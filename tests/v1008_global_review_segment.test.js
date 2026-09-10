// V0.100.8：整段复核必须按输入体量分段。
//
// 背景（实测）：第 1—34 章候选合计 149,366 字，按工程内 1.6 字/token 估算约 9.3 万输入
// token，再叠加 mid_story_review 的 thinking enabled + reasoningEffort high + maxTokens 10000。
// 整段复核是最后一道闸，这一次调用超窗或被掐断会把前面 19 章候选全部标 global_rejected、
// 全部作废——正是"返工跑不完"的形态。
// 本项目自己的先例（volumeReviewInstruction）也是看"各章摘要与结尾钩子"，不是把整卷全文
// 塞进一次调用；分段复核沿用同一条"有界上下文"原则，且后段带前段结论以保留累积判断。
'use strict';

import './helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../server/db/store.js');
const {
  GLOBAL_REVIEW_SEGMENT_CHARS,
  executeRecommendationRecovery,
  planGlobalReviewSegments,
} = await import('../server/engine/recommendation_recovery.js');
const { validateChapterRewrite } = await import('../server/engine/polish.js');
const { recommendationRecoveryGlobalReviewInstruction } = await import('../server/engine/prompts.js');

function fixtureText() {
  return [
 '雨脚越过东坡时，主角先把木尺压进泥里，再叫何平记下土色和水痕。',
    '石九从下方递来麻绳，绳结沾着细沙，众人因此停下第一辆石车。',
    '“七辆车里有一辆没有回签。”梁茂把名册按在膝头，指节压出一道白痕。',
 '主角没有立刻回营，他沿着新开的沟走了半里，直到靴底沾满泥浆。',
 '入夜前，何平回报说北望的哨点换了人，主角只说了一句：明日再看。',
  ].join('\n\n');
}

/**
 * 两轮盲审的 A/B 是互换的：第一轮候选居 B，第二轮候选居 A，两轮都选候选才算明确胜出。
 * 与 v1007 同型夹具保持一致，避免测试自己踩在评审口径上。
 */
function locallyWinningComparisons() {
  const scores = {
    A: { progression: 80, consequence: 80, character: 80, pull: 80 },
    B: { progression: 80, consequence: 80, character: 80, pull: 80 },
  };
  return [
    { winner: 'B', margin: 12, scores, evidence: { A: ['雨脚越过东坡时'], B: ['号角越过东坡时'] }, reason: '候选推进更快' },
    { winner: 'A', margin: 12, scores, evidence: { A: ['号角越过东坡时'], B: ['雨脚越过东坡时'] }, reason: '候选推进更快' },
  ];
}

test('V0.100.8 整段复核按输入体量分段，且分段连续不漏章', () => {
  const chapters = Array.from({ length: 34 }, (_, index) => ({
    idx: index + 1,
    title: '第' + (index + 1) + '章',
 text: '主角核对木牌，确认哨点仍在原位。'.repeat(200),
  }));
  const total = chapters.reduce((sum, chapter) => sum + chapter.text.length, 0);
  assert.ok(total > GLOBAL_REVIEW_SEGMENT_CHARS * 1.5, '夹具必须大到需要分段');

  const segments = planGlobalReviewSegments(chapters);
  assert.ok(segments.length > 1, '超预算时必须分段');
  for (const segment of segments) {
    const size = segment.reduce((sum, chapter) => sum + chapter.text.length, 0);
    assert.ok(size <= GLOBAL_REVIEW_SEGMENT_CHARS, '分段仍超预算：' + size);
  }
  const flattened = segments.flat().map(chapter => chapter.idx);
  assert.deepEqual(flattened, chapters.map(chapter => chapter.idx), '分段必须连续、不漏章、不重复');
  assert.equal(segments.at(-1).at(-1).idx, 34, '最后一章必须落在最后一段');
});

test('V0.100.8 单章超过预算时自成分段，不得被拆断或漏掉', () => {
  const chapters = [
    { idx: 1, title: '短章', text: '短。' },
 { idx: 2, title: '超长章', text: '主角核对木牌。'.repeat(Math.ceil((GLOBAL_REVIEW_SEGMENT_CHARS + 500) / 7)) },
    { idx: 3, title: '尾章', text: '收束。' },
  ];
  const segments = planGlobalReviewSegments(chapters);
  const flattened = segments.flat().map(chapter => chapter.idx);
  assert.deepEqual(flattened, [1, 2, 3], '超长章必须保留且不得打乱章序');
  assert.ok(segments.some(segment => segment.length === 1 && segment[0].idx === 2), '超长章自成分段');
});

