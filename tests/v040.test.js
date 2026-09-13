// V0.40：待登记实体自动治理——类型推断建卡/去重/超期归档/误建迁移/同名合并
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 必须在任何 server 模块加载前设置（store.js 在模块加载时读取 NOVEL_DATA_DIR）
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v040-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();

describe('V0.40 待登记实体自动治理', () => {
  test('inferEntityType：地点/物品/势力/角色/概念分类', async () => {
    const { inferEntityType } = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/pending.js')));
    assert.equal(inferEntityType('秦家禁地', '藏经阁所在'), 'location');
    assert.equal(inferEntityType('青林坳', '父亲提及的地名'), 'location');
    assert.equal(inferEntityType('秦家西院', '秦朗住所'), 'location');
    assert.equal(inferEntityType('废弃石井', '禁地东南角'), 'location');
    assert.equal(inferEntityType('秦渊的铜色护符', '佩戴'), 'item');
    assert.equal(inferEntityType('藏经阁残卷', '内含手记'), 'item');
    assert.equal(inferEntityType('外部势力', '渗透秦家外围'), 'faction');
    assert.equal(inferEntityType('奶娘', '住西厢'), 'character');
    assert.equal(inferEntityType('地牢存在', '发出冷笑的生物'), 'character');
    assert.equal(inferEntityType('灵根', '修仙资质指标'), null, '概念类不建卡');
    assert.equal(inferEntityType('校验端点', '屏障波动中的低谷'), null);
  });

  test('tidyPendingEntities：推断建卡 + 已登记去重 + 超期归档', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v040-'));
        const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { tidyPendingEntities } = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/pending.js')));
    const b = store.books.create({ title: '测试书', genre: '玄幻', blurb: 'x' });
    // 预置：已登记角色 + 各类型待登记
    store.characters.create(b.id, { name: '林晚', card: {} });
    store.pendingEntities.add(b.id, { name: '林晚', context: '主角', sourceChapter: 1 });       // 已登记去重
    store.pendingEntities.add(b.id, { name: '秦家禁地', context: '藏经阁所在', sourceChapter: 1 }); // location 建卡
    store.pendingEntities.add(b.id, { name: '护身玉符', context: '腰间佩戴', sourceChapter: 2 });   // item 建卡
    store.pendingEntities.add(b.id, { name: '奶娘', context: '住西厢', sourceChapter: 1 });         // character 建卡
    store.pendingEntities.add(b.id, { name: '灵根', context: '资质指标', sourceChapter: 10 }); // 未超期保留观察       // 概念：未超期保留
    store.pendingEntities.add(b.id, { name: '旧梦残响', context: '模糊概念', sourceChapter: 1 });   // 超期归档
    // 同名合并：再次出现
    store.pendingEntities.add(b.id, { name: '秦家禁地', context: '三重阵法', sourceChapter: 3 });
    const dup = store.pendingEntities.list(b.id).find(p => p.name === '秦家禁地');
    assert.equal(dup.dup_count, 2, '同名应计数');
    assert.ok(dup.context.includes('三重阵法'), '上下文应合并');

    const stats = tidyPendingEntities(b.id, { currentChapter: 12 });
    assert.equal(stats.confirmed, 3, '应登记 3 项（禁地/玉符/奶娘），林晚去重也算 confirmed');
    assert.equal(stats.archived, 1, '旧梦残响超期归档');
    assert.equal(store.locations.list(b.id).some(e => e.name === '秦家禁地'), true, '禁地应建 location 卡');
    assert.equal(store.items.list(b.id).some(e => e.name === '护身玉符'), true, '玉符应建 item 卡');
    assert.equal(store.characters.list(b.id).some(e => e.name === '奶娘'), true, '奶娘应建角色卡');
    // 灵根（概念，未超期）保留
    assert.equal(store.pendingEntities.list(b.id).some(p => p.name === '灵根'), true, '概念类保留观察');
    // 处理记录状态
    const all = store.pendingEntities.listAll(b.id);
    assert.ok(all.some(p => p.name === '林晚' && p.status === 'already_registered'), '已登记去重');
    assert.ok(all.some(p => p.name === '旧梦残响' && p.status === 'stale_archived'), '超期归档');
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('migrateMisplacedCharacters：误建角色卡迁移到正确卡表', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v040b-'));
        const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { migrateMisplacedCharacters } = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/pending.js')));
    const b = store.books.create({ title: '测试书', genre: '玄幻', blurb: 'x' });
    // 模拟 V0.30 误建：物品被建成 autoConfirmed 角色卡
    store.characters.create(b.id, { name: '地牢屏障', card: { autoConfirmed: true, note: '反弹屏障' } });
    store.characters.create(b.id, { name: '正常角色', card: { autoConfirmed: true, note: '秦朗的师兄' } });
    const n = migrateMisplacedCharacters(b.id);
    assert.equal(n, 1, '地牢屏障应迁移');
    assert.equal(store.items.list(b.id).some(e => e.name === '地牢屏障'), true, '迁移到 items');
    assert.equal(store.characters.list(b.id).some(e => e.name === '地牢屏障'), false, '角色卡删除');
    assert.equal(store.characters.list(b.id).some(e => e.name === '正常角色'), true, '正常角色保留');
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('结算自动整理接线 + 前端整理入口', () => {
    const s = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/settle.js'), 'utf8');
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const f = fs.readFileSync(path.join(ROOT, 'web/js/views/facts.js'), 'utf8');
    assert.ok(s.includes("tidyPendingEntities(bookId, { currentChapter"), '结算应自动整理');
    assert.ok(idx.includes("'/api/books/:id/pending/tidy'"), '应有手动整理 API');
    assert.ok(idx.includes('migrateMisplacedCharacters'), '整理 API 应含误建迁移');
    assert.ok(f.includes('⚡ 自动整理'), '前端应有自动整理按钮');
  });
});
