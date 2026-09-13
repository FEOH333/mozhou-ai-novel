// V0.49 角色与情感引擎测试：角色弧光/配角库/社会生态/情感弧/人物戏/q6/结算回写/注入
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v049-'));

describe('V0.49 角色与情感引擎', () => {
  test('书纲指令含角色弧光设计（主角 arc 分阶段双线+配角 secret/fate）', async () => {
    const { bookOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const s = bookOutlineInstruction({ genre: '玄幻', blurb: 'x' });
    assert.ok(s.includes('角色弧光设计'), '应含角色弧光设计段');
    assert.ok(s.includes('成长弧线（能力+心境双线') || s.includes('能力线+心境线'), 'arc 应双线');
    assert.ok(s.includes('"secret"') || s.includes('命运线'), '配角应含 secret/fate');
    assert.ok(s.includes('性格弱点') || s.includes('内在弱点'), '应要求性格弱点');
  });

  test('cast 材料落库 + 公共前缀注入（书纲生成后）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const outline = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));
    const b = store.books.create({ title: '未命名', genre: '玄幻', blurb: 'x' });
    await outline.generateBookOutline(b.id, {});
    const cast = store.materials.get(b.id, 'cast');
    assert.ok(cast?.content, 'cast 材料应落库');
    assert.ok(cast.content.includes('主角') || cast.content.includes('配角库'), '应含主角/配角库');
    assert.ok(outline.publicMaterialsText(b.id).cast, '公共材料应含 cast');
  });

  test('characters 表 6 新列读写 + 迁移', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const b = store.books.create({ title: '角色列书', genre: '玄幻', blurb: 'x' });
    const c = store.characters.create(b.id, { name: '阿福', personality: '忠厚', goal: '守护', fear: '被抛弃', secret: '曾叛', arc: '忠厚→决绝', relation: '李尘之友' });
    assert.equal(c.personality, '忠厚');
    assert.equal(c.secret, '曾叛');
    store.characters.update(c.id, { arc: '忠厚→决绝→牺牲' });
    assert.equal(store.characters.get(c.id).arc, '忠厚→决绝→牺牲', 'update 应支持弧线列');
  });

  test('设定指令含社会生态 + 落独立 ecology 材料（V0.50：不进公共前缀按场景注入）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { generateBookSettings } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/settings.js')));
    const b = store.books.create({ title: '生态书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', 'c');
    store.materials.set(b.id, 'outline', 'o');
    await generateBookSettings(b.id, {});
    const eco = store.materials.get(b.id, 'ecology')?.content || '';
    assert.ok(eco.includes('社会生态') || eco.includes('【'), 'ecology 材料应含市井细节');
    const w = store.materials.get(b.id, 'world')?.content || '';
    assert.ok(!w.includes('【社会生态】'), '社会生态不应再并入 world 公共前缀（避免每章注入喧宾夺主）');
  });

  test('卷大纲指令含情感弧设计（每卷≥1 情感事件）', async () => {
    const { volumeOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const s = volumeOutlineInstruction({ bookTitle: 'T', volumeIdx: 1, volumeTitle: 'V', bookOutline: '{}', chapterCount: 8 });
    assert.ok(s.includes('情感弧设计'), '应含情感弧设计');
    assert.ok(s.includes('情感事件'), '应含情感事件要求');
    assert.ok(s.includes('离别') && s.includes('背叛'), '应列举情感事件类型');
  });

  test('细纲指令含 pace 节奏字段与按需人物戏（V0.50）', async () => {
    const { chapterOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const s = chapterOutlineInstruction({ chapterIdx: 1, chapterLength: 3200 });
    assert.ok(s.includes('character_beat'), '应含 character_beat 字段');
    assert.ok(s.includes('"pace"'), '应含 pace 节奏字段');
    assert.ok(s.includes('advance'), '应含推进章定位');
    assert.ok(s.includes('配角高光'), '应含配角高光');
    assert.ok(s.includes('画龙点睛'), '应体现按需注入不喧宾夺主');
  });

  test('五问自检含 q6 情感变化且番茄强制', async () => {
    const { fiveQuestionsInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const s = fiveQuestionsInstruction({ bookTitle: 'T', chapterIdx: 1, chapterTitle: 'C', outline: {} });
    assert.ok(s.includes('q6_emotional_change'), '应含 q6');
    assert.ok(s.includes('角色内心或人与人关系发生了变化'), 'q6 应定义情感/关系变化');
    // outline.js 判定逻辑
    const outline = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/planning/outline.js'), 'utf8');
    assert.ok(src.includes('q6'), 'fiveQuestionsCheck 应读取 q6');
  });

  test('正文指令注入角色卡字段与人物戏要点', async () => {
    const { writeSceneInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const s = writeSceneInstruction({
      bookTitle: 'T', chapterIdx: 1, scene: { id: 's1', pov: '李尘', beat: 'x' }, scenesBefore: [],
      cardText: '【角色人物卡】- 李尘：性格：自卑',
      characterBeat: { character: '李尘', inner_change: '从恐惧到决心', relation_delta: '与阿福和解' },
    });
    assert.ok(s.includes('角色人物卡'), '应注入角色卡');
    assert.ok(s.includes('人物戏要点'), '应注入人物戏要点');
    assert.ok(s.includes('内心变化'), '人物戏应含内心变化');
  });

  test('审校含情感连贯性软检（low 级不阻断）', async () => {
    const { auditInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const s = auditInstruction({ bookTitle: 'T', chapterTitle: 'C' });
    assert.ok(s.includes('情感连贯性'), '审校应含情感连贯性类型');
    assert.ok(s.includes('severity=low') || s.includes('一律 severity=low'), '应注明 low 不阻断');
  });

  test('结算 character_emotional 回写角色卡（心境/关系）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { settleChapter } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/settle.js')));
    const b = store.books.create({ title: '结算书', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    // 真实管线是在正文写完、章节仍为 drafted 时进入结算；done 代表已完成旧书，
    // V0.100 起必须先建立同版账本，不能用不真实 fixture 绕过旧书升级门。
    const c = store.chapters.create(b.id, v.id, 1, { title: 'C1', status: 'drafted' });
    store.scenes.create(c.id, 1, { content: '正文', status: 'done' });
    store.characters.create(b.id, { name: '林晚', relation: '旧识' });
    await settleChapter(b.id, c.id, {});
    const lw = store.characters.list(b.id).find(x => x.name === '林晚');
    assert.ok((lw.relation || '').includes('疏远'), 'relation 应回写关系变化');
    const st = JSON.parse(lw.state_json || '{}');
    assert.ok(st['心境'], 'state 应回写心境');
  });

  test('world 页角色卡 API 返回弧光字段', async () => {
    // 静态断言：index.js 含 /characters 端点
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(idx.includes('/api/books/:id/characters'), '应含角色卡端点');
    // world.js 含角色卡展示
    const wjs = fs.readFileSync(path.join(ROOT, 'web/js/views/world.js'), 'utf8');
    assert.ok(wjs.includes('角色卡'), 'world 页应含角色卡展示区');
  });
});
