// V0.78 新角色联动链路修复：pending 实体默认倾向角色 + dup_count 强信号 + 手动整理不误归档
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v079-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.78 新角色联动链路', () => {
  test('①inferEntityType 剥"（身份）"后缀，不因"书"误判物品', async () => {
    const { inferEntityType } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pending.js')));
    // 老幺（书库杂役）→ 核心名"老幺"，不应被 item 的"书"误命中
    assert.equal(inferEntityType('老幺（书库杂役）', ''), null, '带后缀角色不应误判物品');
    assert.equal(inferEntityType('老幺', '书库杂役'), null, '普通昵称不匹配词表');
    // 真正的物品仍能识别
    assert.equal(inferEntityType('玄铁剑', ''), 'item', '物品应识别');
    assert.equal(inferEntityType('老幺（书库杂役）', ''), null, '不带 context 也不误判');
  });

  test('②looksLikePerson：老幺/小二/阿福等昵称识别为人物', async () => {
    const { looksLikePerson } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pending.js')));
    assert.equal(looksLikePerson('老幺'), true, '老幺应识别为人');
    assert.equal(looksLikePerson('老幺（书库杂役）'), true, '带后缀也应识别');
    assert.equal(looksLikePerson('小二'), true, '小二应识别');
    assert.equal(looksLikePerson('阿福'), true, '阿福应识别');
    assert.equal(looksLikePerson('赵铁柱'), true, '赵铁柱应识别');
    assert.equal(looksLikePerson('青云宗'), false, '宗门不应识别为人物');
    assert.equal(looksLikePerson('神秘玉佩'), false, '物品不应识别为人物');
  });

  test('③tidyPendingEntities：像人物的未分类实体 → 默认建角色卡', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { tidyPendingEntities } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pending.js')));
    const b = store.books.create({ title: '链路书', genre: '玄幻', blurb: 'x' });
    store.pendingEntities.add(b.id, { name: '老幺', context: '书库杂役，林月指出其监视', sourceChapter: 5 });
    const r = tidyPendingEntities(b.id, { currentChapter: 6 });
    assert.equal(r.confirmed, 1, '应建卡');
    const chars = store.characters.list(b.id);
    assert.ok(chars.some(c => c.name === '老幺'), '角色库应有老幺');
    const pe = store.pendingEntities.listAll(b.id);
    assert.ok(pe.some(p => p.name === '老幺' && p.status === 'character_auto'), '状态应为 character_auto');
  });

  test('④tidyPendingEntities：重复出现（dup_count≥2）→ 建角色卡', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { tidyPendingEntities } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pending.js')));
    const b = store.books.create({ title: '重复书', genre: '玄幻', blurb: 'x' });
    store.pendingEntities.add(b.id, { name: '阿四', context: '酒馆伙计', sourceChapter: 3 });
    store.pendingEntities.add(b.id, { name: '阿四', context: '再次出现', sourceChapter: 6 });
    const r = tidyPendingEntities(b.id, { currentChapter: 7 });
    assert.equal(r.confirmed, 1, '重复实体应建卡');
    assert.ok(store.characters.list(b.id).some(c => c.name === '阿四'), '角色库应有阿四');
  });

  test('⑤tidyPendingEntities：手动整理传真实章号不误归档刚登记实体', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { tidyPendingEntities } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pending.js')));
    const b = store.books.create({ title: '手动书', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    for (let i = 1; i <= 3; i++) store.chapters.create(b.id, v.id, i, { title: '第' + i + '章', status: 'done' });
    store.pendingEntities.add(b.id, { name: '阿五', context: '挑夫', sourceChapter: 3 });
    // 手动整理应传真实最新章节号（3），而非默认 999999
    const maxIdx = store.chapters.list(b.id).reduce((m, c) => Math.max(m, c.idx), 0);
    const r = tidyPendingEntities(b.id, { currentChapter: maxIdx || 1 });
    assert.equal(r.confirmed, 1, '阿五像人物应建卡');
    assert.ok(store.characters.list(b.id).some(c => c.name === '阿五'), '应建成角色');
  });

  test('⑥完整链路：正文【新设定:老幺】→ pending → tidy → 角色卡 → 点名册可见', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { stripNewSettingMarkers } = await import(pathToFileURL(path.join(ROOT, 'server/engine/write.js')));
    const { tidyPendingEntities } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pending.js')));
    const { characterRollCallText } = await import(pathToFileURL(path.join(ROOT, 'server/engine/characters.js')));
    const b = store.books.create({ title: '全链路书', genre: '玄幻', blurb: 'x' });
    store.characters.create(b.id, { name: '李尘', tier: 'protagonist' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    for (let i = 1; i <= 10; i++) store.chapters.create(b.id, v.id, i, { title: '第' + i + '章', status: 'done' });
    // 1) 正文标记
    const cleaned = stripNewSettingMarkers(b.id, '他看见老幺站在书库门口。【新设定:老幺——书库杂役，负责管理卷宗】', 11);
    assert.ok(!cleaned.includes('【新设定'), '标记应剥离');
    assert.ok(store.pendingEntities.list(b.id).some(p => p.name === '老幺'), '应登记 pending');
    // 2) tidy 建卡
    const r = tidyPendingEntities(b.id, { currentChapter: 11 });
    assert.equal(r.confirmed, 1, '应建角色卡');
    // 3) 点名册可见（李尘 + 老幺）
    const rollCall = characterRollCallText(b.id, { limit: 10 });
    assert.ok(rollCall.includes('老幺'), '点名册应含老幺');
  });
});
