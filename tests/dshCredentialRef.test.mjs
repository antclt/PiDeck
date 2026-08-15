import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { credentialRefFor } = loadTsCommonJs("src/renderer/src/config/dshCredentialRef.ts");

test("credentialRefFor: 显式 apiKeyEnv 优先", () => {
	assert.equal(credentialRefFor({ apiKeyEnv: "MY_CUSTOM_KEY" }, "my-route"), "MY_CUSTOM_KEY");
});

test("credentialRefFor: 空白 apiKeyEnv 视为未声明，走派生", () => {
	assert.equal(credentialRefFor({ apiKeyEnv: "   " }, "my-route"), "MY_ROUTE_API_KEY");
	assert.equal(credentialRefFor(undefined, "my-route"), "MY_ROUTE_API_KEY");
});

test("credentialRefFor: 按 dsh-web 规则派生 <ROUTE>_API_KEY（大写 + 连字符转下划线）", () => {
	assert.equal(credentialRefFor(undefined, "deepseek"), "DEEPSEEK_API_KEY");
	assert.equal(credentialRefFor(undefined, "my-gateway"), "MY_GATEWAY_API_KEY");
	assert.equal(credentialRefFor(undefined, "openai-compatible"), "OPENAI_COMPATIBLE_API_KEY");
});
