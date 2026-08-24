import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const mapping = loadTsCommonJs("src/main/config/providerMigration.ts");
const service = loadTsCommonJs("src/main/config/providerMigrationService.ts");

test("credentialRefFor uses explicit env then derived ROUTE_API_KEY", () => {
  assert.equal(mapping.credentialRefFor({ apiKeyEnv: "MY_KEY" }, "weishiair"), "MY_KEY");
  assert.equal(mapping.credentialRefFor({}, "opencode-go"), "OPENCODE_GO_API_KEY");
});

test("legacy provider route names get valid unique credential refs", () => {
  const first = mapping.credentialRefFor({}, "输入");
  const second = mapping.credentialRefFor({}, "供应商");
  assert.match(first, /^PIDECK_[0-9A-F]{8}_API_KEY$/);
  assert.match(second, /^[A-Za-z_][A-Za-z0-9_]*$/);
  assert.notEqual(first, second);
});
test("pi custom gateway maps into llm-pi-ai with catalog fields only", () => {
  const dsh = mapping.piToDshSnapshot({
    name: "weishiair",
    baseUrl: "https://api.weishiair.de/v1",
    api: "openai-completions",
    apiKey: "sk-test",
    headers: { "User-Agent": "pideck" },
    models: [
      { id: "grok-4.6", name: "grok-4.6", contextWindow: 128000, cost: { input: 1 } },
    ],
  });
  assert.equal(dsh.namespace, "llm-pi-ai");
  assert.equal(dsh.profile.baseURL, "https://api.weishiair.de/v1");
  assert.equal(dsh.profile.apiKeyEnv, "WEISHIAIR_API_KEY");
  assert.equal(dsh.profile.models?.length, 1);
  assert.equal(dsh.profile.models?.[0]?.id, "grok-4.6");
  assert.equal(dsh.profile.models?.[0]?.name, "grok-4.6");
  assert.equal(dsh.profile.models?.[0]?.contextWindow, 128000);
  assert.equal(dsh.profile.models?.[0]?.cost, undefined);
});

test("official deepseek stays in llm-deepseek instead of a custom dict row", () => {
  const dsh = mapping.piToDshSnapshot({
    name: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    apiKey: "sk-ds",
    models: [{ id: "deepseek-chat" }],
  });
  assert.equal(dsh.namespace, "llm-deepseek");
  assert.equal(dsh.profile.baseURL, undefined);
  assert.equal(dsh.profile.apiKeyEnv, "DEEPSEEK_API_KEY");
});

test("dsh settings yaml parse + merge keeps sibling namespaces", () => {
  const parsed = mapping.parseDshSettingsDocument({
    "ui-onboarding": { welcomeNoticeVersion: "1" },
    "llm-pi-ai": {
      providers: {
        weishiair: { baseURL: "https://api.weishiair.de/v1", models: [{ id: "grok-4.6" }] },
      },
    },
  });
  assert.equal(parsed.piAi.weishiair.baseURL, "https://api.weishiair.de/v1");
  const next = mapping.mergeDshProviderIntoSettings(
    { "ui-onboarding": { welcomeNoticeVersion: "1" }, "llm-pi-ai": { providers: { old: {} } } },
    {
      name: "weishiair",
      namespace: "llm-pi-ai",
      profile: { baseURL: "https://api.weishiair.de/v1", apiKeyEnv: "WEISHIAIR_API_KEY" },
    },
  );
  assert.equal(next["ui-onboarding"].welcomeNoticeVersion, "1");
  assert.ok(next["llm-pi-ai"].providers.old);
  assert.equal(next["llm-pi-ai"].providers.weishiair.baseURL, "https://api.weishiair.de/v1");
});

test("mergePiProvider writes auth.json key and strips inline models.json key", () => {
  const merged = mapping.mergePiProvider(
    { providers: {} },
    {},
    {
      name: "weishiair",
      baseUrl: "https://api.weishiair.de/v1",
      api: "openai-completions",
      apiKey: "sk-test",
      models: [{ id: "grok-4.6" }],
    },
  );
  assert.equal(merged.models.providers.weishiair.apiKey, undefined);
  assert.equal(merged.auth.weishiair.key, "sk-test");
});

