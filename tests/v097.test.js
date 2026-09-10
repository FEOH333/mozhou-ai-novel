// tests/v097.test.js —— V0.97 推流前精读实证防线（《示例历史长篇》34 章精读台账落地）
// 台账：
// 覆盖：跨章复读窗 15→12 / 章内复读 / 章首起手式 / 章末收束查重 / 对白偈语配额 /
//      裸对话连发 / 他她段首密度 / 章名查重 / 时间承诺断链 / 时代红线扩词+大人白名单 /
//      王坚登场窗 / 细节一致与章法轮换纪律写审同源 / doctor 残章+相似名体检 / 非历史零影响
import './helper.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  detectCrossChapterRepeats, detectInChapterRepeats, detectChapterOpenerTic,
  detectChapterEndingTic, detectAphorismQuota, detectBareDialogueRuns,
  detectPronounParaDensity, detectTitleDuplication, detectTimePromiseBreak,
  runLocalRules,
} from '../server/engine/rules.js';
import { REDLINES } from '../server/data/redlines.js';
import { eraRedLineCheck } from '../server/engine/history.js';
import { historicalFigureTimelineIssues } from '../server/engine/historical_guardrails.js';
import { HISTORICAL_FIGURES } from '../server/data/history.js';
import { CONTINUITY_CRAFT_TEXT } from '../server/data/literary_techniques.js';
import { writeSceneInstruction, auditInstruction, reviseInstruction } from '../server/engine/prompts.js';

// ---------- 1. 跨章逐字复读窗口 15→12（S5 实证：ch18/19「油灯捻得极低」14 字、ch33/34「收网的计时」13 字漏检） ----------
test('V0.97 跨章复读：归一化 ≥12 字整句逐字重复即检出', () => {
  assert.equal(REDLINES.crossRepeatMinChars, 12, '跨章复读窗阈值应降为 12（单一真源）');
  const prev = [{ idx: 18, text: '帐里没点炭。油灯捻得极低，光只照亮膝前一圈。他翻开册子。' }];
  const cur = '他坐下来。油灯捻得极低，光只照亮膝前一圈。册页边角卷着。';
  const issues = detectCrossChapterRepeats(cur, prev);
  assert.ok(issues.some(i => i.severity === 'medium' && i.quote.includes('油灯捻得极低')), '14 字逐字句应命中');
  const cur13 = '旗杆立住了。收网的计时，从这根旗杆算起。';
  const issues13 = detectCrossChapterRepeats(cur13, [{ idx: 33, text: '他望着江面。收网的计时，从这根旗杆算起。' }]);
  assert.ok(issues13.length >= 1, '13 字逐字句应命中');
});

test('V0.97 跨章复读：不足 12 字的正常承接不误报', () => {
  const prev = [{ idx: 1, text: '他把碗放下了。夜色沉下来。' }];
  const cur = '他把碗放下了。天亮了，营里响起号角。';
  assert.equal(detectCrossChapterRepeats(cur, prev).length, 0, '短句正常承接不拦');
});

// ---------- 2. 章内逐字复读（S6 实证：ch6「没有再把一次猜中当成本事」×2、ch16 句内复读、ch25「他没有碰那卷文书」×2） ----------
test('V0.97 章内复读：同一长句章内逐字出现两次 → medium', () => {
  const text = '他收起纸片，没有再把一次猜中当成本事。……中间隔着三段别的正文，长度撑开一点让段落结构成形。……他合上工册，没有再把一次猜中当成本事。';
  const issues = detectInChapterRepeats(text);
  assert.ok(issues.some(i => i.severity === 'medium' && i.quote.includes('没有再把一次猜中')), '章内逐字复读应命中');
});

test('V0.97 章内复读：段内 ≥6 字短语重复 → low（ch16「沿着墙线的走向」句内两刷形态）', () => {
  const text = '他贴着墙根走，沿着墙线的走向数到第七棵，又折回来沿着墙线的走向复核了一遍。';
  const issues = detectInChapterRepeats(text);
  assert.ok(issues.some(i => i.severity === 'low' && i.issue.includes('沿着墙线的走向')), '段内短语复读应报 low');
});

