/**
 * 时间机器（本地历史）跨端原生内核实现：zstd 前缀字典字节级增量 + RFC 6902 JSON 差分
 * （纯 C++17，无运行时绑定、无 IO；桌面 N-API 胶水与 Android JNI 胶水复用本文件）
 *
 * 能力：
 * - Patch(old, next, level?)   先判等、再前后缀裁剪、最后以「旧文件中段」为 zstd 前缀字典
 *   编码新文件中段；type 0 表示完全相同（不落历史），type 1 为增量载荷
 * - Apply(base, delta)         以 base 中段为前缀字典解码增量并拼回前后缀，得到新文件字节
 * - Compress / Decompress      普通 zstd 帧（快照与池载荷使用，无字典）
 * - DiffJson(a, b)             JSON 语义差分：输出 RFC 6902 操作序列（跨端公共 delta 标准，
 *   仅 add/remove/replace/move，顺序应用、就地生效）；数组对带 id 对象按 id 对齐（识别
 *   换位/增删/内容改写），其余元素按位置对角配对。上层按需调用，失败回落明文路径
 * - Version                    内嵌 libzstd 版本号（黄金向量与缓存指纹用）
 *
 * 增量载荷布局（格式 v1，四端契约）：
 *   [u32 prefixLen][u32 suffixLen][zstd 帧(字典 = old 的中段)]（全部小端）
 *
 * 说明：
 * - 单次输入上限 64MB（与 JS/Kotlin 层一致）；异常输入返回 false 并填充 error，绑定层降级
 * - libzstd / yyjson 源码静态编入：
 *   桌面见 deps/zstd_sources.gypi 与 deps/yyjson_sources.gypi（scripts/build-history.mjs 生成）
 *   Android 见 app/src/main/cpp/CMakeLists.txt（同版本源码经 scripts/sync-history-kernel.mjs 同步）
 */
#include "history_kernel.h"

#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

// 解压侧窗口上限 API（ZSTD_DCtx_setMaxWindowSize）声明在 zstd.h 的「static linking only」区；
// 本项目把 libzstd 源码静态编入产物，符合该宏的适用条件（对动态库使用方不适用）
#ifndef ZSTD_STATIC_LINKING_ONLY
#define ZSTD_STATIC_LINKING_ONLY
#endif
#include "zstd.h"
#include "yyjson.h"

