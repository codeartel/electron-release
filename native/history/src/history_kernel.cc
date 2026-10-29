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

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
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

/** 锚定值且 id 在 skip 里：比较时视为「已剔除」，不参与差异 */
bool SkippedAnchor(yyjson_val* value, const std::unordered_set<std::string>& skip) {
  if (value == nullptr || !yyjson_is_obj(value)) {
    return false;
  }
  yyjson_val* id = yyjson_obj_getn(value, "id", 2);
  if (id == nullptr || !yyjson_is_str(id)) {
    return false;
  }
  return skip.count(std::string(yyjson_get_str(id), yyjson_get_len(id))) > 0;
}

bool ArrayEqualsIgnoring(yyjson_val* a, yyjson_val* b, const std::unordered_set<std::string>& skip);

/**
 * 剔除 skip 里的锚定子孙后比较两棵子树：用于判断「本地除了被远端搬走的那些节点之外，
 * 有没有改过别的内容」。相等才敢跟着远端删除，否则仍按真冲突保留本地版。
 */
bool SubtreeEqualsIgnoring(yyjson_val* a, yyjson_val* b, const std::unordered_set<std::string>& skip) {
  if (a == nullptr || b == nullptr) {
    return a == b;
  }
  const bool skipA = SkippedAnchor(a, skip);
  const bool skipB = SkippedAnchor(b, skip);
  if (skipA || skipB) {
    return skipA && skipB;
  }
  if (yyjson_is_obj(a) && yyjson_is_obj(b)) {
    if (yyjson_obj_size(a) != yyjson_obj_size(b)) {
      return false;
    }
    yyjson_obj_iter iter = yyjson_obj_iter_with(a);
    yyjson_val* key = nullptr;
    while ((key = yyjson_obj_iter_next(&iter)) != nullptr) {
      const char* name = yyjson_get_str(key);
      const size_t nameLen = yyjson_get_len(key);
      yyjson_val* other = yyjson_obj_getn(b, name, nameLen);
      if (other == nullptr) {
        return false;
      }
      yyjson_val* value = yyjson_obj_iter_get_val(key);
      if (nameLen == 8 && std::memcmp(name, "children", 8) == 0) {
        if (!ArrayEqualsIgnoring(value, other, skip)) {
          return false;
        }
        continue;
      }
      if (!ValueEquals(value, other)) {
        return false;
      }
    }
    return true;
  }
  if (yyjson_is_arr(a) && yyjson_is_arr(b)) {
    return ArrayEqualsIgnoring(a, b, skip);
  }
  return ValueEquals(a, b);
}

