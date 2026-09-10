#!/usr/bin/env node

/**
 * scripts/sync-release-to-atomgit.mjs
 *
 * 将 GitHub 的 Release（含更新日志正文和所有附件安装包）自动同步到 AtomGit 平台。
 *
 * 凭证安全约定：
 * 1. 绝不硬编码 Token，统一从环境变量 ATOMGIT_TOKEN 获取，或通过命令行参数 --token 传入；
 * 2. 避免将带有敏感 Token 的文件提交至代码仓库；
 * 3. 支持断点续传/跳过已上传附件，避免重复上传上百 MB 的安装包。
 *
 * latest 标记约定（v0.7.4 抢占事故修复）：
 * 旧版脚本在创建/更新 release 时硬编码 release_status:'latest'，导致「谁后同步谁就是
 * 最新版」——先同步 v0.7.4 再同步 v0.7.3 后，AtomGit 上 latest 指向 v0.7.3，更新 feed
 * （releases/download/latest）会给所有用户发旧版本。现在以 GitHub 官方 latest
 * （/releases/latest）为唯一事实来源，同步完成后统一校正 AtomGit 的 latest 标记。
 *
 * 上传超时约定（workflow 卡死修复）：
 * 旧版 PUT 上传无超时，对象存储连接挂起会让 GitHub Actions job 永久卡住
 * （52 分钟无进展）。所有 fetch 调用均有超时；PUT 失败自动重试一次并计入失败清单，
 * 脚本以非 0 退出码结束，让 workflow 明确标红。
 *
 * 用法：
 *   node scripts/sync-release-to-atomgit.mjs --tag v0.7.4
 *   ATOMGIT_TOKEN=xxx node scripts/sync-release-to-atomgit.mjs --tag v0.7.2,v0.7.3,v0.7.4
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// API 调用超时：AtomGit API 偶发挂起，60s 足够（均为轻量 JSON 请求）
const API_TIMEOUT_MS = 60_000;
// 单文件直传对象存储的超时：与 gh release download 的 600s 对齐，
// 覆盖 ~165MB 安装包在慢速链路下的上传时间，同时兜底连接挂死场景
const UPLOAD_TIMEOUT_MS = 600_000;

// 解析命令行参数
const args = process.argv.slice(2);
function getArg(flag, defaultValue = '') {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return defaultValue;
}

const targetTags = (getArg('--tags', '') || getArg('--tag', ''))
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);
const ghRepo = getArg('--gh-repo', 'ayuayue/PiDeck');
const atomgitRepo = getArg('--atomgit-repo', 'ayuayue/PiDeck');
const atomgitApiBase = getArg('--api-base', 'https://api.atomgit.com/api/v5');
const token = process.env.ATOMGIT_TOKEN || getArg('--token', '');

/** 带超时的 fetch 包装：所有网络请求必须经过这里，防止挂起拖死 CI job。 */
function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * latest 校正计划（纯函数，可单测）：
 * AtomGit 只允许一个 release 持有 release_status='latest'（更新 feed 以此为准）。
 * 以 GitHub latest tag 为准，其余 release 应为无标记（脚本侧用 'none' 提交；
 * AtomGit 若拒绝 'none' 值则由调用方降级为跳过并警告——通常平台会在新 latest
 * 写入时自动降级旧标记，此 PATCH 只是兜底）。
 */
export function planLatestCorrection(AtomgitReleases, githubLatestTag) {
  const plan = [];
  for (const rel of AtomgitReleases || []) {
    if (rel.tag_name === githubLatestTag) {
      if (rel.release_status !== 'latest') {
        plan.push({ tag: rel.tag_name, release_status: 'latest' });
      }
    } else if (rel.release_status === 'latest') {
      plan.push({ tag: rel.tag_name, release_status: 'none' });
    }
  }
  return plan;
}

/**
 * 本次目标 tag 的 release_status（纯函数，可单测）：
 * 仅当目标 tag 就是 GitHub 官方 latest 时才写 'latest'；否则不传该字段
 * （undefined → 调用方省略），避免同步旧版本时抢占最新标记。
 */
export function pickReleaseStatus(isTargetLatest) {
  return isTargetLatest ? 'latest' : undefined;
}

// 仅 CLI 直跑时执行主流程；被测试 import 时不触发副作用（进程退出/目录创建/网络请求）
const isCliMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

