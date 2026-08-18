import assert from "node:assert/strict";
import test from "node:test";
import { isValidProviderName, PROVIDER_NAME_MAX_LENGTH } from "../src/shared/providerName.ts";

test("合法 provider name：字母开头 + 字母数字/下划线/连字符", () => {
	// 回归：新增/重命名供应商名称走严格白名单，保证 DSH credentialRefFor
	// 生成的 <NAME>_API_KEY 是合法 POSIX 环境变量名，不被 host 进程吞掉。
	assert.equal(isValidProviderName("openai"), true);
	assert.equal(isValidProviderName("deepseek"), true);
	assert.equal(isValidProviderName("my-provider"), true);
	assert.equal(isValidProviderName("my_provider"), true);
	assert.equal(isValidProviderName("openai_v2"), true);
	assert.equal(isValidProviderName("a"), true);
	assert.equal(isValidProviderName("A".repeat(PROVIDER_NAME_MAX_LENGTH)), true);
});

test("非法 provider name：路径穿越 / 特殊字符 / 空格 / 点号", () => {
	// DSH 兼容性：这些字符会让 credentialRefFor 输出非法环境变量名，
	// 或在 shell/JSON key 场景被转义/误解析 → 密钥读不到、配置写歪。
	assert.equal(isValidProviderName(""), false);
	assert.equal(isValidProviderName("   "), false);
	assert.equal(isValidProviderName("../etc"), false);
	assert.equal(isValidProviderName("a/b"), false);
	assert.equal(isValidProviderName("a\\b"), false);
	assert.equal(isValidProviderName("a b"), false);
	assert.equal(isValidProviderName("a.b"), false);
	assert.equal(isValidProviderName("a;b"), false);
	assert.equal(isValidProviderName("a$b"), false);
	assert.equal(isValidProviderName("a&b"), false);
	assert.equal(isValidProviderName("a|b"), false);
	assert.equal(isValidProviderName("a`b"), false);
	assert.equal(isValidProviderName("中文供应商"), false);
	assert.equal(isValidProviderName("供应商"), false);
	assert.equal(isValidProviderName("-leading-dash"), false);
});

test("数字开头被拒：credentialRefFor 后环境变量名非法", () => {
	// provider name "2provider" → credentialRefFor → "2PROVIDER_API_KEY"
	// POSIX 环境变量名不能数字开头，故必须字母开头。
	assert.equal(isValidProviderName("2provider"), false);
	assert.equal(isValidProviderName("123"), false);
});

test("超长名称被拒：与 isSafeProviderName 长度上限一致", () => {
	assert.equal(isValidProviderName("a".repeat(PROVIDER_NAME_MAX_LENGTH + 1)), false);
});

test("首尾空格被 trim：用户误粘空格不影响判断", () => {
	assert.equal(isValidProviderName("  openai  "), true);
	assert.equal(isValidProviderName("  a b  "), false);
});
