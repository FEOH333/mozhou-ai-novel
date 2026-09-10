// V0.98.14 高赞网友 AI 味清单 → 行文结构级防线补漏（写审同源一次到位）：
// 跨句拆分偈语（"不是X。…是Y。"）检测盲区 + 段首他她密度升档 + 审校结构层核查
import './helper.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('V0.98.14 对白跨句拆分偈语计入配额：3 处「不是X。…是Y。」→ medium（高赞"不是什么笑而是什么笑"形态）', async () => {
  const { detectAphorismQuota } = await import('../server/engine/rules.js');
  const dialogue = `陈七蹲下来看那道印子：“他们不是来探路的。”他拧了拧灯布，“是来看咱们挖到哪一步。看完了，就走。”
　　“这夜里营里需要的，不是一把追到沟口的刀。”他又说，“是有人把消息接好、传对，让该来的人来。”
　　“你记住了，怕的不是死在沟里。”他最后说，“是把话传错了害死全队。”`;
  const issues = detectAphorismQuota(dialogue);
  assert.ok(issues.some(i => i.severity === 'medium' && i.issue.includes('偈语')),
    '跨句拆开的「不是X。…是Y。」是同一偈语骨架，必须按配额统计（此前只认逗号同句形态，全部漏网）');
});

test('V0.98.14 对白跨句感知判别豁免：听声辨质/辨物句式不误计', async () => {
  const { detectAphorismQuota } = await import('../server/engine/rules.js');
  const soundTeaching = `“那不是牛叫的声。”陈七侧耳听了一息，“是风灌进溶洞的呜咽。”
　　“这不是碾过粗石的响。”他把耳朵贴上去，“是刃口顺着石面走的声音。”`;
  assert.equal(detectAphorismQuota(soundTeaching).length, 0, '听声辨质是合法感官教学句，跨句拆分不得误计偈语配额');
});

test('V0.98.14 叙述层跨句「不是X。…是Y。」点题对比：2 处升 medium，单字人称短否定豁免', async () => {
  const { detectNotButPattern } = await import('../server/engine/rules.js');
  const narration = `他等的不是那封信。是那个人的背影。
　　阿蛮问的从来不是工钱。是这一绳到底能不能拴住人。
　　夜里醒来的不是老兵。是新丁。`;
  const issues = detectNotButPattern(narration);
  assert.ok(issues.length >= 1, '叙述层跨句拆分对比必须入检测');
  assert.ok(issues.some(i => i.severity === 'medium'), '2 处以上跨句偈语应升 medium');
  const short = `“不是他。是我哥。”`;
  assert.equal(detectNotButPattern(short).length, 0, '单字人称口语短否定豁免');
});

test('V0.98.14 段首他她密度升档：≥45% 报 medium（参与审校修订），35-45% 保持 low 软信号', async () => {
  const { detectPronounParaDensity } = await import('../server/engine/rules.js');
  const REDLINES = (await import('../server/data/redlines.js')).REDLINES;
  assert.equal(REDLINES.pronounParaStartHigh, 0.45, '高阈值 45% 进单一真源');
  const paras50 = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? '他' : '石头') + `顶住第${i}道力。`).join('\n');
  const high = detectPronounParaDensity(paras50);
  assert.ok(high.some(i => i.severity === 'medium'), '段首主语过半=面目雷同，必须参与 verdict 触发修订');
  const paras40 = Array.from({ length: 20 }, (_, i) => (i % 5 < 2 ? '他' : '石头') + `顶住第${i}道力。`).join('\n');
  assert.equal(detectPronounParaDensity(paras40).every(i => i.severity === 'low'), true, '35-45% 区间保持软信号');
});

test('V0.98.14 写作指令写审同源：跨句偈语与段首主语红线进入正文写作要求', async () => {
  const { writeSceneInstruction } = await import('../server/engine/prompts.js');
  const instruction = writeSceneInstruction({
 bookTitle: '示例历史长篇', chapterIdx: 12, chapterTitle: '夜哨',
 scene: { id: 's1', pov: '主角', target_words: 2000, beat: '看营' },
    scenesBefore: [], sceneAfter: null, prevTail: '', worldbookText: '',
    factsText: '', foreshadowsText: '', prevSceneSummary: '', rules: '',
    rollingSummary: '', recentSummaries: [], timelineEvents: [], futureChapters: [],
    constraints: [], pleasureContext: '', styleRules: '', perspective: 'third',
  });
  assert.ok(instruction.includes('跨句'), '写作指令必须点名跨句拆分形态（否则模型不知"不是X。是Y。"同罪）');
  assert.ok(instruction.includes('段首') && instruction.includes('35%'), '段首主语轮换必须量化（写审同源：检测 35% soft/45% 驳回）');
});

