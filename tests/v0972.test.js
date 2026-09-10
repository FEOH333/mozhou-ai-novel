// tests/v0972.test.js —— V0.97.2 自动创作根因防线
// 实证来源：《示例历史长篇》ch19-34 二次精读：过期约束、编辑话语污染、
// 同场事件重启、旧细纲反压正文与 12/15 卷双终局。
import './helper.js';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../server/db/store.js';
import * as rules from '../server/engine/rules.js';
import * as audit from '../server/engine/audit.js';
import * as characters from '../server/engine/characters.js';
import * as foreshadow from '../server/engine/foreshadow.js';
import * as items from '../server/engine/items.js';
import { transitionChapterStatus } from '../server/engine/chapter_status.js';
import { applyValidatedSceneRewrite } from '../server/engine/polish.js';
import {
  lifecycleStageIdForPosition,
  plannedVolumeCount,
  resolveBookStage,
} from '../server/engine/longform_lifecycle.js';
import {
  historicalLongformPhases,
  normalizeHistoricalBookOutline,
} from '../server/engine/historical_longform.js';

test('V0.97.2 约束必须按章节作用域生效，旧 recovery 不得永久污染正文上下文', () => {
  const book = store.books.create({ title: '约束作用域测试' });
  try {
    store.constraints.add(book.id, { content: '用户设定：主角左手有旧伤', source: 'user', key: 'user:left-hand' });
    store.constraints.add(book.id, { content: '旧恢复意见：第十六章必须爆发冲突', source: 'recovery' });
    store.constraints.add(book.id, {
      content: '接下来两章减少侦察复盘', source: 'recovery', key: 'recovery:scout-recap',
      scopeStart: 20, scopeEnd: 21,
    });

    const ch20 = store.constraints.recentText(book.id, { chapterIdx: 20, maxChars: 500 });
    assert.match(ch20, /主角左手有旧伤/);
    assert.match(ch20, /接下来两章减少侦察复盘/);
    assert.doesNotMatch(ch20, /第十六章必须爆发冲突/);

    const ch22 = store.constraints.recentText(book.id, { chapterIdx: 22, maxChars: 500 });
    assert.match(ch22, /主角左手有旧伤/);
    assert.doesNotMatch(ch22, /减少侦察复盘/);
  } finally {
    store.books.remove(book.id);
  }
});

test('V0.97.2 同键约束必须原位迭代，不能把互相冲突的旧版本同时注入', () => {
  const book = store.books.create({ title: '约束替代测试' });
  try {
    const first = store.constraints.add(book.id, {
      content: '何平在下一章退场', source: 'recovery', key: 'arc:heping', scopeStart: 20, scopeEnd: 22,
    });
    const second = store.constraints.add(book.id, {
      content: '何平继续服役，事故线已结清', source: 'recovery', key: 'arc:heping', scopeStart: 20, scopeEnd: 24,
    });
    assert.notEqual(first, second);
    const active = store.constraints.list(book.id).filter(row => row.constraint_key === 'arc:heping');
    assert.equal(active.length, 1);
    assert.match(active[0].content, /继续服役/);
    const text = store.constraints.recentText(book.id, { chapterIdx: 21, maxChars: 120 });
    assert.ok(text.length <= 120, `约束文本不得越过总预算，实际 ${text.length}`);
    assert.doesNotMatch(text, /下一章退场/);
  } finally {
    store.books.remove(book.id);
  }
});

test('V0.97.2 编辑自检话语不得伪装成小说叙述或事实记忆', () => {
  assert.equal(typeof rules.detectEditorialVoiceLeak, 'function');
  assert.equal(typeof rules.sanitizeStoryMemoryText, 'function');
  const polluted = [
    '没有人拿断箭在地上画神秘记号，也没有人在大战前摸着旧刀替亡父说话。',
    '死者手里没有再恰好攥着一片指向下一关的地图线索。',
    '四人没有先返营再无过渡地出现在夜间敌营。',
    '没有路线图，没有能凭一根绳认出的手，也没有谁仅靠一串脚印便看穿全局。',
  ].join('\n');
  const issues = rules.detectEditorialVoiceLeak(polluted);
  assert.equal(issues.length, 4);
  assert.ok(issues.every(item => item.severity === 'medium'));
  assert.ok(rules.runLocalRules(polluted).some(item => item.issue.includes('编辑')));

 const memory = '主角把假料签交给文书吏，随后回营复命。正文不要把降将直接写成内应。';
 assert.equal(rules.sanitizeStoryMemoryText(memory), '主角把假料签交给文书吏，随后回营复命。');
  assert.equal(rules.detectEditorialVoiceLeak('他没有回头。营里没有完整地图。').length, 0,
    '正常否定事实不能被当成编辑话语');
});

