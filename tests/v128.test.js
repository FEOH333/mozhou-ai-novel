// V0.93.6 缓存命中率优化：①write 注入预算护栏（防注入源膨胀复发——08-07 旧版本
// 注入未限流曾致 write 尾部 494k tokens 全 miss、命中率 20%，V0.70/73 限流后 10k）；
// ②成本聚合近期命中率口径（累计被历史旧版本稀释成假象，近期才是实时仪表）
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v128-cache-'));
const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
const { estimateTokens } = await import(pathToFileURL(path.join(ROOT, 'server/llm/tokenizer.js')));
const foreshadow = await import(pathToFileURL(path.join(ROOT, 'server/engine/foreshadow.js')));
const characters = await import(pathToFileURL(path.join(ROOT, 'server/engine/characters.js')));
const pleasure = await import(pathToFileURL(path.join(ROOT, 'server/engine/pleasure.js')));
const worldbook = await import(pathToFileURL(path.join(ROOT, 'server/engine/worldbook.js')));
const { styleRulesText } = await import(pathToFileURL(path.join(ROOT, 'server/data/creative_packs.js')));
const { techniqueInjection, buildDynamicStyle, ENVIRONMENT_TEXT, PSYCHOLOGY_TEXT } = await import(pathToFileURL(path.join(ROOT, 'server/data/literary_techniques.js')));
const { PLOT_DEAI_TEXT } = await import(pathToFileURL(path.join(ROOT, 'server/engine/plot_ai.js')));

/** 塞满各注入源限流上限，构造"最坏情况"的 write 数据环境 */
function seedWorstCase(bookId) {
  // 12 条反馈约束（recentText 只取最近 12 条，整体 ≤3000 chars）
  for (let i = 1; i <= 20; i++) {
    store.constraints.add(bookId, { content: `第${i}章反馈约束：不要重复使用“目光落在”式套话，主角情绪要用身体反应写（指节发麻/喉头发紧），本章埋伏笔要自然。`, source: 'pleasure' });
  }
  // 6+ 条活跃伏笔（activeForeshadowsText limit=6）
  for (let i = 1; i <= 10; i++) {
    store.foreshadows.create(bookId, { desc: `伏笔${i}：主角腰间那枚断角腰牌来自矿洞深处，埋设于第${i * 3}章`, importance: 'high', payoffChapter: i * 3 + 10, plantedChapter: i * 3 });
  }
  // 8 条开放钩子（buildPleasureContext 限流）
  for (let i = 1; i <= 8; i++) {
    store.pleasureHooks.create(bookId, { desc: `钩子${i}：灰烟偏东二里，敌方巡逻队扩编，第${20 + i}章兑现`, kind: 'medium', plantedChapter: 10, dueChapter: 20 + i });
  }
  // 10 个点名册角色 + 3 张角色卡
  for (let i = 1; i <= 10; i++) {
    store.characters.create(bookId, { name: `角色${i}号`, tier: i <= 2 ? 'major' : 'minor', firstChapter: i, goal: `振兴家族，查明腰牌来历`, fear: `怕再次被抛弃`, secret: `隐瞒了自己能听见矿洞低语` });
  }
  for (let i = 1; i <= 3; i++) {
    store.characters.create(bookId, { name: `卡角色${i}`, tier: 'major', firstChapter: i, goal: '寻回失踪的兄长', fear: '矿井坍塌', secret: '与主角有旧怨' });
  }
  // 20 条时间线事件
  for (let i = 1; i <= 20; i++) {
    store.timeline.add(bookId, { chapterId: null, event: `第${i * 5}章：主角在矿洞第${i}层发现新的青铜纹路，向西北延伸` });
  }
  // 8 条事实（关键词命中走本地召回，不触发语义检索）
  for (let i = 1; i <= 8; i++) {
    store.facts.create(bookId, { subject: '主角', predicate: '获得', object: `第${i}块腰牌残片`, sourceChapter: i * 2 });
  }
  // 世界书条目（激活注入）
  store.worldbook.create(bookId, { keywords: ['矿洞', '腰牌'], content: '矿洞位于青阳镇西侧，岩壁有青铜纹路，越深纹路越亮，深处有低语声。', priority: 5 });
  store.worldbook.create(bookId, { keywords: ['青云宗'], content: '青云宗山门三进，外门弟子每月考核一次，任务堂在演武场西侧。', priority: 4 });
  // 地点卡
  store.locations.create(bookId, { name: '青阳镇矿洞', firstChapter: 1, lastChapter: 30, card: { kind: '地点', desc: '镇西废弃矿洞，深处有青铜纹路与低语' } });
  // 滚动摘要
  store.rollingSummaries.set(bookId, '主角已集齐三块腰牌残片，发现矿洞深处封印着古老存在；青云宗外门考核在即。');
}

