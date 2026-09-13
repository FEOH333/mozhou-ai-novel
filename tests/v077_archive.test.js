// V0.77 归档可靠性：模型输出不完整时 fail-closed，落库在同步事务中原子完成
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-v077-archive-'));
process.env.NOVEL_DATA_DIR = tmp;
process.env.NOVEL_MOCK_LLM = '0';

const store = await import('../server/db/store.js');
const { getGlobal, saveGlobal } = await import('../server/config.js');
const { runArchive } = await import('../server/engine/pipeline/archive.js');

const originalFetch = globalThis.fetch;
let savedConfig;

const validPayload = {
  new_rolling: {
    story_state: '主角已经离开旧城。',
    characters: [{ name: '林晚', state: '位于青云山' }],
    unresolved_hooks: ['玉佩仍未解开'],
    key_facts: [{ fact: '林晚持有玉佩', ref: '第1章' }],
    upcoming: '进入宗门。',
  },
  missing: [],
};

before(() => {
  savedConfig = getGlobal();
  saveGlobal({
    apiKey: 'test-key',
    baseUrl: 'http://archive-v077.test',
    provider: 'custom',
    protocol: 'chat',
    deepseekParams: false,
    archiveStrategy: 'auto',
    keepRecentChapters: 1,
    resilience: {
      connectTimeoutMs: 200,
      idleTimeoutMs: 200,
      totalTimeoutMs: 1000,
      maxRetries: 0,
      jitterMs: 0,
      circuitBreaker: { threshold: 100, openMs: 100 },
    },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  try { store.db().exec('DROP TRIGGER IF EXISTS v077_fail_archive_insert'); } catch { /* ignore */ }
});

after(() => {
  saveGlobal(savedConfig);
  globalThis.fetch = originalFetch;
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* ignore */ }
});

function installModelResponse(content, finishReason = 'stop') {
  globalThis.fetch = async () => new Response(JSON.stringify({
    model: 'archive-test-model',
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeArchivableBook() {
  const book = store.books.create({ title: '归档可靠性测试', genre: '玄幻' });
  store.rollingSummaries.set(book.id, '旧滚动摘要：绝不能在失败时覆盖');
  for (let idx = 1; idx <= 4; idx += 1) {
    const chapter = store.chapters.create(book.id, null, idx, { title: `第${idx}章`, status: 'done' });
    const scene = store.scenes.create(chapter.id, 1, {
      content: `第${idx}章正文：林晚握着玉佩走过长街。`,
      status: 'done',
    });
    const historySeq = store.history.append(book.id, 'assistant', scene.content);
    store.scenes.update(scene.id, { historySeq });
  }
  return book;
}

function persistedState(bookId) {
  return {
    rolling: store.rollingSummaries.get(bookId),
    history: store.history.list(bookId),
    archives: store.archives.list(bookId),
    sceneHistorySeqs: store.chapters.list(bookId).flatMap(chapter =>
      store.scenes.list(chapter.id).map(scene => [scene.id, scene.history_seq])),
  };
}

async function expectFailClosed({ content, finishReason = 'stop', code }) {
  const book = makeArchivableBook();
  const beforeState = persistedState(book.id);
  installModelResponse(content, finishReason);

  await assert.rejects(
    runArchive(book.id, { force: true }),
    error => {
      assert.equal(error.code, code);
      return true;
    },
  );

  assert.deepEqual(persistedState(book.id), beforeState);
}

describe('V0.77 归档 fail-closed', () => {
  test('不可解析 JSON 不覆盖摘要、不删历史、不新增归档', async () => {
    await expectFailClosed({ content: '这不是 JSON', code: 'ARCHIVE_INVALID_RESPONSE' });
  });

  test('被容错解析器补闭合的截断 JSON 仍视为无效并 fail-closed', async () => {
    const truncated = JSON.stringify(validPayload).slice(0, -1);
    await expectFailClosed({ content: truncated, code: 'ARCHIVE_INVALID_RESPONSE' });
  });

  test('缺少滚动摘要关键结构不覆盖摘要、不删历史、不新增归档', async () => {
    await expectFailClosed({
      content: JSON.stringify({ new_rolling: { story_state: '只有一个字段' }, missing: [] }),
      code: 'ARCHIVE_INVALID_RESPONSE',
    });
  });

  test('finishReason=length 即使 JSON 可解析也必须 fail-closed', async () => {
    await expectFailClosed({
      content: JSON.stringify(validPayload),
      finishReason: 'length',
      code: 'ARCHIVE_INCOMPLETE_RESPONSE',
    });
  });

  test('归档批次写入失败时事务回滚摘要、历史和场景 history_seq', async () => {
    const book = makeArchivableBook();
    const beforeState = persistedState(book.id);
    installModelResponse(JSON.stringify(validPayload));
    store.db().exec(`
      CREATE TRIGGER v077_fail_archive_insert
      BEFORE INSERT ON book_archives
      WHEN NEW.book_id = '${book.id}'
      BEGIN
        SELECT RAISE(ABORT, 'injected archive failure');
      END
    `);

    await assert.rejects(runArchive(book.id, { force: true }), /injected archive failure/);
    assert.deepEqual(persistedState(book.id), beforeState);
  });
});