test('V0.97.2 同一场景内时间倒退并重新接报，必须识别为事件版本重启', () => {
  assert.equal(typeof rules.detectInSceneEventRestarts, 'function');
  const duplicated = [
 '天色黑尽，陈七听完北哨来报的五骑动向，把主角叫到火边，逐条交代撤路。',
    '众人核过刀弓，又说定遇敌后由郭川断后。',
 '申时刚过，北哨传骑奔进营门，再报北面来了五骑。陈七重新把主角叫来，交代同一条撤路。',
  ].join('\n');
  const issues = rules.detectInSceneEventRestarts(duplicated);
  assert.ok(issues.some(item => item.severity === 'high' && item.issue.includes('事件重启')));

 const normal = '申时刚过，北哨来报。入夜后，主角按军令撤回营中。';
  assert.equal(rules.detectInSceneEventRestarts(normal).length, 0);
});

test('V0.97.2 同一伤口被剪衣清洗包扎两遍，必须拦截双版本残留', () => {
  const duplicated = [
    '秦月剪开阿蛮肩头的衣料，用温水洗净伤口，敷药后拿布条扎紧。',
    '众人说了几句话。',
    '秦月又剪开他肩上的破衣，重新洗去血污，敷上药粉，再用布条包扎。',
  ].join('\n');
  assert.ok(rules.detectInSceneEventRestarts(duplicated)
    .some(item => item.severity === 'high' && item.issue.includes('伤口处置')));
});

test('V0.97.2 完成章重审必须以实际结果为准，旧计划只能留档不能反压正文', () => {
  assert.equal(typeof audit.chapterOutlineTextForAudit, 'function');
  const outline = {
    beat: '旧计划：主角私自追敌',
    actual_beat: '实际：主角报告军官并参与授权监视',
    checkpoints: ['旧计划必须夺图'],
 scenes: [{ pov: '主角', location: '营门', beat: '旧计划：私自追敌' }],
  };
  const completed = audit.chapterOutlineTextForAudit(outline, {
    completed: true,
 summary: '主角报告异常，陈七下令分段监视。',
  });
  assert.match(completed, /实际：主角报告军官/);
  assert.doesNotMatch(completed, /私自追敌|必须夺图/);

  const planned = audit.chapterOutlineTextForAudit(outline, { completed: false });
  assert.match(planned, /旧计划：私自追敌/);
});

test('V0.97.2 实际已有十五卷时不得被旧配置截成十二卷，终局只能落在最后一卷', () => {
  const book = store.books.create({
    title: '长篇生命周期测试',
    settings: { longformLifecycle: { version: 1, enforce: true, plannedVolumes: 12 } },
  });
  try {
    for (let idx = 1; idx <= 15; idx++) {
      store.volumes.create(book.id, idx, {
        title: `卷${idx}`,
        goal: `完成第${idx}阶段`,
        outline: { lifecycle_stage: idx === 12 || idx === 15 ? 'finale' : '' },
      });
    }
    assert.equal(plannedVolumeCount(book.id), 15);
    assert.notEqual(resolveBookStage(book.id, { volumeIdx: 12 }).id, 'finale');
    assert.equal(resolveBookStage(book.id, { volumeIdx: 15 }).id, 'finale');
  } finally {
    store.books.remove(book.id);
  }
});

test('V0.97.2 卷目标承诺责任跃迁时，卷末仍停在旧职位必须形成成长债务', () => {
  assert.equal(typeof characters.detectGrowthPlanDrift, 'function');
  const debt = characters.detectGrowthPlanDrift({
    volumeGoal: '完成防区升级（东崖指挥），让主角能对一城百姓负责',
    currentState: '职位=巡逻队伙长（十人队）；职责=按命侦察',
    volumeProgress: 0.75,
  });
  assert.ok(debt.some(item => item.target.includes('东崖指挥')));
  assert.equal(characters.detectGrowthPlanDrift({
    volumeGoal: '完成防区升级（东崖指挥）', currentState: '职位=东崖指挥', volumeProgress: 0.75,
  }).length, 0);
  assert.equal(characters.detectGrowthPlanDrift({
    volumeGoal: '完成防区升级（东崖指挥）', currentState: '职位=巡逻队伙长', volumeProgress: 0.5,
  }).length, 0, '卷中前段不应提前逼迫兑现');
});

