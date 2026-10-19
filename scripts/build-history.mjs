#!/usr/bin/env node
/**
 * 时间机器（本地历史）原生模块重建脚本（history addon：zstd 字节级增量 + yyjson 语义差分）
 *
 * 背景：
 * - history addon（native/history）以 libzstd 官方 patch-from（ZSTD_CCtx_refPrefix）实现
 *   「以旧文件中段为字典」的字节级增量；libzstd 源码静态编入 addon，无运行时动态库依赖
 * - JSON 语义差分（diffJson，RFC 6902）依赖 yyjson（单文件解析/序列化库，MIT）：
 *   源码同样静态编入；两份依赖均解压到 native/history/deps（生成物，不入库）
 * - 两库源码分别来自官方 release / archive tarball，按解压结果生成
 *   deps/zstd_sources.gypi 与 deps/yyjson_sources.gypi
 * - 编译用 Node headers（NAPI 8）：产物对 Electron 与 Node 双兼容，Electron 升级无需重编
 *   （与 muhammara 的裸 V8 API 路径不同，这是 N-API 的净收益）
 *
 * 用法：
 *   node scripts/build-history.mjs                  # 完整构建（源码缺失时自动下载）
 *   node scripts/build-history.mjs --refresh-zstd   # 强制重新下载解压 zstd 源码
 *   node scripts/build-history.mjs --refresh-yyjson # 强制重新下载解压 yyjson 源码
 *
 * 产物：
 *   native/history/binding.node（覆盖已有产物；构建中间目录 native/history/build 保留）
 *
 * 注意：
 * - 必须在目标平台执行（产物不可跨平台混用）
 * - 需要本地具备编译工具链（Xcode Command Line Tools / VS Build Tools / gcc）
 * - 指纹缓存闸门见 scripts/build-native.mjs（history 维度：平台/arch/Node/zstd/yyjson 版本/脚本哈希）
 */
