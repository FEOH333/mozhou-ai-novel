// V0.109.4 紧急完本：从任意进度规划收束卷 → 写完即完本（不受字数下限/章数上限约束）。
//
// 这个功能的失败模式很隐蔽：如果「写完收束卷」不能真的把书判成完本，
// 用户就会看到"收束卷写完了但还显示未完成"——功能形同虚设。故必须有完成路径的端到端断言。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1095-ef-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const cont = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/continuation.js')));

/** 建一本已有 N 章完成正文的书 */
function makeBook({ chapters = 3, foreshadows = 2 } = {}) {
  const book = store.books.create({ title: `EF-${Math.random().toString(36).slice(2, 7)}`, genre: '玄幻' });
  const vol = store.volumes.create(book.id, 1, { title: '第一卷' });
  for (let i = 1; i <= chapters; i++) {
    const ch = store.chapters.create(book.id, vol.id, i, { title: `C${i}`, status: 'done' });
    store.scenes.create(ch.id, 1, { content: '辰时三刻，他走进院子，拿起柴刀。'.repeat(20), status: 'done' });
  }
  for (let i = 0; i < foreshadows; i++) {
    store.foreshadows.create(book.id, { desc: `伏笔${i + 1}`, importance: 'high' });
  }
  return { book, vol };
}

/** 把某卷的章节全部标记为完成 */
function completeVolume(volumeId) {
  for (const ch of store.chapters.listByVolume(volumeId)) {
    store.chapters.update(ch.id, { status: 'done' });
    if (!store.scenes.list(ch.id).length) {
      store.scenes.create(ch.id, 1, { content: '正文。'.repeat(30), status: 'done' });
    }
  }
}