namespace slinote_history {
namespace {

uint32_t ReadU32(const uint8_t* data) {
  uint32_t out = 0;
  std::memcpy(&out, data, sizeof(out));  // 小端平台（支持的全部平台）直接取
  return out;
}

void WriteU32(uint8_t* data, uint32_t value) {
  std::memcpy(data, &value, sizeof(value));
}

/** 计算覆盖输入所需的 windowLog（prefix 字典 + 目标都需要在窗口内） */
int WindowLogFor(size_t totalLen) {
  int windowLog = 10;
  while (windowLog < 27 && (1ull << windowLog) < static_cast<uint64_t>(totalLen)) {
    windowLog++;
  }
  return windowLog;
}

/** 压缩级别钳制到 [1,22]（与拆分前 JS 调用序列一致） */
int ClampLevel(int level) {
  if (level < 1) {
    return 1;
  }
  if (level > 22) {
    return 22;
  }
  return level;
}

}  // namespace

const char* Version() {
  return ZSTD_versionString();
}

bool Patch(const uint8_t* oldData, size_t oldLen,
           const uint8_t* nextData, size_t nextLen,
           int level, PatchResult* out, std::string* error) {
  if (static_cast<uint64_t>(oldLen) > kMaxInput || static_cast<uint64_t>(nextLen) > kMaxInput) {
    *error = "patch input exceeds 64MB limit";
    return false;
  }
  level = ClampLevel(level);

  // 前后缀裁剪：判等优先，其次剥离公共前后缀（纯追加/纯截断退化为 0/0）
  const size_t maxCommon = oldLen < nextLen ? oldLen : nextLen;
  size_t prefix = 0;
  while (prefix < maxCommon && oldData[prefix] == nextData[prefix]) {
    prefix++;
  }
  size_t suffix = 0;
  const size_t rest = maxCommon - prefix;
  while (suffix < rest && oldData[oldLen - 1 - suffix] == nextData[nextLen - 1 - suffix]) {
    suffix++;
  }

  if (prefix == oldLen && prefix == nextLen) {
    out->type = 0;
    out->data.clear();
    return true;
  }

  const uint8_t* oldMid = oldData + prefix;
  const size_t oldMidLen = oldLen - prefix - suffix;
  const uint8_t* nextMid = nextData + prefix;
  const size_t nextMidLen = nextLen - prefix - suffix;

  ZSTD_CCtx* cctx = ZSTD_createCCtx();
  if (cctx == nullptr) {
    *error = "zstd context allocation failed";
    return false;
  }

  const int windowLog = WindowLogFor(oldMidLen + nextMidLen);
  size_t code = 0;
  code |= ZSTD_CCtx_setParameter(cctx, ZSTD_c_compressionLevel, level);
  code |= ZSTD_CCtx_setParameter(cctx, ZSTD_c_windowLog, windowLog);
  code |= ZSTD_CCtx_setParameter(cctx, ZSTD_c_contentSizeFlag, 1);
  code |= ZSTD_CCtx_setParameter(cctx, ZSTD_c_checksumFlag, 0);
  code |= ZSTD_CCtx_setParameter(cctx, ZSTD_c_enableLongDistanceMatching, 1);
  if (oldMidLen > 0) {
    code |= ZSTD_CCtx_refPrefix(cctx, oldMid, oldMidLen);
  }
  code |= ZSTD_CCtx_setPledgedSrcSize(cctx, nextMidLen);
  if (ZSTD_isError(code)) {
    *error = std::string("zstd parameter setup failed: ") + ZSTD_getErrorName(code);
    ZSTD_freeCCtx(cctx);
    return false;
  }

  const size_t bound = ZSTD_compressBound(nextMidLen);
  std::vector<uint8_t> payload(8 + bound);
  WriteU32(payload.data(), static_cast<uint32_t>(prefix));
  WriteU32(payload.data() + 4, static_cast<uint32_t>(suffix));
  const size_t written = ZSTD_compress2(cctx, payload.data() + 8, bound, nextMid, nextMidLen);
  ZSTD_freeCCtx(cctx);
  if (ZSTD_isError(written)) {
    *error = std::string("zstd compress failed: ") + ZSTD_getErrorName(written);
    return false;
  }
  payload.resize(8 + written);

  out->type = 1;
  out->data = std::move(payload);
  return true;
}

bool Apply(const uint8_t* baseData, size_t baseLen,
           const uint8_t* deltaData, size_t deltaLen,
           std::vector<uint8_t>* out, std::string* error) {
  if (static_cast<uint64_t>(baseLen) > kMaxInput) {
    *error = "apply base exceeds 64MB limit";
    return false;
  }
  if (deltaLen < 8) {
    *error = "delta payload too short";
    return false;
  }

  const uint32_t prefix = ReadU32(deltaData);
  const uint32_t suffix = ReadU32(deltaData + 4);
  if (static_cast<uint64_t>(prefix) + suffix > baseLen) {
    *error = "delta does not match base (prefix/suffix out of range)";
    return false;
  }

  const uint8_t* oldMid = baseData + prefix;
  const size_t oldMidLen = baseLen - prefix - suffix;
  const uint8_t* frame = deltaData + 8;
  const size_t frameLen = deltaLen - 8;

  const unsigned long long frameSize = ZSTD_getFrameContentSize(frame, frameLen);
  if (frameSize == ZSTD_CONTENTSIZE_ERROR) {
    *error = "corrupt delta frame";
    return false;
  }
  if (frameSize == ZSTD_CONTENTSIZE_UNKNOWN) {
    *error = "delta frame missing content size";
    return false;
  }
  if (frameSize > kMaxOutput) {
    *error = "delta output exceeds limit";
    return false;
  }

  const uint64_t outLen = static_cast<uint64_t>(prefix) + frameSize + suffix;
  if (outLen > kMaxOutput) {
    *error = "apply output exceeds limit";
    return false;
  }

  std::vector<uint8_t> result(static_cast<size_t>(outLen));
  if (prefix > 0) {
    std::memcpy(result.data(), baseData, prefix);
  }
  if (suffix > 0) {
    std::memcpy(result.data() + prefix + frameSize, baseData + baseLen - suffix, suffix);
  }

  ZSTD_DCtx* dctx = ZSTD_createDCtx();
  if (dctx == nullptr) {
    *error = "zstd context allocation failed";
    return false;
  }
  ZSTD_DCtx_setMaxWindowSize(dctx, 1ull << 27);
  if (oldMidLen > 0) {
    ZSTD_DCtx_refPrefix(dctx, oldMid, oldMidLen);
  }
  const size_t decoded = ZSTD_decompressDCtx(dctx, result.data() + prefix, frameSize, frame, frameLen);
  ZSTD_freeDCtx(dctx);
  if (ZSTD_isError(decoded)) {
    *error = std::string("zstd decode failed: ") + ZSTD_getErrorName(decoded);
    return false;
  }
  if (decoded != frameSize) {
    *error = "zstd decode size mismatch";
    return false;
  }

  *out = std::move(result);
  return true;
}

bool Compress(const uint8_t* data, size_t len, int level,
              std::vector<uint8_t>* out, std::string* error) {
  if (static_cast<uint64_t>(len) > kMaxInput) {
    *error = "compress input exceeds 64MB limit";
    return false;
  }
  level = ClampLevel(level);

  ZSTD_CCtx* cctx = ZSTD_createCCtx();
  if (cctx == nullptr) {
    *error = "zstd context allocation failed";
    return false;
  }
  size_t code = 0;
  code |= ZSTD_CCtx_setParameter(cctx, ZSTD_c_compressionLevel, level);
  code |= ZSTD_CCtx_setParameter(cctx, ZSTD_c_contentSizeFlag, 1);
  code |= ZSTD_CCtx_setPledgedSrcSize(cctx, len);
  if (ZSTD_isError(code)) {
    *error = std::string("zstd parameter setup failed: ") + ZSTD_getErrorName(code);
    ZSTD_freeCCtx(cctx);
    return false;
  }

  const size_t bound = ZSTD_compressBound(len);
  std::vector<uint8_t> result(bound);
  const size_t written = ZSTD_compress2(cctx, result.data(), bound, data, len);
  ZSTD_freeCCtx(cctx);
  if (ZSTD_isError(written)) {
    *error = std::string("zstd compress failed: ") + ZSTD_getErrorName(written);
    return false;
  }
  result.resize(written);

  *out = std::move(result);
  return true;
}

bool Decompress(const uint8_t* data, size_t len, uint64_t maxSize,
                std::vector<uint8_t>* out, std::string* error) {
  const unsigned long long frameSize = ZSTD_getFrameContentSize(data, len);
  if (frameSize == ZSTD_CONTENTSIZE_ERROR) {
    *error = "corrupt zstd frame";
    return false;
  }
  if (frameSize == ZSTD_CONTENTSIZE_UNKNOWN) {
    *error = "zstd frame missing content size";
    return false;
  }
  if (frameSize > maxSize) {
    *error = "decompress output exceeds limit";
    return false;
  }

  std::vector<uint8_t> result(static_cast<size_t>(frameSize));
  const size_t decoded = ZSTD_decompress(result.data(), frameSize, data, len);
  if (ZSTD_isError(decoded)) {
    *error = std::string("zstd decode failed: ") + ZSTD_getErrorName(decoded);
    return false;
  }
  if (decoded != frameSize) {
    *error = "zstd decode size mismatch";
    return false;
  }

  *out = std::move(result);
  return true;
}

// ---------------------------------------------------------------------------
// JSON 语义差分（RFC 6902 操作序列）
// ---------------------------------------------------------------------------
namespace {

/** 锚定判定：对象且含 "id" 键时返回其值（数组跨版本对齐的唯一键），否则返回 nullptr */
yyjson_val* AnchorId(yyjson_val* value) {
  if (value == nullptr || !yyjson_is_obj(value)) {
    return nullptr;
  }
  return yyjson_obj_get(value, "id");
}

/** JSON 值相等：数字按 double 语义（与 JS 一致：1 与 1.0 相等），其余按结构比较 */
bool ValueEquals(yyjson_val* a, yyjson_val* b) {
  if (yyjson_is_num(a) && yyjson_is_num(b)) {
    return yyjson_get_num(a) == yyjson_get_num(b);
  }
  return yyjson_equals(a, b);
}

/** RFC 6901 路径转义：'~' -> '~0'，'/' -> '~1' */
std::string EscapePointer(const char* token, size_t len) {
  std::string out;
  out.reserve(len);
  for (size_t i = 0; i < len; i++) {
    const char ch = token[i];
    if (ch == '~') {
      out += "~0";
    } else if (ch == '/') {
      out += "~1";
    } else {
      out.push_back(ch);
    }
  }
  return out;
}

/** 数组工作元素：值引用（来自 a）+ 是否已与 b 对应（未匹配的遗留元素在清理阶段删除） */
struct DiffWorkItem {
  yyjson_val* value = nullptr;
  bool matched = false;
};

/**
 * 语义差分器：产出 RFC 6902 操作序列（仅 add/remove/replace/move，顺序应用、就地生效）
 * - 标量/类型不同：replace（数字按 double 语义判等）
 * - 对象：键对齐——a 独有 remove，b 独有 add，共有键递归
 * - 数组：带 id 对象按 id 跨版本对齐（识别换位/增删/内容改写），其余元素按位置对角配对；
 *   工作数组与「补丁顺序应用」过程同步，三阶段执行：
 *   ① 预删除：a 中「带 id 且 id 不在 b」的元素（倒序删除，路径下标始终有效）
 *   ② 主循环：j 从 0 扫 b——锚定元素找同 id 元素（错位发 move / 缺失发 add 插入）；
 *      非锚定元素与工作数组同位置未占用元素对角递归，否则发 add 挤压
 *   ③ 清理：倒序删除工作数组中仍未匹配的遗留元素
 */
class JsonDiffer {
 public:
  JsonDiffer(yyjson_val* from, yyjson_val* to) : from_(from), to_(to) {}

