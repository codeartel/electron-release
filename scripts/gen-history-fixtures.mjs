#!/usr/bin/env node
/**
 * 时间机器跨端互读夹具生成（log.bin v2 双端互读回归）
 *
 * 用途：
 * - 桌面（本脚本）用 dist/history-worker.js 的引擎按「确定性场景脚本」写出一批
 *   log.bin 样本（快照/增量/联动 move/墓碑/重锚/尾部截断/段落通道），并跑一遍
 *   读接口（list/status/step/snapshot/read/readSegments），把结果逐字段落盘为期望
 * - Android 侧 androidTest 以同源引擎（Kotlin engine + JNI 内核）复制同一场景：
 *   正向：读桌面样本 → 与期望逐字段一致；
 *   反向：按同一场景重放捕获 → 与桌面样本 log.bin 逐字节一致 + 读结果一致
 *   （双向互读即契约：字节一致优先，行为一致兜底）
 *
 * 用法：
 *   node scripts/gen-history-fixtures.mjs [输出目录]
 *   默认输出：../android/app/src/androidTest/assets/history-fixtures/
 *
 * 说明：
 * - 场景使用生产默认参数（128/0.3/64/12），与 Android engine.kt 常量一致
 * - 时间/batchId 全部为固定常量；内容由固定种子伪随机生成（跨端确定性）
 * - 期望记录为「冷启动读到」的结果（Android 侧以新 basePath 首次触碰等价）
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const BUNDLE = path.join(rootDir, 'dist', 'history-worker.js');
const BINDING = path.join(rootDir, 'native', 'history', 'binding.node');
const outRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(rootDir, '..', 'android', 'app', 'src', 'androidTest', 'assets', 'history-fixtures');

if (!fs.existsSync(BUNDLE)) {
  console.error(`缺少构建产物：${BUNDLE}（请先执行 rollup 构建）`);
  process.exit(1);
}
if (!fs.existsSync(BINDING)) {
  console.error(`缺少原生绑定：${BINDING}（请先执行 node scripts/build-native.mjs --only history）`);
  process.exit(1);
}

/** 重新加载 bundle（模拟 worker 冷启动：一切内存缓存归零） */
function freshEngine() {
  delete require.cache[BUNDLE];
  const bundle = require(BUNDLE);
  return bundle.getEngine({ bindingPath: BINDING });
}

const b64 = (buf) => Buffer.from(buf).toString('base64');

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

const T0 = 1700000000000;

// ---------------------------------------------------------------------------
// 捕获脚本执行与读接口序列化
// ---------------------------------------------------------------------------

/** 按捕获计划写盘（engine = 捕获阶段引擎） */
async function runCaptures(engine, basePath, captures) {
  for (const cap of captures) {
    const data = Buffer.from(cap.data, 'base64');
    if (cap.op === 'captureEditor') {
      await engine.captureEditor(basePath, cap.id, data, cap.time, cap.batchId, cap.move ?? undefined);
    } else if (cap.op === 'captureEditorUnlink') {
      await engine.captureEditorUnlink(basePath, cap.id, data, cap.time, cap.batchId);
    } else if (cap.op === 'captureSegment') {
      await engine.captureSegment(basePath, cap.id, data, cap.time, cap.batchId);
    } else if (cap.op === 'undeleteEditor') {
      await engine.undeleteEditor(basePath, cap.id);
    } else {
      throw new Error(`未知捕获类型：${cap.op}`);
    }
  }
}

function serializeStep(step) {
  if (!step) {
    return null;
  }
  const out = { from: step.from, to: step.to, time: step.time, batchId: step.batchId };
  if (step.plain) {
    out.plain = b64(step.plain);
  }
  if (step.delta) {
    out.delta = b64(step.delta);
  }
  return out;
}

function serializeList(versions) {
  return versions.map((v) => ({
    rev: v.rev,
    time: v.time,
    batchId: v.batchId,
    type: v.type,
    plainSize: v.plainSize,
    storedSize: v.storedSize,
    abandoned: v.abandoned === true
  }));
}

