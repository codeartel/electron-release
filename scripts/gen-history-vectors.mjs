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
// mergeEditor：编辑器文档树三方合并（输入为整份 state 明文，输出为内核 JSON）
// ---------------------------------------------------------------------------
function runMergeEditor(name, baseValue, localValue, remoteValue, verify) {
  const toBuf = (value) => (Buffer.isBuffer(value) ? value : txt(JSON.stringify(value)));
  const args = { base: enc(toBuf(baseValue)), local: enc(toBuf(localValue)), remote: enc(toBuf(remoteValue)) };
  let out;
  try {
    out = addon.mergeEditor(toBuf(baseValue), toBuf(localValue), toBuf(remoteValue));
  } catch (error) {
    push(name, 'mergeEditor', args, { error: error.message });
    return;
  }
  const parsed = JSON.parse(out.toString('utf8')); // 自检：输出必须是合法 JSON
  // verify 放在 try 外：用例断言写错时要当场报错，不能降级成一条「error 期望」的错误黄金用例
  if (verify) {
    verify(parsed);
  }
  push(name, 'mergeEditor', args, { data: enc(out) });
}

/** 造节点：id + type + 一个文本子项 */
const MNode = (id, text, extra = {}) => ({
  id,
  type: 'paragraph',
  props: { uid: `u${id}` },
  children: [text],
  ...extra
});
/** 造文本节点（可带额外 props） */
const MText = (id, text, props = {}) => ({ id, type: 'text', props: { uid: `u${id}`, ...props }, children: [text] });
/** 造整份 state 明文（/data 子树 + uids 容器） */
const MState = (...children) => ({ data: { id: 'root', type: 'root', children }, uids: {} });

