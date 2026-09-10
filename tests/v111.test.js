// V0.92 全书生命周期：分阶段推进与卷纲硬校验
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v111-lifecycle-'));
const ROOT = process.cwd();

const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const lifecycle = await import(pathToFileURL(path.join(ROOT, 'server/engine/longform_lifecycle.js')));
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
const pleasure = await import(pathToFileURL(path.join(ROOT, 'server/engine/pleasure.js')));
const outlineEngine = await import(pathToFileURL(path.join(ROOT, 'server/engine/outline.js')));

describe('V0.92 全书生命周期阶段', () => {
 test('《示例历史长篇》十五卷按通用位置映射推进，终卷只在第十五卷', () => {
    const book = store.books.create({
 title: '示例历史长篇', genre: '历史',
      blurb: '淳祐元年九岁失家，十八年后守钓鱼城，四十年重整山河。',
    });
    for (let idx = 1; idx <= 15; idx++) store.volumes.create(book.id, idx, { title: `卷${idx}` });
    const actual = Array.from({ length: 15 }, (_, i) => lifecycle.resolveBookStage(book.id, { volumeIdx: i + 1 }).id);
    assert.deepEqual(actual, [
      'opening', 'opening', 'opening',
      'early_middle', 'early_middle', 'early_middle',
      'middle', 'middle', 'middle', 'middle',
      'late_middle', 'late_middle',
      'ending', 'ending',
      'finale',
    ]);
  });

  test('通用十卷书使用同一有序生命周期，当前只有少量实体卷也不会误判已到终卷', () => {
    const book = store.books.create({ title: '十卷长篇', genre: '玄幻', blurb: '一路成长到终局' });
    store.volumes.create(book.id, 1, { title: '第一卷' });
    assert.equal(lifecycle.resolveBookStage(book.id, { volumeIdx: 1 }).totalVolumes, 10);
    assert.equal(lifecycle.resolveBookStage(book.id, { volumeIdx: 1 }).id, 'opening');
    assert.equal(lifecycle.resolveBookStage(book.id, { volumeIdx: 3 }).id, 'early_middle');
    assert.equal(lifecycle.resolveBookStage(book.id, { volumeIdx: 5 }).id, 'middle');
    assert.equal(lifecycle.resolveBookStage(book.id, { volumeIdx: 8 }).id, 'late_middle');
    assert.equal(lifecycle.resolveBookStage(book.id, { volumeIdx: 9 }).id, 'ending');
    assert.equal(lifecycle.resolveBookStage(book.id, { volumeIdx: 10 }).id, 'finale');
  });

  test('阶段提示包含职责、转折、兑付、支线预算与禁止捷径', () => {
    const book = store.books.create({
      title: '阶段提示书', genre: '玄幻', blurb: '长篇',
      settings: { longformLifecycle: { plannedVolumes: 10 } },
    });
    const ctx = lifecycle.buildLifecycleContext(book.id, { volumeIdx: 8 });
    const text = lifecycle.lifecyclePromptText(ctx);
    for (const expected of ['阶段ID：late_middle', '本阶段职责', '必须发生的阶段转折', '兑付职责', '新主线额度', '禁止捷径']) {
      assert.match(text, new RegExp(expected));
    }
  });

  test('开篇提示只注入当前到期债务，不被终卷十项结算字段淹没', () => {
    const book = store.books.create({
      title: '开篇债务限流书', genre: '玄幻', blurb: '少年终将守住故土',
      settings: { longformLifecycle: { plannedVolumes: 10 } },
    });
    store.contractPromises.upsert(book.id, { text: '前三章立住主角目标', dueChapter: 3, status: 'open' });
    const ctx = lifecycle.buildLifecycleContext(book.id, { volumeIdx: 1 });
    assert.ok(Array.isArray(ctx.stageBlockers));
    assert.equal(ctx.stageBlockers.some(item => item.type === 'ending_form'), false);
    assert.equal(ctx.stageBlockers.some(item => item.id === 'core-promise'), false);
    assert.match(lifecycle.lifecyclePromptText(ctx), /当前阶段到期\/应收束债务/);
  });

  test('开篇长期主线与远期承诺留在总台账，但不冒充当前四章内债务', () => {
    const book = store.books.create({
      title: '长线限流书', genre: '玄幻', blurb: '百章后完成守城誓言',
      settings: { longformLifecycle: { plannedVolumes: 10 } },
    });
    store.storyArcs.create(book.id, { name: '百章守城主线', type: '主线', openedChapter: 1, targetChapter: 100 });
    store.pleasureHooks.create(book.id, { desc: '百章后归乡', kind: 'long', status: 'open', plantedChapter: 1, dueChapter: 100 });
    const ctx = lifecycle.buildLifecycleContext(book.id, { volumeIdx: 1 });
    assert.ok(ctx.payoffLedger.obligations.some(item => item.label === '百章守城主线' && item.status === 'future'));
    assert.ok(ctx.payoffLedger.blockers.some(item => item.label === '百章后归乡'));
    assert.equal(ctx.stageBlockers.some(item => /百章守城|百章后归乡/.test(item.label)), false);
  });
});

