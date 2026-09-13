// V0.91.1 实书卡顿/卡章回归：审校降级语义、顺序写作、进度透传、暂停状态自愈
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v108-live-block-'));
process.env.NOVEL_NO_OPEN = '1';

const store = await import('../server/db/store.js');
const pipeline = await import('../server/engine/pipeline/pipeline.js');
const pilot = await import('../server/engine/pipeline/pilot.js');
const safety = await import('../server/engine/pipeline/data_safety.js');

describe('V0.91.1 审校卡章收敛', () => {
  test('medium 客观问题进入局部修订，高等级细纲根因仍交给重规划', () => {
    assert.equal(typeof pipeline.auditIssueRepairMode, 'function');
    const mediumOutline = {
      verdict: 'fix',
      issues: [{ type: '大纲偏离', severity: 'medium', quote: '母亲扔下包袱', issue: '遗漏护身符' }],
    };
    assert.equal(pipeline.auditIssueRepairMode(mediumOutline), 'revise', '可定位的 medium 大纲问题应局部修正文，而非 0 轮卡章');

    const highOutline = {
      verdict: 'fix',
      issues: [{ type: '大纲偏离', severity: 'high', quote: '整章错写', issue: '核心事件错误' }],
    };
    assert.equal(pipeline.auditIssueRepairMode(highOutline), 'replan', 'high 细纲根因仍须重规划');

    const textFix = {
      verdict: 'fix',
      issues: [{ type: '语句质量', severity: 'medium', quote: '缓缓走来', issue: 'AI 味重复' }],
    };
    assert.equal(pipeline.auditIssueRepairMode(textFix), 'revise', '文本问题仍须进入正文修订');

    assert.equal(pipeline.auditIssueRepairMode({
      verdict: 'fix', issues: [{ type: '情感连贯性', severity: 'low', quote: '', issue: '软提示' }],
    }), 'defer', '只有软提示时不得以 fix 穿透到质量失败闸');

    assert.equal(pipeline.auditVerdictAfterBudget({
      verdict: 'fix', issues: [{ type: '大纲偏离', severity: 'medium', issue: '仍有轻微遗漏' }],
    }).verdict, 'defer', '修订预算耗尽后只剩 medium 问题应记债放行');
    assert.equal(pipeline.auditVerdictAfterBudget({
      verdict: 'fix', issues: [{ type: '史实错误', severity: 'high', issue: '史实年代错误' }],
    }).verdict, 'fix', '修订预算耗尽后仍有 high 硬伤必须继续拦截');
  });

  test('任何章节终态失败都暂停顺序创作，不能越过卡章继续写后文', () => {
    assert.equal(typeof pilot.chapterFailurePolicy, 'function');
    assert.deepEqual(pilot.chapterFailurePolicy('QUALITY_GATE_FAILED'), {
      qualityStop: true, status: 'quality_blocked', pause: true,
    });
    assert.deepEqual(pilot.chapterFailurePolicy('API_ERROR'), {
      qualityStop: false, status: 'planned', pause: true,
    });
    const source = fs.readFileSync(path.join(process.cwd(), 'server/engine/pipeline/pilot.js'), 'utf8');
    assert.match(source, /\['quality_blocked', 'partial', 'failed'\]\.includes\(chapter\.status\)/,
      '质量卡章转成 partial/failed 后也必须继续受顺序闸保护');
  });
});

describe('V0.91.1 暂停与可见进度', () => {
  test('暂停遗留的 writing 场景在续跑前恢复为 planned/draft', () => {
    assert.equal(typeof safety.recoverInterruptedScenes, 'function');
    const book = store.books.create({ title: '暂停恢复', genre: '历史' });
    const chapter = store.chapters.create(book.id, null, 1, { title: '第一章', status: 'planned' });
    const empty = store.scenes.create(chapter.id, 1, { beat: '未写', status: 'writing', content: '' });
    const partial = store.scenes.create(chapter.id, 2, { beat: '已有草稿', status: 'writing', content: '已经流式收到的正文草稿。' });

    const result = safety.recoverInterruptedScenes(chapter.id);
    assert.equal(result.recovered, 2);
    assert.equal(store.scenes.get(empty.id).status, 'planned');
    assert.equal(store.scenes.get(partial.id).status, 'draft');
  });

  test('首次生成章细纲也透传 onEvent/signal，长思考期间页面能收到内部阶段事件', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'server/engine/pipeline/pipeline.js'), 'utf8');
    assert.match(source, /generateChapterOutline\(bookId, chapterId, \{ onEvent, signal \}\)/);
  });
});
