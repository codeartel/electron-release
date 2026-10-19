{
  "targets": [
    {
      "target_name": "history",
      "sources": [
        "src/history_kernel.cc",
        "src/history.cc"
      ],
      "includes": [
        "deps/zstd_sources.gypi",
        "deps/yyjson_sources.gypi"
      ],
      "defines": [
        "NAPI_VERSION=8",
        "_CRT_SECURE_NO_WARNINGS",
        # zstd 在 x86_64 默认引用 HUF 解码汇编（huf_decompress_amd64.S），而汇编文件不在
        # gyp 源清单内，mac/linux x64 链接会报 fixup error；关闭后走等价的 C fast loop
        # （仍按 BMI2 编译），压缩格式与解压结果逐字节不变
        "ZSTD_DISABLE_ASM"
      ],
      "cflags_cc": [ "-std=c++17" ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": [ "/std:c++17", "/EHsc", "/utf-8" ]
        }
      },
      "conditions": [
        [ "OS=='mac' or OS=='linux'", {
          "cflags": [ "-fvisibility=hidden" ],
          "xcode_settings": {
            "OTHER_CFLAGS": [ "-fvisibility=hidden" ]
          }
        } ],
        # Linux：Node 的 common.gypi 默认给 cflags_cc 注入 -fno-exceptions，
        # 而 kernel 用 std::runtime_error 上报 diff 深度/分配失败，必须显式打开异常
        # （mac 由 GCC_ENABLE_CPP_EXCEPTIONS 打开，Windows 由 /EHsc 打开）
        [ "OS=='linux'", {
          "cflags_cc!": [ "-fno-exceptions" ],
          "cflags_cc": [ "-fexceptions" ]
        } ]
      ]
    }
  ]
}
