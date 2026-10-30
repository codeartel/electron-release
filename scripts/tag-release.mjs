#!/usr/bin/env node
/**
 * 一键发布：按 package.json 版本打 tag，并驱动四个平台的打包工作流。
 *
 * 打包工作流跑在 electron-release 镜像仓（只有推那边的 tag 才会触发 CI），所以脚本会定位到镜像仓执行：
 *   - 在 electron 源仓运行：自动使用兄弟目录 ../electron-release（可用 --repo-dir=<路径> 指定）
 *   - 在 electron-release 运行：直接作用于本仓
 *
 * 用法：
 *   node scripts/tag-release.mjs                     # 用 package.json 版本打 v<version> 并推送
 *   node scripts/tag-release.mjs --tag=v0.13.6-rc.1  # 指定 tag 名
 *   node scripts/tag-release.mjs --dispatch-only     # 不打 tag，只让已存在的 tag 重跑四个工作流
 *   node scripts/tag-release.mjs --no-push           # 只在本地建 tag，不推送
 *   node scripts/tag-release.mjs --dry-run           # 预演：只打印将要执行的动作
 *
 * 触发口径：
 *   - 新建并推送 tag → 由工作流的 push: tags 自动触发，脚本不会再 dispatch（避免双跑）
 *   - tag 已存在  → push 不会再次触发工作流，脚本改用 REST API 显式 dispatch
 *   - dispatch 需要 GH_TOKEN / GITHUB_TOKEN 环境变量（需该仓 repo 权限）
 *
 * 退出码：0 表示 tag 已推送且工作流已触发（或已由 push 触发）；1 表示有失败项。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(`--${name}`);
const readOpt = (name) => {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
};

const dryRun = hasFlag('dry-run');
const allowDirty = hasFlag('allow-dirty');
const allowUnpushed = hasFlag('allow-unpushed');
const noPush = hasFlag('no-push');
const dispatchOnly = hasFlag('dispatch-only');
const forceDispatch = hasFlag('dispatch');
const noDispatch = hasFlag('no-dispatch');

function log(message) {
  console.log(`[tag-release] ${message}`);
}

function fail(message) {
  console.error(`[tag-release] 错误：${message}`);
  process.exit(1);
}

// ---------- 定位实际执行打包的仓库 ----------
const isSourceRepo = fs.existsSync(path.join(sourceDir, 'src'));
const repoDir = isSourceRepo
  ? path.resolve(readOpt('repo-dir') ?? path.join(sourceDir, '..', 'electron-release'))
  : sourceDir;
if (!fs.existsSync(path.join(repoDir, '.git'))) {
  fail(
    `目标目录不是 git 仓库：${repoDir}` +
      (isSourceRepo ? '（electron-release 未放在同级目录时用 --repo-dir=<路径> 指定）' : ''),
  );
}

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (allowFail) {
      return null;
    }
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    fail(`git ${args.join(' ')} 执行失败${stderr ? `：${stderr}` : ''}`);
  }
  return null;
}

// ---------- 打包工作流清单（按 build-*.yml 扫描，新增平台自动纳入） ----------
const workflowDir = path.join(repoDir, '.github', 'workflows');
const workflows = fs.existsSync(workflowDir)
  ? fs
      .readdirSync(workflowDir)
      .filter((file) => /^build-.*\.ya?ml$/.test(file))
      .sort()
      .map((file) => {
        const text = fs.readFileSync(path.join(workflowDir, file), 'utf8');
        const name = /^name:[ \t]*(.+)$/m.exec(text)?.[1].trim() ?? file;
        return { file, name };
      })
  : [];
if (workflows.length === 0) {
  fail(`没有找到打包工作流（${workflowDir}/build-*.yml），确认目标是 electron-release 镜像仓`);
}

// ---------- 版本与 tag ----------
let version;
try {
  version = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')).version;
} catch (error) {
  fail(`读取 ${path.join(repoDir, 'package.json')} 失败：${error.message}`);
}
if (!version) {
  fail('package.json 缺少 version 字段');
}
const tagName = readOpt('tag') ?? `v${version}`;
if (!/^[A-Za-z0-9._\/-]+$/.test(tagName)) {
  fail(`tag 名称包含不支持的字符：${tagName}`);
}
if (!/^v?\d+\.\d+\.\d+/.test(tagName)) {
  log(`警告：tag ${tagName} 不像版本号，确认是有意为之`);
}

// ---------- origin 与仓库描述 ----------
const originUrl = git(['remote', 'get-url', 'origin'], { allowFail: true });
if (!originUrl) {
  fail('origin 未配置，无法推送 tag 或调用工作流 API');
}
const slugMatch = /github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(originUrl);
if (!slugMatch) {
  fail(`无法从 origin 解析 GitHub 仓库：${originUrl}`);
}
const slug = `${slugMatch[1]}/${slugMatch[2]}`;

function ensureCommitReady() {
  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    if (!allowDirty) {
      fail(
        '工作区有未提交改动，tag 只会指向已提交内容，请先提交并推送（或加 --allow-dirty 忽略）：\n' +
          dirty.split('\n').slice(0, 5).join('\n'),
      );
    }
    log('警告：工作区有未提交改动，远端构建不会包含这些改动');
  }
  const head = git(['rev-parse', 'HEAD']);
  const upstream = git(['rev-parse', '@{upstream}'], { allowFail: true });
  if (!upstream) {
    if (!allowUnpushed) {
      fail('当前分支没有上游分支，无法确认 tag 指向的提交已推送（先 git push -u，或加 --allow-unpushed）');
    }
    log('警告：当前分支没有上游分支，无法确认提交已推送');
  } else if (head !== upstream) {
    if (!allowUnpushed) {
      fail(
        `本地 HEAD 与上游不一致（${head.slice(0, 7)} ≠ ${upstream.slice(0, 7)}），` +
          '远端构建可能不含最新提交，请先 push（或加 --allow-unpushed）',
      );
    }
    log('警告：本地 HEAD 与上游不一致，远端构建可能不含最新提交');
  }
  return head;
}

/** 远端该 tag 指向的提交（annotated tag 优先取 ^{} 解引用结果） */
function remoteTagCommit(tag) {
  const out = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { allowFail: true });
  if (!out) {
    return null;
  }
  const lines = out.split('\n').filter(Boolean);
  const deref = lines.find((line) => line.endsWith(`${tag}^{}`));
  const picked = deref ?? lines[0];
  return picked?.split('\t')[0] ?? null;
}

