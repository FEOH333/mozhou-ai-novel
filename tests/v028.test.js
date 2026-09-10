// V0.28 测试：SSE 生成进度 / 设定自动生成 / 抽取增强 / 操作日志
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v028-'));
process.env.NOVEL_NO_OPEN = '1';

test('V0.28: 设定自动生成——世界观/人物/地点/物品/势力/世界书全落库', async () => {
  const store = await import('../server/db/store.js');
  const settings = await import('../server/engine/settings.js');
  const outline = await import('../server/engine/outline.js');
  const b = store.books.create({ title: '未命名', genre: '玄幻', platform: '番茄', blurb: '废柴剑子捡到玉佩' });
  await outline.generateBookContract(b.id, { genre: '玄幻', blurb: '废柴剑子捡到玉佩', platform: '番茄' });
  await outline.generateBookOutline(b.id, {});
  const r = await settings.generateBookSettings(b.id);
  assert.equal(r.ok, true, '设定生成应成功');
  assert.ok(r.counts.locations >= 1 && r.counts.items >= 1 && r.counts.factions >= 1 && r.counts.worldbook >= 1);
  assert.ok((store.materials.get(b.id, 'world')?.content || '').length > 50, '世界观材料应落库');
  // V0.59 整合：人物卡不再写文本材料（单一事实源=characters 表），断言角色落库
  assert.ok(store.characters.list(b.id).some(c => c.name.includes('林晚')), '角色库应含主角');
  assert.ok(store.locations.list(b.id).length >= 1, '地点卡应存在');
  assert.ok(store.worldbook.list(b.id).length >= 1, '世界书词条应存在');
  // 幂等：已有设定则跳过
  const r2 = await settings.generateBookSettings(b.id);
  assert.equal(r2.skipped, true, '二次调用应跳过');
});

test('V0.28: 设定生成失败不抛异常且报告错误', async () => {
  const settings = await import('../server/engine/settings.js');
  const r = await settings.generateBookSettings('bk-不存在');
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('V0.28: 抽取增强——new_entities 带 type 自动写实体卡', async () => {
  const store = await import('../server/db/store.js');
  const outline = await import('../server/engine/outline.js');
  const settle = await import('../server/engine/settle.js');
  const b = store.books.create({ title: 'T3', genre: '玄幻', blurb: 'x' });
  const vol = store.volumes.create(b.id, 1, { title: '第一卷' });
  const ch = store.chapters.create(b.id, vol.id, 1, { title: '第一章' });
  await outline.generateChapterOutline(b.id, ch.id);
  // 写入场景正文（settle 需要 fullText）
  store.scenes.create(ch.id, 1, { beat: '测试场景', content: '林晚走进青云城，城门守卫拦住了他。', status: 'done' });
  await settle.settleChapter(b.id, ch.id, {
    data: {
      facts: [{ subject: '林晚', predicate: '位于', object: '青云城' }],
      character_updates: [],
      timeline: [],
      foreshadow_actions: [],
      summary: '测试',
      new_entities: [
        { name: '青云城', type: 'location', context: '林晚所在的城市，繁华但暗流涌动' },
        { name: '聚灵丹', type: 'item', context: '一枚可加速修炼的丹药' },
        { name: '天罗皇朝', type: 'faction', context: '暗中追查玉佩的王朝' },
      ],
    },
  });
  assert.ok(store.locations.list(b.id).some(e => e.name === '青云城'), '地点卡应自动创建');
  assert.ok(store.items.list(b.id).some(e => e.name === '聚灵丹'), '物品卡应自动创建');
  assert.ok(store.factions.list(b.id).some(e => e.name === '天罗皇朝'), '势力卡应自动创建');
});

test('V0.28: 日志系统——三类记录/过滤查询/容量清理', async () => {
  const store = await import('../server/db/store.js');
  const { logApi, logLlm, logFlow, logOp } = await import('../server/util/oplog.js');
  store.operationLogs.clear();
  logApi({ method: 'GET', path: '/api/books', status: 200, durationMs: 12 });
  logLlm({ task: 'write_scene', model: 'deepseek-v4-flash', durationMs: 3400, ok: true, retries: 1 });
  logFlow({ op: 'pilot_start', bookId: 'bk-x', detail: '目标章数=全部' });
  assert.equal(store.operationLogs.count(), 3, '三条日志');
  // 过滤
  const llmOnly = store.operationLogs.list({ category: 'llm' });
  assert.equal(llmOnly.total, 1);
  assert.equal(llmOnly.items[0].op, 'write_scene');
  const bookOnly = store.operationLogs.list({ bookId: 'bk-x' });
  assert.equal(bookOnly.total, 1);
  assert.equal(bookOnly.items[0].op, 'pilot_start');
  // 容量清理：max=3 时再加一条应裁掉最旧
  logOp({ category: 'flow', op: 'extra', max: 3 });
  assert.equal(store.operationLogs.count(), 3, '超过 max 自动清理');
  const items = store.operationLogs.list({ limit: 10 }).items;
  assert.ok(!items.some(i => i.op === 'GET /api/books'), '最旧的 GET 应被清理');
});

test('V0.28: 生成进度——书级大纲 onEvent 收到阶段事件', async () => {
  const store = await import('../server/db/store.js');
  const outline = await import('../server/engine/outline.js');
  const b = store.books.create({ title: 'T4', genre: '玄幻', blurb: 'x' });
  await outline.generateBookContract(b.id, { genre: '玄幻', blurb: 'x', platform: '番茄' });
  const events = [];
  await outline.generateBookOutline(b.id, {}, { onEvent: (ev) => events.push(ev) });
  assert.ok(events.some(e => e.type === 'stage' && e.message && e.message.includes('书级大纲')), '应收到书级大纲阶段事件');
  const volEvents = [];
  const vol = store.volumes.list(b.id)[0];
  await outline.generateVolumeOutline(b.id, vol.id, {}, { onEvent: (ev) => volEvents.push(ev) });
  assert.ok(volEvents.some(e => e.type === 'stage'), '卷大纲应收到阶段事件');
});
