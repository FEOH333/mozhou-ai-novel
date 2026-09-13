// V0.83 开书前全链路最终检查（32 处修复的核心断言）
// 覆盖：路由补全/writingModel/懒卷纲/截断重试/文风注入/scene_type/结构纪律/签约复评/
// 名字质量门/标题误杀漏网/attraction hard/关键节点硬要求/语义检索降级/漂移周期/中期反馈约束/
// replanReason/卷末钩子/世界展开收紧/归档多批/卷体检技巧维度/cast接线
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v091-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.83 开书前全链路最终检查', () => {
  test('①7个V0.80-0.82新任务补DEFAULT_ROUTES（不再回退write的0.9高发散）', async () => {
    const { DEFAULT_ROUTES } = await import(pathToFileURL(path.join(ROOT, 'server/config.js')));
    for (const t of ['era_context', 'opening_blueprint', 'attraction', 'signing_review', 'promise_check', 'growth_remedy', 'world_progress']) {
      assert.ok(DEFAULT_ROUTES[t], `${t} 应有专属路由`);
    }
    assert.equal(DEFAULT_ROUTES.era_context.temperature, 0.3, '历史考据低温度');
    assert.equal(DEFAULT_ROUTES.attraction.temperature, 0.2, '判定任务低温度');
    assert.equal(DEFAULT_ROUTES.opening_blueprint.reasoningEffort, 'high', '开篇蓝图高思考强度');
  });

  test('②writingModel 不再被路由保存锁死 pro', async () => {
    const { resolveModelName } = await import(pathToFileURL(path.join(ROOT, 'server/config.js')));
    const mkG = routes => ({ provider: 'deepseek_official', writingModel: 'flash', routes });
    // 默认 global + 旧路由缓存（含 write model=deepseek-v4-pro）→ 仍应跟随 writingModel=flash
    const name = resolveModelName('write', 'deepseek-v4-pro', mkG({ write: { model: 'deepseek-v4-pro', temperature: 0.9, maxTokens: 12000, thinking: 'disabled' } }), {});
    assert.equal(name, 'deepseek-v4-flash', '旧路由缓存的 pro 不应覆盖 writingModel=flash');
    // 显式指定第三方模型名 → 尊重覆盖
    const name2 = resolveModelName('write', 'deepseek-v4-pro', mkG({ write: { model: 'glm-5', temperature: 0.9, maxTokens: 12000, thinking: 'disabled' } }), {});
    assert.equal(name2, 'glm-5', '显式第三方模型名应尊重');
  });

  test('③latestBlurb ReferenceError 修复（generateBookOutline 不再引用外部作用域变量）', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/planning/outline.js'), 'utf8');
    // 生成书纲函数内不得有对 latestBlurb 变量的代码引用（注释提及不算）——此前仅 generateBookContract 内声明 → 触发即崩
    const fnStart = src.indexOf('export async function generateBookOutline');
    const fnEnd = src.indexOf('export async function generateVolumeOutline');
    const fnBody = src.slice(fnStart, fnEnd);
    assert.ok(!fnBody.includes('latestBlurb ||'), 'generateBookOutline 内不得引用 latestBlurb 变量');
  });

  test('④pilot 骨架幂等解耦：快感计划/开篇蓝图/设定从"书纲缺失"块外（老书重跑可补）', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/pilot.js'), 'utf8');
    // 书纲缺失块到"已按大纲命名"（块内最后语句）结束——三步调用必须出现在该标记之后（块外）
    const blockEnd = src.indexOf('已按大纲命名为');
    const afterBlock = src.slice(blockEnd);
    assert.ok(afterBlock.includes('generateOpeningBlueprint'), '开篇蓝图调用移出书纲缺失块');
    assert.ok(afterBlock.includes('generateBookSettings'), '设定生成调用移出书纲缺失块');
    assert.ok(afterBlock.includes('planBookPleasure'), '快感计划调用移出书纲缺失块');
    // 书纲块本身不再包含三步
    const blockStart = src.indexOf("if (!store.materials.get(bookId, 'outline')?.content)");
    const blockBody = src.slice(blockStart, blockEnd);
    assert.ok(!blockBody.includes('generateOpeningBlueprint'), '书纲缺失块内不得有开篇蓝图');
    assert.ok(!blockBody.includes('generateBookSettings'), '书纲缺失块内不得有设定生成');
  });

  test('⑤jsonMode 规划型任务截断重试（runTask 提高 maxTokens 重试 + truncated 标记）', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/llm/router.js'), 'utf8');
    assert.ok(src.includes('PLANNING_TASKS'), '规划任务集合存在');
    assert.ok(src.includes("r.finishReason === 'length'") || src.includes("first.finishReason === 'length'"), '截断检测');
    assert.ok(src.includes('truncated = true'), '重试后仍截断标记 truncated');
    // V0.95.2：audit 开思考后纳入截断重试集（reasoning 挤占 JSON 的兜底；fail-closed 语义不变——重试后仍截断照抛 AUDIT_INVALID）
    assert.ok(src.split("PLANNING_TASKS = new Set")[1].includes("'audit'"), 'audit 参与截断重试（V0.95.2）');
  });

  test('⑥文风注入卷纲/细纲/修订/打磨（防大纲基调定错与修订漂移）', async () => {
    const { volumeOutlineInstruction, chapterOutlineInstruction, reviseInstruction, polishExecuteInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const v = volumeOutlineInstruction({ bookTitle: 'X', volumeIdx: 1, volumeTitle: 'V1', bookOutline: '{}', chapterCount: 6, styleRules: '【文风纪律】冷峻克制' });
    assert.ok(v.includes('【文风纪律】冷峻克制'), '卷大纲注入文风');
    const c = chapterOutlineInstruction({ bookTitle: 'X', chapterIdx: 1, volumeGoal: '', recentSummaries: [], rollingSummary: '', activeForeshadows: [], forgottenForeshadows: [], approachingForeshadows: [], retrieved: [], prevChapterTail: '', futureChapters: [], styleRules: '【文风纪律】冷峻克制', prevContinuityTo: '铺垫' });
    assert.ok(c.includes('【文风纪律】冷峻克制'), '细纲注入文风');
    const r = reviseInstruction({ bookTitle: 'X', chapterTitle: 'C', scene: { target_words: 1000, content: '原文' }, issues: [{ severity: 'high', type: '设定冲突', issue: 'i', quote: 'q', fix: 'f' }], extraNote: '', styleRules: '【文风纪律】冷峻克制' });
    assert.ok(r.includes('【文风纪律】冷峻克制'), '修订注入文风');
    const p = polishExecuteInstruction({ bookTitle: 'X', chapterIdx: 1, chapterTitle: 'C', chapterText: 'T', feedback: 'f', styleRules: '【文风纪律】冷峻克制' });
    assert.ok(p.includes('【文风纪律】冷峻克制'), '打磨注入文风');
  });

  test('⑦scene_type 持久化（schema列/建行写入/技法用真实类型）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const b = store.books.create({ title: '场景书', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: 'V1' });
    const ch = store.chapters.create(b.id, v.id, 1, { title: 'ch1', status: 'planned' });
    store.scenes.create(ch.id, 1, { beat: '大战', sceneType: 'fight' });
    const sc = store.scenes.list(ch.id)[0];
    assert.equal(sc.scene_type, 'fight', 'scene_type 落库');
    // 语法：schema 含列、pipeline 写入
    const schema = fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8');
    assert.ok(schema.includes('scene_type'), 'schema 含 scene_type 列');
    const pipe = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/pipeline.js'), 'utf8');
    assert.ok(pipe.includes('sceneType: s.scene_type'), 'ensureSceneRows 写入 scene_type');
  });

  test('⑧结构纪律 structureInjection 接入章细纲（插叙/铺垫纪律章级生效）', async () => {
    const { chapterOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const c = chapterOutlineInstruction({ bookTitle: 'X', chapterIdx: 1, volumeGoal: '', recentSummaries: [], rollingSummary: '', activeForeshadows: [], forgottenForeshadows: [], approachingForeshadows: [], retrieved: [], prevChapterTail: '', futureChapters: [] });
    assert.ok(c.includes('插叙与倒叙的使用原则'), '细纲含插叙纪律');
    assert.ok(c.includes('每 10-15 章安排一次'), '细纲含小高潮结算');
    assert.ok(c.includes('连续紧张不超过 3 章'), '细纲含节奏纪律');
  });

  test('⑨签约评审修订零破坏（保留评审证据、滚动摘要和已完成正文）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { rewriteOpening } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/signing.js')));
    const b = store.books.create({ title: '签约书', genre: '玄幻', platform: '番茄', blurb: 'x' });
    store.materials.set(b.id, 'signing_review', '评审结论：reject');
    store.rollingSummaries.set(b.id, '旧剧情污染');
    const v = store.volumes.create(b.id, 1, { title: 'V1' });
    const ch = store.chapters.create(b.id, v.id, 1, { title: 'ch1', status: 'done', word_count: 3000 });
    store.scenes.create(ch.id, 1, { content: '正文', status: 'done' });
    store.chapterSettlements.set(b.id, ch.id, { contentHash: 'hash', result: {} });
    const r = await rewriteOpening(b.id, { toChapter: 1 });
    assert.ok(r.ok && r.staged, '修订任务登记');
    assert.equal(store.materials.get(b.id, 'signing_review')?.content, '评审结论：reject', '保留评审证据，避免重复触发');
    assert.equal(store.rollingSummaries.get(b.id), '旧剧情污染', '原稿未替换前滚动摘要保持一致');
    assert.equal(store.chapters.get(ch.id).status, 'done', '章节保持完成状态');
    assert.equal(store.chapters.fullText(ch.id), '正文', '正文不得清空');
    assert.ok(store.materials.get(b.id, 'signing_revision_brief')?.content, '修订任务单落库');
  });

  test('⑩角色名质量门：结算抽取占位名/称谓名不建卡（进 pending）', async () => {
    const { isSaneName, isPlaceholderName } = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/names.js')));
    assert.equal(isPlaceholderName('灰衣人'), true, '占位名识别');
    assert.equal(isPlaceholderName('老者'), true, '称谓识别');
    assert.equal(isPlaceholderName('掌柜的'), true, '身份后缀识别');
    assert.equal(isSaneName('赵铁柱'), true, '常规名通过');
    assert.equal(isSaneName('灰衣人'), false, '占位名不建卡');
    assert.equal(isSaneName('掌柜的'), false, '称谓名不建卡');
    assert.equal(isSaneName('一个神秘男子'), false, '无名指代不建卡');
    // settle 接线：合成校验（两处建卡前过 isSaneName）
    const settle = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/settle.js'), 'utf8');
    assert.ok(settle.includes('isSaneName'), 'settle 引用名字质量门');
  });

  test('⑪章名：中性意象词不再误杀（生死之间/真相之前），流水账漏网修正', async () => {
    const { isFlatTitle, hasFlatTitleFlaw } = await import(pathToFileURL(path.join(ROOT, 'server/engine/longform/alignment.js')));
    assert.equal(isFlatTitle('生死之间'), false, '中性词不误杀');
    assert.equal(isFlatTitle('真相之前'), false, '中性词不误杀');
    assert.equal(isFlatTitle('夜探旧宅'), true, '动作直述保留');
    assert.equal(hasFlatTitleFlaw('药园杂役'), true, '流水账软信号');
    assert.equal(hasFlatTitleFlaw('雨夜叩门'), false, '文学标题无缺陷');
    assert.equal(hasFlatTitleFlaw('第6章'), true, '骨架残留检测');
  });

  test('⑫attraction：番茄默认 hard 生效（?? 不遮蔽）+ 历史轻事件词表', async () => {
    const { attractionLocalRules } = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/attraction.js')));
    // 历史宫廷文戏（无打杀但有"诏令"）→ 不误报平淡开场
    const histText = '诏令自临安星夜而至，弹劾的奏章堆满案头，参奏他私通北虏，一道旨意押他下狱。他立在堂前，望着那份文书，久久无言。';
    const r1 = attractionLocalRules(histText, { isHistory: true });
    assert.ok(!r1.some(i => i.type === '平淡开场'), '历史文戏含诏令/弹劾不误报');
    // 通用词表文本 → 仍走原逻辑
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/quality/attraction.js'), 'utf8');
    assert.ok(src.includes("settings.attractionGate ?? g?.attractionGate"), 'attraction mode 用 ?? （番茄 hard 不再被全局 soft 遮蔽）');
  });

  test('⑬关键节点硬性写作要求 + 语义检索降级保护', async () => {
    const { writeSceneInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const w = writeSceneInstruction({ bookTitle: 'X', chapterIdx: 1, chapterTitle: 'C', scene: { id: 's1', pov: 'A', location: 'L', beat: '攻城', target_words: 1000, scene_type: 'fight' }, scenesBefore: [], sceneAfter: null, prevTail: '', rollingSummary: '', recentSummaries: [], timelineEvents: [], futureChapters: [], foreshadowsText: '', factsText: '', worldbookText: '', constraints: '', styleRules: '', sceneType: 'fight' });
    assert.ok(w.includes('战斗戏硬要求'), '战斗戏硬要求');
    assert.ok(w.includes('地形'), '战斗含地形变量');
    const e = writeSceneInstruction({ bookTitle: 'X', chapterIdx: 1, chapterTitle: 'C', scene: { id: 's1', pov: 'A', location: 'L', beat: '诀别', target_words: 1000, scene_type: 'emotion' }, scenesBefore: [], sceneAfter: null, prevTail: '', rollingSummary: '', recentSummaries: [], timelineEvents: [], futureChapters: [], foreshadowsText: '', factsText: '', worldbookText: '', constraints: '', styleRules: '', sceneType: 'emotion' });
    assert.ok(e.includes('情感戏硬要求'), '情感戏硬要求');
    // 语义检索降级保护：factbook 引用 vectorstore 用动态 import + try/catch（embedding 不可用自动降级）
    const fb = fs.readFileSync(path.join(ROOT, 'server/engine/narrative/factbook.js'), 'utf8');
    assert.ok(fb.includes('relevantFactsSmart'), '智能召回存在');
    assert.ok(fb.includes('semanticSearch'), '语义检索接入');
    assert.ok(fb.includes('catch { /* embedding 不可用'), '降级保护存在');
  });

  test('⑭漂移周期信号 + replanReason 注入 + 中期反馈进全局约束 + 世界展开收紧', async () => {
    const rec = fs.readFileSync(path.join(ROOT, 'server/engine/recovery/recovery.js'), 'utf8');
    assert.ok(rec.includes('每 15 章周期性主题/大纲体检'), '周期漂移信号');
    assert.ok(rec.includes('replanReason: reason'), 'replanFrom 传诊断原因');
    assert.ok(rec.includes('世界观展开停滞'), '世界展开并入漂移信号');
    const pol = fs.readFileSync(path.join(ROOT, 'server/engine/quality/polish.js'), 'utf8');
    assert.ok(pol.includes("source: 'polish'"), '中期反馈写入全局约束');
    // 世界展开：touchEntities 需进展动词才计 first_chapter
    const we = fs.readFileSync(path.join(ROOT, 'server/engine/planning/world_expansion.js'), 'utf8');
    assert.ok(we.includes('progressRe'), 'touchEntities 含进展动词判定');
    assert.ok(we.includes('doneChapters - 25'), '高层级须近期活跃（防闪现顶格）');
  });

  test('⑮卷间/章间承接：续卷末章钩子 + 上章铺垫注入 + 卷体检技巧维度', async () => {
    const cont = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/continuation.js'), 'utf8');
    assert.ok(cont.includes('结尾钩子'), '续卷末章钩子注入');
    assert.ok(cont.includes('hooks.volume_ending'), '卷体检末章钩子补读');
    const { chapterOutlineInstruction, volumeReviewInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const c = chapterOutlineInstruction({ bookTitle: 'X', chapterIdx: 2, volumeGoal: '', recentSummaries: [], rollingSummary: '', activeForeshadows: [], forgottenForeshadows: [], approachingForeshadows: [], retrieved: [], prevChapterTail: '', futureChapters: [], prevContinuityTo: '为下一章埋下伏笔' });
    assert.ok(c.includes('上一章铺垫'), '上章 continuity_to 注入');
    const v = volumeReviewInstruction({ bookTitle: 'X', volumeIdx: 1, volumeTitle: 'V1', volumeGoal: '', volumeSummary: '', chapterLines: '', foreshadowLines: '', prevVolumeTail: '', contractLogline: '' });
    assert.ok(v.includes('"technique"'), '卷体检含技巧维度');
    assert.ok(v.includes('插叙'), '技巧维度含插叙');
  });

  test('⑯历史判词升级：签约按多类型阅读回报和胜利代价审阅', async () => {
    const { signingReviewInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const hist = signingReviewInstruction({ bookTitle: 'X', genre: '历史', contract: '', blueprint: '', opening: '' });
    assert.ok(hist.includes('阅读回报节奏'), '历史签约改用阅读回报判词');
    assert.ok(hist.includes('失败是否有增量'), '失败也必须产生叙事增量');
    assert.ok(!hist.includes('爽点是否当众'), '历史签约不强迫当众爽点');
  });

  test('⑰pilot 懒卷纲 + 卷章数统一 + cast 接线 + volumeCount 插值', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/pilot.js'), 'utf8');
    assert.ok(src.includes('v.idx > 2'), '懒卷纲（只预生成前2卷）');
    assert.ok(src.includes('sweepVolumeCastDesign'), 'cast 设计接线（V0.105.4 起为持久化 sweep，取代进程内 castDesignedVols）');
    assert.ok(src.includes('volumeChapterCount'), '卷章数统一函数');
    const { volumeChapterCount, lengthProfileOf } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));
    const b = { genre: '历史', settings_json: '{}' };
    assert.equal(volumeChapterCount(b, { isFirst: true }), 8, '首卷 8 章（V0.107 分章科学化）');
    assert.equal(volumeChapterCount(b), 12, '常规卷 12 章（V0.107 分章科学化）');
    const pr = fs.readFileSync(path.join(ROOT, 'server/engine/prompts.js'), 'utf8');
    assert.ok(pr.includes('volumes 数组**前 ${volumes || 4} 卷写完整'), 'volumeCount 插值接线');
  });

  test('⑱非历史题材零影响回归：原逻辑路径保持', async () => {
    const { attractionLocalRules } = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/attraction.js')));
    const r = attractionLocalRules('他猛地冲了上去，当众一脚踹翻那人，众人哗然震惊，反手一巴掌，爽！', { isHistory: false });
    assert.ok(!r.some(i => i.type === '本章无爽点'), '非历史通用爽点词仍有效');
    const { isSaneName } = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/names.js')));
    assert.equal(isSaneName('王铁柱'), true, '常规名');
    // 历史红线/命名规则仅历史题材注入（调用点有 genre 保护，纯函数本身通用）
    const h = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/history.js')));
    assert.ok(h.historyNamingRules().includes('避讳'), '命名规则含避讳');
  });
});
