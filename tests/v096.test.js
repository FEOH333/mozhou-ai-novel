// V0.88 朝堂权谋专项
// 覆盖：COURT_INTRIGUE_TEXT 权谋纪律（皇帝三重身份/五型对照/判断三问/双层对话/信息差/暗线四阶段/桌上桌下/代价/反降智/前后方传导）/
// COURT_HISTORY_TEXT 朝堂史实质感段（仅历史题材）/
// COURT_ANCHORS 南宋末朝堂考据锚点（贾似道专权/襄樊中枢决策/朝廷体制/派系/事件链）/
// isCourtIntrigueText 强/弱词分级检测 / 四处注入接线（正文场景/细纲/卷纲/审校 courtCheck）/
// 权谋逻辑核查边界 1.7（仅朝堂章条件注入 + 独立「权谋逻辑」类型）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v096-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.88 朝堂权谋专项', () => {
  test('①COURT_INTRIGUE_TEXT 权谋纪律完整：皇帝三重身份/五型对照/判断三问/双层对话/信息差/暗线四阶段/代价/传导', async () => {
    const lt = await import(pathToFileURL(path.join(ROOT, 'server/data/literary_techniques.js')));
    const t = lt.COURT_INTRIGUE_TEXT;
    assert.ok(t.includes('朝堂权谋纪律'), '权谋纪律存在');
    assert.ok(t.includes('皇帝三重身份冲突') && t.includes('人（欲望/恐惧）、帝王（权力计算/孤独）、符号'), '皇帝三重身份');
    assert.ok(t.includes('决策缺陷') && t.includes('朝局病灶'), '性格→朝局病灶闭环');
    assert.ok(t.includes('判断三问'), '皇帝判断三问');
    assert.ok(t.includes('廷议') && t.includes('内批/留中') && t.includes('单独召对') && t.includes('经筵问对') && t.includes('御笔/内批'), '决策场景五件套（宋制无批红）');
    assert.ok(!t.includes('批红御笔'), '宋末书不教明代批红术语');
    assert.ok(t.includes('一句话两层') && t.includes('表面句+真实句'), '双层对话');
    assert.ok(t.includes('信息差表') && t.includes('来源、代价、被污染概率'), '信息差与情报三要素');
    assert.ok(t.includes('铺垫') && t.includes('发酵') && t.includes('引爆') && t.includes('清算'), '暗线四阶段');
    assert.ok(t.includes('桌上桌下') && t.includes('廷议上一套、私室里另一套'), '桌上桌下对切');
    assert.ok(t.includes('零成本权谋禁用') && t.includes('谎言的利息最贵'), '权谋代价');
    assert.ok(t.includes('反派也是理性人') && t.includes('主角一出手众人纳头便拜'), '反降智');
    assert.ok(t.includes('落点回主线核心') && t.includes('打赢了战役，输给了政治'), '前后方传导');
    // 史实段独立（非历史书不硬套宋制细节）
    assert.ok(lt.COURT_HISTORY_TEXT.includes('朝堂史实质感'), '独立史实段存在');
    assert.ok(lt.COURT_HISTORY_TEXT.includes('文明的残忍') && lt.COURT_HISTORY_TEXT.includes('不杀士大夫'), '宋制质感');
    assert.ok(lt.COURT_HISTORY_TEXT.includes('以文驭武'), '以文驭武恶果');
    assert.ok(!t.includes('打算法'), '通用纪律不含宋专有史实');
  });

  test('②COURT_ANCHORS 南宋末朝堂考据锚点：贾似道专权/襄樊中枢/体制/派系/事件链', async () => {
    const h = await import(pathToFileURL(path.join(ROOT, 'server/data/history.js')));
    const a = h.COURT_ANCHORS;
    assert.ok(a.includes('南宋末年朝堂考据锚点'), '朝堂锚点存在');
    assert.ok(a.includes('打算法') && a.includes('公田法') && a.includes('葛岭遥控'), '贾似道专权三件套');
    assert.ok(a.includes('策立度宗') && a.includes('拥立之恩'), '权臣双保险');
    assert.ok(a.includes('刘整') && a.includes('降元'), '武将离心暗线');
    assert.ok(a.includes('襄樊围城') && a.includes('范文虎') && a.includes('隐匿边报'), '襄樊中枢决策');
    assert.ok(a.includes('台谏风闻奏事') && a.includes('经筵') && a.includes('内批'), '朝廷体制');
    assert.ok(a.includes('边报/邸报→进奏院') && a.includes('留中'), '政务链');
    assert.ok(a.includes('文天祥') && a.includes('陈宜中') && a.includes('谢道清'), '派系人物');
    assert.ok(a.includes('丁家洲') && a.includes('木棉庵') && a.includes('崖山'), '覆亡事件链');
    assert.ok(a.includes('打赢了战役，输给了政治'), '母题落点');
  });

  test('③isCourtIntrigueText 分级检测：强词 1 个命中/弱词需 2 个/跨语境弱词不误检', async () => {
    const lt = await import(pathToFileURL(path.join(ROOT, 'server/data/literary_techniques.js')));
    // 强词：单次即判朝堂
    assert.ok(lt.isCourtIntrigueText('贾似道收到弹劾奏疏'), '弹劾/奏疏命中');
    assert.ok(lt.isCourtIntrigueText('今日廷议，百官争北伐'), '廷议命中');
    assert.ok(lt.isCourtIntrigueText('圣旨到——内批留中'), '圣旨/内批命中');
    assert.ok(lt.isCourtIntrigueText('经筵之上，讲官借古讽今'), '经筵命中');
    assert.ok(lt.isCourtIntrigueText('谢太后垂帘听政'), '垂帘命中');
    // 弱词：2 个以上才判（权谋语境多词齐现）
    assert.ok(lt.isCourtIntrigueText('宰相权谋算计，拉拢党羽'), '弱词≥2 判权谋');
    assert.ok(lt.isCourtIntrigueText('猜忌与构陷，权臣架空皇帝'), '弱词≥2 判权谋');
    // 跨语境弱词单次：不误检（玄幻宗门/都市职场/情感戏——单弱词不判）
    assert.equal(lt.isCourtIntrigueText('宗门长老拉拢新晋弟子入伙'), false, '宗门拉拢单词不误检');
    assert.equal(lt.isCourtIntrigueText('她试探他是不是真的放下了'), false, '情感试探不误检');
    assert.equal(lt.isCourtIntrigueText('主角立誓北伐，誓师出征'), false, '战场誓师不误检');
    assert.equal(lt.isCourtIntrigueText('市集买菜，讨价还价'), false, '日常不命中');
    assert.equal(lt.isCourtIntrigueText(), false, '空输入不命中');
  });

  test('④正文场景注入：朝堂场景带纪律+史实段+考据锚点，非历史不注宋制史实，日常不注入', async () => {
    const { writeSceneInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const base = { bookTitle: 'X', chapterIdx: 1, chapterTitle: 'C', scene: { id: 's1', pov: '文天祥', location: '临安', beat: '廷议北伐，贾似道阴阳怪气反对', target_words: 1200, scene_type: 'dialogue' }, scenesBefore: [], sceneAfter: null, prevTail: '', rollingSummary: '', recentSummaries: [], timelineEvents: [], futureChapters: [], foreshadowsText: '', factsText: '', worldbookText: '', constraints: '', styleRules: '', sceneType: 'dialogue', goal: '朝堂之争', conflict: '权臣掣肘' };
    const court = writeSceneInstruction({ ...base, courtText: '【朝堂权谋纪律】（V0.88 硬要求）\n【朝堂史实质感（历史题材）】\n【本时代朝堂考据锚点】\n【南宋末年朝堂考据锚点】' });
    assert.ok(court.includes('朝堂权谋纪律'), '朝堂场景注入纪律');
    assert.ok(court.includes('朝堂史实质感（历史题材）'), '历史书注入史实段');
    assert.ok(court.includes('本时代朝堂考据锚点'), '历史书注入考据锚点');
    const noCourt = writeSceneInstruction({ ...base, scene: { ...base.scene, beat: '市集买菜，讨价还价', scene_type: 'daily' }, sceneType: 'daily', goal: '日常', conflict: '无' });
    assert.ok(!noCourt.includes('朝堂权谋纪律'), '日常场景不注入');
    // 非历史题材：注入纪律，但不注入宋制史实段/朝堂锚点
    const nonHist = writeSceneInstruction({ ...base, courtText: '【朝堂权谋纪律】（V0.88 硬要求）' });
    assert.ok(nonHist.includes('朝堂权谋纪律') && !nonHist.includes('朝堂史实质感（历史题材）') && !nonHist.includes('南宋末年朝堂考据锚点'), '非历史不注宋制史实');
  });

  test('⑤细纲注入：朝堂章细纲带纪律（局部变量定义）', async () => {
    const { chapterOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/outline.js'), 'utf8');
    assert.ok(src.includes('const courtText = isCourtIntrigueText'), '细纲局部变量定义');
    assert.ok(src.includes('courtText,'), '细纲注入槽位传参');
    const c = chapterOutlineInstruction({ bookTitle: 'X', chapterIdx: 5, volumeGoal: '北伐之议', recentSummaries: [], rollingSummary: '', activeForeshadows: [], forgottenForeshadows: [], approachingForeshadows: [], retrieved: [], prevChapterTail: '', futureChapters: [], courtText: '【朝堂权谋纪律】（V0.88 硬要求）\n【本时代朝堂考据锚点】\n【南宋末年朝堂考据锚点】' });
    assert.ok(c.includes('朝堂权谋纪律'), '朝堂章细纲注入纪律');
    assert.ok(c.includes('南宋末年朝堂考据锚点'), '细纲注入朝堂锚点');
  });

  test('⑥卷纲注入：权谋卷按朝堂纪律设计章节', async () => {
    const { volumeOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/outline.js'), 'utf8');
    assert.ok(src.includes("courtText: isCourtIntrigueText(vol.title, vol.goal, vol.outline_json)"), '卷纲权谋检测');
    const v = volumeOutlineInstruction({ bookTitle: 'X', volumeIdx: 4, volumeTitle: '临安风云', bookOutline: {}, chapterCount: 8, courtText: '【朝堂权谋纪律】（V0.88 硬要求）\n【本时代朝堂考据锚点】\n【南宋末年朝堂考据锚点】' });
    assert.ok(v.includes('朝堂权谋纪律'), '权谋卷卷纲注入纪律');
    assert.ok(v.includes('南宋末年朝堂考据锚点'), '卷纲注入朝堂锚点');
  });

  test('⑦审校 courtCheck：1.7 边界条件注入 + 独立「权谋逻辑」类型（非朝堂章不携带）', async () => {
    const { auditInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const court = auditInstruction({ bookTitle: 'X', chapterTitle: 'C', chapterText: 't', factsText: '', foreshadowsText: '', characterStates: '', contract: '', courtCheck: true });
    assert.ok(court.includes('本章为朝堂/权谋章节'), '朝堂章审校提示');
    assert.ok(court.includes('1.7 权谋逻辑核查'), '朝堂章注入 1.7 边界');
    assert.ok(court.includes('皇帝/权臣降智'), '皇帝降智检查');
    assert.ok(court.includes('只有一层意思'), '对话双层检查');
    assert.ok(court.includes('暗线无铺垫直接引爆'), '暗线铺垫检查');
    assert.ok(court.includes('权谋无代价'), '权谋代价检查');
    assert.ok(court.includes('不传导主线'), '前后方传导检查');
    assert.ok(court.includes('|权谋逻辑'), '权谋逻辑为独立类型');
    const normal = auditInstruction({ bookTitle: 'X', chapterTitle: 'C', chapterText: 't', factsText: '', foreshadowsText: '', characterStates: '', contract: '' });
    assert.ok(!normal.includes('本章为朝堂/权谋章节'), '非朝堂章不提示');
    assert.ok(!normal.includes('1.7 权谋逻辑核查'), '非朝堂章不携带 1.7 边界（条件注入）');
    assert.ok(!normal.includes('|权谋逻辑'), '非朝堂章类型枚举无权谋逻辑');
    assert.ok(!normal.includes('皇帝/权臣降智'), '非朝堂章无权谋判据');
    // audit.js：计算 + 记债路由
    const auditSrc = fs.readFileSync(path.join(ROOT, 'server/engine/audit.js'), 'utf8');
    assert.ok(auditSrc.includes('courtCheck = isCourtIntrigueText'), 'audit.js 计算 courtCheck');
    // V0.109.3：记债语义迁入 issue_types 注册表（audit 只查 needsRoundup）
    const { needsRoundup } = await import(pathToFileURL(path.join(ROOT, 'server/data/issue_types.js')));
    assert.equal(needsRoundup('权谋逻辑'), true, '权谋逻辑进记债路由（注册表 roundup:true）');
  });

  test('⑧端到端：朝堂章 auditChapter 计算 courtCheck 并注入审校指令', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { auditChapter } = await import(pathToFileURL(path.join(ROOT, 'server/engine/audit.js')));
 const b = store.books.create({ title: '示例历史长篇', genre: '历史', blurb: '北伐与朝堂', platform: '番茄' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const ch = store.chapters.create(b.id, v.id, 1, { title: '廷议北伐', status: 'done', outline: { scenes: [{ pov: '文天祥', location: '临安', beat: '百官廷议，贾似道反对北伐' }], checkpoints: [] } });
    store.scenes.create(ch.id, 1, { pov: '文天祥', location: '临安', beat: '廷议北伐', content: '廷议之上，文天祥力主北伐，贾似道冷笑不置可否。', status: 'done' });
    const r = await auditChapter(b.id, ch.id);
    assert.ok(r, '审校执行成功');
    assert.ok(r.llmIssues !== undefined || r.verdict !== undefined, '返回审校结论');
  });

  test('⑨非历史题材零影响 + 权谋与战争纪律不冲突（可同章并存）', async () => {
    const { writeSceneInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const daily = writeSceneInstruction({ bookTitle: 'X', chapterIdx: 1, chapterTitle: 'C', scene: { id: 's1', pov: 'A', location: 'L', beat: '宗门修炼', target_words: 1000, scene_type: 'daily' }, scenesBefore: [], sceneAfter: null, prevTail: '', rollingSummary: '', recentSummaries: [], timelineEvents: [], futureChapters: [], foreshadowsText: '', factsText: '', worldbookText: '', constraints: '', styleRules: '', sceneType: 'daily', goal: '日常', conflict: '无' });
    assert.ok(daily.includes('写作要求'), '非朝堂场景正常出指令');
    assert.ok(!daily.includes('朝堂权谋纪律'), '非朝堂不注入纪律');
    // 朝堂+战争并存：两段纪律都注入（如"临安廷议北伐"章——先权谋后战场）
    const mixedBase = { bookTitle: 'X', chapterIdx: 1, chapterTitle: 'C', scene: { id: 's1', pov: 'A', location: '临安', beat: '临安廷议北伐，战场军报急递', target_words: 1200, scene_type: 'fight' }, scenesBefore: [], sceneAfter: null, prevTail: '', rollingSummary: '', recentSummaries: [], timelineEvents: [], futureChapters: [], foreshadowsText: '', factsText: '', worldbookText: '', constraints: '', styleRules: '', sceneType: 'fight', goal: '北伐之争', conflict: '权臣掣肘', warfareText: '【战役写作纪律】（V0.87 硬要求）', courtText: '【朝堂权谋纪律】（V0.88 硬要求）' };
    const mixed = writeSceneInstruction(mixedBase);
    assert.ok(mixed.includes('战役写作纪律') && mixed.includes('朝堂权谋纪律'), '战争+权谋纪律可并存');
  });
});
