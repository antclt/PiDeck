# 会话分组（PiDeck 内置宿主插件）

把**当前项目**的会话手动整理成分组：有关联的会话放到一起，点一下直接跳过去。

上游：[Lamb-Yang/pideck-plugin](https://github.com/Lamb-Yang/pideck-plugin) 的 `session-groups/`（本目录是它的随包内置副本）。

## 功能

- 单栏折叠列表：分组 + 「未分组」区，展开/收起状态自动记住
- 快速搜索：面板顶部搜索框按标题实时过滤（保留分组结构，命中组自动展开、无命中组隐藏），点 × 或 Esc 清空；切项目自动清空
- 新建 / 重命名 / 删除分组（删除前有确认，组内会话回到未分组）
- 「添加会话」弹层：搜索标题 + 勾选，**一个会话只属于一个组**，勾到新组自动从原组移出
- 拖动归组：整条会话可拖，落到任意分组卡片（含未分组区）即归组
- 每条会话带 ⓘ 详情按钮：弹层展示完整字段（所属分组/模型/创建时间/更新时间/状态/会话 ID）
- 活跃标记：`updatedAt` ≤ 10 分钟的会话显示绿点（事件驱动 + 每分钟静默重绘），当前会话另有「当前」标签
- 会话被删除/归档后自动清理失效引用，改名后标题自动同步（监听 `sessions.changed`）
- 切换项目自动重载该项目的分组；文案跟随界面语言（中/英）

## 权限

```json
"permissions": ["sessions.read", "workbench.navigate"]
```

- `sessions.read`：只读当前项目的会话目录与元信息（不读历史正文）。
- `workbench.navigate`：点击会话让 PiDeck 切过去。
- 没有网络权限，不联网、不上传会话、不写密钥。分组关系存在插件私有 `storage`（每插件 1 MiB，键 `grp.<projectId>`，按项目隔离），只存「组名 + 会话 id 引用」。

## 面板形态

`"presentation": "page"`：工作区内联页，非模态，侧栏 `layers` 图标入口再点即关。它是 `page` 形态的第一个内置示例（另一个内置插件 `billion-context` 用的是 `popover`）。

## 内置落位语义

- 随包分发在 `resources/host-plugins/session-groups/`（`extraResources` → `<resources>/host-plugins`），由 `HostPluginManager.seedBuiltin()` 在 `load()` 前落位到 `userData/host-plugins/session-groups/`。
- **落位 ≠ 授权**：首次落位同样是 `requiresConsent`，要在 设置 → PiDeck 插件 里按整包指纹授权并启用；侧栏只列已启用插件的面板。
- 升级：磁盘副本仍等于上次落位指纹（没人手改）时随新版 PiDeck 替换，且授权顺延；手改过的副本永不被覆盖（那时以你的副本为准，内置内容不再生效）。
- 内置插件不允许卸载（`plugin-builtin`，下次启动会被重新落位），要停用请用禁用。

## 改这个插件

- 只在本目录改：`app.js` / `styles.css` / `app.html`，然后 设置 → PiDeck 插件 → 重新扫描 → 授权并启用（授权绑定整包文件指纹，内容一变就要重新批准）。
- 想同步上游：以上游仓库的 `session-groups/` 为数据源，复制这 4 个文件（`pideck-plugin.json` / `app.html` / `app.js` / `styles.css`），**不要**整个仓库覆盖过来（上游还带别的插件与主题文件）。manifest `version` 跟着上游走。
- 想调样式可在普通浏览器里把 `app.html` 的 `<script>` 换成假的 `window.pideck`（见 `docs/host-plugin-dev-guide.md`）。
- 约束：只用 `window.pideck`（context / sessions / storage / workbench / onEvent），不用 `innerHTML` 渲染动态文本，不联网。

API 参考见 PiDeck 仓库的 `docs/host-plugin-dev-guide.md`。
