// V0.109.3 通用中文 AI 腔：规则数据 + 确定性检测器 + 类型语义注册表 + 写审同源注入。
//
// 本套测试守四件事：
//   ① 每个检测器的命中/不命中/边界（含"正常文本不该报"这条最重要）
//   ② 护栏：短文本不判、对白内豁免、空输入不抛异常
//   ③ 注册表语义正确，且 rules.js 产出的每个 type 都已登记
//      （漏登记 = 新纪律静默不触发修订自愈，是本轮架构升级要防的核心风险）
//   ④ 端到端：medium「AI 腔」确实把 verdict 推成 fix（检测器不能是摆设）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_FAULT = '';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1093-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const rules = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/rules.js')));
const audit = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/audit.js')));
const issueTypes = await import(pathToFileURL(path.join(ROOT, 'server/data/issue_types.js')));
const aiFlavor = await import(pathToFileURL(path.join(ROOT, 'server/data/ai_flavor.js')));
const redlines = await import(pathToFileURL(path.join(ROOT, 'server/data/redlines.js')));
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));

/** 生成 n 段正常叙事（无 AI 腔特征），用于"不该报"的反向断言。
 *  含口语标记（"走吧"）与具体时间/数量——这样它对**全部**维度都构成无特征基线，
 *  否则会因"叙事温度为 0"被情感温度维度命中，让"不该报"的断言失去意义。 */
const normalText = (n = 12) => Array.from({ length: n }, (_, i) =>
  `第${i + 1}日辰时三刻，他沿着河滩走了三里，鞋底踩进泥里，拔出来时带出一小截芦苇根。`
  + `他蹲下身子，把芦苇根在指间捻了捻，又丢回水里。"走吧。"他站起来，接着往东去了。`).join('\n');

