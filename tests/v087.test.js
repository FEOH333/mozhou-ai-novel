// V0.80 契约承诺兑现校验
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v087-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.80 契约承诺兑现校验', () => {
  test('①syncContractPromises：只登记有绝对期限的"前N章"承诺，周期节奏不伪装成第10章债务', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { syncContractPromises } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/promise.js')));
    const b = store.books.create({ title: '承诺书', genre: '玄幻', blurb: 'x' });
    const synced = syncContractPromises(b.id, {
      promises: ['前3章必有打脸', '前5章内获得功法', '每10章一次突破', '每卷末以阶段高潮收束'],
    });
    assert.equal(synced.length, 2);
    assert.equal(synced[0].due, 3);
    assert.equal(synced[1].due, 5);
    assert.deepEqual(synced.map(item => item.text), ['前3章必有打脸', '前5章内获得功法']);
    // 幂等：再 sync 不重复
    syncContractPromises(b.id, { promises: ['前3章必有打脸'] });
    const all = store.contractPromises.list(b.id);
    assert.equal(all.length, 2, '周期规则不应落入一次性兑现账本，同承诺也不应重复');
    assert.equal(all.some(item => /每10章|每卷末/.test(item.text)), false);
  });

  test('②generateBookContract 自动落库契约承诺 + settings.contractStructured', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { generateBookContract } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));
    const b = store.books.create({ title: '契约书', genre: '玄幻', blurb: '被废剑宗弟子捡玉佩' });
    await generateBookContract(b.id, {});
    const promises = store.contractPromises.list(b.id);
    assert.ok(promises.length >= 1, '应落库契约承诺');
    const settings = store.books.settings(b.id);
    assert.ok(settings.contractStructured?.promises, '应存结构化契约');
  });

  test('③checkPromiseFulfillment：到期已兑现（mock met:true）→ status=met', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { syncContractPromises, checkPromiseFulfillment } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/promise.js')));
    const b = store.books.create({ title: '核对书', genre: '玄幻', blurb: 'x' });
    syncContractPromises(b.id, { promises: ['前3章必有打脸'] });
    // 建 3 章并标记 done
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    for (let i = 1; i <= 3; i++) store.chapters.create(b.id, v.id, i, { title: `第${i}章`, status: 'done' });
    const results = await checkPromiseFulfillment(b.id, 3);
    assert.equal(results.length, 1, '应核对到期承诺');
    assert.equal(results[0].met, true, 'mock 默认已兑现');
    const p = store.contractPromises.list(b.id)[0];
    assert.equal(p.status, 'met', '已兑现应标记 met');
  });

  test('④到期未兑现（NOVEL_PROMISE_FAULT）→ 约束注入 + 保持 open', async () => {
    process.env.NOVEL_PROMISE_FAULT = '1'; // mock 返回 met:false
    try {
      const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
      const { syncContractPromises, checkPromiseFulfillment } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/promise.js')));
      const b = store.books.create({ title: '未兑现书', genre: '玄幻', blurb: 'x' });
      syncContractPromises(b.id, { promises: ['前3章必有打脸'] });
      const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
      for (let i = 1; i <= 3; i++) store.chapters.create(b.id, v.id, i, { title: `第${i}章`, status: 'done' });
      const results = await checkPromiseFulfillment(b.id, 3);
      assert.equal(results[0].met, false, '应判定未兑现');
      const p = store.contractPromises.list(b.id)[0];
      assert.equal(p.status, 'open', '未兑现应保持 open 重试窗');
      const cons = store.constraints.list(b.id);
      assert.ok(cons.some(c => c.content.includes('契约承诺未兑现')), '应注入约束');
    } finally {
      delete process.env.NOVEL_PROMISE_FAULT;
    }
  });
});
