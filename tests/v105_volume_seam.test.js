// V0.105：卷缝前体检被 needs_attention 卡住时，不得拦住下一卷大纲建章
import './helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_NO_OPEN = '1';

const store = await import('../server/db/store.js');
const {
  shouldReviewVolumeBeforeLazyOutline,
  reviewDueVolumes,
  autoReviewVolumes,
} = await import('../server/engine/planning/volumereview.js');

function completeVolume(bookId, volumeId, idx) {
  const ch = store.chapters.create(bookId, volumeId, idx, { title: `第${idx}章`, status: 'done' });
  store.scenes.create(ch.id, 1, { content: `第${idx}章正文。`, status: 'done' });
  store.summaries.set(ch.id, bookId, `第${idx}章摘要`);
  return ch;
}

test('V0.105 安全闸拦截只记债，缝前体检与启动补审都不再重烧', async () => {
  const book = store.books.create({ title: '缝前体检书', genre: '历史' });
  const v1 = store.volumes.create(book.id, 1, { title: '已写完卷' });
  const v2 = store.volumes.create(book.id, 2, { title: '空卷待大纲' });
  completeVolume(book.id, v1.id, 1);
  completeVolume(book.id, v1.id, 2);
  store.volumeReviews.upsert(book.id, v1.id, {
    grade: 'C', report: { rewrite_failures: [{ code: 'REWRITE_REJECTED' }] },
    issues: [{ severity: 'P1', desc: '节奏平' }], status: 'needs_attention',
  });

  const due = reviewDueVolumes(book.id).filter(d => d.id === v1.id);
  assert.equal(due.length, 1, 'needs_attention 仍出现在候选里供展示');
  assert.equal(shouldReviewVolumeBeforeLazyOutline(due[0]), false);
  assert.equal(shouldReviewVolumeBeforeLazyOutline({ reason: '写完未体检' }), true);
  assert.equal(shouldReviewVolumeBeforeLazyOutline({ reason: '上次解析失败，重试' }), true);

  const results = await autoReviewVolumes(book.id, { maxVolumes: 1 });
  assert.equal(results.length, 0, '启动补审不得把安全闸拦截卷再审一遍');
  assert.equal(store.chapters.listByVolume(v2.id).length, 0);
});

test('V0.105 卷缝出口年早于规划起点时，承接年不得判 YEAR_OUTSIDE_PHASE', async () => {
  const longform = await import('../server/engine/longform/historical_longform.js');
  const phase = { startYear: 1261, endYear: 1264, startAge: 29, endAge: 32, anchor: '蒙古汗位之争' };
  const bridging = {
    chapters: [
      { idx: 1, year: 1259, era_year: '开庆元年', protagonist_age: 27, title: '北望余烟', beat: '清点断桅后的北岸余烟' },
      { idx: 2, year: 1260, era_year: '景定元年', protagonist_age: 28, title: '汗位空窗', beat: '蒙哥死后的汗位传闻传到合州' },
    ],
  };
  const blocked = longform.validateHistoricalVolumeOutline(bridging, phase);
  assert.ok(blocked.issues.some(i => i.code === 'YEAR_OUTSIDE_PHASE'), '无出口年时仍以规划起点为下限');

  const window = longform.historicalVolumeYearWindow(phase, 1259);
  assert.deepEqual(window, { minYear: 1259, maxYear: 1264, bridged: true });

  const allowed = longform.validateHistoricalVolumeOutline(bridging, phase, { previousExitYear: 1259 });
  assert.equal(allowed.issues.filter(i => i.code === 'YEAR_OUTSIDE_PHASE').length, 0);

  const tooEarly = longform.validateHistoricalVolumeOutline({
    chapters: [{ idx: 1, year: 1258, era_year: '宝祐六年', protagonist_age: 26, title: '回退', beat: '退回上一年' }],
  }, phase, { previousExitYear: 1259 });
  assert.ok(tooEarly.issues.some(i => i.code === 'YEAR_OUTSIDE_PHASE'));

  const outlineSrc = fs.readFileSync(path.join(process.cwd(), 'server/engine/planning/outline.js'), 'utf8');
  assert.match(outlineSrc, /previousExitYear/);
});