import { execFileSync, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const moduleDir = path.join(rootDir, 'native', 'history');
const workDir = path.join(rootDir, '.native-build', 'history');
const outDir = path.join(moduleDir, 'binding.node');
const depsDir = path.join(moduleDir, 'deps');
const zstdDir = path.join(depsDir, 'zstd');
const gypiPath = path.join(depsDir, 'zstd_sources.gypi');
const yyjsonDir = path.join(depsDir, 'yyjson');
const yyjsonGypiPath = path.join(depsDir, 'yyjson_sources.gypi');

const ZSTD_VERSION = '1.5.7';
const ZSTD_URL = `https://github.com/facebook/zstd/releases/download/v${ZSTD_VERSION}/zstd-${ZSTD_VERSION}.tar.gz`;

const YYJSON_VERSION = '0.10.0';
const YYJSON_URL = `https://github.com/ibireme/yyjson/archive/refs/tags/${YYJSON_VERSION}.tar.gz`;

function log(message) {
  console.log(`[build-history] ${message}`);
}

function run(command, cwd) {
  log(`$ ${command}`);
  execSync(command, { cwd, stdio: 'inherit' });
}

/** 下载 zstd 源码 tarball（带本地缓存） */
async function fetchZstdTarball() {
  const cacheFile = path.join(workDir, `zstd-${ZSTD_VERSION}.tar.gz`);
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 1024 * 1024) {
    log(`使用缓存的 zstd 源码包：${path.relative(rootDir, cacheFile)}`);
    return cacheFile;
  }
  fs.mkdirSync(workDir, { recursive: true });
  log(`下载 zstd ${ZSTD_VERSION}：${ZSTD_URL}`);
  const response = await fetch(ZSTD_URL);
  if (!response.ok) {
    throw new Error(`下载 zstd 源码失败：HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024 * 1024) {
    throw new Error('zstd 源码包体积异常，下载可能被截断');
  }
  fs.writeFileSync(cacheFile, buffer);
  log(`已缓存源码包（${(buffer.length / 1024 / 1024).toFixed(1)}MB）`);
  return cacheFile;
}

/** 解压 tarball 并拷贝 lib/{common,compress,decompress} 与公共头文件到 deps/zstd */
function extractZstd(tarball) {
  const extractDir = path.join(workDir, 'extract');
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  // 只解压 lib 与 LICENSE：完整 tarball 的 tests/cli-tests/bin/* 是符号链接，
  // Windows 的 bsdtar 无法创建符号链接会以非零码退出（与构建无关的内容）
  const members = [`zstd-${ZSTD_VERSION}/lib`, `zstd-${ZSTD_VERSION}/LICENSE`];
  try {
    // Windows 10+ 自带 bsdtar；mac/linux 自带 tar
    run(`tar -xzf "${tarball}" -C "${extractDir}" ${members.join(' ')}`, workDir);
  } catch (error) {
    const sourceLib = path.join(extractDir, `zstd-${ZSTD_VERSION}`, 'lib');
    if (!fs.existsSync(path.join(sourceLib, 'zstd.h'))) {
      throw error;
    }
    log('tar 退出码非零，但 lib 源码已解出，继续');
  }

  const sourceRoot = path.join(extractDir, `zstd-${ZSTD_VERSION}`);
  const sourceLib = path.join(sourceRoot, 'lib');
  if (!fs.existsSync(path.join(sourceLib, 'zstd.h'))) {
    throw new Error(`zstd 源码结构异常：${sourceLib}`);
  }

  fs.rmSync(zstdDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(zstdDir, 'lib'), { recursive: true });

  // 头文件 + 三个子目录（仅 .c/.h，剔除 Makefile 等）
  const keepFile = (name) => name.endsWith('.c') || name.endsWith('.h');
  for (const entry of fs.readdirSync(sourceLib)) {
    const from = path.join(sourceLib, entry);
    if (fs.statSync(from).isFile() && keepFile(entry)) {
      fs.copyFileSync(from, path.join(zstdDir, 'lib', entry));
    }
  }
  for (const sub of ['common', 'compress', 'decompress']) {
    fs.cpSync(path.join(sourceLib, sub), path.join(zstdDir, 'lib', sub), {
      recursive: true,
      filter: (src) => fs.statSync(src).isDirectory() || keepFile(src),
    });
  }

  // LICENSE 一并保留（BSD-3，无许可污染）
  const license = path.join(sourceRoot, 'LICENSE');
  if (fs.existsSync(license)) {
    fs.copyFileSync(license, path.join(zstdDir, 'LICENSE'));
  }
  log(`zstd 源码已就位：${path.relative(rootDir, zstdDir)}`);
}

/** 下载 yyjson 源码 tarball（带本地缓存） */
async function fetchYyjsonTarball() {
  const cacheFile = path.join(workDir, `yyjson-${YYJSON_VERSION}.tar.gz`);
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 100 * 1024) {
    log(`使用缓存的 yyjson 源码包：${path.relative(rootDir, cacheFile)}`);
    return cacheFile;
  }
  fs.mkdirSync(workDir, { recursive: true });
  log(`下载 yyjson ${YYJSON_VERSION}：${YYJSON_URL}`);
  const response = await fetch(YYJSON_URL);
  if (!response.ok) {
    throw new Error(`下载 yyjson 源码失败：HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 100 * 1024) {
    throw new Error('yyjson 源码包体积异常，下载可能被截断');
  }
  fs.writeFileSync(cacheFile, buffer);
  log(`已缓存源码包（${(buffer.length / 1024).toFixed(0)}KB）`);
  return cacheFile;
}

/** 解压 tarball 并拷贝 src/{yyjson.c,yyjson.h} 与 LICENSE 到 deps/yyjson */
function extractYyjson(tarball) {
  const extractDir = path.join(workDir, 'extract-yyjson');
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const prefix = `yyjson-${YYJSON_VERSION}`;
  const members = [`${prefix}/src`, `${prefix}/LICENSE`];
  try {
    run(`tar -xzf "${tarball}" -C "${extractDir}" ${members.join(' ')}`, workDir);
  } catch (error) {
    if (!fs.existsSync(path.join(extractDir, prefix, 'src', 'yyjson.c'))) {
      throw error;
    }
    log('tar 退出码非零，但 yyjson 源码已解出，继续');
  }

  const sourceSrc = path.join(extractDir, prefix, 'src');
  if (!fs.existsSync(path.join(sourceSrc, 'yyjson.c')) || !fs.existsSync(path.join(sourceSrc, 'yyjson.h'))) {
    throw new Error(`yyjson 源码结构异常：${sourceSrc}`);
  }

  fs.rmSync(yyjsonDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(yyjsonDir, 'src'), { recursive: true });
  for (const name of ['yyjson.c', 'yyjson.h']) {
    fs.copyFileSync(path.join(sourceSrc, name), path.join(yyjsonDir, 'src', name));
  }
  // LICENSE 一并保留（MIT，无许可污染）
  const license = path.join(extractDir, prefix, 'LICENSE');
  if (fs.existsSync(license)) {
    fs.copyFileSync(license, path.join(yyjsonDir, 'LICENSE'));
  }
  log(`yyjson 源码已就位：${path.relative(rootDir, yyjsonDir)}`);
}

/** 按解压结果生成 gyp 源清单（.c 全量 + include_dirs），路径相对 deps/ 目录（gyp includes 语义） */
function writeSourcesGypi() {
  const sources = [];
  for (const sub of ['common', 'compress', 'decompress']) {
    const dir = path.join(zstdDir, 'lib', sub);
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith('.c')) {
        sources.push(`zstd/lib/${sub}/${name}`);
      }
    }
  }
  const lines = [
    '# 由 scripts/build-history.mjs 生成：zstd 源文件清单（不手工编辑）',
    `# zstd v${ZSTD_VERSION}`,
    '# 路径相对本 gypi 所在目录（gyp includes 语义：gypi 内相对路径以 gypi 目录为基准）',
    '{',
    "  'include_dirs': [ 'zstd/lib' ],",
    "  'sources': [",
    ...sources.map((file) => `    '${file}',`),
    '  ],',
    '}',
    ''
  ];
  fs.mkdirSync(depsDir, { recursive: true });
  fs.writeFileSync(gypiPath, lines.join('\n'));
  log(`已生成源清单：${path.relative(rootDir, gypiPath)}（${sources.length} 个 .c）`);
}