async function main() {
  if (targetTags.length === 0) {
    console.error('❌ 错误: 必须指定同步的 Release Tag！例如: --tag v0.7.4 或 --tag v0.7.2,v0.7.3,v0.7.4');
    process.exit(1);
  }

  if (!token) {
    console.error('❌ 错误: 缺少 AtomGit Token！请通过环境变量 ATOMGIT_TOKEN 设置，或传入 --token 参数。');
    process.exit(1);
  }

  // 0. 以 GitHub 官方 latest 为唯一事实来源，供后续 release_status 决策与收尾校正
  console.log(`\n📌 查询 GitHub 官方 latest Release...`);
  const githubLatestTag = execFileSync('gh', [
    'api',
    `repos/${ghRepo}/releases/latest`,
    '--jq',
    '.tag_name',
  ], { encoding: 'utf-8' }).trim();
  console.log(`✅ GitHub latest: ${githubLatestTag}`);

  const failedAssets = [];

  for (const targetTag of targetTags) {
    try {
      await syncOneRelease(targetTag, githubLatestTag, failedAssets);
    } catch (err) {
      // 单个 tag 失败不中断后续 tag（多 tag 批量同步时尽量推进），最终统一以退出码暴露
      console.error(`❌ 同步 [${targetTag}] 失败:`, err.message);
      failedAssets.push({ tag: targetTag, name: '(release level)', error: err.message });
    }
  }

  if (failedAssets.length > 0) {
    console.error(`\n🚨 以下条目未成功，请重跑（已上传附件会自动跳过）:`);
    for (const f of failedAssets) {
      console.error(`   - [${f.tag}] ${f.name}: ${f.error}`);
    }
    process.exit(1);
  }

  console.log(`\n✅ 全部同步完成。`);
}