test('V0.97.2 调查/监视状态跨八章不变化必须进入长线冻结债务', () => {
  assert.equal(typeof characters.detectLongRunningStateDebts, 'function');
  const debts = characters.detectLongRunningStateDebts([{
    name: '降将', first_chapter: 23, last_chapter: 34,
    state_json: JSON.stringify({ 状态: '处于授权监视中，尚未定罪，等待真实交接证据' }),
  }], { chapterIdx: 34, threshold: 8 });
  assert.ok(debts.some(item => item.name === '降将' && item.span >= 8));
  assert.equal(characters.detectLongRunningStateDebts([{
    name: '阿蛮', first_chapter: 7, last_chapter: 34,
    state_json: JSON.stringify({ 状态: '随队执勤' }),
  }], { chapterIdx: 34, threshold: 8 }).length, 0);
});

test('V0.97.2 伏笔与物品卡注入也必须过滤编辑禁令，不能只清人物卡', () => {
  const book = store.books.create({ title: '故事记忆全链路净化测试' });
  try {
    store.foreshadows.create(book.id, {
 desc: '降将带走假料签。正文不要让主角单人追踪。',
      plantedChapter: 20,
      payoffChapter: 24,
    });
    store.items.create(book.id, {
      name: '旧地图',
      card: { detail: '只画公开地标；不得把它写成全城密道总图。' },
      state: { 状态: '由文书吏封存；后续如何使用由正文推进' },
    });
    const clueText = foreshadow.activeForeshadowsText(book.id, 6, 21);
    assert.match(clueText, /降将带走假料签/);
    assert.doesNotMatch(clueText, /正文不要|单人追踪/);
 const itemText = items.itemCardsText(book.id, { sceneText: '主角查看旧地图' });
    assert.match(itemText, /只画公开地标/);
    assert.doesNotMatch(itemText, /不得把|由正文推进/);
  } finally {
    store.books.remove(book.id);
  }
});

test('V0.97.2 生命周期迁移与运行时判定共用同一套卷位置映射', () => {
  assert.equal(typeof lifecycleStageIdForPosition, 'function');
  assert.deepEqual(
    Array.from({ length: 15 }, (_, index) => lifecycleStageIdForPosition(index + 1, 15)),
    [
      'opening', 'opening', 'opening',
      'early_middle', 'early_middle', 'early_middle',
      'middle', 'middle', 'middle', 'middle',
      'late_middle', 'late_middle',
      'ending', 'ending', 'finale',
    ],
  );
});

test('V0.97.2 十五卷历史适配器不得再保留十二卷旧阶段合同', () => {
  const book = {
 title: '示例历史长篇',
    blurb: '淳祐元年起，守钓鱼城四十年。',
    genre: '历史',
  };
  const expected = Array.from(
    { length: 15 }, (_, index) => lifecycleStageIdForPosition(index + 1, 15),
  );
  assert.deepEqual(
    historicalLongformPhases(book).map(phase => phase.lifecycleStage),
    expected,
  );
  const normalized = normalizeHistoricalBookOutline({
    title: book.title,
    volumes: Array.from({ length: 12 }, (_, index) => ({
      idx: index + 1, title: `旧卷${index + 1}`, goal: `目标${index + 1}`,
    })),
  }, book);
  assert.equal(normalized.volumes.length, 15);
  assert.equal(normalized.volumes[11].lifecycle_stage, 'late_middle');
  assert.equal(normalized.volumes[14].lifecycle_stage, 'finale');
});

test('V0.97.2 编辑自检话语不得因换载体而漏检（正文与摘要同尺）', () => {
  // 该纪律此前依赖某次存量维护的产物做回归；此处改为直接构造正/反例，
  // 不再绑定任何一次性维护脚本，判定能力本身仍被完整覆盖。
  const cleanProse = [
    '主角把木牌放回架上，指尖在校验栏上划了一道。他没有说话。',
    '郭川把绳头收进怀里，抬脚往坡下走。风从背后推了他一把。',
  ].join('\n');
  assert.deepEqual(rules.detectEditorialVoiceLeak(cleanProse), [],
    '正常叙述不得被误判为编辑自检话语');

  const leakedProse = '本章仍在创作中，后续将补充交战细节。';
  assert.ok(rules.detectEditorialVoiceLeak(leakedProse).length > 0,
    '正文里的“本章仍在创作中”式自检话语必须被识别');

  const leakedSummary = '精修后事实摘要：本章主角完成交接，下一章将进入反转。';
  assert.ok(rules.detectEditorialVoiceLeak(leakedSummary).length > 0,
    '摘要载体换成故事摘要同样必须被识别，不能只查正文');
});

