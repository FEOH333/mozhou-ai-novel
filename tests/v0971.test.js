// tests/v0971.test.js —— V0.97.1 推流前二次精修根因防线
// 实证来源：《示例历史长篇》逐章二次精读：场景断句、物证过顺、数字报表化、写审口径缺项。
import './helper.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  detectSceneBoundaryFragments,
  detectEvidenceCertaintyStack,
  detectNumericDataDump,
  runLocalRules,
  runSceneContinuityRules,
} from '../server/engine/rules.js';
import { REDLINES } from '../server/data/redlines.js';
import { CONTINUITY_CRAFT_TEXT } from '../server/data/literary_techniques.js';
import { auditInstruction, writeSceneInstruction } from '../server/engine/prompts.js';
import { auditDatabase } from '../server/maintenance/doctor.js';
import { applyAnchoredTextPatch, resolveSupersededPatchFailures } from '../server/maintenance/patch-chain.js';
import { chapterOutlineQualityIssues } from '../server/engine/outline.js';

test('V0.97.1 场景边界：跨场景断句必须 high，完整换场不误报', () => {
  const broken = [
 { idx: 1, content: '陈七忽然止步。主角顺着他的目光看去——' },
    { idx: 2, content: '两枚靴印嵌在湿泥里。' },
    { idx: 3, content: '他看见了那只手——小小的' },
    { idx: 4, content: '，五指张开，攥着半块糖人。他没有' },
    { idx: 5, content: '动，只把呼吸压低。' },
  ];
  const issues = detectSceneBoundaryFragments(broken);
  assert.equal(issues.length, 3);
  assert.ok(issues.every(i => i.severity === 'high' && i.type === '事实矛盾'));
  assert.ok(runSceneContinuityRules(broken).some(i => i.issue.includes('断在场景边界')),
    '场景连续性总入口必须纳入断句检测');

  const clean = [
    { idx: 1, content: '陈七停下，把手按在刀柄上。' },
    { idx: 2, content: '天亮以后，他们沿着河沟继续往北。' },
  ];
  assert.equal(detectSceneBoundaryFragments(clean).length, 0);
});

test('V0.97.1 物证推理：自然痕迹连续给出唯一答案须触发质量门', () => {
  const overfit = [
    '靴印前掌深、后跟浅，只有连夜赶路的人才会这样落脚。',
    '竹管上的压痕与断绳严丝合缝，分毫不差。',
    '竹屑刻痕贴上旧图，折角恰好落在鸡爪滩。',
  ].join('\n');
  const issues = detectEvidenceCertaintyStack(overfit);
  assert.ok(issues.some(i => i.severity === 'medium' && i.issue.includes('唯一结论')));
  assert.ok(runLocalRules(overfit).some(i => i.issue.includes('唯一结论')),
    '章级本地质量门必须纳入物证过顺检测');

  const cautious = [
    '靴印前掌较深，可能是赶路，也可能只是背了重物。',
    '绳股相近，但营里同样的绳很多，单凭这一点不能认人。',
    '文书吏把两件东西分别封好，等巡哨记录回来再比。',
  ].join('\n');
  assert.equal(detectEvidenceCertaintyStack(cautious).length, 0);
});

test('V0.97.1 信息冗余：同段连续抛出五个以上数字单位为 medium', () => {
  assert.equal(REDLINES.numericTokensPerParagraphMax, 4, '数字段落上限必须由单一真源给出');
  const dump = '帐篷四十顶，马桩八排，火堆十五处，巡逻五路，每路三骑，约两百人。';
  const issues = detectNumericDataDump(dump);
  assert.ok(issues.some(i => i.severity === 'medium' && i.issue.includes('报表')));
  assert.ok(runLocalRules(dump).some(i => i.issue.includes('报表')));

 const useful = '沟口有三骑，左侧另伏两人。主角看清后才退。';
  assert.equal(detectNumericDataDump(useful).length, 0);
});

test('V0.97.1 写审同源：证据边界、能力权限、技术可信与对白情绪均明确注入', () => {
  for (const term of ['观察不等于结论', '权限来源', '技术机理', '对白目的']) {
    assert.ok(CONTINUITY_CRAFT_TEXT.includes(term), `纪律文本缺少：${term}`);
  }
  const write = writeSceneInstruction({
    bookTitle: '书', chapterIdx: 9, chapterTitle: '章',
 scene: { id: 's1', pov: '主角', location: '营', beat: '核对线索', target_words: 1000 },
    scenesBefore: [], sceneAfter: null, prevTail: '', worldbookText: '', factsText: '',
    foreshadowsText: '', rules: '', continuityCraft: CONTINUITY_CRAFT_TEXT,
  });
  assert.ok(write.includes('观察不等于结论'));
  assert.ok(write.includes('对白目的'));

  const audit = auditInstruction({
    bookTitle: '书', chapterTitle: '章', chapterText: '正文', factsText: '', foreshadowsText: '',
    characterStates: '', contract: '', continuityCraft: CONTINUITY_CRAFT_TEXT,
  });
  assert.ok(audit.includes('3.15'));
  assert.ok(audit.includes('物证') && audit.includes('权限') && audit.includes('技术机理'));
});

