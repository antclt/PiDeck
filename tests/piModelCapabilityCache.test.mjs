import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
  PiModelCapabilityCache,
  parseAvailableModelsResponse,
} = loadTsCommonJs("src/main/pi/PiModelCapabilityCache.ts");

function response(data) {
  return { success: true, data };
}

function failure(error) {
  return { success: false, error };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createProcess(models, levelsByModel, options = {}) {
  const commands = [];
  let currentKey = "";
  let stopped = 0;
  const process = {
    async start(_sessionPath, _trustOverride, noSession) {
      assert.equal(noSession, true, "capability probe must use --no-session");
      return {
        async request(command) {
          commands.push(command);
          if (command.type === "get_available_models") {
            return response({ models });
          }
          if (command.type === "set_model") {
            currentKey = `${command.provider}\u0000${command.modelId}`;
            return options.setFailureKeys?.has(currentKey)
              ? failure("model unavailable")
              : response({ model: { provider: command.provider, id: command.modelId } });
          }
          if (command.type === "get_available_thinking_levels") {
            const value = levelsByModel.get(currentKey);
            return value instanceof Error ? failure(value.message) : response({ levels: value });
          }
          throw new Error(`unexpected command: ${command.type}`);
        },
      };
    },
    stop() {
      stopped += 1;
    },
  };
  return { process, commands, getStopped: () => stopped };
}

test("parseAvailableModelsResponse keeps only safe model fields and de-duplicates identities", () => {
  const models = parseAvailableModelsResponse(response({
    models: [
      {
        provider: "openai",
        id: "gpt-5",
        name: "GPT 5",
        contextWindow: 200_000,
        maxTokens: 32_000,
        reasoning: true,
        input: ["text", "image"],
        thinkingLevelMap: { off: null, high: "high", xhigh: "xhigh", ignored: "never" },
        apiKey: "must-not-cross-ipc",
      },
      { provider: "openai", id: "gpt-5", name: "duplicate" },
      { provider: "bad", id: "" },
    ],
  }));

  assert.deepEqual(plain(models), [{
    provider: "openai",
    id: "gpt-5",
    name: "GPT 5",
    contextWindow: 200_000,
    maxTokens: 32_000,
    reasoning: true,
    input: ["text", "image"],
    images: true,
    thinkingLevelMap: { off: null, high: "high", xhigh: "xhigh" },
  }]);
});

test("hydration queries every model in one no-session process and publishes exact levels", async () => {
  const models = [
    { provider: "openai", id: "gpt-5", reasoning: true, input: ["text", "image"] },
    { provider: "anthropic", id: "claude", reasoning: false, input: ["text"] },
  ];
  const levels = new Map([
    ["openai\u0000gpt-5", ["off", "low", "high", "xhigh"]],
    ["anthropic\u0000claude", ["off"]],
  ]);
  const fake = createProcess(models, levels);
  const cache = new PiModelCapabilityCache({ createProcess: () => fake.process });

  const snapshot = await cache.ensure();

  assert.deepEqual(plain(snapshot?.models.map((model) => ({
    provider: model.provider,
    id: model.id,
    images: model.images,
    thinkingLevels: model.thinkingLevels,
  }))), [
    { provider: "openai", id: "gpt-5", images: true, thinkingLevels: ["off", "low", "high", "xhigh"] },
    { provider: "anthropic", id: "claude", images: false, thinkingLevels: ["off"] },
  ]);
  assert.deepEqual(fake.commands.map((command) => command.type), [
    "get_available_models",
    "set_model",
    "get_available_thinking_levels",
    "set_model",
    "get_available_thinking_levels",
  ]);
  assert.equal(fake.getStopped(), 1, "the probe must be stopped after publication");

  const cached = await cache.ensure();
  assert.equal(fake.commands.length, 5, "picker reads must reuse the published snapshot");
  cached.models[0].thinkingLevels.push("mutated");
  assert.deepEqual(plain(cache.getSnapshot().models[0].thinkingLevels), ["off", "low", "high", "xhigh"]);
});

test("one unavailable model remains listed without claiming an exact level", async () => {
  const models = [
    { provider: "openai", id: "available", reasoning: true },
    { provider: "openai", id: "removed", reasoning: true },
  ];
  const levels = new Map([["openai\u0000available", ["off", "high"]]]);
  const fake = createProcess(models, levels, {
    setFailureKeys: new Set(["openai\u0000removed"]),
  });
  const cache = new PiModelCapabilityCache({ createProcess: () => fake.process });

  const snapshot = await cache.ensure();

  assert.deepEqual(plain(snapshot?.models[0].thinkingLevels), ["off", "high"]);
  assert.equal(snapshot?.models[1].thinkingLevels, undefined);
});

test("unsupported thinking RPC discards the exact snapshot instead of inventing levels", async () => {
  const models = [{ provider: "openai", id: "legacy", reasoning: true }];
  const levels = new Map([
    ["openai\u0000legacy", new Error("Unknown command: get_available_thinking_levels")],
  ]);
  const fake = createProcess(models, levels);
  const warnings = [];
  const cache = new PiModelCapabilityCache({
    createProcess: () => fake.process,
    onWarning: (message, detail) => warnings.push({ message, detail }),
  });

  assert.equal(await cache.ensure(), null);
  assert.equal(cache.getSnapshot(), null);
  assert.equal(fake.getStopped(), 1);
  assert.match(warnings[0].detail.error, /get_available_thinking_levels/i);
  await cache.ensure();
  assert.equal(
    fake.commands.filter((command) => command.type === "get_available_models").length,
    1,
    "a failed generation must not respawn Pi for every picker open",
  );
});

test("a refresh invalidates a stale hydration generation before it can publish", async () => {
  let resolveFirstStart;
  const firstStarted = new Promise((resolve) => {
    resolveFirstStart = resolve;
  });
  let firstStopped = 0;
  const firstProcess = {
    async start() {
      await firstStarted;
      return {
        async request(command) {
          if (command.type === "get_available_models") return response({ models: [] });
          throw new Error("stale process should not query model levels");
        },
      };
    },
    stop() {
      firstStopped += 1;
    },
  };
  const second = createProcess(
    [{ provider: "openai", id: "fresh", reasoning: true }],
    new Map([["openai\u0000fresh", ["off", "medium"]]]),
  );
  let processCount = 0;
  const cache = new PiModelCapabilityCache({
    createProcess: () => {
      processCount += 1;
      return processCount === 1 ? firstProcess : second.process;
    },
  });

  const stale = cache.ensure();
  const fresh = cache.refresh();
  resolveFirstStart();

  assert.equal(await stale, null);
  assert.deepEqual(plain((await fresh)?.models[0].thinkingLevels), ["off", "medium"]);
  assert.equal(firstStopped, 1);
  assert.equal(cache.getSnapshot().models[0].id, "fresh");
});
