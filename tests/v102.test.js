// V0.91 数据安全：自动质检零破坏、章节字数一致、缺失正文从最佳快照只增恢复
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v102-safety-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const signing = await import(pathToFileURL(path.join(ROOT, 'server/engine/signing.js')));
const safety = await import(pathToFileURL(path.join(ROOT, 'server/engine/data_safety.js')));
const pilot = await import(pathToFileURL(path.join(ROOT, 'server/engine/pilot.js')));

function completedChapter(bookId, volumeId, idx, text) {
  const chapter = store.chapters.create(bookId, volumeId, idx, {
    title: `第${idx}章`, status: 'done', wordCount: text.length,
    outline: { goal: `目标${idx}`, scenes: [{ id: 's1', beat: `节拍${idx}` }] },
  });
  store.scenes.create(chapter.id, 1, { content: text, beat: `节拍${idx}`, status: 'done' });
  store.summaries.set(chapter.id, bookId, `摘要${idx}`);
  store.chapterSettlements.set(bookId, chapter.id, { contentHash: `hash-${idx}`, result: { ok: true } });
  return chapter;
}

describe('V0.91 自动质检零破坏', () => {
  test('签约评审需要修订时只登记建议，不删除或降级已完成正文', async () => {
    const book = store.books.create({ title: '零破坏评审', genre: '历史', platform: '番茄' });
    const volume = store.volumes.create(book.id, 1, { title: '蜀中旧事' });
    const chapter = completedChapter(book.id, volume.id, 1, '母亲把尚有余温的炊饼塞进他怀里。'.repeat(80));
    const fact = store.facts.create(book.id, { subject: '陆止戈', predicate: '年龄', object: '九岁', sourceChapter: 1 });
    store.materials.set(book.id, 'signing_review', '结论：revise');
    const before = {
      text: store.chapters.fullText(chapter.id),
      outline: store.chapters.get(chapter.id).outline_json,
      status: store.chapters.get(chapter.id).status,
      scenes: store.scenes.list(chapter.id).length,
      summary: store.summaries.get(chapter.id).summary,
      settlement: store.chapterSettlements.get(chapter.id).content_hash,
    };

    const result = await signing.rewriteOpening(book.id, {
      toChapter: 1,
      feedback: '[历史质感] 童年战力过强，改为依靠地形与成年人协作。',
    });

    assert.equal(result.ok, true);
    assert.equal(result.staged, true, '自动评审应进入待修订状态，而非先删稿');
    assert.equal(store.chapters.fullText(chapter.id), before.text);
    assert.equal(store.chapters.get(chapter.id).outline_json, before.outline);
    assert.equal(store.chapters.get(chapter.id).status, before.status);
    assert.equal(store.scenes.list(chapter.id).length, before.scenes);
    assert.equal(store.summaries.get(chapter.id).summary, before.summary);
    assert.equal(store.chapterSettlements.get(chapter.id).content_hash, before.settlement);
    assert.equal(store.facts.get(fact.id).status, 'active');
    assert.equal(store.materials.get(book.id, 'signing_review').content, '结论：revise');
    assert.match(store.materials.get(book.id, 'signing_revision_brief').content, /童年战力过强/);
  });

  test('章节 create/update 同时接受 wordCount 与 word_count，数据库字数不再与正文状态撕裂', () => {
    const book = store.books.create({ title: '字数一致性', genre: '历史' });
    const c1 = store.chapters.create(book.id, null, 1, { title: '一', wordCount: 1234 });
    const c2 = store.chapters.create(book.id, null, 2, { title: '二', word_count: 2345 });
    assert.equal(store.chapters.get(c1.id).word_count, 1234);
    assert.equal(store.chapters.get(c2.id).word_count, 2345);
    store.chapters.update(c1.id, { word_count: 3456 });
    assert.equal(store.chapters.get(c1.id).word_count, 3456);
  });
});

