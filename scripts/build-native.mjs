#!/usr/bin/env node
/**
 * 原生模块重建入口（本地构建缓存闸门）
 *
 * 覆盖模块：
 * - muhammara（PDF 合并）：指纹 = 平台/架构/Electron 版本/muhammara 版本/构建脚本哈希
 *   （与 CI 缓存键一致，见 .github/workflows/build-*.yml）
 * - history（时间机器内核）：N-API 产物用 Node headers 编译，指纹 = 平台/架构/Node 版本/
 *   zstd 版本/yyjson 版本/构建脚本哈希（不绑定 Electron 版本，Electron 升级免重编）
 *
 * 两者全量编译都较慢（下载源码 + C/C++ 编译），仅当指纹变化或产物缺失时才重编；
 * 指纹命中且产物存在时跳过，未命中时调用对应构建脚本，成功后写入缓存标记
 *
 * 用法：
 *   node scripts/build-native.mjs                    # 全部模块：指纹命中则跳过，否则编译
 *   node scripts/build-native.mjs --only history     # 仅处理指定模块（muhammara|history）
 *   node scripts/build-native.mjs --dry-run          # 仅输出是否会重建，不执行任何操作
 *   node scripts/build-native.mjs --force            # 忽略缓存标记，强制重建
 *
 * 缓存标记：.native-build/stamp.json（该目录为编译临时工作目录，不入库）
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stampPath = path.join(rootDir, '.native-build', 'stamp.json');

/**
 * 模块表：脚本路径、产物路径、版本号提取键与指纹摘要
 * - muhammara：裸 V8 API，与 Electron 头文件绑定（指纹含 Electron 版本）
 * - history：N-API 8，Node headers 编译（指纹含 Node 版本，不含 Electron 版本）
 * versionKeys 指向构建脚本内的版本常量名（可多个，任一变化都触发重编）
 */
const modules = [
  {
    name: 'muhammara',
    builder: 'scripts/build-muhammara.mjs',
    binding: 'native/muhammara/binding.node',
    versionKeys: ['MUHAMMARA_VERSION'],
    summary: (current) => `Electron ${current.electron} / muhammara ${current.muhammara} / 平台 ${current.platform}-${current.arch}`
  },
  {
    name: 'history',
    builder: 'scripts/build-history.mjs',
    binding: 'native/history/binding.node',
    versionKeys: ['ZSTD_VERSION', 'YYJSON_VERSION'],
    summary: (current) => `Node ${current.node} / zstd ${current.zstd} / yyjson ${current.yyjson} / 平台 ${current.platform}-${current.arch}`
  }
];

/** 版本键 → 指纹字段名：'ZSTD_VERSION' -> 'zstd'，'MUHAMMARA_VERSION' -> 'muhammara' */
function versionField(key) {
  return key.replace(/_VERSION$/, '').toLowerCase();
}

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

/** 计算指定模块的当前构建指纹（任一维度变化都会触发重编译） */
function moduleFingerprint(module) {
  const script = fs.readFileSync(path.join(rootDir, module.builder), 'utf8');
  const versions = {};
  for (const key of module.versionKeys) {
    const field = versionField(key);
    versions[field] = script.match(new RegExp(`${key} = '([^']*)'`))?.[1] ?? 'unknown';
  }
  const scriptHash = createHash('sha256').update(script).digest('hex');
  const { platform, arch } = process;
  if (module.name === 'muhammara') {
    const electron = readElectronVersion();
    return {
      fingerprint: [platform, arch, `electron-${electron}`, `muhammara-${versions.muhammara}`, `script-${scriptHash}`].join('-'),
      electron,
      muhammara: versions.muhammara,
      platform,
      arch,
      scriptHash
    };
  }
  // history：N-API 产物（Node headers 编译），指纹绑定 Node 版本而非 Electron 版本
  const node = process.versions.node;
  return {
    fingerprint: [platform, arch, `node-${node}`, `zstd-${versions.zstd}`, `yyjson-${versions.yyjson}`, `script-${scriptHash}`].join('-'),
    node,
    zstd: versions.zstd,
    yyjson: versions.yyjson,
    platform,
    arch,
    scriptHash
  };
}

