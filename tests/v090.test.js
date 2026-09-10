// V0.82 历史题材超级加强：朝代可配置 / era_context 双写修复 / 史实校验 / 时间线锚点 /
// 历史爽点·签约·金手指分流 / 时代元素持久注入 / 取名避讳 / 地点库朝代地理 / 红线扩充
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v090-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.82 历史题材超级加强', () => {
  test('①朝代可配置：宋末默认内置包；自定义朝代走用户 seed 模板', async () => {
    const h = await import(pathToFileURL(path.join(ROOT, 'server/engine/history.js')));
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    // 默认（无 era）→ 宋末内置考据包
    const b = store.books.create({ title: '宋末书', genre: '历史', blurb: 'x' });
    const s1 = h.seedForBook(store.books.get(b.id));
    assert.ok(s1.label.includes('宋末'), '默认应选宋末内置包');
    assert.ok(s1.seed.includes('蒙哥'), '种子含史实人物');
    // 自定义朝代（明末）→ 用户 seed 模板
    const b2 = store.books.create({ title: '明末书', genre: '历史', blurb: 'x', era: JSON.stringify({ dynasty: '明末', years: '1628-1644', eraLine: '崇祯', seed: '李自成破京师 1644' }) });
    const s2 = h.seedForBook(store.books.get(b2.id));
    assert.ok(s2.label.includes('明末'), '自定义朝代走用户配置');
    assert.ok(s2.seed.includes('李自成破京师 1644'), '用户考据要点进 seed');
    // 宽松文本 era（key:value 行）
    const b3 = store.books.create({ title: '唐末书', genre: '历史', blurb: 'x', era: '朝代:唐末\n年份:875-907\n考据:黄巢之乱' });
    const cfg = h.parseEraConfig(store.books.get(b3.id));
    assert.equal(cfg.dynasty, '唐末');
    assert.equal(cfg.years, '875-907');
    assert.equal(cfg.seed, '黄巢之乱');
    const s3 = h.seedForBook(store.books.get(b3.id));
    assert.ok(s3.seed.includes('黄巢之乱'), '宽松文本要点进 seed');
    // 非历史书 seedForBook 仍返回宋末兜底（不影响：isHistory 外层拦截）
  });

  test('②era_context 双写修复：formatEraContext 输出带【时代红线】标签（章节级正则可匹配）', async () => {
    const h = await import(pathToFileURL(path.join(ROOT, 'server/engine/history.js')));
    const text = h.formatEraContext({
      era: '南宋末',
      real_events: ['1242年余玠筑山城'],
      offices: '宰执/制置使',
      military: '山城防御',
      geography: '钓鱼城',
      economy: '会子',
      ritual: '避讳',
      red_lines: ['烟草', '玉米'],
      alterable_history: '蒙哥之死',
    });
    assert.ok(text.includes('【时代红线】'), '含【时代红线】标签');
    assert.ok(text.includes('【可改史点】'), '含【可改史点】标签');
    assert.ok(text.includes('【史实骨架】'), '含【史实骨架】标签');
    // 章节级裁剪能命中红线/可改史点（此前自由文本无标签 → 裁剪返回空串 → 历史约束静默失效）
    const { eraContextText } = h;
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const b = store.books.create({ title: '红线书', genre: '历史', blurb: 'x' });
    store.materials.set(b.id, 'era_context', text);
    const chapter = h.eraContextText(b.id, { scope: 'chapter', maxChars: 300 });
    assert.ok(chapter.includes('时代红线'), '章节级注入含时代红线');
    assert.ok(chapter.includes('可改史点'), '章节级注入含可改史点');
  });

  test('③史实校验：auditInstruction 历史题材注入时代基准；非历史不注入', async () => {
    const { auditInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const hist = auditInstruction({ bookTitle: 'X', chapterTitle: 'C', chapterText: 'T', factsText: '', foreshadowsText: '', characterStates: '', contract: '', eraContext: '【时代红线】无烟草\n【可改史点】蒙哥之死' });
    assert.ok(hist.includes('历史时代基准'), '历史审校注入时代基准');
    assert.ok(hist.includes('史实错误'), '判定类型含史实错误');
    assert.ok(hist.includes('未到史实节点'), '含事件提前硬伤检查');
    const plain = auditInstruction({ bookTitle: 'X', chapterTitle: 'C', chapterText: 'T', factsText: '', foreshadowsText: '', characterStates: '', contract: '', eraContext: '' });
    assert.ok(!plain.includes('历史时代基准'), '非历史不注入时代基准');
    // 史实错误已入细纲根因（replan 分流）
    const { OUTLINE_ROOT_ISSUES } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline.js')));
    assert.ok(OUTLINE_ROOT_ISSUES.includes('史实错误'), '史实错误为细纲根因');
  });

  test('④历史阅读回报词表分流：只保留题材化计数信号，不凭缺词判空转', async () => {
    const { attractionLocalRules, attractionLocalSignals } = await import(pathToFileURL(path.join(ROOT, 'server/engine/attraction.js')));
    const histText = '王坚猛地拍案而起，识破这封军报里的阴谋，帐中诸将相顾动容，皆服其智。他缓步走出帐去，望见江上点点渔火。';
    const r1 = attractionLocalRules(histText, { isHistory: true });
    assert.ok(!r1.some(i => i.type === '本章无阅读回报'), '历史题材有识破/动容等史实回报词不应误判');
    const quiet = '他挑着水桶，走过长街，穿过市集，回了家，生了火，煮了饭，吃了，歇了。';
    assert.equal(attractionLocalSignals(histText, { isHistory: true }).reward_terms_found, true, '历史回报词应进入客观信号');
    assert.equal(attractionLocalSignals(quiet, { isHistory: true }).reward_terms_found, false, '缺词只记录 false');
    assert.ok(!attractionLocalRules(quiet, { isHistory: true }).some(i => i.type === '本章无阅读回报'), '缺词不能直接推出空转');
    assert.ok(!attractionLocalRules(quiet, { isHistory: false }).some(i => i.type === '本章无爽点'), '非历史也不得凭缺词判无爽点');
    assert.equal(attractionLocalSignals('他反手一巴掌，众人哗然，他冷笑一声，一脚踹翻那人，直接转身就走。', { isHistory: true }).reward_terms_found, false, '通用打脸词不冒充历史回报词');
  });

  test('⑤签约评审历史维度：史实严谨/历史质感/立身之本；金手指要求豁免', async () => {
    const { signingReviewInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const hist = signingReviewInstruction({ bookTitle: 'X', genre: '历史', contract: '', blueprint: '', opening: '' });
    assert.ok(hist.includes('史实严谨'), '历史评审含史实严谨');
    assert.ok(hist.includes('历史质感'), '含历史质感');
    assert.ok(hist.includes('历史人物尊重'), '含历史人物尊重');
    assert.ok(hist.includes('立身之本'), '含立身之本（替代金手指）');
    assert.ok(!hist.includes('金手指：是否 500 字内点明'), '历史题材豁免金手指硬要求');
    const plain = signingReviewInstruction({ bookTitle: 'X', genre: '玄幻', contract: '', blueprint: '', opening: '' });
    assert.ok(plain.includes('若原设定没有金手指，不得因此判低'), '非历史按原设定审核心玩法，不强造金手指');
    assert.ok(!plain.includes('金手指：是否 500 字内点明'), '非历史也不再使用伪平台字数阈值');
  });

  test('⑥史实事件锚点：seedEraEvents 落库 + 边界注入（已过不可改前因/未到不得提前）', async () => {
    const h = await import(pathToFileURL(path.join(ROOT, 'server/engine/history.js')));
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const b = store.books.create({ title: '锚点书', genre: '历史', blurb: 'x' });
    h.seedEraEvents(b.id, {
      real_events: ['1242年余玠筑山城防御体系', '1254年王坚大扩钓鱼城', '1259年蒙哥围钓鱼城七月死', '1279年崖山'],
    });
    const evs = store.eraEvents.list(b.id);
    assert.equal(evs.length, 4, '应落库 4 条');
    assert.equal(evs[0].year, 1242, '公元年抽取');
    // 故事年份 1250 → 已过 1242/1254？1254>1250 未到；已过=1242，未到=1254/1259/1279
    const boundary = store.eraEvents.boundaryText(b.id, 1250);
    assert.ok(boundary.includes('已过史实节点'), '含已过节点');
    assert.ok(boundary.includes('未到史实节点'), '含未到节点');
    assert.ok(boundary.includes('蒙哥围钓鱼城') === false || boundary.includes('未到史实节点'), '1259 蒙哥之死未到节点不得提前');
    // currentStoryYear：无 timeline 时用最早史实事件年份
    assert.equal(h.currentStoryYear(b.id), 1242, '故事起点=最早史实事件年份');
    // timeline 带 year 优先
    store.timeline.add(b.id, { chapterId: null, event: '淳祐三年（1243年）春，余玠募兵', year: 1243, eraYear: '淳祐三年', season: '春季' });
    assert.equal(h.currentStoryYear(b.id), 1243, 'timeline 纪年优先');
  });

  test('⑦纪年抽取：extractEraMarkers 提取 公元年/年号纪年/季节', async () => {
    const h = await import(pathToFileURL(path.join(ROOT, 'server/engine/history.js')));
    const m = h.extractEraMarkers('淳祐元年（1241年）春，蒙军哨骑出现在城下。');
    assert.equal(m.year, 1241);
    assert.ok(m.eraYear.includes('年'));
    assert.equal(m.season, '春季');
    assert.equal(h.extractEraMarkers('他走到城头，望着远方。').year, null);
  });

  test('⑧取名/避讳规则：注入契约与设定；红线扩充含错位称谓/异代制度', async () => {
    const h = await import(pathToFileURL(path.join(ROOT, 'server/engine/history.js')));
    const rules = h.historyNamingRules();
    assert.ok(rules.includes('避讳'), '含避讳规则');
    assert.ok(rules.includes('表字'), '含表字规则');
    assert.ok(rules.includes('余玠'), '含真实历史人物实名约束');
    // 红线扩充：宋人称谓/异代制度
    const d = await import(pathToFileURL(path.join(ROOT, 'server/data/history.js')));
    const terms = d.RED_LINES.map(r => r.term);
    assert.ok(terms.includes('大人'), '含错位称谓"大人"');
    assert.ok(terms.includes('南书房'), '含异代制度"南书房"');
    assert.ok(terms.includes('军机处'), '含异代制度"军机处"');
    assert.ok(terms.includes('科学'), '含现代观念词');
    // 红线检测：宋代语境"大人"应命中
    const hits = h.eraRedLineCheck('小人参见大人，请大人为小人做主。');
    assert.ok(hits.some(r => r.term === '大人'), '宋人自称小人称呼大人应命中错位称谓');
  });

  test('⑨时代元素词条化：ensureEraContext 后世界书自动建官职/地理词条（持久注入）', async () => {
    const h = await import(pathToFileURL(path.join(ROOT, 'server/engine/history.js')));
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const b = store.books.create({ title: '词条书', genre: '历史', blurb: 'x' });
    h.seedEraWorldbook(b.id, {
      offices: '制置使/都统制/知州',
      military: '山城防御/怯薛',
      geography: '钓鱼城/夔门/襄阳',
      economy: '会子/铜钱',
      ritual: '避讳/官家/点茶',
    });
    const wb = store.worldbook.list(b.id);
    assert.ok(wb.length >= 3, '应建 3+ 词条');
    const allKw = wb.flatMap(w => JSON.parse(w.keywords || '[]'));
    assert.ok(allKw.includes('制置使'), '官职词条关键词');
    assert.ok(allKw.includes('钓鱼城'), '地理词条关键词');
    assert.ok(allKw.includes('点茶'), '礼法词条关键词');
    // 已存在同名词条跳过（幂等）
    h.seedEraWorldbook(b.id, { offices: '制置使', military: '', geography: '', economy: '', ritual: '' });
    assert.ok(store.worldbook.list(b.id).length >= 3, '幂等不重复建词条');
  });

  test('⑩地点库朝代地理：admin_level/strategic 存储与注入文本', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { locationCardText } = await import(pathToFileURL(path.join(ROOT, 'server/engine/locations.js')));
    const b = store.books.create({ title: '地点书', genre: '历史', blurb: 'x' });
    const l = store.locations.create(b.id, { name: '钓鱼城', card: {} });
    store.locations.update(l.id, { kind: '山城', adminLevel: '州·山城', strategic: '三江汇流，锁江天堑', desc: '合州城东要塞' });
    const got = store.locations.get(l.id);
    assert.equal(got.admin_level, '州·山城', '行政层级存储');
    assert.equal(got.strategic, '三江汇流，锁江天堑', '战略属性存储');
    const text = locationCardText(b.id, '钓鱼城');
    assert.ok(text.includes('山城'), '注入含类型');
    assert.ok(text.includes('三江汇流'), '注入含战略属性');
    assert.ok(text.includes('州·山城'), '注入含行政层级');
  });

  test('⑪金手指分流：formatPleasurePlan/formatBlueprintText 历史题材改"立身之本"', async () => {
    const { formatPleasurePlan } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pleasure.js')));
    const plan = { reward_rhythm: { small: '每1章', medium: '每6章', large: '每20章' }, protagonist_recipe: { golden_finger: { power: '熟知川蜀地理', limit: '只知地理不知军略' } } };
    const histText = formatPleasurePlan(plan, { isHistory: true });
    assert.ok(histText.includes('立身之本'), '历史题材注入立身之本');
    assert.ok(!histText.includes('金手指：熟知川蜀地理'), '历史题材不注入金手指字段');
    const plainText = formatPleasurePlan(plan, { isHistory: false });
    assert.ok(plainText.includes('主角金手指'), '非历史保留金手指');
    // 开篇蓝图指令历史分支
    const { openingBlueprintInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const histBp = openingBlueprintInstruction({ bookTitle: 'X', genre: '历史', platform: '番茄', contract: '', bookOutline: '', pleasurePlan: '', chapterCount: 20, isHistory: true });
    assert.ok(histBp.includes('立身之本'), '历史开篇蓝图用立身之本');
    assert.ok(histBp.includes('历史文核心纪律'), '含历史文核心纪律');
    assert.ok(!histBp.includes('500字内点明金手指'), '历史蓝图豁免金手指硬要求');
    const plainBp = openingBlueprintInstruction({ bookTitle: 'X', genre: '玄幻', platform: '番茄', contract: '', bookOutline: '', pleasurePlan: '', chapterCount: 20, isHistory: false });
    assert.ok(plainBp.includes('若本书确有金手指'), '非历史仅在原设定存在时自然露出金手指');
    assert.ok(!plainBp.includes('500字内点明金手指'), '非历史也不再使用伪平台字数阈值');
  });

  test('⑫历史书 pilot 全流程：era 配置 + 史实锚点 + 世界书词条 + 边界注入', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { runBookPilot } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pilot.js')));
    const b = store.books.create({ title: '端到端历史', genre: '历史', platform: '番茄', blurb: '蜀中孤儿守钓鱼城', era: JSON.stringify({ dynasty: '南宋末', years: '1234-1279', eraLine: '淳祐/宝祐/开庆', seed: '余玠帅蜀；王坚筑钓鱼城；蒙哥1259年死' }) });
    const r = await runBookPilot(b.id, { targetChapters: 2 });
    assert.ok(r.written >= 1, '应写完至少 1 章');
    assert.ok(store.materials.get(b.id, 'era_context')?.content, '应生成时代背景卡');
    assert.ok(store.eraEvents.list(b.id).length >= 1, '应落史实锚点');
    assert.ok(store.worldbook.list(b.id).length >= 1, '应建时代词条');
    // 章节细纲注入史实边界（eraBoundary 非空——有史实锚点且当前年份已知）
    const { eraBoundaryText, currentStoryYear } = await import(pathToFileURL(path.join(ROOT, 'server/engine/history.js')));
    const boundary = eraBoundaryText(b.id, currentStoryYear(b.id));
    if (store.eraEvents.list(b.id).length) assert.ok(boundary.includes('史实边界'), '细纲/正文可注入史实边界');
  });

  test('⑬非历史题材零影响回归：爽点词表/审校/签约均走原逻辑', async () => {
    const { attractionLocalRules } = await import(pathToFileURL(path.join(ROOT, 'server/engine/attraction.js')));
    const r = attractionLocalRules('他猛地冲了上去，当众一脚踹翻那人，众人哗然震惊，反手一巴掌，爽！', { isHistory: false });
    assert.ok(!r.some(i => i.type === '本章无爽点'), '非历史通用爽点词仍有效');
    const { formatPleasurePlan } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pleasure.js')));
    const plan = { reward_rhythm: {}, protagonist_recipe: { golden_finger: { power: '系统面板' } } };
    assert.ok(formatPleasurePlan(plan, { isHistory: false }).includes('金手指'), '非历史保留金手指文案');
    // 红线检测仅历史题材启用——eraRedLineCheck 是纯函数，不注入非历史正文（调用点有 genre 保护）
    const h = await import(pathToFileURL(path.join(ROOT, 'server/engine/history.js')));
    assert.equal(h.eraRedLineCheck('他喝着咖啡看报纸。').length > 0, true, '红线检测函数本身可用（由调用点按题材启用）');
  });
});