test('V0.97 章内复读：正常文本不误报', () => {
  const text = '雨停的时候，她推开了窗。远处有船靠岸，缆绳落在青石板上，发出沉闷的响声。\n她转头看了他一眼："走吧。"\n他沉默地跟了上去。';
  assert.equal(detectInChapterRepeats(text).length, 0);
});

// ---------- 3. 章首起手式跨章同质（S1 实证：14+ 章「天没亮+雾露」开篇） ----------
test('V0.97 起手式：前两章同用「天没亮」族开篇，本章再用 → medium', () => {
  const prevHeads = [
    { idx: 8, text: '天没亮，山雾压着营地的火把。' },
    { idx: 10, text: '天刚亮，露水打湿了校场的旗。' },
    { idx: 11, text: '他被人声吵醒，帐外已经开锅。' },
  ];
  const issues = detectChapterOpenerTic('天未亮，雾气从江面爬上来。', prevHeads);
  assert.ok(issues.some(i => i.severity === 'medium' && i.issue.includes('起手式')), '同族起手式跨章同质应命中');
});

test('V0.97 起手式：仅一章前科或本章起手不同族 → 不报', () => {
  const onePrev = [{ idx: 8, text: '天没亮，山雾压着营地。' }];
  assert.equal(detectChapterOpenerTic('天未亮，雾气从江面爬上来。', onePrev).length, 0, '仅一章前科不构成套路');
  const twoPrev = [{ idx: 8, text: '天没亮，山雾压着营地。' }, { idx: 9, text: '天刚亮，号角响了。' }];
 assert.equal(detectChapterOpenerTic('号角吹了第三遍，主角才把绳结打完。', twoPrev).length, 0, '动作起手不命中');
});

// ---------- 4. 章末收束意象/句式跨章查重（S2/S3/S4 实证：灰烟明灭 10 章、昱儿哥公式 4 章、写进工册 5 章） ----------
test('V0.97 章末收束：前章「灰烟一明一灭」收束，本章再收 → medium', () => {
  const prevTails = [{ idx: 18, text: '远处的灰烟立在那里，底部一明一灭。' }];
  const text = '他看了一会儿，回帐去了。\n灰烟底部那点暗红，一明一灭。';
  const issues = detectChapterEndingTic(text, prevTails);
  assert.ok(issues.some(i => i.severity === 'medium' && i.issue.includes('收束')), '收束意象跨章复读应命中');
});

test('V0.97 章末收束：亡亲报备式与记账式收束查重（通用句式，不含书内专名）', () => {
  const text1 = '他望着北边的山影。\n爹，我把他带到了。';
  const prev1 = [{ idx: 5, text: '风停了。\n昱儿，哥回来了。' }];
  assert.ok(detectChapterEndingTic(text1, prev1).length >= 1, '亡亲报备公式跨章应命中');
  const text2 = '他吹了灯。\n他把今天的事写进工册。';
  const prev2 = [{ idx: 10, text: '夜里很静。\n这一笔也记进了册子。' }];
  assert.ok(detectChapterEndingTic(text2, prev2).length >= 1, '记账式收束跨章应命中');
});

test('V0.97 章末收束：本章收束与前章不同 → 不报', () => {
  const prevTails = [{ idx: 18, text: '远处的灰烟立在那里，底部一明一灭。' }];
  const text = '陈七冒雨进棚，斗笠往下滴水：「雨里踩出来的印子，不止我们的。」';
  assert.equal(detectChapterEndingTic(text, prevTails).length, 0);
});

// ---------- 5. 对白偈语配额（S7 实证：导师格言腔全员同嗓；与审校 3.11「全章≥3」同源） ----------
test('V0.97 对白偈语：对白内「不是X是Y / X有X的Y」全章 ≥3 → medium', () => {
 const text = '老兵拍拍他：「刀不是刀，是手臂。」\n主角点头。\n「弓有弓的性子，急不得。」\n旁边有人笑：「当兵不是受罪，是吃饭。」';
  const issues = detectAphorismQuota(text);
  assert.ok(issues.some(i => i.severity === 'medium' && i.issue.includes('偈语')), '对白偈语超配额应命中');
  const two = '「刀不是刀，是手臂。」\n他嗯了一声。\n「弓有弓的性子。」';
  assert.ok(!detectAphorismQuota(two).some(i => i.severity === 'medium'), '两处不升级');
});

