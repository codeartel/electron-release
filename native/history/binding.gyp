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
        "_CRT_SECURE_NO_WARNINGS"
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
        } ]
      ]
    }
  ]
}
