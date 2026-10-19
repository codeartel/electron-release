#!/usr/bin/env node
/**
 * 时间机器原生内核黄金向量生成（跨端一致性回归）
 *
 * 用途：
 * - 桌面（本脚本，x64/arm64 mac 等）用 native/history/binding.node 跑一组确定性用例，
 *   生成期望输出向量（base64 编码的二进制 + 错误信息）
 * - Android 侧以同源内核（JNI）跑同一向量集逐字节比对（androidTest）
 * - 内核重构/升级时重跑本脚本，向量差异必须逐字节可控（否则即为跨端漂移）
 *
 * 用法：
 *   node scripts/gen-history-vectors.mjs [输出路径]
 *   默认输出：native/history/history-golden-vectors.json
 *
 * 说明：
 * - 输入全部确定性（固定种子伪随机），向量文件可直接入库（android 侧测试资源）
 * - 仅收录内核级行为（成功输出 / 内核错误信息）；JS 参数类型错误不属于内核契约
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const addonPath = path.join(rootDir, 'native', 'history', 'binding.node');
const outPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(rootDir, 'native', 'history', 'history-golden-vectors.json');

const addon = require(addonPath);

const enc = (buf) => Buffer.from(buf).toString('base64');
const txt = (s) => Buffer.from(s, 'utf8');

/** 固定种子 LCG 伪随机字节（跨平台确定性） */
function prngBytes(len, seed) {
  const out = Buffer.alloc(len);
  let state = seed >>> 0;
  for (let i = 0; i < len; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

const cases = [];
const push = (name, fn, args, expect) => cases.push({ name, fn, args, expect });

function runPatch(name, oldBuf, nextBuf, level = null) {
  const args = { old: enc(oldBuf), next: enc(nextBuf), level };
  let result;
  try {
    result = level == null ? addon.patch(oldBuf, nextBuf) : addon.patch(oldBuf, nextBuf, level);
  } catch (error) {
    push(name, 'patch', args, { error: error.message });
    return;
  }
  if (result.type === 0) {
    push(name, 'patch', args, { type: 0 });
    return;
  }
  push(name, 'patch', args, { type: 1, data: enc(result.data) });
  // 同步登记 apply 往返用例（base=old，delta=payload → next）
  runApply(`${name} > apply`, oldBuf, result.data, nextBuf);
}

function runApply(name, baseBuf, deltaBuf, expectBuf) {
  const args = { base: enc(baseBuf), delta: enc(deltaBuf) };
  try {
    const out = addon.apply(baseBuf, deltaBuf);
    if (expectBuf != null && !out.equals(expectBuf)) {
      throw new Error(`apply 输出与预期不一致（${out.length} != ${expectBuf.length}）`);
    }
    push(name, 'apply', args, { data: enc(out) });
  } catch (error) {
    push(name, 'apply', args, { error: error.message });
  }
}

function runCompress(name, dataBuf, level = null) {
  const args = { data: enc(dataBuf), level };
  try {
    const out = level == null ? addon.compress(dataBuf) : addon.compress(dataBuf, level);
    push(name, 'compress', args, { data: enc(out) });
    // 往返用例：缺省 maxSize（null），并加验输出与原始明文一致
    runDecompress(`${name} > decompress`, out, null, dataBuf);
    return out;
  } catch (error) {
    push(name, 'compress', args, { error: error.message });
    return null;
  }
}

function runDecompress(name, dataBuf, maxSize = null, expectBuf = null) {
  const args = { data: enc(dataBuf), maxSize };
  try {
    const out = maxSize == null ? addon.decompress(dataBuf) : addon.decompress(dataBuf, maxSize);
    if (expectBuf != null && !out.equals(expectBuf)) {
      throw new Error(`decompress 输出与预期不一致`);
    }
    push(name, 'decompress', args, { data: enc(out) });
  } catch (error) {
    push(name, 'decompress', args, { error: error.message });
  }
}

function runDiffJson(name, aBuf, bBuf) {
  const args = { a: enc(aBuf), b: enc(bBuf) };
  try {
    const out = addon.diffJson(aBuf, bBuf);
    JSON.parse(out.toString('utf8')); // 自检：输出必须是合法 JSON
    push(name, 'diffJson', args, { data: enc(out) });
  } catch (error) {
    push(name, 'diffJson', args, { error: error.message });
  }
}

// ---------------------------------------------------------------------------
// patch / apply：字节级增量（前缀字典）全形态
// ---------------------------------------------------------------------------
runPatch('patch/identical-empty', Buffer.alloc(0), Buffer.alloc(0));
runPatch('patch/identical-small', txt('hello 世界'), txt('hello 世界'));
runPatch('patch/identical-large', prngBytes(65536, 7), prngBytes(65536, 7));
runPatch('patch/append', txt('hello'), txt('hello world'));
runPatch('patch/prepend', txt('world'), txt('hello world'));
runPatch('patch/truncate', txt('hello world'), txt('hello'));
runPatch('patch/middle-replace', txt('hello world'), txt('hello brave world'));
runPatch('patch/prefix-suffix-overlap', txt('aaa'), txt('aa'));
runPatch('patch/repeat-pattern', txt('abab'), txt('ababab'));
runPatch('patch/single-byte-diff', prngBytes(1000, 11), (() => {
  const a = prngBytes(1000, 11);
  const b = Buffer.from(a);
  b[500] ^= 0xff;
  return b;
})());
runPatch('patch/empty-old', Buffer.alloc(0), txt('{"title":"新文档"}'));
runPatch('patch/empty-next', txt('{"title":"旧文档"}'), Buffer.alloc(0));
runPatch('patch/binary-null-bytes', Buffer.concat([Buffer.from([0, 0, 1, 2]), prngBytes(64, 21), Buffer.from([0, 0])]), Buffer.concat([Buffer.from([0, 0, 1, 2]), prngBytes(64, 22), Buffer.from([0, 0, 9])]));
runPatch('patch/unicode', txt('第一行：时间机器\n第二行：快照与增量'), txt('第一行：时间机器\n第二行：快照与增量与墓碑\n第三行：move'));
runPatch('patch/json-note-small-change', txt(JSON.stringify({ id: 'n1', title: '周报', content: '本周完成 A/B/C', tags: ['work'], updatedAt: 1000 })), txt(JSON.stringify({ id: 'n1', title: '周报（终稿）', content: '本周完成 A/B/C 与 D', tags: ['work', 'weekly'], updatedAt: 2000 })));

const bigBase = prngBytes(131072, 31);
const bigEdited = Buffer.from(bigBase);
bigEdited.write('EDITED-REGION-БЛА', 60000);
runPatch('patch/large-small-edit', bigBase, bigEdited);
runPatch('patch/large-all-diff', prngBytes(131072, 41), prngBytes(131072, 42));

runPatch('patch/level-1', txt('0123456789'.repeat(128)), txt('0123456789'.repeat(128) + 'tail'), 1);
runPatch('patch/level-22', txt('0123456789'.repeat(128)), txt('X' + '0123456789'.repeat(128)), 22);
runPatch('patch/level-clamp-low', txt('content-a'.repeat(64)), txt('content-b'.repeat(64)), 0);
runPatch('patch/level-clamp-high', txt('content-a'.repeat(64)), txt('content-b'.repeat(64)), 99);
runPatch('patch/level-negative', txt('abc'.repeat(64)), txt('abd'.repeat(64)), -3);

// apply 错误形态（内核级）
runApply('apply/error-too-short', txt('abc'), Buffer.from([1, 2, 3]), null);
runApply('apply/error-prefix-out-of-range', txt('abc'), Buffer.concat([
  (() => { const b = Buffer.alloc(4); b.writeUInt32LE(1000, 0); return b; })(),
  (() => { const b = Buffer.alloc(4); b.writeUInt32LE(0, 0); return b; })(),
  Buffer.from('zzzz')
]), null);
runApply('apply/error-corrupt-frame', txt('abc'), Buffer.concat([
  (() => { const b = Buffer.alloc(4); b.writeUInt32LE(0, 0); return b; })(),
  (() => { const b = Buffer.alloc(4); b.writeUInt32LE(0, 0); return b; })(),
  Buffer.from('not-a-zstd-frame')
]), null);

// ---------------------------------------------------------------------------
// compress / decompress：普通 zstd 帧
// ---------------------------------------------------------------------------
runCompress('compress/text-default', txt('快照载荷：'.repeat(100)));
runCompress('compress/text-level-1', txt('快照载荷：'.repeat(100)), 1);
runCompress('compress/text-level-19', txt('快照载荷：'.repeat(100)), 19);
runCompress('compress/empty', Buffer.alloc(0));
runCompress('compress/large-64k', prngBytes(65536, 51));

(() => {
  const frame = addon.compress(txt('x'.repeat(1000)));
  const args = { data: enc(frame), maxSize: 10 };
  let message = null;
  try {
    addon.decompress(frame, 10);
  } catch (error) {
    message = error.message;
  }
  if (message == null) {
    throw new Error('decompress maxSize 用例未按预期失败');
  }
  push('decompress/error-exceeds-max', 'decompress', args, { error: message });
})();
runDecompress('decompress/error-corrupt', Buffer.from('garbage-frame'), null, null);

// ---------------------------------------------------------------------------
// diffJson：RFC 6902 语义差分
// ---------------------------------------------------------------------------
const J = (value) => txt(JSON.stringify(value));

runDiffJson('diffJson/identical', J({ a: 1, b: [1, 2] }), J({ a: 1, b: [1, 2] }));
runDiffJson('diffJson/scalar-change', J({ a: 1 }), J({ a: 2 }));
runDiffJson('diffJson/object-add-remove-replace', J({ keep: 1, drop: 'x', same: true }), J({ keep: 2, add: 'y', same: true }));
runDiffJson('diffJson/type-change', J({ v: 1 }), J({ v: '1' }));
runDiffJson('diffJson/nested', J({ doc: { blocks: { b1: { text: 'a' } }, meta: { v: 3 } } }), J({ doc: { blocks: { b1: { text: 'b' }, b2: { text: '' } }, meta: { v: 3 } } }));
runDiffJson('diffJson/array-id-reorder', J({ list: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'c', v: 3 }] }), J({ list: [{ id: 'c', v: 3 }, { id: 'a', v: 1 }, { id: 'b', v: 2 }] }));
runDiffJson('diffJson/array-id-insert-remove', J({ list: [{ id: 'a' }, { id: 'b' }] }), J({ list: [{ id: 'b' }, { id: 'd' }] }));
runDiffJson('diffJson/array-id-content-change', J({ list: [{ id: 'a', v: 1, t: 'x' }, { id: 'b', v: 2 }] }), J({ list: [{ id: 'a', v: 9, t: 'x' }, { id: 'b', v: 2 }] }));
runDiffJson('diffJson/array-mixed', J({ list: [{ id: 'a', v: 1 }, 'plain', 42] }), J({ list: ['plain', { id: 'a', v: 2 }, 42, { id: 'n', v: 0 }] }));
runDiffJson('diffJson/array-scalars', J({ list: [1, 2, 3] }), J({ list: [1, 9, 3, 4] }));
runDiffJson('diffJson/keys-escape', J({ 'a/b': 1, 'c~d': 2 }), J({ 'a/b': 3, 'c~d': 2, 'e/f~g': 4 }));
runDiffJson('diffJson/numbers-double-semantics', J({ a: 1, b: 2.5 }), J({ a: 1.0, b: 3 }));
runDiffJson('diffJson/unicode', J({ t: '标题：回忆', list: ['α', 'β'] }), J({ t: '标题：回忆 II', list: ['β', 'α'] }));
runDiffJson('diffJson/deep-nesting', (() => {
  const build = (v, depth) => {
    let node = { v };
    for (let i = 0; i < depth; i++) node = { child: node };
    return node;
  };
  return J(build(1, 100));
})(), (() => {
  const build = (v, depth) => {
    let node = { v };
    for (let i = 0; i < depth; i++) node = { child: node };
    return node;
  };
  return J(build(2, 100));
})());
runDiffJson('diffJson/error-invalid-json', txt('not-json'), J({ a: 1 }));

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const vectors = {
  format: 'slinote-history-golden',
  formatVersion: 1,
  zstdVersion: addon.version(),
  caseCount: cases.length,
  cases
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(vectors, null, 2) + '\n');
console.log(`[gen-history-vectors] 已生成 ${cases.length} 个用例：${outPath}`);
console.log(`[gen-history-vectors] zstd ${vectors.zstdVersion}`);