/** 按读接口计划执行并记录期望（engine = 冷启动读阶段引擎） */
async function runOps(engine, basePath, ops) {
  const out = [];
  for (const op of ops) {
    const entry = { ...op };
    if (op.op === 'status') {
      const status = await engine.status(basePath, op.id);
      entry.expect = status ? { cursor: status.cursor, canUndo: status.canUndo, canRedo: status.canRedo } : null;
    } else if (op.op === 'step') {
      entry.expect = serializeStep(await engine.step(basePath, op.id, op.move, op.dirty === true, op.plainOnly === true));
    } else if (op.op === 'list') {
      entry.expect = serializeList(await engine.list(basePath, op.kind, op.id));
    } else if (op.op === 'snapshot') {
      const snap = await engine.snapshot(basePath, op.id, op.time, op.nearest === true);
      entry.expect = snap ? { rev: snap.rev, time: snap.time, batchId: snap.batchId, plain: b64(snap.plain) } : null;
    } else if (op.op === 'read') {
      const data = await engine.read(basePath, op.kind, op.id, op.time, op.batchId);
      entry.expect = data ? b64(data) : null;
    } else if (op.op === 'readSegments') {
      const entries = await engine.readSegments(basePath, op.segments);
      const data = {};
      for (const seg of op.segments) {
        const plain = entries ? entries[seg.id] : null;
        data[seg.id] = plain ? b64(plain) : null;
      }
      entry.expect = data;
    } else {
      throw new Error(`未知读接口：${op.op}`);
    }
    out.push(entry);
  }
  return out;
}

