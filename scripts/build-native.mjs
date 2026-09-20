#!/usr/bin/env node
/**
 * muhammara 原生模块重建入口（本地构建缓存闸门）
 *
 * 背景：
 * - build-muhammara.mjs 全量编译耗时较长（下载源码 + C++ 编译），
 *   但仅在以下情况才需要重新编译：Electron 版本变更、muhammara 版本变更、
 *   构建脚本变更、绑定产物缺失
 * - 本脚本采用与 CI 缓存键同款的构建指纹（平台/架构/Electron 版本/muhammara
 *   版本/构建脚本哈希，见 .github/workflows/build-*.yml），指纹命中且产物存在
 *   时跳过编译；未命中时调用 build-muhammara.mjs，成功后写入缓存标记
 *
 * 用法：
 *   node scripts/build-native.mjs            # 指纹命中则跳过，否则编译
 *   node scripts/build-native.mjs --dry-run  # 仅输出是否会重建，不执行任何操作
 *   node scripts/build-native.mjs --force    # 忽略缓存标记，强制重建
 *
 * 缓存标记：.native-build/stamp.json（该目录为编译临时工作目录，不入库；
 *   直接运行 build-muhammara.mjs 会清空 .native-build，届时下次运行本脚本将重建）
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builderPath = path.join(rootDir, 'scripts', 'build-muhammara.mjs');
const bindingPath = path.join(rootDir, 'native', 'muhammara', 'binding.node');
const stampPath = path.join(rootDir, '.native-build', 'stamp.json');

/**
 * 读取 Electron 版本（解析逻辑与 build-muhammara.mjs 保持一致：
 * 优先本地安装版本，未安装时回退根 package.json 声明版本）
 */
function readElectronVersion() {
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(rootDir, 'node_modules', 'electron', 'package.json'), 'utf8'));
    if (installed.version) {
      return String(installed.version);
    }
  } catch {
    // 忽略：回退 package.json 声明版本.
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const spec = pkg.devDependencies?.electron ?? pkg.dependencies?.electron;
  const matched = typeof spec === 'string' ? spec.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/) : null;
  if (!matched) {
    console.error('[build-native] 无法确定 Electron 版本，请检查 package.json 中的 electron 依赖');
    process.exit(1);
  }
  return matched[0];
}

/** 计算当前构建指纹（维度与 CI 缓存键一致，任一维度变化都会触发重编译） */
function currentFingerprint() {
  const script = fs.readFileSync(builderPath, 'utf8');
  const muhammara = script.match(/MUHAMMARA_VERSION = '([^']*)'/)?.[1] ?? 'unknown';
  const scriptHash = createHash('sha256').update(script).digest('hex');
  const { platform, arch } = process;
  const electron = readElectronVersion();
  return {
    fingerprint: [platform, arch, `electron-${electron}`, `muhammara-${muhammara}`, `script-${scriptHash}`].join('-'),
    electron,
    muhammara,
    platform,
    arch,
    scriptHash
  };
}

/** 描述缓存标记与当前指纹的差异（便于判断为何重建） */
function describeChange(cached, current) {
  const parts = [];
  if (cached.electron !== current.electron) {
    parts.push(`Electron ${cached.electron} -> ${current.electron}`);
  }
  if (cached.muhammara !== current.muhammara) {
    parts.push(`muhammara ${cached.muhammara} -> ${current.muhammara}`);
  }
  if (cached.scriptHash !== current.scriptHash) {
    parts.push('构建脚本已变更');
  }
  if (cached.platform !== current.platform || cached.arch !== current.arch) {
    parts.push(`平台 ${cached.platform}-${cached.arch} -> ${current.platform}-${current.arch}`);
  }
  return parts.join('；') || '缓存状态异常';
}

const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');
const current = currentFingerprint();

if (current.muhammara === 'unknown') {
  console.warn('[build-native] 未能从构建脚本解析 MUHAMMARA_VERSION，将始终重建');
}

let cached = null;
try {
  cached = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
} catch {
  // 忽略：无缓存标记
}

const summary = `Electron ${current.electron} / muhammara ${current.muhammara} / 平台 ${current.platform}-${current.arch}`;
const matched = current.muhammara !== 'unknown' && cached?.fingerprint === current.fingerprint && fs.existsSync(bindingPath);

if (!force && matched) {
  console.log(`[build-native] 命中缓存（${summary} / 构建脚本未变更），跳过编译`);
  console.log('[build-native] 强制重建：node scripts/build-native.mjs --force');
  process.exit(0);
}

const reason = force
  ? '--force 强制重建'
  : !cached
    ? '首次构建（无缓存标记）'
    : !fs.existsSync(bindingPath)
      ? '绑定产物缺失'
      : describeChange(cached, current);
console.log(`[build-native] 需要重建：${reason}`);

if (dryRun) {
  console.log('[build-native] --dry-run：不执行编译');
  process.exit(0);
}

try {
  execFileSync(process.execPath, [builderPath], { cwd: rootDir, stdio: 'inherit' });
} catch {
  console.error('[build-native] 编译失败，缓存标记未更新（详见上方编译输出）');
  process.exit(1);
}

fs.mkdirSync(path.dirname(stampPath), { recursive: true });
fs.writeFileSync(stampPath, JSON.stringify({ ...current, builtAt: new Date().toISOString() }, null, 2));
console.log(`[build-native] 编译完成，缓存标记已更新（${summary}）`);
