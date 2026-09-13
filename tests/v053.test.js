// V0.53 角色库整理修复测试：cast 无前缀匹配/extra 重新评估/非人物卡净化/补全候选
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v053-'));

describe('V0.53 角色库整理修复', () => {
  test('castMatched 兼容无 "- " 前缀的 cast 行（阿福｜...）', async () => {
    const roster = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/roster.js')));
    const cast = '【主角弧光】\n李尘｜起点缺陷：懒\n\n【配角库】\n阿福｜小乞丐｜乐观｜目标是吃饱｜秘密：孤儿｜命运线：牺牲｜与李尘兄弟\n- 赵铁柱｜恶霸｜凶悍';
    assert.equal(roster.castMatched(cast, '阿福'), true, '无前缀行应匹配');
    assert.equal(roster.castMatched(cast, '赵铁柱'), true, '带 - 前缀行应匹配');
    assert.equal(roster.castMatched(cast, '石碑'), false, '未点名不应匹配');
  });

  test('localTier：cast 主角→protagonist/配角→major/未匹配→minor（不再默认 extra）', async () => {
    const roster = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/roster.js')));
    const cast = '【主角弧光】\n李尘｜起点缺陷：懒\n\n【配角库】\n阿福｜小乞丐｜乐观｜目标是吃饱';
    const mk = (name, tier) => ({ name, tier, personality: '', goal: '', secret: '', arc: '' });
    assert.equal(roster.localTier('x', cast, mk('李尘', 'extra')), 'protagonist', '主角应升 protagonist');
    assert.equal(roster.localTier('x', cast, mk('阿福', 'extra')), 'major', '配角应升 major');
    assert.equal(roster.localTier('x', cast, mk('瘦丐', 'extra')), 'minor', '未匹配不再默认 extra');
    // 已有 protagonist/major 且有内容 → 尊重
    assert.equal(roster.localTier('x', cast, { name: '李尘', tier: 'protagonist', personality: '隐忍' }), 'protagonist');
  });

  test('purgeMisplacedCharacterCards：道具迁移 items/生物与 cast 点名保留', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const roster = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/roster.js')));
    const b = store.books.create({ title: 'T', genre: '玄幻', blurb: 'x' });
    const cast = '【配角库】\n阿福｜小乞丐｜乐观｜目标是吃饱';
    store.characters.create(b.id, { name: '阿福', tier: 'minor' });
    store.characters.create(b.id, { name: '石碑', tier: 'minor' });
    store.characters.create(b.id, { name: '骨片', tier: 'minor' });
    store.characters.create(b.id, { name: '石蜥', tier: 'minor' });
    const { migrated } = roster.purgeMisplacedCharacterCards(b.id, cast);
    assert.deepEqual(migrated.sort(), ['石碑', '骨片'].sort(), '道具应迁移');
    const left = store.characters.list(b.id).map(c => c.name);
    assert.ok(left.includes('阿福') && left.includes('石蜥'), 'cast 点名与生物保留');
    const items = store.items.list(b.id).map(i => i.name);
    assert.ok(items.includes('石碑') && items.includes('骨片'), 'items 表应有迁移卡');
  });

  test('tidyRoster 端到端：分级+净化+AI 补全（mock）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const roster = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/roster.js')));
    const b = store.books.create({ title: 'T2', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'cast', '【主角弧光】\n李尘｜懒\n\n【配角库】\n阿福｜小乞丐｜乐观｜目标是吃饱｜秘密：孤儿');
    store.characters.create(b.id, { name: '李尘', tier: 'extra' });
    store.characters.create(b.id, { name: '阿福', tier: 'extra' });
    store.characters.create(b.id, { name: '断玉', tier: 'extra' });
    const r = await roster.tidyRoster(b.id, {});
    assert.ok(r.migrated.includes('断玉'), '断玉应净化');
    const chars = store.characters.list(b.id);
    assert.equal(chars.find(c => c.name === '李尘').tier, 'protagonist');
    assert.equal(chars.find(c => c.name === '阿福').tier, 'major');
  });
});
