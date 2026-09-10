// V0.65 角色库自动整理增强测试：双轨净化/同义词合并/出场频率分级
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v065-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const roster = await import(pathToFileURL(path.join(ROOT, 'server/engine/roster.js')));

describe('V0.65 角色库增强', () => {
  test('①双轨净化：多字词强命中（六维补全过也清）+ 单字词弱命中（仅空卡）', () => {
    const b = store.books.create({ title: '净化书', genre: '玄幻' });
    // 兽骨箭头（六维全空）→ 箭头强命中
    store.characters.create(b.id, { name: '兽骨箭头' });
    // 孙伯家门口白石头门槛（六维全空）→ 门槛强命中
    store.characters.create(b.id, { name: '孙伯家门口白石头门槛' });
    // 窗台白光（六维全空）→ 光弱命中（空卡可清）
    store.characters.create(b.id, { name: '窗台白光' });
    // 王光（六维有内容，真角色）→ 光弱命中但六维有内容 → 保留
    store.characters.create(b.id, { name: '王光', personality: '温和', goal: '种田' });
    // 灰影（六维补全过）→ 以"影"结尾 → BIO 保护保留
    store.characters.create(b.id, { name: '灰影', personality: '神秘', goal: '观察' });
    const { migrated } = roster.purgeMisplacedCharacterCards(b.id, '');
    assert.ok(migrated.includes('兽骨箭头'), '箭头应被净化');
    assert.ok(migrated.includes('孙伯家门口白石头门槛'), '门槛应被净化');
    assert.ok(migrated.includes('窗台白光'), '白光（空卡）应被净化');
    assert.ok(!migrated.includes('王光'), '王光（有六维）不应被误杀');
    assert.ok(!migrated.includes('灰影'), '灰影（影结尾 BIO）不应被净化');
    const items = store.items.list(b.id).map(i => i.name);
    assert.ok(items.includes('兽骨箭头') && items.includes('窗台白光'), '净化项应迁移到 items');
  });

  test('②本地合并：包含关系（灰影→灰影人）', () => {
    const b = store.books.create({ title: '合并书', genre: '玄幻' });
    store.characters.create(b.id, { name: '灰影', tier: 'minor' });
    store.characters.create(b.id, { name: '灰影人', tier: 'minor' });
    // 给灰影一条事实
    store.facts.create(b.id, { subject: '灰影', predicate: '出现', object: '夜间' });
    const merges = roster.localMergeSuggest(b.id);
    assert.ok(merges.some(m => m.from === '灰影' && m.to === '灰影人'), '灰影应并入灰影人');
    const n = roster.applyMerges(b.id, merges);
    assert.ok(n >= 1, '应执行合并');
    const names = store.characters.list(b.id).map(c => c.name);
    assert.ok(!names.includes('灰影'), '灰影卡应删除');
    assert.ok(names.includes('灰影人'), '灰影人保留');
    // 事实迁移：灰影的事实应归属灰影人
    const facts = store.facts.list(b.id).filter(f => f.subject === '灰影人' && f.status === 'active');
    assert.ok(facts.length >= 1, '事实应迁移到灰影人');
  });

  test('③主角不可被合并', () => {
    const b = store.books.create({ title: '主角保护', genre: '玄幻' });
    store.characters.create(b.id, { name: '李尘', tier: 'protagonist' });
    store.characters.create(b.id, { name: '李尘的剑', tier: 'minor' });
    const merges = roster.localMergeSuggest(b.id);
    assert.ok(!merges.some(m => m.from === '李尘' || m.to === '李尘'), '主角不应出现在合并中');
  });

  test('④出场频率分级：高频未点名升级、极低频降 extra', () => {
    const b = store.books.create({ title: '分级书', genre: '玄幻' });
    const v = store.volumes.create(b.id, 1, { title: 'V1' });
    const c1 = store.chapters.create(b.id, v.id, 1, { title: 'C1' });
    // 高频角色（摘要出现 20 次）
    store.characters.create(b.id, { name: '高频率', tier: 'minor' });
    // 低频角色
    store.characters.create(b.id, { name: '低频率', tier: 'minor' });
    store.summaries.set(c1.id, b.id, '高频率高频率高频率高频率高频率高频率高频率高频率高频率高频率高频率高频率高频率高频率高频率高频率高频率高频率高频率高频率');
    const changed = roster.tierByFrequency(b.id, '');
    const high = store.characters.list(b.id).find(c => c.name === '高频率');
    const low = store.characters.list(b.id).find(c => c.name === '低频率');
    assert.equal(high.tier, 'major', '高频（20次）应升级 major');
    assert.equal(low.tier, 'extra', '低频（0次）应降 extra');
    assert.ok(changed >= 2, '应有分级调整');
  });
});
