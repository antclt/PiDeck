import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { MAC_MANUAL_LATEST_RELEASE_URL, createMacManualUpdateChecker, parseGitHubReleaseVersion, parseLatestReleaseTagFromJson, resolveLatestReleaseVersion, shouldReadJsonBody } = loadTsCommonJs("src/main/update/macManualUpdate.ts", {
	stubs: {
		electron: {
			net: {
				fetch: async () => {
					throw new Error("not used in test");
				},
			},
		},
	},
});

test("parseGitHubReleaseVersion accepts a redirected latest-release tag only", () => {
	assert.equal(parseGitHubReleaseVersion("https://github.com/pideck-app/PiDeck/releases/tag/v0.7.4"), "0.7.4");
	assert.equal(parseGitHubReleaseVersion("https://github.com/pideck-app/PiDeck/releases/tag/0.7.4-beta.1"), "0.7.4-beta.1");
	assert.equal(parseGitHubReleaseVersion("https://github.com/pideck-app/PiDeck/releases/latest"), null);
	assert.equal(parseGitHubReleaseVersion("https://atomgit.com/ayuayue/PiDeck/releases/latest"), null);
	assert.equal(parseGitHubReleaseVersion("not a URL"), null);
});

test("parseLatestReleaseTagFromJson reads AtomGit / GitHub REST tag_name", () => {
	assert.equal(parseLatestReleaseTagFromJson(JSON.stringify({ tag_name: "v0.7.6" })), "0.7.6");
	assert.equal(parseLatestReleaseTagFromJson(JSON.stringify({ tag_name: "0.7.6" })), "0.7.6");
	assert.equal(parseLatestReleaseTagFromJson("{"), null);
	assert.equal(parseLatestReleaseTagFromJson(JSON.stringify({ name: "v0.7.6" })), null);
});

test("resolveLatestReleaseVersion prefers a GitHub tag URL, then JSON tag_name", () => {
	assert.equal(
		resolveLatestReleaseVersion({
			url: "https://github.com/pideck-app/PiDeck/releases/tag/v0.7.4",
			body: JSON.stringify({ tag_name: "v9.9.9" }),
		}),
		"0.7.4",
	);
	assert.equal(
		resolveLatestReleaseVersion({
			url: "https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/releases/latest",
			body: JSON.stringify({ tag_name: "v0.7.6" }),
		}),
		"0.7.6",
	);
	assert.equal(
		resolveLatestReleaseVersion({
			url: "https://atomgit.com/ayuayue/PiDeck/releases/latest",
		}),
		null,
	);
});

test("shouldReadJsonBody is true for OpenAPI hosts and JSON content types", () => {
	assert.equal(shouldReadJsonBody("https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/releases/latest", "text/plain"), true);
	assert.equal(shouldReadJsonBody("https://api.github.com/repos/pideck-app/PiDeck/releases/latest", ""), true);
	assert.equal(shouldReadJsonBody("https://github.com/pideck-app/PiDeck/releases/latest", "text/html"), false);
	assert.equal(shouldReadJsonBody("https://atomgit.com/ayuayue/PiDeck/releases/latest", "text/html"), false);
	assert.equal(shouldReadJsonBody("https://example.com/latest", "application/json; charset=utf-8"), true);
});

test("manual macOS checker uses the static latest redirect and detects beta -> stable", async () => {
	let requestedUrl = "";
	const check = createMacManualUpdateChecker({
		fetchLatestRelease: async (url) => {
			requestedUrl = url;
			return {
				ok: true,
				status: 200,
				url: "https://github.com/pideck-app/PiDeck/releases/tag/v0.7.4",
			};
		},
	});

	const result = await check("0.7.3-beta");
	assert.equal(requestedUrl, MAC_MANUAL_LATEST_RELEASE_URL);
	assert.equal(result.latestVersion, "0.7.4");
	assert.equal(result.hasUpdate, true);
});

test("manual macOS checker does not flag the same stable version", async () => {
	const check = createMacManualUpdateChecker({
		fetchLatestRelease: async () => ({
			ok: true,
			status: 200,
			url: "https://github.com/pideck-app/PiDeck/releases/tag/v0.7.4",
		}),
	});

	const result = await check("0.7.4");
	assert.equal(result.latestVersion, "0.7.4");
	assert.equal(result.hasUpdate, false);
});

test("manual macOS checker reads AtomGit OpenAPI tag_name when the HTML page has no tag URL", async () => {
	let requestedUrl = "";
	const apiUrl = "https://api.atomgit.com/api/v5/repos/ayuayue/PiDeck/releases/latest";
	const check = createMacManualUpdateChecker({
		fetchLatestRelease: async (url) => {
			requestedUrl = url;
			return {
				ok: true,
				status: 200,
				url: apiUrl,
				body: JSON.stringify({ tag_name: "v0.7.6", release_status: "latest" }),
			};
		},
	});

	const result = await check("0.7.6", apiUrl);
	assert.equal(requestedUrl, apiUrl);
	assert.equal(result.latestVersion, "0.7.6");
	assert.equal(result.hasUpdate, false);
});

test("manual macOS checker surfaces HTTP and unresolved latest-release failures", async () => {
	const unavailable = createMacManualUpdateChecker({
		fetchLatestRelease: async () => ({ ok: false, status: 503, url: "" }),
	});
	await assert.rejects(() => unavailable("0.7.3"), /503/);

	const spaShell = createMacManualUpdateChecker({
		fetchLatestRelease: async () => ({
			ok: true,
			status: 200,
			url: "https://atomgit.com/ayuayue/PiDeck/releases/latest",
		}),
	});
	await assert.rejects(() => spaShell("0.7.3"), /did not resolve/);
});
