// V0.100.12：返工候选审计与整段复核都必须精确断点续跑。
'use strict';

import './helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../server/db/store.js');
const recovery = await import('../server/engine/recovery/recommendation_recovery.js');

function paragraphs(segments, size = 5) {
  const groups = [];
  for (let index = 0; index < segments.length; index += size) {
    groups.push(segments.slice(index, index + size).join(''));
  }
  return groups.join('\n\n');
}

function passingComparison(round) {
  const candidateIsB = round % 2 === 1;
  return {
    winner: candidateIsB ? 'B' : 'A',
    margin: 16,
    scores: candidateIsB
      ? {
          A: { progression: 30, consequence: 25, character: 35, pull: 28 },
          B: { progression: 82, consequence: 80, character: 78, pull: 76 },
        }
      : {
          A: { progression: 82, consequence: 80, character: 78, pull: 76 },
          B: { progression: 30, consequence: 25, character: 35, pull: 28 },
        },
    evidence: candidateIsB
      ? { A: ['始终没有定论'], B: ['拍案定下'] }
      : { A: ['分头准备'], B: ['守着火盆'] },
    reason: '候选形成行动与后果',
  };
}

test('V0.100.12 检查点合并保留尚未重跑的接受、拒绝和冻结审计', () => {
  assert.equal(typeof recovery.mergeCandidateAudits, 'function',
    '候选检查点必须共用一个可验证的合并入口');
  const previous = [
    { chapter: 1, status: 'accepted', after: '旧候选' },
    { chapter: 2, status: 'rejected', rejection: { code: 'RECOVERY_NO_CLEAR_IMPROVEMENT' } },
    { chapter: 3, status: 'frozen', rejection: { code: 'RECOVERY_CHAPTER_FROZEN' } },
  ];
  const current = [{ chapter: 1, status: 'accepted', after: '本轮更新候选' }];

  const merged = recovery.mergeCandidateAudits(previous, current);

  assert.deepEqual(merged.map(item => [item.chapter, item.status]), [
    [1, 'accepted'], [2, 'rejected'], [3, 'frozen'],
  ]);
  assert.equal(merged[0].after, '本轮更新候选', '本轮同章审计必须覆盖旧条目');
});