  /** 生成操作序列文档（成功返回 out doc 由调用方 free；失败返回 nullptr 并写 error） */
  yyjson_mut_doc* Run(std::string* error) {
    doc_ = yyjson_mut_doc_new(nullptr);
    if (doc_ == nullptr) {
      *error = "yyjson mut doc allocation failed";
      return nullptr;
    }
    ops_ = yyjson_mut_arr(doc_);
    if (ops_ == nullptr) {
      yyjson_mut_doc_free(doc_);
      doc_ = nullptr;
      *error = "yyjson mut array allocation failed";
      return nullptr;
    }
    yyjson_mut_doc_set_root(doc_, ops_);
    if (ValueEquals(from_, to_)) {
      return doc_;  // 判等：空操作序列（快速路径）
    }
    try {
      DiffValue(from_, to_, 0);
    } catch (const std::runtime_error& e) {
      yyjson_mut_doc_free(doc_);
      doc_ = nullptr;
      *error = e.what();
      return nullptr;
    }
    return doc_;
  }

 private:
  /** 未找到下标 */
  static constexpr size_t kNoIndex = static_cast<size_t>(-1);

  /** 在当前 path 下对两个值递归差分 */
  void DiffValue(yyjson_val* a, yyjson_val* b, int depth) {
    if (ValueEquals(a, b)) {
      return;
    }
    if (depth >= kMaxDiffDepth) {
      throw std::runtime_error("diffJson depth limit exceeded");
    }
    const yyjson_type type = yyjson_get_type(a);
    if (type != yyjson_get_type(b)) {
      EmitValueOp("replace", path_, b);
      return;
    }
    if (type == YYJSON_TYPE_OBJ) {
      DiffObject(a, b, depth);
    } else if (type == YYJSON_TYPE_ARR) {
      DiffArray(a, b, depth);
    } else {
      EmitValueOp("replace", path_, b);  // 标量不同
    }
  }

