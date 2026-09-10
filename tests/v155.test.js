// V0.96.4 锁定：DeepWrite「可审阅的文稿修改」落地——快照 diff 对比视图
// ① diffParagraphs 段落级纯函数（LCS：删/增/同三类块）
// ② snapshotDiffOverview / snapshotChapterDiff 快照 vs 当前（data_safety 语义层）
// ③ GET /api/books/:id/snapshots/:sid/diff 端点注册与守卫
// ④ 前端书务台「对比」入口 + 红删绿增块渲染 + 连续未变段折叠
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import './helper.js';
import * as store from '../server/db/store.js';
import { diffParagraphs } from '../server/util/diff.js';
import { snapshotDiffOverview, snapshotChapterDiff } from '../server/engine/data_safety.js';

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------- ① diffParagraphs 段落级纯函数 ----------

test('V0.96.4 diffParagraphs：全同文本全为 same 块（快照后未动 = 无差异的最常见情形）', () => {
  const text = '第一段：夜色如墨。\n第二段：他握紧了拳。\n第三段：城头火起。';
  const blocks = diffParagraphs(text, text);
  assert.ok(blocks.length > 0 && blocks.every(b => b.type === '='), '全同文本应全部 same 块');
  assert.equal(blocks.map(b => b.text).join('\n'), text, 'same 块拼接应还原原文');
});

test('V0.96.4 diffParagraphs：中段替换 → 删+增成对、前后 same 保留（修订审阅主场景）', () => {
  const oldText = '他感到愤怒。\n他转身出门。\n夜色渐深。';
  const newText = '他握紧了拳，指节咯吱作响。\n他转身出门。\n夜色渐深。';
  const blocks = diffParagraphs(oldText, newText);
  const types = blocks.map(b => b.type).join('');
  assert.equal(types, '-+=', '应为 删/增/同（相邻同段合并成一块，LCS 锚定公共后缀）');
  assert.equal(blocks[0].text, '他感到愤怒。', '删除块应是旧句');
  assert.equal(blocks[1].text, '他握紧了拳，指节咯吱作响。', '新增块应是新句（禁-正例结对铁律的正例）');
  assert.ok(blocks[2].text.includes('他转身出门。') && blocks[2].text.includes('夜色渐深。'), '未动两段合并保留在 same 块');
});

test('V0.96.4 diffParagraphs：纯新增/纯删除段与空文本边界', () => {
  assert.deepEqual(
    diffParagraphs('', '新写的一段。').map(b => b.type), ['+'],
    '快照空章 → 当前有正文 = 全新增',
  );
  assert.deepEqual(
    diffParagraphs('被删的一段。', '').map(b => b.type), ['-'],
    '当前清空 = 全删除',
  );
  assert.deepEqual(diffParagraphs('', ''), [], '双侧空文本 = 零块');
});

test('V0.96.4 diffParagraphs：相邻同类型块合并输出（不留碎片）', () => {
  const blocks = diffParagraphs('甲。\n乙。\n丙。', '甲。\n丁。\n戊。');
  const types = blocks.map(b => b.type).join('');
  assert.equal(types, '=-+', '中间两段替换应合并为一块删+一块增（不输出 --++ 或 -+-+ 碎片）');
});

// ---------- ② 快照对比语义层（data_safety 单源） ----------

function seedBookForDiff() {
  const book = store.books.create({ title: 'diff 对比测试书', genre: '历史' });
  const vol = store.volumes.create(book.id, 1, { title: '卷一' });
  const ch1 = store.chapters.create(book.id, vol.id, 1, { title: '旧章名', wordCount: 0 });
  store.scenes.create(ch1.id, 1, { content: '旧正文第一段。', status: 'done' });
  store.scenes.create(ch1.id, 2, { content: '旧正文第二段。', status: 'done' });
  const snap = store.snapshots.add(book.id, { label: '测试快照', source: 'manual', data: store.snapshotBook(book.id) });
  // 快照后：ch1 改标题+改正文，另增 ch2（快照外新章）
  store.chapters.update(ch1.id, { title: '新章名' });
  const s1 = store.scenes.list(ch1.id)[0];
  store.scenes.update(s1.id, { content: '新正文第一段。' });
  const ch2 = store.chapters.create(book.id, vol.id, 2, { title: '快照外新章' });
  store.scenes.create(ch2.id, 1, { content: '全新章节正文。', status: 'done' });
  return { book, vol, ch1, ch2, snap };
}

