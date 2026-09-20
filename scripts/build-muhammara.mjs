#!/usr/bin/env node
/**
 * muhammara 精简原生运行时重建脚本（主进程 PDF 合并与大纲写入用）
 *
 * 背景：
 * - 项目仅需 muhammara 的「PDF 合并 + 大纲写入」能力，运行时只保留编译产物 binding.node
 *   与自研精简加载器（src/pdf/native.ts），不引入 @muhammara/native-core 的 JS 依赖
 * - 基于 7.0.0-beta.1：官方 src/nodes.h 已内建 V8 版本条件编译（V8 >= 14.8 使用
 *   ExternalPointerTypeTag），Electron 43（V8 15）直接命中新 API，无需补丁；
 *   脚本保留旧版源码的补丁逻辑（幂等，beta.1 自动跳过）
 * - 裁剪 OpenSSL：定义 PDFHUMMUS_NO_OPENSSL 并移除 openssl 构建/链接依赖后，
 *   不再静态链接 libcrypto（体积约减半）；仅 PDF 2.0/AES-256 加密不可用，
 *   RC4/AES-128 由内置 LibAesgm 实现，合并/大纲等全部功能不受影响
 * - 编译告警抑制：对顶层与 src/deps 下各依赖的 binding.gyp 注入统一的 target_defaults，
 *   关闭第三方源码与绑定层的已知无害告警（未使用返回值/变量、弃用 API、K&R
 *   旧式函数原型等），编译日志仅保留有价值的信息
 *
 * 用法：
 *   node scripts/build-muhammara.mjs.
 *
 * 产物：
 *   native/muhammara/binding.node（覆盖已有产物）
 *
 * 注意：
 * - 必须在目标平台执行（mac/win/linux 产物不可混用），Electron 升级后需重新执行
 * - 需要本地具备编译工具链（Xcode Command Line Tools / VS Build Tools / gcc）
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workDir = path.join(rootDir, '.native-build');
const outDir = path.join(rootDir, 'native', 'muhammara');
const MUHAMMARA_PACKAGE = '@muhammara/native-with-source';
const MUHAMMARA_VERSION = '7.0.0-beta.1';
/**
 * 读取 Electron 版本作为编译 target：
 * 优先取本地安装版本（与实际运行版本一致），未安装时回退根 package.json 声明版本
 */
function readElectronVersion() {
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(rootDir, 'node_modules', 'electron', 'package.json'), 'utf8'));
    if (installed.version) {
      return String(installed.version);
    }
  } catch {
    // 忽略：回退 package.json 声明版本
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const spec = pkg.devDependencies?.electron ?? pkg.dependencies?.electron;
  // 兼容 ^/~/精确等声明形式，提取版本数字部分
  const matched = typeof spec === 'string' ? spec.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/) : null;
  if (!matched) {
    console.error('[build-muhammara] 无法确定 Electron 版本，请检查 package.json 中的 electron 依赖');
    process.exit(1);
  }
  return matched[0];
}

function run(command, cwd) {
  console.log(`[build-muhammara] $ ${command}`);
  execSync(command, { cwd, stdio: 'inherit' });
}

// 1. 下载源码包（含 C++ 源码与构建脚本）
fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });
run(`npm pack ${MUHAMMARA_PACKAGE}@${MUHAMMARA_VERSION} --pack-destination "${workDir}"`, rootDir);

const tarball = fs.readdirSync(workDir).find((name) => name.endsWith('.tgz'));
if (!tarball) {
  console.error('[build-muhammara] 未找到下载的 npm 源码包');
  process.exit(1);
}
run(`tar -xzf "${path.join(workDir, tarball)}" -C "${workDir}"`, workDir);

const packageDir = path.join(workDir, 'package');

