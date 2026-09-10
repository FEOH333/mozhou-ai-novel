// V0.77：整章重写安全闸——任何可疑模型输出都不得覆盖原正文
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_FAULT = '';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v077-rewrite-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const polish = await import(pathToFileURL(path.join(ROOT, 'server/engine/polish.js')));
const volumeReview = await import(pathToFileURL(path.join(ROOT, 'server/engine/volumereview.js')));

function prose(label, paragraphs = 45) {
  return Array.from({ length: paragraphs }, (_, i) =>
    `${label}${i + 1}：林晚沿着第${i + 3}级石阶向前，记住墙上不同的刻痕，又与守门弟子核对时辰。`
  ).join('\n\n');
}

describe('V0.77 整章重写安全闸', () => {
  test('纯校验：拦截空输出、截断、明显过短、异常重复与错章，放行完整最小修订', () => {
    assert.equal(typeof polish.validateChapterRewrite, 'function', '应导出统一重写校验器');
    const before = prose('原章');
    const peer = prose('别章');

    for (const [name, after, options, expectedCode] of [
      ['空输出', '  \n', {}, 'REWRITE_EMPTY'],
      ['完成原因表明截断', before, { finishReason: 'length' }, 'REWRITE_TRUNCATED'],
      ['相对旧正文和目标明显过短', '林晚推开门。', { targetChars: 3500 }, 'REWRITE_TOO_SHORT'],
      ['模型异常复读', '他推门看见月光落在石阶上，风从回廊尽头吹来。\n\n'.repeat(35), {}, 'REWRITE_REPETITIVE'],
      ['模型无分段连续复读', '铜铃响过三声，守门人仍没有回头。'.repeat(90), {}, 'REWRITE_REPETITIVE'],
      ['输出显式写成别的章', `第103章\n${before}`, { chapterIdx: 88 }, 'REWRITE_WRONG_CHAPTER'],
      ['输出与其他章节近乎相同', peer, { chapterIdx: 88, peerChapters: [{ idx: 103, text: peer }] }, 'REWRITE_WRONG_CHAPTER'],
    ]) {
      const result = polish.validateChapterRewrite({ before, after, chapterIdx: 88, ...options });
      assert.equal(result.ok, false, `${name}应被拦截`);
      assert.equal(result.code, expectedCode, `${name}应给出稳定诊断码`);
      assert.ok(result.message, `${name}应有可读诊断`);
      assert.ok(result.metrics, `${name}应保留长度/相似度等诊断指标`);
    }

    const complete = before.replace('记住墙上不同的刻痕', '仔细记下墙上新出现的刻痕');
    const accepted = polish.validateChapterRewrite({
      before,
      after: complete,
      finishReason: 'stop',
      targetChars: 2200,
      chapterIdx: 88,
      peerChapters: [{ idx: 103, text: peer }],
    });
    assert.equal(accepted.ok, true, accepted.message);
    assert.equal(accepted.unchanged, false);

    const legacyRepetitive = '旧稿中的回声仍在。'.repeat(80);
    const unchanged = polish.validateChapterRewrite({ before: legacyRepetitive, after: legacyRepetitive, finishReason: 'stop', chapterIdx: 5 });
    assert.equal(unchanged.ok, true, '模型原样返回时没有覆盖动作，不应把旧稿自身的问题误报为新损伤');
    assert.equal(unchanged.unchanged, true);
  });

  test('卷审工单：短输出不覆盖正文，并把失败状态、报告和事件返回给调用者', async () => {
    const book = store.books.create({ title: '卷审防截断', genre: '玄幻' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷', goal: '守住山门', status: 'outlined' });
    const ch1 = store.chapters.create(book.id, volume.id, 1, { title: '前情', status: 'done' });
    const ch2 = store.chapters.create(book.id, volume.id, 2, { title: '守门', status: 'done' });
    store.scenes.create(ch1.id, 1, { content: prose('前情', 8), targetWords: 900, status: 'done' });
    const original = prose('守门');
    store.scenes.create(ch2.id, 1, { content: original, targetWords: 3500, status: 'done' });
    store.summaries.set(ch1.id, book.id, '主角来到山门');
    store.summaries.set(ch2.id, book.id, '主角守住山门');
    const events = [];

    const result = await volumeReview.runVolumeReview(book.id, volume.id, {
      onEvent: (event) => events.push(event), // V0.104 起卷审事件统一为 {type,...} 对象（emitVolumeReviewEvent），与下方全书打磨测试同口径
    });

    assert.equal(store.chapters.fullText(ch2.id), original, '卷审可疑输出不得覆盖正文');
    assert.equal(result.revised, 0);
    assert.equal(result.failedRevisions, 1, '调用结果应显式报告失败修订数');
    assert.equal(result.rewriteFailures[0].code, 'REWRITE_TOO_SHORT');
    assert.ok(events.some((event) => event.type === 'chapter_rewrite_rejected' && event.chapterIdx === 2));

    const row = store.volumeReviews.byVolume(book.id, 1);
    assert.equal(row.status, 'needs_attention', '卷审记录不得伪装成全部完成');
    const report = JSON.parse(row.report_json);
    assert.equal(report.rewrite_failures[0].chapter, 2, '失败诊断应持久化到既有卷审报告');
  });

  test('全书打磨：拒绝错章/短章后正文不变，返回失败清单且写入诊断日志', async () => {
    const book = store.books.create({ title: '打磨防错章', genre: '玄幻' });
    const ch = store.chapters.create(book.id, null, 1, { title: '山门夜战', status: 'done' });
    const original = prose('夜战');
    store.scenes.create(ch.id, 1, { content: original, targetWords: 3500, status: 'done' });
    const events = [];
    const { saveGlobal } = await import(pathToFileURL(path.join(ROOT, 'server/config.js')));
    saveGlobal({
      apiKey: 'test-only-key', baseUrl: 'https://rewrite.test', protocol: 'chat',
      resilience: { maxRetries: 0, jitterMs: 0 },
    });
    const responses = [
      JSON.stringify({ overall: '需修订', priorities: [{ priority: 'P1', chapter: 1, type: 'polish', feedback: '压缩重复描写' }] }),
      JSON.stringify({ checks: [] }),
      '林晚推开门。',
    ];
    const realFetch = global.fetch;
    process.env.NOVEL_MOCK_LLM = '0';
    global.fetch = async () => {
      const content = responses.shift();
      assert.notEqual(content, undefined, '打磨链路不应发出计划外请求');
      return new Response(JSON.stringify({
        id: 'local-test', model: 'local-test-model',
        choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    let result;
    try {
      result = await polish.runPolish(book.id, { onEvent: (event) => events.push(event) });
    } finally {
      global.fetch = realFetch;
      process.env.NOVEL_MOCK_LLM = '1';
    }

    assert.equal(store.chapters.fullText(ch.id), original, '打磨可疑输出不得覆盖正文');
    assert.equal(result.executed, 0);
    assert.equal(result.failed, 1, JSON.stringify({ result, events }));
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].code, 'REWRITE_TOO_SHORT');
    assert.ok(events.some((event) => event.type === 'chapter_rewrite_rejected' && event.idx === 1));
    const logs = store.operationLogs.list({ bookId: book.id, category: 'flow' }).items;
    assert.ok(logs.some((row) => row.level === 'warn' && row.op === 'rewrite_rejected'), '应留存可诊断操作日志');
  });
});