describe('V0.109.4 紧急完本', () => {

  test('未启动时状态为 inactive，不影响常规完本判定', () => {
    const { book } = makeBook();
    assert.deepEqual(cont.emergencyFinishState(book.id), { active: false });
    const lc = cont.localEndingCheck(book.id);
    assert.equal(lc.finished, false, '未启动紧急完本时不得被判完本');
  });

  test('规划收束卷：建卷 + 记录状态 + 章数落在 3-8 区间', async () => {
    const { book } = makeBook({ foreshadows: 2 });
    const r = await cont.planEmergencyFinish(book.id, { chapters: 5 });
    assert.ok(r.volumeId, '应返回卷 id');
    assert.equal(r.targetChapters, 5);
    assert.equal(r.openForeshadows, 2, '应统计到未回收伏笔数');

    const st = cont.emergencyFinishState(book.id);
    assert.equal(st.active, true);
    assert.equal(st.targetChapters, 5);
    assert.equal(st.writtenChapters, 0);
    assert.equal(st.done, false);
  });

  test('章数被夹在 3-8：太少收不干净、太多就不是"紧急"了', async () => {
    const a = makeBook();
    assert.equal((await cont.planEmergencyFinish(a.book.id, { chapters: 1 })).targetChapters, 3);
    const b = makeBook();
    assert.equal((await cont.planEmergencyFinish(b.book.id, { chapters: 99 })).targetChapters, 8);
    const c = makeBook();
    assert.equal((await cont.planEmergencyFinish(c.book.id, {})).targetChapters,
      cont.EMERGENCY_FINISH_DEFAULT_CHAPTERS, '不传则用默认值');
  });

  test('★关键路径：收束卷写完 → 完本判定返回 finished', async () => {
    const { book } = makeBook({ foreshadows: 3 });
    const planned = await cont.planEmergencyFinish(book.id, { chapters: 4 });

    // 未写完时：继续写
    let lc = cont.localEndingCheck(book.id);
    assert.equal(lc.finished, false, '未写完不得判完本');
    assert.equal(lc.shouldContinue, true, '应继续写收束卷');

    // 写完收束卷
    completeVolume(planned.volumeId);
    const st = cont.emergencyFinishState(book.id);
    assert.equal(st.done, true, '收束卷应判为已完成');

    lc = cont.localEndingCheck(book.id);
    assert.equal(lc.finished, true, '收束卷写完必须判完本');
    assert.equal(lc.shouldContinue, false, '不得再继续写');
    assert.match(lc.reason, /紧急完本/, '理由应说明是紧急完本');
  });

  test('紧急完本优先于常规拦截：字数不足 / 伏笔未回收都不再挡住完本', async () => {
    const { book } = makeBook({ chapters: 2, foreshadows: 5 });
    // 先确认常规判定会因伏笔/字数而"继续写"
    assert.equal(cont.localEndingCheck(book.id).shouldContinue, true, '常规判定应为继续写');

    const planned = await cont.planEmergencyFinish(book.id, { chapters: 3 });
    completeVolume(planned.volumeId);
    const lc = cont.localEndingCheck(book.id);
    assert.equal(lc.finished, true, '伏笔未回收完也应完本（作者已决定收束）');
    assert.ok(lc.reason.includes('收束卷') || lc.reason.includes('紧急完本'));
  });

  test('重复启动被拒绝（避免建出两个收束卷）', async () => {
    const { book } = makeBook();
    await cont.planEmergencyFinish(book.id, { chapters: 3 });
    await assert.rejects(() => cont.planEmergencyFinish(book.id, { chapters: 3 }), /已在进行中/);
  });

  test('没有完成章节时拒绝启动（空书无需紧急完本）', async () => {
    const book = store.books.create({ title: '空书', genre: '玄幻' });
    await assert.rejects(() => cont.planEmergencyFinish(book.id, {}), /还没有任何完成章节/);
  });

  test('取消后回到常规判定', async () => {
    const { book } = makeBook({ foreshadows: 3 });
    await cont.planEmergencyFinish(book.id, { chapters: 3 });
    assert.equal(cont.emergencyFinishState(book.id).active, true);

    const r = cont.cancelEmergencyFinish(book.id);
    assert.equal(r.cancelled, true);
    assert.equal(cont.emergencyFinishState(book.id).active, false);
    assert.equal(cont.localEndingCheck(book.id).finished, false, '取消后不得再判完本');
  });

  test('悬空记录不劫持完本判定（卷被删后应视为未启用）', async () => {
    const { book } = makeBook();
    const planned = await cont.planEmergencyFinish(book.id, { chapters: 3 });
    store.volumes.remove(planned.volumeId);
    const st = cont.emergencyFinishState(book.id);
    assert.equal(st.active, false, '卷不存在时不得判为进行中');
    assert.equal(cont.localEndingCheck(book.id).finished, false, '悬空记录不得把书判完本');
  });

  test('状态存在 materials（不进 L2 公共前缀）', () => {
    const src = read('server/engine/pipeline/continuation.js');
    assert.match(src, /store\.materials\.set\(bookId, EMERGENCY_FINISH_KIND/, '状态应写 materials');
    const cache = read('server/llm/cache.js');
    assert.ok(!cache.includes('emergency_finish'), 'emergency_finish 不得进公共材料前缀');
  });

  test('接口已接线：GET 查状态 / POST 规划 / DELETE 取消', () => {
    const idx = read('server/index.js');
    assert.match(idx, /route\('GET', '\/api\/books\/:id\/emergency-finish'/, 'GET 应注册');
    assert.match(idx, /route\('POST', '\/api\/books\/:id\/emergency-finish'/, 'POST 应注册');
    assert.match(idx, /route\('DELETE', '\/api\/books\/:id\/emergency-finish'/, 'DELETE 应注册');
    assert.match(idx, /from '\.\/engine\/pipeline\/continuation\.js'/, '应导入紧急完本能力');
    assert.match(idx, /writeJobs\.start\(\{[\s\S]{0,120}emergency-finish/, '应走后台作业（不阻塞请求）');
  });
});
