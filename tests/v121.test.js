// V0.93 期待与故事弧：语义近似兑现、逐章推进
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v121-ledger-'));

const store = await import('../server/db/store.js');
const pleasure = await import('../server/engine/pleasure.js');

describe('V0.93 期待账本语义结算', () => {
  test('同一兑现事件即使语序与措辞不同也能匹配', async () => {
    assert.equal(typeof pleasure.hookDescriptionsMatch, 'function');
    assert.equal(pleasure.hookDescriptionsMatch(
      '林晚在城门当众打碎旧敌的门牙',
      '城门旧敌的门牙被林晚当众打碎，围观者震惊',
    ), true);

    const book = store.books.create({ title: '语义钩子测试', genre: '玄幻' });
    const chapter = store.chapters.create(book.id, null, 1, { title: '兑现', status: 'done' });
    store.scenes.create(chapter.id, 1, { content: '林晚在城门前当众击败旧敌。', status: 'done' });
    const hook = store.pleasureHooks.create(book.id, {
      desc: '城门旧敌的门牙被林晚当众打碎，围观者震惊',
      kind: 'short', plantedChapter: 1, dueChapter: 1,
    });

    await pleasure.auditPleasure(book.id, chapter.id, 1);
    assert.equal(store.pleasureHooks.get(hook.id).status, 'paid');
  });
});

describe('V0.93 故事弧逐章推进', () => {
  test('完成章推进主线和正文明确出现的人物弧，不误动未出场人物', () => {
 const book = store.books.create({ title: '示例历史长篇', genre: '历史' });
    const main = store.storyArcs.create(book.id, {
      name: '山河守护主线', type: '主线', openedChapter: 1, targetChapter: 100,
    });
    const aman = store.storyArcs.create(book.id, {
      name: '阿蛮兄弟线', type: '关系线', openedChapter: 9, targetChapter: 40,
    });
    const yujie = store.storyArcs.create(book.id, {
      name: '余玠师徒线', type: '关系线', openedChapter: 4, targetChapter: 70,
    });

    assert.equal(typeof pleasure.reconcileStoryArcsForChapter, 'function');
    const result = pleasure.reconcileStoryArcsForChapter(book.id, 15, {
 chapterText: '主角和阿蛮一起清沟，把迟报的教训写进工册。',
 summary: '主角与阿蛮建立预警程序。',
    });

    assert.deepEqual(new Set(result.advanced), new Set(['山河守护主线', '阿蛮兄弟线']));
    assert.equal(store.storyArcs.get(main.id).last_active_chapter, 15);
    assert.equal(store.storyArcs.get(aman.id).last_active_chapter, 15);
    assert.notEqual(store.storyArcs.get(yujie.id).last_active_chapter, 15);
  });
});
