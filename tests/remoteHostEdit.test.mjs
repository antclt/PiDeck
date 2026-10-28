import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");
const { SshHostPinStore } = loadTsCommonJs("src/main/remote/SshHostPinStore.ts");

function sshString(text) {
	const value = Buffer.isBuffer(text) ? text : Buffer.from(text);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(value.length);
	return Buffer.concat([size, value]);
}

function authenticatedCandidate(id) {
	const pinAlias = `pideck-${id}`;
	const key = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 23))]);
	const bytes = Buffer.from(`${pinAlias} ssh-ed25519 ${key.toString("base64")}\n`);
	return {
		hostName: "pi.example.invalid",
		user: "alice",
		port: 2222,
		pinAlias,
		routeDigest: createHash("sha256").update("route-v1").digest("hex"),
		knownHostsSha256: createHash("sha256").update(bytes).digest("hex"),
		knownHostsBase64: bytes.toString("base64"),
		hostKeyFingerprints: [`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`],
	};
}

async function verifiedHost(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-edit-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const pinStore = new SshHostPinStore(directory, { verifier: async (_route, alias) => authenticatedCandidate(alias.slice("pideck-".length)) });
	t.after(() => pinStore.dispose());
	const store = await RemoteHostStore.open(directory, { pinStore });
	const draft = await store.createDraft({ label: "Build Pi", sshHost: "build-pi", user: "alice", port: 2222, connectTimeoutMs: 15000 }, 0);
	const offer = await store.offerPin(draft.id, 7, 1);
	const approved = await store.confirmPin({ requestId: offer.requestId, hostId: draft.id, senderId: 7, choice: "approve" }, 1);
	assert.ok(approved?.verifiedEndpoint);
	return { directory, store, pinStore, id: draft.id };
}

// 编辑必须原位更新：换 id 会切断项目与会话的引用，也把同一台机器的历史拆成多行。
test("editing a label keeps the host id and its trust anchor", async (t) => {
	const { store, id } = await verifiedHost(t);
	const before = store.getSnapshot().profiles[0];
	const result = await store.updateProfile(id, { label: "Build Pi 2" }, store.getSnapshot().revision);
	assert.equal(result.endpointChanged, false);
	assert.equal(result.profile.id, id);
	assert.equal(result.profile.label, "Build Pi 2");
	assert.deepEqual(JSON.parse(JSON.stringify(result.profile.verifiedEndpoint)), JSON.parse(JSON.stringify(before.verifiedEndpoint)));
	assert.equal(store.getSnapshot().profiles.length, 1);
});

// 端点变了，旧 pin 描述的是另一台机器：verifiedEndpoint 与 pin 必须一起失效，强制重新确认指纹。
test("changing the endpoint drops the old verification and pin, keeping the same id", async (t) => {
	const { directory, store, pinStore, id } = await verifiedHost(t);
	const result = await store.updateProfile(id, { sshHost: "other-pi", port: 2200 }, store.getSnapshot().revision);
	assert.equal(result.endpointChanged, true);
	assert.equal(result.profile.id, id);
	assert.equal(result.profile.sshHost, "other-pi");
	assert.equal(result.profile.port, 2200);
	assert.equal(result.profile.verifiedEndpoint, undefined);
	assert.equal(result.profile.verifiedAt, undefined);
	assert.equal(pinStore.hasPendingOffer?.(id) ?? false, false);
	// 重新打开时快照仍然可用（清掉 verifiedEndpoint 后不再依赖那条 pin）。
	const reopened = await RemoteHostStore.open(directory);
	assert.equal(reopened.getSnapshot().status, "ready");
	assert.equal(reopened.getSnapshot().profiles[0].sshHost, "other-pi");
	const disk = JSON.parse(await readFile(join(directory, "remote-hosts.json"), "utf8"));
	assert.equal(disk.profiles[0].id, id);
	assert.equal(disk.profiles[0].verifiedEndpoint, undefined);
});

// 已停用的档案是墓碑，不是可编辑的配置。
test("a disabled host cannot be edited", async (t) => {
	const { store, id } = await verifiedHost(t);
	await store.disable(id, store.getSnapshot().revision);
	await assert.rejects(() => store.updateProfile(id, { label: "nope" }, store.getSnapshot().revision), /REMOTE_HOST_EDIT_INVALID/);
});

// 字段校验与新建同源：非法端口/空名称不得写进快照。
test("invalid edits are rejected before any write", async (t) => {
	const { store, id } = await verifiedHost(t);
	const revision = store.getSnapshot().revision;
	await assert.rejects(() => store.updateProfile(id, { label: "   " }, revision), /REMOTE_HOST_EDIT_INVALID/);
	await assert.rejects(() => store.updateProfile(id, { port: 70000 }, revision), /REMOTE_HOST_EDIT_INVALID/);
	await assert.rejects(() => store.updateProfile(id, { identityFile: "relative/key" }, revision), /REMOTE_HOST_EDIT_INVALID/);
	assert.equal(store.getSnapshot().revision, revision);
});