  /** 对象键对齐：a 独有 remove，b 独有 add，共有键递归 */
  void DiffObject(yyjson_val* a, yyjson_val* b, int depth) {
    yyjson_obj_iter iter = yyjson_obj_iter_with(a);
    yyjson_val* key = nullptr;
    while ((key = yyjson_obj_iter_next(&iter)) != nullptr) {
      yyjson_val* valueA = yyjson_obj_iter_get_val(key);
      const char* name = yyjson_get_str(key);
      const size_t nameLen = yyjson_get_len(key);
      const size_t pathLen = path_.size();
      path_.push_back('/');
      path_ += EscapePointer(name, nameLen);
      yyjson_val* valueB = yyjson_obj_getn(b, name, nameLen);
      if (valueB == nullptr) {
        EmitOp("remove", path_);
      } else {
        DiffValue(valueA, valueB, depth + 1);
      }
      path_.resize(pathLen);
    }
    yyjson_obj_iter iterB = yyjson_obj_iter_with(b);
    while ((key = yyjson_obj_iter_next(&iterB)) != nullptr) {
      const char* name = yyjson_get_str(key);
      const size_t nameLen = yyjson_get_len(key);
      if (yyjson_obj_getn(a, name, nameLen) == nullptr) {
        const size_t pathLen = path_.size();
        path_.push_back('/');
        path_ += EscapePointer(name, nameLen);
        EmitValueOp("add", path_, yyjson_obj_iter_get_val(key));
        path_.resize(pathLen);
      }
    }
  }