describe('V0.91 快照正文自愈', () => {
  test('只恢复当前正文为空的章，并为每章选择所有快照中内容最长的版本', () => {
    const book = store.books.create({ title: '快照自愈', genre: '历史' });
    const volume = store.volumes.create(book.id, 1, { title: '旧山河' });
    const damaged = store.chapters.create(book.id, volume.id, 1, {
      title: '晨炊未冷', status: 'planned', wordCount: 4200, outline: { beat: '保留当前规划' },
    });
    const healthy = completedChapter(book.id, volume.id, 2, '当前第二章正文，不得被旧快照覆盖。'.repeat(30));

    store.snapshots.add(book.id, {
      label: '较短旧稿', source: 'manual', data: { chapters: [
        { idx: 1, title: '旧一', status: 'done', word_count: 100, scenes: [{ idx: 1, content: '短稿', status: 'done' }] },
        { idx: 2, title: '旧二', status: 'done', word_count: 100, scenes: [{ idx: 1, content: '不该覆盖第二章', status: 'done' }] },
      ] },
    });
    const longest = '晨烟沿着瓦檐散开，弟弟举着缺了一角的糖人。'.repeat(120);
    const best = store.snapshots.add(book.id, {
      label: '签约评审前完整稿', source: 'manual', data: { chapters: [
        { idx: 1, title: '完整一', status: 'done', word_count: 4200, outline_json: '{"old":true}', scenes: [
          { idx: 1, pov: '陆止戈', location: '灶房', beat: '晨炊', content: longest, status: 'done', target_words: 1200 },
        ] },
      ] },
    });
    // 恢复器必须扫描全部快照，不能受书库界面“最近 20 个”的展示上限影响。
    for (let i = 0; i < 20; i++) {
      store.snapshots.add(book.id, {
        label: `较新的空快照${i + 1}`,
        source: 'auto',
        data: { chapters: [] },
      });
    }
    const healthyBefore = store.chapters.fullText(healthy.id);

    const preview = safety.recoverMissingChapterContent(book.id, { dryRun: true });
    assert.deepEqual(preview.candidates.map(c => c.idx), [1]);
    assert.equal(preview.candidates[0].snapshotId, best.id);
    assert.equal(store.scenes.list(damaged.id).length, 0, 'dryRun 不写数据库');

    const recovered = safety.recoverMissingChapterContent(book.id);
    assert.equal(recovered.recovered, 1);
    assert.equal(store.chapters.fullText(damaged.id), longest);
    assert.equal(store.chapters.get(damaged.id).status, 'done');
    assert.equal(store.chapters.get(damaged.id).outline_json, '{"beat":"保留当前规划"}', '只恢复正文，不覆盖当前规划');
    assert.equal(store.chapters.fullText(healthy.id), healthyBefore, '已有正文绝不覆盖');
    assert.deepEqual(
      store.narrativeRevisions.blocking(book.id)?.manifest?.changed_chapters,
      [1],
      '从快照救回的正文必须暂停续写，先重建同版本摘要/人物/伏笔/纲要',
    );
  });

  test('pilot 启动修复入口执行同一只增恢复器并发出可见事件', () => {
    const book = store.books.create({ title: '启动自愈', genre: '历史' });
    const damaged = store.chapters.create(book.id, null, 1, { title: '空章', status: 'planned', wordCount: 900 });
    store.snapshots.add(book.id, { label: '完整稿', data: { chapters: [{
      idx: 1, status: 'done', word_count: 900,
      scenes: [{ idx: 1, beat: '旧节拍', content: '可恢复的旧正文'.repeat(80), status: 'done' }],
    }] } });
    const events = [];
    const result = pilot.repairMissingDraftsBeforePilot(book.id, { onEvent: event => events.push(event) });
    assert.equal(result.recovered, 1);
    assert.ok(store.chapters.fullText(damaged.id).includes('可恢复的旧正文'));
    assert.ok(events.some(event => event.type === 'content_recovered' && event.count === 1));
  });

  test('同一章优先恢复最新完整快照，不能因旧稿更长而把已精修版本救回旧稿', () => {
    const book = store.books.create({ title: '修订稿恢复优先级', genre: '历史' });
    const damaged = store.chapters.create(book.id, null, 1, {
      title: '归骨', status: 'done', wordCount: 3000,
    });
    store.snapshots.add(book.id, { label: '较长旧稿', data: { chapters: [{
      idx: 1, status: 'done', word_count: 5000,
      scenes: [{ idx: 1, content: '旧稿中的完整遗体错误。'.repeat(300), status: 'done' }],
    }] } });
    // created_at 由 SQLite 写入毫秒值；确保第二份快照严格更新。
    const newer = store.snapshots.add(book.id, { label: '精修后安全快照', source: 'revision', data: { chapters: [{
      idx: 1, status: 'revised', word_count: 3000,
      scenes: [{ idx: 1, content: '精修后只携骨殖。'.repeat(120), status: 'revised' }],
    }] } });
    store.db().prepare('UPDATE snapshots SET created_at=created_at+1 WHERE id=?').run(newer.id);

    const preview = safety.recoverMissingChapterContent(book.id, { dryRun: true });
    assert.equal(preview.candidates[0].snapshotId, newer.id);
    const result = safety.recoverMissingChapterContent(book.id);
    assert.equal(result.recovered, 1);
    assert.match(store.chapters.fullText(damaged.id), /精修后只携骨殖/);
    assert.doesNotMatch(store.chapters.fullText(damaged.id), /完整遗体错误/);
  });
});
