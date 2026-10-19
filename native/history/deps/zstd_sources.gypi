# 由 scripts/build-history.mjs 生成：zstd 源文件清单（不手工编辑）
# zstd v1.5.7
# 路径相对本 gypi 所在目录（gyp includes 语义：gypi 内相对路径以 gypi 目录为基准）
{
  'include_dirs': [ 'zstd/lib' ],
  'sources': [
    'zstd/lib/common/debug.c',
    'zstd/lib/common/entropy_common.c',
    'zstd/lib/common/error_private.c',
    'zstd/lib/common/fse_decompress.c',
    'zstd/lib/common/pool.c',
    'zstd/lib/common/threading.c',
    'zstd/lib/common/xxhash.c',
    'zstd/lib/common/zstd_common.c',
    'zstd/lib/compress/fse_compress.c',
    'zstd/lib/compress/hist.c',
    'zstd/lib/compress/huf_compress.c',
    'zstd/lib/compress/zstd_compress.c',
    'zstd/lib/compress/zstd_compress_literals.c',
    'zstd/lib/compress/zstd_compress_sequences.c',
    'zstd/lib/compress/zstd_compress_superblock.c',
    'zstd/lib/compress/zstd_double_fast.c',
    'zstd/lib/compress/zstd_fast.c',
    'zstd/lib/compress/zstd_lazy.c',
    'zstd/lib/compress/zstd_ldm.c',
    'zstd/lib/compress/zstd_opt.c',
    'zstd/lib/compress/zstd_preSplit.c',
    'zstd/lib/compress/zstdmt_compress.c',
    'zstd/lib/decompress/huf_decompress.c',
    'zstd/lib/decompress/zstd_ddict.c',
    'zstd/lib/decompress/zstd_decompress.c',
    'zstd/lib/decompress/zstd_decompress_block.c',
  ],
}