test('V0.97 叙述偈语：「有的要X，有的要Y」叙述者总结句 → low', () => {
  const text = '路口乱成一团。有的要躲，有的要守，喊声混在一起。';
  const issues = detectAphorismQuota(text);
  assert.ok(issues.some(i => i.severity === 'low' && i.issue.includes('有的要')), '叙述偈语应变体补全');
});

// ---------- 6. 裸对话连发（C5/D2 实证：ch5 八句裸问答） ----------
test('V0.97 裸对话：连续 ≥4 行纯引号对白零动作锚点 → low，≥6 → medium', () => {
  const five = '“走了？”\n“走了。”\n“去哪？”\n“北边。”\n“还回来么？”\n他望着路口，很久没有说话。';
  const issues5 = detectBareDialogueRuns(five);
  assert.ok(issues5.some(i => i.severity === 'low'), '5 连发应报 low');
  const seven = '“走了？”\n“走了。”\n“去哪？”\n“北边。”\n“还回来么？”\n“不知道。”\n“哦。”';
  const issues7 = detectBareDialogueRuns(seven);
  assert.ok(issues7.some(i => i.severity === 'medium'), '7 连发应报 medium');
});

test('V0.97 裸对话：有动作锚点的对白不误报', () => {
  const text = '“走了？”他把绳头咬断。\n“走了。”\n赵四往门外看了一眼。“去哪？”\n“北边。”\n“还回来么？”\n他摇摇头，把门带上。';
  assert.equal(detectBareDialogueRuns(text).length, 0);
});

// ---------- 7. 他她段首密度软信号（S14 实证：ch4 段首 37%，全书均 8-27%） ----------
test('V0.97 他她段首密度：≥35% 报 low，正常密度不报', () => {
 const denseParas = Array.from({ length: 12 }, (_, i) => (i < 5 ? '他' : '主角') + `把第${i}件事做完，回头又看了一眼。`);
  const issues = detectPronounParaDensity(denseParas.join('\n'));
  assert.ok(issues.some(i => i.severity === 'low' && i.issue.includes('段首')), '高密度应报软信号');
 const okParas = Array.from({ length: 12 }, (_, i) => (i < 3 ? '他' : '主角') + `把第${i}件事做完，回头又看了一眼。`);
  assert.equal(detectPronounParaDensity(okParas.join('\n')).length, 0, '25% 不报');
});

// ---------- 8. 章名全书查重（ch34《北望》与 ch8 完全重名实证） ----------
test('V0.97 章名查重：全书已有同名章 → medium', () => {
  const issues = detectTitleDuplication('北望', ['归骨', '北望', '狼烟']);
  assert.ok(issues.some(i => i.severity === 'medium' && i.issue.includes('同名')), '完全同名应拦');
  assert.equal(detectTitleDuplication('狼烟', ['归骨', '北望']).length, 0);
});

// ---------- 9. 时间承诺断链（S8 实证：ch16 末「明日卯时」→ ch17 跨年；ch31 末「明日探」→ ch32 跨年） ----------
test('V0.97 时间承诺断链：前章末「明日」承诺 + 本章跨年 → medium', () => {
  const issues = detectTimePromiseBreak({ prevTailText: '文书吏把马缰丢给他：“明日卯时，西校场找独耳陈。”', year: 1249, prevYear: 1248 });
  assert.ok(issues.some(i => i.type === '时间线冲突' && i.severity === 'medium'), '承诺跨年断链应命中');
  assert.equal(detectTimePromiseBreak({ prevTailText: '“明日卯时，西校场。”', year: 1248, prevYear: 1248 }).length, 0, '同年不拦');
  assert.equal(detectTimePromiseBreak({ prevTailText: '他睡下了。', year: 1249, prevYear: 1248 }).length, 0, '无承诺不拦');
});

