// V0.93 完成态单一真源：修订章必须同时具备完整场景与结算证据
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v122-completion-'));

const store = await import('../server/db/store.js');
const { isCompletedChapter } = await import('../server/engine/chapter_status.js');
const { reviewDueVolumes } = await import('../server/engine/volumereview.js');
const { settleChapter } = await import('../server/engine/settle.js');
const { applyValidatedChapterRewrite } = await import('../server/engine/polish.js');

const sha256 = text => createHash('sha256').update(text).digest('hex');

function createRevisedChapter(bookId, volumeId, idx, { complete = true } = {}) {
  const chapter = store.chapters.create(bookId, volumeId, idx, {
    title: `修订章${idx}`, status: 'revised',
  });
  if (complete) {
    store.scenes.create(chapter.id, 1, {
      content: `第${idx}章修订后的完整正文。`, status: 'revised',
    });
    store.summaries.set(chapter.id, bookId, `第${idx}章摘要`);
  }
  return chapter;
}

describe('V0.93 完成态单一真源', () => {
  test('裸 revised 不是完成章，具备完整正文与摘要后才是完成章', () => {
    const book = store.books.create({ title: '完成态测试', genre: '历史' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
    const complete = createRevisedChapter(book.id, volume.id, 1);
    const incomplete = createRevisedChapter(book.id, volume.id, 2, { complete: false });

    assert.equal(isCompletedChapter({ status: 'done' }), true);
    assert.equal(isCompletedChapter({ status: 'settled' }), true);
    assert.equal(isCompletedChapter(complete), true);
    assert.equal(isCompletedChapter(incomplete), false);
    assert.equal(isCompletedChapter({ status: 'revised' }), false);
  });

  test('完整修订卷进入卷体检候选，避免卷审被状态写法漏掉', () => {
    const book = store.books.create({ title: '卷审完成态测试', genre: '历史' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
    createRevisedChapter(book.id, volume.id, 1);
    createRevisedChapter(book.id, volume.id, 2);

    assert.deepEqual(reviewDueVolumes(book.id), [
      { idx: 1, id: volume.id, reason: '写完未体检' },
    ]);
  });

  test('旧书完整修订章即使已有摘要也不能伪补指纹，必须先同版重建', async () => {
    const book = store.books.create({ title: '结算幂等测试', genre: '历史' });
    const chapter = createRevisedChapter(book.id, null, 1);

    await assert.rejects(
      () => settleChapter(book.id, chapter.id),
      error => error.code === 'NARRATIVE_STATE_LEGACY' && /先重建/.test(error.message),
    );
    assert.equal(store.chapterSettlements.get(chapter.id), undefined);
  });

  test('安全精修换正文但不再伪刷新旧结算；自动创作等待全书派生回放', async () => {
    const book = store.books.create({ title: '精修指纹测试', genre: '历史' });
 const before = '主角先把险情报给老兵甲，再按分派复读撤离口令。'.repeat(20);
    const after = before.replaceAll('险情', '沟渠堵塞');
    const chapter = store.chapters.create(book.id, null, 1, {
      title: '迟了半声', status: 'done', wordCount: before.length,
    });
    store.scenes.create(chapter.id, 1, { content: before, status: 'done' });
 store.summaries.set(chapter.id, book.id, '主角学会先报告再行动。');
    store.chapterSettlements.set(book.id, chapter.id, {
 contentHash: sha256(before), result: { summary: '主角学会先报告再行动。', facts: { created: 1 } },
    });

    const applied = applyValidatedChapterRewrite(book.id, chapter, after);

    assert.equal(applied.ok, true);
    // V0.100.16：引擎闸对零换行超长候选做确定性重分段，落库正文以 normalize 后为准。
    const { normalizeChapterParagraphs } = await import('../server/engine/polish.js');
    const storedAfter = normalizeChapterParagraphs(after);
    assert.equal(store.chapters.fullText(chapter.id), storedAfter);
    assert.equal(store.chapters.get(chapter.id).word_count, [...after].filter(char => /[\u4e00-\u9fff]/.test(char)).length);
    assert.equal(store.chapters.get(chapter.id).status, 'done', '编辑修订不能把完成章降为模糊 revised');
    assert.equal(store.scenes.list(chapter.id)[0].status, 'revised');
    assert.equal(store.chapterSettlements.get(chapter.id), undefined, '旧事实投影不能只换 hash 后继续沿用');
    assert.equal(store.summaries.get(chapter.id), undefined, '旧摘要必须同步失效');
    assert.equal(store.narrativeRevisions.blocking(book.id)?.status, 'stale');
    await assert.rejects(() => settleChapter(book.id, chapter.id), error => error.code === 'NARRATIVE_STATE_STALE');
  });

  test('旧结算指纹本已失配时拒绝覆盖正文，不能掩盖派生状态污染', () => {
    const book = store.books.create({ title: '精修失败关闭测试', genre: '历史' });
    const before = '原正文'.repeat(100);
    const chapter = store.chapters.create(book.id, null, 1, { status: 'done' });
    store.scenes.create(chapter.id, 1, { content: before, status: 'done' });
    store.chapterSettlements.set(book.id, chapter.id, {
      contentHash: sha256('另一份旧正文'), result: { facts: { created: 3 } },
    });

    const applied = applyValidatedChapterRewrite(book.id, chapter, '候选正文'.repeat(100));

    assert.equal(applied.ok, false);
    assert.equal(applied.code, 'REWRITE_SETTLEMENT_STALE');
    assert.equal(store.chapters.fullText(chapter.id), before);
  });

  test('多场景精修以实际落库全文登记 stale 指纹，不受场景拼接空行影响', async () => {
    const book = store.books.create({ title: '多场景指纹测试', genre: '历史' });
    const chapter = store.chapters.create(book.id, null, 1, { status: 'settled' });
    store.scenes.create(chapter.id, 1, { content: '第一场原文。'.repeat(80), status: 'done' });
    store.scenes.create(chapter.id, 2, { content: '第二场原文。'.repeat(80), status: 'done' });
    const before = store.chapters.fullText(chapter.id);
    store.summaries.set(chapter.id, book.id, '两场完成撤离演练。');
    store.chapterSettlements.set(book.id, chapter.id, {
      contentHash: sha256(before), result: { summary: '两场完成撤离演练。' },
    });
    store.chapterHealth.upsert({
      bookId: book.id, chapterId: chapter.id, idx: 1,
      verdict: 'fix', issues: 1, highIssues: 1, failed: 1, wordCount: 100,
    });

    const applied = applyValidatedChapterRewrite(
      book.id,
      chapter,
      '第一场修订正文。'.repeat(75) + '\n\n' + '第二场修订正文。'.repeat(75),
    );
    const storedText = store.chapters.fullText(chapter.id);

    assert.equal(applied.ok, true);
    assert.equal(applied.afterHash, sha256(storedText));
    assert.equal(store.chapterSettlements.get(chapter.id), undefined);
    assert.equal(store.chapterHealth.getByChapter(chapter.id), null, '旧健康快照针对旧正文，精修后必须失效');
    assert.equal(store.narrativeRevisions.blocking(book.id)?.manifest?.chapter_hashes?.[1], sha256(storedText));
    await assert.rejects(() => settleChapter(book.id, chapter.id), error => error.code === 'NARRATIVE_STATE_STALE');
  });
});
