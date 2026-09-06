import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const configModal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
const skills = readFileSync("src/renderer/src/config/SkillsTab.tsx", "utf8");
const prompts = readFileSync("src/renderer/src/config/PromptsTab.tsx", "utf8");
const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const rendererStyles = readFileSync("src/renderer/src/styles.css", "utf8");
const settingsModal = readFileSync("src/renderer/src/components/app/SettingsModal.tsx", "utf8");
const commonTab = readFileSync("src/renderer/src/components/app/settings/CommonTab.tsx", "utf8");
const projectResources = readFileSync("src/renderer/src/components/app/ProjectResourcesModal.tsx", "utf8");
const workspaceStyles = readFileSync("src/renderer/src/styles/workspace.css", "utf8");
const zhCopy = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enCopy = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
const tabs = readFileSync("src/renderer/src/components/ui-shadcn/tabs.tsx", "utf8");
const skillTableRow = skills.slice(skills.indexOf("function SkillTableRow"));

test("config shell defines compact density and crisp system typography", () => {
  assert.match(surfaces, /\.config-modal \[data-slot="button"\]/);
  assert.match(surfaces, /\.config-modal \[data-slot="input"\]/);
  // Windows/Electron 小字号中文需要保留子像素抗锯齿；config modal 不能强制 grayscale antialiasing。
  assert.match(surfaces, /\.config-modal \{[\s\S]*-webkit-font-smoothing: subpixel-antialiased/);
  assert.match(surfaces, /\.config-modal \{[\s\S]*text-rendering: auto/);
  assert.doesNotMatch(surfaces, /\.config-modal \{[\s\S]*-webkit-font-smoothing: antialiased;/);
  assert.match(surfaces, /\.config-nav-btn \{[\s\S]*font-size:\s*14px/);
  // 选中态随 Vertical Tabs 迁移：由 TabsTrigger data-[state=active] utility 承担
  assert.match(tabs, /data-\[state=active\]:bg-bg-panel/);
  assert.doesNotMatch(surfaces, /\.config-nav-btn\.active \{/);
  assert.match(foundation, /Segoe UI Variable Text/);
  assert.match(foundation, /Microsoft YaHei UI/);
  assert.doesNotMatch(foundation, /MiSans/);
  // 语言下拉的 "system" 选项位于常用设置 tab（CommonTab，自 SettingsModal 拆分）
  assert.match(commonTab, /value: "system"/);
  assert.doesNotMatch(rendererStyles, /styles\/lxgw-wenkai\.css/);
  assert.doesNotMatch(rendererStyles, /misans/i);
  assert.equal(existsSync("src/renderer/assets/fonts/misans"), false);
  assert.equal(existsSync("src/renderer/src/styles/misans"), false);
  assert.equal(existsSync("src/renderer/assets/fonts/lxgw-wenkai"), false);
  assert.equal(existsSync("src/renderer/src/styles/lxgw-wenkai.css"), false);
  assert.doesNotMatch(rendererStyles, /lxgw-wenkai/);
  assert.doesNotMatch(surfaces, /\.config-models-grid-header[\s\S]*font-weight: 650/);
  assert.match(configModal, /configModalSizeClass/);
  assert.match(configModal, /w-\[80vw\]/);
  assert.match(configModal, /max-w-\[80vw\]/);
  assert.match(configModal, /h-\[80vh\]/);
  assert.match(configModal, /sm:max-w-\[min\(1300px,80vw\)\]/);
  assert.match(configModal, /max-\[820px\]:flex-col/);
  assert.match(configModal, /max-\[820px\]:flex-row/);
  assert.match(settingsModal, /settingsModalSizeClass/);
  assert.match(settingsModal, /w-\[80vw\]/);
  assert.match(surfaces, /\.settings-modal \{[\s\S]*width: min\(1300px, 80vw\);[\s\S]*height: min\(850px, 80vh\);/);
  assert.match(surfaces, /\.config-modal \{[\s\S]*width: min\(1300px, 80vw\);[\s\S]*height: min\(850px, 80vh\);/);
});

test("project resources use one consistent shadcn management shell", () => {
  // 弹窗必须只有一套标题栏和一套 tab rail；重复 header 会造成截图中的空白与关闭按钮错位。
  assert.match(projectResources, /<DialogHeader className="[^"]*border-b/);
  assert.doesNotMatch(projectResources, /<header className="project-resources-header"/);
  assert.match(projectResources, /<Tabs\n\s+value=\{activeTab\}/);
  assert.match(projectResources, /<TabsList className="[^"]*w-full/);
  assert.match(projectResources, /from "\.\.\/ui-shadcn\/(?:alert|scroll-area)"/);
  assert.match(projectResources, /<Alert variant="destructive"/);
  assert.match(projectResources, /<ScrollArea className=/);

  // 视觉重排只能换容器；项目资源的切换、编辑、启停、删除和刷新流程必须仍在页面中。
  for (const contract of [
    "toggleSkill",
    "toggleExtension",
    "confirmDelete",
    "openEditor",
    "openProjectPromptEditor",
    "refresh",
    "loadPrompts",
  ]) {
    assert.match(projectResources, new RegExp(`\\b${contract}\\b`));
  }
});

test("project resource cards stack metadata and keep destructive actions discoverable", () => {
  // 卡片内容必须垂直排布；横向 flex 会把名称、状态和路径挤成截图中的一条线。
  assert.match(workspaceStyles, /\.project-resource-card > \.project-resource-info \{[^}]*display: grid/);
  // 新建表单卡片（两列栅格左栏）已整体移除，列表不再依赖跨行占位。
  assert.doesNotMatch(workspaceStyles, /\.project-skill-create/);
  // 删除/编辑不能只依赖 hover，否则鼠标离开卡片或触屏设备上不可发现。
  assert.match(workspaceStyles, /\.project-resource-actions \{[^}]*opacity: 1/);
  assert.match(projectResources, /setDeleteTarget\(\{ kind: "skill"/);
  assert.match(projectResources, /setDeleteTarget\(\{ kind: "extension"/);
  assert.match(projectResources, /setDeleteTarget\(\{ kind: "prompt"/);
});

test("resource create forms are removed; lists keep compact density", () => {
  // 新建 Skill/提示词表单已整体移除（模板由 AI 生成，无需手动填写）：
  // 固定标签列、创建按钮文案与两列栅格规则都不应再出现。
  assert.doesNotMatch(projectResources, /grid-cols-\[4rem_minmax\(0,1fr\)\]/);
  assert.doesNotMatch(projectResources, /projectResources\.createSkillAction/);
  assert.doesNotMatch(projectResources, /projectResources\.createPromptAction/);
  assert.doesNotMatch(projectResources, /creatingPrompt \? t\("config\.creatingSkill"\)/);
  assert.match(projectResources, /project-resources-list-section/);
});

test("skills and prompts use compact tab rails aligned with the extensions page", () => {
  // 用户要求技能/提示词页的两个 table（本地/商店）外框与扩展页一致：紧凑、仅包裹 tab 本身
  assert.match(skills, /<TabsList className="w-fit self-start"/);
  assert.match(prompts, /<TabsList className="w-fit self-start"/);
  const tabs = readFileSync("src/renderer/src/components/ui-shadcn/tabs.tsx", "utf8");
  assert.match(tabs, /w-full items-center/);
  assert.match(tabs, /data-\[state=active\]:shadow-sm/);
  assert.match(tabs, /!text-\[color:var\(--color-text-secondary\)\]/);
});

test("skill list filtering depends on resource scope, not the new-skill destination", () => {
  assert.match(skills, /const visibleSkills = data\.skills\.filter\(\(skill\) => props\.scope/);
  assert.doesNotMatch(skills, /data\.skills\.filter\([^;]*newLocationId/);
  assert.doesNotMatch(skills, /const filteredSkills = data\.skills\.filter/);
});

test("skill table uses real aligned columns, not a colSpan card", () => {
  assert.match(skillTableRow, /<TableRow>/);
  assert.match(skillTableRow, /<TableCell className="min-w-0">/);
  // 描述列：w-2/5 固定占比（table-fixed 忽略 min-width，窗口拉小时无宽度列会被
  // 压到接近 0 成竖条）+ 长描述 3 行截断（line-clamp 包在内部 span 上，
  // 避免 display:-webkit-box 破坏 table-cell 布局），title 悬浮看全文
  assert.match(skillTableRow, /<TableCell className="w-2\/5 whitespace-normal break-words/);
  assert.match(skillTableRow, /<span className="block line-clamp-3">/);
  assert.match(skillTableRow, /<TableCell className="text-right">/);
  // 操作按钮直接放在 TableCell 内，不再包一层可点击的卡片 button。
  assert.doesNotMatch(skillTableRow, /<button[\s\S]*skill-rename-inline[\s\S]*<Button/);
  // 新建 Skill 表单已整体移除：位置选择 Select 与旧自定义下拉弹层都不应出现。
  assert.doesNotMatch(skills, /<SelectTrigger/);
  assert.doesNotMatch(skills, /skill-location-picker/);
  assert.doesNotMatch(skills, /config\.createSkill/);
});