test("unsafe provider names are rejected", () => {
  assert.equal(mapping.isSafeProviderName("../etc"), false);
  assert.equal(mapping.isSafeProviderName("weishiair"), true);
});

test("apply pi-to-dsh writes settings.yaml and credentials without starting host", async () => {
  const home = await mkdtemp(join(tmpdir(), "pideck-migrate-"));
  await writeFile(join(home, "settings.yaml"), "ui-onboarding:\n  welcomeNoticeVersion: keep-me\n", "utf8");
  const deps = {
    configManager: {
      getModelsConfig: async () => ({
        parsed: {
          providers: {
            weishiair: {
              baseUrl: "https://api.weishiair.de/v1",
              api: "openai-completions",
              apiKey: "sk-from-pi",
              models: [{ id: "grok-4.6", name: "grok-4.6" }],
            },
          },
        },
      }),
      getAuthConfig: async () => ({ parsed: {} }),
      saveModelsConfig: async () => ({ valid: true }),
      saveAuthConfig: async () => ({ valid: true }),
    },
    dshHost: {
      getHomeDir: () => home,
      isHostReady: () => false,
      updateSettings: async () => {
        throw new Error("must not start host");
      },
      setCredential: async () => {
        throw new Error("must not start host");
      },
      describeSettings: async () => ({ namespaces: [] }),
      readCredentialValue: async () => undefined,
    },
  };
  const result = await service.applyProviderMigration(deps, "pi-to-dsh", "weishiair");
  assert.equal(result.ok, true);
  assert.equal(result.copiedKey, true);
  assert.equal(result.wroteViaHost, false);
  const yaml = await readFile(join(home, "settings.yaml"), "utf8");
  assert.match(yaml, /welcomeNoticeVersion: keep-me/);
  assert.match(yaml, /weishiair:/);
  assert.match(yaml, /baseURL: https:\/\/api\.weishiair\.de\/v1/);
  const creds = await readFile(join(home, ".credentials.yaml"), "utf8");
  assert.match(creds, /WEISHIAIR_API_KEY:/);
  assert.match(creds, /sk-from-pi/);
});

test("apply pi-to-dsh uses the same valid legacy credential ref through a ready host", async () => {
  const calls = { patch: null, ref: null };
  const deps = {
    configManager: {
      getModelsConfig: async () => ({
        parsed: {
          providers: {
            输入: {
              baseUrl: "https://gateway.example/v1",
              api: "openai-completions",
              apiKey: "sk-from-pi",
              models: [{ id: "legacy-model" }],
            },
          },
        },
      }),
      getAuthConfig: async () => ({ parsed: {} }),
      saveModelsConfig: async () => ({ valid: true }),
      saveAuthConfig: async () => ({ valid: true }),
    },
    dshHost: {
      getHomeDir: () => "",
      isHostReady: () => true,
      updateSettings: async (_ns, patch) => {
        calls.patch = patch;
      },
      setCredential: async (ref) => {
        calls.ref = ref;
      },
      describeSettings: async () => ({
        namespaces: [{ ns: "llm-pi-ai", revision: 7, value: { providers: {} } }],
      }),
      readCredentialValue: async () => undefined,
    },
  };
  const result = await service.applyProviderMigration(deps, "pi-to-dsh", "输入");
  assert.equal(result.ok, true);
  assert.equal(result.wroteViaHost, true);
  const profile = calls.patch.providers["输入"];
  assert.match(profile.apiKeyEnv, /^PIDECK_[0-9A-F]{8}_API_KEY$/);
  assert.equal(calls.ref, profile.apiKeyEnv);
});
test("apply dsh-to-pi copies credential into auth.json", async () => {
  const home = await mkdtemp(join(tmpdir(), "pideck-migrate-"));
  await writeFile(
    join(home, "settings.yaml"),
    "llm-pi-ai:\n  providers:\n    weishiair:\n      baseURL: https://api.weishiair.de/v1\n      api: openai-completions\n      models:\n        - id: grok-4.6\n",
    "utf8",
  );
  const saved = { models: null, auth: null };
  const deps = {
    configManager: {
      getModelsConfig: async () => ({ parsed: { providers: {} } }),
      getAuthConfig: async () => ({ parsed: {} }),
      saveModelsConfig: async (data) => {
        saved.models = data;
        return { valid: true };
      },
      saveAuthConfig: async (data) => {
        saved.auth = data;
        return { valid: true };
      },
    },
    dshHost: {
      getHomeDir: () => home,
      isHostReady: () => false,
      updateSettings: async () => undefined,
      setCredential: async () => undefined,
      describeSettings: async () => ({ namespaces: [] }),
      readCredentialValue: async (ref) => (ref === "WEISHIAIR_API_KEY" ? "sk-from-dsh" : undefined),
    },
  };
  const result = await service.applyProviderMigration(deps, "dsh-to-pi", "weishiair");
  assert.equal(result.ok, true);
  assert.equal(result.copiedKey, true);
  assert.equal(saved.models.providers.weishiair.baseUrl, "https://api.weishiair.de/v1");
  assert.equal(saved.auth.weishiair.key, "sk-from-dsh");
});