runMergeEditor('mergeEditor/identical', MState(MNode('a', 'x')), MState(MNode('a', 'x')), MState(MNode('a', 'x')));
runMergeEditor('mergeEditor/local-only', MState(MNode('a', 'base')), MState(MNode('a', 'local')), MState(MNode('a', 'base')));
runMergeEditor('mergeEditor/remote-only', MState(MNode('a', 'base')), MState(MNode('a', 'base')), MState(MNode('a', 'remote')));
runMergeEditor('mergeEditor/both-same', MState(MNode('a', 'base')), MState(MNode('a', 'next')), MState(MNode('a', 'next')));
runMergeEditor('mergeEditor/text-non-overlap', MState(MNode('a', 'hello world')), MState(MNode('a', 'HELLO world')), MState(MNode('a', 'hello WORLD')));
runMergeEditor('mergeEditor/text-overlap', MState(MNode('a', 'hello world')), MState(MNode('a', 'goodbye world')), MState(MNode('a', 'hello earth')));
runMergeEditor('mergeEditor/text-insert-same-point', MState(MNode('a', 'ab')), MState(MNode('a', 'aXb')), MState(MNode('a', 'aYb')));
runMergeEditor('mergeEditor/local-delete-remote-edit', MState(MNode('a', 'base')), MState(), MState(MNode('a', 'remote')));
runMergeEditor('mergeEditor/local-edit-remote-delete', MState(MNode('a', 'base')), MState(MNode('a', 'local')), MState());
runMergeEditor('mergeEditor/both-delete', MState(MNode('a', 'base'), MNode('b', 'keep')), MState(MNode('b', 'keep')), MState(MNode('b', 'keep')));
runMergeEditor(
  'mergeEditor/both-add-different',
  MState(MNode('a', 'x')),
  MState(MNode('a', 'x'), MNode('b', 'lb')),
  MState(MNode('a', 'x'), MNode('c', 'rc'))
);
runMergeEditor('mergeEditor/both-add-same-id', MState(), MState(MNode('b', 'lb')), MState(MNode('b', 'rb')));
runMergeEditor(
  'mergeEditor/local-add-only',
  MState(MNode('a', 'x')),
  MState(MNode('a', 'x'), MNode('b', 'lb')),
  MState(MNode('a', 'x'))
);
runMergeEditor(
  'mergeEditor/children-reorder',
  MState(MNode('a', 'x'), MNode('b', 'y')),
  MState(MNode('b', 'y'), MNode('a', 'x')),
  MState(MNode('a', 'x'), MNode('b', 'y'))
);
runMergeEditor(
  'mergeEditor/props-both-changed',
  MState(MNode('a', 'x', { props: { uid: 'ua', color: 'base' } })),
  MState(MNode('a', 'x', { props: { uid: 'ua', color: 'local' } })),
  MState(MNode('a', 'x', { props: { uid: 'ua', color: 'remote' } }))
);
runMergeEditor(
  'mergeEditor/style-both-changed',
  MState(MNode('a', 'x', { style: { color: '#111' } })),
  MState(MNode('a', 'x', { style: { color: '#222' } })),
  MState(MNode('a', 'x', { style: { color: '#333' } }))
);
runMergeEditor(
  'mergeEditor/props-expand-local',
  MState(MNode('a', 'x', { props: { uid: 'ua', expand: true } })),
  MState(MNode('a', 'x', { props: { uid: 'ua', expand: false } })),
  MState(MNode('a', 'x', { props: { uid: 'ua', expand: true } }))
);
runMergeEditor(
  'mergeEditor/props-and-children',
  MState(MNode('a', 'x', { props: { uid: 'ua', level: 1 } })),
  MState(MNode('a', 'x', { props: { uid: 'ua', level: 2 } })),
  MState(MNode('a', 'y', { props: { uid: 'ua', level: 1 } }))
);
runMergeEditor(
  'mergeEditor/type-conflict',
  MState(MNode('a', 'x')),
  MState(MNode('a', 'x', { type: 'h1' })),
  MState(MNode('a', 'x', { type: 'h2' }))
);
runMergeEditor(
  'mergeEditor/sheet-cells',
  MState({ id: 's1', type: 'sheet', children: [{ id: 'r1', type: 'row', children: [MText('c1', 'v1'), MText('c2', 'w1')] }] }),
  MState({ id: 's1', type: 'sheet', children: [{ id: 'r1', type: 'row', children: [MText('c1', 'v2'), MText('c2', 'w1')] }] }),
  MState({ id: 's1', type: 'sheet', children: [{ id: 'r1', type: 'row', children: [MText('c1', 'v1'), MText('c2', 'w2')] }] })
);
runMergeEditor(
  'mergeEditor/sheet-cell-conflict',
  MState({ id: 's1', type: 'sheet', children: [{ id: 'r1', type: 'row', children: [MText('c1', 'v1')] }] }),
  MState({ id: 's1', type: 'sheet', children: [{ id: 'r1', type: 'row', children: [MText('c1', 'va')] }] }),
  MState({ id: 's1', type: 'sheet', children: [{ id: 'r1', type: 'row', children: [MText('c1', 'vb')] }] })
);
runMergeEditor(
  'mergeEditor/deep-tree',
  MState({ id: 'n1', type: 'list', children: [{ id: 'n2', type: 'item', children: [{ id: 'n3', type: 'paragraph', children: [MText('t1', 'deep base')] }] }] }),
  MState({ id: 'n1', type: 'list', children: [{ id: 'n2', type: 'item', children: [{ id: 'n3', type: 'paragraph', children: [MText('t1', 'deep local')] }] }] }),
  MState({ id: 'n1', type: 'list', children: [{ id: 'n2', type: 'item', children: [{ id: 'n3', type: 'paragraph', children: [MText('t1', 'deep remote')] }] }] })
);
runMergeEditor('mergeEditor/inline-string-children', MState({ id: 'p1', type: 'paragraph', children: ['plain base'] }), MState({ id: 'p1', type: 'paragraph', children: ['plain local'] }), MState({ id: 'p1', type: 'paragraph', children: ['plain remote'] }));