describe('V0.92 卷纲生命周期硬校验', () => {
  test('中后期禁止再开重大主线', () => {
    const ctx = { stage: lifecycle.LONGFORM_STAGES.late_middle, payoffLedger: { blockers: [] } };
    const result = lifecycle.validateLifecycleVolumeOutline({
      lifecycle_stage: 'late_middle', stage_turn: '原有三线开始汇流',
      arcs_advanced: ['主线'], arcs_closed: ['旧支线'], hooks_paid: ['旧承诺'],
      new_major_arcs: ['突然出现的远古终极敌人'],
    }, ctx);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.code === 'LATE_MAJOR_ARC_OPENED'));
  });

  test('收尾卷有未清债务时必须列出本卷兑付项', () => {
    const ctx = {
      stage: lifecycle.LONGFORM_STAGES.ending,
      payoffLedger: { blockers: [{ id: 'arc-1', label: '朝堂主线', type: 'story_arc' }] },
    };
    const result = lifecycle.validateLifecycleVolumeOutline({
      lifecycle_stage: 'ending', stage_turn: '最终对手显形',
      arcs_advanced: ['朝堂主线'], arcs_closed: [], hooks_paid: [], new_major_arcs: [],
      ending_delivery: { final_opposition: '最终对手显形' },
    }, ctx);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.code === 'ENDING_PAYOFF_MISSING'));
  });

  test('终卷缺最终选择、代价、核心承诺、世界结算或闭幕意象时拒绝落库', () => {
    const ctx = { stage: lifecycle.LONGFORM_STAGES.finale, payoffLedger: { blockers: [] } };
    const result = lifecycle.validateLifecycleVolumeOutline({
      lifecycle_stage: 'finale', stage_turn: '完成终局',
      arcs_advanced: [], arcs_closed: [], hooks_paid: [], new_major_arcs: [],
      ending_delivery: { protagonist_settlement: '主角完成成长' },
    }, ctx);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.code === 'FINALE_SETTLEMENT_MISSING'));
    assert.match(result.issues.find(issue => issue.code === 'FINALE_SETTLEMENT_MISSING').message, /final_choice|最终选择/);
  });
});