test('V0.100.9 任一分段不成立即整批不落盘，矛盾的 pass+无推进也必须归一为否决', async () => {
  const book = store.books.create({ title: '整段复核分段', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const before = fixtureText();
  for (let idx = 1; idx <= 2; idx++) {
    const chapter = store.chapters.create(book.id, volume.id, idx, {
      title: '第' + idx + '章', status: 'done', wordCount: 800,
    });
    store.scenes.create(chapter.id, 1, { content: before, status: 'done', targetWords: 800 });
  }
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const orders = [1, 2].map(idx => ({
    chapter: idx, action: 'tune', objective: '推进第' + idx + '章',
    evidence: ['七辆车里有一辆没有回签'], reason: '停滞',
  }));
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 2, status: 'planned', workOrders: orders,
    result: { diagnosis_fingerprint: 'global-review-segmented' },
  });
 const rewritten = before + '\n\n号角越过东坡时，主角亲自把木尺插进泥里守到天亮。';
  assert.ok(validateChapterRewrite({ before, after: rewritten, chapterIdx: 1, targetChars: 800, peerChapters: [] }).ok);

  const reviewPrompts = [];
  let compareRound = 0;
  await executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task, messages }) => {
      const prompt = messages.at(-1)?.content || '';
      if (task === 'revise') return { content: rewritten, finishReason: 'stop' };
      if (task === 'opening_candidate_compare') {
        return { content: JSON.stringify(locallyWinningComparisons()[compareRound++ % 2]), finishReason: 'stop' };
      }
      reviewPrompts.push(prompt);
      const isLaterSegment = reviewPrompts.length > 1;
      return {
        content: JSON.stringify({
          // 模型有时会给出自相矛盾的“pass + sustained_progression=false”；
          // 领域层必须归一为 fail，否则候选仍会停在 local_passed 并被错误续跑。
          verdict: 'pass',
          sustained_progression: !isLaterSegment,
          evidence: ['号角越过东坡时'],
          reason: isLaterSegment ? '后段没有形成累积推进' : '前段递进成立',
          residual_risks: [],
        }),
        finishReason: 'stop',
      };
    },
    globalReviewSegmentChars: 300, // 每章约 215 字，两章合计超 300 → 强制分段
  });

  assert.equal(reviewPrompts.length, 2, '必须分成两次复核调用');
  assert.match(reviewPrompts[1], /前段结论/, '后段必须带上前段结论，否则跨段累积无从判断');

  const persisted = store.recommendationRecoveryRuns.get(run.id);
  assert.equal(persisted.status, 'failed', '任一分段否决时整批不落盘');
  assert.deepEqual(persisted.result.applied, [], '不得部分落盘');
  assert.equal(persisted.result.completion, 'global_rejected');
  assert.equal(persisted.result.globalReview.verdict, 'fail', '矛盾裁决必须归一为 fail');
  for (const candidate of persisted.result.candidates) {
    if (candidate.status === 'accepted') {
      assert.equal(candidate.provenance.validationState, 'global_rejected', '整段否决的候选不得再冒充已验证');
    }
  }
});

test('V0.100.8 全部分段通过才落盘，并保留各段结论', async () => {
  const book = store.books.create({ title: '整段复核全通过', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const before = fixtureText();
  for (let idx = 1; idx <= 2; idx++) {
    const chapter = store.chapters.create(book.id, volume.id, idx, {
      title: '第' + idx + '章', status: 'done', wordCount: 800,
    });
    store.scenes.create(chapter.id, 1, { content: before, status: 'done', targetWords: 800 });
  }
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const orders = [1, 2].map(idx => ({
    chapter: idx, action: 'tune', objective: '推进第' + idx + '章',
    evidence: ['七辆车里有一辆没有回签'], reason: '停滞',
  }));
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 2, status: 'planned', workOrders: orders,
    result: { diagnosis_fingerprint: 'global-review-all-pass' },
  });
 const rewritten = before + '\n\n号角越过东坡时，主角亲自把木尺插进泥里守到天亮。';
  let compareRound = 0;

  const result = await executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task }) => {
      if (task === 'revise') return { content: rewritten, finishReason: 'stop' };
      if (task === 'opening_candidate_compare') {
        return { content: JSON.stringify(locallyWinningComparisons()[compareRound++ % 2]), finishReason: 'stop' };
      }
      return {
        content: JSON.stringify({
          verdict: 'pass', sustained_progression: true,
          segment_consistency: true,
          evidence: ['号角越过东坡时'], reason: '两段都形成累积推进', residual_risks: [],
        }),
        finishReason: 'stop',
      };
    },
    globalReviewSegmentChars: 300,
    narrativeRevisionImpl: async () => ({ revisionId: 'revision-segmented' }),
  });

  assert.equal(result.completion, 'complete');
  assert.equal(result.applied.length, 2);
  assert.equal(result.globalReview.verdict, 'pass');
  assert.equal(result.globalReview.segments.length, 2, '必须保留各段结论供追溯');
});

