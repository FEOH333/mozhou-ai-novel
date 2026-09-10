// V0.93.11 系统性检查修复：①跨章句子复读检测（doctor 实证 ch28/ch33 同句）；
// ②续卷过期动态材料过滤（foreshadow_plan 目标已过 / polish_feedback 超 15 章不再注入）
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v134-syscheck-'));
const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const rules = await import(pathToFileURL(path.join(ROOT, 'server/engine/rules.js')));
const continuation = await import(pathToFileURL(path.join(ROOT, 'server/engine/continuation.js')));

describe('V0.93.11 系统性检查修复', () => {
  test('跨章句子复读：本章整句出现在前文 → medium；正常承接不拦', () => {
 const chapterText = '主角站在城头，看着远方的烟。从地底方向传来的，隔着岩层和泥土的过滤，闷得像一声压抑的咳嗽。他握紧了刀。';
    const prevChapters = [
      { idx: 28, text: '他蹲在矿洞口。从地底方向传来的，隔着岩层和泥土的过滤，闷得像一声压抑的咳嗽。' },
      { idx: 27, text: '今天只是寻常的一天。' },
    ];
    const issues = rules.detectCrossChapterRepeats(chapterText, prevChapters);
    assert.equal(issues.length, 1, '跨章同句应命中');
    assert.equal(issues[0].severity, 'medium', '应参与审校 verdict');
    assert.ok(issues[0].issue.includes('第28章'), '应指出前文章号');
    // 正常承接（同人名/同地点但不整句重复）不拦
 const ok = rules.detectCrossChapterRepeats('主角推开营帐的门。', prevChapters);
    assert.equal(ok.length, 0, '正常描写不拦');
    // 无前文 / 空文本
    assert.equal(rules.detectCrossChapterRepeats('一句话。', []).length, 0);
    assert.equal(rules.detectCrossChapterRepeats('', prevChapters).length, 0);
    // 短句（<15 字）不拦
    assert.equal(rules.detectCrossChapterRepeats('他握紧了刀。', [{ idx: 1, text: '他握紧了刀。' }]).length, 0);
  });

  test('续卷注入：过期 foreshadow_plan/polish_feedback 不再注入（直测 filterStaleMaterials）', async () => {
    const book = store.books.create({ title: '材料时效测试', genre: '玄幻' });
    // 造 20 章进度
    for (let i = 1; i <= 20; i++) store.chapters.create(book.id, null, i, { title: `第${i}章` });
    const latest = store.chapters.list(book.id).reduce((m, c) => Math.max(m, Number(c.idx) || 0), 0);
    assert.equal(latest, 20);
    // 过期的伏笔收束计划（目标第 15 章，已过）→ 不注入
    store.materials.set(book.id, 'foreshadow_plan', '【伏笔收束计划】（第10章生成，后续卷/章须落实）\n- 目标第15章附近回收玉佩伏笔');
    // 过期的中期审阅反馈（第 3 章生成，差 17 章 > 15 → 跳过）
    store.materials.set(book.id, 'polish_feedback', '【中期审阅反馈｜opening阶段】（第3章时生成，阶段ID=opening；供后续卷大纲/续卷/细纲参考）\n节奏拖沓，需减少铺垫');
    let { midReviewText, closurePlanText } = continuation.filterStaleMaterials(book.id, latest);
    assert.equal(closurePlanText, '', '目标章已过 → foreshadow_plan 不应注入');
    assert.equal(midReviewText, '', '生成超 15 章 → polish_feedback 不应注入');
    // 仍然相关的计划（目标未来章）应保留；无生成标记的反馈视为新鲜保留
    store.materials.set(book.id, 'foreshadow_plan', '【伏笔收束计划】（第18章生成）\n- 目标第25章附近回收玉佩伏笔');
    store.materials.set(book.id, 'polish_feedback', '【中期审阅反馈｜中期阶段】（阶段ID=mid；供后续卷大纲/续卷/细纲参考）\n支线太多，需收拢');
    ({ midReviewText, closurePlanText } = continuation.filterStaleMaterials(book.id, latest));
    assert.ok(closurePlanText.includes('目标第25章'), '仍有未来目标章 → 应注入');
    assert.ok(midReviewText.includes('支线太多'), '无生成章标记 → 视为新鲜应注入');
  });
});