// ---------- 10. 时代红线扩词 + 大人白名单（S12 实证：烟杆/官爷/竹简/面料漏检；ch30/31 成人义「大人」误报） ----------
test('V0.97 时代红线扩词：烟杆/旱烟/官爷/竹简/面料命中', () => {
  assert.ok(eraRedLineCheck('他摸出烟杆，在鞋底上磕了磕。').some(h => h.term === '烟杆'), '烟杆');
  assert.ok(eraRedLineCheck('老汉捧着旱烟袋锅子。').some(h => h.term === '旱烟' || h.term === '烟袋'), '旱烟/烟袋');
  assert.ok(eraRedLineCheck('官爷饶命。').some(h => h.term === '官爷'), '官爷');
  assert.ok(eraRedLineCheck('名册写在竹简上。').some(h => h.term === '竹简'), '竹简');
  assert.ok(eraRedLineCheck('驮袋里露出半截面料。').some(h => h.term === '面料'), '面料');
});

test('V0.97 大人白名单：成人名词义放行，称呼官员仍拦（v090 回归）', () => {
  assert.ok(!eraRedLineCheck('孩子吓得不敢动，一个大人把它拿走了。').some(h => h.term === '大人'), '一个大人把它拿走=成人义');
  assert.ok(!eraRedLineCheck('娃娃骑在大人脖子上看灯。').some(h => h.term === '大人'), '骑在大人脖子上=成人义');
  assert.ok(eraRedLineCheck('小人参见大人，请大人为小人做主。').some(h => h.term === '大人'), '称呼官员仍拦');
});

// ---------- 11. 王坚登场窗（firstYear 语义=登场年 1242 余玠部将，1254 是任合州知州年） ----------
test('V0.97 王坚 firstYear=1242：1253 年正文登场不再误报，贾似道 1253 仍拦', () => {
  const wang = HISTORICAL_FIGURES.find(f => f.name === '王坚');
  assert.equal(wang.firstYear, 1242, '王坚 firstYear 应为 1242（余玠部将可登场）');
  const okIssues = historicalFigureTimelineIssues({
 bookTitle: '示例历史长篇', genre: '历史', year: 1253,
    chapterText: '王坚率军到营中视察。', figures: HISTORICAL_FIGURES,
  });
  assert.ok(!okIssues.some(i => i.issue.includes('王坚')), '1253 年王坚在场合法');
  const badIssues = historicalFigureTimelineIssues({
 bookTitle: '示例历史长篇', genre: '历史', year: 1253,
    chapterText: '阿蛮啐了一口：狗日的贾似道。', figures: HISTORICAL_FIGURES,
  });
  assert.ok(badIssues.some(i => i.issue.includes('贾似道') && i.severity === 'high'), '贾似道 1253 仍拦');
});

// ---------- 12. 细节一致与章法轮换纪律：写审同源注入 ----------
test('V0.97 CONTINUITY_CRAFT_TEXT 注入写作/修订/审校三处', () => {
  assert.ok(CONTINUITY_CRAFT_TEXT.includes('细节一致与章法轮换'), '纪律文本存在');
  const writeInstr = writeSceneInstruction({
    bookTitle: '书', chapterIdx: 1, chapterTitle: '章',
 scene: { id: 's1', pov: '主角', location: '营', beat: '写场景', target_words: 1000 },
    scenesBefore: [], sceneAfter: null, prevTail: '', worldbookText: '', factsText: '',
    foreshadowsText: '', rules: '', continuityCraft: CONTINUITY_CRAFT_TEXT,
  });
  assert.ok(writeInstr.includes('细节一致与章法轮换'), '写作指令注入');
  const reviseInstr = reviseInstruction({
    bookTitle: '书', chapterTitle: '章',
    scene: { target_words: 1000, content: '原文', beat: '节拍' },
    issues: [{ severity: 'medium', type: '事实矛盾', issue: 'i', quote: 'q', fix: 'f' }],
    extraNote: '', styleRules: '', continuityCraft: CONTINUITY_CRAFT_TEXT,
  });
  assert.ok(reviseInstr.includes('细节一致与章法轮换'), '修订指令注入');
  const auditInstr = auditInstruction({
    bookTitle: '书', chapterTitle: '章', chapterText: '正文',
    factsText: '', foreshadowsText: '', characterStates: '', contract: '',
    continuityCraft: CONTINUITY_CRAFT_TEXT,
  });
  assert.ok(auditInstr.includes('3.13'), '审校边界 3.13 道具/状态一致性');
  assert.ok(auditInstr.includes('3.14'), '审校边界 3.14 剧情复读/章法');
  assert.ok(auditInstr.includes('细节一致与章法轮换'), '审校注入同一纪律文本（写审同源）');
});

