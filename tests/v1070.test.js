// V0.107.0 测试：章卷命名工艺 + 分章科学化 + 章名核对闸
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1070-'));
process.env.NOVEL_NO_OPEN = '1';

test('V0.107: TITLE_CRAFT_TEXT / VOLUME_TITLE_CRAFT_TEXT 单一真源与防漂移', async () => {
  const { TITLE_CRAFT_TEXT, VOLUME_TITLE_CRAFT_TEXT } = await import('../server/data/literary_techniques.js');
  assert.ok(TITLE_CRAFT_TEXT.includes('句式族轮换'), '章名工艺须含句式族轮换');
  assert.ok(TITLE_CRAFT_TEXT.includes('半遮不剧透'), '章名工艺须含半遮不剧透');
  assert.ok(TITLE_CRAFT_TEXT.includes('事件承诺必须兑现'), '章名工艺须含事件承诺兑现（写审同源）');
  assert.ok(VOLUME_TITLE_CRAFT_TEXT.includes('意象化'), '卷名工艺须含意象化要求');
  // 防漂移：prompts.js 引用合并常量，不再残留 V0.73 内嵌字符串
  const promptsSrc = fs.readFileSync(path.join(process.cwd(), 'server/engine/prompts.js'), 'utf8');
  assert.ok(promptsSrc.includes('TITLE_CRAFT_TEXT') && promptsSrc.includes('VOLUME_TITLE_CRAFT_TEXT'), 'prompts 须引用合并常量');
  assert.ok(!promptsSrc.includes('V0.73 文学性要求'), 'V0.73 内嵌命名文本应全部替换为单一真源');
});

test('V0.107: titleShapeOf 句式族分类', async () => {
  const rules = await import('../server/engine/rules.js');
  assert.equal(rules.titleShapeOf('军报'), 'terse', '2-3 字为极简名词族');
  assert.equal(rules.titleShapeOf('十人一绳'), 'four', '4 字为四字格族');
  assert.equal(rules.titleShapeOf('第一次选择'), 'mid', '5-6 字为中长族');
  assert.equal(rules.titleShapeOf('踏出这一步的门'), 'long', '≥7 字为长句族');
  assert.equal(rules.titleShapeOf('谁在墙外？'), 'question', '含问号为问句族');
  assert.equal(rules.titleShapeOf(''), null, '空标题无族');
});

test('V0.107: titleShapeStreakIssues 连排与占比检测', async () => {
  const rules = await import('../server/engine/rules.js');
  // 连排 3 报（soft）、连排 4 硬拦
  const soft = rules.titleShapeStreakIssues(['军报', '夜哨', '斥候']);
  assert.equal(soft.length, 1, '3 连排应报 1 条');
  assert.equal(soft[0].count, 3);
  assert.equal(soft[0].hard, false, '3 连排非硬拦');
  const hard = rules.titleShapeStreakIssues(['军报', '夜哨', '斥候', '狼烟']);
  assert.ok(hard.some(s => s.hard === true && s.count === 4), '4 连排应为硬项');
  // 多样化标题零问题
  const varied = ['风起', '山雨欲来', '第一次选择', '踏出这一步的门', '灯下旧刀', '谁在墙外？', '雨停', '旧约新签'];
  assert.equal(rules.titleShapeStreakIssues(varied).length, 0, '轮换句式零问题');
  // 占比 >70%（≥8 个才判）
  const mono8 = Array.from({ length: 8 }, (_, i) => ['军报', '山雨欲来'][i % 2]).map((t, i) => (i % 2 ? t : ['夜哨', '斥候', '狼烟'][i % 3]));
  assert.equal(rules.titleShapeStreakIssues(['军报', '山雨欲来', '夜哨', '探杆验墙', '斥候', '图上生根', '狼烟', '灯下看信']).length, 0, '8 章 4 字 5/8=62% 不报');
  const ratio = rules.titleShapeStreakIssues(['军报', '山雨', '夜哨', '晨雾', '斥候', '烽烟', '狼烟', '更鼓']);
  assert.ok(ratio.some(s => s.kind === 'ratio'), '全极简族占比 100% 应软报');
  assert.ok(mono8.length === 8);
});