/** 拷贝 .history 工作区到场景 tree（保持 editor/<enc>/segment/<enc> 结构） */
function exportTree(basePath, treeDir) {
  fs.rmSync(treeDir, { recursive: true, force: true });
  fs.cpSync(path.join(basePath, '.history'), treeDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// 场景定义
// ---------------------------------------------------------------------------

const scenarios = [];
const pushScenario = (scenario) => scenarios.push(scenario);

/** 编辑器文件真实形态（buildFullPlain/snapshot/step delta 依赖 data.data.id 骨架） */
const editorFile = (id, title, n, body, segments = []) =>
  JSON.stringify({ data: { id, title, n, body }, segments });

/** 基础链路：快照/增量/无变化写/联动 move（撤销+重做）/撤销后编辑/gzip 嗅探 */
function buildBasicScenario() {
  const v1 = editorFile('n1', 'A', 1, 'x'.repeat(500));
  const v2 = editorFile('n1', 'A', 2, 'x'.repeat(500) + 'y');
  const v3 = editorFile('n1', 'B', 3, 'x'.repeat(500) + 'yy');
  const w = editorFile('n1', 'W', 9, 'x'.repeat(500) + 'zzz');
  const gz1 = editorFile('gz', '压缩输入', 1, 'z'.repeat(800));
  const gz2 = editorFile('gz', '压缩输入 II', 2, 'z'.repeat(800) + '!');
  const caps = (id, ...items) => items.map(([data, time, batchId, move]) => ({
    op: 'captureEditor',
    id,
    data: b64(data),
    time,
    batchId,
    ...(move ? { move } : {})
  }));

  return {
    name: 'basic',
    steps: [
      {
        captures: [
          ...caps('n1',
            [v1, T0, 1100],
            [v2, T0 + 1000, 1200],
            [v2, T0 + 2000, 1300], // 无变化写：不落记录
            [v3, T0 + 3000, 1400],
            [v2, T0 + 4000, 1500, { op: 'undo', target: 1 }],
            [v1, T0 + 5000, 1600, { op: 'undo', target: 0 }],
            [v2, T0 + 6000, 1700, { op: 'redo', target: 1 }],
            [w, T0 + 7000, 1800], // 撤销后编辑：编辑来源钉在 v2
            [v2, T0 + 8000, 1900, { op: 'undo', target: 1 }]
          ),
          ...caps('gz', [zlib.gzipSync(Buffer.from(gz1)), T0 + 9000, 2000], [gz2, T0 + 10000, 2100])
        ]
      },
      {
        ops: [
          { op: 'status', id: 'n1' },
          { op: 'list', kind: 'editor', id: 'n1' },
          { op: 'step', id: 'n1', move: 'undo', dirty: false },
          { op: 'step', id: 'n1', move: 'redo', dirty: false },
          { op: 'step', id: 'n1', move: 'redo', dirty: false, plainOnly: true },
          { op: 'step', id: 'n1', move: 'undo', dirty: true },
          { op: 'snapshot', id: 'n1', time: T0 + 3000, nearest: false },
          { op: 'snapshot', id: 'n1', time: T0 + 4500, nearest: true },
          { op: 'snapshot', id: 'n1', time: T0 - 5000, nearest: true },
          { op: 'read', kind: 'editor', id: 'n1', time: T0 + 1000, batchId: 1200 },
          { op: 'read', kind: 'editor', id: 'n1', time: T0 + 999999, batchId: 1234 },
          { op: 'read', kind: 'editor', id: 'n1', time: T0 + 1000, batchId: 9999 },
          { op: 'status', id: 'gz' },
          { op: 'read', kind: 'editor', id: 'gz', time: T0 + 9000, batchId: 2000 },
          { op: 'read', kind: 'editor', id: 'gz', time: T0 + 10000, batchId: 2100 }
        ]
      }
    ],
    logBins: ['editor/n1/log.bin', 'editor/gz/log.bin']
  };
}

/** 重锚链路：140 条递增版本触发重锚快照（生产阈值 128）+ 站位与 delta 撤销 */
function buildReanchorScenario() {
  const captures = [];
  for (let i = 0; i < 140; i++) {
    const content = editorFile('bulk', 'B', i, 'r'.repeat(200 + (i % 50)));
    captures.push({ op: 'captureEditor', id: 'bulk', data: b64(Buffer.from(content)), time: T0 + i * 1000, batchId: 5000 + i });
  }
  return {
    name: 'reanchor',
    steps: [
      { captures },
      {
        ops: [
          { op: 'status', id: 'bulk' },
          { op: 'list', kind: 'editor', id: 'bulk' },
          { op: 'read', kind: 'editor', id: 'bulk', time: T0 + 10 * 1000, batchId: 5010 },
          { op: 'read', kind: 'editor', id: 'bulk', time: T0 + 139 * 1000, batchId: 5139 },
          { op: 'snapshot', id: 'bulk', time: T0 + 139 * 1000, nearest: false },
          { op: 'snapshot', id: 'bulk', time: T0 + 70 * 1000 + 500, nearest: true },
          { op: 'step', id: 'bulk', move: 'undo', dirty: false }
        ]
      }
    ],
    logBins: ['editor/bulk/log.bin']
  };
}

/** 墓碑链路：删除留底（链尾相符不补快照）/重复删除幂等/复活摘墓碑 */
function buildTombstoneScenario() {
  const v1 = editorFile('gone', 'T1', 1, 't'.repeat(300));
  const v2 = editorFile('gone', 'T2', 2, 't'.repeat(300) + 't');
  const v3 = editorFile('gone', 'T3', 3, 't'.repeat(300) + 'tt');
  const caps = (id, ...items) => items.map(([data, time, batchId]) => ({
    op: 'captureEditor',
    id,
    data: b64(data),
    time,
    batchId
  }));

  return {
    name: 'tombstone',
    steps: [
      {
        captures: [
          ...caps('gone', [v1, T0, 3001], [v2, T0 + 1000, 3002]),
          { op: 'captureEditorUnlink', id: 'gone', data: b64(Buffer.from(v2)), time: T0 + 2000, batchId: 3003 },
          { op: 'captureEditorUnlink', id: 'gone', data: b64(Buffer.from(v2)), time: T0 + 3000, batchId: 3004 }
        ]
      },
      {
        ops: [
          { op: 'status', id: 'gone' },
          { op: 'list', kind: 'editor', id: 'gone' },
          { op: 'step', id: 'gone', move: 'undo', dirty: false, plainOnly: true },
          { op: 'read', kind: 'editor', id: 'gone', time: T0 + 500, batchId: 3001 },
          { op: 'read', kind: 'editor', id: 'gone', time: T0 + 1500, batchId: 3002 },
          { op: 'snapshot', id: 'gone', time: T0 + 1500, nearest: true }
        ]
      },
      {
        captures: [...caps('gone', [v3, T0 + 4000, 3005])]
      },
      {
        ops: [
          { op: 'status', id: 'gone' },
          { op: 'list', kind: 'editor', id: 'gone' },
          { op: 'step', id: 'gone', move: 'undo', dirty: false, plainOnly: true },
          { op: 'read', kind: 'editor', id: 'gone', time: T0 + 4000, batchId: 3005 },
          { op: 'snapshot', id: 'gone', time: T0 + 4000, nearest: false }
        ]
      }
    ],
    logBins: ['editor/gone/log.bin']
  };
}

/** 段落通道：快照/增量/无变化写 + 按版本 (time,batchId) 对齐读回（含缺失 null）+ 大文档快照拼接 */
function buildSegmentsScenario() {
  const segNode = (text, n) => JSON.stringify([{ type: 'paragraph', children: [{ text }], n }]);
  const s1 = segNode('s'.repeat(400), 1);
  const s2 = segNode('s'.repeat(400) + 's', 2);
  const s3 = segNode('s'.repeat(400) + 'ss', 3);
  const doc1 = JSON.stringify({ data: { id: 'doc1', title: 'D', n: 1 }, segments: ['seg1'] });
  const segs = (...items) => items.map(([data, time, batchId]) => ({
    op: 'captureSegment',
    id: 'seg1',
    data: b64(data),
    time,
    batchId
  }));

  return {
    name: 'segments',
    steps: [
      {
        captures: [
          ...segs([s1, T0, 4001], [s2, T0 + 1000, 4002]),
          ...segs([s1, T0 + 2000, 4003]), // 无变化写：不落记录
          ...segs([s3, T0 + 3000, 4004]),
          { op: 'captureEditor', id: 'doc1', data: b64(Buffer.from(doc1)), time: T0, batchId: 4001 }
        ]
      },
      {
        ops: [
          { op: 'list', kind: 'segment', id: 'seg1' },
          { op: 'list', kind: 'editor', id: 'doc1' },
          {
            op: 'readSegments',
            segments: [
              { id: 'seg1', time: T0, batchId: 4001 },
              { id: 'seg1', time: T0 + 3000, batchId: 4004 },
              { id: 'seg1', time: T0 + 999999, batchId: 4005 }
            ]
          },
          { op: 'read', kind: 'segment', id: 'seg1', time: T0 + 3000, batchId: 4004 },
          { op: 'snapshot', id: 'doc1', time: T0, nearest: false }
        ]
      }
    ],
    logBins: ['segment/seg1/log.bin', 'editor/doc1/log.bin']
  };
}

// ---------------------------------------------------------------------------
// 生成（写树 + 冷启动跑读接口 + 落盘期望）
// ---------------------------------------------------------------------------

async function generateScenario(def) {
  const dir = path.join(outRoot, def.name);
  const basePath = path.join(dir, 'work');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(basePath, { recursive: true });

  const steps = [];
  for (const step of def.steps) {
    if (step.captures) {
      await runCaptures(freshEngine(), basePath, step.captures);
      steps.push({ captures: step.captures });
    } else {
      const ops = await runOps(freshEngine(), basePath, step.ops);
      steps.push({ ops });
    }
  }

  exportTree(basePath, path.join(dir, 'tree'));
  fs.rmSync(basePath, { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'work'), { recursive: true, force: true });

  return {
    name: def.name,
    tree: `${def.name}/tree`,
    logBins: def.logBins ?? [],
    steps
  };
}

/** 截断尾场景：基础样本 + 垃圾尾字节（读得通即修复成功，读结果与基础场景一致） */
async function generateTruncatedScenario(baseExpected) {
  const name = 'truncated';
  const dir = path.join(outRoot, name);
  const basePath = path.join(dir, 'work');
  fs.mkdirSync(basePath, { recursive: true });
  fs.cpSync(path.join(outRoot, 'basic', 'tree'), path.join(basePath, '.history'), { recursive: true });

  const logFile = path.join(basePath, '.history', 'editor', 'n1', 'log.bin');
  fs.appendFileSync(logFile, Buffer.from('GARBAGE-TAIL-截断残留'));

  // 冷启动读：引擎应容忍并修复截断尾部，读结果与基础场景一致
  const basicOps = baseExpected.steps.find((s) => s.ops)?.ops ?? [];
  const ops = await runOps(freshEngine(), basePath, basicOps);

  const repairedSize = fs.statSync(logFile).size;

  exportTree(basePath, path.join(dir, 'tree'));
  // 发运带垃圾尾的样本（测试侧自行修复）
  const shippedLog = path.join(dir, 'tree', 'editor', 'n1', 'log.bin');
  fs.appendFileSync(shippedLog, Buffer.from('GARBAGE-TAIL-截断残留'));
  fs.rmSync(basePath, { recursive: true, force: true });

  return { name, tree: `${name}/tree`, logBins: [], steps: [{ ops }], repairedSize };
}

async function main() {
  fs.mkdirSync(outRoot, { recursive: true });
  const out = [];
  const basic = await generateScenario(buildBasicScenario());
  out.push(basic);
  const truncated = await generateTruncatedScenario(basic);
  out.push(await generateScenario(buildReanchorScenario()));
  out.push(await generateScenario(buildTombstoneScenario()));
  out.push(await generateScenario(buildSegmentsScenario()));
  out.push(truncated);

  const payload = {
    format: 'slinote-history-fixtures',
    formatVersion: 1,
    zstdVersion: require(BINDING).version(),
    scenarioCount: out.length,
    scenarios: out
  };
  fs.writeFileSync(path.join(outRoot, 'expected.json'), JSON.stringify(payload) + '\n');

  console.log(`[gen-history-fixtures] 已生成 ${out.length} 个场景：${outRoot}`);
  for (const s of out) {
    const ops = s.steps.reduce((n, step) => n + (step.ops?.length ?? 0), 0);
    const caps = s.steps.reduce((n, step) => n + (step.captures?.length ?? 0), 0);
    console.log(`  - ${s.name}: 捕获 ${caps} 条 / 读接口 ${ops} 条${s.logBins.length ? ` / 字节比对 ${s.logBins.length} 文件` : ''}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