describe('V0.93.6 缓存命中率优化', () => {
  test('write 注入预算护栏：限流上限数据下注入合计 ≤25k tokens（防 08-07 式尾部膨胀复发）', async () => {
    const book = store.books.create({ title: '预算护栏测试', genre: '历史', settings: { lengthProfile: 5000 } });
    seedWorstCase(book.id);
    const chapter = store.chapters.create(book.id, null, 21, { title: '第21章' });
    const outline = {
      goal: '查明灰烟来源，扩编巡逻队',
      conflict: '敌方侦察范围扩大与兵力不足的矛盾',
      continuity_from: '上一章点卯结束',
      scenes: [
        { id: 's1', idx: 1, pov: '主角', location: '青阳镇矿洞', beat: '主角进矿洞查看青铜纹路，发现新的低语' },
        { id: 's2', idx: 2, pov: '主角', location: '演武场', beat: '巡逻队扩编点卯，主角被任命为小队长' },
        { id: 's3', idx: 3, pov: '配角', location: '青云宗任务堂', beat: '任务堂发布灰烟侦察任务，主角接下' },
      ],
      ending_hook: '灰烟偏东二里，像一根钉在暮色里的木刺，无声地逼向营垒。',
    };
    store.chapters.update(chapter.id, { outline });
    const scene = { id: 's1', idx: 1, pov: '主角', location: '青阳镇矿洞', beat: '主角进矿洞查看青铜纹路，发现新的低语', target_words: 1800, scene_type: 'suspense' };

    // 逐项取真实数据源输出（与 write.js 同源）
    const scanText = JSON.stringify(outline) + ' ' + outline.scenes.map(s => s.beat).join(' ');
    const worldbookText = worldbook.activateEntriesText(book.id, scanText);
    const constraints = store.constraints.recentText(book.id, { limit: 12, maxChars: 3000 });
    const foreshadowsText = foreshadow.activeForeshadowsText(book.id) + '\n' + foreshadow.overdueForeshadowsText(book.id, 21);
    const rollCallText = characters.characterRollCallText(book.id, { limit: 10, chapterIdx: 21 });
    const cardText = characters.characterCardsText(book.id, { names: ['主角', '配角'], limit: 3, chapterIdx: 21 });
    const pleasureContext = pleasure.buildPleasureContext(book.id, 21);
    const styleRules = styleRulesText(undefined, '主角性格谨慎，叙事节奏偏快，对话简洁。');

    const instruction = prompts.writeSceneInstruction({
      bookTitle: '预算护栏测试', chapterIdx: 21, chapterTitle: '第21章',
      goal: outline.goal, conflict: outline.conflict, continuityFrom: outline.continuity_from,
      scene, scenesBefore: [], sceneAfter: outline.scenes[1],
      prevTail: '上一场景结尾文字。', prevSceneSummary: '上一场景摘要。',
      worldbookText, factsText: '', foreshadowsText, rules: '遵守系统提示。', rollingSummary: '主角已集齐三块腰牌残片。',
      recentSummaries: [{ idx: 20, summary: '上一章：点卯结束，巡逻队扩编。' }],
      timelineEvents: ['第100章事件'], futureChapters: [{ idx: 22, beat: '下一章：出城侦察。' }],
      constraints, pleasureContext, styleRules, rollCallText, cardText,
      perspective: 'third', techniqueText: techniqueInjection('suspense'),
      dynamicStyle: buildDynamicStyle({ genre: '历史', sceneType: 'suspense', emotion: '紧张' }),
      powerStatus: '境界：练气三层', endingHook: outline.ending_hook, plotDeAI: PLOT_DEAI_TEXT,
      historyDeAI: '【历史去AI味】禁现代词汇。', eraContext: '【时代红线】不得让主角提前知晓蒙哥死讯。', eraBoundary: '【史实边界】1243年无回回炮。',
      poetryText: '【诗词】可化用边塞诗意象。', environmentText: ENVIRONMENT_TEXT, psychologyText: PSYCHOLOGY_TEXT,
      historicalChapterFrame: '公元1243年｜主角11岁｜阶段：成长', isHistory: true,
    });

    const tok = estimateTokens(instruction);
    console.log(`  write 注入合计 ≈ ${Math.round(tok / 1000)}k tokens（历史题材最坏组合）`);
    assert.ok(tok <= 25_000, `write 注入预算超限：${tok} tokens > 25k（限流失效或新注入源膨胀，须限流）`);
  });

  test('成本聚合近期命中率：只统计最近 500 条内有效调用（剔除 estimated/noCacheData）', () => {
    const book = store.books.create({ title: '命中率口径测试', genre: '都市' });
    // 502 条陈旧记录（模拟旧版本运行期：全 miss 拖低累计口径；超出最近 500 条窗口）
    const ins = store.db().prepare(`INSERT INTO usage_logs (ts, book_id, chapter_id, task, model, prompt_hit, prompt_miss, completion, cost, cost_if_miss, duration_ms, estimated, extra)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const oldTs = Date.now() - 90 * 86400_000;
    for (let i = 0; i < 502; i++) {
      ins.run(oldTs + i, book.id, null, 'write', 'm', 0, 100000, 2000, 0.01, 0.1, 1000, 0, '{}');
    }
    // 窗口内（最近 500 条）的无效行：estimated 与 noCacheData 应被剔除
    store.usageLogs.add({ bookId: book.id, chapterId: null, task: 'write', model: 'm', promptHit: 0, promptMiss: 500000, completion: 2000, cost: 0.01, costIfMiss: 0.1, durationMs: 1000, estimated: 1 });
    store.usageLogs.add({ bookId: book.id, chapterId: null, task: 'write', model: 'm', promptHit: 0, promptMiss: 300000, completion: 2000, cost: 0.01, costIfMiss: 0.1, durationMs: 1000, extra: { noCacheData: true } });
    // 近期（高命中）
    store.usageLogs.add({ bookId: book.id, chapterId: null, task: 'write', model: 'm', promptHit: 90000, promptMiss: 10000, completion: 2000, cost: 0.01, costIfMiss: 0.1, durationMs: 1000 });
    store.usageLogs.add({ bookId: book.id, chapterId: null, task: 'audit', model: 'm', promptHit: 4000, promptMiss: 12000, completion: 2000, cost: 0.01, costIfMiss: 0.1, durationMs: 1000 });

    const agg = store.usageLogs.aggregate({ bookId: book.id });
    assert.equal(agg.recentCalls, 500, '近期窗口 = 最近 500 条有效调用（无效行不占窗口：498 陈旧 + 2 近期，estimated/noCacheData 被剔除）');
    const expectedRecentMiss = 498 * 100000 + 10000 + 12000;
    assert.ok(Math.abs(agg.recentHitRatio - (94000 / (94000 + expectedRecentMiss))) < 1e-9,
      `近期命中率应按窗口内有效调用计算（陈旧全 miss 在窗口内如实计入，但不混入 estimated/noCacheData）`);
    // 陈旧记录超出窗口的那部分只进全量口径（历史事实不丢，只是与近期分开展示）
    assert.ok(agg.totalMiss >= 50_000_000, '全量口径保留全部历史 miss（与近期口径并存）');
  });
});
