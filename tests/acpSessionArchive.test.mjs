/**
 * AcpSessionArchive（#415 MVP：ACP 投影消息落盘）单测。
 *
 * 边界都是「安静搞坏」的类型：半截文件、并发写、base64 撑爆磁盘、sessionId 穿越目录。
 * 这里用真实临时目录跑 fs（不 mock），把硬约束钉死：
 * 原子写/读回、损坏降级、条数+字节上限、sha1 命名与路径安全、base64 剔除、
 * 并发不撕裂、写/读失败只记日志不抛。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AcpSessionArchive, ACP_ARCHIVE_MAX_MESSAGES, ACP_ARCHIVE_MAX_BYTES } = loadTsCommonJs("src/main/acp/AcpSessionArchive.ts");

let nextId = 0;
/** 消息工厂：只填归档/匹配关心的字段（其余字段只是透传）。 */
function message(overrides = {}) {
	nextId += 1;
	return {
		id: `acp:msg-${nextId}`,
		agentId: "acp:agent-1",
		role: "user",
		text: `message ${nextId}`,
		timestamp: 1_700_000_000_000 + nextId,
		...overrides,
	};
}

async function tempDir(t) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-acp-archive-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function tempArchive(t) {
	const dir = await tempDir(t);
	const warnings = [];
	const archive = new AcpSessionArchive({
		userDataDir: dir,
		logger: { warn: (channel, msg, meta) => warnings.push({ channel, message: msg, meta }) },
	});
	return { dir, archive, warnings };
}

const ids = (messages) => messages.map((entry) => entry.id).join(",");
const archiveDir = (dir) => join(dir, "acp-sessions");

test("原子写/读回：save 后 read 拿回同一批消息，临时文件被 rename 掉不留残留", async (t) => {
	const { dir, archive } = await tempArchive(t);
	const messages = [message(), message({ role: "assistant", text: "answer body" })];
	await archive.save("sess-roundtrip", messages);

	const file = archive.filePathFor("sess-roundtrip");
	assert.equal(dirname(file), archiveDir(dir), "归档落在 userData/acp-sessions 下");
	assert.equal(await readFile(file, "utf8").then((raw) => JSON.parse(raw).messages.length), 2);
	const back = await archive.read("sess-roundtrip");
	assert.equal(ids(back), ids(messages));
	assert.equal(back[1].text, "answer body");

	const names = await readdir(archiveDir(dir));
	assert.equal(names.length, 1, "只有一份归档文件");
	assert.ok(!names.some((name) => name.endsWith(".tmp")), "临时文件必须已被 rename，不留 *.tmp");
});

test("读回不存在的会话（未归档过）静默为空，不记警告刷屏", async (t) => {
	const { archive, warnings } = await tempArchive(t);
	assert.equal((await archive.read("never-saved")).length, 0);
	assert.equal((await archive.read("")).length, 0);
	assert.equal(warnings.length, 0);
});

test("空快照不覆盖已有归档：0 条消息不写盘（load 重放为空的护栏）", async (t) => {
	const { archive } = await tempArchive(t);
	await archive.save("sess-guard", [message({ text: "必须留住的历史" })]);
	const before = await readFile(archive.filePathFor("sess-guard"), "utf8");
	// 两条写口都要过护栏：直接 save 与管理器用的 enqueueSave
	await archive.save("sess-guard", []);
	await archive.enqueueSave("sess-guard", []);
	assert.equal(await readFile(archive.filePathFor("sess-guard"), "utf8"), before, "空 messages 不得把有内容的归档清空");
	assert.equal((await archive.read("sess-guard"))[0].text, "必须留住的历史");
	// 从没归档过的会话写空也不该凭空造文件
	await archive.save("sess-empty-new", []);
	const keptName = `${createHash("sha1").update("sess-guard", "utf8").digest("hex")}.json`;
	assert.deepEqual(await readdir(dirname(archive.filePathFor("sess-empty-new"))), [keptName], "空快照不产文件");
});