// 文本冲突且合并结果为空：必须落空串占位，否则 diff 的 index 越界、前端定位失败静默丢弃
runMergeEditor(
  'mergeEditor/text-conflict-empty-result',
  MState({ id: 'p1', type: 'paragraph', children: [{ id: 's1', type: 'span', children: ['x y z'] }] }),
  MState({ id: 'p1', type: 'paragraph', children: [{ id: 's1', type: 'span', children: ['ab'] }] }),
  MState({ id: 'p1', type: 'paragraph', children: [{ id: 's1', type: 'span', children: [''] }] }),
  (out) => {
    const kids = out.data?.children?.[0]?.children?.[0]?.children;
    if (out.ok !== true || out.conflicts?.length !== 1 || out.conflicts[0].action !== 'diff' ||
        kids?.length !== 1 || kids[0] !== '' || out.conflicts[0].index !== 0) {
      throw new Error(`文本冲突合并结果为空时必须留下可定位的空串占位：${JSON.stringify(out).slice(0, 240)}`);
    }
  }
);

// 节点内 key 冲突整节点回退 replace 时，子树已产出的 diff 必须撤销（否则前端双层包装、重复裁决）
runMergeEditor(
  'mergeEditor/props-conflict-swallows-child-diff',
  MState(MNode('a', 'base', { props: { uid: 'ua', color: 'black' } })),
  MState(MNode('a', 'local', { props: { uid: 'ua', color: 'red' } })),
  MState(MNode('a', 'remote', { props: { uid: 'ua', color: 'blue' } })),
  (out) => {
    const node = out.data?.children?.[0];
    if (out.ok !== true || out.conflicts?.length !== 1 || out.conflicts[0].action !== 'replace' ||
        node?.props?.color !== 'blue' || node?.children?.[0] !== 'remote') {
      throw new Error(`整节点回退只能留一条 replace，不得叠加子树 diff：${JSON.stringify(out).slice(0, 240)}`);
    }
  }
);

// 新增块锚定在「本轮被删掉的文本段」之后：不能退化到同级最前面
runMergeEditor(
  'mergeEditor/insert-anchored-on-deleted-text',
  MState(MNode('a', 'keep'), 'X'),
  MState(MNode('a', 'keep'), 'X', MNode('b', 'new')),
  MState(MNode('a', 'keep')),
  (out) => {
    const ids = (out.data?.children ?? []).map((child) => child.id ?? child);
    if (out.ok !== true || JSON.stringify(ids) !== JSON.stringify(['a', 'b'])) {
      throw new Error(`锚点被删后新增块应跟在最近存活兄弟之后：${JSON.stringify(out).slice(0, 240)}`);
    }
  }
);

// 同层重复身份（props.id 允许重复，如两个引用同一标题的块）：两侧各改一处都要保留
runMergeEditor(
  'mergeEditor/duplicate-props-id-changed-both',
  MState({ type: 'reference', props: { id: 'h1', tag: 'base' } }, { type: 'reference', props: { id: 'h1', tag: 'base' } }),
  MState({ type: 'reference', props: { id: 'h1', tag: 'local' } }, { type: 'reference', props: { id: 'h1', tag: 'base' } }),
  MState({ type: 'reference', props: { id: 'h1', tag: 'base' } }, { type: 'reference', props: { id: 'h1', tag: 'remote' } }),
  (out) => {
    const tags = (out.data?.children ?? []).map((child) => child.props?.tag);
    if (out.ok !== true || out.conflicts?.length !== 0 || JSON.stringify(tags) !== JSON.stringify(['local', 'remote'])) {
      throw new Error(`同层重复身份的两个兄弟各自的改动都必须保留：${JSON.stringify(out).slice(0, 240)}`);
    }
  }
);

// 无 id 文本段错位：一侧在段前插入裸字符串，组内序号整体后移，base 原文会被错配成「被改写」
// （合并结果里原文消失，前端二选一必丢一侧内容）；无 id 前提下无法可靠对齐，判不可表达回落人工
runMergeEditor(
  'mergeEditor/text-segment-shift-unexpressible',
  MState({ id: 'p1', type: 'paragraph', children: ['T'] }),
  MState({ id: 'p1', type: 'paragraph', children: ['X', 'T'] }),
  MState({ id: 'p1', type: 'paragraph', children: ['T', 'Y'] }),
  (out) => {
    if (out.ok !== false || out.reason !== 'shape-conflict') {
      throw new Error(`文本段错位无法对齐，应回落 shape-conflict：${JSON.stringify(out).slice(0, 240)}`);
    }
  }
);

