import type { PiSkillLocation } from "./types/skills";

export type GlobalSkillSourceId = Extract<
	PiSkillLocation["id"],
	"pi-global" | "agents-global"
>;

/** Global skill identities include their discovery root so equal names do not cross scopes. */
export function isGlobalSkillSourceId(sourceId: PiSkillLocation["id"]): sourceId is GlobalSkillSourceId {
	return sourceId === "pi-global" || sourceId === "agents-global";
}

export function globalSkillOverrideKey(sourceId: GlobalSkillSourceId, name: string): string {
	return `${sourceId}:${name.trim().toLowerCase()}`;
}

/** Global prompts have one managed discovery root; normalize the command name for stable matching. */
export function globalPromptOverrideKey(name: string): string {
	return name.trim().toLowerCase();
}