test("source contracts keep IPC / preload / UI wired", async () => {
  const ipc = await readFile(join(process.cwd(), "src/shared/ipc.ts"), "utf8");
  const preload = await readFile(join(process.cwd(), "src/preload/index.ts"), "utf8");
  const systemIpc = await readFile(join(process.cwd(), "src/main/ipc/systemIpc.ts"), "utf8");
  const modelsTab = await readFile(join(process.cwd(), "src/renderer/src/config/ModelsTab.tsx"), "utf8");
  const dshCards = await readFile(join(process.cwd(), "src/renderer/src/config/DshProviderCards.tsx"), "utf8");
  assert.match(ipc, /configPreviewProviderMigration/);
  assert.match(preload, /previewProviderMigration/);
  assert.match(systemIpc, /applyProviderMigration/);
  assert.match(modelsTab, /direction="pi-to-dsh"/);
  assert.match(dshCards, /direction="dsh-to-pi"/);
});

test("mergeCredentialDocument writes dsh-credentials-local v1 layout (version:1 + refs)", () => {
  // 空文档 → v1
  const fromEmpty = mapping.mergeCredentialDocument("", "DEEPSEEK_API_KEY", "sk-abc");
  const parsedEmpty = JSON.parse(JSON.stringify(mapping.loadYamlObject(fromEmpty)));
  assert.equal(parsedEmpty.version, 1);
  assert.equal(parsedEmpty.refs.DEEPSEEK_API_KEY, "sk-abc");

  // 旧扁平布局 → 迁入 refs 层，输出 v1
  const fromFlat = mapping.mergeCredentialDocument(
    ["DEEPSEEK_API_KEY: sk-old", "WBX_API_KEY: sk-wbx", ""].join("\n"),
    "WBX_API_KEY",
    "sk-wbx-new",
  );
  const parsedFlat = JSON.parse(JSON.stringify(mapping.loadYamlObject(fromFlat)));
  assert.equal(parsedFlat.version, 1);
  assert.equal(parsedFlat.refs.DEEPSEEK_API_KEY, "sk-old");
  assert.equal(parsedFlat.refs.WBX_API_KEY, "sk-wbx-new");

  // 已是 v1 → 只改 refs 层，保留 records
  const fromV1 = mapping.mergeCredentialDocument(
    ["version: 1", "refs:", "  A_KEY: sk-a", "records:", "  r: x", ""].join("\n"),
    "A_KEY",
    "sk-a-new",
  );
  const parsedV1 = JSON.parse(JSON.stringify(mapping.loadYamlObject(fromV1)));
  assert.equal(parsedV1.version, 1);
  assert.equal(parsedV1.refs.A_KEY, "sk-a-new");
  assert.equal(parsedV1.records.r, "x");
});
