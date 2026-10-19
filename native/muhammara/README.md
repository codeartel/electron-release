# native/muhammara

主进程 PDF 合并与大纲写入所使用的 muhammara 原生运行时（仅保留编译产物）。

## 内容

- `binding.node`：muhammara 7.0.0-beta.1（@muhammara/native-with-source）针对项目 Electron 在
  本平台编译的原生绑定（已裁剪 OpenSSL：定义 PDFHUMMUS_NO_OPENSSL 且不链接 libcrypto，体积约
  为完整版的 43%；V8 兼容由上游内建条件编译，无需补丁），由主进程 `pdf-worker` 子进程加载。
- 配套 JS 层在 `src/pdf-native.ts`（自研精简加载器：事件补丁 + PDFRStreamForFile），
  不依赖 @muhammara/native-core 及其 JS 依赖。

## 重新构建

Electron 大版本升级（ABI 变化）或切换发布平台后，需要在对应平台执行：

```bash
node scripts/build-muhammara.mjs
```

脚本自动完成：下载源码 → gyp 改造（裁剪 OpenSSL、注入编译告警抑制）→ 按项目 Electron 版本 node-gyp 编译 → 覆盖 `binding.node`。

`binding.node` 不入库（见 .gitignore）：开发机首次 clone 或 Electron 大版本升级后需执行一次；
CI 打包由各平台 job 自行编译（见下）。

## 能力边界

裁剪 OpenSSL 后，PDF 2.0 / AES-256 加密与 AESV3 解密不可用（业务未使用）；
RC4 / AES-128（PDF 1.4–1.7）由内置 LibAesgm 实现，合并与大纲功能不受影响。

## 打包

`package.json` 的 build.files 只包含 `native/**/binding.node`（及静态链接依赖的 LICENSE），
且 `asarUnpack` 将 `native/**` 解包，保证运行时可通过文件路径加载 `.node`（签名公证不受
asar 内可执行文件影响）。编译输入（`binding.gyp`、`src/`、`deps/`）与 `build/` 中间产物不入包。

GitHub Actions 各平台 job（.github/workflows/build-*.yml）在 `npm ci` 后执行
`scripts/build-native.mjs`（缓存闸门）：指纹命中直接跳过，未命中时调用
`scripts/build-muhammara.mjs` 现场编译，runner 架构与目标包一致
（macos-latest=arm64、macos-15-intel=x64、ubuntu-latest=x64、ubuntu-24.04-arm=arm64），
无需把二进制提交进仓库。

编译产物由 `actions/cache` 缓存（key 含平台/架构/Electron 版本/muhammara 版本/脚本 hash），
命中时跳过编译；编译成功后立即保存缓存（restore/save 分离，后续打包/签名失败不丢缓存），
Electron 或 muhammara 升级、编译脚本变更后 key 变化会自动失效重编。