describe('V0.92 规划提示前置接线', () => {
  test('卷纲 JSON schema 携带阶段转折、弧线推进/闭合、期待兑付与结局交付字段', () => {
    const text = prompts.volumeOutlineInstruction({
      bookTitle: '阶段规划书', volumeIdx: 8, volumeTitle: '汇流', bookOutline: {}, chapterCount: 8,
      lifecycleText: '阶段ID：late_middle｜阶段：中后期', endingBlueprintText: '【结局蓝图】最终选择：交出王印',
    });
    for (const field of ['"lifecycle_stage"', '"stage_turn"', '"arcs_advanced"', '"arcs_closed"', '"hooks_paid"', '"new_major_arcs"', '"ending_delivery"']) {
      assert.ok(text.includes(field), `卷纲 schema 缺 ${field}`);
    }
    assert.match(text, /阶段ID：late_middle/);
    assert.match(text, /最终选择：交出王印/);
  });

  test('收尾卷卷纲不再被旧规则强迫开新地图、升级或留下新主线钩子', () => {
    const text = prompts.volumeOutlineInstruction({
      bookTitle: '收尾规则书', volumeIdx: 10, volumeTitle: '归潮', bookOutline: {}, chapterCount: 8,
      lifecycleText: '阶段ID：ending｜阶段：后期收尾', endingBlueprintText: '【结局蓝图】逐项清账',
      growthDimension: '统帅成长', growthExample: '将领→统帅', worldExpansion: '旧规则：推进到下一战区',
    });
    assert.doesNotMatch(text, /结尾章必须兑现上卷钩子并留新钩/);
    assert.doesNotMatch(text, /每卷至少推进 1-2 个小阶段/);
    assert.doesNotMatch(text, /本卷必须把故事舞台推进到下一区域层级/);
    assert.match(text, /禁止另开新主线|只允许终局推进钩/);
    assert.match(text, /成长弧结算/);
    assert.match(text, /既有战场|既有区域/);
  });

  test('续卷提示在收尾期不再声称故事远未结束，也不强制末章另留新钩', () => {
    const text = prompts.nextVolumeInstruction({
      bookTitle: '收尾书', volumeCount: 9, chapterCount: 8,
      lifecycleStage: 'ending', lifecycleText: '阶段ID：ending｜阶段：后期收尾', endingBlueprintText: '【结局蓝图】逐项清账',
    });
    assert.doesNotMatch(text, /故事远未结束，禁止收尾/);
    assert.doesNotMatch(text, /末章留新钩子/);
    assert.match(text, /结局蓝图/);
    assert.match(text, /只允许终局推进钩/);
  });

  test('新书书纲一次规划全阶段并把总卷数固化到作品设置', async () => {
    const book = store.books.create({ title: '生命周期新书', genre: '玄幻', blurb: '少年成长为守城者' });
    const generated = await outlineEngine.generateBookOutline(book.id, { volumeCount: 10 });
    assert.equal(generated.volumes.length, 10);
    assert.equal(store.books.settings(book.id).longformLifecycle.plannedVolumes, 10);
    assert.deepEqual(generated.volumes.map(v => v.lifecycle_stage), [
      'opening', 'opening', 'early_middle', 'early_middle', 'middle', 'middle', 'middle', 'late_middle', 'ending', 'finale',
    ]);
    assert.ok(generated.volumes.every(v => v.stage_turn));
  });

  test('即使模型只返回四个近期卷，也不会把第四卷误标成终卷', async () => {
    const book = store.books.create({ title: '近期四卷书', genre: '玄幻', blurb: '长期连载，只先细化四卷' });
    const generated = await outlineEngine.generateBookOutline(book.id, { volumeCount: 4 });
    assert.equal(generated.volumes.length, 4);
    assert.equal(store.books.settings(book.id).longformLifecycle.plannedVolumes, 10);
    assert.equal(generated.volumes.at(-1).lifecycle_stage, 'early_middle');
  });
});

describe('V0.92 快感调度与收尾阶段不打架', () => {
  test('中后期弧线不足时不再强迫补开支线', () => {
    const book = store.books.create({
      title: '中后期调度书', genre: '玄幻', blurb: '终局前汇流',
      settings: { longformLifecycle: { plannedVolumes: 10 } },
    });
    store.volumes.create(book.id, 8, { title: '汇流卷', status: 'outlined' });
    const rules = pleasure.schedulerCheck(book.id, 70).join('\n');
    assert.doesNotMatch(rules, /开启新支线|应保持3-5条/);
    assert.match(rules, /中后期|汇流|禁止新增重大主线/);
  });

  test('终卷不登记新期待或强制章末悬念', () => {
    const book = store.books.create({
      title: '终卷钩子书', genre: '玄幻', blurb: '故事已到终卷',
      settings: { longformLifecycle: { plannedVolumes: 10 } },
    });
    store.volumes.create(book.id, 10, { title: '终卷', status: 'outlined', outline: { lifecycle_stage: 'finale' } });
    const registered = pleasure.registerHooksFromOutline(book.id, {
      new_hooks: [{ desc: '新的远古敌人苏醒', kind: 'super' }],
      ending_hook: { desc: '天外仍有更强敌人', intensity: 5 },
    }, 100);
    assert.deepEqual(registered, []);
    assert.equal(store.pleasureHooks.list(book.id).length, 0);
  });
});
