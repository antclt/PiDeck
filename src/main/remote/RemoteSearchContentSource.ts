/**
 * Frozen bounded content search, deployed as its own bundle file (search-content.mjs) and imported by helper.mjs.
 *
 * Why a sibling artifact instead of growing the protocol entry: opening file bodies is the first read that can
 * spend seconds and megabytes, so it gets one reviewed, content-addressed file whose whole surface is the bound
 * list below. The entry keeps only dispatch, path containment and cancellation; the walk itself lives here.
 *
 * Security model (each item is an invariant of the frozen body):
 * - the walk starts at the request path the entry already resolved inside the canonical root, never follows a
 *   symbolic link (dirent link entries, and links between readdir and open via O_NOFOLLOW), and every path it
 *   builds is path.join of a directory it opened and a name that directory reported;
 * - a file is opened read-only after fstat proves it is a regular file and its size fits the per-file and
 *   remaining byte budgets; an oversized file is skipped without reading, a file past the remaining budget
 *   stops the walk with reason "bytes" instead of being shortened;
 * - a file whose first 8 KiB contain a NUL byte is binary and is skipped; strict UTF-8 decoding failure skips it
 *   too. Both are "not text", never a truncation and never a raw byte in the answer;
 * - a match carries only relative path, basename, 1-based line, 0-based column and at most 200 characters of
 *   that line: no file body ever leaves the helper, and no snippet can push a frame near the 8 MiB cap;
 * - the answer is bounded by 200 matches, 2000 files, 16 MiB read, 8 s of scanning and depth 12; the walk stops
 *   at the entry/file that exceeds a bound and reports truncated:true with the reason, so a bounded answer is
 *   deterministic instead of quietly looking complete;
 * - cancellation is checked at every entry boundary (the entry marks the job aborted through the same
 *   `cancel` path fs.searchNames uses), so a cancelled walk settles exactly once with REQUEST_CANCELLED.
 */

