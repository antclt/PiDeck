import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	USAGE_PROBE_DEFAULT_INTERVAL_MINUTES,
	providerUsageEntryStale,
	shouldAutoFetchProviderUsage,
} = loadTsCommonJs("src/renderer/src/hooks/providerUsageAutoQuery.ts");

const MINUTE = 60_000;
const NOW = 1_700_000_000_000;

function idleEntry() {
	return { status: "idle", fetchedAt: null, result: null, error: null };
}

function readyEntry(fetchedAt) {
	return { status: "ready", fetchedAt, result: { ok: true }, error: null };
}

test("default interval is 5 minutes", () => {
	assert.equal(USAGE_PROBE_DEFAULT_INTERVAL_MINUTES, 5);
});

test("never-fetched entry is stale even when interval is 0", () => {
	assert.equal(providerUsageEntryStale(idleEntry(), 0, NOW), true);
	assert.equal(providerUsageEntryStale(null, 5, NOW), true);
	assert.equal(providerUsageEntryStale(undefined, 5, NOW), true);
});

test("interval 0 with a completed fetch is not stale", () => {
	assert.equal(providerUsageEntryStale(readyEntry(NOW - MINUTE), 0, NOW), false);
});

test("fetched entry is stale only after the interval elapses", () => {
	const fetchedAt = NOW - 4 * MINUTE;
	assert.equal(providerUsageEntryStale(readyEntry(fetchedAt), 5, NOW), false);
	assert.equal(providerUsageEntryStale(readyEntry(fetchedAt), 4, NOW), true);
	assert.equal(providerUsageEntryStale(readyEntry(NOW - 5 * MINUTE), 5, NOW), true);
});

test("manual refresh always fetches, even when auto query is off", () => {
	assert.equal(
		shouldAutoFetchProviderUsage({
			autoQueryEnabled: false,
			reason: "manual",
			entry: idleEntry(),
			intervalMinutes: 0,
			now: NOW,
		}),
		true,
	);
});

test("auto query off blocks mount, poll, and batch", () => {
	for (const reason of ["mount", "poll", "batch"]) {
		assert.equal(
			shouldAutoFetchProviderUsage({
				autoQueryEnabled: false,
				reason,
				entry: idleEntry(),
				intervalMinutes: 5,
				now: NOW,
			}),
			false,
			`${reason} must not fire when auto query is off`,
		);
	}
});

test("auto query on mounts and batches only when the entry is stale", () => {
	assert.equal(
		shouldAutoFetchProviderUsage({
			autoQueryEnabled: true,
			reason: "mount",
			entry: idleEntry(),
			intervalMinutes: 0,
			now: NOW,
		}),
		true,
	);
	assert.equal(
		shouldAutoFetchProviderUsage({
			autoQueryEnabled: true,
			reason: "batch",
			entry: readyEntry(NOW - MINUTE),
			intervalMinutes: 0,
			now: NOW,
		}),
		false,
	);
	assert.equal(
		shouldAutoFetchProviderUsage({
			autoQueryEnabled: true,
			reason: "mount",
			entry: readyEntry(NOW - 6 * MINUTE),
			intervalMinutes: 5,
			now: NOW,
		}),
		true,
	);
});

test("poll only fires when auto query is on and interval is positive", () => {
	assert.equal(
		shouldAutoFetchProviderUsage({
			autoQueryEnabled: true,
			reason: "poll",
			entry: idleEntry(),
			intervalMinutes: 0,
			now: NOW,
		}),
		false,
	);
	assert.equal(
		shouldAutoFetchProviderUsage({
			autoQueryEnabled: true,
			reason: "poll",
			entry: readyEntry(NOW),
			intervalMinutes: 5,
			now: NOW,
		}),
		true,
	);
});