test("损坏/半截/非 JSON 归档降级为空数组（不抛），并记一次日志留证据", async (t) => {
	const { archive, warnings } = await tempArchive(t);
	await archive.save("sess-corrupt", [message()]);
	const file = archive.filePathFor("sess-corrupt");
	const corruptPayloads = ['{"version":1,"acpSessionId":"sess-corrupt","messages":[{"id":"a",', "not json at all", "null", "[]", JSON.stringify({ version: 1, messages: "nope" }), ""];
	for (const payload of corruptPayloads) {
		await writeFile(file, payload, "utf8");
		assert.equal((await archive.read("sess-corrupt")).length, 0, `损坏内容必须降级为空: ${payload.slice(0, 20)}`);
	}
	assert.ok(
		warnings.some((entry) => entry.message.includes("corrupt")),
		"损坏文件要记日志（否则历史静默消失无从排查）",
	);
});

test("单条消息形状不符只跳过该条：一条坏数据不该让整段历史消失", async (t) => {
	const { archive } = await tempArchive(t);
	const good = message({ text: "keep me" });
	await archive.save("sess-partial", [good]);
	const file = archive.filePathFor("sess-partial");
	await writeFile(file, JSON.stringify({ version: 1, acpSessionId: "sess-partial", messages: [{ id: 1 }, { id: "", role: "user", text: "x", timestamp: 1, agentId: "a" }, "garbage", good] }), "utf8");
	const back = await archive.read("sess-partial");
	assert.equal(back.length, 1);
	assert.equal(back[0].text, "keep me");
});

test("条数上限：超过 2000 条从头截断，truncatedFrom 记录被丢弃条数", async (t) => {
	const { archive } = await tempArchive(t);
	const messages = Array.from({ length: ACP_ARCHIVE_MAX_MESSAGES + 50 }, (_, index) => message({ text: `m${index}` }));
	await archive.save("sess-big", messages);

	const payload = JSON.parse(await readFile(archive.filePathFor("sess-big"), "utf8"));
	assert.equal(payload.messages.length, ACP_ARCHIVE_MAX_MESSAGES);
	assert.equal(payload.truncatedFrom, 50);
	assert.equal(payload.messages[0].text, "m50", "从头截断：保留最新一段");
	assert.equal(payload.messages.at(-1).text, `m${ACP_ARCHIVE_MAX_MESSAGES + 49}`);
	assert.equal((await archive.read("sess-big")).length, ACP_ARCHIVE_MAX_MESSAGES);
});

test("字节上限：总量超 8 MiB 时按条丢弃，落盘文件不超上限且 truncatedFrom 可对账", async (t) => {
	const { archive } = await tempArchive(t);
	const chunk = "x".repeat(64 * 1024);
	const total = 160;
	const messages = Array.from({ length: total }, (_, index) => message({ text: `${index}:${chunk}` }));
	await archive.save("sess-fat", messages);

	const file = archive.filePathFor("sess-fat");
	const size = (await stat(file)).size;
	assert.ok(size <= ACP_ARCHIVE_MAX_BYTES, `文件必须 ≤ 8 MiB（实际 ${size}）`);
	const payload = JSON.parse(await readFile(file, "utf8"));
	assert.ok(payload.truncatedFrom > 0, "超预算必须从头截断并记录条数");
	assert.equal(payload.messages.length + payload.truncatedFrom, total);
	assert.ok(payload.messages.at(-1).text.startsWith(`${total - 1}:`), "尾部（最新）消息必须保留");
});

test("文件名用 sha1(acpSessionId)：特殊字符不进路径，不出逃归档目录，不互相覆盖", async (t) => {
	const { dir, archive } = await tempArchive(t);
	const trickyId = "../../etc/passwd\\..\\sess:1?*<>|";
	const file = archive.filePathFor(trickyId);
	assert.equal(dirname(file), archiveDir(dir));
	const name = file.split(/[\\/]/).pop();
	assert.match(name, /^[0-9a-f]{40}\.json$/, "文件名必须是 sha1 十六进制，sessionId 不裸拼");
	assert.equal(name, `${createHash("sha1").update(trickyId, "utf8").digest("hex")}.json`, "口径与 session-store 的 sha1 命名一致");

	await archive.save(trickyId, [message({ text: "tricky" })]);
	// 只差路径片段的伪造 id 不能读到/覆盖前一份
	await archive.save("../../etc/passwd", [message({ text: "other" })]);
	assert.equal((await archive.read(trickyId))[0].text, "tricky");
	assert.equal((await archive.read("../../etc/passwd"))[0].text, "other");
	const outside = await readdir(dir);
	assert.deepEqual(outside, ["acp-sessions"], "不在 userData 下多写任何路径");
});

