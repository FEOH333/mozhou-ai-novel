// V0.100.10：推荐返工诊断的证据定位必须既不误杀真实短引文，也不让模型近似转述
// 在两次纠正后继续拖死整批。最终兜底只采用能回指正文的真实片段；夹杂错字/错归因的
// 行保守降级为 keep，完整幻觉仍失败关闭。
'use strict';

import './helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../server/db/store.js');
const {
  diagnoseRecommendationRecovery,
  validateRecoveryDiagnosis,
} = await import('../server/engine/recommendation_recovery.js');

function diagnosisRow(chapter, evidence, action = 'tune') {
  return {
    chapter,
    score: action === 'keep' ? 82 : 58,
    action,
    evidence: [evidence],
    effective_events: ['人物收到消息并作出反应'],
    irreversible_change: '',
    character_cost: '',
    promise_delivery: '',
    filler_signals: [],
    ending_pull: '局面如何继续',
    reason: '模型认为本章需要调整',
    rebuild_objective: action === 'keep' ? '' : '压实事件后果',
  };
}

test('V0.100.10 三字符真实短引文先做精确定位，不再被四字符投影下限误杀', () => {
  const text = '他盯着那只手，看了两息。然后他骂了一声：“晦气。”他把饼扔到断砖上。';
  const result = validateRecoveryDiagnosis({
    quality_curve: [diagnosisRow(4, '晦气。', 'keep')],
    segment_verdict: { deterioration_found: false, turn_chapter: null, reason: '本章有效' },
  }, [{ idx: 4, title: '饿殍路', text }]);
  assert.deepEqual(result.quality_curve[0].evidence, ['晦气。']);
});

test('V0.100.10 模型夹入零宽格式字符时仍映射回正文真实切片', () => {
  const text = '然后他骂了一声：“晦气。”他把饼扔到断砖上。';
  const result = validateRecoveryDiagnosis({
    quality_curve: [diagnosisRow(4, '晦\u200b气。', 'keep')],
    segment_verdict: { deterioration_found: false, turn_chapter: null, reason: '本章有效' },
  }, [{ idx: 4, title: '饿殍路', text }]);
  assert.deepEqual(result.quality_curve[0].evidence, ['晦气。']);
});

test('V0.100.10 两次纠正后仍是近似引文时，只采真实核心并隔离该行，不再终止整批', async () => {
  const book = store.books.create({ title: '近似引文最终兜底', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapterTwoText = [
    '父亲夹了一筷子菜，搁在碗沿上。筷子停了停，他说：“明天天不亮，你娘带你跟昱儿往南走。”',
    '“老陆。”赵四压着嗓子，喘得厉害，“你看见了？”父亲没回头。“看见了。”',
    '“大安军破了。”赵四的声音抖了一下，又稳住了。',
  ].join('\n');
  const chapterFourText = '他盯着那只手，看了两息。然后他骂了一声：“晦气。”他把嘴里叼着的一张饼扯下来，往地上摔。';
  for (const [idx, title, text] of [
    [2, '军报', chapterTwoText],
    [4, '饿殍路', chapterFourText],
  ]) {
    const chapter = store.chapters.create(book.id, volume.id, idx, {
      title, status: 'done', wordCount: text.length,
    });
    store.scenes.create(chapter.id, 1, { content: text, status: 'done', targetWords: text.length });
  }
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });

  let calls = 0;
  const events = [];
  const run = await diagnoseRecommendationRecovery(book.id, {
    startChapter: 2,
    endChapter: 4,
    onEvent: event => events.push(event),
    runTaskImpl: async () => {
      calls += 1;
      return {
        content: JSON.stringify({
          quality_curve: [
            diagnosisRow(2, calls === 1
              ? '明日天不亮，你娘带你跟昱儿往南走。'
              : '大安军破了。”赵四压着嗓子'),
            diagnosisRow(4, calls < 3 ? '晦气。' : '晦气。”他把嘴里叼着的饼扯下来'),
          ],
          segment_verdict: { deterioration_found: true, turn_chapter: 2, reason: '两章需要调整' },
        }),
        finishReason: 'stop',
      };
    },
  });

  assert.equal(calls, 3, '仍先给模型两次纠正机会，第三次才启用本地安全兜底');
  assert.equal(run.status, 'planned');
  assert.deepEqual(run.quality_curve.map(row => row.action), ['keep', 'keep'], '夹杂错引的行不得触发改稿');
  assert.equal(run.work_orders.length, 0);
  for (const row of run.quality_curve) {
    const source = row.chapter === 2 ? chapterTwoText : chapterFourText;
    assert.ok(row.evidence.length >= 1, `第${row.chapter}章至少保留一段真实核心`);
    assert.ok(row.evidence.every(quote => source.includes(quote)), `第${row.chapter}章落库证据必须逐字来自正文`);
    assert.ok(row.validation_warnings?.some(item => item.code === 'partial_evidence_isolated'));
  }
  assert.ok(events.some(event => event.type === 'recovery_evidence_isolated'), '事件流应明确告诉作者已隔离近似引文');
});

test('V0.100.10 完全没有正文核心的幻觉引文仍然失败关闭', async () => {
  const book = store.books.create({ title: '完整幻觉仍失败', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '河滩', status: 'done', wordCount: 30,
  });
  store.scenes.create(chapter.id, 1, {
 content: '主角沿着河滩走过芦苇荡。', status: 'done', targetWords: 30,
  });
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });

  let calls = 0;
  await assert.rejects(() => diagnoseRecommendationRecovery(book.id, {
    startChapter: 1,
    endChapter: 1,
    runTaskImpl: async () => {
      calls += 1;
      return {
        content: JSON.stringify({
          quality_curve: [diagnosisRow(1, '天外神龙掀翻整座皇城')],
          segment_verdict: { deterioration_found: true, turn_chapter: 1, reason: '幻觉' },
        }),
        finishReason: 'stop',
      };
    },
  }), /无法在原文定位/);
  assert.equal(calls, 3);
});