/** 同步单个 tag 的 release：元数据 → 附件增量上传 → 校正 latest 标记。 */
async function syncOneRelease(targetTag, githubLatestTag, failedAssets) {
  const isTargetLatest = targetTag === githubLatestTag;
  console.log(`\n========================================`);
  console.log(`🚀 同步 Release: ${targetTag} (GitHub latest=${githubLatestTag}${isTargetLatest ? '，本 tag 为最新' : ''})`);
  console.log(`GitHub 仓库:  ${ghRepo}`);
  console.log(`AtomGit 仓库: ${atomgitRepo}`);
  console.log(`========================================\n`);

  // 1. 获取 GitHub Release 详情与资产列表
  console.log(`📥 获取 GitHub Release [${targetTag}] 元数据...`);
  const raw = execFileSync('gh', [
    'release',
    'view',
    targetTag,
    '--repo',
    ghRepo,
    '--json',
    'name,tagName,body,assets'
  ], { encoding: 'utf-8' });
  const ghRelease = JSON.parse(raw);

  console.log(`✅ Release 名称="${ghRelease.name || targetTag}", 附件总数=${ghRelease.assets.length}`);

  // 2. 检查或创建 AtomGit Release
  const releaseUrl = `${atomgitApiBase}/repos/${atomgitRepo}/releases/tags/${encodeURIComponent(targetTag)}?access_token=${encodeURIComponent(token)}`;
  let atomgitRelease = null;

  const checkRes = await fetchWithTimeout(releaseUrl);
  if (checkRes.ok) {
    atomgitRelease = await checkRes.json();
    console.log(`ℹ️ AtomGit 上已存在 Release [${targetTag}]，增量同步附件。`);
    // 只更新 name/body；release_status 不在此处触碰——避免同步旧 tag 时抢占 latest
    const patchBody = {
      name: ghRelease.name || targetTag,
      body: ghRelease.body || '',
    };
    if (isTargetLatest) patchBody.release_status = 'latest';
    const patchUrl = `${atomgitApiBase}/repos/${atomgitRepo}/releases/${encodeURIComponent(targetTag)}?access_token=${encodeURIComponent(token)}`;
    const patchRes = await fetchWithTimeout(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patchBody),
    });
    if (!patchRes.ok) {
      const errText = await patchRes.text().catch(() => '');
      // PATCH 失败不阻塞附件上传，但要留痕（latest 校正步骤会再兜底一次）
      console.error(`⚠️ 更新 Release 元数据失败: HTTP ${patchRes.status} ${errText}`);
    }
  } else if (checkRes.status === 404) {
    console.log(`✨ AtomGit 上尚无 Release [${targetTag}]，创建中...`);
    const createBody = {
      tag_name: targetTag,
      name: ghRelease.name || targetTag,
      body: ghRelease.body || '',
    };
    const status = pickReleaseStatus(isTargetLatest);
    if (status) createBody.release_status = status;
    const createUrl = `${atomgitApiBase}/repos/${atomgitRepo}/releases?access_token=${encodeURIComponent(token)}`;
    const createRes = await fetchWithTimeout(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`创建 AtomGit Release 失败: HTTP ${createRes.status} ${errText}`);
    }
    atomgitRelease = await createRes.json();
    console.log(`✅ 创建 AtomGit Release 成功!`);
  } else {
    const errText = await checkRes.text();
    throw new Error(`检查 AtomGit Release 状态异常: HTTP ${checkRes.status} ${errText}`);
  }

  // 重新获取最新的 AtomGit 附件列表以判断哪些已上传（断点续传：按附件名去重）
  const freshRes = await fetchWithTimeout(releaseUrl);
  const currentRelease = await freshRes.json();
  const existingAttachNames = new Set(
    (currentRelease.assets || [])
      .filter(a => a.type === 'attach')
      .map(a => a.name)
  );

  console.log(`📦 当前 AtomGit 已有附件数: ${existingAttachNames.size}`);

  // 3. 逐个下载并上传资产
  const assetsToSync = ghRelease.assets;
  let successCount = 0;
  let skipCount = 0;

  for (let i = 0; i < assetsToSync.length; i++) {
    const asset = assetsToSync[i];
    const fileName = asset.name;
    const fileSizeMb = (asset.size / (1024 * 1024)).toFixed(2);
    console.log(`\n[${i + 1}/${assetsToSync.length}] 处理: ${fileName} (${fileSizeMb} MB)`);

    if (existingAttachNames.has(fileName)) {
      console.log(`⏩ 附件 [${fileName}] 在 AtomGit 已存在，跳过。`);
      skipCount++;
      continue;
    }

    const cacheDir = path.resolve(REPO_ROOT, '.cache', 'release-sync', targetTag);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    const localFilePath = path.join(cacheDir, fileName);
    let needDownload = true;
    if (fs.existsSync(localFilePath)) {
      const stat = fs.statSync(localFilePath);
      if (stat.size === asset.size) {
        console.log(`💾 使用本地缓存文件: ${localFilePath}`);
        needDownload = false;
      }
    }

    if (needDownload) {
      console.log(`⬇️ 从 GitHub 下载 ${fileName}...`);
      try {
        // 清理可能存在的未完成下载临时文件，避免把损坏文件传上去
        if (fs.existsSync(localFilePath)) {
          fs.unlinkSync(localFilePath);
        }
        // 本地调试可用代理；CI 环境未设置代理变量时不生效
        const proxyEnv = { ...process.env };
        if (process.env.USE_LOCAL_PROXY === 'true' || process.env.HTTP_PROXY) {
          proxyEnv.HTTP_PROXY = process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
          proxyEnv.HTTPS_PROXY = process.env.HTTPS_PROXY || 'http://127.0.0.1:7890';
          proxyEnv.http_proxy = process.env.http_proxy || 'http://127.0.0.1:7890';
          proxyEnv.https_proxy = process.env.https_proxy || 'http://127.0.0.1:7890';
        }

        execFileSync('gh', [
          'release',
          'download',
          targetTag,
          '--repo',
          ghRepo,
          '--pattern',
          fileName,
          '--dir',
          cacheDir,
          '--clobber'
        ], { stdio: 'inherit', env: proxyEnv, timeout: 600000 }); // 单个文件下载上限 10 分钟
      } catch (err) {
        console.error(`❌ 下载附件 ${fileName} 失败:`, err.message);
        if (fs.existsSync(localFilePath)) {
          try { fs.unlinkSync(localFilePath); } catch {}
        }
        failedAssets.push({ tag: targetTag, name: fileName, error: `download: ${err.message}` });
        continue;
      }
    }

    // 上传（含一次自动重试：presigned URL 可能过期或连接中断，重跑成本高）
    let uploaded = false;
    let lastUploadError = '';
    for (let attempt = 1; attempt <= 2 && !uploaded; attempt++) {
      if (attempt > 1) console.log(`🔁 第 ${attempt} 次尝试上传 [${fileName}]...`);
      try {
        lastUploadError = await uploadOneAsset(targetTag, fileName, localFilePath);
        uploaded = !lastUploadError;
      } catch (err) {
        lastUploadError = err.message;
      }
    }

    if (uploaded) {
      console.log(`🎉 附件 [${fileName}] 上传成功！`);
      successCount++;
    } else {
      console.error(`❌ 上传失败 [${fileName}]: ${lastUploadError}`);
      failedAssets.push({ tag: targetTag, name: fileName, error: lastUploadError });
    }
  }

  console.log(`\n========================================`);
  console.log(`🏁 [${targetTag}] 同步结束！`);
  console.log(`成功上传: ${successCount} 个附件 | 跳过已有: ${skipCount} 个附件`);
  console.log(`========================================`);

  // 4. 收尾：本 tag 是 GitHub latest 时，确保 AtomGit 的 latest 标记最终落在它身上
  if (isTargetLatest) {
    await correctLatestFlag(targetTag);
  }
}