test('V0.96.4 snapshotDiffOverview：只列变化章（modified/added/removed），未变章不进列表', () => {
  const { book, snap } = seedBookForDiff();
  const ov = snapshotDiffOverview(book.id, snap.id);
  assert.equal(ov.snapshot.id, snap.id, '概览应回带快照元信息');
  assert.equal(ov.unchanged, 0, '无未变章');
  const ch1Row = ov.chapters.find(c => c.idx === 1);
  assert.ok(ch1Row, '改了标题+正文的 ch1 应在差异列表');
  assert.equal(ch1Row.change, 'modified', 'ch1 是修改');
  assert.equal(ch1Row.snapTitle, '旧章名', '快照侧标题');
  assert.equal(ch1Row.curTitle, '新章名', '当前侧标题');
  const ch2Row = ov.chapters.find(c => c.idx === 2);
  assert.ok(ch2Row, '快照外新章 ch2 应标记 added');
  assert.equal(ch2Row.change, 'added', 'ch2 是新增');
  assert.equal(ch2Row.snapWords, 0, '快照侧 ch2 无正文');
  assert.ok(ch2Row.curWords > 0, '当前侧 ch2 有正文');
});

test('V0.96.4 snapshotDiffOverview：removed（快照有、当前无）与全同快照零差异', () => {
  const { book, ch2 } = seedBookForDiff();
  // 造一个更早的快照（含 ch1/ch2 原貌），再删掉当前 ch2 → removed
  const snap2 = store.snapshots.add(book.id, { label: '删除前快照', source: 'manual', data: store.snapshotBook(book.id) });
  store.scenes.clear(ch2.id);
  store.chapters.remove(ch2.id);
  const ov = snapshotDiffOverview(book.id, snap2.id);
  const row = ov.chapters.find(c => c.idx === 2);
  assert.ok(row, '被删章应出现在差异列表');
  assert.equal(row.change, 'removed', '快照有当前无 = removed');
  // 全同快照：打完快照不动任何东西
  const snap3 = store.snapshots.add(book.id, { label: '全同快照', source: 'manual', data: store.snapshotBook(book.id) });
  const ov3 = snapshotDiffOverview(book.id, snap3.id);
  assert.equal(ov3.chapters.length, 0, '全同快照应零差异章');
  assert.ok(ov3.unchanged >= 1, '未变章计数应≥1');
});

test('V0.96.4 snapshotChapterDiff：块级红删绿增数据 + 字数与 changed 判定', () => {
  const { book, snap } = seedBookForDiff();
  const d = snapshotChapterDiff(book.id, snap.id, 1);
  assert.equal(d.idx, 1, '回带章号');
  assert.equal(d.snapshotTitle, '旧章名', '快照侧标题');
  assert.equal(d.currentTitle, '新章名', '当前侧标题');
  assert.equal(d.changed, true, '正文有替换应 changed');
  assert.ok(d.snapWords > 0 && d.curWords > 0, '双侧字数应非零');
  const delTexts = d.blocks.filter(b => b.type === '-').map(b => b.text);
  const addTexts = d.blocks.filter(b => b.type === '+').map(b => b.text);
  assert.ok(delTexts.includes('旧正文第一段。'), '删除块含旧正文首段');
  assert.ok(addTexts.includes('新正文第一段。'), '新增块含新正文首段');
  assert.ok(d.blocks.some(b => b.type === '=' && b.text === '旧正文第二段。'), '未动段落应保留为 same 块');
  // 快照外新章：按快照空文本对比 = 全新增
  const d2 = snapshotChapterDiff(book.id, snap.id, 2);
  assert.equal(d2.changed, true, '快照后新增的章相对快照无对应内容——按快照空对比应全新增');
  assert.ok(d2.blocks.length > 0 && d2.blocks.every(b => b.type === '+'), '全新增章应全部为 + 块');
});

// ---------- ③ 端点注册（源码断言） ----------

test('V0.96.4 端点：GET /api/books/:id/snapshots/:sid/diff 注册且走 OWNED.snapshot 守卫', () => {
  const index = read('server/index.js');
  assert.ok(index.includes("route('GET', '/api/books/:id/snapshots/:sid/diff'"), 'diff 端点应注册');
  const seg = index.slice(index.indexOf("/api/books/:id/snapshots/:sid/diff'"));
  assert.ok(seg.slice(0, 900).includes('OWNED.snapshot'), 'diff 端点应挂快照归属守卫');
  assert.ok(seg.slice(0, 900).includes('snapshotDiffOverview') && seg.slice(0, 900).includes('snapshotChapterDiff'),
    '无 chapter 参数走概览、带 chapter 走块级 diff');
});

// ---------- ④ 前端可视化（源码断言） ----------

test('V0.96.4 前端：书务台快照卡片加「对比」入口，红删绿增块渲染 + 未变段折叠', () => {
  const ws = read('web/js/views/workshop.js');
  assert.ok(ws.includes('`/api/books/${book.id}/snapshots/${snapId}/diff`'), '快照行应请求 diff 端点');
  assert.ok(ws.includes('对比'), '应有「对比」按钮文案');
  assert.ok(ws.includes('diff-block-add') && ws.includes('diff-block-del'), '应渲染红删绿增块类名');
  assert.ok(/段未变/.test(ws), '连续未变段应折叠提示');
  const css = read('web/css/app.css');
  assert.ok(css.includes('.diff-block-add') && css.includes('.diff-block-del'), 'diff 块样式应进 app.css');
});
