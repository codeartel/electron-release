/**
 * 时间机器（本地历史）原生内核的 N-API 胶水层（N-API 8 / C++17）
 *
 * 定位：全部算法位于 history_kernel.{h,cc}（跨端共享：桌面 N-API / Android JNI）；
 * 本文件只保留：
 * - 参数解析（Buffer/Uint8Array/数字）与参数类型错误（TypeError）
 * - 内核失败映射为 Error 抛出（错误信息与拆分前逐字一致；报错顺序不变）
 * - 导出面：version / patch / apply / compress / decompress / diffJson（与拆分前一致）
 *
 * 编译期 NAPI_VERSION=8；用 Node headers 编译即可，Electron/Node 双兼容。
 * libzstd / yyjson 源码经 scripts/build-history.mjs 拉取并静态编入
 * （见 deps/zstd_sources.gypi 与 deps/yyjson_sources.gypi；yyjson 为 MIT 单文件库）。
 */
#include <node_api.h>

#include <cstdint>
#include <string>
#include <vector>

#include "history_kernel.h"

namespace {

using slinote_history::kDefaultLevel;
using slinote_history::kMaxInput;
using slinote_history::kMaxOutput;

void ThrowError(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
}

void ThrowTypeError(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
}

napi_value MakeInt32(napi_env env, int32_t value) {
  napi_value out = nullptr;
  napi_create_int32(env, value, &out);
  return out;
}

napi_value MakeString(napi_env env, const char* value) {
  napi_value out = nullptr;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &out);
  return out;
}

napi_value MakeBuffer(napi_env env, const void* data, size_t len) {
  void* copied = nullptr;
  napi_value out = nullptr;
  if (napi_create_buffer_copy(env, len, data, &copied, &out) != napi_ok) {
    ThrowError(env, "napi_create_buffer_copy failed");
    return nullptr;
  }
  return out;
}

/** 读取 Buffer 参数；非 Buffer（Uint8Array 等）时按视图取字节 */
bool ArgBytes(napi_env env, napi_value value, const uint8_t** data, size_t* len) {
  bool isBuffer = false;
  napi_is_buffer(env, value, &isBuffer);
  if (isBuffer) {
    void* ptr = nullptr;
    if (napi_get_buffer_info(env, value, &ptr, len) != napi_ok) {
      return false;
    }
    *data = static_cast<const uint8_t*>(ptr);
    return true;
  }
  bool isTypedArray = false;
  napi_is_typedarray(env, value, &isTypedArray);
  if (isTypedArray) {
    napi_typedarray_type type;
    size_t length = 0;
    void* ptr = nullptr;
    napi_value arrayBuffer = nullptr;
    size_t byteOffset = 0;
    if (napi_get_typedarray_info(env, value, &type, &length, &ptr, &arrayBuffer, &byteOffset) != napi_ok) {
      return false;
    }
    if (type != napi_uint8_array && type != napi_uint8_clamped_array) {
      return false;
    }
    *data = static_cast<const uint8_t*>(ptr);
    *len = length;
    return true;
  }
  return false;
}

bool ArgLevel(napi_env env, napi_value value, int32_t* level) {
  return napi_get_value_int32(env, value, level) == napi_ok;
}

// ---------------------------------------------------------------------------
// version() -> string
// ---------------------------------------------------------------------------
napi_value Version(napi_env env, napi_callback_info info) {
  return MakeString(env, slinote_history::Version());
}

// ---------------------------------------------------------------------------
// patch(old: Buffer, next: Buffer, level?: number) -> { type: 0 } | { type: 1, data: Buffer }
// ---------------------------------------------------------------------------
napi_value Patch(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3] = {nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  if (argc < 2) {
    ThrowTypeError(env, "patch(old, next, level?) requires two byte inputs");
    return nullptr;
  }

  const uint8_t* oldData = nullptr;
  size_t oldLen = 0;
  const uint8_t* nextData = nullptr;
  size_t nextLen = 0;
  if (!ArgBytes(env, argv[0], &oldData, &oldLen) || !ArgBytes(env, argv[1], &nextData, &nextLen)) {
    ThrowTypeError(env, "patch(old, next, level?) requires Buffer/Uint8Array arguments");
    return nullptr;
  }
  // 报错顺序与拆分前一致（类型错误 → 体量上限 → 级别）；体量校验内核内亦有（JNI 侧唯一入口）
  if (static_cast<uint64_t>(oldLen) > kMaxInput || static_cast<uint64_t>(nextLen) > kMaxInput) {
    ThrowError(env, "patch input exceeds 64MB limit");
    return nullptr;
  }

  int32_t level = kDefaultLevel;
  if (argc >= 3 && !ArgLevel(env, argv[2], &level)) {
    ThrowTypeError(env, "patch level must be a number");
    return nullptr;
  }

  slinote_history::PatchResult result;
  std::string error;
  if (!slinote_history::Patch(oldData, oldLen, nextData, nextLen, level, &result, &error)) {
    ThrowError(env, error);
    return nullptr;
  }

  napi_value out = nullptr;
  napi_create_object(env, &out);
  napi_set_named_property(env, out, "type", MakeInt32(env, result.type));
  if (result.type == 1) {
    napi_value data = MakeBuffer(env, result.data.data(), result.data.size());
    if (data == nullptr) {
      return nullptr;
    }
    napi_set_named_property(env, out, "data", data);
  }
  return out;
}

