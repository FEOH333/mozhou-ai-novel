// V0.105：番茄发稿自查 / 中期防崩编成占用轴合同，禁止同构考卷与额外 LLM 环节。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const store = await import('../server/db/store.js');
const {
  compileCraftOccupancy, craftHits, detectCraftIssues, healCraftMorphology, craftRegression,
  CRAFT_BRIEF_MAX_CHARS, compileBookCraftOccupancy, buildLedgerCheckBrief,
} = await import('../server/engine/quality/craft_occupancy.js');
const {
  compileStageWindow, stageTaskIssues, fourElementIssues, conflictFocusIssues,
} = await import('../server/engine/planning/stage_window.js');
const { chapterOutlineQualityIssues } = await import('../server/engine/planning/outline.js');
const { auditVerdictAfterBudget } = await import('../server/engine/pipeline/pipeline.js');
const { shouldRunMidStoryReview } = await import('../server/engine/quality/polish.js');
const { applyForeshadowActions } = await import('../server/engine/narrative/foreshadow.js');
const { writeSceneInstruction, chapterOutlineInstruction, midStoryReviewInstruction } = await import('../server/engine/prompts.js');
const { platformGuidanceText } = await import('../server/data/platform_guidance.js');
const { PREPUBLISH_CRAFT_TEXT } = await import('../server/data/literary_techniques.js');
const { REDLINES } = await import('../server/data/redlines.js');

const fatScenes = () => [1, 2, 3, 4].map(i => ({
  id: `s${i}`, beat: `场面${i}推进新信息与新关系`, target_words: 900,
}));

test('V0.105 空占用零注入，不含身份标签/四要素/断簪考卷', () => {
  const contract = compileCraftOccupancy([]);
  assert.equal(contract.text, '');
  assert.equal(Object.keys(contract.occupied || {}).filter(k => contract.occupied[k]).length, 0);
  assert.doesNotMatch(contract.text, /身份标签|四要素|断簪/);
});

test('V0.105 只点名已占用轴，不附带未占用禁令', () => {
  const contract = compileCraftOccupancy([{ name_bomb: true }]);
  assert.match(contract.text, /人名/);
  assert.doesNotMatch(contract.text, /阶梯|身份标签|因此|四要素|断簪/);
  assert.ok(contract.text.length <= CRAFT_BRIEF_MAX_CHARS);
});

test('V0.105 全轴占用仍不超过简报字符预算', () => {
  const all = {
    name_bomb: true, identity_dump: true, dual_interior: true, connector_run: true,
    long_sentence_streak: true, staircase: true, two_speaker_para: true, travel_ending: true,
  };
  const contract = compileCraftOccupancy([all]);
  assert.ok(contract.text.length > 0);
  assert.ok(contract.text.length <= CRAFT_BRIEF_MAX_CHARS, `简报 ${contract.text.length} 超预算`);
});

test('V0.105 无花名册不误报人名轰炸', () => {
  const text = '苏婉、苏莲、苏父、苏母、王妈妈都在席间喝茶。';
  const hits = craftHits(text, { rosterNames: [] });
  assert.equal(hits.name_bomb, false);
  assert.equal(detectCraftIssues(text, { rosterNames: [] }).length, 0);
});

test('V0.105 阶梯假排版/双说话人/超额因此可本地愈合且复检归零', () => {
  const stairs = '苏婉。\n\n很慌。\n\n想说。\n\n说不出。';
  const twoSpeak = '萧烬问道：“你是谁？”黑衣人说：“你不用知道。”';
  const connectors = '因此甲先动。因此乙再动。因此丙收网。';
  const healedStairs = healCraftMorphology(stairs);
  const healedSpeak = healCraftMorphology(twoSpeak);
  const healedConn = healCraftMorphology(connectors);
  assert.equal(healedStairs.healed, true);
  assert.equal(healedSpeak.healed, true);
  assert.equal(healedConn.healed, true);
  assert.equal(craftHits(healedStairs.content).staircase, false);
  assert.equal(craftHits(healedSpeak.content).two_speaker_para, false);
  assert.equal(craftHits(healedConn.content).connector_run, false);
  assert.equal(detectCraftIssues(healedStairs.content).length, 0);
});

test('V0.105 文学软项带 proseFix，预算耗尽记债放行', () => {
  const dual = '苏婉心想，我没有拿玉佩。苏莲心想，这次你死定了。';
  const issues = detectCraftIssues(dual);
  assert.ok(issues.some(i => i.proseFix && i.axis === 'dual_interior'));
  const deferred = auditVerdictAfterBudget({
    verdict: 'fix',
    issues: issues.map(i => ({ ...i, type: '语句质量', severity: 'medium' })),
  });
  assert.equal(deferred.verdict, 'defer');
});

