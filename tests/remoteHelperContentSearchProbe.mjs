/**
 * 远端内容搜索协议级真机探针（本轮验证用，**不是默认单测**）。
 *
 * 为什么不做 UI 端到端：现有 e2e 没有文件搜索入口（grep searchContent e2e/ = 0），
 * 而新增 e2e spec 不在 verifier 的写作用域内。这里退一步，做**协议级真机证据**：
 * 直接用真实主机上**已部署的 helper bundle** 起一个 helper 进程，按 NDJSON 契约发帧。
 *
 * 验什么：
 * 1) hello → capabilities 含 fs.searchContent、helperVersion/nodeVersion 可读；
 * 2) fs.searchContent → 命中已知文本关键词；二进制文件被跳过（不产生匹配）；
 *    结果含 matches/matchedFiles/scannedFiles/scannedBytes/truncated；
 * 3) 非法查询（空 query） → 稳定拒绝（ok:false + code），不是挂死或静默空结果；
 * 4) 旧 helper 回退：若 capabilities 不含 fs.searchContent（部署的是旧 bundle），
 *    记录该事实并说明主进程路由会返回 null（仅文件名回退），需要一次远程连接触发内容寻址的热更新部署。
 *
 * 只读产品数据：只在 $HOME 下建一个临时目录并在结束时删除；不打印主机名/用户名。
 * 凭据只从 PIDECK_E2E_REMOTE_* 读（由 %TEMP%\pideck-v-probe.ps1 在进程内派生）。
 *
 * 用法：node tests/remoteHelperContentSearchProbe.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const host = process.env.PIDECK_E2E_REMOTE_HOST ?? "";
const user = process.env.PIDECK_E2E_REMOTE_USER ?? "";
const port = process.env.PIDECK_E2E_REMOTE_PORT ?? "22";
const FINGERPRINT = process.env.PIDECK_E2E_REMOTE_FINGERPRINT ?? "";
const HOST_ID = "33333333-3333-4333-8333-333333333333";
const PROBE_KEYWORD = "PIDECK_CONTENT_PROBE_OK";
const out = { host: "<host>", user: "<user>", fp: FINGERPRINT === "" ? "<missing>" : "<set>", steps: {}, verdict: "unknown" };

function sshBase(extra = []) {
	return ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=8", "-p", port, ...extra, user + "@" + host];
}

function sshRun(command, timeout = 30_000) {
	const result = spawnSync("ssh", [...sshBase(), command], { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
	return { status: result.status, stdout: result.stdout ?? "", stderr: (result.stderr ?? "").trim().slice(0, 200) };
}

function sanitize(text) {
	return String(text).split(host).join("<host>").split(user).join("<user>");
}

let tmpDir = "";
let helper = null;
const lines = [];

function nextLine(timeoutMs) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const done = (value, error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(value);
		};
		const timer = setTimeout(() => done(null, new Error("FRAME_TIMEOUT")), timeoutMs);
		const onData = (chunk) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
			for (const line of buffer.split("\n")) {
				if (line.trim() === "") continue;
				try {
					done(JSON.parse(line));
					return;
				} catch {
					void 0;
				}
			}
		};
		helper.stdout.once("data", onData);
		helper.stderr.once("data", (chunk) => lines.push(sanitize(chunk.toString("utf8")).slice(0, 200)));
	});
}

function send(frame) {
	helper.stdin.write(JSON.stringify(frame) + "\n");
}

try {
	if (host === "" || user === "") throw new Error("MISSING_CREDENTIALS");
	const fingerprintExpected = FINGERPRINT !== "" && FINGERPRINT.startsWith("SHA256:");

	// 1) 找已部署的 helper bundle（内容寻址目录里最新的一个）+ 远端 node（登录 shell 里的 nvm node）。
	const bundleList = sshRun("ls -1dt $HOME/.pideck/remote-host/bundles/*/ 2>/dev/null | head -3");
	const bundles = bundleList.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
	out.steps.deployedBundles = bundles.length;
	if (bundles.length === 0) throw new Error("NO_DEPLOYED_BUNDLE");
	const bundlePath = bundles[0].trim().replace(/\/$/, "");

	const nodeProbe = sshRun("bash -lc 'command -v node' 2>/dev/null || command -v node");
	const nodePath = nodeProbe.stdout.split(/\r?\n/).filter(Boolean).pop() ?? "";
	if (nodePath === "") throw new Error("NO_REMOTE_NODE");
	out.steps.nodeVersion = sshRun(nodePath + " -v").stdout.trim();

	const helperPath = bundlePath + "/helper.mjs";
	const presence = sshRun("[ -f '" + helperPath + "' ] && echo helper=yes; [ -f '" + bundlePath + "/search-content.mjs' ] && echo content=yes");
	out.steps.artifact = { helperMjs: presence.stdout.includes("helper=yes"), searchContentMjs: presence.stdout.includes("content=yes") };
	out.steps.helperSha256 =
		sshRun("sha256sum '" + helperPath + "' | cut -d' ' -f1")
			.stdout.trim()
			.slice(0, 16) + "…";

	// 2) 临时项目目录：文本关键词 + 二进制（前 8KiB 含 NUL）+ 一个深层目录。
	tmpDir = sshRun("mktemp -d $HOME/.pideck-content-probe.XXXXXX").stdout.trim();
	if (tmpDir === "" || !tmpDir.startsWith("/")) throw new Error("MKTEMP_FAILED");
	const probeFile = tmpDir + "/note.txt";
	const binaryFile = tmpDir + "/blob.bin";
	const deepFile = tmpDir + "/d1/d2/d3/deep.txt";
	const setup = [
		"mkdir -p '" + tmpDir + "/d1/d2/d3'",
		"printf 'hello\\n" + PROBE_KEYWORD + " 这一行是命中行\\n' > '" + probeFile + "'",
		"head -c 64 /dev/zero > '" + binaryFile + "' && printf '" + PROBE_KEYWORD + "' >> '" + binaryFile + "'",
		"printf '" + PROBE_KEYWORD + " deep\\n' > '" + deepFile + "'",
		"chmod 600 '" + probeFile + "' '" + binaryFile + "' '" + deepFile + "'",
	].join(" && ");
	const setupResult = sshRun(setup);
	if (setupResult.status !== 0) throw new Error("FIXTURE_SETUP_FAILED");

	// 3) 起 helper（--root 限定到临时目录），按 NDJSON 契约发帧。
	helper = spawn("ssh", [...sshBase(["-T"]), nodePath + " '" + helperPath + "' --root '" + tmpDir + "'"], { stdio: ["pipe", "pipe", "pipe"] });
	helper.stdin.setDefaultEncoding("utf8");

	send({ v: 1, hostId: HOST_ID, generation: 1, id: "hello-1", method: "hello", timeoutMs: 10_000, params: {} });
	const hello = await nextLine(20_000);
	out.steps.hello = {
		ok: hello.ok === true,
		helperVersion: hello.result?.helperVersion ?? null,
		nodeVersion: hello.result?.nodeVersion ?? null,
		capabilityCount: Array.isArray(hello.result?.capabilities) ? hello.result.capabilities.length : null,
		hasContentCapability: Array.isArray(hello.result?.capabilities) ? hello.result.capabilities.includes("fs.searchContent") : false,
	};

	if (out.steps.hello.hasContentCapability !== true) {
		out.steps.searchContent = { skipped: true, reason: "OLD_HELPER_WITHOUT_CAPABILITY" };
		out.steps.fallback = "capabilities 不含 fs.searchContent ⇒ 主进程 files.searchContent 对远端项目返回 null（渲染层走「仅文件名」）；需要一次远程连接触发内容寻址热更新部署新 bundle";
		out.verdict = "old-helper-fallback";
	} else {
		send({ v: 1, hostId: HOST_ID, generation: 1, id: "search-1", method: "fs.searchContent", timeoutMs: 20_000, params: { path: ".", query: PROBE_KEYWORD, maxMatches: 50 } });
		const search = await nextLine(30_000);
		const result = search.result ?? {};
		const matches = Array.isArray(result.matches) ? result.matches : [];
		out.steps.searchContent = {
			ok: search.ok === true,
			error: search.error?.code ?? null,
			matches: matches.length,
			matchedFiles: result.matchedFiles ?? null,
			scannedFiles: result.scannedFiles ?? null,
			scannedBytes: result.scannedBytes ?? null,
			truncated: result.truncated ?? null,
			paths: matches.map((match) => match.path).sort(),
			binarySkipped: matches.every((match) => match.path !== "blob.bin"),
			deepFound: matches.some((match) => match.path === "d1/d2/d3/deep.txt"),
			keywordHit: matches.some((match) => typeof match.snippet === "string" && match.snippet.includes(PROBE_KEYWORD)),
			snippetBounded: matches.every((match) => typeof match.snippet !== "string" || match.snippet.length <= 200),
		};

		send({ v: 1, hostId: HOST_ID, generation: 1, id: "search-2", method: "fs.searchContent", timeoutMs: 10_000, params: { path: ".", query: "" } });
		const invalid = await nextLine(15_000);
		out.steps.invalidQuery = { ok: invalid.ok === true, code: invalid.error?.code ?? null };

		const searchOk = out.steps.searchContent.ok === true && out.steps.searchContent.matches >= 2 && out.steps.searchContent.binarySkipped === true && out.steps.searchContent.deepFound === true && out.steps.searchContent.keywordHit === true;
		const invalidRejected = out.steps.invalidQuery.ok === false && typeof out.steps.invalidQuery.code === "string";
		const fingerprintNote = fingerprintExpected ? "fingerprint provided (not printed)" : "fingerprint missing";
		out.steps.fingerprintNote = fingerprintNote;
		out.verdict = searchOk && invalidRejected ? "pass" : "fail";
	}
} catch (error) {
	out.error = sanitize(error instanceof Error ? error.message : String(error)).slice(0, 200);
	out.verdict = "error";
} finally {
	if (helper !== null) {
		try {
			helper.stdin.end();
		} catch {
			void 0;
		}
		helper.kill();
	}
	if (tmpDir !== "" && tmpDir.startsWith("/")) sshRun("rm -rf '" + tmpDir + "'");
	if (lines.length > 0) out.helperStderr = lines.slice(-3);
}

console.log(JSON.stringify(out, null, 2));
process.exit(out.verdict === "pass" || out.verdict === "old-helper-fallback" ? 0 : 1);