test('V0.107: titleRootRepeatIssues 近词根查重', async () => {
  const rules = await import('../server/engine/rules.js');
  const issues = rules.titleRootRepeatIssues(['北渡', '鸡爪滩旧图', '北渡口', '灰烟深处']);
  assert.equal(issues.length, 1, '北渡/北渡口 同 2 字词根应报');
  assert.equal(issues[0].root, '北渡');
  assert.equal(rules.titleRootRepeatIssues(['北渡', '南归']).length, 0, '不同词根不报');
  // 共享首字但词根不同（北渡/北望）不报——1 字共享过宽，防误报优先
  assert.equal(rules.titleRootRepeatIssues(['北渡', '北望']).length, 0);
});

test('V0.107: chapterTitleDeliveryIssues 三层核对（事件 high/具象 medium/意象豁免）', async () => {
  const rules = await import('../server/engine/rules.js');
  // ch52 事故正面拦截：帝星陨落 + 正文零死亡词 → high + proseFix
 const ch52 = rules.chapterTitleDeliveryIssues('帝星陨落', '钓鱼城的清晨，砲声停了。主角数着垛口的箭，一夜没合眼。');
  assert.equal(ch52.length, 1);
  assert.equal(ch52[0].severity, 'high', '事件承诺零在场应为 high');
  assert.equal(ch52[0].proseFix, true, '走修订不走 replan');
  // 兑现（正文含驾崩/发丧）→ 干净
  const ok = rules.chapterTitleDeliveryIssues('帝星陨落', '驿骑入城，说官家驾崩了，举国发丧。');
  assert.equal(ok.length, 0, '正文词族在场即兑现');
  // 转述式落地也算在场（塘报）
  const relay = rules.chapterTitleDeliveryIssues('大捷', '塘报说西线告捷，斩首三百。');
  assert.equal(relay.length, 0);
  // 具象型：全部 bigram 零命中 → medium
  const concrete = rules.chapterTitleDeliveryIssues('伍字军旗', '他在田里干活，锄头起落。');
  assert.equal(concrete.length, 1);
  assert.equal(concrete[0].severity, 'medium');
  // bigram 命中即豁免（意象型《故园成灰》正文含「成灰」）
  const imagery = rules.chapterTitleDeliveryIssues('故园成灰', '那座宅子烧了三天，最后成灰。');
  assert.equal(imagery.length, 0);
  // 2 字章名不判（无 bigram）
  assert.equal(rules.chapterTitleDeliveryIssues('军报', '完全无关的正文').length, 0);
  // 非事件词章名不触发 high（磨刀/夜哨不进词族）
  assert.equal(rules.chapterTitleDeliveryIssues('井边磨刀', '山在那，河在那。').length, 1, '只落 medium 具象档');
  assert.equal(rules.chapterTitleDeliveryIssues('井边磨刀', '山在那，河在那。')[0].severity, 'medium');
});

test('V0.107: volumeChapterCount 新档位 8/12/14', async () => {
  const outline = await import('../server/engine/outline.js');
  const book = { genre: '历史' }; // 历史档 3500 → 常规 12
  assert.equal(outline.volumeChapterCount(book, {}), 12, '常规卷 12 章');
  assert.equal(outline.volumeChapterCount(book, { isFirst: true }), 8, '首卷 8 章');
  assert.equal(outline.volumeChapterCount({ genre: '历史', settings_json: JSON.stringify({ lengthProfile: 5000 }) }, {}), 14, '丰满档 14 章');
});

test('V0.107: TITLE_EVENT_LEXICON 写审同源（redlines 单一真源）', async () => {
  const { TITLE_EVENT_LEXICON } = await import('../server/data/redlines.js');
  assert.ok(TITLE_EVENT_LEXICON.length >= 8, '词族表覆盖主要强事件');
  const death = TITLE_EVENT_LEXICON.find(f => f.trigger.includes('驾崩'));
  assert.ok(death.evidence.some(w => w.includes('薨')) && death.evidence.some(w => w.includes('发丧')), '帝王死词族含转述式落地词');
});