/** 读取缓存标记；兼容旧格式（顶层即 muhammara 单模块记录） */
function readStamps() {
  try {
    const raw = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    if (raw && typeof raw === 'object') {
      if (typeof raw.fingerprint === 'string') {
        return { muhammara: raw };
      }
      return raw;
    }
  } catch {
    // 忽略：无缓存标记
  }
  return {};
}

/** 描述缓存标记与当前指纹的差异（便于判断为何重建） */
function describeChange(module, cached, current) {
  const parts = [];
  if (module.name === 'muhammara') {
    if (cached.electron !== current.electron) {
      parts.push(`Electron ${cached.electron} -> ${current.electron}`);
    }
    if (cached.muhammara !== current.muhammara) {
      parts.push(`muhammara ${cached.muhammara} -> ${current.muhammara}`);
    }
  } else {
    if (cached.node !== current.node) {
      parts.push(`Node ${cached.node} -> ${current.node}`);
    }
    if (cached.zstd !== current.zstd) {
      parts.push(`zstd ${cached.zstd} -> ${current.zstd}`);
    }
    if (cached.yyjson !== current.yyjson) {
      parts.push(`yyjson ${cached.yyjson} -> ${current.yyjson}`);
    }
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
const onlyIndex = process.argv.indexOf('--only');
const onlyArg = onlyIndex >= 0
  ? process.argv[onlyIndex + 1]
  : process.argv.find((arg) => arg.startsWith('--only='))?.split('=')[1];
const targets = onlyArg ? modules.filter((module) => module.name === onlyArg) : modules;

if (onlyArg && targets.length === 0) {
  console.error(`[build-native] 未知模块：${onlyArg}（可选：${modules.map((module) => module.name).join('|')}）`);
  process.exit(1);
}

const stamps = readStamps();
let failed = false;

for (const module of targets) {
  const current = moduleFingerprint(module);
  const bindingPath = path.join(rootDir, module.binding);
  const summary = module.summary(current);
  const missingVersions = module.versionKeys.filter((key) => current[versionField(key)] === 'unknown');
  const knownVersion = missingVersions.length === 0;
  if (!knownVersion) {
    console.warn(`[build-native] 未能从 ${module.builder} 解析 ${missingVersions.join('/')}，将始终重建`);
  }

  const cached = stamps[module.name] ?? null;
  if (!force && knownVersion && cached?.fingerprint === current.fingerprint && fs.existsSync(bindingPath)) {
    console.log(`[build-native] ${module.name} 命中缓存（${summary} / 构建脚本未变更），跳过编译`);
    continue;
  }

  const reason = force
    ? '--force 强制重建'
    : !cached
      ? '首次构建（无缓存标记）'
      : !fs.existsSync(bindingPath)
        ? '绑定产物缺失'
        : describeChange(module, cached, current);
  console.log(`[build-native] ${module.name} 需要重建：${reason}`);

  if (dryRun) {
    continue;
  }

  try {
    execFileSync(process.execPath, [path.join(rootDir, module.builder)], { cwd: rootDir, stdio: 'inherit' });
  } catch {
    console.error(`[build-native] ${module.name} 编译失败（详见上方编译输出）`);
    failed = true;
    break;
  }
  stamps[module.name] = { ...current, builtAt: new Date().toISOString() };
  console.log(`[build-native] ${module.name} 编译完成（${summary}）`);
}

// 已成功模块的缓存标记始终落盘（失败时不回滚已完成的成果）
if (!dryRun) {
  fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  fs.writeFileSync(stampPath, JSON.stringify(stamps, null, 2));
}

if (failed) {
  process.exit(1);
}
if (dryRun) {
  console.log('[build-native] --dry-run：未执行编译');
} else if (!force) {
  console.log('[build-native] 全部处理完成；强制重建：node scripts/build-native.mjs --force（或 --only=<模块>）');
}