// 同层重复身份一侧删/增一个兄弟：序号键整体偏移，配对不可信，故只降级该 id 的配对
// （落 replace、多余副本原样保留），不再把整份合并判成不可表达
runMergeEditor(
  'mergeEditor/duplicate-identity-count-drift',
  MState({ type: 'reference', props: { id: 'h1', tag: 'a' } }, { type: 'reference', props: { id: 'h1', tag: 'b' } }),
  MState({ type: 'reference', props: { id: 'h1', tag: 'b' } }),
  MState({ type: 'reference', props: { id: 'h1', tag: 'a' } }, { type: 'reference', props: { id: 'h1', tag: 'b2' } }),
  (out) => {
    const tags = (out.data?.children ?? []).map((child) => child.props?.tag);
    const conflicts = out.conflicts ?? [];
    if (out.ok !== true || conflicts.length !== 1 || conflicts[0].action !== 'replace' ||
        conflicts[0].id !== 'h1' || conflicts[0].local?.props?.tag !== 'b' ||
        JSON.stringify(tags) !== JSON.stringify(['a', 'b2'])) {
      throw new Error(`同层重复身份数量漂移应降级为单条 replace 并保留多余副本：${JSON.stringify(out).slice(0, 240)}`);
    }
  }
);

// 降级只能作用于出问题的 id：同层其它子项照常自动合并，重复块不牵连整篇
runMergeEditor(
  'mergeEditor/duplicate-identity-degrades-locally',
  MState(MNode('p1', 'base'), { type: 'reference', props: { id: 'h1', tag: 'a' } }),
  MState(
    MNode('p1', 'local'),
    { type: 'reference', props: { id: 'h1', tag: 'a' } },
    { type: 'reference', props: { id: 'h1', tag: 'clone' } }
  ),
  MState(MNode('p1', 'base'), { type: 'reference', props: { id: 'h1', tag: 'a' } }),
  (out) => {
    const children = out.data?.children ?? [];
    const tags = children.filter((child) => child.props?.id === 'h1').map((child) => child.props?.tag);
    if (out.ok !== true || (out.conflicts ?? []).length !== 0 ||
        children[0]?.children?.[0] !== 'local' || JSON.stringify(tags) !== JSON.stringify(['a', 'clone'])) {
      throw new Error(`重复块之外的同层子项必须照常自动合并：${JSON.stringify(out).slice(0, 240)}`);
    }
  }
);

// 跨父节点移动 + 原处修改：结果会复制出两份同 id，协议表达不了，必须回落人工
runMergeEditor(
  'mergeEditor/move-vs-edit-across-parents',
  MState(
    { id: 'd1', type: 'div', children: [MNode('b', 'old')] },
    { id: 'd2', type: 'div', children: [MNode('c', 'keep')] }
  ),
  MState(
    { id: 'd1', type: 'div', children: [] },
    { id: 'd2', type: 'div', children: [MNode('c', 'keep'), MNode('b', 'local')] }
  ),
  MState(
    { id: 'd1', type: 'div', children: [MNode('b', 'remote')] },
    { id: 'd2', type: 'div', children: [MNode('c', 'keep')] }
  ),
  (out) => {
    if (out.ok !== false || out.reason !== 'dup-id') {
      throw new Error(`跨父节点移动无法用描述符表达，应回落 dup-id：${JSON.stringify(out).slice(0, 240)}`);
    }
  }
);

