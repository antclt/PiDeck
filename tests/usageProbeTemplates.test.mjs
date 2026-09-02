import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const tpl = loadTsCommonJs("src/main/config/usageProbeTemplates.ts");

test("newapi 模板把带 /v1 的端点剥离为管理根并跳过版本化补齐", () => {
  const built = tpl.buildDeclarativeUsageProbeTemplate(
    "newapi",
    { accessToken: "tok", userId: "2325" },
    { baseUrl: "https://88api.ai/v1", apiKey: "sk-x" },
  );
  assert.ok(!("error" in built), "应构建成功");
  assert.equal(built.baseUrl, "https://88api.ai");
  assert.equal(built.candidate.path, "/api/user/self");
  assert.equal(built.candidate.noVersionPath, true);
  assert.equal(built.candidate.headers["New-Api-User"], "2325");
  assert.equal(built.candidate.headers.Authorization, "Bearer tok");
});

test("newapi 模板显式覆盖的请求地址优先（同样剥离版本段）", () => {
  const built = tpl.buildDeclarativeUsageProbeTemplate(
    "newapi",
    { accessToken: "tok", userId: "u1", baseUrl: "https://api.override.example/v1" },
    { baseUrl: "https://88api.ai/v1", apiKey: "sk-x" },
  );
  assert.ok(!("error" in built));
  assert.equal(built.baseUrl, "https://api.override.example");
});

test("newapi 模板缺访问令牌或用户 ID 时返回错误", () => {
  const missing = tpl.buildDeclarativeUsageProbeTemplate(
    "newapi",
    { accessToken: "", userId: "" },
    { baseUrl: "https://88api.ai/v1", apiKey: "sk-x" },
  );
  assert.ok("error" in missing);
});