test('V0.105 修订把收束改成近章赶路空镜则拒收', () => {
  const occupancy = compileCraftOccupancy([{ travel_ending: true }]);
  const before = '她把证据按在案上：“今夜之前，名单必须到北崖。”';
  const after = '前头路还长，大家继续赶路。天色渐晚，路旁柳树被风吹得沙沙响。';
  const verdict = craftRegression(before, after, occupancy);
  assert.equal(verdict.reject, true);
});

test('V0.105 四要素缺一条不 hard，四条全空才 hard', () => {
  const missingOne = fourElementIssues({
    goal: '提交证据', conflict: '长老发难', turn: '证人站队', reader_pull: '',
    scenes: fatScenes(),
  });
  assert.equal(missingOne.some(i => i.hard), false);
  const voidAll = fourElementIssues({
    goal: '', conflict: '', turn: '', reader_pull: '',
    scenes: fatScenes(),
  });
  assert.ok(voidAll.some(i => i.hard && i.code === 'OUTLINE_FOUR_ELEMENT_VOID'));
  const viaGate = chapterOutlineQualityIssues({
    goal: '提交证据', conflict: '长老发难', turn: '证人站队', reader_pull: '',
    scenes: fatScenes(),
  });
  assert.equal(viaGate.some(i => i.code === 'OUTLINE_FOUR_ELEMENT_VOID'), false);
});

test('V0.105 阶段关卡签名重复才 outline hard', () => {
  const window = compileStageWindow([
    { idx: 21, beat: '进村探查确认屠村不是普通劫杀' },
    { idx: 22, beat: '进村探查再确认一遍屠村不是普通劫杀' },
    { idx: 23, beat: '带证据换入宗名额当众打脸' },
  ], 22);
  const issues = stageTaskIssues({ goal: '再探村', beat: '进村探查再确认一遍屠村不是普通劫杀' }, window);
  assert.ok(issues.some(i => i.hard && i.code === 'OUTLINE_STAGE_TASK_REPEATED'));
  const ok = stageTaskIssues({ goal: '换名额', beat: '带证据换入宗名额当众打脸' }, compileStageWindow([
    { idx: 21, beat: '进村探查确认屠村不是普通劫杀' },
    { idx: 22, beat: '找到凶手留下的标记' },
    { idx: 23, beat: '带证据换入宗名额当众打脸' },
  ], 23));
  assert.equal(ok.some(i => i.hard), false);
});

test('V0.105 冲突焦点只在阶段边界比较，不每章考智斗', () => {
  const same = conflictFocusIssues('face_slap', 'face_slap', { stageStart: true });
  assert.ok(same.some(i => i.hard && i.code === 'OUTLINE_CONFLICT_FOCUS_REPEATED'));
  const midStage = conflictFocusIssues('face_slap', 'face_slap', { stageStart: false });
  assert.equal(midStage.length, 0);
  const changed = conflictFocusIssues('dilemma', 'face_slap', { stageStart: true });
  assert.equal(changed.length, 0);
});

test('V0.105 字数关与每10章关不双触发中期审阅', () => {
  assert.equal(shouldRunMidStoryReview({ written: 10, totalWords: 100000, lastReviewWritten: 0, lastReviewWords: 0 }), true);
  assert.equal(shouldRunMidStoryReview({ written: 10, totalWords: 100000, lastReviewWritten: 10, lastReviewWords: 100000 }), false);
  assert.equal(shouldRunMidStoryReview({ written: 15, totalWords: 100000, lastReviewWritten: 10, lastReviewWords: 0 }), true);
  assert.equal(shouldRunMidStoryReview({ written: 15, totalWords: 100000, lastReviewWritten: 10, lastReviewWords: 100000 }), false);
  assert.equal(shouldRunMidStoryReview({ written: 9, totalWords: 50000, lastReviewWritten: 0, lastReviewWords: 0 }), false);
});

test('V0.105 写前四表简报提及才注入且条数封顶', () => {
  const brief = buildLedgerCheckBrief({
    chapterIdx: 25,
    mentionedNames: ['江绮'],
    timeline: Array.from({ length: 12 }, (_, i) => ({ event: `事件${i}`, year: 1259 })),
    characters: [
      { name: '江绮', lastChapter: 24, location: '黑水村' },
      { name: '路人甲', lastChapter: 3, location: '京城' },
    ],
    foreshadows: Array.from({ length: 10 }, (_, i) => ({
      desc: `伏笔${i}`, planted_chapter: 10, payoff_chapter: 30, status: 'planted',
    })),
  });
  assert.match(brief, /江绮/);
  assert.doesNotMatch(brief, /路人甲/);
  assert.ok((brief.match(/伏笔/g) || []).length <= 6);
});