// ---------------------------------------------------------------------------
// apply(base: Buffer, delta: Buffer) -> Buffer
// ---------------------------------------------------------------------------
napi_value Apply(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  if (argc < 2) {
    ThrowTypeError(env, "apply(base, delta) requires two byte inputs");
    return nullptr;
  }

  const uint8_t* baseData = nullptr;
  size_t baseLen = 0;
  const uint8_t* deltaData = nullptr;
  size_t deltaLen = 0;
  if (!ArgBytes(env, argv[0], &baseData, &baseLen) || !ArgBytes(env, argv[1], &deltaData, &deltaLen)) {
    ThrowTypeError(env, "apply(base, delta) requires Buffer/Uint8Array arguments");
    return nullptr;
  }

  std::vector<uint8_t> out;
  std::string error;
  if (!slinote_history::Apply(baseData, baseLen, deltaData, deltaLen, &out, &error)) {
    ThrowError(env, error);
    return nullptr;
  }
  return MakeBuffer(env, out.data(), out.size());
}

// ---------------------------------------------------------------------------
// compress(data: Buffer, level?: number) -> Buffer
// ---------------------------------------------------------------------------
napi_value Compress(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  const uint8_t* data = nullptr;
  size_t len = 0;
  if (argc < 1 || !ArgBytes(env, argv[0], &data, &len)) {
    ThrowTypeError(env, "compress(data, level?) requires a byte input");
    return nullptr;
  }
  // 报错顺序与拆分前一致（类型错误 → 体量上限 → 级别）
  if (static_cast<uint64_t>(len) > kMaxInput) {
    ThrowError(env, "compress input exceeds 64MB limit");
    return nullptr;
  }

  int32_t level = kDefaultLevel;
  if (argc >= 2 && !ArgLevel(env, argv[1], &level)) {
    ThrowTypeError(env, "compress level must be a number");
    return nullptr;
  }

  std::vector<uint8_t> out;
  std::string error;
  if (!slinote_history::Compress(data, len, level, &out, &error)) {
    ThrowError(env, error);
    return nullptr;
  }
  return MakeBuffer(env, out.data(), out.size());
}

// ---------------------------------------------------------------------------
// decompress(data: Buffer, maxSize?: number) -> Buffer
// ---------------------------------------------------------------------------
napi_value Decompress(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  const uint8_t* data = nullptr;
  size_t len = 0;
  if (argc < 1 || !ArgBytes(env, argv[0], &data, &len)) {
    ThrowTypeError(env, "decompress(data, maxSize?) requires a byte input");
    return nullptr;
  }

  uint64_t maxSize = kMaxOutput;
  if (argc >= 2 && argv[1] != nullptr) {
    int32_t value = 0;
    if (!ArgLevel(env, argv[1], &value) || value < 0) {
      ThrowTypeError(env, "decompress maxSize must be a non-negative number");
      return nullptr;
    }
    maxSize = static_cast<uint64_t>(value);
  }

  std::vector<uint8_t> out;
  std::string error;
  if (!slinote_history::Decompress(data, len, maxSize, &out, &error)) {
    ThrowError(env, error);
    return nullptr;
  }
  return MakeBuffer(env, out.data(), out.size());
}

// ---------------------------------------------------------------------------
// diffJson(a: Buffer, b: Buffer) -> Buffer（RFC 6902 操作序列，JSON 文本）
// ---------------------------------------------------------------------------
napi_value DiffJson(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  if (argc < 2) {
    ThrowTypeError(env, "diffJson(a, b) requires two byte inputs");
    return nullptr;
  }

  const uint8_t* aData = nullptr;
  size_t aLen = 0;
  const uint8_t* bData = nullptr;
  size_t bLen = 0;
  if (!ArgBytes(env, argv[0], &aData, &aLen) || !ArgBytes(env, argv[1], &bData, &bLen)) {
    ThrowTypeError(env, "diffJson(a, b) requires Buffer/Uint8Array arguments");
    return nullptr;
  }

  std::vector<uint8_t> out;
  std::string error;
  if (!slinote_history::DiffJson(aData, aLen, bData, bLen, &out, &error)) {
    ThrowError(env, error);
    return nullptr;
  }
  return MakeBuffer(env, out.data(), out.size());
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor desc[] = {
    {"version", nullptr, Version, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"patch", nullptr, Patch, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"apply", nullptr, Apply, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"compress", nullptr, Compress, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"decompress", nullptr, Decompress, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"diffJson", nullptr, DiffJson, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}