test('V0.98.14 审校 3.14 结构层核查补漏：跨句偈语与纯描写推进场景过渡', async () => {
  const { auditInstruction } = await import('../server/engine/prompts.js');
  const audit = auditInstruction({
    bookTitle: 'X', chapterTitle: '夜哨', chapterText: '正文',
    factsText: '', foreshadowsText: '', characterStates: '', contract: '',
  });
  assert.ok(audit.includes('跨句'), '审校必须核查跨句拆分偈语（写审同源）');
  assert.ok(audit.includes('纯环境'), '审校必须核查连续纯描写段推进场景过渡（高赞"大段描写+一句对话+大段描写"）');
});

// ---------- V0.98.14 精修复验驱动：起手/收束词表裂口 + 母题词表扩充 + 章首句跨章逐字 ----------

test('V0.98.14 起手式词表裂口补全：天还没亮/天未全亮 形态可命中（ch32 逐字重 ch28 必须本地可抓）', async () => {
  const { detectChapterOpenerTic } = await import('../server/engine/rules.js');
  const hit = detectChapterOpenerTic('天还没亮透，露水把营门前的土路浸成一片潮气。',
    [{ idx: 28, text: '天还没亮透，露水压着草尖。' }, { idx: 25, text: '天未全亮，营帐间只有脚步声。' }]);
  assert.ok(hit.some(i => i.severity === 'medium'), '「天还没亮透」逐字重出必须被章首起手式防线抓到（此前"还没/全"插入形态全盲，ch28/ch32 实证）');
});

test('V0.98.14 收束词表新增收怀贴物族：收进怀里贴着X 跨章复读 → medium（四章成族实证）', async () => {
  const { detectChapterEndingTic } = await import('../server/engine/rules.js');
  const hits = detectChapterEndingTic('他把工册收进怀里，贴着那截断绳头，慢慢走了。',
    [{ idx: 19, text: '她把册页收进怀里，贴着衣袖，转身走了。' }]);
  assert.ok(hits.some(i => i.severity === 'medium'), '「收进怀里，贴着X」是 ch19/20/23/24 四章成族的收束套子，必须报');
});

test('V0.98.14 母题词表扩充：指腹、蹲族变体（蹲得住/能蹲住/蹲住了）、小动作变体组可计数', async () => {
  const { detectMotifRepetition } = await import('../server/engine/rules.js');
  const hit = detectMotifRepetition('他用指腹按住绳头。指腹被磨得发白，他换掌根压住。指腹又滑开。');
  assert.ok(hit.some(i => i.severity === 'medium' && i.issue.includes('指腹')), '「指腹」×3 是动作库过窄实证（ch27 六连），必须报');
  const squat = detectMotifRepetition('他蹲下看绳。能蹲住了，他才继续。蹲在沟边的石头上歇了歇。');
  assert.ok(squat.some(i => i.severity === 'medium' && i.issue.includes('蹲')), '蹲族变体（蹲下/蹲住/蹲在）合并计数（此前漏"蹲得住/能蹲住"）');
});

test('V0.98.14 章首句跨章逐字高权重：首句 ≥6 字与前章首句重合即报（12 字窗盲区补齐）', async () => {
  const { detectOpenerRepeat } = await import('../server/engine/rules.js');
  const hit = detectOpenerRepeat('天还没亮透，营门的木梆敲了两下。', [{ idx: 28, text: '天还没亮透，露水压着草尖。' }]);
  assert.ok(hit.some(i => i.severity === 'medium'), '短首句逐字重合（≥6 字）必须报——12 字整句窗漏掉 ch32/ch28 式短首句');
  const miss = detectOpenerRepeat('晨光从云缝里漏下来，木梆敲了两下。', [{ idx: 28, text: '天还没亮透，露水压着草尖。' }]);
  assert.equal(miss.length, 0, '不同首句不误报');
});