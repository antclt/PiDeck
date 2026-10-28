import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { getProjectAgentSessionDisplay } = loadTsCommonJs("src/renderer/src/agentListDisplay.ts");
const FILE_PATH = "/Users/Fixture/.pi/agent/sessions/2026-10-07T12-34-56-000Z_session.jsonl";

/** 历史重复索引的展示夹具：同一文件有两个 ID，但名字与活跃时间不同。 */
function session(id, name, updatedAt) {
	return { id, name, updatedAt, filePath: FILE_PATH, source: "pi", preview: "", messageCount: 1 };
}

/** runtime 自带的稳定会话身份优先于单纯按路径、时间猜出的重复记录。 */
function agent(id, deckSessionId, createdAt) {
	return { id, deckSessionId, projectId: "project-1", cwd: "/Users/Fixture/Project", title: "runtime title", status: "idle", createdAt, sessionPath: FILE_PATH, sessionEnvironment: "native" };
}

function displayedSession(sessions, agents = []) {
	const display = getProjectAgentSessionDisplay({ sessions, agents });
	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "session");
	return display.children[0].session;
}

test("#354 duplicate-path sidebar rows use the newest record regardless of input order", () => {
	const older = session("older", "A", 100);
	const newer = session("newer", "A1", 200);
	for (const sessions of [
		[newer, older],
		[older, newer],
	]) {
		assert.equal(displayedSession(sessions).id, newer.id);
		assert.equal(displayedSession(sessions).name, "A1");
	}
});

test("#354 duplicate-path sidebar rows preserve the runtime's explicit stable session identity", () => {
	const bound = session("bound", "Manual title", 100);
	const scanned = session("scanned", "Old scanned title", 200);
	for (const sessions of [
		[bound, scanned],
		[scanned, bound],
	]) {
		assert.equal(displayedSession(sessions, [agent("runtime", bound.id, 10)]).id, bound.id);
	}
});

test("#354 multiple duplicate-path runtimes resolve to the newest runtime's bound record", () => {
	const older = session("older", "First runtime", 200);
	const newer = session("newer", "Second runtime", 100);
	for (const sessions of [
		[newer, older],
		[older, newer],
	]) {
		assert.equal(displayedSession(sessions, [agent("old-runtime", older.id, 10), agent("new-runtime", newer.id, 20)]).id, newer.id);
	}
});

test("#354 equal-time runtimes keep the selected row aligned with its runtime decoration", () => {
	const first = session("first", "First", 100);
	const second = session("second", "Second", 200);
	for (const status of ["idle", "running"]) {
		const agents = [agent("first-runtime", first.id, 10), agent("second-runtime", second.id, 10)].map((runtime) => ({ ...runtime, status }));
		for (const sessions of [
			[first, second],
			[second, first],
		]) {
			const display = getProjectAgentSessionDisplay({ sessions, agents });
			assert.equal(display.children.length, 1);
			const row = display.children[0];
			assert.equal(row.type, "session");
			assert.equal(row.session.id, status === "running" ? second.id : first.id);
			assert.equal(row.agent.deckSessionId, row.session.id);
		}
	}
});

test("#354 equal-time duplicate records have a stable identity independent of listing order", () => {
	const first = session("a-original", "A", 100);
	const second = session("b-duplicate", "A1", 100);
	assert.equal(displayedSession([first, second]).id, displayedSession([second, first]).id);
});

// 远端（SSH）会话没有本机 filePath：agent 的 sessionPath 是远端路径，永远配不上会话行。
// 不按 catalog 会话 id 配对，侧栏就会出现「agent 行 + 会话行」两条同名条目（用户实拍）。
test("remote sessions pair with their runtime by catalog id instead of a local path", () => {
	const remote = {
		id: "remote-session",
		name: "列出当前目录并确认其为空",
		updatedAt: 200,
		filePath: "",
		source: "pi",
		preview: "",
		messageCount: 2,
		locator: { kind: "ssh", hostId: "0f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d", remoteSessionId: "--home-x--/s.jsonl", remotePath: "/home/x/.pi/agent/sessions/--home-x--/s.jsonl" },
	};
	const runtime = {
		id: "runtime-1",
		deckSessionId: "remote-session",
		projectId: "project-1",
		cwd: "/home/x/pideck",
		title: "runtime title",
		status: "idle",
		createdAt: 10,
		sessionPath: "/home/x/.pi/agent/sessions/--home-x--/s.jsonl",
		sessionEnvironment: "native",
	};
	const display = getProjectAgentSessionDisplay({ sessions: [remote], agents: [runtime] });
	assert.equal(display.children.length, 1);
	assert.equal(display.children[0].type, "session");
	assert.equal(display.children[0].session.id, "remote-session");
	assert.equal(display.children[0].agent?.id, "runtime-1");
});