/** 数组语义比较：先剔除 skip 锚定项，再按序递归 */
bool ArrayEqualsIgnoring(yyjson_val* a, yyjson_val* b, const std::unordered_set<std::string>& skip) {
  std::vector<yyjson_val*> left;
  std::vector<yyjson_val*> right;
  yyjson_arr_iter iterA = yyjson_arr_iter_with(a);
  yyjson_val* itemA = nullptr;
  while ((itemA = yyjson_arr_iter_next(&iterA)) != nullptr) {
    if (!SkippedAnchor(itemA, skip)) {
      left.push_back(itemA);
    }
  }
  yyjson_arr_iter iterB = yyjson_arr_iter_with(b);
  yyjson_val* itemB = nullptr;
  while ((itemB = yyjson_arr_iter_next(&iterB)) != nullptr) {
    if (!SkippedAnchor(itemB, skip)) {
      right.push_back(itemB);
    }
  }
  if (left.size() != right.size()) {
    return false;
  }
  for (size_t i = 0; i < left.size(); i++) {
    if (!SubtreeEqualsIgnoring(left[i], right[i], skip)) {
      return false;
    }
  }
  return true;
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

// ---------------------------------------------------------------------------
// 编辑器文档树三方合并（同步冲突预合并）：文本侧
// ---------------------------------------------------------------------------
namespace {

/** 编辑块起始下标哨兵 */
constexpr size_t kNoEdit = static_cast<size_t>(-1);
/** 相邻编辑块之间公共文本短于该长度时合并为一块（与前端 diff_cleanupSemantic 同向） */
constexpr size_t kMergeTextGap = 4;

/** 字符起点表：每个 UTF-8 字符的起始字节偏移，末尾追加 size() 作为哨兵 */
std::vector<size_t> Utf8Offsets(const std::string& text) {
  std::vector<size_t> offsets;
  offsets.reserve(text.size() / 2 + 2);
  for (size_t i = 0; i < text.size(); i++) {
    if ((static_cast<unsigned char>(text[i]) & 0xC0) != 0x80) {
      offsets.push_back(i);
    }
  }
  offsets.push_back(text.size());
  return offsets;
}

/** 按字符下标取原文切片（边界均为字符起点，不会截断多字节序列） */
std::string SliceChars(const std::string& text, const std::vector<size_t>& offsets, size_t from, size_t to) {
  const size_t count = offsets.size() - 1;
  if (from >= to || to > count) {
    return std::string();
  }
  return text.substr(offsets[from], offsets[to] - offsets[from]);
}

/** 单字符相等（先比字节长度再 memcmp） */
bool CharEqual(const std::string& a, const std::vector<size_t>& aOff, size_t ai,
               const std::string& b, const std::vector<size_t>& bOff, size_t bi) {
  const size_t aLen = aOff[ai + 1] - aOff[ai];
  const size_t bLen = bOff[bi + 1] - bOff[bi];
  if (aLen != bLen) {
    return false;
  }
  return std::memcmp(a.data() + aOff[ai], b.data() + bOff[bi], aLen) == 0;
}

/** 单侧编辑块：base 字符区间 [baseStart, baseEnd) 对应 side 字符区间 [sideStart, sideEnd) */
struct TextEdit {
  size_t baseStart = 0;
  size_t baseEnd = 0;
  size_t sideStart = 0;
  size_t sideEnd = 0;
};

/**
 * 计算 base→side 的编辑块（按 base 升序、互不重叠）：先裁公共前后缀，再对中段做
 * LCS 动态规划回溯；中段超过 kMaxMergeTextChars 时返回 false（调用方按整段冲突处理）。
 */
bool TextEdits(const std::string& base, const std::vector<size_t>& baseOff,
               const std::string& side, const std::vector<size_t>& sideOff,
               std::vector<TextEdit>* edits) {
  const size_t n = baseOff.size() - 1;
  const size_t m = sideOff.size() - 1;

  size_t prefix = 0;
  while (prefix < n && prefix < m && CharEqual(base, baseOff, prefix, side, sideOff, prefix)) {
    prefix++;
  }
  size_t suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix &&
         CharEqual(base, baseOff, n - 1 - suffix, side, sideOff, m - 1 - suffix)) {
    suffix++;
  }

  const size_t bn = n - prefix - suffix;
  const size_t sm = m - prefix - suffix;
  if (bn > kMaxMergeTextChars || sm > kMaxMergeTextChars) {
    return false;
  }

  // dp[i][j]：base[prefix+i..) 与 side[prefix+j..) 的最长公共子序列长度（uint16 足够）
  const size_t row = sm + 1;
  std::vector<uint16_t> dp((bn + 1) * row, 0);
  for (size_t i = bn; i-- > 0;) {
    for (size_t j = sm; j-- > 0;) {
      if (CharEqual(base, baseOff, prefix + i, side, sideOff, prefix + j)) {
        dp[i * row + j] = static_cast<uint16_t>(dp[(i + 1) * row + j + 1] + 1);
      } else {
        const uint16_t down = dp[(i + 1) * row + j];
        const uint16_t right = dp[i * row + j + 1];
        dp[i * row + j] = down > right ? down : right;
      }
    }
  }

  size_t i = 0;
  size_t j = 0;
  size_t editBase = kNoEdit;
  size_t editSide = kNoEdit;
  const auto flush = [&](size_t baseEnd, size_t sideEnd) {
    if (editBase == kNoEdit) {
      return;
    }
    edits->push_back(TextEdit{prefix + editBase, prefix + baseEnd, prefix + editSide, prefix + sideEnd});
    editBase = kNoEdit;
    editSide = kNoEdit;
  };

  while (i < bn && j < sm) {
    if (CharEqual(base, baseOff, prefix + i, side, sideOff, prefix + j) &&
        dp[i * row + j] == dp[(i + 1) * row + j + 1] + 1) {
      flush(i, j);
      i++;
      j++;
      continue;
    }
    if (editBase == kNoEdit) {
      editBase = i;
      editSide = j;
    }
    if (dp[(i + 1) * row + j] >= dp[i * row + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  if (i < bn || j < sm) {
    if (editBase == kNoEdit) {
      editBase = i;
      editSide = j;
    }
  }
  flush(bn, sm);

  // 字符级 LCS 会切出碎片编辑；两侧碎片交替落位会拼出乱序文本，
  // 因此把中间公共段过短的相邻编辑块合并成一块（冲突方保守：宁可整段要点选）
  if (edits->size() > 1) {
    std::vector<TextEdit> coalesced;
    coalesced.reserve(edits->size());
    for (size_t k = 0; k < edits->size(); k++) {
      if (!coalesced.empty() && (*edits)[k].baseStart - coalesced.back().baseEnd < kMergeTextGap) {
        coalesced.back().baseEnd = (*edits)[k].baseEnd;
        coalesced.back().sideEnd = (*edits)[k].sideEnd;
        continue;
      }
      coalesced.push_back((*edits)[k]);
    }
    *edits = std::move(coalesced);
  }
  return true;
}

/** 文本三方合并结果：merged 为合并文本，conflict 时两侧给出冲突段原文 */
struct TextMergeResult {
  std::string merged;
  bool conflict = false;
  std::string localConflict;
  std::string remoteConflict;
};

/**
 * 三路文本合并（diff3）：两侧编辑块不重叠则全部保留；重叠取远端并回填冲突段。
 * 返回 false 表示无法三方合并（文本过长或重叠超过一处），调用方按整段冲突处理。
 */
bool MergeText3(const std::string& base, const std::string& local, const std::string& remote,
                TextMergeResult* out) {
  const std::vector<size_t> baseOff = Utf8Offsets(base);
  const std::vector<size_t> localOff = Utf8Offsets(local);
  const std::vector<size_t> remoteOff = Utf8Offsets(remote);
  std::vector<TextEdit> localEdits;
  std::vector<TextEdit> remoteEdits;
  if (!TextEdits(base, baseOff, local, localOff, &localEdits)) {
    return false;
  }
  if (!TextEdits(base, baseOff, remote, remoteOff, &remoteEdits)) {
    return false;
  }

  const size_t n = baseOff.size() - 1;
  size_t bpos = 0;
  size_t li = 0;
  size_t ri = 0;
  int conflicts = 0;
  out->merged.clear();
  out->localConflict.clear();
  out->remoteConflict.clear();

  while (bpos < n || li < localEdits.size() || ri < remoteEdits.size()) {
    const size_t lNext = li < localEdits.size() ? localEdits[li].baseStart : n;
    const size_t rNext = ri < remoteEdits.size() ? remoteEdits[ri].baseStart : n;
    const size_t next = lNext < rNext ? lNext : rNext;
    if (next > bpos) {
      out->merged.append(SliceChars(base, baseOff, bpos, next));
      bpos = next;
      continue;
    }

    const bool lHas = li < localEdits.size() && localEdits[li].baseStart == bpos;
    const bool rHas = ri < remoteEdits.size() && remoteEdits[ri].baseStart == bpos;
    if (lHas && rHas) {
      const TextEdit& le = localEdits[li];
      const TextEdit& re = remoteEdits[ri];
      const std::string lText = SliceChars(local, localOff, le.sideStart, le.sideEnd);
      const std::string rText = SliceChars(remote, remoteOff, re.sideStart, re.sideEnd);
      li++;
      ri++;
      // 两侧替换成同一内容：等价于单侧改动，不算冲突
      if (le.baseEnd == re.baseEnd && lText == rText) {
        out->merged.append(rText);
        bpos = le.baseEnd;
        continue;
      }
      if (conflicts++ > 0) {
        return false;  // 多处重叠：交给上层整段判冲突
      }
      out->merged.append(rText);
      out->localConflict = lText;
      out->remoteConflict = rText;
      bpos = le.baseEnd > re.baseEnd ? le.baseEnd : re.baseEnd;
      continue;
    }
    if (lHas) {
      const TextEdit le = localEdits[li++];
      out->merged.append(SliceChars(local, localOff, le.sideStart, le.sideEnd));
      bpos = le.baseEnd;
      continue;
    }
    const TextEdit re = remoteEdits[ri++];
    out->merged.append(SliceChars(remote, remoteOff, re.sideStart, re.sideEnd));
    bpos = re.baseEnd;
  }

  out->conflict = conflicts > 0;
  return true;
}

}  // namespace

// ---------------------------------------------------------------------------
// 编辑器文档树三方合并（同步冲突预合并）：节点侧
// ---------------------------------------------------------------------------
namespace {

/**
 * 子节点引用：锚定节点用 id 作键；文本段按「前一个锚点 + 段内序号」作键。
 * key 在本层唯一（同 id 的兄弟追加出现序号），id 保留裸身份，供冲突描述符的 id/anchor 使用。
 */
struct ChildRef {
  yyjson_val* value = nullptr;
  bool anchored = false;
  std::string key;
  std::string id;
};

/** 取节点 id（根字段 id 优先，兼容 props.id）；非对象或无字符串 id 返回空串 */
std::string NodeIdOf(yyjson_val* value) {
  if (value == nullptr || !yyjson_is_obj(value)) {
    return std::string();
  }
  yyjson_val* id = yyjson_obj_getn(value, "id", 2);
  if (id == nullptr) {
    yyjson_val* props = yyjson_obj_getn(value, "props", 5);
    if (props != nullptr && yyjson_is_obj(props)) {
      id = yyjson_obj_getn(props, "id", 2);
    }
  }
  if (id == nullptr || !yyjson_is_str(id)) {
    return std::string();
  }
  return std::string(yyjson_get_str(id), yyjson_get_len(id));
}

/** 展开子数组为引用序列：锚定节点续段，文本段按段内序号编号（同一锚点下顺序对齐） */
void CollectChildren(yyjson_val* array, std::vector<ChildRef>* out,
                     std::unordered_map<std::string, size_t>* idCounts = nullptr) {
  out->clear();
  if (idCounts != nullptr) {
    idCounts->clear();
  }
  if (array == nullptr || !yyjson_is_arr(array)) {
    return;
  }
  /**
   * anchor 记「最近一个锚定节点的本层唯一键」，ordinal 记它之后的文本段序号；
   * occ 记同层同 id 的出现次数。props.id 是节点属性（标题 id / 引用 id），同层允许重复
   * ——两个引用块指向同一标题时 id 相同——键里不带出现序号会让 IndexRefs 把两个兄弟
   * 错配成同一个，后一个的改动被前一个的合并结果覆盖且不报冲突。
   */
  std::string anchor;
  size_t ordinal = 0;
  std::unordered_map<std::string, size_t> occ;
  yyjson_arr_iter iter = yyjson_arr_iter_with(array);
  yyjson_val* item = nullptr;
  while ((item = yyjson_arr_iter_next(&iter)) != nullptr) {
    const std::string id = NodeIdOf(item);
    if (!id.empty()) {
      const size_t seq = occ[id]++;
      std::string key = "n" + id + "#" + std::to_string(seq);
      out->push_back(ChildRef{item, true, std::move(key), id});
      anchor = out->back().key.substr(1);  // 唯一键（id#seq），保证文本段键也不撞
      ordinal = 0;
      continue;
    }
    out->push_back(ChildRef{item, false, "t" + anchor + "#" + std::to_string(ordinal), std::string()});
    ordinal++;
  }
  if (idCounts != nullptr) {
    *idCounts = std::move(occ);
  }
}

/**
 * 同层重复身份（props.id 相同的引用块等）用「出现序号」做键，只能在三侧数量对齐时配对：
 * 一侧删掉或插入一个同身份兄弟，后续节点的序号会整体前移/后移而配对到错的人 —— 先出现
 * 那一个兄弟的合并结果会覆盖掉后一个的改动，且不报任何冲突（静默丢改动）。
 * 三侧非零计数不一致的 id 收进 out：这些 id 的配对不可信，MergeChildren 对其一律不自动
 * 归并内容，改落 replace 描述符交前端裁决 —— 单页脏数据不再让整份合并回落两方 diff。
 */
void CollectUnstableIdentities(const std::unordered_map<std::string, size_t>& baseIds,
                               const std::unordered_map<std::string, size_t>& localIds,
                               const std::unordered_map<std::string, size_t>& remoteIds,
                               std::unordered_set<std::string>* out) {
  out->clear();
  const auto countOf = [](const std::unordered_map<std::string, size_t>& counts,
                          const std::string& id) -> size_t {
    const auto it = counts.find(id);
    return it == counts.end() ? 0 : it->second;
  };
  std::unordered_set<std::string> visited;
  const auto unstable = [&](const std::string& id) {
    if (!visited.insert(id).second) {
      return;
    }
    const size_t counts[3] = {countOf(baseIds, id), countOf(localIds, id), countOf(remoteIds, id)};
    size_t first = 0;
    for (int i = 0; i < 3; i++) {
      if (counts[i] == 0) {
        continue;
      }
      if (first == 0) {
        first = counts[i];
        continue;
      }
      if (counts[i] != first) {
        out->insert(id);
        return;
      }
    }
  };
  for (const auto& entry : baseIds) {
    unstable(entry.first);
  }
  for (const auto& entry : localIds) {
    unstable(entry.first);
  }
  for (const auto& entry : remoteIds) {
    unstable(entry.first);
  }
}

/** 建键索引（同键取首个，保持确定性） */
void IndexRefs(const std::vector<ChildRef>& refs, std::unordered_map<std::string, size_t>* out) {
  out->clear();
  for (size_t i = 0; i < refs.size(); i++) {
    out->emplace(refs[i].key, i);
  }
}

/** 取字符串值（非字符串按空串） */
std::string StringOf(yyjson_val* value) {
  if (value == nullptr || !yyjson_is_str(value)) {
    return std::string();
  }
  return std::string(yyjson_get_str(value), yyjson_get_len(value));
}

/** 数据根节点 id（文本冲突描述符的 parent）：base 优先，缺失时回退 local */
std::string RootIdOf(yyjson_val* base, yyjson_val* local) {
  std::string id = NodeIdOf(base);
  if (id.empty()) {
    id = NodeIdOf(local);
  }
  return id;
}

/**
 * 三方合并器：把 base/local/remote 归并为内容树，并把剩余真冲突写成描述符。
 * 冲突统一「合并结果放远端值、描述符 local 字段放本地值」，与前端四类原语语义对齐；
 * 节点内出现键级冲突时整节点回退为远端值（不产出半合并的混合态）。
 * 同层重复身份的数量在三侧漂移时只降级该 id 的配对（落 replace），不让整份合并失败。
 */
class EditorMerger {
 public:
  bool failed() const { return failed_; }
  bool internal() const { return internal_; }
  const std::string& reason() const { return reason_; }
  int autoMerged() const { return autoMerged_; }

  /** 执行合并；成功返回结果文档（root = {ok,data,conflicts,auto}），失败返回 nullptr */
  yyjson_mut_doc* Run(yyjson_val* base, yyjson_val* local, yyjson_val* remote) {
    doc_ = yyjson_mut_doc_new(nullptr);
    if (doc_ == nullptr) {
      FailInternal();
      return nullptr;
    }
    conflicts_ = yyjson_mut_arr(doc_);
    if (conflicts_ == nullptr) {
      FailInternal();
      yyjson_mut_doc_free(doc_);
      doc_ = nullptr;
      return nullptr;
    }
    std::unordered_map<std::string, int> remoteAllIds;
    CountInputIds(remote, &remoteAllIds);
    remoteTreeIds_.reserve(remoteAllIds.size());
    for (const auto& entry : remoteAllIds) {
      remoteTreeIds_.insert(entry.first);
    }
    yyjson_mut_val* data = MergeNode(base, local, remote, 0, RootIdOf(base, local), false);
    if (data == nullptr) {
      yyjson_mut_doc_free(doc_);
      doc_ = nullptr;
      return nullptr;
    }
    /**
     * 防御：同一 node.id 在结果里出现得比任何一侧都多，只可能来自「一边删、另一边加」的
     * 跨父节点移动 —— 描述符协议只有 id/parent/anchor，表达不了「移动」，硬合并会在两个
     * 父节点下各留一份同 id 节点（前端按 id 建全局索引，必然错配到错的那份）。
     * 这里判不可表达，交回两方 diff 人工裁决，不落盘错数据。
     */
    if (HasDuplicatedNodeId(data, local, remote)) {
      Fail("dup-id");
      yyjson_mut_doc_free(doc_);
      doc_ = nullptr;
      return nullptr;
    }
    /**
     * 契约自检：add 描述符的语义是「结果里没有该节点，前端按 parent/anchor 插回」。
     * 若同一个 node.id 已在结果里（同层重复身份键 + 前方插入会把原节点错配成新增），
     * 前端会再插一份同 id 节点。这类键位错配交给人工，不落盘自相矛盾的结果。
     */
    if (HasAddOverlapWithData(data)) {
      Fail("dup-id");
      yyjson_mut_doc_free(doc_);
      doc_ = nullptr;
      return nullptr;
    }
    /**
     * 可定位性自检：前端按 id 在整棵树里建「首个命中」索引（indexConflictNodes），再用
     * parent/anchor 反查位置。同一身份在结果树里出现多次时（引用块的 props.id 撞上被引用
     * 标题的 node.id），描述符会落到另一个节点：replace/remove 包错节点、add 插错父节点、
     * diff 的 index 在错父节点上越界而被静默跳过 —— 本地内容丢失且无任何提示。
     * 例外：同层重复身份漂移的 id 已由 MergeChildren 降级（只留 replace + 多余副本），
     * 其多份共存是有意为之，见 HasAmbiguousConflictTarget 内部的 unstableIdentities_ 过滤。
     */
    if (HasAmbiguousConflictTarget(data)) {
      Fail("dup-id");
      yyjson_mut_doc_free(doc_);
      doc_ = nullptr;
      return nullptr;
    }
    yyjson_mut_val* root = yyjson_mut_obj(doc_);
    if (root == nullptr || !yyjson_mut_obj_add_bool(doc_, root, "ok", true) ||
        !yyjson_mut_obj_add_val(doc_, root, "data", data) ||
        !yyjson_mut_obj_add_val(doc_, root, "conflicts", conflicts_) ||
        !yyjson_mut_obj_add_int(doc_, root, "auto", autoMerged_)) {
      FailInternal();
      yyjson_mut_doc_free(doc_);
      doc_ = nullptr;
      return nullptr;
    }
    yyjson_mut_doc_set_root(doc_, root);
    return doc_;
  }

 private:
  yyjson_mut_doc* doc_ = nullptr;
  yyjson_mut_val* conflicts_ = nullptr;
  int autoMerged_ = 0;
  bool failed_ = false;
  bool internal_ = false;
  /**
   * 同层重复身份数量漂移的 id（见 CollectUnstableIdentities）：这些 id 在结果树里被刻意
   * 保留成多份，冲突描述符只能落到前端「全局首个命中」的那一份，可定位性自检需对其放行。
   */
  std::unordered_set<std::string> unstableIdentities_;
  /** 各 unstable id 在本层被实际保留成几份（全树累加）：用于区分「降级保留的重复」与「跨层撞 id」 */
  std::unordered_map<std::string, int> unstableOutputs_;
  /**
   * 远端全树裸 id 集合：某 id 在本层消失时用它区分「远端删除了它」与「远端把它搬到了别的
   * 父节点下」。后者见 MergeChildren 第 ① 轮的移动降级。
   */
  std::unordered_set<std::string> remoteTreeIds_;

  /** 登记一个 unstable id 的保留份数（MergeChildren 每落地一份调一次） */
  void NoteUnstableOutput(const std::unordered_set<std::string>& unstable, const std::string& id) {
    if (!id.empty() && unstable.count(id) > 0) {
      unstableOutputs_[id]++;
    }
  }
  std::string reason_;

  void Fail(const char* reason) {
    if (!failed_) {
      failed_ = true;
      reason_ = reason;
    }
  }

  void FailInternal() {
    internal_ = true;
    Fail("internal");
  }

  /** 统计输入树中根 id 字段的出现次数（props.id 是节点属性、同层允许重复，不参与） */
  void CountInputIds(yyjson_val* node, std::unordered_map<std::string, int>* out) {
    if (node == nullptr) {
      return;
    }
    if (yyjson_is_arr(node)) {
      yyjson_arr_iter iter = yyjson_arr_iter_with(node);
      yyjson_val* item = nullptr;
      while ((item = yyjson_arr_iter_next(&iter)) != nullptr) {
        CountInputIds(item, out);
      }
      return;
    }
    if (!yyjson_is_obj(node)) {
      return;
    }
    yyjson_val* id = yyjson_obj_getn(node, "id", 2);
    if (id != nullptr && yyjson_is_str(id)) {
      (*out)[std::string(yyjson_get_str(id), yyjson_get_len(id))]++;
    }
    CountInputIds(yyjson_obj_getn(node, "children", 8), out);
  }

  /** 同上，结果树版本 */
  void CountMergedIds(yyjson_mut_val* node, std::unordered_map<std::string, int>* out) {
    if (node == nullptr) {
      return;
    }
    if (yyjson_mut_is_arr(node)) {
      yyjson_mut_arr_iter iter = yyjson_mut_arr_iter_with(node);
      yyjson_mut_val* item = nullptr;
      while ((item = yyjson_mut_arr_iter_next(&iter)) != nullptr) {
        CountMergedIds(item, out);
      }
      return;
    }
    if (!yyjson_mut_is_obj(node)) {
      return;
    }
    yyjson_mut_val* id = yyjson_mut_obj_getn(node, "id", 2);
    if (id != nullptr && yyjson_mut_is_str(id)) {
      (*out)[std::string(yyjson_mut_get_str(id), yyjson_mut_get_len(id))]++;
    }
    CountMergedIds(yyjson_mut_obj_getn(node, "children", 8), out);
  }

  /** 合并结果是否把某个 node.id 复制成了比任一侧更多的份数 */
  bool HasDuplicatedNodeId(yyjson_mut_val* data, yyjson_val* local, yyjson_val* remote) {
    std::unordered_map<std::string, int> localIds;
    std::unordered_map<std::string, int> remoteIds;
    std::unordered_map<std::string, int> mergedIds;
    CountInputIds(local, &localIds);
    CountInputIds(remote, &remoteIds);
    CountMergedIds(data, &mergedIds);
    for (const auto& entry : mergedIds) {
      const auto localIt = localIds.find(entry.first);
      const auto remoteIt = remoteIds.find(entry.first);
      const int localCount = localIt == localIds.end() ? 0 : localIt->second;
      const int remoteCount = remoteIt == remoteIds.end() ? 0 : remoteIt->second;
      const int allowed = localCount > remoteCount ? localCount : remoteCount;
      if (entry.second > allowed) {
        return true;
      }
    }
    return false;
  }

  /** 取节点身份 id（根字段 id 优先，兼容 props.id）；与 NodeIdOf 同口径 */
  static std::string IdentityOf(yyjson_mut_val* value) {
    if (value == nullptr || !yyjson_mut_is_obj(value)) {
      return std::string();
    }
    yyjson_mut_val* id = yyjson_mut_obj_getn(value, "id", 2);
    if (id == nullptr) {
      yyjson_mut_val* props = yyjson_mut_obj_getn(value, "props", 5);
      if (props != nullptr && yyjson_mut_is_obj(props)) {
        id = yyjson_mut_obj_getn(props, "id", 2);
      }
    }
    if (id == nullptr || !yyjson_mut_is_str(id)) {
      return std::string();
    }
    return std::string(yyjson_mut_get_str(id), yyjson_mut_get_len(id));
  }

  /** 统计结果树中每个身份的出现次数（props.id 同层允许重复，故按出现次数计） */
  void CountMergedIdentity(yyjson_mut_val* node, std::unordered_map<std::string, int>* out) {
    if (node == nullptr) {
      return;
    }
    if (yyjson_mut_is_arr(node)) {
      yyjson_mut_arr_iter iter = yyjson_mut_arr_iter_with(node);
      yyjson_mut_val* item = nullptr;
      while ((item = yyjson_mut_arr_iter_next(&iter)) != nullptr) {
        CountMergedIdentity(item, out);
      }
      return;
    }
    if (!yyjson_mut_is_obj(node)) {
      return;
    }
    const std::string id = IdentityOf(node);
    if (!id.empty()) {
      (*out)[id]++;
    }
    CountMergedIdentity(yyjson_mut_obj_getn(node, "children", 8), out);
  }

  /**
   * 冲突描述符的 id/parent/anchor 是否在结果树里不唯一（不唯一则前端必然定位到错节点）。
   * 同层重复身份漂移的 id 由 MergeChildren 刻意保留多份（多余副本原样落地、配对副本落 replace），
   * 这些 id 已登记在 unstableIdentities_，不再当成不可表达。
   */
  bool HasAmbiguousConflictTarget(yyjson_mut_val* data) {
    std::unordered_map<std::string, int> counts;
    CountMergedIdentity(data, &counts);
    static const char* kFields[] = {"id", "parent", "anchor"};
    static const size_t kLens[] = {2, 6, 6};
    yyjson_mut_arr_iter iter = yyjson_mut_arr_iter_with(conflicts_);
    yyjson_mut_val* conflict = nullptr;
    while ((conflict = yyjson_mut_arr_iter_next(&iter)) != nullptr) {
      for (int i = 0; i < 3; i++) {
        yyjson_mut_val* value = yyjson_mut_obj_getn(conflict, kFields[i], kLens[i]);
        if (value == nullptr || !yyjson_mut_is_str(value)) {
          continue;
        }
        const std::string key(yyjson_mut_get_str(value), yyjson_mut_get_len(value));
        /**
         * 同层重复身份漂移：MergeChildren 刻意保留了多份（配对副本落 replace、多余副本原样落地）。
         * 若结果树里该 id 的份数正好等于本层降级产出的份数，说明重复全部来自这次保留，
         * 描述符落到哪一份都指向同一个重复组，可以放行；份数更多则还有跳层撞 id，仍按不可定位处理。
         * 只放行 id 字段：parent/anchor 歧义与重复块无关，保持原严格口径。
         */
        if (i == 0 && unstableIdentities_.count(key) > 0) {
          const auto keptIt = unstableOutputs_.find(key);
          const auto keptCount = counts.find(key);
          if (keptIt != unstableOutputs_.end() && keptCount != counts.end() &&
              keptCount->second == keptIt->second) {
            continue;
          }
        }
        const auto it = counts.find(key);
        if (it != counts.end() && it->second > 1) {
          return true;
        }
      }
    }
    return false;
  }

  /** add 描述符的 id 是否已在结果里（与 add 的协议语义冲突） */
  bool HasAddOverlapWithData(yyjson_mut_val* data) {
    std::unordered_map<std::string, int> mergedIds;
    CountMergedIds(data, &mergedIds);
    yyjson_mut_arr_iter iter = yyjson_mut_arr_iter_with(conflicts_);
    yyjson_mut_val* conflict = nullptr;
    while ((conflict = yyjson_mut_arr_iter_next(&iter)) != nullptr) {
      yyjson_mut_val* action = yyjson_mut_obj_getn(conflict, "action", 6);
      if (action == nullptr || !yyjson_mut_is_str(action)) {
        continue;
      }
      if (std::string(yyjson_mut_get_str(action), yyjson_mut_get_len(action)) != "add") {
        continue;
      }
      yyjson_mut_val* id = yyjson_mut_obj_getn(conflict, "id", 2);
      if (id == nullptr || !yyjson_mut_is_str(id)) {
        continue;
      }
      if (mergedIds.find(std::string(yyjson_mut_get_str(id), yyjson_mut_get_len(id))) != mergedIds.end()) {
        return true;
      }
    }
    return false;
  }

  /** 把不可变文档中的值复制进结果文档 */
  yyjson_mut_val* Copy(yyjson_val* value) {
    yyjson_mut_val* out = yyjson_val_mut_copy(doc_, value);
    if (out == nullptr) {
      FailInternal();
    }
    return out;
  }

  /** 追加对象键值；键名复制进本文档（yyjson_mut_obj_add_val 不复制键，跨文档会悬空） */
  bool AddKey(yyjson_mut_val* obj, const char* name, size_t nameLen, yyjson_mut_val* value) {
    if (value == nullptr) {
      return false;
    }
    yyjson_mut_val* key = yyjson_mut_strncpy(doc_, name, nameLen);
    if (key == nullptr || !yyjson_mut_obj_add(obj, key, value)) {
      FailInternal();
      return false;
    }
    return true;
  }

  /**
   * 收集子树里被远端「搬到别处」的锚定子孙：该 id 在本层消失、但远端全树仍含它。
   * 远端把子节点取走、容器因此变空被删，是本函数要识别的主形态。
   */
  void CollectMovedDescendants(yyjson_val* node,
                               std::vector<std::pair<std::string, yyjson_val*>>* out) const {
    if (node == nullptr) {
      return;
    }
    if (yyjson_is_obj(node)) {
      yyjson_val* id = yyjson_obj_getn(node, "id", 2);
      if (id != nullptr && yyjson_is_str(id)) {
        std::string key(yyjson_get_str(id), yyjson_get_len(id));
        if (remoteTreeIds_.count(key) > 0) {
          out->emplace_back(key, node);
          return;  // 整棵搬走，不再下探
        }
      }
    }
    yyjson_val* children = yyjson_is_obj(node) ? yyjson_obj_getn(node, "children", 8) : node;
    if (children == nullptr || !yyjson_is_arr(children)) {
      return;
    }
    yyjson_arr_iter iter = yyjson_arr_iter_with(children);
    yyjson_val* item = nullptr;
    while ((item = yyjson_arr_iter_next(&iter)) != nullptr) {
      CollectMovedDescendants(item, out);
    }
  }

  /** 新建冲突描述符骨架（action + id） */
  yyjson_mut_val* NewConflict(const char* action, const std::string& id) {
    yyjson_mut_val* out = yyjson_mut_obj(doc_);
    if (out == nullptr || !yyjson_mut_obj_add_strcpy(doc_, out, "action", action) ||
        !yyjson_mut_obj_add_strncpy(doc_, out, "id", id.data(), id.size())) {
      FailInternal();
      return nullptr;
    }
    return out;
  }

  void PushConflict(yyjson_mut_val* conflict) {
    if (conflict == nullptr) {
      return;
    }
    if (!yyjson_mut_arr_append(conflicts_, conflict)) {
      FailInternal();
    }
  }

  /** 父节点 id（根为空串时不写，前端按整树定位） */
  void SetParent(yyjson_mut_val* conflict, const std::string& parentId) {
    if (conflict == nullptr || parentId.empty()) {
      return;
    }
    yyjson_mut_obj_add_strncpy(doc_, conflict, "parent", parentId.data(), parentId.size());
  }

  /** 定位锚点：前一个兄弟节点的裸 id（空 = 头部，写 null） */
  void SetAnchor(yyjson_mut_val* conflict, const std::string& anchorId) {
    if (conflict == nullptr) {
      return;
    }
    if (anchorId.empty()) {
      yyjson_mut_obj_add_null(doc_, conflict, "anchor");
      return;
    }
    yyjson_mut_obj_add_strncpy(doc_, conflict, "anchor", anchorId.data(), anchorId.size());
  }

  /**
   * 无名子项（无 id 对象，如列表项；或字符串与对象互换）三方归并。
   * 这类子项在 merged 里没有稳定 id，前端注入冲突只能按 id 定位，故只接受
   * 「两侧同值」与「单侧改动」；两侧各自改成不同内容属不可表达，整文件回落老路径。
   * 成功时返回 true 并写 *out / *keep；不可表达时置失败原因返回 false。
   */
  bool MergeUnnamedItem(yyjson_val* base, yyjson_val* local, yyjson_val* remote,
                        yyjson_mut_val** out, bool* keep) {
    *out = nullptr;
    *keep = true;
    if (base == nullptr) {
      // 两侧以同一无 id 段位各自新增：值相同才算可自动落地
      if (!ValueEquals(local, remote)) {
        Fail("shape-conflict");
        return false;
      }
      *out = Copy(remote);
      return true;
    }
    if (local != nullptr && remote != nullptr) {
      if (ValueEquals(local, remote)) {
        *out = Copy(remote);
        return true;
      }
      if (ValueEquals(base, local)) {
        autoMerged_++;
        *out = Copy(remote);
        return true;
      }
      if (ValueEquals(base, remote)) {
        autoMerged_++;
        *out = Copy(local);
        return true;
      }
      Fail("shape-conflict");
      return false;
    }
    // 单侧删除：仅当留存侧未被同时改动时才可自动落地；与锚定节点同语义，删除优先
    yyjson_val* survivor = local != nullptr ? local : remote;
    if (!ValueEquals(base, survivor)) {
      // 一边删一边改属真冲突，无名节点无法在前端定位，整文件回落
      Fail("shape-conflict");
      return false;
    }
    autoMerged_++;
    *keep = false;
    return true;
  }

  /**
   * 合并单个节点。recordReplace 为 true 时节点内冲突整节点回退为远端值并记 replace；
   * 为 false（根节点）时按不可表达处理（ok:false 回落明文路径）。
   * base 为空表示两侧以同一 id 各自新增了节点。
   */
  yyjson_mut_val* MergeNode(yyjson_val* base, yyjson_val* local, yyjson_val* remote,
                            int depth, const std::string& nodeId, bool recordReplace) {
    const size_t conflictMark = yyjson_mut_arr_size(conflicts_);
    if (base == nullptr) {
      if (ValueEquals(local, remote)) {
        return Copy(remote);
      }
      return NodeFallback(local, remote, nodeId, recordReplace, "add-conflict", conflictMark);
    }
    if (ValueEquals(local, remote)) {
      return Copy(remote);
    }
    if (ValueEquals(base, local)) {
      autoMerged_++;
      return Copy(remote);
    }
    if (ValueEquals(base, remote)) {
      autoMerged_++;
      return Copy(local);
    }
    if (depth >= kMaxMergeDepth) {
      Fail("depth");
      return nullptr;
    }
    if (!yyjson_is_obj(base) || !yyjson_is_obj(local) || !yyjson_is_obj(remote)) {
      return NodeFallback(local, remote, nodeId, recordReplace, "type-conflict", conflictMark);
    }

    yyjson_mut_val* out = yyjson_mut_obj(doc_);
    if (out == nullptr) {
      FailInternal();
      return nullptr;
    }
    bool keyConflict = false;
    yyjson_val* key = nullptr;
    yyjson_obj_iter iter = yyjson_obj_iter_with(base);
    while ((key = yyjson_obj_iter_next(&iter)) != nullptr) {
      if (!MergeNodeKey(base, local, remote, yyjson_get_str(key), yyjson_get_len(key),
                        out, depth, nodeId, &keyConflict)) {
        return nullptr;
      }
    }
    // 两侧各自新增的键（base 里没有）：单侧新增直接采用，两侧新增不同值算键级冲突
    for (int side = 0; side < 2; side++) {
      yyjson_val* source = side == 0 ? local : remote;
      yyjson_obj_iter sideIter = yyjson_obj_iter_with(source);
      while ((key = yyjson_obj_iter_next(&sideIter)) != nullptr) {
        const char* name = yyjson_get_str(key);
        const size_t nameLen = yyjson_get_len(key);
        if (yyjson_obj_getn(base, name, nameLen) != nullptr) {
          continue;
        }
        yyjson_val* localValue = yyjson_obj_getn(local, name, nameLen);
        yyjson_val* remoteValue = yyjson_obj_getn(remote, name, nameLen);
        if (localValue == nullptr || remoteValue == nullptr) {
          if (!AddKey(out, name, nameLen, Copy(localValue != nullptr ? localValue : remoteValue))) {
            return nullptr;
          }
          continue;
        }
        if (side != 0) {
          continue;  // 两侧都新增的键在 local 轮已处理
        }
        if (ValueEquals(localValue, remoteValue)) {
          if (!AddKey(out, name, nameLen, Copy(remoteValue))) {
            return nullptr;
          }
          continue;
        }
        keyConflict = true;
      }
    }
    if (keyConflict) {
      return NodeFallback(local, remote, nodeId, recordReplace, "key-conflict", conflictMark);
    }
    return out;
  }

  /** 合并节点对象的一个键（children 走序列归并，其余按键级三方法） */
  bool MergeNodeKey(yyjson_val* base, yyjson_val* local, yyjson_val* remote,
                    const char* name, size_t nameLen, yyjson_mut_val* out,
                    int depth, const std::string& nodeId, bool* keyConflict) {
    yyjson_val* baseValue = yyjson_obj_getn(base, name, nameLen);
    yyjson_val* localValue = yyjson_obj_getn(local, name, nameLen);
    yyjson_val* remoteValue = yyjson_obj_getn(remote, name, nameLen);
    if (nameLen == 8 && std::memcmp(name, "children", 8) == 0) {
      yyjson_mut_val* children = MergeChildren(baseValue, localValue, remoteValue, depth + 1, nodeId);
      if (children == nullptr) {
        return false;
      }
      return AddKey(out, name, nameLen, children);
    }
    if (localValue == nullptr || remoteValue == nullptr) {
      if (localValue == nullptr && remoteValue == nullptr) {
        return true;  // 两侧都删键：一致
      }
      yyjson_val* kept = localValue != nullptr ? localValue : remoteValue;
      if (ValueEquals(baseValue, kept)) {
        autoMerged_++;  // 单侧删键、另一侧未改：跟随删除
        return true;
      }
      *keyConflict = true;
      return true;
    }
    if (ValueEquals(localValue, remoteValue)) {
      return AddKey(out, name, nameLen, Copy(remoteValue));
    }
    if (ValueEquals(baseValue, localValue)) {
      autoMerged_++;
      return AddKey(out, name, nameLen, Copy(remoteValue));
    }
    if (ValueEquals(baseValue, remoteValue)) {
      autoMerged_++;
      return AddKey(out, name, nameLen, Copy(localValue));
    }
    // 两侧改成不同值：type 不可表达（整文件回落），展开态恒取本地
    if (nameLen == 4 && std::memcmp(name, "type", 4) == 0) {
      Fail("type-conflict");
      return false;
    }
    if (nameLen == 6 && std::memcmp(name, "expand", 6) == 0) {
      return AddKey(out, name, nameLen, Copy(localValue));
    }
    bool conflict = false;
    yyjson_mut_val* merged = MergePlainObject(baseValue, localValue, remoteValue, depth + 1, &conflict);
    if (merged == nullptr) {
      if (failed_) {
        return false;
      }
      *keyConflict = true;
      return true;
    }
    return AddKey(out, name, nameLen, merged);
  }

  /** 整节点回退：可表达时记 replace（local = 本地版）并取远端版，否则判不可表达 */
  yyjson_mut_val* NodeFallback(yyjson_val* local, yyjson_val* remote, const std::string& nodeId,
                               bool recordReplace, const char* reason, size_t conflictMark) {
    if (!recordReplace) {
      Fail(reason);
      return nullptr;
    }
    /**
     * 回退前撤销本节点子树已产出的冲突描述符：整节点已换回远端原样，子树里的 diff/replace
     * 在合并结果里已无对应位置。留着会让前端对同一节点双层包装、要用户裁决两次，两次选择
     * 还可能拼出对撞双方都不存在的混合态（远端文本 + 本地 props）。
     */
    while (yyjson_mut_arr_size(conflicts_) > conflictMark) {
      if (yyjson_mut_arr_remove_last(conflicts_) == nullptr) {
        FailInternal();
        return nullptr;
      }
    }
    if (!nodeId.empty()) {
      yyjson_mut_val* conflict = NewConflict("replace", nodeId);
      if (conflict == nullptr) {
        return nullptr;
      }
      if (!yyjson_mut_obj_add_val(doc_, conflict, "local", Copy(local))) {
        FailInternal();
        return nullptr;
      }
      PushConflict(conflict);
    }
    return Copy(remote);
  }

  /**
   * 同层重复身份（数量在三侧漂移）的配对归并：出现序号已不可信，内容一律不自动归并。
   * 两侧同值仍可直接落地；否则整节点回退为远端值并记 replace（local 放本地版）。
   * 无 id 时描述符无从定位，只能判不可表达。
   */
  yyjson_mut_val* MergeUnstableDuplicate(yyjson_val* local, yyjson_val* remote,
                                        const std::string& nodeId) {
    if (ValueEquals(local, remote)) {
      return Copy(remote);
    }
    if (nodeId.empty()) {
      Fail("dup-id");
      return nullptr;
    }
    return NodeFallback(local, remote, nodeId, true, "dup-id", yyjson_mut_arr_size(conflicts_));
  }

  /**
   * 合并普通对象（style / props）：键级三方；出现键级冲突时置 *conflict 并返回 nullptr，
   * 由调用方整节点回退，避免产出半合并的混合态。
   */
  yyjson_mut_val* MergePlainObject(yyjson_val* base, yyjson_val* local, yyjson_val* remote,
                                   int depth, bool* conflict) {
    if (ValueEquals(local, remote)) {
      return Copy(remote);
    }
    if (ValueEquals(base, local)) {
      autoMerged_++;
      return Copy(remote);
    }
    if (ValueEquals(base, remote)) {
      autoMerged_++;
      return Copy(local);
    }
    if (depth >= kMaxMergeDepth) {
      Fail("depth");
      return nullptr;
    }
    if (!yyjson_is_obj(base) || !yyjson_is_obj(local) || !yyjson_is_obj(remote)) {
      *conflict = true;
      return nullptr;
    }
    yyjson_mut_val* out = yyjson_mut_obj(doc_);
    if (out == nullptr) {
      FailInternal();
      return nullptr;
    }
    bool anyConflict = false;
    yyjson_val* key = nullptr;
    yyjson_obj_iter iter = yyjson_obj_iter_with(base);
    while ((key = yyjson_obj_iter_next(&iter)) != nullptr) {
      const char* name = yyjson_get_str(key);
      const size_t nameLen = yyjson_get_len(key);
      // 展开态属于视图状态：恒取本地，不参与冲突
      if (nameLen == 6 && std::memcmp(name, "expand", 6) == 0) {
        yyjson_val* localValue = yyjson_obj_getn(local, name, nameLen);
        if (localValue != nullptr && !AddKey(out, name, nameLen, Copy(localValue))) {
          return nullptr;
        }
        continue;
      }
      yyjson_val* baseValue = yyjson_obj_iter_get_val(key);
      yyjson_val* localValue = yyjson_obj_getn(local, name, nameLen);
      yyjson_val* remoteValue = yyjson_obj_getn(remote, name, nameLen);
      if (localValue == nullptr || remoteValue == nullptr) {
        if (localValue == nullptr && remoteValue == nullptr) {
          continue;
        }
        yyjson_val* kept = localValue != nullptr ? localValue : remoteValue;
        if (ValueEquals(baseValue, kept)) {
          autoMerged_++;
          continue;
        }
        anyConflict = true;
        continue;
      }
      bool subConflict = false;
      yyjson_mut_val* merged = MergePlainObject(baseValue, localValue, remoteValue, depth + 1, &subConflict);
      if (merged == nullptr) {
        if (failed_) {
          return nullptr;
        }
        anyConflict = true;
        continue;
      }
      if (subConflict) {
        anyConflict = true;
        continue;
      }
      if (!AddKey(out, name, nameLen, merged)) {
        return nullptr;
      }
    }
    for (int side = 0; side < 2; side++) {
      yyjson_val* source = side == 0 ? local : remote;
      yyjson_obj_iter sideIter = yyjson_obj_iter_with(source);
      while ((key = yyjson_obj_iter_next(&sideIter)) != nullptr) {
        const char* name = yyjson_get_str(key);
        const size_t nameLen = yyjson_get_len(key);
        if (yyjson_obj_getn(base, name, nameLen) != nullptr) {
          continue;
        }
        yyjson_val* localValue = yyjson_obj_getn(local, name, nameLen);
        yyjson_val* remoteValue = yyjson_obj_getn(remote, name, nameLen);
        if (localValue == nullptr || remoteValue == nullptr) {
          if (!AddKey(out, name, nameLen, Copy(localValue != nullptr ? localValue : remoteValue))) {
            return nullptr;
          }
          continue;
        }
        if (side != 0) {
          continue;
        }
        if (ValueEquals(localValue, remoteValue)) {
          if (!AddKey(out, name, nameLen, Copy(remoteValue))) {
            return nullptr;
          }
          continue;
        }
        anyConflict = true;
      }
    }
    if (anyConflict) {
      *conflict = true;
      return nullptr;
    }
    return out;
  }

  /** 文本段三方合并；返回 false 仅表示内部失败，*conflict 标记是否需要人工裁决 */
  bool MergeTextItem(const std::string& baseText, const std::string& localText,
                     const std::string& remoteText, std::string* merged, bool* conflict) {
    TextMergeResult result;
    const bool textable = MergeText3(baseText, localText, remoteText, &result);
    *conflict = !textable || result.conflict;
    *merged = textable ? result.merged : remoteText;
    return true;
  }

  /** 子节点序列三方归并（实现在类外，避免单次改动过大） */
  yyjson_mut_val* MergeChildren(yyjson_val* base, yyjson_val* local, yyjson_val* remote,
                                int depth, const std::string& parentId);
};

// ---------------------------------------------------------------------------
// 子节点序列归并
// ---------------------------------------------------------------------------
/**
 * 子节点序列三方归并：保留 base 顺序，插入项挂最近共同锚点之后（顺序差异不算冲突）。
 * 定位一律用 parent + anchor（前一个兄弟 id），不用数字下标（连续 splice 会漂移）。
 * 同层重复身份的数量在三侧漂移时，只降级这些 id 的配对（落 replace、多余副本原样保留），
 * 不整份失败：一篇文档里一处重复块不应该让全部自动合并且回落到两方 diff。
 */
yyjson_mut_val* EditorMerger::MergeChildren(yyjson_val* base, yyjson_val* local, yyjson_val* remote,
                                            int depth, const std::string& parentId) {
  if (depth >= kMaxMergeDepth) {
    Fail("depth");
    return nullptr;
  }
  std::vector<ChildRef> baseRefs;
  std::vector<ChildRef> localRefs;
  std::vector<ChildRef> remoteRefs;
  std::unordered_map<std::string, size_t> baseIds;
  std::unordered_map<std::string, size_t> localIds;
  std::unordered_map<std::string, size_t> remoteIds;
  CollectChildren(base, &baseRefs, &baseIds);
  CollectChildren(local, &localRefs, &localIds);
  CollectChildren(remote, &remoteRefs, &remoteIds);
  /**
   * 同层重复身份的数量漂移（一侧删/增了一个同身份兄弟）：出现序号配对会错位，但没必要因此
   * 判整份不可表达 —— 只把这些 id 的配对降级为 replace 描述符，本层其余子项照常归并。
   */
  std::unordered_set<std::string> unstable;
  CollectUnstableIdentities(baseIds, localIds, remoteIds, &unstable);
  unstableIdentities_.insert(unstable.begin(), unstable.end());

  std::unordered_map<std::string, size_t> baseAt;
  std::unordered_map<std::string, size_t> localAt;
  std::unordered_map<std::string, size_t> remoteAt;
  IndexRefs(baseRefs, &baseAt);
  IndexRefs(localRefs, &localAt);
  IndexRefs(remoteRefs, &remoteAt);

  struct PendingText {
    yyjson_mut_val* value = nullptr;  // 合并后的字符串值（用于回填绝对下标）
    size_t fallback = 0;
    std::string local;
    std::string remote;
  };
  std::vector<yyjson_mut_val*> out;
  std::vector<std::string> outKeys;
  std::vector<PendingText> pending;
  std::string anchorId;  // 输出序列中最近一个锚定节点的裸 id（add/remove 的 anchor 字段用）

  const auto append = [&](const std::string& key, const std::string& id, yyjson_mut_val* value) {
    out.push_back(value);
    outKeys.push_back(key);
    if (!id.empty()) {
      anchorId = id;
      NoteUnstableOutput(unstable, id);
    }
  };

  // ---- 第 ① 轮：沿 base 顺序归并「base 里存在」的子项 ----
  for (size_t i = 0; i < baseRefs.size(); i++) {
    const ChildRef& ref = baseRefs[i];
    const auto localIt = localAt.find(ref.key);
    const auto remoteIt = remoteAt.find(ref.key);
    const bool hasLocal = localIt != localAt.end();
    const bool hasRemote = remoteIt != remoteAt.end();

    if (ref.anchored) {
      const std::string& id = ref.id;
      const bool unstableId = unstable.count(id) > 0;
      if (hasLocal && hasRemote) {
        yyjson_val* localValue = localRefs[localIt->second].value;
        yyjson_val* remoteValue = remoteRefs[remoteIt->second].value;
        yyjson_mut_val* merged = unstableId
            ? MergeUnstableDuplicate(localValue, remoteValue, id)
            : MergeNode(ref.value, localValue, remoteValue, depth + 1, id, true);
        if (merged == nullptr) {
          return nullptr;
        }
        append(ref.key, ref.id, merged);
        continue;
      }
      if (hasLocal) {
        // 本地改、远端删：合并结果含本地版，记 remove（node = 本地版）
        yyjson_val* localValue = localRefs[localIt->second].value;
        if (ValueEquals(ref.value, localValue)) {
          autoMerged_++;
          continue;
        }
        if (unstableId) {
          /**
           * 重复身份下 remove 描述符会命中另一份同 id 副本（前端按全局首个命中包节点）：
           * 不动描述符，直接保留本地副本 —— 内容不丢，代价只是用户不被告知。
           */
          append(ref.key, ref.id, Copy(localValue));
          continue;
        }
        /**
         * 远端搬走 + 本地改内容：该 id 在本层消失、却在远端别处出现，属跨父节点移动。描述符
         * 没有移动原语，但可以只在新位置落地远端版、本层腾空，把内容差异记成 replace ——
         * 结果树里该 id 仍只有一份（前端 indexConflictNodes 不会错配），data 是远端版、
         * local 字段是本地版，与 replace 契约一致。不这么做就会旧父、新父各留一份，被
         * HasDuplicatedNodeId 判不可表达、整份回落两方 diff。
         */
        if (!id.empty() && remoteTreeIds_.count(id) > 0) {
          yyjson_mut_val* moved = NewConflict("replace", id);
          if (moved != nullptr && !yyjson_mut_obj_add_val(doc_, moved, "local", Copy(localValue))) {
            FailInternal();
            return nullptr;
          }
          PushConflict(moved);
          continue;
        }
        /**
         * 远端把本层子树里的锚定子孙取走挂到别处，这棵壳因此变空被删：若整棵本地版落地，
         * 被取走的那颗就在旧位置与新位置各留一份（HasDuplicatedNodeId 拦下后整份回落）。
         * 本地除了被取走项之外没改别的内容时，跟着远端删除：壳不落地，每个被取走项记
         * replace（local = 本地版），新位置那份（远端版）就是结果树里唯一的一份。
         */
        std::vector<std::pair<std::string, yyjson_val*>> movedDescendants;
        CollectMovedDescendants(localValue, &movedDescendants);
        if (!movedDescendants.empty()) {
          std::unordered_set<std::string> movedIds;
          for (const auto& moved : movedDescendants) {
            movedIds.insert(moved.first);
          }
          if (SubtreeEqualsIgnoring(localValue, ref.value, movedIds)) {
            for (const auto& moved : movedDescendants) {
              yyjson_mut_val* conflict = NewConflict("replace", moved.first);
              if (conflict != nullptr &&
                  !yyjson_mut_obj_add_val(doc_, conflict, "local", Copy(moved.second))) {
                FailInternal();
                return nullptr;
              }
              PushConflict(conflict);
            }
            continue;
          }
        }
        yyjson_mut_val* conflict = NewConflict("remove", id);
        SetParent(conflict, parentId);
        SetAnchor(conflict, anchorId);
        if (conflict != nullptr && !yyjson_mut_obj_add_val(doc_, conflict, "node", Copy(localValue))) {
          FailInternal();
          return nullptr;
        }
        PushConflict(conflict);
        append(ref.key, ref.id, Copy(localValue));
        continue;
      }
      if (hasRemote) {
        // 本地删、远端改：合并结果不含，记 add（node = 远端版）
        yyjson_val* remoteValue = remoteRefs[remoteIt->second].value;
        if (ValueEquals(ref.value, remoteValue)) {
          autoMerged_++;
          continue;
        }
        if (unstableId) {
          // 同上：add 会与结果里已在的同 id 副本撞车（HasAddOverlapWithData），改为原样保留远端副本
          append(ref.key, ref.id, Copy(remoteValue));
          continue;
        }
        yyjson_mut_val* conflict = NewConflict("add", id);
        SetParent(conflict, parentId);
        SetAnchor(conflict, anchorId);
        if (conflict != nullptr && !yyjson_mut_obj_add_val(doc_, conflict, "node", Copy(remoteValue))) {
          FailInternal();
          return nullptr;
        }
        PushConflict(conflict);
        continue;
      }
      autoMerged_++;  // 两侧都删
      continue;
    }

    // 文本段：缺失侧按空串参与三方合并（单侧改 + 单侧删 能自动落地时不会进冲突）
    yyjson_val* localValue = hasLocal ? localRefs[localIt->second].value : nullptr;
    yyjson_val* remoteValue = hasRemote ? remoteRefs[remoteIt->second].value : nullptr;
    if (!yyjson_is_str(ref.value) || (localValue != nullptr && !yyjson_is_str(localValue)) ||
        (remoteValue != nullptr && !yyjson_is_str(remoteValue))) {
      // 非纯字符串的无名子项（无 id 对象，如列表项）：整段归并，单侧改动直接采用
      yyjson_mut_val* unnamed = nullptr;
      bool keep = false;
      if (!MergeUnnamedItem(ref.value, localValue, remoteValue, &unnamed, &keep)) {
        return nullptr;
      }
      if (keep) {
        append(ref.key, ref.id, unnamed);
      }
      continue;
    }
    const std::string baseText = StringOf(ref.value);
    const std::string localText = StringOf(localValue);
    const std::string remoteText = StringOf(remoteValue);
    std::string mergedText;
    bool textConflict = false;
    if (!MergeTextItem(baseText, localText, remoteText, &mergedText, &textConflict)) {
      return nullptr;
    }
    if (mergedText.empty()) {
      if (!textConflict) {
        autoMerged_++;  // 两侧都删掉了该文本段
        continue;
      }
      /**
       * 两侧改了同一段且合并结果为空（远端把它清空/删掉）：必须落一个空串占位。
       * 不占位则 data 里没有可定位的元素，diff 的 index 会越界，前端 injectConflicts 的
       * 「按下标替换」与「按 remote 文本查找」两条路都失败并静默跳过 —— 本地文本既不在
       * 合并结果里，也永远拿不到裁决，等于静默丢内容。
       */
      yyjson_mut_val* placeholder = yyjson_mut_strncpy(doc_, "", 0);
      if (placeholder == nullptr) {
        FailInternal();
        return nullptr;
      }
      pending.push_back(PendingText{placeholder, 0, localText, remoteText});
      append(ref.key, ref.id, placeholder);
      continue;
    }
    yyjson_mut_val* merged = yyjson_mut_strncpy(doc_, mergedText.data(), mergedText.size());
    if (merged == nullptr) {
      FailInternal();
      return nullptr;
    }
    if (textConflict) {
      pending.push_back(PendingText{merged, 0, localText, remoteText});
    } else {
      autoMerged_++;
    }
    append(ref.key, ref.id, merged);
  }

  // ---- 第 ② 轮：收集 base 中不存在的新增子项（单侧新增 / 两侧同 id）----
  enum InsertSide { kInsertLocal, kInsertBoth, kInsertRemote };
  struct Insertion {
    std::string key;
    InsertSide side = kInsertLocal;
    yyjson_val* local = nullptr;
    yyjson_val* remote = nullptr;
    std::string id;
    bool anchored = false;
  };
  std::vector<Insertion> insertions;
  std::vector<std::string> groupOrder;
  std::unordered_map<std::string, std::vector<size_t>> groups;

  /**
   * base 本层文本段的内容清单：用于识别「插入段与已有段同文」的错位。
   * 文本段无 id，只能按锚点组内序号对齐；一侧在段前插入新的裸字符串时，序号整体后移，
   * base 原文会被错配成「被改写」，合并结果里原文消失、前端只能二选一（必丢一侧内容）。
   * 无 id 前提下无法可靠对齐，故判不可表达，交回两方 diff 人工确认。
   */
  std::vector<std::string> baseTexts;
  for (size_t i = 0; i < baseRefs.size(); i++) {
    if (!baseRefs[i].anchored && yyjson_is_str(baseRefs[i].value)) {
      baseTexts.push_back(StringOf(baseRefs[i].value));
    }
  }
  const auto shiftedTextInsertion = [&](const ChildRef& ref) {
    if (ref.anchored || !yyjson_is_str(ref.value)) {
      return false;
    }
    const std::string text = StringOf(ref.value);
    if (text.empty()) {
      return false;
    }
    for (size_t i = 0; i < baseTexts.size(); i++) {
      if (baseTexts[i] == text) {
        return true;
      }
    }
    return false;
  };

  for (size_t i = 0; i < localRefs.size(); i++) {
    const std::string& key = localRefs[i].key;
    if (baseAt.count(key) > 0) {
      continue;
    }
    std::string insertAnchor;
    for (size_t j = i; j-- > 0;) {
      if (baseAt.count(localRefs[j].key) > 0) {
        insertAnchor = localRefs[j].key;
        break;
      }
    }
    if (shiftedTextInsertion(localRefs[i])) {
      Fail("shape-conflict");
      return nullptr;
    }
    Insertion item;
    item.key = key;
    item.local = localRefs[i].value;
    item.anchored = localRefs[i].anchored;
    item.id = localRefs[i].id;
    const auto remoteIt = remoteAt.find(key);
    if (remoteIt == remoteAt.end()) {
      item.side = kInsertLocal;
    } else {
      item.side = kInsertBoth;
      item.remote = remoteRefs[remoteIt->second].value;
    }
    if (groups.find(insertAnchor) == groups.end()) {
      groupOrder.push_back(insertAnchor);
    }
    groups[insertAnchor].push_back(insertions.size());
    insertions.push_back(item);
  }
  for (size_t i = 0; i < remoteRefs.size(); i++) {
    const std::string& key = remoteRefs[i].key;
    if (baseAt.count(key) > 0 || localAt.count(key) > 0) {
      continue;
    }
    std::string insertAnchor;
    for (size_t j = i; j-- > 0;) {
      if (baseAt.count(remoteRefs[j].key) > 0) {
        insertAnchor = remoteRefs[j].key;
        break;
      }
    }
    if (shiftedTextInsertion(remoteRefs[i])) {
      Fail("shape-conflict");
      return nullptr;
    }
    Insertion item;
    item.key = key;
    item.side = kInsertRemote;
    item.remote = remoteRefs[i].value;
    item.anchored = remoteRefs[i].anchored;
    item.id = remoteRefs[i].id;
    if (groups.find(insertAnchor) == groups.end()) {
      groupOrder.push_back(insertAnchor);
    }
    groups[insertAnchor].push_back(insertions.size());
    insertions.push_back(item);
  }

  /**
   * ---- 第 ③ 轮：按锚点分组插入（同锚点 local 在前）----
   * 两侧往同一锚点各插一个不同节点时两者都保留：两端都没删对方的编辑，并集就是完整结果，
   * 顺序按 local 优先确定，无歧义、无需裁决。这里**不能**补 add 描述符 —— add 的协议语义是
   * 「合并结果里没有该节点，前端按 parent/anchor 插回」，节点已写入 out，再报 add 会让前端
   * 插回第二份（同 id 重复内容）。
   */
  for (size_t g = 0; g < groupOrder.size(); g++) {
    const std::string& groupKey = groupOrder[g];
    const std::vector<size_t>& members = groups[groupKey];

    size_t pos = 0;
    if (!groupKey.empty()) {
      bool found = false;
      for (size_t i = 0; i < outKeys.size(); i++) {
        if (outKeys[i] == groupKey) {
          pos = i + 1;
          found = true;
          break;
        }
      }
      if (!found) {
        /**
         * 锚点本身在本轮没了（两侧都删的块、合并结果为空的文本段）：退化到 base 中它
         * 之前最近的存活子项之后。直接留 pos=0 会把整组新增插到同级最前面，
         * 内容不丢但新块会跳到段落顶部。
         */
        for (size_t i = 0; i < baseRefs.size() && !found; i++) {
          if (baseRefs[i].key != groupKey) {
            continue;
          }
          for (size_t j = i; j-- > 0;) {
            for (size_t k = 0; k < outKeys.size(); k++) {
              if (outKeys[k] == baseRefs[j].key) {
                pos = k + 1;
                found = true;
                break;
              }
            }
            if (found) {
              break;
            }
          }
        }
      }
    }

    for (size_t m = 0; m < members.size(); m++) {
      Insertion& item = insertions[members[m]];
      yyjson_mut_val* merged = nullptr;
      if (item.side == kInsertBoth) {
        if (item.anchored) {
          /**
           * 两侧同键各自新增（base 里没有）：数量漂移时这一份也只是「多出来的兄弟」，
           * 不能报 add（结果里可能已有同 id 副本，前端会重复插回），统一落 replace。
           */
          merged = unstable.count(item.id) > 0
              ? MergeUnstableDuplicate(item.local, item.remote, item.id)
              : MergeNode(nullptr, item.local, item.remote, depth + 1, item.id, true);
          if (merged == nullptr) {
            return nullptr;
          }
        } else if (!yyjson_is_str(item.local) || !yyjson_is_str(item.remote)) {
          // 同段位的无 id 对象：两侧同值才可落地（否则无 id 可定位冲突）
          bool keep = false;
          if (!MergeUnnamedItem(nullptr, item.local, item.remote, &merged, &keep)) {
            return nullptr;
          }
        } else {
          std::string mergedText;
          bool textConflict = false;
          if (!MergeTextItem(std::string(), StringOf(item.local), StringOf(item.remote),
                             &mergedText, &textConflict)) {
            return nullptr;
          }
          merged = yyjson_mut_strncpy(doc_, mergedText.data(), mergedText.size());
          if (merged == nullptr) {
            FailInternal();
            return nullptr;
          }
          if (textConflict) {
            pending.push_back(PendingText{merged, 0, StringOf(item.local), StringOf(item.remote)});
          }
        }
      } else {
        // 单侧新增，或两侧同锚点各新增：都是完整内容，直接落地（后者两者并列保留）
        autoMerged_++;
        merged = Copy(item.side == kInsertLocal ? item.local : item.remote);
      }
      if (merged == nullptr) {
        return nullptr;
      }
      out.insert(out.begin() + static_cast<std::ptrdiff_t>(pos), merged);
      outKeys.insert(outKeys.begin() + static_cast<std::ptrdiff_t>(pos), item.key);
      NoteUnstableOutput(unstable, item.id);
      pos++;
    }
  }

  // ---- 第 ④ 轮：文本冲突回填绝对下标（输出序列已定型，下标不再漂移）----
  for (size_t i = 0; i < pending.size(); i++) {
    size_t index = pending[i].fallback;
    if (pending[i].value != nullptr) {
      for (size_t j = 0; j < out.size(); j++) {
        if (out[j] == pending[i].value) {
          index = j;
          break;
        }
      }
    }
    yyjson_mut_val* conflict = NewConflict("diff", parentId);
    yyjson_mut_obj_add_strncpy(doc_, conflict, "local", pending[i].local.data(), pending[i].local.size());
    yyjson_mut_obj_add_strncpy(doc_, conflict, "remote", pending[i].remote.data(),
                               pending[i].remote.size());
    yyjson_mut_obj_add_uint(doc_, conflict, "index", static_cast<uint64_t>(index));
    PushConflict(conflict);
  }

  yyjson_mut_val* array = yyjson_mut_arr(doc_);
  if (array == nullptr) {
    FailInternal();
    return nullptr;
  }
  for (size_t i = 0; i < out.size(); i++) {
    if (!yyjson_mut_arr_append(array, out[i])) {
      FailInternal();
      return nullptr;
    }
  }
  return array;
}

}  // namespace

// ---------------------------------------------------------------------------
// 编辑器文档树三方合并（对外入口）
// ---------------------------------------------------------------------------
bool MergeEditorJson(const uint8_t* baseData, size_t baseLen,
                     const uint8_t* localData, size_t localLen,
                     const uint8_t* remoteData, size_t remoteLen,
                     std::vector<uint8_t>* out, std::string* error) {
  if (static_cast<uint64_t>(baseLen) > kMaxMergeInput ||
      static_cast<uint64_t>(localLen) > kMaxMergeInput ||
      static_cast<uint64_t>(remoteLen) > kMaxMergeInput) {
    *error = "mergeEditor input exceeds 16MB limit";
    return false;
  }

  const uint8_t* payloads[3] = {baseData, localData, remoteData};
  const size_t lengths[3] = {baseLen, localLen, remoteLen};
  const char* labels[3] = {"base", "local", "remote"};
  yyjson_doc* docs[3] = {nullptr, nullptr, nullptr};
  yyjson_val* roots[3] = {nullptr, nullptr, nullptr};

  yyjson_read_err readErr;
  for (int i = 0; i < 3; i++) {
    docs[i] = yyjson_read_opts(const_cast<char*>(reinterpret_cast<const char*>(payloads[i])),
                               lengths[i], YYJSON_READ_NOFLAG, nullptr, &readErr);
    if (docs[i] == nullptr) {
      *error = std::string("mergeEditor parse ") + labels[i] + " payload failed: " +
               (readErr.msg != nullptr ? readErr.msg : "unknown");
      for (int j = 0; j < i; j++) {
        yyjson_doc_free(docs[j]);
      }
      return false;
    }
  }

  for (int i = 0; i < 3; i++) {
    yyjson_val* root = yyjson_doc_get_root(docs[i]);
    /**
     * 契约要求三份入参都是整份 state（节点树在 /data 下）：
     * `/data` 缺失或不是对象 → 业务级不可表达，回 ok:false,reason:"no-data"
     * 由调用方回落两方 diff（不让宿主把它当异常抛出）。
     */
    yyjson_val* data = yyjson_is_obj(root) ? yyjson_obj_getn(root, "data", 4) : nullptr;
    roots[i] = data;
    if (data == nullptr || !yyjson_is_obj(data)) {
      for (int j = 0; j < 3; j++) {
        yyjson_doc_free(docs[j]);
      }
      const std::string fallback = "{\"ok\":false,\"reason\":\"no-data\"}";
      out->assign(fallback.begin(), fallback.end());
      return true;
    }
  }

  EditorMerger merger;
  yyjson_mut_doc* result = merger.Run(roots[0], roots[1], roots[2]);
  for (int i = 0; i < 3; i++) {
    yyjson_doc_free(docs[i]);
  }
  if (result == nullptr) {
    if (merger.internal() || !merger.failed()) {
      *error = "mergeEditor internal error";
      return false;
    }
    // 业务级不可表达：返回 ok:false 由调用方回落明文双写路径（合并失败不等于同步失败）
    const std::string json = "{\"ok\":false,\"reason\":\"" + merger.reason() + "\"}";
    out->assign(json.begin(), json.end());
    return true;
  }

  size_t jsonLen = 0;
  yyjson_write_err writeErr;
  char* json = yyjson_mut_write_opts(result, YYJSON_WRITE_NOFLAG, nullptr, &jsonLen, &writeErr);
  if (json == nullptr) {
    yyjson_mut_doc_free(result);
    *error = std::string("mergeEditor serialize failed: ") +
             (writeErr.msg != nullptr ? writeErr.msg : "unknown");
    return false;
  }
  const bool tooLarge = static_cast<uint64_t>(jsonLen) > kMaxInput;
  if (!tooLarge) {
    out->assign(reinterpret_cast<uint8_t*>(json), reinterpret_cast<uint8_t*>(json) + jsonLen);
  }
  free(json);
  yyjson_mut_doc_free(result);
  if (tooLarge) {
    const std::string fallback = "{\"ok\":false,\"reason\":\"too-large\"}";
    out->assign(fallback.begin(), fallback.end());
  }
  return true;
}

}  // namespace slinote_history