/** 生成 yyjson gyp 源清单（单文件库：yyjson.c + include_dirs），路径相对 deps/ 目录 */
function writeYyjsonGypi() {
  const lines = [
    '# 由 scripts/build-history.mjs 生成：yyjson 源文件清单（不手工编辑）',
    `# yyjson v${YYJSON_VERSION}`,
    '# 路径相对本 gypi 所在目录（gyp includes 语义：gypi 内相对路径以 gypi 目录为基准）',
    '{',
    "  'include_dirs': [ 'yyjson/src' ],",
    "  'sources': [ 'yyjson/src/yyjson.c' ],",
    '}',
    ''
  ];
  fs.mkdirSync(depsDir, { recursive: true });
  fs.writeFileSync(yyjsonGypiPath, lines.join('\n'));
  log(`已生成源清单：${path.relative(rootDir, yyjsonGypiPath)}`);
}

/** 编译产物自检：加载 binding 并做 patch/apply 往返 + 边界校验 */
function selfCheck() {
  const require = createRequire(import.meta.url);
  delete require.cache[outDir];
  const addon = require(outDir);

  const zstdVersion = addon.version();
  if (typeof zstdVersion !== 'string' || !zstdVersion.startsWith(ZSTD_VERSION)) {
    throw new Error(`addon 内嵌 zstd 版本异常：${zstdVersion}`);
  }

  const base = Buffer.from(JSON.stringify({ a: 1, text: 'hello 时间机器' }).repeat(200));
  const next = Buffer.from(JSON.stringify({ a: 1, text: 'hello 时间机器!' }).repeat(200) + 'tail');

  const same = addon.patch(base, base);
  if (same.type !== 0) {
    throw new Error('patch 判等失败');
  }

  const delta = addon.patch(base, next);
  if (delta.type !== 1) {
    throw new Error('patch 未产出增量');
  }
  const applied = addon.apply(base, delta.data);
  if (!applied.equals(next)) {
    throw new Error('apply(patch(old, new)) !== new');
  }

  const frame = addon.compress(next);
  if (!addon.decompress(frame).equals(next)) {
    throw new Error('compress/decompress 往返失败');
  }

  // 边界：空输入 + 损坏增量
  if (addon.patch(Buffer.alloc(0), Buffer.alloc(0)).type !== 0) {
    throw new Error('空输入判等失败');
  }
  let corrupted = false;
  try {
    addon.apply(base, Buffer.from([1, 2, 3]));
  } catch {
    corrupted = true;
  }
  if (!corrupted) {
    throw new Error('损坏增量未抛错');
  }

  // diffJson：语义差分（RFC 6902 操作序列形态与判等）
  const jsonA = Buffer.from(JSON.stringify({ a: 1, list: [{ id: 'x', v: 1 }, 's'], keep: true }));
  const jsonB = Buffer.from(JSON.stringify({ a: 1, list: ['s', { id: 'x', v: 2 }, { id: 'y', v: 9 }], keep: true }));
  const ops = JSON.parse(addon.diffJson(jsonA, jsonB).toString('utf8'));
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error('diffJson 未产出操作序列');
  }
  for (const op of ops) {
    if (typeof op.op !== 'string' || typeof op.path !== 'string') {
      throw new Error('diffJson 产出了非法操作');
    }
  }
  const noOps = JSON.parse(addon.diffJson(jsonA, jsonA).toString('utf8'));
  if (!Array.isArray(noOps) || noOps.length !== 0) {
    throw new Error('diffJson 判等失败（应输出空操作序列）');
  }

  log(`自检通过（zstd ${zstdVersion}，delta ${delta.data.length}/${next.length} 字节，diffJson ${ops.length} 条操作）`);
}