  /** 数组对齐：id 锚定元素跨版本匹配 + 非锚定元素位置对角配对（三阶段） */
  void DiffArray(yyjson_val* a, yyjson_val* b, int depth) {
    // 工作数组：模拟「补丁顺序应用」过程中的实际数组状态（值引用指向 a 的元素）
    std::vector<DiffWorkItem> work;
    const size_t aLen = yyjson_arr_size(a);
    work.reserve(aLen);
    yyjson_arr_iter iterA = yyjson_arr_iter_with(a);
    yyjson_val* item = nullptr;
    while ((item = yyjson_arr_iter_next(&iterA)) != nullptr) {
      work.push_back(DiffWorkItem{item, false});
    }

    // 阶段 ①：预删除——a 中「带 id 且 id 不在 b」的元素
    for (size_t i = aLen; i-- > 0;) {
      yyjson_val* id = AnchorId(work[i].value);
      if (id != nullptr && !ArrayContainsAnchor(b, id)) {
        EmitOp("remove", ChildPath(i));
        work.erase(work.begin() + static_cast<std::ptrdiff_t>(i));
      }
    }

    // 对工作位置 index 与 b 的当前元素做内容递归
    auto diffAt = [&](size_t index, yyjson_val* next) {
      const size_t pathLen = path_.size();
      path_.push_back('/');
      path_ += std::to_string(index);
      DiffValue(work[index].value, next, depth + 1);
      path_.resize(pathLen);
    };

    // 阶段 ②：主循环——逐个位置把工作数组对齐到 b
    yyjson_arr_iter iterB = yyjson_arr_iter_with(b);
    size_t j = 0;
    while ((item = yyjson_arr_iter_next(&iterB)) != nullptr) {
      yyjson_val* id = AnchorId(item);
      if (id != nullptr) {
        const size_t p = FindAnchor(work, id);
        if (p == kNoIndex) {
          // b 新增锚定元素：插入到位置 j
          EmitValueOp("add", ChildPath(j), item);
          work.insert(work.begin() + static_cast<std::ptrdiff_t>(j), DiffWorkItem{item, true});
        } else {
          if (p != j) {
            // 换位：RFC 6902 move（from/to 为「移除 from 后」的位置语义，与工作数组一致）
            EmitMove(p, j);
            const DiffWorkItem moved = work[p];
            work.erase(work.begin() + static_cast<std::ptrdiff_t>(p));
            work.insert(work.begin() + static_cast<std::ptrdiff_t>(j), moved);
          }
          diffAt(j, item);
          work[j].matched = true;
        }
      } else if (j < work.size() && !work[j].matched && AnchorId(work[j].value) == nullptr) {
        // 非锚定元素：与同位置未占用元素对角配对（裸字符串等的局部改写）
        diffAt(j, item);
        work[j].matched = true;
      } else {
        // 新增或错位挤压：插入到位置 j，工作数组同步插入已匹配元素
        EmitValueOp("add", ChildPath(j), item);
        work.insert(work.begin() + static_cast<std::ptrdiff_t>(j), DiffWorkItem{item, true});
      }
      j++;
    }

    // 阶段 ③：清理——倒序删除工作数组中仍未匹配的遗留元素
    for (size_t i = work.size(); i-- > 0;) {
      if (!work[i].matched) {
        EmitOp("remove", ChildPath(i));
      }
    }
  }