test('V0.97 写作指令量化红线补：对白偈语/起手式/章内复讲口径', () => {
  const instr = writeSceneInstruction({
    bookTitle: '书', chapterIdx: 1, chapterTitle: '章',
 scene: { id: 's1', pov: '主角', location: '营', beat: '写场景', target_words: 1000 },
    scenesBefore: [], sceneAfter: null, prevTail: '', worldbookText: '', factsText: '',
    foreshadowsText: '', rules: '',
  });
  assert.ok(instr.includes('偈语'), '量化红线含对白偈语上限');
  assert.ok(instr.includes('起手式') || instr.includes('收束'), '量化红线含起手式/收束轮换口径');
});

// ---------- 13. 非历史题材零影响回归 ----------
test('V0.97 非历史零影响：干净文本新检测器全静默', () => {
  const clean = [
    '雨停的时候，她推开了窗。远处有船靠岸，缆绳落在青石板上，发出沉闷的响声。',
    '她转头看了他一眼："走吧。"',
    '楼梯很窄，他沉默地跟了上去。',
    '码头上人不多，几个脚夫蹲在缆桩边上吃饭。',
    '船老大跳下跳板，把缆绳在桩上绕了两圈。',
    '"今天潮快。"他说。',
    '她点点头，先一步上了跳板。',
    '风从江面过来，带着腥味。',
    '镇子在身后退远，青瓦上还挂着水。',
    '船篷里很暗，只有舱口一方亮光。',
    '舱角堆着麻袋，她找了个角落坐下，把包袱抱在膝上。',
    '船身一晃，离了岸。',
  ].join('\n');
  assert.equal(detectInChapterRepeats(clean).length, 0, '章内复读');
  assert.equal(detectChapterOpenerTic(clean, []).length, 0, '起手式无前章');
  assert.equal(detectChapterEndingTic(clean, []).length, 0, '收束无前章');
  assert.equal(detectAphorismQuota(clean).length, 0, '偈语');
  assert.equal(detectBareDialogueRuns(clean).length, 0, '裸对话');
  assert.equal(detectPronounParaDensity(clean).length, 0, '段首密度');
  assert.equal(detectTimePromiseBreak({ prevTailText: clean, year: 1249, prevYear: 1248 }).length, 0, '无承诺跨年不拦');
  const local = runLocalRules(clean);
  assert.ok(!local.some(i => /起手式|收束|偈语|裸对话|段首|逐字出现/.test(i.issue)), 'runLocalRules 不新增误报');
});