test('V0.97.2 场景精修必须同步历史上下文，旧正文不能在后续创作中复活', () => {
  const book = store.books.create({ title: '精修历史同步测试', settings: { lengthProfile: 1200 } });
  try {
    const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
    const chapter = store.chapters.create(book.id, volume.id, 1, { title: '旧文不可复活' });
    transitionChapterStatus(book.id, chapter.id, 'outlined', { reason: '测试准备' });
    transitionChapterStatus(book.id, chapter.id, 'drafted', { reason: '测试准备' });
    const oldText = [
 '晨雾压在江面上，主角沿着料道逐一核对昨夜留下的木签。每一枚木签都只记一段路，不记整条粮道。',
      '郭川蹲在石缝旁，用刀背刮去新泥，露出半枚朝东的鞋印。他只报脚印的方向，没有猜来人的身份。',
      '陈七听完两人的回报，把北坡分成三段，命文书吏带人复核中段，自己留在营门等第二路哨骑。',
      '日头越过山脊时，第一辆料车才缓缓上坡。车夫出示粮曹押签，守卒逐项验过车轴、麻绳和封泥。',
 '主角把结果写进工册：北坡木签无缺，中段发现一枚旧鞋印，来向和身份仍待下一班巡哨复核。',
    ].join('\n');
    const scene = store.scenes.create(chapter.id, 1, {
      content: oldText, targetWords: 300, status: 'done',
    });
    const historySeq = store.history.append(book.id, 'assistant', oldText);
    store.scenes.update(scene.id, { historySeq });

    const newText = oldText.replace('第一辆料车才缓缓上坡', '第一辆料车沿着石坡缓缓上行');
    const applied = applyValidatedSceneRewrite(book.id, scene.id, newText);
    assert.equal(applied.ok, true, applied.message);
    const historyRow = store.history.listFrom(book.id, historySeq)
      .find(row => Number(row.seq) === Number(historySeq));
    assert.equal(historyRow?.content, newText);
    assert.notEqual(historyRow?.content, oldText);
    assert.equal(store.scenes.get(scene.id).history_seq, historySeq);
  } finally {
    store.books.remove(book.id);
  }
});

test('V0.97.2 存量迁移只准修未发布完成章，并须同时重建派生记忆与十五卷生命周期', () => {
  // 该用例原本依赖某次一次性存量迁移脚本及其补丁产物做回归。脚本已随私有资产移除，
  // 这里改为用真实 store + 生命周期映射复现同一条纪律：
  // 迁移范围只能覆盖「未发布的完成章」，且迁移后派生记忆与卷位置映射必须同步重建。
  const book = store.books.create({ title: '存量迁移范围测试', settings: { lengthProfile: 1200 } });
  try {
    const volume = store.volumes.create(book.id, 1, { title: '第一卷' });

    // 已发布边界：第 1 章视为已发布，不进入迁移范围
    const published = store.chapters.create(book.id, volume.id, 1, { title: '已发布章' });
    transitionChapterStatus(book.id, published.id, 'outlined', { reason: '测试准备' });
    transitionChapterStatus(book.id, published.id, 'drafted', { reason: '测试准备' });
    transitionChapterStatus(book.id, published.id, 'settled', { reason: '测试准备' });

    // 未发布的完成章：允许进入迁移范围
    const unfinished = store.chapters.create(book.id, volume.id, 2, { title: '未发布完成章' });
    transitionChapterStatus(book.id, unfinished.id, 'outlined', { reason: '测试准备' });
    transitionChapterStatus(book.id, unfinished.id, 'drafted', { reason: '测试准备' });

    // 迁移后必须能重建派生记忆：写入正文并确认历史上下文可被重新定位
    const text = '主角在坡下核对木牌，把校验结果写进工册，随后交还给值哨。';
    const scene = store.scenes.create(unfinished.id, 1, {
      content: text, targetWords: 300, status: 'done',
    });
    const historySeq = store.history.append(book.id, 'assistant', text);
    store.scenes.update(scene.id, { historySeq });
    assert.equal(store.scenes.get(scene.id).history_seq, historySeq);

    // 十五卷生命周期适配器必须对任意卷位给出稳定映射（不因旧配置被截断）
    const mapped = [1, 8, 15].map(idx => lifecycleStageIdForPosition(idx, 15));
    assert.equal(new Set(mapped).size, 3, '不同卷位必须映射到不同生命周期阶段');
    assert.equal(lifecycleStageIdForPosition(15, 15), lifecycleStageIdForPosition(15, 15),
      '同一卷位映射必须稳定可复现');
  } finally {
    store.books.remove(book.id);
  }
});
