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
 * 用法：
 *   node scripts/sync-release-to-atomgit.mjs --tag v0.7.4
 *   ATOMGIT_TOKEN=xxx node scripts/sync-release-to-atomgit.mjs --tag v0.7.4
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// 解析命令行参数
const args = process.argv.slice(2);
function getArg(flag, defaultValue = '') {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return defaultValue;
}

const targetTag = getArg('--tag', '');
const ghRepo = getArg('--gh-repo', 'ayuayue/PiDeck');
const atomgitRepo = getArg('--atomgit-repo', 'ayuayue/PiDeck');
const atomgitApiBase = getArg('--api-base', 'https://api.atomgit.com/api/v5');
const token = process.env.ATOMGIT_TOKEN || getArg('--token', '');

if (!targetTag) {
  console.error('❌ 错误: 必须指定同步的 Release Tag！例如: --tag v0.7.4');
  process.exit(1);
}

if (!token) {
  console.error('❌ 错误: 缺少 AtomGit Token！请通过环境变量 ATOMGIT_TOKEN 设置，或传入 --token 参数。');
  process.exit(1);
}

// 缓存目录存放下载的 Release 资产
const cacheDir = path.resolve(REPO_ROOT, '.cache', 'release-sync', targetTag);
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

async function main() {
  console.log(`\n========================================`);
  console.log(`🚀 开始同步 Release 到 AtomGit: ${targetTag}`);
  console.log(`GitHub 仓库:  ${ghRepo}`);
  console.log(`AtomGit 仓库: ${atomgitRepo}`);
  console.log(`本地资产缓存: ${cacheDir}`);
  console.log(`========================================\n`);

  // 1. 获取 GitHub Release 详情与资产列表
  console.log(`📥 正在获取 GitHub Release [${targetTag}] 元数据...`);
  let ghRelease;
  try {
    const raw = execFileSync('gh', [
      'release',
      'view',
      targetTag,
      '--repo',
      ghRepo,
      '--json',
      'name,tagName,body,assets'
    ], { encoding: 'utf-8' });
    ghRelease = JSON.parse(raw);
  } catch (err) {
    console.error(`❌ 获取 GitHub Release 失败:`, err.message);
    process.exit(1);
  }

  console.log(`✅ 获取成功: Release 名称="${ghRelease.name || targetTag}", 附件总数=${ghRelease.assets.length}`);

  // 2. 检查或创建 AtomGit Release
  console.log(`\n🔍 检查 AtomGit 上的 Release 状态...`);
  const releaseUrl = `${atomgitApiBase}/repos/${atomgitRepo}/releases/tags/${encodeURIComponent(targetTag)}?access_token=${encodeURIComponent(token)}`;
  const checkRes = await fetch(releaseUrl);
  let atomgitRelease = null;

  if (checkRes.ok) {
    atomgitRelease = await checkRes.json();
    console.log(`ℹ️ AtomGit 上已存在 Release [${targetTag}]，准备增量同步附件。`);

    // 同步更新 body 与 name（如果需要）
    const patchUrl = `${atomgitApiBase}/repos/${atomgitRepo}/releases/${encodeURIComponent(targetTag)}?access_token=${encodeURIComponent(token)}`;
    await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ghRelease.name || targetTag,
        body: ghRelease.body || '',
        release_status: 'latest'
      })
    });
  } else if (checkRes.status === 404) {
    console.log(`✨ AtomGit 上尚无 Release [${targetTag}]，正在创建...`);
    const createUrl = `${atomgitApiBase}/repos/${atomgitRepo}/releases?access_token=${encodeURIComponent(token)}`;
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: targetTag,
        name: ghRelease.name || targetTag,
        body: ghRelease.body || '',
        release_status: 'latest'
      })
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error(`❌ 创建 AtomGit Release 失败: HTTP ${createRes.status}`, errText);
      process.exit(1);
    }
    atomgitRelease = await createRes.json();
    console.log(`✅ 创建 AtomGit Release 成功!`);
  } else {
    const errText = await checkRes.text();
    console.error(`❌ 检查 AtomGit Release 状态异常: HTTP ${checkRes.status}`, errText);
    process.exit(1);
  }

  // 重新获取最新的 AtomGit 附件列表以判断哪些已上传
  const freshRes = await fetch(releaseUrl);
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

    // 检查本地缓存是否存在完整文件
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
      console.log(`⬇️ 正在从 GitHub 下载 ${fileName}...`);
      try {
        // 先清理可能存在的未完成下载临时文件
        if (fs.existsSync(localFilePath)) {
          fs.unlinkSync(localFilePath);
        }
        // 如果环境变量未显式配置代理，但本地存在 7890 端口，可由调用方传入代理环境变量
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
        continue;
      }
    }

    // 获取 AtomGit 预签名上传 URL
    console.log(`🔗 申请 AtomGit 上传凭证...`);
    const uploadUrlEndpoint = `${atomgitApiBase}/repos/${atomgitRepo}/releases/${encodeURIComponent(targetTag)}/upload_url?access_token=${encodeURIComponent(token)}&file_name=${encodeURIComponent(fileName)}`;
    const uploadUrlRes = await fetch(uploadUrlEndpoint);
    if (!uploadUrlRes.ok) {
      const errText = await uploadUrlRes.text();
      console.error(`❌ 获取上传凭据失败 [${fileName}]: HTTP ${uploadUrlRes.status}`, errText);
      continue;
    }

    const uploadInfo = await uploadUrlRes.json();
    if (!uploadInfo.url) {
      console.error(`❌ 返回的上传凭据无效 [${fileName}]:`, uploadInfo);
      continue;
    }

    // PUT 上传二进制文件
    console.log(`⬆️ 正在直传到 AtomGit 对象存储...`);
    try {
      const fileStream = fs.createReadStream(localFilePath);
      const putHeaders = {
        ...(uploadInfo.headers || {}),
        'Content-Length': String(fs.statSync(localFilePath).size)
      };

      const putRes = await fetch(uploadInfo.url, {
        method: 'PUT',
        headers: putHeaders,
        body: fileStream,
        // @ts-ignore Node 18+ duplex stream support
        duplex: 'half'
      });

      if (!putRes.ok) {
        const putErr = await putRes.text();
        console.error(`❌ 上传失败 [${fileName}]: HTTP ${putRes.status}`, putErr);
        continue;
      }

      console.log(`🎉 附件 [${fileName}] 上传成功！`);
      successCount++;
    } catch (err) {
      console.error(`❌ 上传发生异常 [${fileName}]:`, err.message);
    }
  }

  console.log(`\n========================================`);
  console.log(`🏁 同步完成！`);
  console.log(`成功上传: ${successCount} 个附件`);
  console.log(`跳过已有: ${skipCount} 个附件`);
  console.log(`访问地址: https://atomgit.com/${atomgitRepo}/releases/${targetTag}`);
  console.log(`========================================\n`);
}

main().catch(err => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
