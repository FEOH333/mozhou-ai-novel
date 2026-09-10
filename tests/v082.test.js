// V0.78 彻底修复：审校宽松引用匹配（防误杀真实问题）+ 细纲根因问题 replan
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v082-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.78 宽松引用匹配 + 细纲根因 replan', () => {
  test('①sanitizeAuditResult 宽松匹配：模型改写引用不再误杀真实问题', async () => {
    const { sanitizeAuditResult } = await import(pathToFileURL(path.join(ROOT, 'server/engine/audit.js')));
    // 正文实际是"书架后那道灰衣身影"，审校引用"那人是灰衣人"（改写）→ 应保留（含"灰衣"关键词）
    const chapterText = '书架后那道灰衣身影还在。我往门口走时，他没有动，手指仍搭在卷宗格沿上。';
    const result = sanitizeAuditResult({
      verdict: 'fix',
      issues: [{ type: '大纲偏离', severity: 'high', quote: '那人是灰衣人，外门弟子中没这号人物', issue: '正文与细纲不符', fix: '改回细纲角色' }],
    }, chapterText);
    assert.equal(result.issues.length, 1, '改写引用应被保留');
    assert.equal(result.verdict, 'fix', '真实问题不应被误判 accept');
  });

  test('②sanitizeAuditResult 仍过滤完全无关的伪引用', async () => {
    const { sanitizeAuditResult } = await import(pathToFileURL(path.join(ROOT, 'server/engine/audit.js')));
    const chapterText = '李尘走进任务堂，翻看卷宗。';
    // quote 与正文完全无关 → 应过滤
    const result = sanitizeAuditResult({
      verdict: 'fix',
      issues: [{ type: '事实编造', severity: 'high', quote: '他在秘境里捡到一枚神器', issue: '凭空编造', fix: '删' }],
    }, chapterText);
    assert.equal(result.issues.length, 0, '无关伪引用应过滤');
    assert.equal(result.verdict, 'accept', '全过滤后应 accept');
  });

  test('③hasOutlineRootIssue：细纲根因 high → replan', async () => {
    const { hasOutlineRootIssue } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline.js')));
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '事实编造', severity: 'high' }] }), true);
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '大纲偏离', severity: 'high' }] }), true);
    assert.equal(hasOutlineRootIssue({ issues: [{ type: '语句质量', severity: 'high' }] }), false);
  });

  test('④完整链路：审校报大纲偏离（灰衣人 vs 老幺）→ sanitize保留 → replan 触发', async () => {
    // 模拟：正文写灰衣人，细纲要求老幺，审校报大纲偏离
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { sanitizeAuditResult } = await import(pathToFileURL(path.join(ROOT, 'server/engine/audit.js')));
    const { hasOutlineRootIssue } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline.js')));
    const chapterText = '书架后那道灰衣身影还在。林月低声说那是负责书库杂务的人。';
    const cleaned = sanitizeAuditResult({
      verdict: 'fix',
      issues: [{ type: '大纲偏离', severity: 'high', quote: '那人是灰衣人', issue: '细纲要求老幺，正文写灰衣人', fix: '改回' }],
    }, chapterText);
    assert.equal(cleaned.issues.length, 1, '大纲偏离应保留');
    assert.equal(hasOutlineRootIssue(cleaned), true, '应触发 replan');
  });

  test('⑤runChapterFlow mock 审校 accept 不破坏正常流程', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { runChapterFlow } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline.js')));
    const b = store.books.create({ title: '正常书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', 'x');
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const ch = store.chapters.create(b.id, v.id, 1, { title: '第一章', status: 'planned' });
    store.chapters.update(ch.id, { outline: { title: '第一章', scenes: [{ pov: '李尘', location: '镇', beat: '事件', target_words: 300 }] } });
    const r = await runChapterFlow(b.id, ch.id, {});
    assert.ok(['done'].includes(r.status), `应正常完成，实际 ${r.status}`);
  });
});
