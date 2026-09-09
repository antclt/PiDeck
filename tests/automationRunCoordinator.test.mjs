import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AutomationStore } = loadTsCommonJs("src/main/automation/AutomationStore.ts");
const { AutomationRunCoordinator } = loadTsCommonJs("src/main/automation/AutomationRunCoordinator.ts");

function createMockDeps(store) {
	const createdSessions = [];
	const sentPrompts = [];
	const abortedTargets = [];

	const catalog = {
		createDraft: async (opts) => {
			const session = {
				id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
				projectId: opts.projectId,
				title: opts.title,
				source: opts.source,
			};
			createdSessions.push(session);
			return session;
		},
	};

	const sessionRuntimeCoordinator = {
		send: async (payload) => {
			sentPrompts.push(payload);
			return {
				accepted: true,
				agentId: "agent-123",
				runtimeGeneration: 1,
			};
		},
		abortRuntime: async (target) => {
			abortedTargets.push(target);
		},
	};

	const projectStore = {
		get: (id) => ({ id, name: "Test Project", path: "/test", environment: "native" }),
	};

	return {
		store,
		catalog,
		sessionRuntimeCoordinator,
		projectStore,
		createdSessions,
		sentPrompts,
		abortedTargets,
	};
}

test("AutomationRunCoordinator runs queue, executes session, updates metrics, and marks success on idle event", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-test-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);

		const task = await store.createTask({
			name: "Nightly Health Check",
			projectId: "p1",
			prompt: "Check repo status",
			schedule: { type: "cron", expression: "0 0 * * *" },
			budget: { timeoutMs: 60_000, maxTokens: 10_000 },
		}, 1_000);

		const deps = createMockDeps(store);
		const coordinator = new AutomationRunCoordinator(deps);

		const run = await coordinator.enqueueRun(task, undefined, "manual", 1_050);
		assert.equal(run.status, "queued");

		// Allow queue drain microtask / async step to execute
		await new Promise((r) => setTimeout(r, 20));

		// Session created & prompt sent
		assert.equal(deps.createdSessions.length, 1);
		assert.equal(deps.sentPrompts.length, 1);
		assert.equal(deps.sentPrompts[0].message, "Check repo status");

		const runningRun = store.getRun(run.id);
		assert.ok(runningRun.status === "starting" || runningRun.status === "running");
		assert.equal(runningRun.sessionId, deps.createdSessions[0].id);

		// Observe token metrics
		coordinator.observeRuntimeEvent({
			sourceChannel: "agents:runtime-state",
			sessionId: deps.createdSessions[0].id,
			agentId: "agent-123",
			runtimeGeneration: 1,
			payload: {
				agentId: "agent-123",
				state: {
					inputTokens: 120,
					outputTokens: 80,
					cost: 0.005,
					isTurnActive: true,
					isExecutingTool: false,
				},
			},
		});

		// Observe turn idle/finished (isTurnActive: false, isExecutingTool: false)
		coordinator.observeRuntimeEvent({
			sourceChannel: "agents:runtime-state",
			sessionId: deps.createdSessions[0].id,
			agentId: "agent-123",
			runtimeGeneration: 1,
			payload: {
				agentId: "agent-123",
				state: {
					inputTokens: 120,
					outputTokens: 80,
					cost: 0.005,
					isTurnActive: false,
					isExecutingTool: false,
				},
			},
		});

		await new Promise((r) => setTimeout(r, 20));

		const finishedRun = store.getRun(run.id);
		assert.equal(finishedRun.status, "succeeded");
		assert.equal(finishedRun.inputTokens, 120);
		assert.equal(finishedRun.outputTokens, 80);
		assert.equal(finishedRun.costUsd, 0.005);

		coordinator.dispose();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("AutomationRunCoordinator enforces token budget and aborts runtime when budget exhausted", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-budget-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);

		const task = await store.createTask({
			name: "Budget Limited Task",
			projectId: "p1",
			prompt: "Check repo status",
			schedule: { type: "cron", expression: "0 0 * * *" },
			budget: { timeoutMs: 60_000, maxTokens: 500 }, // strict 500 token limit
		}, 1_000);

		const deps = createMockDeps(store);
		const coordinator = new AutomationRunCoordinator(deps);

		const run = await coordinator.enqueueRun(task, undefined, "manual", 1_050);
		await new Promise((r) => setTimeout(r, 20));

		// Emit metrics exceeding maxTokens (600 > 500)
		coordinator.observeRuntimeEvent({
			sourceChannel: "agents:runtime-state",
			sessionId: deps.createdSessions[0].id,
			agentId: "agent-123",
			runtimeGeneration: 1,
			payload: {
				agentId: "agent-123",
				state: {
					inputTokens: 350,
					outputTokens: 250,
					cost: 0.01,
					isTurnActive: true,
					isExecutingTool: false,
				},
			},
		});

		await new Promise((r) => setTimeout(r, 20));

		assert.equal(deps.abortedTargets.length, 1);
		assert.equal(deps.abortedTargets[0].sessionId, deps.createdSessions[0].id);

		const budgetRun = store.getRun(run.id);
		assert.equal(budgetRun.status, "budget-exhausted");
		assert.equal(budgetRun.budgetReason, "tokens");
		assert.match(budgetRun.error, /token budget/);

		coordinator.dispose();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("AutomationRunCoordinator supports manual abortRun", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pideck-coord-abort-"));
	const storePath = join(dir, "automation.json");
	try {
		const store = new AutomationStore(storePath);
		await store.load(1_000);

		const task = await store.createTask({
			name: "Manual Abort Task",
			projectId: "p1",
			prompt: "Long running inspection",
			schedule: { type: "manual" },
			budget: { timeoutMs: 120_000 },
		}, 1_000);

		const deps = createMockDeps(store);
		const coordinator = new AutomationRunCoordinator(deps);

		const run = await coordinator.enqueueRun(task, undefined, "manual", 1_050);
		await new Promise((r) => setTimeout(r, 20));

		const aborted = await coordinator.abortRun(run.id, "User requested cancellation");
		assert.equal(aborted, true);

		assert.equal(deps.abortedTargets.length, 1);
		const abortedRun = store.getRun(run.id);
		assert.equal(abortedRun.status, "aborted");
		assert.equal(abortedRun.error, "User requested cancellation");

		coordinator.dispose();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
