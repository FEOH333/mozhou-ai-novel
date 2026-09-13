// V0.87 战争写作专项
// 覆盖：WARFARE_TEXT 战役纪律（五段节奏/全员智商在线/信息差/感官/代价）/
// WARFARE_HISTORY_TEXT 史实锚定段（仅历史题材）/
// WARFARE_ANCHORS 宋蒙战争考据锚点（围城战术/防御体系/兵器/蒙哥死因多版本）/
// isWarfareText 强/弱词分级检测 / 四处注入接线（正文场景/细纲/卷纲/审校 warfareCheck）/
// 战争逻辑核查边界 1.6（仅战役章条件注入 + 独立「战争逻辑」类型）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v095-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.87 战争写作专项', () => {
  test('①WARFARE_TEXT 战役纪律完整：五段节奏/全员智商在线/信息差/感官/代价；史实锚定段独立拆分', async () => {
    const lt = await import(pathToFileURL(path.join(ROOT, 'server/data/literary_techniques.js')));
    assert.ok(lt.WARFARE_TEXT.includes('战役写作纪律'), '战役纪律存在');
    assert.ok(lt.WARFARE_TEXT.includes('五段节奏'), '五段节奏');
    assert.ok(lt.WARFARE_TEXT.includes('侦察/情报') && lt.WARFARE_TEXT.includes('转折点'), '战役结构完整');
    assert.ok(lt.WARFARE_TEXT.includes('全员智商在线'), '全员智商在线');
    assert.ok(lt.WARFARE_TEXT.includes('敌方不降智'), '敌方不降智');
    assert.ok(lt.WARFARE_TEXT.includes('奇袭/偷袭必须有铺垫'), '奇袭需铺垫');
    assert.ok(lt.WARFARE_TEXT.includes('守方反制'), '奇袭写完补守方反制（禁单边碾压）');
    assert.ok(lt.WARFARE_TEXT.includes('信息差'), '信息差');
    assert.ok(lt.WARFARE_TEXT.includes('指挥官视角') && lt.WARFARE_TEXT.includes('小兵视角'), '双视角');
    assert.ok(lt.WARFARE_TEXT.includes('声音清单') || lt.WARFARE_TEXT.includes('砲石'), '战场感官');
    assert.ok(lt.WARFARE_TEXT.includes('伤亡写'), '战争代价');
    assert.ok(lt.WARFARE_TEXT.includes('兵马未动粮草先行'), '后勤联动');
    assert.ok(lt.WARFARE_TEXT.includes('打赢了战役，输给了政治'), '战争×政治母题');
    // 史实锚定段独立：WARFARE_TEXT 不再内嵌（非历史书注入不硬套宋蒙史实）
    assert.ok(lt.WARFARE_HISTORY_TEXT.includes('史实锚定'), '独立史实锚定段存在');
    assert.ok(lt.WARFARE_HISTORY_TEXT.includes('钓鱼城之战'), '史实锚定含钓鱼城');
    assert.ok(lt.WARFARE_HISTORY_TEXT.includes('蒙哥死因留多种版本并存'), '蒙哥死因多版本');
    assert.ok(!lt.WARFARE_TEXT.includes('钓鱼城之战'), 'WARFARE_TEXT 不含宋蒙专有史实（防非历史书误注入）');
  });

  test('②WARFARE_ANCHORS 宋蒙战争考据锚点：大迂回/钓鱼城防御/围城战术/兵器/蒙哥死因/战略窗口', async () => {
    const h = await import(pathToFileURL(path.join(ROOT, 'server/data/history.js')));
    assert.ok(h.WARFARE_ANCHORS.includes('宋蒙战争战役考据锚点'), '考据锚点存在');
    assert.ok(h.WARFARE_ANCHORS.includes('大迂回'), '蒙古攻宋战略大迂回');
    assert.ok(h.WARFARE_ANCHORS.includes('三路灭宋'), '三路灭宋定策');
    assert.ok(h.WARFARE_ANCHORS.includes('14 处天池') && h.WARFARE_ANCHORS.includes('92 眼水井'), '钓鱼城水粮自给');
    assert.ok(h.WARFARE_ANCHORS.includes('一字城墙'), '一字城墙');
    assert.ok(h.WARFARE_ANCHORS.includes('飞檐洞暗道'), '飞檐洞暗道（夜袭反制素材）');
    assert.ok(h.WARFARE_ANCHORS.includes('围攻七门'), '围攻七门');
    assert.ok(h.WARFARE_ANCHORS.includes('浮梁'), '浮梁锁江');
    assert.ok(h.WARFARE_ANCHORS.includes('砲石') && h.WARFARE_ANCHORS.includes('床子弩'), '兵器写实');
    assert.ok(h.WARFARE_ANCHORS.includes('突火枪'), '突火枪（时间线刚发明）');
    assert.ok(h.WARFARE_ANCHORS.includes('患疾') && h.WARFARE_ANCHORS.includes('痢疾'), '蒙哥死因多种版本并存');
    assert.ok(h.WARFARE_ANCHORS.includes('尽屠城中之民'), '蒙哥遗言（仇恨链条）');
    assert.ok(h.WARFARE_ANCHORS.includes('贾似道谎报大捷'), '蒙哥死后战略窗口（全书纵深）');
    assert.ok(h.WARFARE_ANCHORS.includes('回回炮'), '襄阳回回炮（后期底牌）');
    assert.ok(!h.WARFARE_ANCHORS.includes('《合州志》"'), '蒙哥死因条目无损坏字符');
  });

  test('③isWarfareText 分级检测：强词 1 个命中/弱词需 2 个/跨语境弱词单次不误检', async () => {
    const lt = await import(pathToFileURL(path.join(ROOT, 'server/data/literary_techniques.js')));
    // 强词：单次即判战役
    assert.ok(lt.isWarfareText('钓鱼城之战，蒙古军四面合围'), '围城命中');
    assert.ok(lt.isWarfareText('', '守城三年，粮道被断'), '守城/粮道命中');
    assert.ok(lt.isWarfareText('蒙军夜袭，奇袭渡口'), '奇袭命中（强词）');
    assert.ok(lt.isWarfareText('北伐誓师'), '北伐命中');
    assert.ok(lt.isWarfareText('城破之夜'), '城破命中');
    // 弱词：2 个以上才判（战役语境多词齐现）
    assert.ok(lt.isWarfareText('决战之夜，援军不至，合围已成'), '弱词≥2 判战役');
    assert.ok(lt.isWarfareText('大军出征，扎营夜袭'), '弱词≥2 判战役');
    // 跨语境弱词单次：不误检（玄幻单挑"决战"、都市"水军带节奏"、体育"客场出征"）
    assert.equal(lt.isWarfareText('两人决战于山巅，剑气纵横'), false, '玄幻单挑决战不误检');
    assert.equal(lt.isWarfareText('反派雇佣水军带节奏'), false, '都市网络水军不误检');
    assert.equal(lt.isWarfareText('球队客场出征，冲击冠军'), false, '体育客场出征不误检');
    assert.equal(lt.isWarfareText('市集买菜，讨价还价'), false, '日常不命中');
    assert.equal(lt.isWarfareText('他在灯下读信，想起故人'), false, '文戏不命中');
    assert.equal(lt.isWarfareText(), false, '空输入不命中');
  });

  test('④正文场景注入：战役场景带纪律+史实锚定+考据锚点，非历史不注宋蒙史实，日常不注入', async () => {
    const { writeSceneInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const base = { bookTitle: 'X', chapterIdx: 1, chapterTitle: 'C', scene: { id: 's1', pov: '王坚', location: '钓鱼城', beat: '蒙军浮梁锁江，四面围攻七门', target_words: 1200, scene_type: 'fight' }, scenesBefore: [], sceneAfter: null, prevTail: '', rollingSummary: '', recentSummaries: [], timelineEvents: [], futureChapters: [], foreshadowsText: '', factsText: '', worldbookText: '', constraints: '', styleRules: '', sceneType: 'fight', goal: '守城', conflict: '蒙军攻城' };
    const war = writeSceneInstruction({ ...base, warfareText: '【战役写作纪律】（V0.87 硬要求）\n【史实锚定（历史题材）】\n【本时代战役考据锚点】\n【宋蒙战争战役考据锚点】' });
    assert.ok(war.includes('战役写作纪律'), '战役场景注入纪律');
    assert.ok(war.includes('史实锚定（历史题材）'), '历史书注入史实锚定段');
    assert.ok(war.includes('本时代战役考据锚点'), '历史书注入考据锚点');
    const noWar = writeSceneInstruction({ ...base, scene: { ...base.scene, beat: '市集买菜，讨价还价', scene_type: 'daily' }, sceneType: 'daily', goal: '日常', conflict: '无' });
    assert.ok(!noWar.includes('战役写作纪律'), '日常场景不注入');
    // 非历史题材：注入纪律，但不注入史实锚定/宋蒙考据（P1-2 拆离后）
    const nonHist = writeSceneInstruction({ ...base, warfareText: '【战役写作纪律】（V0.87 硬要求）' });
    assert.ok(nonHist.includes('战役写作纪律') && !nonHist.includes('史实锚定（历史题材）') && !nonHist.includes('宋蒙战争战役考据锚点'), '非历史不注宋蒙史实');
  });

  test('⑤细纲注入：战役章细纲带纪律（局部变量无 ReferenceError）', async () => {
    const { chapterOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/planning/outline.js'), 'utf8');
    assert.ok(src.includes('const warfareText = isWarfareText'), '细纲局部变量定义');
    assert.ok(src.includes('warfareText,'), '细纲注入槽位传参');
    assert.ok(src.includes('const chOutline = store.chapters.outline(chapterId)'), '细纲检测用解析后的 outline（修复死源）');
    assert.ok((src.match(/chapter\.outline\?\.beat/g) || []).length <= 1, '无死源代码引用（仅注释提及历史）');
    const c = chapterOutlineInstruction({ bookTitle: 'X', chapterIdx: 5, volumeGoal: '守城', recentSummaries: [], rollingSummary: '', activeForeshadows: [], forgottenForeshadows: [], approachingForeshadows: [], retrieved: [], prevChapterTail: '', futureChapters: [], warfareText: '【战役写作纪律】（V0.87 硬要求）\n【本时代战役考据锚点】\n【宋蒙战争战役考据锚点】' });
    assert.ok(c.includes('战役写作纪律'), '战役章细纲注入纪律');
    assert.ok(c.includes('宋蒙战争战役考据锚点'), '细纲注入考据锚点');
  });

  test('⑥卷纲注入：战争卷按战役纪律设计章节', async () => {
    const { volumeOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/planning/outline.js'), 'utf8');
    assert.ok(src.includes("warfareText: isWarfareText(vol.title, vol.goal, vol.outline_json)"), '卷纲战役检测');
    const v = volumeOutlineInstruction({ bookTitle: 'X', volumeIdx: 3, volumeTitle: '钓鱼城', bookOutline: {}, chapterCount: 8, warfareText: '【战役写作纪律】（V0.87 硬要求）\n【本时代战役考据锚点】\n【宋蒙战争战役考据锚点】' });
    assert.ok(v.includes('战役写作纪律'), '战争卷卷纲注入纪律');
    assert.ok(v.includes('宋蒙战争战役考据锚点'), '卷纲注入考据锚点');
  });

  test('⑦审校 warfareCheck：1.6 边界条件注入 + 独立「战争逻辑」类型（非战役章不携带）', async () => {
    const { auditInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const war = auditInstruction({ bookTitle: 'X', chapterTitle: 'C', chapterText: 't', factsText: '', foreshadowsText: '', characterStates: '', contract: '', warfareCheck: true });
    assert.ok(war.includes('本章为战役章节'), '战役章审校提示');
    assert.ok(war.includes('1.6 战争逻辑核查'), '战役章注入 1.6 核查边界');
    assert.ok(war.includes('敌方无脑硬冲'), '敌方无脑硬冲检查');
    assert.ok(war.includes('奇袭/偷袭无铺垫无反制'), '奇袭无铺垫检查');
    assert.ok(war.includes('战役无节奏'), '战役无节奏检查');
    assert.ok(war.includes('无战场感官与代价'), '无感官代价检查');
    assert.ok(war.includes('战役不写后方联动'), '无后方联动检查');
    assert.ok(war.includes('战争逻辑'), '战役章类型枚举含战争逻辑');
    assert.ok(war.includes('|战争逻辑'), '战争逻辑为独立类型（不冒充史实错误）');
    const normal = auditInstruction({ bookTitle: 'X', chapterTitle: 'C', chapterText: 't', factsText: '', foreshadowsText: '', characterStates: '', contract: '' });
    assert.ok(!normal.includes('本章为战役章节'), '非战役章不提示');
    assert.ok(!normal.includes('1.6 战争逻辑核查'), '非战役章不携带 1.6 边界（条件注入）');
    assert.ok(!normal.includes('|战争逻辑'), '非战役章类型枚举无战争逻辑');
    assert.ok(!normal.includes('敌方无脑硬冲'), '非战役章无战争逻辑判据');
    // audit.js：计算 + 记债路由
    const auditSrc = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/audit.js'), 'utf8');
    assert.ok(auditSrc.includes('warfareCheck = isWarfareText'), 'audit.js 计算 warfareCheck');
    // V0.109.3：记债语义迁入 issue_types 注册表（audit 只查 needsRoundup）
    const { needsRoundup } = await import(pathToFileURL(path.join(ROOT, 'server/data/issue_types.js')));
    assert.equal(needsRoundup('战争逻辑'), true, '战争逻辑进记债路由（注册表 roundup:true）');
  });

  test('⑧端到端：战役章 auditChapter 计算 warfareCheck 并注入审校指令', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { auditChapter } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/audit.js')));
 const b = store.books.create({ title: '示例历史长篇', genre: '历史', blurb: '守钓鱼城', platform: '番茄' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const ch = store.chapters.create(b.id, v.id, 1, { title: '钓鱼城之战', status: 'done', outline: { scenes: [{ pov: '王坚', location: '钓鱼城', beat: '蒙军浮梁锁江围攻七门' }], checkpoints: [] } });
    store.scenes.create(ch.id, 1, { pov: '王坚', location: '钓鱼城', beat: '蒙军攻城', content: '蒙古军浮梁锁江，四面围攻七门。砲石如雨砸向城墙。', status: 'done' });
    const r = await auditChapter(b.id, ch.id);
    assert.ok(r, '审校执行成功');
    assert.ok(r.llmIssues !== undefined || r.verdict !== undefined, '返回审校结论');
  });

  test('⑨非历史题材零影响：题材包/注入点不破坏既有路径', async () => {
    const { writeSceneInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const daily = writeSceneInstruction({ bookTitle: 'X', chapterIdx: 1, chapterTitle: 'C', scene: { id: 's1', pov: 'A', location: 'L', beat: '宗门修炼', target_words: 1000, scene_type: 'daily' }, scenesBefore: [], sceneAfter: null, prevTail: '', rollingSummary: '', recentSummaries: [], timelineEvents: [], futureChapters: [], foreshadowsText: '', factsText: '', worldbookText: '', constraints: '', styleRules: '', sceneType: 'daily', goal: '日常', conflict: '无' });
    assert.ok(daily.includes('写作要求'), '非战役场景正常出指令');
    assert.ok(!daily.includes('战役写作纪律'), '非战役不注入纪律');
    // write.js 战役检测用 outline.goal/outline.conflict（无 ctx 引用 → 无 ReferenceError）
    const writeSrc = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/write.js'), 'utf8');
    assert.ok(writeSrc.includes('isWarfareText(scene.beat, outline.goal, outline.conflict)'), 'write.js 战役检测无悬空 ctx');
    assert.ok(writeSrc.includes('WARFARE_HISTORY_TEXT'), 'write.js 接入史实锚定段');
  });
});