// 2. V8 External tag 兼容处理（beta.1 起官方已内建条件编译，旧版源码走补丁）
const nodesHeader = path.join(packageDir, 'src', 'nodes.h');
const nodesSource = fs.readFileSync(nodesHeader, 'utf8');
if (nodesSource.includes('V8_MAJOR_VERSION > 14')) {
  console.log('[build-muhammara] 源码已内建 V8 条件编译，跳过补丁');
} else {
  const nodesPatched = nodesSource
    .split('e->Value()').join('e->Value(v8::kExternalPointerTypeTagDefault)')
    .split('External::New(isolate, c1)').join('External::New(isolate, c1, v8::kExternalPointerTypeTagDefault)');
  if (nodesPatched !== nodesSource) {
    fs.writeFileSync(nodesHeader, nodesPatched);
    console.log('[build-muhammara] 已应用 V8 External tag 兼容补丁（src/nodes.h）');
  } else {
    console.log('[build-muhammara] 兼容补丁已存在，跳过');
  }
}

// 3. gyp 改造：
//    ① 裁剪 OpenSSL（PDFHUMMUS_NO_OPENSSL）移除 openssl 构建/链接依赖，
//    不再静态链接 libcrypto（体积约减半），仅 PDF 2.0/AES-256 加密不可用；
//    ② 将 node-pre-gyp 注入变量替换为字面值（node-gyp 直接编译时未定义会报
//    'Undefined variable module_name' 导致 configure 失败）
const patchGyp = (file, pairs) => {
  let source = fs.readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    if (!source.includes(from)) {
      console.warn(`[build-muhammara] gyp 未命中（跳过）: ${from.trim().slice(0, 70)}`);
      continue;
    }
    source = source.split(from).join(to);
  }
  fs.writeFileSync(file, source);
  const rest = (source.match(/openssl-build|openssl\.gyp/g) || []).length;
  console.log(`[build-muhammara] ${path.basename(file)} 残留 openssl 配置: ${rest}`);
};

const topGyp = path.join(packageDir, 'binding.gyp');
const pdfWriterGyp = path.join(packageDir, 'src', 'deps', 'PDFWriter', 'binding.gyp');
patchGyp(topGyp, [
  ["'<(module_root_dir)/openssl.gyp:openssl',\n", ''],
  ["'USE_BUNDLED=TRUE'", "'USE_BUNDLED=TRUE', 'PDFHUMMUS_NO_OPENSSL'"],
  ["'<(module_root_dir)/openssl-build/<(target_arch)/include/'\n", ''],
  ["'<(module_root_dir)/openssl-build/<(target_arch)/libcrypto.a',\n", ''],
  ["'<(module_root_dir)/openssl-build/<(target_arch)/libcrypto.a'\n", ''],
  ["'<(module_root_dir)/openssl-build/<(target_arch)/libcrypto.lib',\n", ''],
  ["'<(module_root_dir)/openssl-build/<(target_arch)/'\n", ''],
  ["'<(module_name)'", "'muhammara'"],
  ["'<(module_path)'", "'./binding'"]
]);
patchGyp(pdfWriterGyp, [
  ["'<(module_root_dir)/openssl.gyp:openssl',\n", ''],
  ["'<(module_root_dir)/openssl-build/<(target_arch)/include',\n", ''],
  ["'USE_BUNDLED=TRUE'", "'USE_BUNDLED=TRUE', 'PDFHUMMUS_NO_OPENSSL'"]
]);

