import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v100-quality-context-'));
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_NO_OPEN = '1';

const store = await import('../server/db/store.js');
const { assembleCreativeMessages } = await import('../server/llm/context_planner.js');
const { chapterOutlineQualityIssues } = await import('../server/engine/planning/outline.js');
const { writeSceneInstruction } = await import('../server/engine/prompts.js');
const { PLOT_DEAI_TEXT } = await import('../server/engine/quality/plot_ai.js');
const {
  CONTINUITY_CRAFT_TEXT,
  ENVIRONMENT_TEXT,
  PSYCHOLOGY_TEXT,
  techniqueInjection,
  buildDynamicStyle,
} = await import('../server/data/literary_techniques.js');

function outline(overrides = {}) {
  return {
    title: '断桥之后',
    pace: 'advance',
 goal: '主角必须决定是否烧掉退路文书',
    conflict: '保住退路与抢先突围不可兼得',
 dramatic_question: '主角敢不敢亲手断掉退路？',
    counterforce: '同伴反对且敌军正在合围',
    turn: '退路文书已落入敌方斥候视线',
 irreversible_change: '主角烧毁文书并带队转入陌生山道',
    choice_cost: '失去原路撤回的可能并承担十人性命',
    reader_gain: '得到突围路线与主角责任升级',
    reader_pull: '山道尽头出现本不该在此的宋军旗号',
 checkpoints: ['主角烧掉文书', '十人进入山道', '宋军旗号出现'],
    scenes: [
 { id: 's1', pov: '主角', location: '营门', beat: '主角发现斥候逼近，必须在交出文书与烧毁退路之间作选择。', target_words: 1700 },
 { id: 's2', pov: '主角', location: '山道', beat: '主角承担同伴反对，烧毁文书后带十人进入陌生山道。', target_words: 1700 },
 { id: 's3', pov: '主角', location: '断桥', beat: '追兵封死回头路，山道尽头却出现不合时宜的宋军旗号。', target_words: 1600 },
    ],
    ...overrides,
  };
}

test('V0.100 creative context keeps only two prior chapters plus current preceding scenes', () => {
  const book = store.books.create({ title: '上下文测试' });
  store.history.append(book.id, 'system', '固定系统');
  store.history.append(book.id, 'user', '固定材料');
  const chapters = [];
  for (let idx = 1; idx <= 5; idx++) {
    const chapter = store.chapters.create(book.id, null, idx, { title: `第${idx}章`, status: idx < 5 ? 'done' : 'writing' });
    store.scenes.create(chapter.id, 1, {
      content: idx < 5 ? `第${idx}章独有正文${'甲'.repeat(80)}` : '当前章前一场景独有句',
      status: 'done',
    });
    if (idx < 5) store.summaries.set(chapter.id, book.id, `第${idx}章摘要`);
    chapters.push(chapter);
  }
  const currentScene = store.scenes.create(chapters[4].id, 2, { content: '', status: 'planned' });
  const messages = assembleCreativeMessages(book.id, [{ role: 'user', content: '写当前场景' }], {
    chapterId: chapters[4].id,
    sceneId: currentScene.id,
    recentChapterCount: 2,
  });
  const joined = messages.map(message => message.content).join('\n');

  assert.doesNotMatch(joined, /第1章独有正文|第2章独有正文/);
  assert.match(joined, /第3章独有正文/);
  assert.match(joined, /第4章独有正文/);
  assert.match(joined, /当前章前一场景独有句/);
  assert.equal(messages[0].content, '固定系统');
  assert.match(messages[1].content, /固定材料/);
});

test('V0.100 prose brief prioritizes the scene instead of teaching stock gestures and checklist prose', () => {
  const prompt = writeSceneInstruction({
    bookTitle: '去模板测试', chapterIdx: 20, chapterTitle: '营门',
 goal: '主角必须决定是否断掉退路', conflict: '救人和保全撤退路线不可兼得',
    scene: {
 id: 's1', pov: '主角', location: '营门', scene_type: 'emotion', target_words: 1250,
 beat: '主角在撤退与救人之间作出选择，选择必须改变同伴下一步。',
    },
    scenesBefore: [], sceneAfter: null, prevTail: '', rollingSummary: '', recentSummaries: [],
    timelineEvents: [], futureChapters: [], foreshadowsText: '', factsText: '', worldbookText: '',
    constraints: '', styleRules: '', isHistory: true, sceneType: 'emotion',
    plotDeAI: PLOT_DEAI_TEXT, continuityCraft: CONTINUITY_CRAFT_TEXT,
    environmentText: ENVIRONMENT_TEXT, psychologyText: PSYCHOLOGY_TEXT,
    techniqueText: techniqueInjection('emotion'),
    dynamicStyle: buildDynamicStyle({ genre: '历史', sceneType: 'emotion', emotion: '紧张' }),
  });

  assert.ok(prompt.length < 5_500, `创作指令仍被规则墙淹没：${prompt.length} chars`);
  assert.doesNotMatch(prompt, /指节发麻|喉头发紧|眼眶发酸|对手失态|旁观震惊/,
    '负面示例和万能动作不能继续给模型作高频词诱饵');
  assert.match(prompt, /本场景独有|场景特有/, '应把注意力拉回人物、地点和本次选择的独特性');
  assert.match(prompt, /决定|选择.*改变/, '创作核心仍须保留因果变化');
});