test('V0.105 伏笔无正文锚点隔离入账不新建', () => {
  const book = store.books.create({ title: '锚点隔离', genre: '玄幻' });
  const chapterText = '江绮把令牌按在桌上，缺角对着烛火。';
  const isolated = applyForeshadowActions(book.id, [
    { action: 'plant', desc: '掌心异火', note: '体内有火' },
  ], 2, { chapterText });
  assert.equal(isolated.planted, 0);
  assert.equal(isolated.isolated, 1);
  assert.equal(store.foreshadows.list(book.id).length, 0);
  const anchored = applyForeshadowActions(book.id, [
    { action: 'plant', desc: '令牌缺角', quote: '缺角对着烛火' },
  ], 2, { chapterText });
  assert.equal(anchored.planted, 1);
  assert.equal(store.foreshadows.list(book.id).length, 1);
});

test('V0.105 写作指令空占用不灌番茄课全文', () => {
  const prompt = writeSceneInstruction({
    bookTitle: '测', chapterIdx: 2, chapterTitle: '夜探', scene: { id: 's1', beat: '对质', target_words: 900, pov: '甲', location: '厅' },
    scenesBefore: [], sceneAfter: null, prevTail: '',
    craftOccupancyText: '',
    diversityText: '',
  });
  assert.doesNotMatch(prompt, /断簪|身份标签|四要素钉死/);
  assert.ok(PREPUBLISH_CRAFT_TEXT.includes('变化') || PREPUBLISH_CRAFT_TEXT.includes('发稿'));
});

test('V0.105 细纲指令只注入阶段已用关卡', () => {
  const prompt = chapterOutlineInstruction({
    bookTitle: '测', chapterIdx: 22,
    stageOccupancyText: '【本阶段关卡】已用：进村探查。本章推进未占用关卡。',
  });
  assert.match(prompt, /已用：进村探查/);
  assert.doesNotMatch(prompt, /断簪/);
});

test('V0.105 中期审阅指令含四表复盘且不改已写章', () => {
  const text = midStoryReviewInstruction({
    bookTitle: '测', chapterCount: 20, contract: '', outline: '', recent: '', openText: '', arcText: '', pleasure: '',
  });
  assert.match(text, /世界观|人物|时间线|伏笔/);
  assert.match(text, /不要修改已写章节|不改已写/);
});

test('V0.105 平台指导收录两篇官方课且不是审核阈值', () => {
  const text = platformGuidanceText('番茄');
  assert.match(text, /发稿前|自查|中后期|阶段/);
  assert.match(text, /不是审核阈值/);
  const official = text.split('【未证实，禁止当作规则】')[0];
  assert.doesNotMatch(official, /留存率\s*[><=]|第20章必然/);
});

test('V0.105 红线阈值写审同源且非历史零误杀', () => {
  assert.equal(REDLINES.nameBombUniqueMax, 4);
  assert.equal(REDLINES.connectorDetectMedium, 3);
  assert.equal(REDLINES.longSentenceStreak, 3);
  const xuanhuan = store.books.create({ title: '仙途', genre: '玄幻' });
  const empty = compileBookCraftOccupancy(xuanhuan.id, 1);
  assert.equal(empty.text, '');
});

test('V0.105 占用编译器接入写章路径且不新增模型任务', () => {
  const writeSrc = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/write.js'), 'utf8');
  const polishSrc = fs.readFileSync(path.join(ROOT, 'server/engine/quality/polish.js'), 'utf8');
  const clientSrc = fs.readFileSync(path.join(ROOT, 'server/llm/client.js'), 'utf8');
  const recoverySrc = fs.readFileSync(path.join(ROOT, 'server/engine/recovery/recommendation_recovery.js'), 'utf8');
  assert.match(writeSrc, /healCraftMorphology/);
  assert.match(writeSrc, /compileBookCraftOccupancy/);
  assert.match(polishSrc, /shouldRunMidStoryReview/);
  assert.match(recoverySrc, /!issue\.axis/);
  assert.doesNotMatch(clientSrc, /prepublish_check|stage_outline_llm/);
});

test('V0.105 返工文风闸不把发稿占用轴当 AI 模板腔', async () => {
  const { validateRecoveryProseImprovement } = await import('../server/engine/recovery/recommendation_recovery.js');
 const old = '众人围着火盆反复商量，天色从黄昏拖到深夜。主角始终没有作出决定，局势仍停在原处。';
 const neu = '众人围着火盆商量完，主角把腰牌按在案上：“今夜之前，名单必须到北崖。”';
  assert.equal(craftHits(old).travel_ending, true);
  assert.equal(validateRecoveryProseImprovement(old, neu).ok, true);
});
