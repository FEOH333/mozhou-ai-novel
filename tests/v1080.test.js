// V0.108.0 测试：人物活性工艺——番茄作家课三篇（千人一面/纸片人/工具人）融入
// 缺口：backstory/motive_root/web（card_json 新键）、反派三件（rival/agenda/no_retreat/stance）、
// 配角独立目标、生活体感、出场密度检测、审校 3.16 人物活性核查（写审同源）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import './helper.js';

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const load = async f => import(pathToFileURL(path.join(ROOT, f)));

// ---------- ① 纪律常量单一真源 ----------

test('V0.108: CHARACTER_VITALITY_TEXT 三要素齐全且与既有纪律互斥声明', async () => {
  const { CHARACTER_VITALITY_TEXT, DIALOGUE_VOICE_TEXT } = await load('server/data/literary_techniques.js');
  assert.ok(CHARACTER_VITALITY_TEXT.includes('生活体感'), '须含生活体感条');
  assert.ok(CHARACTER_VITALITY_TEXT.includes('退不了'), '须含反派退不了的理由');
  assert.ok(CHARACTER_VITALITY_TEXT.includes('局部正确'), '须含局部正确');
  assert.ok(CHARACTER_VITALITY_TEXT.includes('独立目标'), '须含配角独立目标');
  assert.ok(CHARACTER_VITALITY_TEXT.includes('一场景至多 1 处'), '生活体感须量化');
  // 互斥分工声明在常量上方 JSDoc（不进模板文本，省注入 token）
  const src = read('server/data/literary_techniques.js');
  assert.ok(src.includes('管"行动逻辑层"'), 'JSDoc 须声明行动逻辑层分工');
  assert.ok(!CHARACTER_VITALITY_TEXT.includes('一人一腔'), '不重复 DIALOGUE_VOICE 的台词要求（互斥）');
 assert.ok(!CHARACTER_VITALITY_TEXT.includes('本作') && !CHARACTER_VITALITY_TEXT.includes('钓鱼城'), '纪律文本不含具体书名/地名（铁律）');
  assert.ok(DIALOGUE_VOICE_TEXT.length > 0, '既有纪律不动');
});

// ---------- ② characterCardsText 新键注入 ----------

test('V0.108: characterCardsText 注入 backstory/motive_root/web 与对手三件', async () => {
  const store = await load('server/db/store.js');
  const { characterCardsText } = await load('server/engine/narrative/characters.js');
  const b = store.books.create({ title: 'T108', genre: '玄幻', blurb: 'x' });
  store.characters.create(b.id, {
    name: '沈锐', personality: '谨慎多疑', goal: '收回财权',
    card: { backstory: '幼年家变被过继', motive_root: '怕再一无所有', web: '欠周大一条命' },
  });
  store.characters.create(b.id, {
    name: '赵霸', personality: '狠戾', goal: '压服四镇',
    card: { rival: true, agenda: '成为执刀人', no_retreat: '停手即旧案反噬', stance: '乱世先集权' },
  });
  const text = characterCardsText(b.id, { names: ['沈锐', '赵霸'], limit: 3 });
  assert.ok(text.includes('性格：谨慎多疑（成因：幼年家变被过继）'), 'backstory 并入性格行');
  assert.ok(text.includes('目标：收回财权（因为怕再一无所有，非要不可）'), 'motive_root 并入目标行');
  assert.ok(text.includes('欠周大一条命'), 'web 并入关系行');
  assert.ok(text.includes('他的立场'), '对手三件注入');
  assert.ok(text.includes('退路：无——停手即旧案反噬'), '退不了的理由注入');
  // 无新键角色零污染
  store.characters.create(b.id, { name: '路人甲', personality: '老实', goal: '活着' });
  const plain = characterCardsText(b.id, { names: ['路人甲'], limit: 1 });
  assert.ok(!plain.includes('成因') && !plain.includes('他的立场'), '无新键的角色卡保持原形态');
});

// ---------- ③ rivalCharactersInScene 条件检测 ----------

test('V0.108: rivalCharactersInScene 按 rival 标记 + 场景命中检测', async () => {
  const store = await load('server/db/store.js');
  const { rivalCharactersInScene } = await load('server/engine/narrative/characters.js');
  const b = store.books.create({ title: 'T108b', genre: '玄幻', blurb: 'x' });
  store.characters.create(b.id, { name: '赵霸', card: { rival: true } });
  store.characters.create(b.id, { name: '张三', card: {} });
 assert.deepEqual(rivalCharactersInScene(b.id, '赵霸上门对峙', '主角'), ['赵霸'], 'beat 命中 rival');
 assert.deepEqual(rivalCharactersInScene(b.id, '张三送信', '主角'), [], '非 rival 零命中');
  assert.deepEqual(rivalCharactersInScene(b.id, '日常', '赵霸'), ['赵霸'], 'POV 命中 rival');
});

