# 公告维护指南（announcements-md）

本目录是公告的**唯一编辑入口**：每个公告一个 Markdown 文件，运行脚本编译为仓库根
的 `announcements.json`（客户端实际拉取该文件）。**不要直接手改 announcements.json**，
脚本 `--check` 会校验两者必须一致。

## 发布一条公告

1. 在本目录新建 `<id>.md`，按下方格式填写；
2. 运行 `node scripts/build-announcements.js` 生成 `announcements.json`；
3. 把 `.md` 与 `.json` 一起 commit 并 push 到 `main` 分支；
4. 客户端下次拉取（约 2 小时间隔，或手动点「刷新」）即可看到。

下线公告 = 删除对应 `.md` 文件再重新生成（或等 `effectiveUntil` 自然过期，双保险）。

## md 文件格式

```md
---
id: 2026-09-07-announcements-live   # 必填：稳定唯一 id（发布后不可变更，渲染层已读去重 key）
title: 公告功能上线                  # 必填：标题（单行短文案）
level: info                         # 必填：info | warn | critical
publishedAt: 2026-09-07T00:00:00+08:00   # 必填：ISO 8601 发布时间（新公告在前展示）
effectiveUntil: 2026-10-07T00:00:00+08:00 # 必填：过期时间，到期自动不再展示
minVersion: 0.7.4-beta              # 可选：仅向低于该版本的客户端展示（引导升级）
---
正文（Markdown，客户端「查看详情」按 sanitize 渲染；首尾空行自动剔除）
```

## 校验规则（不满足则脚本报错、拒绝生成）

- 必填字段缺失或为空；`level` 必须是三档之一；日期必须是合法 ISO 8601；
- `id` 不允许含空白字符；全目录 `id` 唯一；
- 正文不能为空；`minVersion` 给了空值同样报错。

## 命令行

| 命令 | 作用 |
|------|------|
| `node scripts/build-announcements.js` | 校验并生成 `announcements.json`（2 空格缩进 + 尾换行，格式保持稳定） |
| `node scripts/build-announcements.js --check` | 只校验：断言 json 与 md 逐字节一致（CI 用） |
| `npm run build:announcements` / `npm run check:announcements` | 同上（package.json 快捷命令） |