test('V0.100 outline gate rejects missing dramatic contract and repeated causal skeleton', () => {
  const issues = chapterOutlineQualityIssues(outline({
    dramatic_question: '',
    counterforce: null,
    irreversible_change: '',
    _prospective_signature: 'observe>adult_verify>record>distant_signal',
  }), {
    chapterLength: 5000,
    recentPatterns: [
      { signature: 'observe>adult_verify>record>distant_signal' },
      { signature: 'observe>adult_verify>record>distant_signal' },
    ],
  });

  assert.ok(issues.some(issue => issue.code === 'OUTLINE_DRAMATIC_CONTRACT_MISSING' && issue.hard));
  assert.ok(issues.some(issue => issue.code === 'OUTLINE_STRUCTURE_REPEATED' && issue.hard));
});

test('V0.100 creative pipeline is wired to bounded context and isolated settlement context', () => {
  const root = process.cwd();
  const writeSource = fs.readFileSync(path.join(root, 'server/engine/pipeline/write.js'), 'utf8');
  const outlineSource = fs.readFileSync(path.join(root, 'server/engine/planning/outline.js'), 'utf8');
  const settleSource = fs.readFileSync(path.join(root, 'server/engine/pipeline/settle.js'), 'utf8');
  assert.match(writeSource, /assembleCreativeMessages\(bookId/);
  assert.match(outlineSource, /assembleCreativeMessages\(bookId/);
  assert.match(settleSource, /assembleReviewMessages\(bookId/);
  assert.doesNotMatch(settleSource, /assembleMessages\(bookId/);
  assert.match(settleSource, /validateNarrativeProjection\(projectionCandidate/,
    '正常结算也必须使用与返工回放同一证据门');
});

test('V0.100 chapter length gate reports a blocking issue before settlement', async () => {
  const { chapterCompletionLengthIssue } = await import('../server/engine/pipeline/pipeline.js');
  const book = store.books.create({ title: '短章门', settings: { lengthProfile: 5000 } });
  const chapter = store.chapters.create(book.id, null, 1, { title: '过短', status: 'drafted' });
  store.scenes.create(chapter.id, 1, { content: '短正文'.repeat(450), status: 'done' });
  const issue = chapterCompletionLengthIssue(book.id, chapter.id);
  assert.equal(issue.code, 'CHAPTER_LENGTH_BLOCKED');
  assert.ok(issue.hanChars < issue.floorChars);
});

test('V0.100 stale narrative state has a visible rebuild route and cockpit action', () => {
  const root = process.cwd();
  const serverSource = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(root, 'web/js/api.js'), 'utf8');
  const workshopSource = fs.readFileSync(path.join(root, 'web/js/views/workshop.js'), 'utf8');
  assert.match(serverSource, /GET', '\/api\/books\/:id\/narrative-state'/);
  assert.match(serverSource, /POST', '\/api\/books\/:id\/narrative-state\/rebuild'/);
  assert.match(apiSource, /narrative-state\/rebuild/);
  assert.match(workshopSource, /narrativeState\.requiresRebuild/, '旧书无账本也必须显示重建入口');
  assert.match(workshopSource, /叙事版本安全门/);
  assert.match(workshopSource, /旧摘要、旧人物状态、旧伏笔或旧大纲/);
});

test('V0.100 snapshot restore and completed-chapter deletion cannot bypass narrative-state invalidation', () => {
  const indexSource = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const restoreRoute = indexSource.match(/route\('POST', '\/api\/books\/:id\/snapshots\/:sid\/restore'[\s\S]*?\}, \{ owned: OWNED\.snapshot \}\);/)?.[0] || '';
  const deleteRoute = indexSource.match(/route\('DELETE', '\/api\/books\/:id\/chapters\/:cid'[\s\S]*?\}, \{ owned: OWNED\.chapter \}\);/)?.[0] || '';
  assert.match(restoreRoute, /markNarrativeStateStale/, '快照换正文后必须登记陈旧叙事版本');
  assert.match(deleteRoute, /markNarrativeStateStale/, '删除完成章后必须登记陈旧叙事版本');
});