test('V0.100.12 整段复核从已通过分段继续，跨段通过后也不重复付费', async () => {
  const book = store.books.create({ title: '整段复核检查点', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapterOne = store.chapters.create(book.id, volume.id, 1, {
    title: '火盆', status: 'done', wordCount: 400,
  });
  const chapterTwo = store.chapters.create(book.id, volume.id, 2, {
    title: '营门', status: 'done', wordCount: 400,
  });
  const oneSegments = Array.from(
    { length: 20 },
    (_, index) => `第${index}段众人守着火盆反复商量，始终没有定论。`,
  );
  const twoSegments = Array.from(
    { length: 20 },
 (_, index) => `第${index}段主角在营门外踱步，雪粒打在甲叶上。`,
  );
  const oldOne = paragraphs(oneSegments);
  const newOneSegments = [...oneSegments];
 newOneSegments[0] = '第0段主角拍案定下撤退批次，众人分头准备。';
 newOneSegments[19] = '第19段主角环视众人，沉声道：“天明前，先走伤员。”';
  const newOne = paragraphs(newOneSegments);
  store.scenes.create(chapterOne.id, 1, { content: oldOne, status: 'done', targetWords: 400 });
  store.scenes.create(chapterTwo.id, 1, {
    content: paragraphs(twoSegments), status: 'done', targetWords: 400,
  });
  store.publicationProfiles.upsert(book.id, {
    recommendationStage: 'failed', publishedChapterCount: 0,
  });
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1,
    endChapter: 2,
    status: 'planned',
    result: { diagnosis_fingerprint: 'global-review-checkpoint-fixture' },
    workOrders: [{
      chapter: 1,
      action: 'tune',
      objective: '让商议转化为撤退行动',
      evidence: ['始终没有定论'],
      reason: '旧稿停在讨论，没有决定',
    }],
  });

  let phase = 1;
  let rewriteCalls = 0;
  let compareCalls = 0;
  const segmentCalls = [0, 0];
  let crossCalls = 0;
  let narrativeCalls = 0;
  const runTaskImpl = async ({ messages, jsonMode }) => {
    const prompt = messages.at(-1)?.content || '';
    if (!jsonMode && (prompt.includes('请完整重写《') || prompt.includes('请修订《'))) {
      rewriteCalls++;
      return { content: newOne, finishReason: 'stop' };
    }
    if (prompt.includes('匿名对照审稿')) {
      compareCalls++;
      return { content: JSON.stringify(passingComparison(compareCalls)), finishReason: 'stop' };
    }
    if (prompt.includes('跨段总复核')) {
      crossCalls++;
      return {
        content: JSON.stringify({
          verdict: 'pass', sustained_progression: true, segment_consistency: true,
 evidence: ['主角拍案定下'], reason: '两段因果与状态连续', residual_risks: [],
        }),
        finishReason: 'stop',
      };
    }
    if (prompt.includes('推荐返工整段复核')) {
      const segmentIndex = prompt.includes('第 1/2 段') ? 0 : 1;
      segmentCalls[segmentIndex]++;
      if (segmentIndex === 1 && phase === 1) throw new Error('TEST_SECOND_SEGMENT_INTERRUPTED');
      return {
        content: JSON.stringify({
          verdict: 'pass', sustained_progression: true,
 evidence: [segmentIndex === 0 ? '主角拍案定下' : '雪粒打在甲叶上'],
          reason: `第${segmentIndex + 1}段形成持续推进`, residual_risks: [],
        }),
        finishReason: 'stop',
      };
    }
    throw new Error(`TEST_UNEXPECTED_TASK: ${prompt.slice(0, 60)}`);
  };
  const narrativeRevisionImpl = async () => {
    narrativeCalls++;
    throw new Error('TEST_STOP_AFTER_GLOBAL_REVIEW');
  };

  await assert.rejects(() => recovery.executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl,
    narrativeRevisionImpl,
    globalReviewSegmentChars: 100,
  }), /TEST_SECOND_SEGMENT_INTERRUPTED/);
  let checkpoint = store.recommendationRecoveryRuns.get(run.id).result.global_review_checkpoint;
  assert.equal(checkpoint.completed_segments, 1);
  assert.equal(checkpoint.total_segments, 2);
  assert.deepEqual(checkpoint.segments.map(item => item.segment), [1]);
  assert.equal(checkpoint.cross_review, null);

  phase = 2;
  await assert.rejects(() => recovery.executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl,
    narrativeRevisionImpl,
    globalReviewSegmentChars: 100,
  }), /TEST_STOP_AFTER_GLOBAL_REVIEW/);
  checkpoint = store.recommendationRecoveryRuns.get(run.id).result.global_review_checkpoint;
  assert.deepEqual(segmentCalls, [1, 2], '续跑只能重做中断的第2段，不能重审已通过的第1段');
  assert.equal(checkpoint.completed_segments, 2);
  assert.equal(checkpoint.cross_review?.verdict, 'pass');
  assert.equal(crossCalls, 1);
  assert.equal(rewriteCalls, 1, '同一运行的已验证候选不得重复生成');
  assert.equal(compareCalls, 2, '同一运行的已验证候选不得重复盲审');

  phase = 3;
  await assert.rejects(() => recovery.executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl,
    narrativeRevisionImpl,
    globalReviewSegmentChars: 100,
  }), /TEST_STOP_AFTER_GLOBAL_REVIEW/);
  assert.deepEqual(segmentCalls, [1, 2], '跨段复核已通过后不得再次调用任何分段复核');
  assert.equal(crossCalls, 1, '跨段总复核已通过后也必须从检查点复用');
  assert.equal(narrativeCalls, 2, '两次都应直接进入尚未完成的影子投影阶段');
});