  /** 在 b 中查找是否存在 id 相同的锚定元素（预删除用） */
  static bool ArrayContainsAnchor(yyjson_val* array, yyjson_val* id) {
    yyjson_arr_iter iter = yyjson_arr_iter_with(array);
    yyjson_val* item = nullptr;
    while ((item = yyjson_arr_iter_next(&iter)) != nullptr) {
      yyjson_val* candidate = AnchorId(item);
      if (candidate != nullptr && ValueEquals(candidate, id)) {
        return true;
      }
    }
    return false;
  }

  /** 在工作数组中查找 id 相同且尚未匹配的元素（主循环用） */
  static size_t FindAnchor(const std::vector<DiffWorkItem>& work, yyjson_val* id) {
    for (size_t i = 0; i < work.size(); i++) {
      if (work[i].matched) {
        continue;
      }
      yyjson_val* candidate = AnchorId(work[i].value);
      if (candidate != nullptr && ValueEquals(candidate, id)) {
        return i;
      }
    }
    return kNoIndex;
  }

  /** 当前 path + '/' + 数组下标 */
  std::string ChildPath(size_t index) const {
    std::string out = path_;
    out.push_back('/');
    out += std::to_string(index);
    return out;
  }

  void EmitOp(const char* op, const std::string& path) {
    // 注 1：yyjson 0.10 的 mut 修改类 API 返回 bool（非节点指针），仅分配异常时为 false
    // 注 2：add_str 不拷贝字符串（借用语义），path 等局部/复用缓冲区必须用 strncpy 变体
    yyjson_mut_val* entry = yyjson_mut_obj(doc_);
    if (entry == nullptr ||
        !yyjson_mut_obj_add_str(doc_, entry, "op", op) ||
        !yyjson_mut_obj_add_strncpy(doc_, entry, "path", path.c_str(), path.size()) ||
        !yyjson_mut_arr_append(ops_, entry)) {
      throw std::runtime_error("yyjson output allocation failed");
    }
  }

  void EmitValueOp(const char* op, const std::string& path, yyjson_val* value) {
    yyjson_mut_val* entry = yyjson_mut_obj(doc_);
    yyjson_mut_val* copied = yyjson_val_mut_copy(doc_, value);
    if (entry == nullptr || copied == nullptr ||
        !yyjson_mut_obj_add_str(doc_, entry, "op", op) ||
        !yyjson_mut_obj_add_strncpy(doc_, entry, "path", path.c_str(), path.size()) ||
        !yyjson_mut_obj_add_val(doc_, entry, "value", copied) ||
        !yyjson_mut_arr_append(ops_, entry)) {
      throw std::runtime_error("yyjson output allocation failed");
    }
  }

