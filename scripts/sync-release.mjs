#!/usr/bin/env node
/**
 * 将 electron 仓库中「发布打包」所需的文件同步到 electron-release 仓库。
 *
 * 背景：electron-release 是用于 GitHub Actions 打包的镜像仓库；本脚本替代手动拷贝，
 * 由 rollup 每次构建成功后自动触发（见 rollup.config.ts 中的 sync-release 插件），
 * 也可随时手动执行：
 *
 *   node scripts/sync-release.mjs               # 完整输出
 *   node scripts/sync-release.mjs --dry-run     # 预演：只列出将要变更的文件，不写入
 *   node scripts/sync-release.mjs --quiet       # 仅在发生变更时输出（构建时使用）
 *   node scripts/sync-release.mjs --dir=<路径>  # 指定 electron-release 目录
 *
 * 同步内容（均以 electron 仓库为准）：
 *   dist/                 构建产物（镜像：多删少补）
 *   assets/               图标与签名授权文件（镜像）
 *   scripts/              CI 工作流依赖的原生模块构建脚本（镜像）
 *   .github/workflows/    GitHub Actions 打包工作流（镜像）
 *   package.json          元数据与 electron-builder 配置（剔除本地路径依赖）
 *   package-lock.json     package.json 变化时通过 npm install --package-lock-only 重生成
 *   .gitignore / .npmrc   仓库配置
 *
 * 注意：不会执行 git 提交；同步完成后请自行检查 electron-release 并提交。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const quiet = argv.includes('--quiet');
const dirArg = argv.find((arg) => arg.startsWith('--dir='));
const releaseDir = path.resolve(dirArg ? dirArg.slice('--dir='.length) : path.join(rootDir, '..', 'electron-release'));

/** 不参与同步与删除的文件（macOS 目录元数据） */
const ignoredNames = new Set(['.DS_Store']);

const stats = { added: 0, updated: 0, removed: 0 };
const details = [];

function log(message) {
  if (!quiet) {
    console.log(`[sync-release] ${message}`);
  }
}

function fail(message) {
  console.error(`[sync-release] 错误：${message}`);
  process.exit(1);
}

// ---------- 校验目标仓库，防止误写 ----------
if (releaseDir === rootDir) {
  fail('目标目录不能是 electron 仓库自身');
}
if (!fs.existsSync(path.join(releaseDir, '.git'))) {
  fail(`目标目录不是 git 仓库：${releaseDir}（可用 --dir=<路径> 指定）`);
}

// ---------- 基础工具 ----------
function walkFiles(dir) {
  const files = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (ignoredNames.has(entry.name)) {
        continue;
      }
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        stack.push(childRel);
      } else if (entry.isFile()) {
        files.push(childRel);
      }
    }
  }
  return files;
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function recordChange(relPath, existed) {
  details.push(`  ${relPath}（${existed ? '更新' : '新增'}）`);
  stats[existed ? 'updated' : 'added'] += 1;
}

function pruneEmptyDirs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      pruneEmptyDirs(path.join(dir, entry.name));
    }
  }
  if (fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir);
  }
}

/** 镜像目录：使目标与源完全一致（新增/更新/删除多余文件） */
function mirrorDir(label, srcDir, destDir) {
  if (!fs.existsSync(srcDir)) {
    fail(`源目录不存在：${srcDir}`);
  }
  const srcFiles = walkFiles(srcDir);
  if (srcFiles.length === 0) {
    fail(`源目录为空，拒绝同步以防误删：${srcDir}`);
  }
  const remainingDest = new Set(fs.existsSync(destDir) ? walkFiles(destDir) : []);

  for (const rel of srcFiles) {
    remainingDest.delete(rel);
    const srcContent = fs.readFileSync(path.join(srcDir, rel));
    const destContent = readIfExists(path.join(destDir, rel));
    if (destContent && srcContent.equals(destContent)) {
      continue;
    }
    recordChange(`${label}/${rel}`, Boolean(destContent));
    if (!dryRun) {
      const dest = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(srcDir, rel), dest);
    }
  }

  for (const rel of remainingDest) {
    details.push(`  ${label}/${rel}（删除）`);
    stats.removed += 1;
    if (!dryRun) {
      fs.rmSync(path.join(destDir, rel), { force: true });
    }
  }
  if (!dryRun && remainingDest.size > 0) {
    pruneEmptyDirs(destDir);
  }
}

