/**
 * 自定义主题包存储：userData/custom-themes/ 目录的扫描/读取/保存/删除。
 * 校验一律走 shared/customThemes.parseCustomThemePackage（用户 JSON 视为不可信输入，
 * 与内置扩展清单同等姿态：解析失败不致命，条目降级为 parseError 呈现）。
 */
import { app } from "electron";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { trashPath } from "../fs/trash";
import { getAppLogger } from "../logging/sharedLogger";
import { CUSTOM_THEME_ID_PATTERN, DEMO_CUSTOM_THEME, parseCustomThemePackage, serializeCustomThemePackage, type CustomThemeListItem } from "../../shared/customThemes";

/** 用户主题存放目录（与 backgrounds/ 同级的受管目录） */
export function customThemesDir(): string {
	return join(app.getPath("userData"), "custom-themes");
}

/** 内置示例主题条目（由 DEMO_CUSTOM_THEME 常量推导，校验通过才上架，防常量与校验器漂移） */
function builtinDemoItem(): CustomThemeListItem | null {
	const parsed = parseCustomThemePackage(serializeCustomThemePackage(DEMO_CUSTOM_THEME));
	if (!parsed.ok) return null;
	return { source: "builtin", id: parsed.theme.id, name: parsed.theme.name, version: parsed.theme.version, author: parsed.theme.author, description: parsed.theme.description, tokens: parsed.tokens };
}

/** 列出全部主题：内置示例在前，用户目录按文件名序；解析失败的用户文件保留为错误条目 */
export async function listCustomThemes(): Promise<{ dir: string; themes: CustomThemeListItem[] }> {
	const dir = customThemesDir();
	const themes: CustomThemeListItem[] = [];
	const demo = builtinDemoItem();
	if (demo) themes.push(demo);
	await mkdir(dir, { recursive: true }).catch(() => undefined);
	const files = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json")).sort();
	for (const file of files) {
		const raw = await readFile(join(dir, file), "utf8").catch(() => null);
		if (raw === null) continue;
		const parsed = parseCustomThemePackage(raw);
		if (parsed.ok) {
			themes.push({ source: "user", id: parsed.theme.id, name: parsed.theme.name, version: parsed.theme.version, author: parsed.theme.author, description: parsed.theme.description, tokens: parsed.tokens });
		} else {
			// 文件名去 .json 作为 id 展示（该条目不可应用，仅供定位坏文件）
			themes.push({ source: "user", id: file.replace(/\.json$/, ""), name: file, tokens: { light: {}, dark: {} }, parseError: parsed.errors });
		}
	}
	return { dir, themes };
}

/** 读取主题原始 JSON 文本（编辑器用）：内置示例返回序列化 demo；用户主题必须存在 */
export async function readCustomTheme(id: string): Promise<string | null> {
	if (!CUSTOM_THEME_ID_PATTERN.test(id)) return null;
	if (id === DEMO_CUSTOM_THEME.id) return serializeCustomThemePackage(DEMO_CUSTOM_THEME);
	return readFile(join(customThemesDir(), `${id}.json`), "utf8").catch(() => null);
}

export type SaveCustomThemeResult = { ok: true; id: string } | { ok: false; errors: string[] };

/** 校验并保存主题包（id 即文件名 <id>.json）；校验失败返回错误清单，不落盘 */
export async function saveCustomTheme(raw: string): Promise<SaveCustomThemeResult> {
	const parsed = parseCustomThemePackage(raw);
	if (!parsed.ok) return { ok: false, errors: parsed.errors };
	const dir = customThemesDir();
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${parsed.theme.id}.json`), serializeCustomThemePackage(parsed.theme), "utf8");
	getAppLogger()?.info("customThemes", "Custom theme saved", { id: parsed.theme.id });
	return { ok: true, id: parsed.theme.id };
}

/** 删除用户主题文件（id 白名单校验 + 回收站，可恢复；内置示例不可删） */
export async function deleteCustomTheme(id: string): Promise<void> {
	if (!CUSTOM_THEME_ID_PATTERN.test(id) || id === DEMO_CUSTOM_THEME.id) return;
	await trashPath(join(customThemesDir(), `${id}.json`), { source: "customThemes:delete" });
	getAppLogger()?.info("customThemes", "Custom theme deleted", { id });
}