  /** RFC 6902 move：from/path 为「移除 from 后」的位置语义（与工作数组模型一致） */
  void EmitMove(size_t from, size_t to) {
    const std::string fromPath = ChildPath(from);
    const std::string toPath = ChildPath(to);
    yyjson_mut_val* entry = yyjson_mut_obj(doc_);
    if (entry == nullptr ||
        !yyjson_mut_obj_add_str(doc_, entry, "op", "move") ||
        !yyjson_mut_obj_add_strncpy(doc_, entry, "from", fromPath.c_str(), fromPath.size()) ||
        !yyjson_mut_obj_add_strncpy(doc_, entry, "path", toPath.c_str(), toPath.size()) ||
        !yyjson_mut_arr_append(ops_, entry)) {
      throw std::runtime_error("yyjson output allocation failed");
    }
  }

  /** 当前 JSON Pointer 路径（拼接/回退式复用，避免每层字符串拷贝） */
  std::string path_;
  yyjson_mut_doc* doc_ = nullptr;
  yyjson_mut_val* ops_ = nullptr;
  yyjson_val* from_ = nullptr;
  yyjson_val* to_ = nullptr;
};

}  // namespace

bool DiffJson(const uint8_t* aData, size_t aLen,
              const uint8_t* bData, size_t bLen,
              std::vector<uint8_t>* out, std::string* error) {
  if (static_cast<uint64_t>(aLen) > kMaxInput || static_cast<uint64_t>(bLen) > kMaxInput) {
    *error = "diffJson input exceeds 64MB limit";
    return false;
  }

  // yyjson_read_opts 在非 INSITU 模式下不写输入内容，const 转换安全
  yyjson_read_err readErr;
  yyjson_doc* aDoc = yyjson_read_opts(
      const_cast<char*>(reinterpret_cast<const char*>(aData)), aLen, YYJSON_READ_NOFLAG, nullptr, &readErr);
  if (aDoc == nullptr) {
    *error = std::string("diffJson parse old payload failed: ") + (readErr.msg != nullptr ? readErr.msg : "unknown");
    return false;
  }
  yyjson_doc* bDoc = yyjson_read_opts(
      const_cast<char*>(reinterpret_cast<const char*>(bData)), bLen, YYJSON_READ_NOFLAG, nullptr, &readErr);
  if (bDoc == nullptr) {
    *error = std::string("diffJson parse new payload failed: ") + (readErr.msg != nullptr ? readErr.msg : "unknown");
    yyjson_doc_free(aDoc);
    return false;
  }

  std::string diffError;
  JsonDiffer differ(yyjson_doc_get_root(aDoc), yyjson_doc_get_root(bDoc));
  yyjson_mut_doc* doc = differ.Run(&diffError);
  yyjson_doc_free(aDoc);
  yyjson_doc_free(bDoc);
  if (doc == nullptr) {
    *error = "diffJson failed: " + diffError;
    return false;
  }

  size_t jsonLen = 0;
  yyjson_write_err writeErr;
  char* json = yyjson_mut_write_opts(doc, YYJSON_WRITE_NOFLAG, nullptr, &jsonLen, &writeErr);
  if (json == nullptr) {
    yyjson_mut_doc_free(doc);
    *error = std::string("diffJson serialize failed: ") + (writeErr.msg != nullptr ? writeErr.msg : "unknown");
    return false;
  }
  yyjson_mut_doc_free(doc);
  out->assign(reinterpret_cast<uint8_t*>(json), reinterpret_cast<uint8_t*>(json) + jsonLen);
  free(json);
  return true;
}

}  // namespace slinote_history