test("base64 不进归档：data 形态剔除，ref 形态保留", async (t) => {
	const { archive } = await tempArchive(t);
	const messages = [
		// 未物化成功的内联图：只丢图，不丢消息
		message({ text: "inline only", images: [{ type: "image", mimeType: "image/png", data: "A".repeat(4096) }] }),
		// 已物化的图保留 ref；同条消息里另一张未物化的图同样剔除
		message({
			text: "mixed",
			images: [
				{ type: "image", mimeType: "image/png", ref: "blob-ref-1" },
				{ type: "image", mimeType: "image/jpeg", data: "B".repeat(2048) },
			],
		}),
	];
	await archive.save("sess-img", messages);
	const raw = await readFile(archive.filePathFor("sess-img"), "utf8");
	assert.ok(!raw.includes("AAAA"), "base64 data 不得落盘");
	assert.ok(!raw.includes("BBBB"), "混合形态里的内联 data 同样不得落盘");

	const back = await archive.read("sess-img");
	assert.equal(back.length, 2, "丢图不丢消息");
	assert.equal(back[0].text, "inline only");
	assert.equal(back[0].images, undefined, "没有 ref 的内联图整条丢弃（归档里无法展示）");
	assert.equal(back[1].images.length, 1);
	assert.equal(back[1].images[0].ref, "blob-ref-1");
	assert.equal(back[1].images[0].data, undefined);
});

test("并发写不撕裂：并发 save 后文件始终是完整 JSON，内容来自同一次写入", async (t) => {
	const { archive } = await tempArchive(t);
	await Promise.all(
		Array.from({ length: 12 }, (_, index) =>
			archive.save(
				"sess-race",
				Array.from({ length: index + 1 }, () => message({ text: `writer-${index}` })),
			),
		),
	);
	const raw = await readFile(archive.filePathFor("sess-race"), "utf8");
	const payload = JSON.parse(raw);
	assert.ok(payload.messages.length >= 1 && payload.messages.length <= 12);
	const texts = new Set(payload.messages.map((entry) => entry.text));
	assert.equal(texts.size, 1, "落盘内容必须来自同一次写入，不能是多份拼起来");
	assert.equal(payload.messages.length, Number([...texts][0].split("-")[1]) + 1, "条数与写入者自洽");
	const names = await readdir(dirname(archive.filePathFor("sess-race")));
	assert.ok(!names.some((name) => name.endsWith(".tmp")), "并发写不得残留临时文件");
});

test("enqueueSave 串行：后入队的写入最后落地（旧快照不得覆盖新快照）", async (t) => {
	const { archive } = await tempArchive(t);
	await Promise.all([archive.enqueueSave("sess-order", [message({ text: "first" })]), archive.enqueueSave("sess-order", [message({ text: "second" }), message({ text: "second-2" })]), archive.enqueueSave("sess-order", [message({ text: "third" }), message({ text: "third-2" }), message({ text: "third-3" })])]);
	const back = await archive.read("sess-order");
	assert.equal(back.length, 3);
	assert.equal(back[0].text, "third");
});

test("写失败只记日志不抛：acp-sessions 目录位被普通文件占住时 save 静默降级", async (t) => {
	const dir = await tempDir(t);
	await writeFile(join(dir, "acp-sessions"), "not a directory", "utf8");
	const warnings = [];
	const archive = new AcpSessionArchive({ userDataDir: dir, logger: { warn: (channel, msg) => warnings.push({ channel, message: msg }) } });
	await archive.save("sess-broken", [message()]); // 不抛
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0].channel, "acp");
	assert.match(warnings[0].message, /write failed/);
	assert.equal((await archive.read("sess-broken")).length, 0);
});

test("未配置 userData 目录时写盘静默失败、读回为空（fail-safe，不影响会话）", async (t) => {
	const warnings = [];
	const archive = new AcpSessionArchive({ userDataDir: "", logger: { warn: (channel, msg) => warnings.push({ channel, message: msg }) } });
	await archive.save("sess-no-root", [message()]);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0].message, /write failed/);
	assert.equal((await archive.read("sess-no-root")).length, 0);
});
