#!/usr/bin/env node
/**
 * ELF 产物的 glibc 依赖下限守卫（Linux 原生模块打包前校验）
 *
 * 背景：
 * - muhammara binding.node 由 CI 现场编译（scripts/build-muhammara.mjs）。若构建机的 glibc
 *   过新（如 ubuntu-latest = Ubuntu 24.04 / glibc 2.39），产物会硬依赖 GLIBC_2.38
 *   （C23 重定向符号 __isoc23_strtoll / __isoc23_strtoul 等）
 * - 该依赖在用户侧是硬失败：动态链接器加载 native 模块时直接报
 *   `version 'GLIBC_2.38' not found`，PDF 合并 worker 起不来，`.part` 被清理 → 导出后
 *   目录里不存在任何文件，而应用主体（Electron 本体只需 GLIBC_2.25）一切正常
 * - 因此发布前必须断言产物要求的 glibc 版本不超过基线（当前基线 = 构建容器 glibc 2.31）
 *
 * 实现：直接解析 ELF64 小端的 `.gnu.version_r`（SHT_GNU_verneed）段，不依赖 readelf，
 * 因此在 macOS 上也能对 Linux 产物做校验。
 *
 * 用法：
 *   node scripts/check-glibc.mjs native/muhammara/binding.node [--max=2.31]
 *
 * 退出码：0 = 未超限或非 ELF（跳过）；1 = 超限或参数/解析错误
 */
import fs from 'node:fs';

const SHT_GNU_VERNEED = 0x6ffffffe;
const ELF_MAGIC = 0x7f454c46;

const argv = process.argv.slice(2);
const maxArg = argv.find((arg) => arg.startsWith('--max='));
const file = argv.find((arg) => !arg.startsWith('--'));

if (!file) {
  console.error('[check-glibc] 用法：node scripts/check-glibc.mjs <elf 文件> [--max=2.31]');
  process.exit(1);
}

const limitText = maxArg ? maxArg.slice('--max='.length) : '2.31';
if (!/^\d+\.\d+$/.test(limitText)) {
  console.error(`[check-glibc] 上限格式非法：${limitText}（期望形如 2.31）`);
  process.exit(1);
}
const limit = limitText.split('.').map(Number);

/**
 * 版本号比较（仅 major.minor）
 */
function compare(left, right) {
  return left[0] - right[0] || left[1] - right[1];
}

/**
 * 解析 ELF64 小端产物的动态依赖版本需求名；非 ELF 返回 null
 */
function readVersionNeeds(buffer) {
  if (buffer.length < 64 || buffer.readUInt32BE(0) !== ELF_MAGIC) {
    return null;
  }
  if (buffer[4] !== 2) {
    throw new Error('仅支持 64 位 ELF');
  }
  if (buffer[5] !== 1) {
    throw new Error('仅支持小端 ELF');
  }
  const sectionOffset = Number(buffer.readBigUInt64LE(0x28));
  const sectionEntrySize = buffer.readUInt16LE(0x3a);
  const sectionCount = buffer.readUInt16LE(0x3c);
  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const at = sectionOffset + i * sectionEntrySize;
    sections.push({
      type: buffer.readUInt32LE(at + 4),
      offset: Number(buffer.readBigUInt64LE(at + 0x18)),
      size: Number(buffer.readBigUInt64LE(at + 0x20)),
      link: buffer.readUInt32LE(at + 0x28)
    });
  }
  /** 从指定段的字符串表读一个以 NUL 结尾的名称 */
  const readString = (sectionIndex, offset) => {
    const section = sections[sectionIndex];
    if (!section) {
      return '';
    }
    const start = section.offset + offset;
    const end = Math.min(section.offset + section.size, buffer.length);
    let stop = start;
    while (stop < end && buffer[stop] !== 0) {
      stop++;
    }
    return buffer.toString('utf8', start, stop);
  };
  const names = [];
  for (const section of sections) {
    if (section.type !== SHT_GNU_VERNEED) {
      continue;
    }
    /**
     * Verneed / Vernaux 均为单链表，偏移语义容易踩坑：
     * - vn_aux / vn_next 相对「当前 Verneed 条目」起点
     * - vna_next 相对「当前 Vernaux 条目」起点
     * 0 表示链表结束
     */
    let needOffset = 0;
    while (needOffset < section.size) {
      const at = section.offset + needOffset;
      const auxOffset = buffer.readUInt32LE(at + 8);
      const nextOffset = buffer.readUInt32LE(at + 12);
      let auxAt = at + auxOffset;
      for (;;) {
        const name = readString(section.link, buffer.readUInt32LE(auxAt + 8));
        if (name) {
          names.push(name);
        }
        const auxNext = buffer.readUInt32LE(auxAt + 12);
        if (!auxNext) {
          break;
        }
        auxAt += auxNext;
      }
      if (!nextOffset) {
        break;
      }
      needOffset += nextOffset;
    }
  }
  return names;
}

let needs;
try {
  needs = readVersionNeeds(fs.readFileSync(file));
} catch (error) {
  console.error(`[check-glibc] 解析失败：${error.message}`);
  process.exit(1);
}

if (!needs) {
  console.log(`[check-glibc] 跳过（非 ELF 产物）：${file}`);
  process.exit(0);
}

/** 只取 glibc 自身的版本需求（同段内还可能有 GLIBCXX_ / CXXABI_） */
const glibcVersions = [...new Set(needs.filter((name) => /^GLIBC_\d+\.\d+$/.test(name)))].sort((a, b) => {
  return compare(a.slice('GLIBC_'.length).split('.').map(Number), b.slice('GLIBC_'.length).split('.').map(Number));
});

if (!glibcVersions.length) {
  console.log(`[check-glibc] 跳过（无 glibc 版本需求记录）：${file}`);
  process.exit(0);
}

const highest = glibcVersions[glibcVersions.length - 1].slice('GLIBC_'.length).split('.').map(Number);
console.log(`[check-glibc] ${file}`);
console.log(`[check-glibc] glibc 版本需求：${glibcVersions.join(' ')}`);
console.log(`[check-glibc] 最高需求：GLIBC_${highest.join('.')}（允许上限 ${limitText}）`);

if (compare(highest, limit) > 0) {
  console.error(
    `[check-glibc] 产物依赖 glibc ${highest.join('.')}，超过上限 ${limitText}：旧发行版（Ubuntu 22.04 / Debian 12 / UOS 等）`
    + '加载该模块会直接失败。请在 glibc 更旧的构建环境（容器）中重新编译后再打包'
  );
  process.exit(1);
}
