import test from 'node:test';
import assert from 'node:assert/strict';

// 被测模块以 ESM import 加载；脚本有 CLI 直跑守卫，import 时不触发网络/进程副作用
const { planLatestCorrection, pickReleaseStatus } = await import('../scripts/sync-release-to-atomgit.mjs');

test('planLatestCorrection: AtomGit latest 落后于 GitHub latest 时计划提升+降级', () => {
  const plan = planLatestCorrection(
    [
      { tag_name: 'v0.7.4', release_status: 'none' },
      { tag_name: 'v0.7.3', release_status: 'latest' },
    ],
    'v0.7.4',
  );
  // 7.4 缺 latest 标记要补上；7.3 错误持有 latest 要降为 none
  assert.deepEqual(plan, [
    { tag: 'v0.7.4', release_status: 'latest' },
    { tag: 'v0.7.3', release_status: 'none' },
  ]);
});

test('planLatestCorrection: 无差异时返回空计划（幂等）', () => {
  const plan = planLatestCorrection(
    [
      { tag_name: 'v0.7.4', release_status: 'latest' },
      { tag_name: 'v0.7.3', release_status: 'none' },
    ],
    'v0.7.4',
  );
  assert.deepEqual(plan, []);
});

test('pickReleaseStatus: 仅 GitHub latest 写 latest 标记，旧 tag 不携带该字段', () => {
  assert.equal(pickReleaseStatus(true), 'latest');
  assert.equal(pickReleaseStatus(false), undefined);
});