// 远端把壳里唯一子节点取走挂到别处、壳因此变空被删 + 本地只删了被取走项里的空文本段：
// 壳跟着远端删除（不落地），被取走项落一条 replace，新位置那份（远端版）成为结果里唯一一份
runMergeEditor(
  'mergeEditor/move-child-out-of-husk-degrades',
  MState(
    { id: 'd1', type: 'div', children: [{ id: 's1', type: 'span', children: [''] }] },
    MNode('d2', 'keep')
  ),
  MState(
    { id: 'd1', type: 'div', children: [{ id: 's1', type: 'span', children: [] }] },
    MNode('d2', 'keep')
  ),
  MState(MNode('d2', 'keep', { children: ['keep', { id: 's1', type: 'span', children: [''] }] })),
  (out) => {
    const kids = out.data?.children ?? [];
    const conflicts = out.conflicts ?? [];
    const occurrences = JSON.stringify(out.data ?? {}).split('"id":"s1"').length - 1;
    const d2 = kids.find((child) => child.id === 'd2');
    if (out.ok !== true || conflicts.length !== 1 || conflicts[0].action !== 'replace' ||
        conflicts[0].id !== 's1' || JSON.stringify(conflicts[0].local?.children) !== '[]' ||
        kids.some((child) => child.id === 'd1') || occurrences !== 1 || d2?.children?.[1]?.id !== 's1') {
      throw new Error(`壳被远端删除时应跟着删除、被取走项落 replace：${JSON.stringify(out).slice(0, 240)}`);
    }
  }
);

// 同上，但本地对壳里其它内容也改了：跟着删除会丢本地改动，故维持整份回落
runMergeEditor(
  'mergeEditor/move-child-out-of-husk-keeps-edit',
  MState(
    { id: 'd1', type: 'div', children: [{ id: 's1', type: 'span', children: [''] }, 'tail'] },
    MNode('d2', 'keep')
  ),
  MState(
    { id: 'd1', type: 'div', children: [{ id: 's1', type: 'span', children: [] }, 'tail-local'] },
    MNode('d2', 'keep')
  ),
  MState(MNode('d2', 'keep', { children: ['keep', { id: 's1', type: 'span', children: [''] }] })),
  (out) => {
    if (out.ok !== false || out.reason !== 'dup-id') {
      throw new Error(`壳里还有本地其它改动时不能跟着远端删除，应回落 dup-id：${JSON.stringify(out).slice(0, 240)}`);
    }
  }
);

// 跨层重复身份（props.id 撞上另一处的同 id 父节点）+ 文本冲突：前端按 id 建「首个命中」索引
// 会定位到另一个父节点，diff 的 index 在错父节点上越界而被静默跳过，判不可表达
runMergeEditor(
  'mergeEditor/ambiguous-conflict-parent',
  MState(
    { id: 'h2', type: 'paragraph', props: { uid: 'u1' }, children: [{ id: 's1', type: 'span', children: ['ab'] }] },
    { id: 'd1', type: 'div', children: [{ type: 'paragraph', props: { id: 'h2', uid: 'u2' }, children: [{ id: 's2', type: 'span', children: ['cd'] }] }] }
  ),
  MState(
    { id: 'h2', type: 'paragraph', props: { uid: 'u1' }, children: [{ id: 's1', type: 'span', children: ['ab'] }] },
    { id: 'd1', type: 'div', children: [{ type: 'paragraph', props: { id: 'h2', uid: 'u2' }, children: [{ id: 's2', type: 'span', children: ['cd'] }, '测试'] }] }
  ),
  MState(
    { id: 'h2', type: 'paragraph', props: { uid: 'u1' }, children: [{ id: 's1', type: 'span', children: ['ab'] }] },
    { id: 'd1', type: 'div', children: [{ type: 'paragraph', props: { id: 'h2', uid: 'u2' }, children: [{ id: 's2', type: 'span', children: ['cd'] }, 'ab'] }] }
  ),
  (out) => {
    if (out.ok !== false || out.reason !== 'dup-id') {
      throw new Error(`冲突描述符的 parent 身份不唯一，应回落 dup-id：${JSON.stringify(out).slice(0, 240)}`);
    }
  }
);

// 无名子项（无 id 对象）：真实数据的列表项/decorate 节点即此形态，
// merged 里没有稳定 id 可定位冲突，故只接受「两侧同值 / 单侧改动」，双侧不同改动整文件回落
/** 造无名节点：无 id、无 props.id，只有 type + 无 id 的 span 子节点 */
const MUnnamed = (text) => ({ type: 'decorate-block-node', children: [{ type: 'span', children: [text] }] });
const pickUnnamedText = (out) => out.data.children[0].children[0].children[0];

