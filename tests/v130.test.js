// V0.93.8 快感审计还债优先级 + 占位名防护：
// ①审计输入"超期欠债+最近埋设"优先（此前 slice(0,8) 按 planted 升序=最老 8 条，
//   ch20+ 新钩子进不了输入 → ch21 名册钩正文已兑现但台账 open 的根因）；
// ②pending 占位标记名（"X（提及）"）不转正建卡（曾顶替真名卡）；
// ③roster 合并排除占位标记名（曾 贾似道→贾似道（提及）吞真卡）
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v130-hooks-'));
const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const pleasure = await import(pathToFileURL(path.join(ROOT, 'server/engine/pleasure.js')));
const pending = await import(pathToFileURL(path.join(ROOT, 'server/engine/pending.js')));
const roster = await import(pathToFileURL(path.join(ROOT, 'server/engine/roster.js')));

describe('V0.93.8 快感审计还债优先级与占位名防护', () => {
  test('审计输入：超期欠债最优先、其次最近埋设，限流 12 条', () => {
    const hooks = [
      { desc: '老钩1（ch2埋，due ch3，早已过期）', planted_chapter: 2, due_chapter: 3 },
      { desc: '老钩2（ch1埋，due ch2）', planted_chapter: 1, due_chapter: 2 },
      { desc: '新钩1（ch20埋，due ch28）', planted_chapter: 20, due_chapter: 28 },
      { desc: '新钩2（ch21埋，due ch29）', planted_chapter: 21, due_chapter: 29 },
      { desc: '无due钩', planted_chapter: 15, due_chapter: null },
    ];
    const picked = pleasure.prioritizeAuditHooks(hooks, 27, 12);
    assert.deepEqual(picked.map(h => h.desc),
      ['老钩1（ch2埋，due ch3，早已过期）', '老钩2（ch1埋，due ch2）', '新钩2（ch21埋，due ch29）', '新钩1（ch20埋，due ch28）', '无due钩'],
      '超期（due<27）排最前，其余按 planted 从新到旧');
    // 限流
    const many = Array.from({ length: 20 }, (_, i) => ({ desc: `钩${i}`, planted_chapter: i, due_chapter: i + 1 }));
    assert.equal(pleasure.prioritizeAuditHooks(many, 10, 12).length, 12, '限流 12 条');
    // 超期全保留（欠债优先于限流）
    const overdue = Array.from({ length: 8 }, (_, i) => ({ desc: `欠${i}`, planted_chapter: i, due_chapter: i + 1 }));
    const recent = Array.from({ length: 20 }, (_, i) => ({ desc: `近${i}`, planted_chapter: 30 + i, due_chapter: null }));
    const picked2 = pleasure.prioritizeAuditHooks([...recent, ...overdue], 27, 12);
    assert.ok(picked2.slice(0, 8).every(h => h.desc.startsWith('欠')), '超期欠债必须全部在输入里');
  });

  test('pending 占位标记名不转正（保留观察，等待具名）', () => {
    const book = store.books.create({ title: '占位名测试', genre: '历史' });
    store.pendingEntities.add(book.id, { name: '贾似道（提及）', context: '阿蛮愤骂其主使余玠之死', sourceChapter: 25 });
    store.pendingEntities.add(book.id, { name: '孙成', context: '候补兵，随队巡逻', sourceChapter: 23 });
    const stats = pending.tidyPendingEntities(book.id, { currentChapter: 27 });
    assert.equal(stats.confirmed, 1, '只有真名孙成转正');
    const chars = store.characters.list(book.id).map(c => c.name);
    assert.ok(chars.includes('孙成'), '真名应建卡');
    assert.ok(!chars.some(n => n.includes('提及')), '占位标记名不得建卡');
    const stillPending = store.pendingEntities.list(book.id);
    assert.ok(stillPending.some(p => p.name === '贾似道（提及）' && p.status === 'pending'), '占位名保留 pending 等待具名');
  });

  test('roster 合并排除占位标记名：真名卡不被并入占位卡', () => {
    const book = store.books.create({ title: '合并保护测试', genre: '历史' });
    store.characters.create(book.id, { name: '贾似道', tier: 'minor', firstChapter: 17, lastChapter: 17 });
    store.characters.create(book.id, { name: '贾似道（提及）', tier: 'extra', firstChapter: 25, lastChapter: 25 });
    store.characters.create(book.id, { name: '黑衣人', tier: 'extra', firstChapter: 3 });
    store.characters.create(book.id, { name: '黑衣人（阿影）', tier: 'minor', firstChapter: 4 });
    const merges = roster.localMergeSuggest(book.id);
    assert.ok(!merges.some(m => m.from === '贾似道' || m.to === '贾似道（提及）'),
      '占位标记名不参与合并（真名卡不得被并入占位卡）');
    // 非占位括号别名（黑衣人（阿影））不受影响——仍可被建议合并（V0.65 行为保留）
    assert.ok(merges.some(m => (m.from === '黑衣人' && m.to === '黑衣人（阿影）') || (m.from === '黑衣人（阿影）' && m.to === '黑衣人')),
      '合法括号别名（阿影）仍按 V0.65 规则参与合并');
  });
});