export const REMOTE_SEARCH_CONTENT_SOURCE = String.raw`"use strict";
/* Bounded remote content search (helper 1.25.0), deployed as its own artifact search-content.mjs and imported by helper.mjs.
   Every bound is repeated from RemoteHelperContract.ts under test. The walk never follows a link, never returns a file body,
   never decodes a binary file and stops at its first exceeded budget with an honest truncated/reason answer. */
export function createContentSearch(root, fs, path) {
	const MAX_MATCHES = 200;
	const MAX_SCANNED_FILES = 2000;
	const MAX_SCANNED_BYTES = 16777216;
	const MAX_FILE_BYTES = 1048576;
	const MAX_BINARY_PROBE = 8192;
	const MAX_SNIPPET = 200;
	const MAX_DEPTH = 12;
	const MAX_TIME = 8000;
	const SLICE = 32;
	const OPEN_READ = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW === undefined ? 0 : fs.constants.O_NOFOLLOW);
	/* A path this walk builds is always path.join of a directory it already opened and a name from that directory. */
	function inside(candidate) { return candidate === root || candidate.startsWith(root + path.sep); }
	function compareName(left, right) { return left.name < right.name ? -1 : left.name > right.name ? 1 : 0; }
	/* One bounded readdir. An unreadable directory is skipped, never turned into a failed search. */
	function readDirectory(absolute) {
		if (inside(absolute) === false) return null;
		let directory = null;
		try { directory = fs.opendirSync(absolute); } catch { return null; }
		const entries = [];
		try {
			for (;;) {
				const entry = directory.readSync();
				if (entry === null) break;
				entries.push(entry);
			}
		} catch { return null; } finally {
			try { directory.closeSync(); } catch { /* the descriptor is already gone */ }
		}
		entries.sort(compareName);
		return entries;
	}
	/* dirent types are not reported by every filesystem: one lstat decides, and a link is never a file or a directory here. */
	function kindOf(entry, absolute, name) {
		if (entry.isDirectory()) return "directory";
		if (entry.isFile()) return "file";
		if (entry.isSymbolicLink()) return "link";
		let stats = null;
		try { stats = fs.lstatSync(path.join(absolute, name)); } catch { return "other"; }
		if (stats.isDirectory()) return "directory";
		if (stats.isFile()) return "file";
		return "other";
	}
	/* fstat decides the size before a byte is read: an oversized file is refused without reading it, and a file past the
	   remaining budget stops the walk instead of being shortened into a plausible-looking half result. */
	function readFile(absolute, budget) {
		if (inside(absolute) === false) return null;
		let handle = null;
		try { handle = fs.openSync(absolute, OPEN_READ); } catch { return null; }
		try {
			const stats = fs.fstatSync(handle);
			if (stats.isFile() !== true) return null;
			const size = Number(stats.size);
			if (size > MAX_FILE_BYTES) return { tooLarge: true };
			if (size > budget) return { overBudget: true };
			const buffer = Buffer.allocUnsafe(size);
			let read = 0;
			while (read < size) {
				const count = fs.readSync(handle, buffer, read, size - read, read);
				if (count < 1) break;
				read += count;
			}
			if (read !== size) return null;
			return { buffer: buffer, bytes: size };
		} catch { return null; } finally {
			try { fs.closeSync(handle); } catch { /* the descriptor is already gone */ }
		}
	}
	/* One hit per matching line, mirroring the file-index result shape: line is 1-based, column is the 0-based
	   character offset, and the snippet is a bounded slice of that line. A file is skipped, not searched, when its first
	   8 KiB contain a NUL byte or when strict UTF-8 decoding rejects it: those are "not text", not truncation. */
	function matchesOf(buffer, relative, name, needle, limit, matches) {
		const probe = buffer.subarray(0, Math.min(buffer.length, MAX_BINARY_PROBE));
		if (probe.indexOf(0) >= 0) return 0;
		let text = null;
		try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { return 0; }
		let matched = 0;
		let line = 1;
		let start = 0;
		for (;;) {
			let end = text.indexOf("\n", start);
			if (end < 0) end = text.length;
			const raw = text.slice(start, end);
			const value = raw.length > 0 && raw.charAt(raw.length - 1) === "\r" ? raw.slice(0, -1) : raw;
			const column = value.toLowerCase().indexOf(needle);
			if (column >= 0) {
				matched += 1;
				matches.push({ path: relative, name: name, line: line, column: column, snippet: value.slice(column, column + MAX_SNIPPET) });
				if (matches.length >= limit) return matched;
			}
			if (end === text.length) break;
			start = end + 1;
			line += 1;
		}
		return matched;
	}
	function resultOf(state, matches) {
		const result = { matches: matches, matchedFiles: state.matchedFiles, scannedFiles: state.scannedFiles, scannedBytes: state.scannedBytes, truncated: state.truncated };
		if (state.truncated === true) result.reason = state.reason;
		return result;
	}
	/* Breadth-first, name-ordered, one slice per turn: cancellation and the deadline are checked at entry boundaries, so a
	   cancel answers exactly one REQUEST_CANCELLED instead of half an answer. */
	function search(job, done) {
		const state = { matchedFiles: 0, scannedFiles: 0, scannedBytes: 0, truncated: false, reason: undefined };
		const matches = [];
		const walk = { pending: [{ absolute: job.absolute, relative: "", depth: 0 }], current: null };
		const deadline = Math.min(job.deadlineAt > 0 ? job.deadlineAt : Infinity, Date.now() + MAX_TIME);
		const limit = job.maxMatches < 1 ? 1 : job.maxMatches > MAX_MATCHES ? MAX_MATCHES : job.maxMatches;
		const needle = String(job.needle).toLowerCase();
		let settled = false;
		function finish(code, reason) {
			if (settled) return;
			settled = true;
			if (code !== null) { done(code, null); return; }
			if (reason !== undefined) { state.truncated = true; state.reason = reason; }
			matches.sort(function (left, right) { return left.path < right.path ? -1 : left.path > right.path ? 1 : left.line - right.line; });
			done(null, resultOf(state, matches));
		}
		function step() {
			if (settled) return;
			if (job.aborted === true) { finish("REQUEST_CANCELLED", undefined); return; }
			if (Date.now() > deadline) { finish(null, "time"); return; }
			let visited = 0;
			while (visited < SLICE) {
				if (settled) return;
				if (walk.current === null) {
					if (walk.pending.length === 0) { finish(null, undefined); return; }
					const next = walk.pending.shift();
					const entries = readDirectory(next.absolute);
					if (entries === null) continue;
					walk.current = { absolute: next.absolute, relative: next.relative, depth: next.depth, entries: entries, index: 0 };
					continue;
				}
				const current = walk.current;
				if (current.index >= current.entries.length) { walk.current = null; continue; }
				const entry = current.entries[current.index];
				current.index += 1;
				visited += 1;
				const name = entry.name;
				const relative = current.relative === "" ? name : current.relative + "/" + name;
				const kind = kindOf(entry, current.absolute, name);
				if (kind === "directory") {
					if (current.depth + 1 >= MAX_DEPTH) { finish(null, "depth"); return; }
					walk.pending.push({ absolute: path.join(current.absolute, name), relative: relative, depth: current.depth + 1 });
					continue;
				}
				if (kind !== "file") continue;
				if (state.scannedFiles >= MAX_SCANNED_FILES) { finish(null, "files"); return; }
				if (state.scannedBytes >= MAX_SCANNED_BYTES) { finish(null, "bytes"); return; }
				const file = readFile(path.join(current.absolute, name), MAX_SCANNED_BYTES - state.scannedBytes);
				if (file === null) continue;
				if (file.tooLarge === true) { state.truncated = true; state.reason = "file-size"; continue; }
				if (file.overBudget === true) { finish(null, "bytes"); return; }
				state.scannedFiles += 1;
				state.scannedBytes += file.bytes;
				const count = matchesOf(file.buffer, relative, name, needle, limit, matches);
				if (count > 0) state.matchedFiles += 1;
				if (matches.length >= limit) { finish(null, "matches"); return; }
			}
			setImmediate(step);
		}
		step();
	}
	return { search: search };
}
`.replace(/\r?\n[\t ]*/g, "");

/** sha256 of REMOTE_SEARCH_CONTENT_SOURCE as UTF-8 bytes; pinned here and re-checked by the helper contract tests. */
export const REMOTE_HELPER_SEARCH_CONTENT_SHA256 = "2bb7689549ea9877f3149febf276a0a75cccffa68a0d5673bc973fdbd64dbe4d";
