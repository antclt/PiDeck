import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	normalizeDshSchema,
	objectFields,
	unionConstOptions,
	dictEntries,
	isSecretSet,
	collectCredentialRefs,
	collectCredentialRefsWithValue,
	readPath,
	setPath,
	pruneEmptyObjects,
} = loadTsCommonJs("src/renderer/src/config/dshSchema.ts");

/** 构造最小 schemastery 风格 schema：{ uid, refs: { id: ref } }。 */
function makeSchema(refs) {
	return { uid: 1, refs: { 1: { type: "object", dict: { ...refs.dict } }, ...refs.refs } };
}

test("normalizeDshSchema 解析 schemastery JSON（数字键 refs）", () => {
	const raw = {
		uid: 2,
		refs: {
			1: { type: "object", dict: { apiKeyEnv: 3 } },
			3: { type: "string", meta: { role: "credential-ref", default: "DEEPSEEK_API_KEY" } },
		},
	};
	const schema = normalizeDshSchema(raw);
	assert.ok(schema);
	assert.equal(schema.uid, 2);
	assert.equal(schema.refs[1].type, "object");
	assert.deepEqual(schema.refs[1].dict, { apiKeyEnv: 3 });
	assert.equal(schema.refs[3].meta?.role, "credential-ref");
});

test("objectFields 展开固定字段（保持声明顺序）", () => {
	const schema = normalizeDshSchema({
		uid: 1,
		refs: {
			1: { type: "object", dict: { b: 2, a: 3 } },
			2: { type: "number" },
			3: { type: "string" },
		},
	});
	const fields = objectFields(schema, schema.refs[1]);
	assert.equal(fields.map((field) => field.name).join(","), "b,a");
	assert.equal(fields[1].ref.type, "string");
});

test("unionConstOptions 提取 const 分支（非 const 分支忽略）", () => {
	const schema = normalizeDshSchema({
		uid: 1,
		refs: {
			1: { type: "union", list: [2, 3, 4] },
			2: { type: "const", value: "read-only" },
			3: { type: "const", value: "workspace-write" },
			4: { type: "object" },
		},
	});
	const options = unionConstOptions(schema, schema.refs[1]);
	assert.equal(options.length, 2);
	assert.equal(options[0].value, "read-only");
	assert.equal(options[1].value, "workspace-write");
});

test("dictEntries 列出动态 dict 条目（llm-pi-ai.providers）", () => {
	const entries = dictEntries({
		opencode: { apiKeyEnv: "OPENCODE_API_KEY" },
		weishiair: { apiKeyEnv: "WEISHIAIR_API_KEY" },
	});
	assert.equal(entries.length, 2);
	assert.equal(entries[0].key, "opencode");
	assert.equal(entries[0].value.apiKeyEnv, "OPENCODE_API_KEY");
	assert.equal(entries[1].key, "weishiair");
	assert.equal(dictEntries(null).length, 0);
	assert.equal(dictEntries([]).length, 0);
});

test("isSecretSet 按 path 匹配 secrets 槽位", () => {
	const secrets = [
		{ path: ["apiKey"], set: true },
		{ path: ["proxy", "password"], set: false },
	];
	assert.equal(isSecretSet(secrets, ["apiKey"]), true);
	assert.equal(isSecretSet(secrets, ["proxy", "password"]), false);
	assert.equal(isSecretSet(secrets, ["other"]), false);
});

test("collectCredentialRefs 收集所有 credential-ref env 名（嵌套 dict/object）", () => {
	const schema = normalizeDshSchema({
		uid: 1,
		refs: {
			1: { type: "object", dict: { apiKeyEnv: 2, providers: 3 } },
			2: { type: "string", meta: { role: "credential-ref", default: "DEEPSEEK_API_KEY" } },
			3: { type: "dict", inner: 4 },
			4: { type: "object", dict: { apiKeyEnv: 5 } },
			5: { type: "string", meta: { role: "credential-ref", default: "WEISHIAIR_API_KEY" } },
		},
	});
	const out = new Set();
	collectCredentialRefs(schema, schema.refs[1], out);
	assert.deepEqual([...out], ["DEEPSEEK_API_KEY", "WEISHIAIR_API_KEY"]);
});

test("collectCredentialRefsWithValue 补充收集 value 里的动态 env 名（llm-pi-ai 场景）", () => {
	// llm-pi-ai 的真实形态：providers 是 dict，apiKeyEnv 的 schema 只有 role 标注、
	// 没有 default；env 名由用户配置在 value.providers[*].apiKeyEnv 里，必须读 value 才不漏。
	const schema = normalizeDshSchema({
		uid: 1,
		refs: {
			1: { type: "object", dict: { providers: 2 } },
			2: { type: "dict", inner: 3 },
			3: { type: "object", dict: { apiKeyEnv: 4 } },
			4: { type: "string", meta: { role: "credential-ref" } },
		},
	});
	const value = {
		providers: {
			opencode: { apiKeyEnv: "OPENCODE_GO_API_KEY" },
			weishiair: { apiKeyEnv: "WEISHIAIR_API_KEY" },
		},
	};
	const out = new Set();
	collectCredentialRefsWithValue(schema, schema.refs[1], value, out);
	assert.deepEqual([...out].sort(), ["OPENCODE_GO_API_KEY", "WEISHIAIR_API_KEY"]);
});

test("collectCredentialRefsWithValue 同时收 schema default 与 value 值（合并去重）", () => {
	const schema = normalizeDshSchema({
		uid: 1,
		refs: {
			1: { type: "object", dict: { apiKeyEnv: 2 } },
			2: { type: "string", meta: { role: "credential-ref", default: "DEEPSEEK_API_KEY" } },
		},
	});
	const out = new Set();
	// 用户改了 env 名：default 与 value 并存时都收（credentials.describe 按 refs 查询，多余 ref 无害）
	collectCredentialRefsWithValue(schema, schema.refs[1], { apiKeyEnv: "MY_KEY" }, out);
	assert.deepEqual([...out].sort(), ["DEEPSEEK_API_KEY", "MY_KEY"]);
});

test("readPath/setPath 读写嵌套 path", () => {
	const root = { a: { b: 1 } };
	assert.equal(readPath(root, ["a", "b"]), 1);
	assert.equal(readPath(root, ["a", "c"]), undefined);
	setPath(root, ["x", "y"], 2);
	assert.equal(root.x?.y, 2);
});

test("pruneEmptyObjects 清理空对象（patch 提交前）", () => {
	const cleaned = pruneEmptyObjects({ a: {}, b: { c: 1 }, d: { e: {} } });
	// vm 编译产物里的对象字面量原型与测试进程不同，deepEqual 会因跨 realm 报错；
	// 这里按字段断言。
	assert.deepEqual(Object.keys(cleaned), ["b"]);
	assert.equal(cleaned.b?.c, 1);
});