test('V0.107: adjustChapterTitle 同步 outline_json.title（ch52 错位根治）+ 已发布保护', async () => {
  const store = await import('../server/db/store.js');
  const align = await import('../server/engine/alignment.js');
  const b = store.books.create({ title: 'T107', genre: '玄幻', blurb: 'x' });
  const vol = store.volumes.create(b.id, 1, { title: '第一卷' });
  const ch = store.chapters.create(b.id, vol.id, 1, { title: '旧章名', outline: { beat: 'x', title: '旧章名' } });
  const r = await align.adjustChapterTitle(b.id, ch.id, {});
  if (r) {
    const after = store.chapters.get(ch.id);
    assert.equal(after.title, r.newTitle, 'chapters.title 已更新');
    assert.equal(JSON.parse(after.outline_json || '{}').title, r.newTitle, 'outline_json.title 同步更新（双写根治）');
  }
  // 已发布边界保护
  store.publicationProfiles.upsert(b.id, { publishedChapterCount: 1 });
  assert.equal(align.isPublishedChapterIdx(b.id, 1), true, 'idx≤发布数为已发布');
  assert.equal(align.isPublishedChapterIdx(b.id, 2), false, '发布数之后为未发布');
});

test('V0.107: checkChapterAlignment 事件承诺零在场 → autoFix 改名候选', async () => {
  const store = await import('../server/db/store.js');
  const align = await import('../server/engine/alignment.js');
  const b = store.books.create({ title: 'T108', genre: '玄幻', blurb: 'x' });
  const vol = store.volumes.create(b.id, 1, { title: '第一卷' });
  const ch = store.chapters.create(b.id, vol.id, 1, { title: '帝星陨落', outline: { beat: 'x' } });
  store.scenes.create(ch.id, 1, { beat: 'x', content: '清晨的城墙很安静，守军各自忙各自的活。', status: 'done' });
  const ca = align.checkChapterAlignment(b.id, ch.id);
  assert.equal(ca.aligned, false);
  assert.equal(ca.autoFix, true, '事件零在场应为改名候选');
  // 兑现后不触发
  const ch2 = store.chapters.create(b.id, vol.id, 2, { title: '雨夜叩门', outline: { beat: 'x' } });
  store.scenes.create(ch2.id, 1, { beat: 'x', content: '雨夜里有人叩门，门环响了两声。', status: 'done' });
  const ca2 = align.checkChapterAlignment(b.id, ch2.id);
  assert.equal(ca2.aligned, true, '意象兑现的章名不误伤');
});

test('V0.107: audit localIssues 挂载 chapterTitleDeliveryIssues（源码接线断言）', async () => {
  const auditSrc = fs.readFileSync(path.join(process.cwd(), 'server/engine/audit.js'), 'utf8');
  assert.ok(auditSrc.includes('chapterTitleDeliveryIssues'), 'audit.js 须挂载章名核对闸');
  const promptsSrc = fs.readFileSync(path.join(process.cwd(), 'server/engine/prompts.js'), 'utf8');
  assert.ok(promptsSrc.includes('事件承诺型章名'), '审校 3.11 须含事件承诺判定（写审同源）');
  assert.ok(promptsSrc.includes('章名承诺：章名里的核心意象或事件'), '写作指令须含章名兑现一句（写侧同源）');
});

test('V0.107: 卷纲生成——章数承诺生效（mock 按请求数返回）+ 句式多样', async () => {
  const store = await import('../server/db/store.js');
  const outline = await import('../server/engine/outline.js');
  const b = store.books.create({ title: 'T109', genre: '玄幻', blurb: 'x' });
  const vol = store.volumes.create(b.id, 1, { title: '第一卷' });
  await outline.generateVolumeOutline(b.id, vol.id, { chapterCount: 12 });
  const chs = store.chapters.listByVolume(vol.id);
  assert.equal(chs.length, 12, '12 章承诺应真实建 12 章');
  const rules = await import('../server/engine/rules.js');
  assert.equal(rules.titleShapeStreakIssues(chs.map(c => c.title)).filter(s => s.hard).length, 0, 'mock 标题不得触发硬拦');
});