test('V0.100.9 各分段局部通过后仍须跨段总复核，不能把局部绿灯直接当整体连续', async () => {
  const book = store.books.create({ title: '边界交接检查', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const before = fixtureText();
  for (let idx = 1; idx <= 2; idx++) {
    const chapter = store.chapters.create(book.id, volume.id, idx, {
      title: '第' + idx + '章', status: 'done', wordCount: 800,
    });
    store.scenes.create(chapter.id, 1, { content: before, status: 'done', targetWords: 800 });
  }
  store.publicationProfiles.upsert(book.id, { recommendationStage: 'failed', publishedChapterCount: 0 });
  const orders = [1, 2].map(idx => ({
    chapter: idx, action: 'tune', objective: '推进第' + idx + '章',
    evidence: ['七辆车里有一辆没有回签'], reason: '停滞',
  }));
  const run = store.recommendationRecoveryRuns.create(book.id, {
    startChapter: 1, endChapter: 2, status: 'planned', workOrders: orders,
    result: {
      diagnosis_fingerprint: 'cross-segment-review',
      repair_plan: {
        arcs: [{
          id: 'arc-handoff', chapters: [1, 2], problem: '交接断裂',
 entry_state: '名册仍在梁茂手中', exit_state: '主角依据名册行动',
          causal_steps: [
            { chapter: 1, required_change: '梁茂确认缺签' },
 { chapter: 2, required_change: '主角接过名册追查' },
          ],
          protected_facts: ['名册不能无交接换手'],
        }],
        chapter_orders: orders,
      },
    },
  });
 const rewritten = before + '\n\n号角越过东坡时，主角亲自把木尺插进泥里守到天亮。';
  const reviewPrompts = [];
  let compareRound = 0;
  let commitCalls = 0;

  const result = await executeRecommendationRecovery(book.id, run.id, {
    runTaskImpl: async ({ task, messages }) => {
      if (task === 'revise') return { content: rewritten, finishReason: 'stop' };
      if (task === 'opening_candidate_compare') {
        return { content: JSON.stringify(locallyWinningComparisons()[compareRound++ % 2]), finishReason: 'stop' };
      }
      const prompt = messages.at(-1)?.content || '';
      reviewPrompts.push(prompt);
      if (prompt.includes('跨段总复核')) {
        return {
          content: JSON.stringify({
            verdict: 'fail', sustained_progression: false, segment_consistency: false,
            evidence: ['号角越过东坡时'],
            reason: '两段各自有推进，但名册跨段无交接换手，整体因果断裂',
            residual_risks: ['角色持物状态冲突'],
          }),
          finishReason: 'stop',
        };
      }
      return {
        content: JSON.stringify({
          verdict: 'pass', sustained_progression: true,
          evidence: ['号角越过东坡时'], reason: '本段局部推进成立', residual_risks: [],
        }),
        finishReason: 'stop',
      };
    },
    globalReviewSegmentChars: 300,
    narrativeRevisionImpl: async () => { commitCalls++; return { revisionId: 'must-not-commit' }; },
  });

  assert.equal(reviewPrompts.length, 3, '两次分段审查后必须再有一次跨段总复核');
  assert.match(reviewPrompts[2], /跨段总复核/);
  assert.match(reviewPrompts[2], /名册不能无交接换手|全范围因果修复计划/,
    '跨段总复核必须看到整体计划与保护事实，不能只拼模型自评');
  assert.equal(result.completion, 'global_rejected');
  assert.equal(result.globalReview.failedStage, 'cross_segment');
  assert.equal(commitCalls, 0, '跨段总复核否决后不得进入原子提交');
  assert.equal(store.recommendationRecoveryRuns.get(run.id).status, 'failed');
});

test('V0.100.8 分段复核仍必须看到整段诊断索引，不得只剩本段图景', () => {
 // 实测：整段否决的真实原因是"23-30 章连续八章调查停滞"这种跨章累积。
  // 若分段后评审只拿到本段索引，跨段同源的重复模式会被当成局部瑕疵放行。
  const curve = [1, 2, 3, 4].map(idx => ({
    chapter: idx, action: 'tune', score: 60, reason: '第' + idx + '章停滞',
  }));
  const instruction = recommendationRecoveryGlobalReviewInstruction({
    bookTitle: '整段图景',
 chapters: [{ idx: 1, title: '第一章', text: '主角核对木牌。' }],
    qualityCurve: curve,
    segmentIndex: 1, segmentCount: 2,
    priorConclusions: ['第1章：通过（递进成立）'],
    precedingTail: '',
  });
  for (const item of curve) {
    assert.ok(instruction.includes('第' + item.chapter + '章['), '整段索引必须保留每一章：第' + item.chapter + '章');
  }
  assert.ok(instruction.includes('第1章[本段]'), '本段章必须标注为本段');
  assert.ok(instruction.includes('第3章[段外]'), '段外章必须保留并标注为段外');
  assert.match(instruction, /前段结论/);
});