// ---------- ④ 正文指令条件注入 ----------

test('V0.108: writeSceneInstruction 生活体感恒注入 + 对手在场追加反派纪律', async () => {
  const { writeSceneInstruction } = await load('server/engine/prompts.js');
 const base = { bookTitle: 'T', chapterIdx: 5, scene: { id: 's1', pov: '主角', beat: 'x' }, scenesBefore: [] };
  const plain = writeSceneInstruction(base);
  assert.ok(plain.includes('【生活体感】'), '生活体感句恒注入');
  assert.ok(!plain.includes('【对手在场】'), '无对手不注入反派块（防膨胀）');
  const withRival = writeSceneInstruction({ ...base, rivalNames: ['权臣'] });
  assert.ok(withRival.includes('【对手在场】权臣'), '对手在场注入反派纪律');
  assert.ok(withRival.includes('不是针对主角'), '反派行动逻辑要求在场');
});

test('V0.108: write.js 传 rivalNames（源码接线断言）', () => {
  const src = read('server/engine/pipeline/write.js');
  assert.ok(src.includes('const rivalNames = rivalCharactersInScene('), 'writeScene 应检测对手出场');
  assert.ok(src.includes('rivalNames, // V0.108'), '检测结果应传入指令');
});

// ---------- ⑤ 生成指令含新字段 ----------

test('V0.108: 三处生成指令含人物活性新字段', async () => {
  const settingsSrc = read('server/engine/planning/settings.js');
  assert.ok(settingsSrc.includes('"backstory"') && settingsSrc.includes('"motive_root"'), '设定指令 characters 字段含新键');
  assert.ok(settingsSrc.includes('"agenda"') && settingsSrc.includes('"no_retreat"') && settingsSrc.includes('"stance"'), '设定指令含对手三件');
  assert.ok(settingsSrc.includes('rival: c.rival === true'), '建卡处写入 rival 标记');
  const promptsSrc = read('server/engine/prompts.js');
  assert.ok(promptsSrc.includes('【对手设计】'), 'cast 设计含对手段');
  assert.ok(promptsSrc.includes('多边关系'), 'cast 设计含多边关系');
  assert.ok(promptsSrc.includes('退不了的理由'), '书纲弧光段含反派三件');
  assert.ok(promptsSrc.includes('【人物行动逻辑（V0.108）】'), '细纲含人物行动逻辑块');
  assert.ok(promptsSrc.includes('每章新增具名角色/实体 ≤2'), '细纲含出场密度约束（写审同源）');
});

// ---------- ⑥ 密度检测（写审同源阈值） ----------

test('V0.108: newCharacterDensityIssues 开篇期 medium/常规 low/正常零报', async () => {
  const { newCharacterDensityIssues } = await load('server/engine/quality/rules.js');
  assert.equal(newCharacterDensityIssues({ newEntityCount: 2, chapterIdx: 5 }).length, 0, '开篇期 2 个零报（指令 ≤2）');
  const mid = newCharacterDensityIssues({ newEntityCount: 3, chapterIdx: 5 });
  assert.equal(mid.length, 1);
  assert.equal(mid[0].severity, 'medium', '开篇期 ≥3 判罚（指令 2 的 N+1）');
  assert.equal(newCharacterDensityIssues({ newEntityCount: 3, chapterIdx: 30 }).length, 0, '常规章 3 个零报');
  const late = newCharacterDensityIssues({ newEntityCount: 4, chapterIdx: 30 });
  assert.equal(late[0].severity, 'low', '常规章 ≥4 软提示');
  assert.equal(newCharacterDensityIssues({ newEntityCount: 0, chapterIdx: 0 }).length, 0, '零新增零报');
});

test('V0.108: audit.js 挂载密度检测（数据源 pendingEntities 按章计数）', () => {
  const src = read('server/engine/pipeline/audit.js');
  assert.ok(src.includes('newCharacterDensityIssues'), 'localIssues 应挂载密度检测');
  assert.ok(src.includes('source_chapter) === Number(chapter.idx)'), '按当章计数');
});

// ---------- ⑦ 审校 3.16 人物活性核查（写审同源） ----------