test('V0.107: 书纲/续卷章数口径同步（源码断言）', async () => {
  const promptsSrc = fs.readFileSync(path.join(process.cwd(), 'server/engine/prompts.js'), 'utf8');
  assert.ok(promptsSrc.includes('每卷 10-16 章'), '书纲口径应为 10-16 章');
  assert.ok(!promptsSrc.includes('每卷 8-15 章'), '旧口径应清除');
  const contSrc = fs.readFileSync(path.join(process.cwd(), 'server/engine/continuation.js'), 'utf8');
  assert.ok(contSrc.includes('|| 12'), '续卷默认 12 章');
});

test('V0.107: 非历史题材零影响回归——章名工艺注入与题材无关', async () => {
  const { TITLE_CRAFT_TEXT } = await import('../server/data/literary_techniques.js');
 assert.ok(!TITLE_CRAFT_TEXT.includes('本作'), '纪律文本不含具体书名（铁律）');
  assert.ok(!TITLE_CRAFT_TEXT.includes('钓鱼城'), '纪律文本不含具体地名');
});

test('V0.107: doctor titleShapes 观察面（只读度量，不拦截）', async () => {
  const doctorSrc = fs.readFileSync(path.join(process.cwd(), 'server/maintenance/doctor.js'), 'utf8');
  assert.ok(doctorSrc.includes('function checkTitleShapes'), 'doctor 应含句式族观察函数');
  assert.ok(doctorSrc.includes('titleShapes: checkTitleShapes'), '观察面应挂进 auditBook checks');
  assert.ok(/ok: true, observation: true/.test(doctorSrc), '观察面恒 ok=true——不进 issueCount、不拦截');

  // 观察面必须能对任意库逐卷分组输出。这里用正式 schema 建一个临时库并灌入两卷章节，
  // 不依赖任何既有作品的数据。
  const { DatabaseSync } = await import('node:sqlite');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1070-titleshapes-'));
  const dbPath = path.join(dir, 'sample.db');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(fs.readFileSync(path.join(process.cwd(), 'server/db/schema.sql'), 'utf8'));
    const now = Date.now();
    db.prepare(`INSERT INTO books (id,title,genre,blurb,platform,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run('bk-sample', '句式族观察测试', '玄幻', '', '通用', now, now);
    db.prepare(`INSERT INTO volumes (id,book_id,idx,title,goal,summary)
      VALUES (?,?,?,?,?,?)`).run('vol-1', 'bk-sample', 1, '第一卷', '', '');
    db.prepare(`INSERT INTO volumes (id,book_id,idx,title,goal,summary)
      VALUES (?,?,?,?,?,?)`).run('vol-2', 'bk-sample', 2, '第二卷', '', '');

    const cols = db.prepare('PRAGMA table_info(chapters)').all().map(c => c.name);
    const insert = db.prepare(`INSERT INTO chapters
      (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    const rowFor = (id, vol, idx, title) => cols.map(name => {
      if (name === 'id') return id;
      if (name === 'book_id') return 'bk-sample';
      if (name === 'volume_id') return vol;
      if (name === 'idx') return idx;
      if (name === 'title') return title;
      if (name === 'status') return 'settled';
      if (name.endsWith('_at')) return now;
      if (name === 'outline_json' || name === 'meta_json') return '{}';
      return null;
    });
    // idx 在书内全局连续（项目约定），卷只是归属
    for (let i = 1; i <= 3; i++) insert.run(...rowFor(`ch-${i}`, 'vol-1', i, `北望${i}`));
    for (let i = 4; i <= 5; i++) insert.run(...rowFor(`ch-${i}`, 'vol-2', i, `风起长河${i}`));
    db.close();

    const { auditDatabase } = await import('../server/maintenance/doctor.js');
    const report = auditDatabase(dbPath);
    const book = report.books?.find?.(b => b.title === '句式族观察测试') || report.books?.[0];
    const shapes = book?.checks?.titleShapes;
    assert.ok(shapes, '体检报告应含 titleShapes');
    assert.ok(shapes.ok === true, '观察面不拦截');
    assert.ok(Array.isArray(shapes.volumes) && shapes.volumes.length > 0, '逐卷分组输出');
    for (const v of shapes.volumes) {
      assert.ok(typeof v.chapters === 'number' && v.chapters > 0);
      assert.ok(v.shapeDistribution && typeof v.shapeDistribution === 'object');
    }
  } finally {
    // Windows 下 SQLite 可能仍持有句柄，临时目录交给系统回收即可
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  }
});
