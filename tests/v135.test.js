// V0.93.11 系统性检查修复（doctor 实证问题落地）：
// ①settle 实体类型门（"青铜薄片"不再冒充 location；与 doctor 检测同源词表）
// ②doctor 时效阈值与续卷注入阈值同源（15 章，此前 12 vs 15 两把尺子）
// ③doctor 缺摘要/health 陈旧只在完成态章判定（planned/drafted 过程态不误报）
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v135-syscheck-'));
const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const names = await import(pathToFileURL(path.join(ROOT, 'server/engine/names.js')));
const settle = await import(pathToFileURL(path.join(ROOT, 'server/engine/settle.js')));
const doctor = await import(pathToFileURL(path.join(ROOT, 'server/maintenance/doctor.js')));
const continuation = await import(pathToFileURL(path.join(ROOT, 'server/engine/continuation.js')));

describe('V0.93.11 系统性检查修复', () => {
  test('实体类型门：物品/短语名不得冒充地点/势力/物品（与 doctor 同源）', () => {
    // doctor 实证的存量误卡（修仙书 locations/factions/items 错类）
    assert.ok(names.entityNamePlausible('locations', '青铜薄片').length > 0, '青铜薄片不该是 location');
    assert.ok(names.entityNamePlausible('locations', '守碑人手札').length > 0, '手札不该是 location');
    assert.ok(names.entityNamePlausible('locations', '另一把活钥').length > 0, '活钥不该是 location');
    assert.ok(names.entityNamePlausible('locations', '烛火不熄，源头在石下').length > 0, '描述短语不该是 location');
    assert.ok(names.entityNamePlausible('factions', '旧阵基石门').length > 0, '石门不该是 faction');
    assert.ok(names.entityNamePlausible('factions', '铁门').length > 0, '铁门不该是 faction');
    assert.ok(names.entityNamePlausible('items', '三个守印人').length > 0, '人/群体不该是 item');
    assert.ok(names.entityNamePlausible('items', '三组鞋印').length > 0, '痕迹不该是 item');
    // 正例：正常地点/势力/物品不误伤
    assert.equal(names.entityNamePlausible('locations', '青阳镇北坡').length, 0);
    assert.equal(names.entityNamePlausible('factions', '玄幽殿').length, 0);
    assert.equal(names.entityNamePlausible('items', '拼合钥匙').length, 0);
    // 空名/超长
    assert.ok(names.entityNamePlausible('locations', '').length > 0);
    assert.ok(names.entityNamePlausible('locations', '一个非常非常非常非常非常非常非常长的地点名称描述文字').length > 0);
  });

  test('settle 建卡走实体类型门：模型自报错类实体不建卡（进 pending）', async () => {
    const book = store.books.create({ title: '实体门测试', genre: '玄幻' });
    const ch = store.chapters.create(book.id, null, 1, { title: '第一章' });
    store.chapters.update(ch.id, { outline: { title: '第一章', scenes: [] } });
    store.scenes.create(ch.id, 1, { pov: 'X', location: '青阳镇', beat: 'b', targetWords: 100, status: 'done', content: '内容。' });
    await settle.settleChapter(book.id, ch.id, { data: {
      facts: [],
      character_updates: [],
      timeline: [],
      foreshadow_actions: [],
      character_notes: [],
      character_emotional: [],
      new_entities: [
        { name: '青铜薄片', type: 'location', context: '门缝内侧发现' },
        { name: '青阳镇北坡', type: 'location', context: '场景地点' },
      ],
      summary: '第一章摘要',
      rolling_update: '第一章进展',
    } });
    const locations = store.locations.list(book.id);
    assert.deepEqual(locations.map(l => l.name), ['青阳镇北坡'], '错类实体不建卡，正例正常建卡');
    const pending = store.pendingEntities.list(book.id);
    assert.ok(pending.some(p => p.name === '青铜薄片'), '错类实体进 pending 等待人工确认');
  });

  test('doctor 时效阈值与续卷注入阈值同源（15 章）', () => {
    assert.equal(doctor.DEFAULTS.staleMaterialAfterChapters, continuation.STALE_MATERIAL_AFTER_CHAPTERS, 'doctor 与续卷注入应共用同一阈值常量');
    assert.equal(doctor.DEFAULTS.staleMaterialAfterChapters, 15);
  });

  test('doctor 缺摘要/health 陈旧只在完成态章判定', () => {
    const mkCh = (status, idx = 1, wordCount = 1000) => ({ id: `ch-${status}-${idx}`, idx, status, word_count: wordCount });
 // summaries：planned/drafted 过程态不报缺摘要（实测 ch27-34 误报修复）
    const db = { prepare: () => ({ all: () => [], get: () => null }) };
    const chs = [mkCh('done'), mkCh('drafted'), mkCh('planned')];
    const summaries = doctor.checkSummaries(db, 'bk', chs);
    assert.equal(summaries.missing.length, 1, '只有 done 报缺摘要');
    assert.equal(summaries.missing[0].status, 'done');
    // health：drafted 的中止快照（word_count=0 vs 当前在途字数）不算陈旧
    // 构造有 chapter_health 行的 mock db：hasTable=true、health 行 word_count=0、idx=1
    const healthDb = {
      prepare: (sql) => {
        if (sql.includes('sqlite_master')) return { get: () => ({ name: 'chapter_health' }) };
        if (sql.includes('FROM chapter_health')) return { all: () => [{ id: 1, chapter_id: 'ch-drafted-1', idx: 1, word_count: 0, created_at: 1 }] };
        return { all: () => [], get: () => null };
      },
    };
    const health = doctor.checkHealth(healthDb, 'bk', chs, { wordCountToleranceRatio: 0.1, wordCountToleranceChars: 100 });
    assert.equal(health.ok, true, '过程态不判 word_count_changed');
    // done 章 health word_count=0 vs 当前 1000 → 判陈旧
    const doneChs = [mkCh('done', 1, 1000)];
    const doneHealthDb = {
      prepare: (sql) => {
        if (sql.includes('sqlite_master')) return { get: () => ({ name: 'chapter_health' }) };
        if (sql.includes('FROM chapter_health')) return { all: () => [{ id: 1, chapter_id: 'ch-done-1', idx: 1, word_count: 0, created_at: 1 }] };
        return { all: () => [], get: () => null };
      },
    };
    const doneHealth = doctor.checkHealth(doneHealthDb, 'bk', doneChs, { wordCountToleranceRatio: 0.1, wordCountToleranceChars: 100 });
    assert.equal(doneHealth.ok, false, '完成态 word_count 陈旧应报');
    assert.ok(doneHealth.staleRecords[0].reasons.includes('word_count_changed'));
  });
});