async function main() {
  // 编译输入自检：发布镜像仓库需由 scripts/sync-release.mjs 同步 native/history 源码，
  // 缺失时 node-gyp 只会抛出难定位的「binding.gyp not found」
  const requiredInputs = ['binding.gyp', 'src/history.cc', 'src/history_kernel.cc', 'src/history_kernel.h'];
  const missing = requiredInputs.filter((rel) => !fs.existsSync(path.join(moduleDir, rel)));
  if (missing.length > 0) {
    throw new Error(`缺少编译输入：${missing.join('、')}（目录 ${moduleDir}；发布镜像仓库请先同步 native/history）`);
  }

  const refreshZstd = process.argv.includes('--refresh-zstd');
  const refreshYyjson = process.argv.includes('--refresh-yyjson');
  if (refreshZstd || !fs.existsSync(path.join(zstdDir, 'lib', 'zstd.h'))) {
    const tarball = await fetchZstdTarball();
    extractZstd(tarball);
  } else {
    log('zstd 源码已存在（--refresh-zstd 可强制刷新）');
  }
  if (refreshYyjson || !fs.existsSync(path.join(yyjsonDir, 'src', 'yyjson.c'))) {
    const tarball = await fetchYyjsonTarball();
    extractYyjson(tarball);
  } else {
    log('yyjson 源码已存在（--refresh-yyjson 可强制刷新）');
  }
  writeSourcesGypi();
  writeYyjsonGypi();

  // Node headers 编译（NAPI 8）：产物对 Electron/Node 双兼容
  run('npx --yes node-gyp rebuild --napi_build_version=8', moduleDir);

  const built = path.join(moduleDir, 'build', 'Release', 'history.node');
  if (!fs.existsSync(built)) {
    console.error('[build-history] 未找到编译产物 build/Release/history.node');
    process.exit(1);
  }
  // 先写临时文件再 rename，不能直接覆盖 outDir：开发期 Electron 可能正映射着旧
  // binding.node，原地覆盖后 macOS 代码签名缓存失效，下次 require/dlopen 会被 SIGKILL
  const tempOut = `${outDir}.${process.pid}.tmp`;
  fs.copyFileSync(built, tempOut);
  fs.renameSync(tempOut, outDir);
  log(`完成：${path.relative(rootDir, outDir)}`);

  selfCheck();
}

main().catch((error) => {
  console.error(`[build-history] 构建失败：${error?.message ?? error}`);
  process.exit(1);
});
