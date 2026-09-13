// V0.72 测试：事件流三 bug + 缓存 replace 语义 + settings rebuild
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v072-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));

describe('V0.72 事件流与缓存深度修复', () => {
  test('①前端 done 字段保护：written undefined 时显示"本章流程完成"', () => {
    const src = fs.readFileSync(path.join(ROOT, 'web/js/views/workshop.js'), 'utf8');
    assert.ok(src.includes("data.written === undefined"), 'done case 应有字段保护');
    assert.ok(src.includes('本章流程完成'), '应显示流程完成文案');
    assert.ok(src.includes("case 'usage_cost'"), '应有 usage_cost 实时费用事件');
  });

  test('②pilot 补写 seen 登记 + 实时状态 + doneCount 目标判定', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/pilot.js'), 'utf8');
    assert.ok(src.includes('seen.add(ch.id)'), '补写成功应登记 seen');
    assert.ok(src.includes('seen.delete(ch.id)'), '补写失败应放行主循环');
    assert.ok(src.includes('store.chapters.get(ch.id)'), '主循环应实时查库状态');
    assert.ok(src.includes('doneCount >= targetChapters'), '目标判定应改已完成章数');
    const rec = fs.readFileSync(path.join(ROOT, 'server/engine/recovery/recovery.js'), 'utf8');
    assert.ok(rec.includes("store.history.truncateFrom(bookId, minSeq, '漂移恢复重规划')"), 'recovery 应补 reason');
  });

  test('③write 失败回退不再 truncate（只清 historySeq）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/write.js'), 'utf8');
    assert.ok(!src.includes("'场景重写失败回退'"), 'write 失败回退不应 truncate');
    assert.ok(src.includes('失败回退**不再 truncate**'), '应有注释说明');
    assert.ok(src.includes('onUsageCost'), 'write 应透传 usage_cost');
  });

  test('④rebuildHistoryFromChapters 逐场景 replace（不再整书 truncate(3)）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/quality/polish.js'), 'utf8');
    assert.ok(src.includes('store.history.replace(bookId, sc.history_seq'), '应逐场景 replace');
    assert.ok(!src.includes('truncateFrom(bookId, 3)'), '不应整书 truncate(3)');
  });

  test('⑤settings 设定生成后 rebuildHistory（世界观进历史堆）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/planning/settings.js'), 'utf8');
    assert.ok(src.includes("rebuildHistory(bookId, '设定生成"), '设定生成应重建历史堆');
  });

  test('⑥集成：补写完成的章主循环不再重写（3 章目标全 done 且不误续卷）', async () => {
    const { runBookPilot } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/pilot.js')));
    const b = store.books.create({ title: '集成书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', 'x');
    store.materials.set(b.id, 'outline', '书纲');
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g', status: 'outlined' });
    for (let i = 1; i <= 3; i++) store.chapters.create(b.id, v.id, i, { title: '第' + i + '章', status: 'planned' });
    const evs = [];
    const r = await runBookPilot(b.id, { targetChapters: 3, onEvent: e => evs.push(e) });
    const done = store.chapters.list(b.id).filter(c => c.status === 'done' || c.status === 'settled');
    assert.equal(done.length, 3, `3 章应全 done，实际 ${done.length}`);
    assert.equal(r.total, 3, '目标 3 章不应续卷（total=' + r.total + '）');
    // 补写只发生一次（第 1 章），主循环不重复写
    const chStarts = evs.filter(e => e.type === 'chapter_start').map(e => e.idx);
    assert.ok(!chStarts.includes(1), '补写完成的第 1 章不应被主循环重写（chapter_start=' + chStarts.join(',') + '）');
    assert.ok(chStarts.includes(2) && chStarts.includes(3), '主循环应写第 2/3 章');
  });

  test('⑦集成：修订场景历史堆 replace 而非 truncate（前缀保持）', async () => {
    const { writeScene } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/write.js')));
    const b = store.books.create({ title: '替换书', genre: '玄幻' });
    const ch = store.chapters.create(b.id, null, 1, { title: 'C1', status: 'planned' });
    store.chapters.update(ch.id, { outline: { title: 'C1', scenes: [
      { pov: '', location: '', beat: 'a', target_words: 300 },
      { pov: '', location: '', beat: 'b', target_words: 300 },
    ] } });
    const s1 = store.scenes.create(ch.id, 1, { pov: '', location: '', beat: 'a', targetWords: 300, status: 'planned' });
    const s2 = store.scenes.create(ch.id, 2, { pov: '', location: '', beat: 'b', targetWords: 300, status: 'planned' });
    await writeScene(b.id, ch.id, s1.id, {});
    await writeScene(b.id, ch.id, s2.id, {});
    const before = store.history.count(b.id);
    const seq1 = store.scenes.get(s1.id).history_seq;
    // 重写场景 1（revise 语义）
    await writeScene(b.id, ch.id, s1.id, {});
    assert.equal(store.history.count(b.id), before, '重写场景历史消息数不变（replace 同 seq）');
    assert.equal(store.scenes.get(s1.id).history_seq, seq1, '重写后 seq 不变（原位替换）');
  });
});
