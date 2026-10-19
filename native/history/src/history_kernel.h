/**
 * 时间机器（本地历史）跨端原生内核：zstd 前缀字典字节级增量 + RFC 6902 JSON 差分
 *
 * 本头文件声明纯 C++17 内核接口（无运行时绑定、无 IO）：
 * - 桌面：native/history/src/history.cc（N-API 胶水）调用
 * - Android：app/src/main/cpp/history/history_jni.cc（JNI 胶水）调用同一份实现
 * 两端绑定层只做参数解析与结果构造，行为逐字节一致（黄金向量回归）。
 */
#ifndef SLINOTE_HISTORY_KERNEL_H_
#define SLINOTE_HISTORY_KERNEL_H_

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace slinote_history {

/** 单次输入上限 64MB（与 JS/Kotlin 层约定一致） */
constexpr uint64_t kMaxInput = 64ull * 1024 * 1024;
/** 解压输出上限（防御损坏或恶意载荷导致的内存膨胀） */
constexpr uint64_t kMaxOutput = 256ull * 1024 * 1024;
/** 默认压缩级别（3~9 区间，可经参数覆盖；实际使用前钳制到 [1,22]） */
constexpr int kDefaultLevel = 6;
/** diffJson 递归深度上限（超限返回错误，由上层回落明文路径） */
constexpr int kMaxDiffDepth = 512;

/** patch 结果：type 0 = 完全相同（不落历史）；type 1 = 增量载荷（data） */
struct PatchResult {
  int type = 0;
  std::vector<uint8_t> data;
};

/** 内嵌 libzstd 版本号（黄金向量与缓存指纹用） */
const char* Version();

/**
 * 字节级增量：先判等、再前后缀裁剪、最后以「旧文件中段」为 zstd 前缀字典编码新文件中段。
 * 返回 false 时 error 填充原因（不抛异常，由绑定层映射为语言级错误）。
 */
bool Patch(const uint8_t* oldData, size_t oldLen,
           const uint8_t* nextData, size_t nextLen,
           int level, PatchResult* out, std::string* error);

/** 以 base 中段为前缀字典解码增量并拼回前后缀，得到新文件字节 */
bool Apply(const uint8_t* baseData, size_t baseLen,
           const uint8_t* deltaData, size_t deltaLen,
           std::vector<uint8_t>* out, std::string* error);

/** 普通 zstd 帧压缩（快照与池载荷使用，无字典） */
bool Compress(const uint8_t* data, size_t len, int level,
              std::vector<uint8_t>* out, std::string* error);

/** 普通 zstd 帧解压；maxSize 由调用方解析（缺省 = kMaxOutput） */
bool Decompress(const uint8_t* data, size_t len, uint64_t maxSize,
                std::vector<uint8_t>* out, std::string* error);

/**
 * JSON 语义差分：输出 RFC 6902 操作序列（UTF-8 JSON 文本；仅 add/remove/replace/move，
 * 顺序应用、就地生效）；带 id 对象按 id 锚定对齐数组，其余元素按位置对角配对
 */
bool DiffJson(const uint8_t* aData, size_t aLen,
              const uint8_t* bData, size_t bLen,
              std::vector<uint8_t>* out, std::string* error);

}  // namespace slinote_history

#endif  // SLINOTE_HISTORY_KERNEL_H_