test('V0.97.1 doctor：只读全书体检必须报告场景断句与结构级 AI 味', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v0971-doctor-'));
  const dbPath = path.join(tmp, 'fixture.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT, genre TEXT);
    CREATE TABLE volumes (id TEXT PRIMARY KEY, book_id TEXT, idx INTEGER, title TEXT);
    CREATE TABLE chapters (id TEXT PRIMARY KEY, book_id TEXT, volume_id TEXT, idx INTEGER, title TEXT, status TEXT, word_count INTEGER, outline_json TEXT);
    CREATE TABLE scenes (id TEXT PRIMARY KEY, chapter_id TEXT, idx INTEGER, content TEXT);
  `);
  db.prepare('INSERT INTO books VALUES (?,?,?)').run('b1', '测试书', '历史');
  db.prepare('INSERT INTO volumes VALUES (?,?,?,?)').run('v1', 'b1', 1, '卷一');
  db.prepare('INSERT INTO chapters VALUES (?,?,?,?,?,?,?,?)').run('c1', 'b1', 'v1', 1, '章一', 'done', 20, '{}');
  db.prepare('INSERT INTO scenes VALUES (?,?,?,?)').run('s1', 'c1', 1, '他蹲下摸土。他又蹲下看草。走到沟口，他第三次蹲下——');
  db.prepare('INSERT INTO scenes VALUES (?,?,?,?)').run('s2', 'c1', 2, '两枚靴印落在泥里。');
  db.close();

  try {
    const report = auditDatabase(dbPath);
    const prose = report.books[0].checks.proseStructure;
    assert.equal(prose.ok, false);
    assert.ok(prose.boundaryFragments.some(x => x.chapterIdx === 1));
    const style = report.books[0].checks.styleQuality;
    assert.equal(style.ok, false);
    assert.ok(style.blocking.some(x => x.issue.includes('动作母题')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('V0.97.1 相似名分级：亲属、通用称呼和远隔出场不冒充同台撞名', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v0971-name-risk-'));
  const dbPath = path.join(tmp, 'fixture.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT, genre TEXT);
    CREATE TABLE volumes (id TEXT PRIMARY KEY, book_id TEXT, idx INTEGER, title TEXT);
    CREATE TABLE chapters (id TEXT PRIMARY KEY, book_id TEXT, volume_id TEXT, idx INTEGER, title TEXT, status TEXT, word_count INTEGER, outline_json TEXT);
    CREATE TABLE scenes (id TEXT PRIMARY KEY, chapter_id TEXT, idx INTEGER, content TEXT);
    CREATE TABLE characters (id TEXT PRIMARY KEY, book_id TEXT, name TEXT, card_json TEXT, first_chapter INTEGER, last_chapter INTEGER);
  `);
  db.prepare('INSERT INTO books VALUES (?,?,?)').run('b1', '测试书', '历史');
  db.prepare('INSERT INTO volumes VALUES (?,?,?,?)').run('v1', 'b1', 1, '卷一');
  db.prepare('INSERT INTO chapters VALUES (?,?,?,?,?,?,?,?)').run('c1', 'b1', 'v1', 1, '章一', 'done', 8, '{}');
  db.prepare('INSERT INTO scenes VALUES (?,?,?,?)').run('s1', 'c1', 1, '正文已经写完。');
  const add = db.prepare('INSERT INTO characters VALUES (?,?,?,?,?,?)');
  add.run('p1', 'b1', '沈砚', '{"role":"主角"}', 1, 20);
  add.run('p2', 'b1', '沈墨', '{"role":"主角的幼弟"}', 1, 5);
  add.run('p3', 'b1', '孙七', '{}', 2, 3);
  add.run('p4', 'b1', '孙锦', '{}', 8, 20);
  add.run('p5', 'b1', '老余', '{}', 20, 20);
  add.run('p6', 'b1', '老郑', '{}', 23, 23);
  db.close();
  try {
    const names = auditDatabase(dbPath).books[0].checks.similarNames;
    assert.equal(names.ok, true);
    assert.equal(names.pairs.length, 0);
    const reasons = new Set(names.ignored.map(x => x.ignoredBecause));
    assert.equal(names.ignored.length, 3, '三对近名都应落入 ignored；pairs 为空表示无高风险同台撞名');
    assert.ok(reasons.has('明确亲属'), `一字之差且卡面写明亲属时应记「明确亲属」，实得 ${JSON.stringify([...reasons])}`);
    assert.ok(reasons.has('通用称呼前缀'), `同姓且以「老」起首的通用称呼应记「通用称呼前缀」，实得 ${JSON.stringify([...reasons])}`);
    assert.ok([...reasons].some(r => /^出场相隔\d+章$/.test(r)), `相隔三章以上的近名应记「出场相隔N章」，实得 ${JSON.stringify([...reasons])}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('V0.97.1 精修补丁链：后续完整替换前补丁时二次运行仍幂等，断链仍失败', () => {
  const chained = resolveSupersededPatchFailures([
    { kind: 'failure', patch: { id: 'base', new: '中间版本完整场景' } },
    { kind: 'failure', patch: { id: 'expand', old: '中间版本完整场景', new: '扩写后的完整场景' } },
    { kind: 'already', patch: { id: 'polish', old: '前缀扩写后的完整场景后缀', new: '最终完整场景' } },
  ], { currentText: '最终完整场景' });
  assert.deepEqual(chained.unresolvedIndices, []);
  assert.deepEqual(chained.supersededIndices, [0, 1]);

  const partialPolish = resolveSupersededPatchFailures([
    { kind: 'failure', patch: { id: 'expand', new: '甲段。中间一句。乙段。' } },
    { kind: 'already', patch: { id: 'polish', old: '中间一句。', new: '改好的一句。' } },
  ], { currentText: '章首。甲段。改好的一句。乙段。章尾。' });
  assert.deepEqual(partialPolish.unresolvedIndices, []);

  const broken = resolveSupersededPatchFailures([
    { kind: 'failure', patch: { id: 'wrong', new: '从未被后续补丁消费的文本' } },
    { kind: 'already', patch: { id: 'other', old: '毫不相关的锚点', new: '当前正文' } },
  ]);
  assert.deepEqual(broken.unresolvedIndices, [0]);
});

test('V0.97.1 精修补丁链：后续待应用改名不得让已被覆盖的旧锚点假失败', () => {
  const entries = [
    {
      kind: 'failure',
      patch: { old: '旧长段', new: '短句马坤' },
    },
    {
      kind: 'failure',
      patch: { old: '短句马坤加尾', new: '这是已经落库的完整长段，其中先写马坤，后面仍写马坤，并且长度足够校验。' },
    },
    {
      kind: 'apply',
      patch: { old: '马坤', new: '郭川', replaceAll: true, expectedCount: 6 },
    },
  ];
  const resolved = resolveSupersededPatchFailures(entries, {
    currentText: '这是已经落库的完整长段，其中先写马坤，后面仍写马坤，并且长度足够校验。',
    projectedText: '这是已经落库的完整长段，其中先写郭川，后面仍写郭川，并且长度足够校验。',
  });
  assert.deepEqual(resolved.unresolvedIndices, []);
  assert.deepEqual(resolved.supersededIndices, [0, 1]);
});

test('V0.97.1 新角色命名：与点名册只差一字的近名必须在细纲阶段硬拦截', () => {
  const outline = {
    scenes: [{
      id: 's1', target_words: 1500,
      beat: '【新设定:马武——本地老斥候】带主角进入河谷，负责辨路。',
    }],
  };
  const issues = chapterOutlineQualityIssues(outline, {
    chapterLength: 1500,
    existingCharacterNames: ['马坤', '文书吏'],
  });
  assert.ok(issues.some(issue => issue.hard && issue.issue.includes('马武') && issue.issue.includes('马坤')));

  const clean = chapterOutlineQualityIssues({
    scenes: [{ id: 's1', target_words: 1500, beat: '【新设定:郭川——本地老斥候】带主角进入河谷。' }],
  }, { chapterLength: 1500, existingCharacterNames: ['马坤', '文书吏'] });
  assert.equal(clean.some(issue => issue.hard && issue.issue.includes('近名')), false);
});

test('V0.97.1 角色改名补丁：按场景已知次数全量替换且二次运行幂等', () => {
  const patch = { old: '马坤', new: '郭川', replaceAll: true, expectedCount: 2 };
  const first = applyAnchoredTextPatch('马坤在前。马坤回头。', patch);
  assert.equal(first.kind, 'apply');
  assert.equal(first.text, '郭川在前。郭川回头。');
  assert.equal(applyAnchoredTextPatch(first.text, patch).kind, 'already');
  assert.equal(applyAnchoredTextPatch('马坤独行。', patch).kind, 'failure');
});
