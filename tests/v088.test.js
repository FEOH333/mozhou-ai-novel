// V0.80 签约模拟评审 + 开篇重写 + 漂移吸引力信号
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v088-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

const promiseData = {
  premise_in_one_breath: '一个普通人在困局中保护身边人', primary_attraction_axis: '人物选择', secondary_axes: [],
  protagonist_now: { lack: '弱小', immediate_need: '活下去', agency_pattern: '观察后行动' },
  payoff_ladder: { near: ['作出选择'], middle: ['保护同伴'], long: ['改变命运'] },
  texture: { route: 'general', pace: '稳', humor: 'low', historical_density: 'low', pov: 'close_third' },
  protected_elements: [], anti_promises: [], author_locks: [], confidence: {},
};

async function completePromise(bookId) {
  const { buildStoryPromiseProfile } = await import(pathToFileURL(path.join(ROOT, 'server/engine/story_promise.js')));
  return buildStoryPromiseProfile(bookId, { data: promiseData });
}

describe('V0.80 签约模拟评审 + 开篇重写 + 漂移吸引力信号', () => {
  test('①signingDue：番茄前3章有正文且画像就绪 → true，不伪造固定平台字数门槛', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { signingDue } = await import(pathToFileURL(path.join(ROOT, 'server/engine/signing.js')));
    const b = store.books.create({ title: '评审书', genre: '玄幻', blurb: 'x', platform: '番茄' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    for (let i = 1; i <= 3; i++) {
      const ch = store.chapters.create(b.id, v.id, i, { title: `第${i}章`, status: 'done' });
      store.chapters.update(ch.id, { wordCount: 100 });
      store.scenes.create(ch.id, 1, { content: `第${i}章真实正文`, status: 'done' });
    }
    await completePromise(b.id);
    assert.equal(signingDue(b.id), true, '番茄+达标应触发');
    // 非番茄不触发
    const b2 = store.books.create({ title: '通用书', genre: '玄幻', blurb: 'x', platform: '通用' });
    const v2 = store.volumes.create(b2.id, 1, { title: 'V1', goal: 'g' });
    for (let i = 1; i <= 3; i++) { const ch = store.chapters.create(b2.id, v2.id, i, { title: `第${i}章`, status: 'done' }); store.chapters.update(ch.id, { wordCount: 100 }); }
    assert.equal(signingDue(b2.id), false, '非番茄不触发');
  });

  test('②simulateSigningReview：落材料 + settings，NOVEL_SIGNING_FAULT=1 → reject', async () => {
    process.env.NOVEL_SIGNING_FAULT = '1';
    try {
      const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
      const { simulateSigningReview } = await import(pathToFileURL(path.join(ROOT, 'server/engine/signing.js')));
      const b = store.books.create({ title: '评审书2', genre: '玄幻', blurb: 'x', platform: '番茄' });
      store.materials.set(b.id, 'contract', '前3章打脸');
      const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
      for (let i = 1; i <= 3; i++) {
        const ch = store.chapters.create(b.id, v.id, i, { title: `第${i}章`, status: 'done' });
        store.scenes.create(ch.id, 1, { content: `第${i}章正文，他站在巷口。`, status: 'done' });
      }
      await completePromise(b.id);
      const r = await simulateSigningReview(b.id, {});
      assert.equal(r.ok, true);
      assert.equal(r.review.verdict, 'reject', 'fault 注入应判 reject');
      assert.ok(store.materials.get(b.id, 'signing_review')?.content, '应落评审材料');
      assert.ok(store.books.settings(b.id).signingReview, '应存结构化评审');
    } finally {
      delete process.env.NOVEL_SIGNING_FAULT;
    }
  });

  test('③文本预审读取真实正文、保存指纹；正文变化后自动到期重审', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { collectSigningInput, signingDue, simulateSigningReview } = await import(pathToFileURL(path.join(ROOT, 'server/engine/signing.js')));
    const b = store.books.create({ title: '真实文本书', genre: '历史', blurb: '要保护一座城', platform: '番茄' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    let firstScene;
    for (let i = 1; i <= 4; i++) {
      const ch = store.chapters.create(b.id, v.id, i, { title: `第${i}章`, status: 'done' });
      const scene = store.scenes.create(ch.id, 1, { content: `第${i}章真实正文-${i === 1 ? '首章唯一末尾证据' : '后续证据'}`, status: 'done' });
      if (i === 1) firstScene = scene;
      store.summaries.set(ch.id, b.id, `第${i}章摘要`);
    }
    await completePromise(b.id);
    const input = collectSigningInput(b.id);
    assert.match(input.fullChapters[0].text, /首章唯一末尾证据/, '不得只给摘要或标题');
    assert.match(input.laterChapters[0].head300, /第4章真实正文/, '第4—10章应给正文切片');
    const reviewData = {
      verdict: 'pass', score: 82, reason: '文本证据成立', issues: [],
      evidence_limits: '只做文本预审，不预测平台结果', observation_plan: ['发布后观察真实读者反馈'],
    };
    const result = await simulateSigningReview(b.id, { data: reviewData });
    assert.equal(result.ok, true);
    assert.equal(result.review.source_fingerprint, input.source_fingerprint);
    assert.equal(Object.hasOwn(result.review, 'metrics'), false, '不得保存伪造留存率或签约概率');
    const saved = store.materials.get(b.id, 'signing_review').content;
    const invalid = await simulateSigningReview(b.id, { data: {
      ...reviewData, metrics: { expected_retention: '80%' },
    } });
    assert.equal(invalid.status, 'unreviewed', '含伪预测字段的结果必须显式未审');
    assert.equal(store.materials.get(b.id, 'signing_review').content, saved, '坏结果不得覆盖上一次有效报告');
    assert.ok(store.books.settings(b.id).signingReviewLastAttempt?.error, '应记录最近失败供界面显示');
    assert.equal(signingDue(b.id), false, '相同正文不应重复审');
    store.scenes.update(firstScene.id, { content: '首章正文已经改变' });
    assert.equal(signingDue(b.id), true, '正文变化后旧审阅必须自动陈旧');
  });

  test('④rewriteOpening：自动评审只登记开篇修订任务，原正文保持可用', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { rewriteOpening } = await import(pathToFileURL(path.join(ROOT, 'server/engine/signing.js')));
    const b = store.books.create({ title: '重写书', genre: '玄幻', blurb: 'x', platform: '番茄' });
    store.materials.set(b.id, 'contract', 'x');
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const chs = [];
    for (let i = 1; i <= 3; i++) {
      const ch = store.chapters.create(b.id, v.id, i, { title: `第${i}章`, status: 'done' });
      store.chapters.update(ch.id, { wordCount: 3000 });
      store.scenes.create(ch.id, 1, { pov: '林晚', location: '镇', beat: 'x', content: '雨还在下。', status: 'done', targetWords: 500 });
      store.summaries.set(ch.id, b.id, '摘要内容');
      store.chapterSettlements.set(b.id, ch.id, { contentHash: 'x', result: {} });
      chs.push(ch);
    }
    // 重写到 ch2（≤ 最大 done ch3）
    const r = await rewriteOpening(b.id, { toChapter: 2 });
    assert.equal(r.ok, true);
    assert.equal(r.staged, true, '应登记为待修订任务');
    const after = store.chapters.list(b.id);
    assert.equal(after.find(c => c.idx === 1).status, 'done', 'ch1 正文应保留');
    assert.equal(after.find(c => c.idx === 2).status, 'done', 'ch2 正文应保留');
    assert.equal(after.find(c => c.idx === 3).status, 'done', 'ch3 不受影响');
    assert.equal(store.scenes.list(chs[0].id).length, 1, '已写场景不得删除');
    assert.ok(store.materials.get(b.id, 'signing_revision_brief')?.content, '应保存修订任务单');
    // 守卫：重写超范围拒绝
    const r2 = await rewriteOpening(b.id, { toChapter: 5 });
    assert.equal(r2.ok, false, '超出最大已完成章应拒绝');
  });

  test('⑤漂移吸引力信号：2章情绪≤3 → 触发寡淡信号', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { detectDrift } = await import(pathToFileURL(path.join(ROOT, 'server/engine/recovery.js')));
    const b = store.books.create({ title: '漂移书', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    for (let i = 1; i <= 3; i++) {
      const ch = store.chapters.create(b.id, v.id, i, { title: `第${i}章`, status: 'done' });
      store.chapterHealth.add({ bookId: b.id, chapterId: ch.id, idx: i, notes: JSON.stringify({ emotion: { type: '平淡', intensity: 2 }, hook: null, payoff_count: 0 }) });
    }
    const r = detectDrift(b.id);
    assert.equal(r.trigger, true, '应触发漂移');
    assert.ok(r.signals.some(s => s.includes('寡淡')), '应含寡淡信号');
  });
});
