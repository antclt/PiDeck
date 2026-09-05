import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	ProjectInheritedResourceToggleInput,
	ProjectResourceOverrides,
} from "../../shared/types";

const OVERRIDE_FIELDS = {
	extension: "pideckDisabledGlobalExtensions",
	skill: "pideckDisabledGlobalSkills",
	prompt: "pideckDisabledGlobalPrompts",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, normalize: (entry: string) => string = (entry) => entry): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const normalized = normalize(entry.trim());
		if (normalized) seen.add(normalized);
	}
	return [...seen];
}

function overridesFromRecord(settings: Record<string, unknown>): ProjectResourceOverrides {
	return {
		disabledGlobalExtensions: stringArray(settings[OVERRIDE_FIELDS.extension]),
		disabledGlobalSkills: stringArray(settings[OVERRIDE_FIELDS.skill], (entry) => entry.toLowerCase()),
		disabledGlobalPrompts: stringArray(settings[OVERRIDE_FIELDS.prompt], (entry) => entry.toLowerCase()),
	};
}

export function projectResourceOverridesFromRecord(
	settings: Record<string, unknown>,
): ProjectResourceOverrides {
	return overridesFromRecord(settings);
}

export function emptyProjectResourceOverrides(): ProjectResourceOverrides {
	return {
		disabledGlobalExtensions: [],
		disabledGlobalSkills: [],
		disabledGlobalPrompts: [],
	};
}

/** Reads PiDeck-only project overrides without treating malformed pi settings as trusted data. */
export function readProjectResourceOverrides(projectRoot: string): ProjectResourceOverrides {
	try {
		const parsed: unknown = JSON.parse(
			readFileSync(join(projectRoot, ".pi", "settings.json"), "utf8"),
		);
		if (!isRecord(parsed)) return emptyProjectResourceOverrides();
		return overridesFromRecord(parsed);
	} catch {
		return emptyProjectResourceOverrides();
	}
}

/** Persists one inherited-resource override while preserving every unrelated pi setting. */
export async function setProjectInheritedResourceEnabled(
	settingsFile: string,
	kind: ProjectInheritedResourceToggleInput["kind"],
	key: string,
	enabled: boolean,
	invalidJsonMessage: string,
): Promise<ProjectResourceOverrides> {
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsFile)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(settingsFile, "utf8"));
		} catch {
			throw new Error(invalidJsonMessage);
		}
		if (!isRecord(parsed)) throw new Error(invalidJsonMessage);
		settings = parsed;
	}

	const field = OVERRIDE_FIELDS[kind];
	const normalize = kind === "extension"
		? (entry: string) => entry
		: (entry: string) => entry.toLowerCase();
	const current = stringArray(settings[field], normalize);
	const next = current.filter((entry) => entry !== key);
	if (!enabled) next.push(key);
	settings[field] = next;
	await mkdir(dirname(settingsFile), { recursive: true });
	await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	return overridesFromRecord(settings);
}