async function dispatchWorkflows() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    fail('dispatch 需要 GH_TOKEN 或 GITHUB_TOKEN 环境变量（需该仓 Actions 写权限）');
  }
  let failed = 0;
  for (const workflow of workflows) {
    if (dryRun) {
      log(`[预演] 将触发：${workflow.name}（${workflow.file}）ref=${tagName}`);
      continue;
    }
    const url = `https://api.github.com/repos/${slug}/actions/workflows/${encodeURIComponent(workflow.file)}/dispatches`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'slinote-tag-release',
      },
      body: JSON.stringify({ ref: tagName, inputs: { tag: tagName } }),
    });
    if (response.status === 204) {
      log(`已触发：${workflow.name}（${workflow.file}）`);
    } else {
      failed += 1;
      const body = await response.text();
      console.error(
        `[tag-release] 触发失败：${workflow.name}（${workflow.file}）HTTP ${response.status} ${body.slice(0, 300)}`,
      );
    }
  }
  return failed;
}

function printSummary(mode) {
  const names = workflows.map((w) => w.name).join('、');
  const messages = {
    push: dryRun
      ? `[预演] 推送 tag 后将由 push 事件触发 ${workflows.length} 个工作流：${names}`
      : `已由 push tag 触发 ${workflows.length} 个工作流：${names}`,
    dispatch: dryRun
      ? `[预演] 将通过 API 触发 ${workflows.length} 个工作流（ref=${tagName}）：${names}`
      : `已通过 API 触发 ${workflows.length} 个工作流（ref=${tagName}）：${names}`,
    none: `未触发工作流，需要时在 Actions 页面手动 Run workflow：${names}`,
  };
  log(`版本：${version}`);
  log(`目标仓库：${repoDir}${isSourceRepo ? '（源仓 → 已切到 electron-release 镜像仓）' : ''}`);
  log(`仓库：${slug}`);
  log(`tag：${tagName}`);
  log(messages[mode]);
  log(`Actions：https://github.com/${slug}/actions`);
  log(`Release（草稿，全部跑完后手动点 Publish）：https://github.com/${slug}/releases`);
}

// ---------- 主流程 ----------
if (dispatchOnly) {
  const remoteCommit = remoteTagCommit(tagName);
  if (!remoteCommit) {
    fail(`远端不存在 tag ${tagName}，--dispatch-only 只能用于已推送的 tag`);
  }
  log(`tag ${tagName} 已存在（${remoteCommit.slice(0, 7)}），跳过建 tag`);
  const failed = await dispatchWorkflows();
  printSummary('dispatch');
  process.exit(failed > 0 ? 1 : 0);
}

const head = ensureCommitReady();
const remoteCommit = remoteTagCommit(tagName);
const localCommit = git(['rev-parse', `refs/tags/${tagName}`], { allowFail: true });
let pushedNow = false;

if (remoteCommit) {
  log(`远端已存在 tag ${tagName}（${remoteCommit.slice(0, 7)}），跳过创建与推送`);
  if (localCommit && localCommit !== remoteCommit) {
    log('警告：本地同名 tag 与远端指向不同提交，本次以远端为准');
  }
} else {
  if (localCommit && localCommit !== head) {
    fail(`本地已存在同名 tag ${tagName} 且指向其他提交（${localCommit.slice(0, 7)}），请先 git tag -d ${tagName}`);
  }
  if (dryRun) {
    log(`[预演] 将创建 annotated tag ${tagName}（指向 ${head.slice(0, 7)}）`);
  } else {
    if (!localCommit) {
      git(['tag', '-a', tagName, '-m', `release ${tagName}`]);
      log(`创建 annotated tag ${tagName}（指向 ${head.slice(0, 7)}）`);
    }
    if (noPush) {
      log(`--no-push：跳过推送，需要时手动执行 git push origin ${tagName}`);
    } else {
      git(['push', 'origin', tagName]);
      pushedNow = true;
      log(`已推送 tag ${tagName} 到 origin`);
    }
  }
}

// tag 早已存在时 push 不会再触发工作流，改用 API 重跑；刚 push 的不要再 dispatch，避免双跑
let shouldDispatch = remoteCommit ? !noDispatch : forceDispatch;
if (forceDispatch && !remoteCommit) {
  log('提示：--dispatch 与新建 tag 同时生效会触发两轮构建，已按单轮处理（以 push 触发为准）');
  shouldDispatch = false;
}
if (noPush && !remoteCommit) {
  shouldDispatch = false;
}

let failed = 0;
if (shouldDispatch) {
  failed = await dispatchWorkflows();
} else if (remoteCommit && noDispatch) {
  log('--no-dispatch：tag 已存在且未触发工作流，需要时在 Actions 页面手动 Run workflow');
}

if (!dryRun && noPush && !remoteCommit) {
  log('未推送 tag，工作流不会被触发');
}

printSummary(shouldDispatch ? 'dispatch' : pushedNow || (dryRun && !remoteCommit && !noPush) ? 'push' : 'none');
process.exit(failed > 0 ? 1 : 0);