runMergeEditor(
  'mergeEditor/unnamed-node-local-only',
  MState(MUnnamed('base')),
  MState(MUnnamed('local')),
  MState(MUnnamed('base')),
  (out) => {
    if (out.ok !== true || out.conflicts.length !== 0 || pickUnnamedText(out) !== 'local' || out.auto < 1) {
      throw new Error(`无名节点单侧改动应自动采用本地版本：${JSON.stringify(out).slice(0, 200)}`);
    }
  }
);
runMergeEditor(
  'mergeEditor/unnamed-node-remote-only',
  MState(MUnnamed('base')),
  MState(MUnnamed('base')),
  MState(MUnnamed('remote')),
  (out) => {
    if (out.ok !== true || out.conflicts.length !== 0 || pickUnnamedText(out) !== 'remote') {
      throw new Error(`无名节点单侧改动应自动采用远端版本：${JSON.stringify(out).slice(0, 200)}`);
    }
  }
);
runMergeEditor(
  'mergeEditor/unnamed-node-both-same',
  MState(MUnnamed('base')),
  MState(MUnnamed('next')),
  MState(MUnnamed('next')),
  (out) => {
    if (out.ok !== true || out.conflicts.length !== 0 || pickUnnamedText(out) !== 'next') {
      throw new Error(`无名节点两侧同值应直接采用：${JSON.stringify(out).slice(0, 200)}`);
    }
  }
);
runMergeEditor('mergeEditor/unnamed-node-both-changed', MState(MUnnamed('base')), MState(MUnnamed('local')), MState(MUnnamed('remote')));
runMergeEditor(
  'mergeEditor/unnamed-node-remote-delete',
  MState(MUnnamed('base'), MNode('b', 'keep')),
  MState(MUnnamed('base'), MNode('b', 'keep')),
  MState(MNode('b', 'keep')),
  (out) => {
    if (out.ok !== true || out.data.children.length !== 1 || out.data.children[0].id !== 'b') {
      throw new Error(`无名节点单侧删除且对侧未改（对称侧），应落地删除：${JSON.stringify(out).slice(0, 200)}`);
    }
  }
);
runMergeEditor('mergeEditor/unnamed-node-delete-vs-edit', MState(MUnnamed('base'), MNode('b', 'keep')), MState(MNode('b', 'keep')), MState(MUnnamed('remote'), MNode('b', 'keep')), (out) => {
  if (out.ok !== false || out.reason !== 'shape-conflict') {
    throw new Error(`无名节点一边删一边改属不可表达，应回落：${JSON.stringify(out).slice(0, 200)}`);
  }
});
runMergeEditor(
  'mergeEditor/unnamed-node-local-delete',
  MState(MUnnamed('base'), MNode('b', 'keep')),
  MState(MNode('b', 'keep')),
  MState(MUnnamed('base'), MNode('b', 'keep')),
  (out) => {
    if (out.ok !== true || out.data.children.length !== 1 || out.data.children[0].id !== 'b') {
      throw new Error(`无名节点单侧删除且对侧未改，应落地本地删除：${JSON.stringify(out).slice(0, 200)}`);
    }
  }
);
runMergeEditor(
  'mergeEditor/text-to-node-local-only',
  MState('plain text'),
  MState(MUnnamed('plain text')),
  MState('plain text'),
  (out) => {
    if (out.ok !== true || out.conflicts.length !== 0 || typeof out.data.children[0] !== 'object') {
      throw new Error(`文本提升为块（单侧）应自动采用：${JSON.stringify(out).slice(0, 200)}`);
    }
  }
);
runMergeEditor('mergeEditor/error-invalid-json', txt('not-json'), MState(), MState());
/** 缺 /data 根 = 业务级不可表达（不是内核故障）：必须回 ok:false 让宿主回落两方 diff */
runMergeEditor(
  'mergeEditor/no-data',
  { uids: {} },
  MState(MNode('a', 'local')),
  MState(MNode('a', 'remote')),
  (out) => {
    if (out.ok !== false || out.reason !== 'no-data') {
      throw new Error(`缺 data 根必须回 no-data：${JSON.stringify(out)}`);
    }
  }
);

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