// ============================================================
describe('V0.109.3 通用中文 AI 腔', () => {

  // ---------- ① 检测器：命中 / 不命中 / 边界 ----------

  test('抽象黑话：命中商业黑话与空洞大词，正常叙事不报', () => {
    assert.equal(rules.detectAbstractJargon('').length, 0);
    assert.equal(rules.detectAbstractJargon(normalText()).length, 0, '正常叙事不得误报');

    // 单条命中不报（阈值 abstractJargonMax = 2）
    assert.equal(rules.detectAbstractJargon('这件事赋能了全局。').length, 0, '单处不报（低于阈值）');
    const hit = rules.detectAbstractJargon('这件事赋能了全局，形成了闭环，是底层逻辑。');
    assert.equal(hit.length, 1);
    assert.equal(hit[0].type, 'AI 腔');
    assert.equal(hit[0].severity, 'medium');
  });

  test('翻译腔：命中框架句式；两处以上升 medium', () => {
    assert.equal(rules.detectTranslationese('').length, 0);
    assert.equal(rules.detectTranslationese(normalText()).length, 0, '正常叙事不得误报');

    const one = rules.detectTranslationese('他在观察的过程中记下了水位。');
    assert.equal(one.length, 1);
    assert.equal(one[0].severity, 'low', '单处为 low');

    const many = rules.detectTranslationese('他在观察的过程中记下了水位。对于船工来说，这是要做出决定的事。');
    assert.ok(many.length >= 2);
    assert.ok(many.every(i => i.severity === 'medium'), '≥2 处升 medium');
  });

  test('"的"字地狱：单句 ≥3 个"的"报，对白内豁免', () => {
    assert.equal(rules.detectDeChain(normalText()).length, 0, '正常叙事不得误报');
    const bad = rules.detectDeChain('那是一条通往山那边的小小的旧旧的石板路。');
    assert.equal(bad.length, 1);
    assert.equal(bad[0].type, 'AI 腔');
    // 对白内的"的"多属口语自然，豁免
    assert.equal(rules.detectDeChain('他说："那是一条通往山那边的小小的旧旧的石板路。"').length, 0,
      '对白内豁免');
  });

  test('假升华：叙述层顿悟收束报，同一句只报一条', () => {
    assert.equal(rules.detectPseudoSublimation(normalText()).length, 0, '正常叙事不得误报');
    const hit = rules.detectPseudoSublimation('他站在城头。这一刻他终于明白了这一切的意义。');
    assert.equal(hit.length, 1, '一句话命中多个模式也只报一条（按句去重）');
    // 关键豁免：人物在对话里说自己想通了是合法的
    assert.equal(rules.detectPseudoSublimation('他说："这一刻我终于明白了。"').length, 0,
      '对白内顿悟不算 AI 腔');
  });

  test('万能状语：命中"带着一丝X"式；正常携带实义物不报', () => {
    assert.equal(rules.detectMannerAdverbial(normalText()).length, 0, '正常叙事不得误报');
    assert.equal(rules.detectMannerAdverbial('他带着干粮上路了。').length, 0, '实义"带着"不报');
    const hit = rules.detectMannerAdverbial('她笑了，带着一丝嘲讽。');
    assert.equal(hit.length, 1);
    assert.equal(hit[0].severity, 'low');
  });

  test('三段排比：只报"等长且同字起头"的机器签名，正常排比不报', () => {
    // 误报风险最高的一条：中文排比是正当修辞，实测此句曾被误报
    assert.equal(rules.detectRuleOfThree('远处有船靠岸，缆绳落在青石板上，发出沉闷的响声。').length, 0,
      '正常叙事排比不得误报');
    assert.equal(rules.detectRuleOfThree(normalText()).length, 0);
    // 等长 + 同字起头 = 机器签名
    const hit = rules.detectRuleOfThree('他来了，他走了，他沉默。');
    assert.equal(hit.length, 1);
    assert.equal(hit[0].type, 'AI 腔');
  });

  test('句式同质化：短句占比过低时报，短文本不判', () => {
    const longOnly = Array.from({ length: 25 }, (_, i) =>
      `他在第${i}个清晨沿着河滩缓慢走向远处的芦苇荡并且不断回想着昨天发生过的那些事情。`).join('');
    const hit = rules.detectSentenceMonotony(longOnly);
    assert.ok(hit.some(i => /短句占比/.test(i.issue)), '通篇长句应报短句占比不足');
    assert.ok(hit.every(i => i.statistical === true), '分布型指标须带 statistical 标记');
    // 最小规模护栏：句数不足不判
    assert.equal(rules.detectSentenceMonotony('他很累。').length, 0, '短文本不判');
  });

  test('段落均质度：段落过于等长时报，段落数不足不判', () => {
    const even = Array.from({ length: 10 }, () => '他在河滩上走了一段路，看了看水位，然后继续往前走。').join('\n');
    const hit = rules.detectParagraphEvenness(even);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].statistical, true);
    assert.equal(rules.detectParagraphEvenness('一段。\n两段。').length, 0, '段落数不足不判');
  });

  test('连接词密度：密度超阈值时报，正常叙事不报', () => {
    assert.equal(rules.detectConnectorDensity(normalText()).length, 0, '正常叙事不得误报');
    const dense = '此外，他看了看天。同时，屋里有人咳嗽。更重要的是，他听见了脚步。'.repeat(12);
    const hit = rules.detectConnectorDensity(dense);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].statistical, true);
  });

  test('情感温度：三支全无才报（软信号 low + statistical，不触发修订）', () => {
    assert.equal(rules.detectEmotionTemperature(normalText()).length, 0, '正常叙事不得误报');

    const cold = '他走进院子。他看了看天。他关上门。'.repeat(12);
    const hit = rules.detectEmotionTemperature(cold);
    assert.equal(hit.length, 1, '纯冷叙事（无情绪/主观/口语）应报');
    assert.equal(hit[0].severity, 'low', '软信号恒为 low——不参与 verdict');
    assert.equal(hit[0].statistical, true, '分布型指标须带标记（返工文风闸排除它）');

    // 三支任一存在即不报
    assert.equal(rules.detectEmotionTemperature(cold + '他心里害怕。').length, 0, '有情绪词即不报');
    assert.equal(rules.detectEmotionTemperature(cold + '说实话，他拿不准。').length, 0, '有主观标记即不报');
    assert.equal(rules.detectEmotionTemperature(cold + '这活儿咋弄呢。').length, 0, '有口语标记即不报');
  });

  test('事实锚点：整章无具体时间/数目/地名时报，有任一即不报', () => {
    assert.equal(rules.detectFactAnchor(normalText()).length, 0, '正常叙事不得误报（含"辰时"/"三里"）');
    const abstractOnly = '他走进那个地方。他看了看那边的情况。他觉得事情有些复杂。'.repeat(12);
    const hit = rules.detectFactAnchor(abstractOnly);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].statistical, true);
  });

  test('全部检测器对空输入/非字符串不抛异常', () => {
    const detectors = [
      'detectAbstractJargon', 'detectTranslationese', 'detectDeChain', 'detectPseudoSublimation',
      'detectMannerAdverbial', 'detectRuleOfThree', 'detectSentenceMonotony',
      'detectParagraphEvenness', 'detectConnectorDensity', 'detectEmotionTemperature', 'detectFactAnchor',
    ];
    for (const name of detectors) {
      assert.equal(typeof rules[name], 'function', `${name} 应导出`);
      assert.doesNotThrow(() => rules[name](''), `${name} 空串不抛`);
      assert.doesNotThrow(() => rules[name](null), `${name} null 不抛`);
      assert.doesNotThrow(() => rules[name](undefined), `${name} undefined 不抛`);
    }
  });

  test('新检测器已接入 runLocalRules（不是孤儿函数）', () => {
    const text = '这件事赋能了全局，形成了闭环，是底层逻辑。他在观察的过程中记下了水位。'
      + '那是一条通往山那边的小小的旧旧的石板路。这一刻他终于明白了这一切的意义。';
    const all = rules.runLocalRules(text, {});
    assert.ok(all.some(i => i.type === 'AI 腔'), 'runLocalRules 聚合结果应含 AI 腔');
  });

  // ---------- ② 词表零重复 ----------

  test('ai_flavor 词表与 redlines 零重复（禁第二份）', () => {
    const red = new Set([...redlines.AI_CLICHE_WORDS, ...redlines.AI_CLICHES]);
    const mine = [
      ...aiFlavor.ABSTRACT_JARGON, ...aiFlavor.GRAND_ABSTRACTION, ...aiFlavor.HEDGING_WORDS,
      ...aiFlavor.EMOTION_LEXICON, ...aiFlavor.SUBJECTIVE_MARKERS, ...aiFlavor.COLLOQUIAL_MARKERS,
      ...aiFlavor.AI_CONNECTORS,
    ];
    const dup = mine.filter(w => red.has(w));
    assert.deepEqual(dup, [], `不得与 redlines 重复：${dup.join('、')}`);
    assert.ok(mine.length > 50, '词表应有实质内容');
  });

  test('ai_flavor 不私藏阈值（量化数字只在 redlines 单一真源）', () => {
    const src = read('server/data/ai_flavor.js');
    // 该文件应只有词表与正则，不得出现"阈值型"数字常量赋值
    assert.doesNotMatch(src, /Max\s*[:=]\s*\d/, 'ai_flavor.js 不得定义阈值');
    assert.doesNotMatch(src, /Min\s*[:=]\s*\d/, 'ai_flavor.js 不得定义阈值');
    const rl = readlines();
    for (const key of ['aiFlavorMinSentences', 'shortSentenceMax', 'paragraphEvennessMin',
      'connectorPerKCharsMax', 'abstractJargonMax', 'deChainMax', 'ruleOfThreeMax',
      'emotionTemperatureMin', 'factAnchorMin']) {
      assert.ok(rl.includes(key), `redlines.REDLINES 应含 ${key}`);
    }
  });

  // ---------- ③ 类型注册表语义与覆盖 ----------

  test('注册表：AI 腔可修不记债；高/中/低严重度语义正确', () => {
    assert.equal(issueTypes.needsRoundup('AI 腔'), false, 'AI 腔不记债（文本级，修复即了结）');
    assert.equal(issueTypes.isTextOnlyType('AI 腔'), true, 'AI 腔属纯文本级');
    assert.equal(issueTypes.isClicheOnlyType('AI 腔'), true, 'AI 腔属 AI 味文本问题');
    assert.equal(issueTypes.isFixableIssue({ type: 'AI 腔', severity: 'medium' }), true,
      'medium AI 腔必须可修——否则检测形同虚设');
    assert.equal(issueTypes.isFixableIssue({ type: 'AI 腔', severity: 'low' }), false,
      'low 不触发修订');
    assert.equal(issueTypes.isFixableIssue({ type: '角色矛盾', severity: 'medium' }), false,
      '需圆场类型 medium 不走修订');
    assert.equal(issueTypes.isFixableIssue({ type: '角色矛盾', severity: 'high' }), true,
      'high 一律可修');
  });

  test('注册表：未登记类型保持旧行为（全部 false）', () => {
    assert.equal(issueTypes.needsRoundup('从未登记过的类型'), false);
    assert.equal(issueTypes.isFixableIssue({ type: '从未登记过的类型', severity: 'medium' }), false);
    assert.equal(issueTypes.isTextOnlyType('从未登记过的类型'), false);
  });

  test('注册表：rules.js 产出的每个 issue type 都已登记（防漏登记导致静默失效）', () => {
    const src = read('server/engine/quality/rules.js');
    const types = new Set([...src.matchAll(/type:\s*'([^']+[\u4e00-\u9fff][^']*)'/g)].map(m => m[1]));
    assert.ok(types.size >= 5, `应提取到多个中文类型（实际 ${types.size}）`);
    const missing = [...types].filter(t => !issueTypes.isRegisteredIssueType(t));
    assert.deepEqual(missing, [], `以下类型未在 issue_types 注册（新增纪律须同步登记）：${missing.join('、')}`);
  });

  test('注册表：audit 指令的类型枚举与注册表口径一致', () => {
    const src = read('server/engine/prompts.js');
    assert.match(src, /\|AI 腔\|/, 'typeEnum 应含 AI 腔');
    const enumTypes = ['角色矛盾', '时间线冲突', '设定冲突', '人称视角', '伏笔遗忘', '事实编造',
      '事实矛盾', '语句质量', 'AI 腔', '大纲偏离', '情感连贯性', '文学性', '史实错误',
      '环境描写缺失', '心理描写标签化', '战争逻辑', '权谋逻辑'];
    const missing = enumTypes.filter(t => !issueTypes.isRegisteredIssueType(t));
    assert.deepEqual(missing, [], `类型枚举中未登记：${missing.join('、')}`);
  });

  // ---------- ④ 写审同源 ----------

  test('写审同源：写作注入 AI 腔简报，审校注入同源核查边界，修订注入同一纪律', () => {
    const write = prompts.writeSceneInstruction({
      bookTitle: 'T', chapterIdx: 1, chapterTitle: 'C',
      scene: { id: 's1', pov: '甲', location: '营', beat: '观察', target_words: 1000 },
      scenesBefore: [], sceneAfter: null, prevTail: '', worldbookText: '', factsText: '',
      foreshadowsText: '', rules: '', rollingSummary: '', recentSummaries: [],
      timelineEvents: [], futureChapters: [], constraints: '',
    });
    assert.ok(write.includes('【语言去机器腔】'), '写作侧应注入 AI 腔简报');
    assert.ok(write.includes('单句"的"不超过 3 个'), '机械防线应含新量化红线');

    const auditText = prompts.auditInstruction({
      bookTitle: 'T', chapterTitle: 'C', chapterText: 'x', factsText: '',
      foreshadowsText: '', characterStates: '', contract: '',
    });
    assert.ok(auditText.includes('3.17 AI 腔核查'), '审校侧应有 3.17 核查边界');
    assert.ok(auditText.includes('AI 腔'), '审校侧应能报 AI 腔类型');

    const revise = prompts.reviseInstruction({
      bookTitle: 'T', chapterTitle: 'C', scene: { id: 's1', beat: 'b' }, issues: [],
      aiFlavorCraft: read('server/data/literary_techniques.js').includes('AI 腔纪律') ? '【AI 腔纪律】x' : '',
    });
    assert.ok(revise.includes('【AI 腔纪律】'), '修订侧应能注入 AI 腔纪律（写了才会按同一把尺改）');
  });

  test('纪律文本存在且不含库存动作范例（铁律一）', () => {
    const src = read('server/data/literary_techniques.js');
    assert.match(src, /export const AI_FLAVOR_TEXT/, '应有 AI_FLAVOR_TEXT 纪律常量');
    // 纪律正文不得夹带"握拳/指节发麻"式可直接照抄的库存范例
    assert.doesNotMatch(src, /AI_FLAVOR_TEXT[\s\S]{0,2000}握紧了拳/, '不得夹带库存动作范例');
  });

  test('polish 诊断与执行两侧都消费 AI 腔口径', () => {
    const p = read('server/engine/prompts.js');
    assert.match(p, /polishDiagnoseInstruction[\s\S]*?机器腔维度/, 'polish 诊断应含机器腔维度');
    assert.match(p, /polishExecuteInstruction[\s\S]*?aiFlavorBrief/, 'polish 执行应能注入简报');
    const polish = read('server/engine/quality/polish.js');
    assert.match(polish, /aiFlavorBrief:\s*CREATIVE_AI_FLAVOR_BRIEF/, 'polish 调用点应传简报');
  });

  // ---------- ⑤ 架构：闸与改写单元同职责 ----------

  test('返工文风闸排除篇章级分布指标（防"旧稿有一项→候选必然还有一项"批量误杀）', () => {
    const src = read('server/engine/recovery/recommendation_recovery.js');
    assert.match(src, /filter\(issue => !issue\.statistical\)/,
      'blockingProseIssues 应排除 statistical 指标（与 axis 同类处理）');
  });

  test('audit 与 pipeline 的文本级/记债判定已改为查注册表（单一真源）', () => {
    const auditSrc = read('server/engine/pipeline/audit.js');
    assert.match(auditSrc, /needsRoundup\(type\)/, 'audit 记债应查注册表');
    assert.match(auditSrc, /isFixableIssue/, 'audit 可修判定应查注册表');
    assert.doesNotMatch(auditSrc, /const\s+NEEDS_ROUNDUP\s*=/, '不得残留第二份白名单');

    const pipeSrc = read('server/engine/pipeline/pipeline.js');
    assert.match(pipeSrc, /isAllTextOnly/, 'pipeline textOnly 应查注册表');

    const divSrc = read('server/engine/quality/chapter_diversity.js');
    assert.match(divSrc, /isClicheOnlyType/, 'chapter_diversity 应查注册表');
  });

  // ---------- ⑥ 端到端：medium「AI 腔」确实触发修订自愈 ----------

  test('端到端：medium「AI 腔」把 verdict 推成 fix（检测器不能是摆设）', async () => {
    const book = store.books.create({ title: 'AI腔回归', genre: '玄幻' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
    const chapter = store.chapters.create(book.id, volume.id, 1, { title: '第一章' });
    store.scenes.create(chapter.id, 1, {
      status: 'done',
      content: '他在推演的流程当中进行了充分的梳理。这件事赋能了全局，形成了闭环，'
        + '构成了底层逻辑。那是一条通往山那边的小小的旧旧的石板路。'
        + '他站在城头，这一刻他终于明白了这一切的意义。'
        + '他笑了笑，带着一丝嘲讽。他又叹了口气，带着几分无奈。',
    });

    const result = await audit.auditChapter(book.id, chapter.id);
    const aiIssues = result.localIssues.filter(i => i.type === 'AI 腔');
    assert.ok(aiIssues.length > 0, '本地应报出 AI 腔问题');
    assert.ok(aiIssues.some(i => i.severity === 'medium'), '应有 medium 级 AI 腔');
    assert.equal(result.verdict, 'fix',
      'medium AI 腔必须把 verdict 推成 fix——否则修订自愈不会启动，检测形同虚设');
  });

  test('端到端：干净文本不被误判为需修订（防误报把正常章节卡进修订循环）', async () => {
    const book = store.books.create({ title: '干净稿', genre: '玄幻' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
    const chapter = store.chapters.create(book.id, volume.id, 1, { title: '第一章' });
    store.scenes.create(chapter.id, 1, {
      status: 'done',
      content: '辰时三刻，他蹲在河边，把芦苇根在指间捻了捻。水凉，他甩了甩手。"走吧。"'
        + '他站起来，沿着滩涂往东走了三里，鞋底踩进泥里，拔出来时带出一小截根须。',
    });

    const result = await audit.auditChapter(book.id, chapter.id);
    const aiIssues = result.localIssues.filter(i => i.type === 'AI 腔');
    const mediumAi = aiIssues.filter(i => i.severity === 'medium');
    assert.deepEqual(mediumAi, [], `干净文本不得报 medium AI 腔：${JSON.stringify(mediumAi)}`);
  });
});

/** 读 redlines.js 源码文本（供阈值存在性断言） */
function readlines() {
  return read('server/data/redlines.js');
}
