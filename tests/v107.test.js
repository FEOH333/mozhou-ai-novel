// V0.91 历史阅读回报贯穿快感计划与章后审计
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v107-reward-audit-'));
const ROOT = process.cwd();
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
const pleasure = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/pleasure.js')));
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));

describe('V0.91 阅读回报计划与审计', () => {
  test('历史书级计划 schema 包含回报调色盘，摆脱小中大爽单一路径', () => {
 const text = prompts.bookPleasurePlanInstruction({ bookTitle: '示例历史长篇', genre: '历史', platform: '番茄' });
    assert.match(text, /reward_palette/);
    assert.match(text, /依恋.*生存.*关系.*信息.*战术.*战略/);
    assert.match(text, /失败.*增量/);
  });

  test('历史章后审计接受依恋与余韵，并用“无阅读回报”而非“无爽点”', () => {
 const text = prompts.pleasureAuditInstruction({ bookTitle: '本作', chapterTitle: '灯火', chapterIdx: 1, chapterText: '正文', isHistory: true, plannedRewardMode: '依恋' });
    assert.match(text, /依恋|余韵/);
    assert.match(text, /无阅读回报/);
    assert.doesNotMatch(text, /"无爽点\|/);
  });

  test('历史快感上下文格式化为阅读回报计划和卷内功能', () => {
 const book = store.books.create({ title: '示例历史长篇', genre: '历史', settings: {
      pleasurePlan: { reward_rhythm: { small: '每章回报轮换', medium: '每4章兑现', large: '每10章结算' }, reward_palette: ['依恋', '信息', '关系'] },
    } });
    const volume = store.volumes.create(book.id, 1, { title: '故园成灰' });
    for (let i = 1; i <= 4; i++) store.chapters.create(book.id, volume.id, i, { title: `ch${i}`, outline: { reward_mode: i === 1 ? '依恋' : '信息' } });
    const text = pleasure.buildPleasureContext(book.id, 1);
    assert.match(text, /阅读回报计划/);
    assert.match(text, /依恋、信息、关系/);
    assert.doesNotMatch(text, /【快感计划】小爽/);
  });
});