/** 单附件上传：申请 presigned URL → PUT 直传对象存储。返回空串表示成功，否则为错误信息。 */
async function uploadOneAsset(targetTag, fileName, localFilePath) {
  // 获取 AtomGit 预签名上传 URL
  const uploadUrlEndpoint = `${atomgitApiBase}/repos/${atomgitRepo}/releases/${encodeURIComponent(targetTag)}/upload_url?access_token=${encodeURIComponent(token)}&file_name=${encodeURIComponent(fileName)}`;
  const uploadUrlRes = await fetchWithTimeout(uploadUrlEndpoint);
  if (!uploadUrlRes.ok) {
    const errText = await uploadUrlRes.text().catch(() => '');
    return `获取上传凭据失败: HTTP ${uploadUrlRes.status} ${errText}`;
  }

  const uploadInfo = await uploadUrlRes.json();
  if (!uploadInfo.url) {
    return `返回的上传凭据无效: ${JSON.stringify(uploadInfo).slice(0, 200)}`;
  }

  // PUT 直传到 AtomGit 对象存储；必须带超时——否则连接挂起会永久卡死 CI job
  const fileStream = fs.createReadStream(localFilePath);
  const putHeaders = {
    ...(uploadInfo.headers || {}),
    'Content-Length': String(fs.statSync(localFilePath).size),
  };
  const putRes = await fetchWithTimeout(
    uploadInfo.url,
    { method: 'PUT', headers: putHeaders, body: fileStream, duplex: 'half' },
    UPLOAD_TIMEOUT_MS,
  );
  if (putRes.status === 409) {
    // 409 = 附件已存在（AtomGit 对象存储幂等语义）：视为成功，与「按名去重」断点续传逻辑一致
    return '';
  }
  if (!putRes.ok) {
    const putErr = await putRes.text().catch(() => '');
    return `PUT 失败: HTTP ${putRes.status} ${putErr.slice(0, 200)}`;
  }
  return '';
}

/**
 * latest 标记校正（仅 GitHub latest tag 同步后调用）：
 * 先读 AtomGit 全部 release，按 GitHub latest 事实纠正差异；
 * 平台若拒绝 'none' 状态值则只警告不阻塞（通常写新 latest 时旧标记会自动降级）。
 */
async function correctLatestFlag(githubLatestTag) {
  try {
    const listUrl = `${atomgitApiBase}/repos/${atomgitRepo}/releases?access_token=${encodeURIComponent(token)}&per_page=50`;
    const listRes = await fetchWithTimeout(listUrl);
    if (!listRes.ok) {
      console.error(`⚠️ 无法读取 AtomGit release 列表（HTTP ${listRes.status}），跳过 latest 校正。`);
      return;
    }
    const releases = await listRes.json();
    const plan = planLatestCorrection(releases, githubLatestTag);
    if (plan.length === 0) {
      console.log(`✅ latest 标记已是最新: ${githubLatestTag}`);
      return;
    }
    for (const item of plan) {
      const patchUrl = `${atomgitApiBase}/repos/${atomgitRepo}/releases/${encodeURIComponent(item.tag)}?access_token=${encodeURIComponent(token)}`;
      const rel = (releases || []).find((r) => r.tag_name === item.tag);
      const patchRes = await fetchWithTimeout(patchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // PATCH 接口要求 name/body 必填：带上现有值，仅改 release_status
        body: JSON.stringify({ name: rel?.name ?? item.tag, body: rel?.body ?? '', release_status: item.release_status }),
      });
      if (patchRes.ok) {
        console.log(`✅ latest 校正: [${item.tag}] → release_status=${item.release_status}`);
      } else {
        const errText = await patchRes.text().catch(() => '');
        console.error(`⚠️ latest 校正 [${item.tag}] → ${item.release_status} 失败: HTTP ${patchRes.status} ${errText}（可在 AtomGit 网页端手动调整）`);
      }
    }
    const feedCheck = await fetchWithTimeout(`${atomgitApiBase}/repos/${atomgitRepo}/releases/latest?access_token=${encodeURIComponent(token)}`);
    if (feedCheck.ok) {
      const latestRelease = await feedCheck.json();
      console.log(`🔎 当前 AtomGit latest release: ${latestRelease.tag_name ?? latestRelease.name ?? '?'}`);
    }
  } catch (err) {
    console.error(`⚠️ latest 校正异常（不阻塞主流程）:`, err.message);
  }
}

if (isCliMain) {
  main().catch(err => {
    console.error('Fatal Error:', err);
    process.exit(1);
  });
}
