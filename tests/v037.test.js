// V0.37：角色生命周期——死亡自动退场 + 配角卡自动丰富 + 点名册注入（写作/细纲/审校硬规则）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// V0.47 修复：必须在任何 server 模块加载前设置（首个测试加载 characters.js→store 正式库，
// 第二个测试再设 env 已晚——模块缓存生效，测试书污染正式库）
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v037-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();

describe('V0.37 角色生命周期与防诈尸机制', () => {
  test('detectDeath：状态键/值命中死亡词返回 true', async () => {
    const { detectDeath } = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/characters.js')));
    assert.equal(detectDeath(['位置=青云城', '状态=死亡']), true, '状态=死亡应检出');
    assert.equal(detectDeath(['状态=战死']), true);
    assert.equal(detectDeath(['状态=陨落']), true);
    assert.equal(detectDeath(['死因=被反派偷袭']), true, '死因键应检出');
    assert.equal(detectDeath(['位置=青云城', '实力=练气三层']), false);
    assert.equal(detectDeath(['伤势=重伤']), false, '重伤不算死亡');
  });

  test('结算标记死亡：deceased 落库 + 死亡章节 + 时间线事件', async () => {
    process.env.NOVEL_MOCK_LLM = '1';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v037-'));
    process.env.NOVEL_DATA_DIR = tmp;
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const settle = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/settle.js')));
    const { applyDeathAndCardEnrich } = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/characters.js')));
    const b = store.books.create({ title: '测试书', genre: '玄幻', blurb: 'x' });
    // 预建两个角色
    store.characters.create(b.id, { name: '林晚', card: { role: '主角' }, state: { 位置: '青云城' } });
    store.characters.create(b.id, { name: '赵无涯', card: { role: '反派' }, state: { 位置: '剑冢' } });
    // 结算：林晚死亡 + 赵无涯状态变化 + 配角注记
    const ch = store.chapters.create(b.id, 'vol-1', 1, { title: '第一章' });
    await store.chapters.update(ch.id, { status: 'settled' });
    const r = applyDeathAndCardEnrich(b.id, [
      { name: '林晚', changes: ['状态=死亡', '死因=被赵无涯偷袭', '位置=剑冢'] },
      { name: '赵无涯', changes: ['实力=金丹期'] },
    ], [
      { name: '赵无涯', note: '性格阴鸷，对林晚恨之入骨' },
    ], 1);
    assert.deepEqual(r.deceased, ['林晚'], '应标记林晚死亡');
    const lin = store.characters.list(b.id).find(c => c.name === '林晚');
    assert.equal(lin.deceased, 1, 'deceased 应落库');
    assert.equal(lin.death_chapter, 1, '死亡章节应为 1');
    const state = JSON.parse(lin.state_json || '{}');
    assert.ok(state['死因']?.includes('偷袭'), '死因应记录');
    const deadList = store.characters.deceasedList(b.id);
    assert.equal(deadList.length, 1, 'deceasedList 应返回 1 人');
    // 卡片丰富
    const zhao = store.characters.list(b.id).find(c => c.name === '赵无涯');
    const card = JSON.parse(zhao.card_json || '{}');
    assert.ok(card.description?.includes('阴鸷'), '配角卡应并入性格注记');
    delete process.env.NOVEL_MOCK_LLM;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('点名册：活跃角色带状态、退场角色带死亡档案与硬规则', async () => {
    process.env.NOVEL_MOCK_LLM = '1';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v037b-'));
    process.env.NOVEL_DATA_DIR = tmp;
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { characterRollCallText } = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/characters.js')));
    const b = store.books.create({ title: '测试书', genre: '玄幻', blurb: 'x' });
    store.characters.create(b.id, { name: '林晚', card: { role: '主角' }, state: { 位置: '青云城', 实力: '练气三层' } });
    store.characters.create(b.id, { name: '赵无涯', card: { role: '反派' }, state: { 死因: '被雷劫劈死' } });
    store.characters.update(store.characters.list(b.id).find(c => c.name === '赵无涯').id, { deceased: true, deathChapter: 5 });
    const text = characterRollCallText(b.id);
    assert.ok(text.includes('【当前出场角色】'), '应有活跃角色段');
    assert.ok(text.includes('林晚'), '应含林晚');
    assert.ok(text.includes('位置=青云城'), '应含角色状态');
    assert.ok(text.includes('【已退场角色（死亡）】'), '应有退场段');
    assert.ok(text.includes('赵无涯'), '应含赵无涯');
    assert.ok(text.includes('第5章死亡'), '应含死亡章节');
    assert.ok(text.includes('不得在正文中以任何形式重新登场'), '应有硬规则');
    delete process.env.NOVEL_MOCK_LLM;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('注入接线：正文/细纲/审校指令均传 rollCallText 或 deceasedText', () => {
    const w = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/write.js'), 'utf8');
    const o = fs.readFileSync(path.join(ROOT, 'server/engine/planning/outline.js'), 'utf8');
    const a = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/audit.js'), 'utf8');
    const p = fs.readFileSync(path.join(ROOT, 'server/engine/prompts.js'), 'utf8');
    assert.ok(w.includes('characterRollCallText(bookId'), 'write.js 应注入点名册');
    assert.ok(w.includes('rollCallText,'), 'writeSceneInstruction 应传参');
    assert.ok(o.includes('rollCallText: characterRollCallText'), '细纲应注入点名册');
    assert.ok(a.includes('deceasedText: characterRollCallText'), '审校应注入退场名单');
    assert.ok(p.includes('rollCallText = \'\''), 'prompts 指令应支持 rollCallText');
    assert.ok(p.includes('deceasedText = \'\''), 'auditInstruction 应支持 deceasedText');
    assert.ok(p.includes('character_notes'), '结算指令应含 character_notes');
    assert.ok(p.includes('状态=死亡'), '结算指令应指导死亡状态写法');
  });
});