/** 单文件同步（内容一致则跳过），返回是否发生变更 */
function syncFile(relPath, content) {
  const dest = path.join(releaseDir, relPath);
  const destContent = readIfExists(dest);
  const buffer = Buffer.from(content);
  if (destContent && buffer.equals(destContent)) {
    return false;
  }
  recordChange(relPath, Boolean(destContent));
  if (!dryRun) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buffer);
  }
  return true;
}

/**
 * 以 electron 的 package.json 为基准生成 release 版：
 * 剔除 file:/绝对路径 依赖（@slinote/service 等仅本地开发存在，CI 上 npm ci 会失败）
 */
function buildReleasePackageJson() {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (typeof spec === 'string' && (spec.startsWith('file:') || path.isAbsolute(spec))) {
        log(`package.json：剔除本地路径依赖 ${name}（${spec}）`);
        delete pkg[field][name];
      }
    }
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

// ---------- 执行同步 ----------
log(dryRun ? `预演（不写入）：${releaseDir}` : `同步到：${releaseDir}`);
mirrorDir('dist', path.join(rootDir, 'dist'), path.join(releaseDir, 'dist'));
mirrorDir('assets', path.join(rootDir, 'assets'), path.join(releaseDir, 'assets'));
mirrorDir('scripts', path.join(rootDir, 'scripts'), path.join(releaseDir, 'scripts'));
mirrorDir('.github/workflows', path.join(rootDir, '.github', 'workflows'), path.join(releaseDir, '.github', 'workflows'));

const packageChanged = syncFile('package.json', buildReleasePackageJson());
if (packageChanged) {
  if (dryRun) {
    details.push('  package-lock.json（将由 npm install --package-lock-only 重生成）');
    stats.updated += 1;
  } else {
    log('package.json 已变更，正在重生成 package-lock.json ...');
    try {
      execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], { cwd: releaseDir, stdio: 'inherit' });
      details.push('  package-lock.json（重生成）');
      stats.updated += 1;
    } catch {
      console.error('[sync-release] 警告：package-lock.json 重生成失败，CI 的 npm ci 可能因锁文件与 package.json 不匹配而失败。');
      console.error('[sync-release] 请在 electron-release 目录手动执行：npm install --package-lock-only');
      process.exitCode = 1;
    }
  }
}

for (const name of ['.gitignore', '.npmrc']) {
  syncFile(name, fs.readFileSync(path.join(rootDir, name)));
}

// ---------- 输出结果 ----------
const total = stats.added + stats.updated + stats.removed;
if (total === 0) {
  log('electron-release 已是最新，无需同步');
} else if (quiet) {
  console.log(`[sync-release] 已同步 ${total} 个文件到 electron-release（新增 ${stats.added} / 更新 ${stats.updated} / 删除 ${stats.removed}）`);
} else {
  for (const line of details) {
    console.log(line);
  }
  log(`完成：新增 ${stats.added}，更新 ${stats.updated}，删除 ${stats.removed}`);
  if (dryRun) {
    log('以上为预演结果，未写入任何文件（去掉 --dry-run 后执行）');
  } else if (process.exitCode !== 1) {
    try {
      const pending = execFileSync('git', ['-C', releaseDir, 'status', '--porcelain'], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean).length;
      log(`electron-release 当前共 ${pending} 个文件待提交，检查无误后：`);
    } catch {
      log('检查无误后提交：');
    }
    console.log(`  cd ${releaseDir} && git add -A && git commit -m "feat: release" && git push`);
  }
}
