/**
 * Git 面板非 git 仓库轮询暂停契约测试。
 *
 * 背景：git 侧栏每 5 秒静默轮询 status + 每 5 分钟 fetch 远程。当项目目录不是
 * git 仓库（或未安装 git）时，轮询每次都会 spawn git 报错，控制台刷屏且浪费
 * 进程开销。修复：非仓库标记置位后暂停两个定时器；仓库状态恢复（git init /
 * 安装 git）后由 refresh 成功路径清标记自动恢复轮询。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");

test("非 git 仓库 / 未安装 git 时暂停 5 秒状态轮询", () => {
  // 静默轮询 interval 回调以 notAGitRepo || gitNotInstalled 短路退出
  const intervalBlock = source.slice(
    source.indexOf("每 5 秒拉取一次最新工作区状态"),
    source.indexOf("refreshAheadBehind", source.indexOf("每 5 秒拉取一次最新工作区状态")),
  );
  assert.match(intervalBlock, /if \(notAGitRepo \|\| gitNotInstalled\) return;/);
  // interval 依赖包含刷新回调和两个标记：项目/仓库作用域变化时重建，错误恢复后自动重启
  assert.match(intervalBlock, /\[layout, refresh, notAGitRepo, gitNotInstalled\]/);
});

test("非 git 仓库 / 未安装 git 时暂停 5 分钟 fetch 远程轮询", () => {
  const fetchBlock = source.slice(
    source.indexOf("每 5 分钟刷新一次 ahead/behind 角标"),
    source.indexOf("toggleResource"),
  );
  assert.match(fetchBlock, /if \(notAGitRepo \|\| gitNotInstalled\) return;/);
  assert.match(
    fetchBlock,
    /\[layout, refreshAheadBehind, notAGitRepo, gitNotInstalled\]/,
  );
  // 首次挂载不得立刻 fetch：必须等 refresh 成功确认仓库，否则非 git 项目一打开就 git fetch 报 128
  assert.doesNotMatch(fetchBlock, /void refreshAheadBehind\(\);\s*const timer/);
});

test("外层 render 重新包装 Git API 时不触发额外 status 刷新", () => {
  const refreshBlock = source.slice(
    source.indexOf("const refresh = useCallback"),
    source.indexOf("// 打开 Git drawer 时首次加载"),
  );
  // getStatus 通过 ref 读取，refresh 的身份只随项目/仓库作用域变化。
  assert.match(refreshBlock, /getStatusRef\.current\(projectId\)/);
  assert.match(refreshBlock, /\[props\.projectId, repoScopeKey, refreshAheadBehind\]/);
  assert.doesNotMatch(refreshBlock, /props\.getStatus\(projectId\)/);
});

test("远程角标计时器不依赖每次 render 新建的 fetch 包装器", () => {
  const fetchBlock = source.slice(
    source.indexOf("每 5 分钟刷新一次 ahead/behind 角标"),
    source.indexOf("toggleResource"),
  );
  assert.match(fetchBlock, /fetchRef\.current/);
  assert.match(fetchBlock, /\[layout, refreshAheadBehind, notAGitRepo, gitNotInstalled\]/);
  assert.doesNotMatch(fetchBlock, /props\.fetch, props\.aheadBehind/);
});

test("仅非 silent 的 refresh 成功路径才会 fetch 远程", () => {
  const successBlock = source.slice(source.indexOf("setGroups(next);"));
  const afterGroups = successBlock.slice(0, successBlock.indexOf("} catch (caught)"));
  assert.match(afterGroups, /if \(!silent\) void refreshAheadBehind\(\);/);
});

test("refresh 成功路径清除仓库/工具标记（git init 或安装 git 后自动恢复轮询）", () => {
  // setGroups(next) 之后紧接着清除两个标记
  const successBlock = source.slice(source.indexOf("setGroups(next);"));
  const afterGroups = successBlock.slice(0, successBlock.indexOf("} catch (caught)"));
  assert.match(afterGroups, /setNotAGitRepo\(false\);/);
  assert.match(afterGroups, /setGitNotInstalled\(false\);/);
});

test("静默失败同样置位非仓库/未安装标记（置位逻辑不在 !silent 分支内）", () => {
  // catch 块中置位先于 !silent UI 清理分支执行
  const catchBlock = source.slice(
    source.indexOf("} catch (caught) {"),
    source.indexOf("} finally {"),
  );
  const silentGuard = catchBlock.indexOf("if (!silent) {");
  assert.ok(silentGuard >= 0, "应存在 !silent 分支");
  // 置位语句必须出现在 !silent 之前——silent 轮询失败也要能停住轮询
  const beforeSilent = catchBlock.slice(0, silentGuard);
  assert.match(beforeSilent, /setNotAGitRepo\(true\);/);
  assert.match(beforeSilent, /setGitNotInstalled\(true\);/);
});

test("手动刷新按钮保留（用户 git init 后可立即手动恢复）", () => {
  // 手动刷新入口仍在（非 silent 刷新）
  assert.match(source, /void refresh\(\);/);
});
