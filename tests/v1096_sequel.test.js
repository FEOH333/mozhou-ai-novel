// V0.109.4 续作（衍新书）：以完本作品为母本派生新书，继承世界观/设定/可选角色。
//
// 这个功能的失败模式：把旧书的**叙事状态**也带过去（主轴进度、旧章 id、旧主角当前状态），
// 新书开篇就会与自己的设定打架。故测试重点在"该带的带、不该带的不带"。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1096-sq-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const sequel = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/sequel.js')));

/** 造一部"已完本"的母本 */
function makeSource(over = {}) {
  const book = store.books.create({
    title: over.title || `母本-${Math.random().toString(36).slice(2, 7)}`,
    genre: over.genre || '历史', platform: '番茄',
  });
  const vol = store.volumes.create(book.id, 1, { title: '第一卷' });
  const ch = store.chapters.create(book.id, vol.id, 1, { title: 'C1', status: 'done' });
  store.scenes.create(ch.id, 1, { content: '辰时三刻，他走进院子。'.repeat(30), status: 'done' });
  store.materials.set(book.id, 'world', '南宋末年，钓鱼城据守。');
  store.facts.create(book.id, { subject: '主角', predicate: '据守于', object: '钓鱼城' });
  store.characters.create(book.id, { name: '主角', tier: 'protagonist', personality: '谨慎', goal: '守城' });
  store.characters.create(book.id, { name: '同伴', tier: 'minor', personality: '爽直' });
  return book;
}

describe('V0.109.4 续作（衍新书）', () => {

  test('候选清单：列清可继承资产与数量，供用户勾选', () => {
    const src = makeSource();
    const c = sequel.sequelCandidates(src.id);
    assert.equal(c.title, src.title);
    assert.equal(c.genre, '历史');
    assert.equal(c.world.available, true);
    assert.equal(c.facts.count, 1);
    assert.equal(c.characters.count, 2);
    assert.deepEqual(c.characters.names.slice().sort(), ['同伴', '主角'].sort());
    assert.equal(sequel.sequelCandidates('不存在的书'), null);
  });

  test('派生：新书继承题材/平台/世界观/事实/角色，且标题可指定', () => {
    const src = makeSource();
    const r = sequel.deriveSequel(src.id, { title: '下一代' });
    assert.equal(r.title, '下一代');
    assert.equal(r.inherited.world, true);
    assert.equal(r.inherited.facts, 1);
    assert.equal(r.inherited.characters, 2);

    const nb = store.books.get(r.bookId);
    assert.equal(nb.genre, '历史', '应继承题材');
    assert.equal(nb.platform, '番茄', '应继承平台');
    assert.equal(store.materials.get(r.bookId, 'world')?.content, '南宋末年，钓鱼城据守。', '应继承世界观');
    assert.equal(store.facts.active(r.bookId).length, 1, '应继承事实');
    assert.equal(store.characters.list(r.bookId).length, 2, '应继承角色');
  });

  test('缺省标题为「母本标题·续」', () => {
    const src = makeSource({ title: '山河' });
    const r = sequel.deriveSequel(src.id, {});
    assert.equal(r.title, '山河·续');
  });

  test('★不该带的不带：旧叙事状态不得污染新书', () => {
    const src = makeSource();
    // 母本制造一些叙事状态
    store.volumes.create(src.id, 2, { title: '第二卷' });
    store.materials.set(src.id, 'cast', '旧主角弧光：从少年到统帅');

    const r = sequel.deriveSequel(src.id, {});
    assert.equal(store.volumes.list(r.bookId).length, 0, '新书不得继承旧卷');
    assert.equal(store.chapters.list(r.bookId).length, 0, '新书不得继承旧章');
    assert.equal(store.materials.get(r.bookId, 'cast')?.content || '', '', 'cast 默认不带');

    // 继承来的角色：状态清零、首登场章重置
    for (const c of store.characters.list(r.bookId)) {
      assert.equal(c.first_chapter, null, '首登场章必须重算');
      assert.deepEqual(JSON.parse(c.state_json || '{}'), {}, '角色状态必须清零');
    }
    // 继承来的事实：source_chapter 必须归零（旧章 id 在新书不存在）
    for (const f of store.facts.active(r.bookId)) {
      assert.equal(f.source_chapter, null, '旧章 id 不得带入新书');
      assert.match(f.note, /继承自/, '应注明来源');
    }
  });

  test('可只继承指定角色（新主角通常要新建，不该被旧主角压住）', () => {
    const src = makeSource();
    const r = sequel.deriveSequel(src.id, { title: '外传', inherit: { characters: ['同伴'] } });
    assert.equal(r.inherited.characters, 1);
    const names = store.characters.list(r.bookId).map(c => c.name);
    assert.deepEqual(names, ['同伴']);
  });

  test('继承开关可关：world/facts/characters 全关只剩空设定新书', () => {
    const src = makeSource();
    const r = sequel.deriveSequel(src.id, {
      title: '全新', inherit: { world: false, facts: false, characters: false },
    });
    assert.equal(r.inherited.world, false);
    assert.equal(r.inherited.facts, 0);
    assert.equal(r.inherited.characters, 0);
    assert.equal(store.materials.get(r.bookId, 'world')?.content || '', '');
    assert.equal(store.facts.active(r.bookId).length, 0);
  });

  test('可选继承 cast 材料', () => {
    const src = makeSource();
    store.materials.set(src.id, 'cast', '旧主角弧光');
    const r = sequel.deriveSequel(src.id, { title: '带弧光', inherit: { cast: true } });
    assert.equal(r.inherited.cast, true);
    assert.equal(store.materials.get(r.bookId, 'cast')?.content, '旧主角弧光');
  });

  test('溯源：新书记录从哪来、继承了什么', () => {
    const src = makeSource();
    const r = sequel.deriveSequel(src.id, { title: '可溯源' });
    const from = sequel.derivedFrom(r.bookId);
    assert.equal(from.sourceBookId, src.id);
    assert.equal(from.sourceTitle, src.title);
    assert.equal(from.inherited.world, true);
    assert.ok(from.derivedAt > 0);
    assert.equal(sequel.derivedFrom(src.id), null, '非续作返回 null');
  });

  test('母本不存在 / 空母本被拒绝', () => {
    assert.throws(() => sequel.deriveSequel('不存在', {}), /母本作品不存在/);
    const empty = store.books.create({ title: '空母本', genre: '玄幻' });
    assert.throws(() => sequel.deriveSequel(empty.id, {}), /还没有任何章节/);
  });

  test('接口已接线：GET 候选 / POST 派生', () => {
    const idx = read('server/index.js');
    assert.match(idx, /route\('GET', '\/api\/books\/:id\/sequel-candidates'/, 'GET 候选应注册');
    assert.match(idx, /route\('POST', '\/api\/books\/:id\/sequel'/, 'POST 派生应注册');
    assert.match(idx, /from '\.\/engine\/planning\/sequel\.js'/, '应导入续作模块');
  });

  test('派生不动母本（母本资产不因派生而改变）', () => {
    const src = makeSource();
    const before = {
      facts: store.facts.active(src.id).length,
      chars: store.characters.list(src.id).length,
      world: store.materials.get(src.id, 'world')?.content,
    };
    sequel.deriveSequel(src.id, { title: 'X' });
    assert.equal(store.facts.active(src.id).length, before.facts, '母本事实数不变');
    assert.equal(store.characters.list(src.id).length, before.chars, '母本角色数不变');
    assert.equal(store.materials.get(src.id, 'world')?.content, before.world, '母本世界观不变');
  });
});