// 4. 编译告警抑制：上游第三方与绑定层存在大量已知无害告警（未使用返回值/变量、
//    弃用 API、K&R 旧式函数原型、静态库归档的空目标文件等）。逐文件注入统一的
//    target_defaults 关闭它们。三个 gyp 实测约束：
//    ① target_defaults 不跨 dependencies 文件生效 → 顶层与各 src/deps/* 分别注入；
//    ② macOS 下 node-gyp 忽略 target 顶层 cflags（只认 xcode_settings），且写进
//    WARNING_CFLAGS 会排在 -Wall 之前被重新打开 → macOS 走 xcode_settings.OTHER_CFLAGS、
//    其他平台（Linux/gcc）走 cflags_c/cflags_cc，二者都拼接在编译命令的 -Wall 之后；
//    ③ 静态库归档的 libtool「has no symbols」告警（新版消息格式未被 gyp-mac-tool 的
//    过滤正则覆盖）用 libtool 自带的 -no_warning_for_no_symbols 静默，经 OTHER_LDFLAGS
//    注入；顶层 loadable_module 的最终链接走 clang（不接受该参数），仅对无链接步骤的
//    纯静态库依赖注入该旗标
const NOISE_CLANG_FLAGS = [
  '-Wno-unused-result',
  '-Wno-unused-variable',
  '-Wno-cast-function-type-mismatch',
  '-Wno-deprecated-non-prototype',
  '-Wno-deprecated-declarations',
  '-Wno-misleading-indentation',
  '-Wno-null-pointer-subtraction',
  '-Wno-sign-compare',
  '-Wno-missing-field-initializers',
  '-Wno-deprecated-copy-with-user-provided-copy',
  '-Wno-unused-const-variable',
  '-Wno-unused-but-set-variable',
  '-Wno-logical-op-parentheses',
  '-Wno-comment'
];
// gcc 不认识 clang 专属告警名（如 deprecated-non-prototype），非 mac 平台仅取共通的子集
const NOISE_GCC_FLAGS = [
  '-Wno-unused-result',
  '-Wno-unused-variable',
  '-Wno-deprecated-declarations',
  '-Wno-misleading-indentation',
  '-Wno-sign-compare',
  '-Wno-missing-field-initializers',
  '-Wno-unused-const-variable',
  '-Wno-unused-but-set-variable',
  '-Wno-comment'
];
const gypList = (flags) => flags.map((flag) => `'${flag}'`).join(', ');
const noiseTargetDefaults = (quietLibtool) => {
  const xcodeSettings = quietLibtool
    ? `{ 'OTHER_CFLAGS': [ ${gypList(NOISE_CLANG_FLAGS)} ], 'OTHER_LDFLAGS': [ '-no_warning_for_no_symbols' ] }`
    : `{ 'OTHER_CFLAGS': [ ${gypList(NOISE_CLANG_FLAGS)} ] }`;
  return [
    "    'target_defaults': {",
    "        'conditions': [",
    `            ['OS=="mac"', { 'xcode_settings': ${xcodeSettings} }],`,
    `            ['OS!="mac"', { 'cflags_c': [ ${gypList(NOISE_GCC_FLAGS)} ], 'cflags_cc': [ ${gypList(NOISE_GCC_FLAGS)} ] }]`,
    "        ]",
    "    },",
    ''
  ].join('\n');
};
const injectNoiseSuppression = (file, quietLibtool) => {
  const source = fs.readFileSync(file, 'utf8');
  const braceIndex = source.indexOf('{');
  if (braceIndex === -1 || source.slice(0, braceIndex).trim() !== '') {
    console.error(`[build-muhammara] gyp 结构异常，无法注入告警抑制: ${file}`);
    process.exit(1);
  }
  fs.writeFileSync(file, `${source.slice(0, braceIndex + 1)}\n${noiseTargetDefaults(quietLibtool)}${source.slice(braceIndex + 1)}`);
  console.log(`[build-muhammara] 已注入编译告警抑制: ${path.relative(packageDir, file)}`);
};
const depsRoot = path.join(packageDir, 'src', 'deps');
const depGypFiles = fs.readdirSync(depsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(depsRoot, entry.name, 'binding.gyp'))
  .filter((file) => fs.existsSync(file));
injectNoiseSuppression(topGyp, false);
for (const file of depGypFiles) {
  injectNoiseSuppression(file, true);
}

// 5. node-gyp 编译（target 指向项目内置 Electron 运行时）
const electronVersion = readElectronVersion();
console.log(`[build-muhammara] Electron target = ${electronVersion}, arch = ${process.arch}`);
run(
  `npx --yes node-gyp rebuild --target=${electronVersion} --arch=${process.arch} --dist-url=https://electronjs.org/headers`,
  packageDir
);

// 6. 拷贝编译产物
const built = [
  path.join(packageDir, 'binding', 'muhammara.node'),
  path.join(packageDir, 'build', 'Release', 'muhammara.node')
].find((file) => fs.existsSync(file));
if (!built) {
  console.error('[build-muhammara] 未找到编译产物 muhammara.node');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(built, path.join(outDir, 'binding.node'));
console.log(`[build-muhammara] 完成：${path.join(outDir, 'binding.node')}`);