test('V0.108: 审校 3.16 反派 medium/配角 low 分级', async () => {
  const { auditInstruction } = await load('server/engine/prompts.js');
  const s = auditInstruction({ bookTitle: 'T', chapterTitle: 'C', chapterText: 'x' });
  assert.ok(s.includes('3.16 人物活性核查'), '审校须含 3.16');
  assert.ok(s.includes('无脑针对主角'), '反派无脑判定形态须点名');
  assert.ok(/对手\/反派的行动无法从其立场[\s\S]*?→ medium「角色矛盾」/.test(s), '反派判 medium');
  assert.ok(/纯粹为推动主角剧情而存在[\s\S]*?→ low「角色矛盾」/.test(s), '配角工具人判 low（防误报）');
});

test('V0.108: 卷审人设漂移核对条', async () => {
  const { volumeReviewInstruction } = await load('server/engine/prompts.js');
  const s = volumeReviewInstruction({ bookTitle: 'T', volumeIdx: 2, volumeTitle: 'V' });
  assert.ok(s.includes('人设漂移核对'), '卷审须含人设漂移条');
  assert.ok(s.includes('P1 character 工单'), '漂移给 P1 character 工单');
});

// ---------- ⑧ 回填脚本（幂等/只填空默认 dry-run） ----------

test('V0.108: 回填脚本默认 dry-run + --apply + 只填空（源码断言）', () => {
  const src = read('server/maintenance/backfill-character-vitality-v108.js');
  assert.ok(src.includes("process.argv.includes('--apply')"), '默认 dry-run');
  assert.ok(src.includes('store.backup'), '应用前自动备份');
  assert.ok(src.includes('store.transaction'), '事务化写入');
  assert.ok(src.includes('if (value && !nextCard[key])'), '只填空不覆盖已有键');
  assert.ok(src.includes("tier === 'protagonist' || tier === 'major'"), '范围限定 protagonist/major（龙套不补）');
});

// ---------- ⑨ 非历史题材零影响 ----------

test('V0.108: 人物活性全链无题材门控（通用能力）', async () => {
  const { CHARACTER_VITALITY_TEXT } = await load('server/data/literary_techniques.js');
  assert.ok(!CHARACTER_VITALITY_TEXT.includes('南宋') && !CHARACTER_VITALITY_TEXT.includes('蒙古'), '纪律文本无历史专属词');
  const { newCharacterDensityIssues } = await load('server/engine/quality/rules.js');
  assert.equal(newCharacterDensityIssues({ newEntityCount: 3, chapterIdx: 5, openingChapters: 20 })[0].severity, 'medium', '密度检测全题材同尺');
});

test('V0.108: doctor characterVitality 观察面（只读，恒 ok）', async () => {
  const doctorSrc = read('server/maintenance/doctor.js');
  assert.ok(doctorSrc.includes('function checkCharacterVitality'), 'doctor 应含人物活性观察函数');
  assert.ok(doctorSrc.includes('characterVitality: checkCharacterVitality'), '观察面应挂进 auditBook checks');

  // 观察面必须能对任意库给出「protagonist/major 的 backstory 回填率」，
  // 且恒 ok=true（只读度量、不拦截）。用正式 schema 建临时库验证，不依赖既有作品。
  const { DatabaseSync } = await import('node:sqlite');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1080-vitality-'));
  try {
    const db = new DatabaseSync(path.join(dir, 'sample.db'));
    db.exec(fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8'));
    const now = Date.now();
    db.prepare(`INSERT INTO books (id,title,genre,blurb,platform,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run('bk-sample', '人物活性观察测试', '玄幻', '', '通用', now, now);
    const insert = db.prepare(`INSERT INTO characters
      (id,book_id,name,tier,deceased,card_json,created_at) VALUES (?,?,?,?,?,?,?)`);
    // 主角与主要角色全部回填 backstory → 期望 100%
    insert.run('c1', 'bk-sample', '甲', 'protagonist', 0,
      JSON.stringify({ backstory: '来历', motive_root: '动机' }), now);
    insert.run('c2', 'bk-sample', '乙', 'major', 0, JSON.stringify({ backstory: '来历' }), now);
    insert.run('c3', 'bk-sample', '丙', 'minor', 0, '{}', now);
    db.close();

    const { auditDatabase } = await import('../server/maintenance/doctor.js');
    const report = auditDatabase(path.join(dir, 'sample.db'));
    const book = report.books?.find?.(b => b.title === '人物活性观察测试') || report.books?.[0];
    const vitality = book?.checks?.characterVitality;
    assert.ok(vitality, '体检报告应含 characterVitality');
    assert.ok(vitality.ok === true, '观察面恒 ok=true，不拦截');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  }
});