// ---------- 14. doctor 体检：drafted 滞留残章 + 角色相似名 ----------
test('V0.97 doctor：drafted 残章与相似名清查', async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v097-doctor-'));
  const DB_PATH = path.join(TMP, 'fixture.db');
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT, genre TEXT, settings_json TEXT);
    CREATE TABLE volumes (id TEXT PRIMARY KEY, book_id TEXT, idx INTEGER, title TEXT);
    CREATE TABLE chapters (id TEXT PRIMARY KEY, book_id TEXT, volume_id TEXT, idx INTEGER, title TEXT, status TEXT, word_count INTEGER, outline_json TEXT);
    CREATE TABLE scenes (id TEXT PRIMARY KEY, chapter_id TEXT, idx INTEGER, content TEXT, target_words INTEGER, status TEXT);
    CREATE TABLE characters (id TEXT PRIMARY KEY, book_id TEXT, name TEXT, card_json TEXT);
  `);
  const text = '他站在断道口，把半截粮旗系上旗杆。北风卷着灰。';
  db.prepare('INSERT INTO books VALUES (?,?,?,?)').run('b1', '体检书', '历史', '{}');
  db.prepare('INSERT INTO volumes VALUES (?,?,?,?)').run('v1', 'b1', 1, '卷一');
  db.prepare('INSERT INTO chapters VALUES (?,?,?,?,?,?,?,?)').run('c1', 'b1', 'v1', 1, '完章', 'done', text.replace(/\s/g, '').length, '{}');
  db.prepare('INSERT INTO chapters VALUES (?,?,?,?,?,?,?,?)').run('c2', 'b1', 'v1', 2, '残章', 'drafted', text.replace(/\s/g, '').length, '{}');
  db.prepare('INSERT INTO scenes VALUES (?,?,?,?,?,?)').run('s1', 'c1', 1, text, 1000, 'done');
  db.prepare('INSERT INTO scenes VALUES (?,?,?,?,?,?)').run('s2', 'c2', 1, text, 1000, 'drafted');
  const addChar = db.prepare('INSERT INTO characters VALUES (?,?,?,?)');
 for (const [id, name] of [['p1', '潘九'], ['p2', '潘六斗'], ['p3', '田二'], ['p4', '田三'], ['p5', '陈七'], ['p6', '主角']]) addChar.run(id, 'b1', name, '{}');
  db.close();
  const { auditDatabase } = await import('../server/maintenance/doctor.js');
  const report = auditDatabase(DB_PATH);
  fs.rmSync(TMP, { recursive: true, force: true });
  const checks = report.books[0].checks;
  assert.equal(checks.draftedStall.ok, false, 'drafted 有正文的残章应报出');
  assert.ok(checks.draftedStall.stalled.some(c => c.title === '残章'), '列出残章');
  assert.equal(checks.similarNames.ok, false, '相似名应报出');
  const pairText = JSON.stringify(checks.similarNames.pairs);
  assert.ok(pairText.includes('潘九') && pairText.includes('潘六斗'), '同姓数字名撞车');
  assert.ok(pairText.includes('田二') && pairText.includes('田三'), '一字差撞名');
});

// ---------- 15. 场景门禁：drafted 残章不适用整章目标字数下限（ch34 残章精修实证：目标 4700 现状 973 被 REWRITE_TOO_SHORT 误拦） ----------
test('V0.97 场景门禁：残章允许同量级最小修订，完成章仍守目标字数下限', async () => {
  const store = await import('../server/db/store.js');
  const { applyValidatedSceneRewrite } = await import('../server/engine/polish.js');
  const book = store.books.create({ title: '残章修订书', genre: '历史', settings: {} });
  const vol = store.volumes.create(book.id, 1, { title: '卷' });
  const mk = (idx, title, status, proseSeed, tpl) => {
    const ch = store.chapters.create(book.id, vol.id, idx, { title, outline: {} });
    // 多样化句式拼 ~800 字（避开复读红线），远低于 4 场景目标合计 4700
    const parts = [];
    for (let i = 0; i < 40; i++) parts.push(tpl(proseSeed, i));
    const prose = parts.join('。');
    store.scenes.create(ch.id, 1, { content: prose, targetWords: 1200, status: 'drafted' });
    store.scenes.create(ch.id, 2, { content: '', targetWords: 1200, status: 'planned' });
    store.scenes.create(ch.id, 3, { content: '', targetWords: 1200, status: 'planned' });
    store.scenes.create(ch.id, 4, { content: '', targetWords: 1100, status: 'planned' });
    store.chapters.update(ch.id, { status });
    return { ch, prose };
  };
  // 残章（drafted）：同量级最小修订应通过
  const a = mk(1, '残章', 'drafted', '他站在断道口', (s, i) => `${s}，第${i}回北风卷着灰扑上来，碎石在靴底咯了一声`);
  const sc1 = store.scenes.list(a.ch.id)[0];
  const r1 = applyValidatedSceneRewrite(book.id, sc1.id, a.prose.replace('北风卷着灰', '南风卷着灰'));
  assert.equal(r1.ok, true, `残章最小修订应通过门禁（实际 ${r1.code} ${r1.message}）`);
  // 完成章（done，无结算指纹）：同形态仍被目标字数下限拦下（保护不回归）
  const b = mk(2, '完章', 'done', '她坐在城楼上', (s, i) => `${s}看第${i}队戍卒换岗，灯笼沿女墙一路点过去`);
  const sc2 = store.scenes.list(b.ch.id)[0];
  const r2 = applyValidatedSceneRewrite(book.id, sc2.id, b.prose.replace('看第1队戍卒换岗', '看第一队戍卒换岗'));
  assert.equal(r2.ok, false, '完成章低于目标字数下限仍应拒绝');
  assert.equal(r2.code, 'REWRITE_TOO_SHORT');
});
