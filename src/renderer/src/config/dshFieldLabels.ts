import { t, type TranslationKey } from "../i18n";

/**
 * DSH schema 字段的可读文案。
 * schemastery 通常不带 title，自定义设置里若只用 path 末段或空 path，
 * 会显示 raw key / "(root)"，用户不知道密钥和 Base URL 该怎么填。
 */
const FIELD_COPY: Record<string, {
	label: TranslationKey;
	hint?: TranslationKey;
	placeholder?: TranslationKey;
}> = {
	baseURL: {
		label: "config.dsh.field.baseURL",
		hint: "config.dsh.field.baseURLHint",
		placeholder: "config.dsh.field.baseURLPlaceholder",
	},
	baseUrl: {
		label: "config.dsh.field.baseURL",
		hint: "config.dsh.field.baseURLHint",
		placeholder: "config.dsh.field.baseURLPlaceholder",
	},
	api: {
		label: "config.dsh.field.api",
		hint: "config.dsh.field.apiHint",
	},
	apiKeyEnv: {
		label: "config.dsh.field.apiKeyEnv",
		hint: "config.dsh.field.apiKeyEnvHint",
		placeholder: "config.dsh.field.apiKeyEnvPlaceholder",
	},
	displayName: {
		label: "config.dsh.field.displayName",
		hint: "config.dsh.field.displayNameHint",
		placeholder: "config.dsh.field.displayNamePlaceholder",
	},
	headers: {
		label: "config.dsh.field.headers",
		hint: "config.dsh.field.headersHint",
	},
};

export type DshFieldCopy = {
	label: string;
	hint?: string;
	placeholder?: string;
};

/** 把 schema 字段名翻成界面文案；未知字段回退字段名，空名不显示 (root)。 */
export function dshFieldCopy(name: string): DshFieldCopy {
	const known = FIELD_COPY[name];
	if (known) {
		return {
			label: t(known.label),
			hint: known.hint ? t(known.hint) : undefined,
			placeholder: known.placeholder ? t(known.placeholder) : undefined,
		};
	}
	return { label: name };
}

/**
 * 自定义设置里应隐藏的字段：密钥已在卡片上方单独编辑，
 * apiKeyEnv 只是凭证槽位名，放在表单里容易被当成「把密钥填这里」。
 */
export function isDshCustomSettingsHiddenField(name: string, meta?: Record<string, unknown>): boolean {
	if (name === "models" || name === "apiKeyEnv") return true;
	return meta?.role === "secret" || meta?.role === "credential-ref";
}
