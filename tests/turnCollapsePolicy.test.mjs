import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const turnExecution = readFileSync(
  "src/renderer/src/components/session/turn/useTurnExecution.ts",
  "utf8",
);
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const appUiAtoms = readFileSync(
  "src/renderer/src/atoms/app-ui-atoms.ts",
  "utf8",
);
const settingsStore = readFileSync(
  "src/main/settings/SettingsStore.ts",
  "utf8",
);

test("non-live runs mount collapsed even without a final answer (interrupted rounds)", () => {
  // 只看历史/会话空闲（agentRunning=false）时一律初始折叠：无最终回答的中断轮
  // （stop/steer 打断，中间回答是其唯一输出）不再因设置①（流式展开）而在历史视图整段展开。
  assert.match(
    turnExecution,
    /if \(!opts\.agentRunning\) return false;/,
  );
  // 初始折叠判定不再依赖 hasFinalAnswer（中断轮与完成轮在历史视图行为一致）
  const initializer = turnExecution.slice(
    turnExecution.indexOf("const [stepsVisible, setStepsVisible] = useState"),
    turnExecution.indexOf("});\n\tconst userOverrideRef"),
  );
  assert.doesNotMatch(initializer, /opts\.hasFinalAnswer/);
});

test("interrupted rounds are still folded by the new-turn signal", () => {
  // 新一轮信号路径不受 hasFinalAnswer 门控：中断轮在新一轮开始时同样被强制收起。
  assert.match(
    turnExecution,
    /opts\.isLatestRun === false && \(opts\.newTurnCollapseTick \?\? 0\) > 0/,
  );
  // 流式上升沿展开语义保留（仅设置①开启且非用户 override）
  assert.match(turnExecution, /!wasRunningRef\.current/);
});

test("queued prompt drains bump the new-turn collapse tick", () => {
  // 排队投递（steer「插入当前回合」/ followUp 排队）从 dispatchPromptSnapshot 出口提交，
  // 必须与普通发送一样 bump tick；否则重启后（tick=0）第一次排队发送永远不会
  // 触发「新一轮折叠」，上一轮（尤其被打断、无最终回答的轮）一直保持展开。
  const dispatchStart = app.indexOf("async function dispatchPromptSnapshot");
  assert.ok(dispatchStart > 0, "dispatchPromptSnapshot exists");
  const dispatch = app.slice(dispatchStart);
  const acceptedIndex = dispatch.indexOf("if (!result.accepted)");
  const bumpIndex = dispatch.indexOf("store.set(bumpNewTurnCollapseTickAtom, sessionId)");
  assert.ok(acceptedIndex > 0, "send fails fast on rejected prompt");
  assert.ok(bumpIndex > acceptedIndex, "tick bump happens only after accepted");
});

test("new-turn collapse stays enabled by default in both settings layers", () => {
  // 设置②（collapsePrevRunsOnNewTurn）默认开启，保证新一轮折叠对新会话默认生效。
  assert.match(appUiAtoms, /collapsePrevRunsOnNewTurn: true/);
  assert.match(settingsStore, /collapsePrevRunsOnNewTurn: true/);
});
