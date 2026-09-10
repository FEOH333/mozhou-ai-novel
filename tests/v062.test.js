// V0.62 自动化六大升级测试：补写通道/书纲按章对齐/卷体检复检/返工防死循环/性能节流
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v062-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();

describe('V0.62 自动化升级', () => {
  test('①pipeline 返工：replan 受轮数限制（防死循环）+ 事实级 high 纳入修订 + stale 升级 replan + coverage 复审', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline.js'), 'utf8');
    assert.ok(src.includes('replanRound'), 'replan 应有轮数计数');
    assert.ok(src.includes('replanRound >= Math.max(2, maxRevise)'), 'replan 超限降级放行（防死循环）');
    assert.ok(src.includes("'设定冲突', '时间线冲突', '角色矛盾', '事实编造', '事实矛盾', '大纲偏离'"), '事实级 high 纳入修订');
    assert.ok(src.includes('lastFixedQuotes'), '应有修订有效性追踪');
    assert.ok(src.includes('staleHigh'), '同问题复发应升级 replan');
    assert.ok(src.includes('coverage: true'), '覆盖补写后应复审');
  });

  test('②卷体检：failed 可重审 + 修订后复检 + P2 工单落债', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/volumereview.js'), 'utf8');
    assert.ok(src.includes("r.status !== 'failed'"), '补审应排除 failed（可重审）');
    assert.ok(src.includes('_recheck'), '应有复检参数');
    assert.ok(src.includes('volume_review_recheck'), '应有复检事件');
    assert.ok(src.includes('revisedCount: revised + (re.revised || 0)'), '复检后 revised_count 累计');
    assert.ok(src.includes('卷体检工单'), 'P2 工单应落 conflicts');
    const pilot = fs.readFileSync(path.join(ROOT, 'server/engine/pilot.js'), 'utf8');
    assert.ok(pilot.includes("prevReview.status === 'failed'"), 'pilot 卷体检 failed 可重审');
  });

  test('③pilot 补写通道：缺章/缺场景自动检测 + 尝试上限 + 每 3 章补查', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/pilot.js'), 'utf8');
    assert.ok(src.includes('backfillMissed'), '应有补写函数');
    assert.ok(src.includes('backfillAttempts'), '应有补写尝试计数（防无限重试）');
    assert.ok(src.includes('backfillAttempts.get(ch.id) >= 2'), '每章最多试 2 次');
    assert.ok(src.includes('chapterSinceBackfill'), '应每 3 章补查');
    assert.ok(src.includes("emit('backfill'"), '应有补写事件');
    assert.ok(src.includes("import { writeScene }"), '应导入场景级补写');
  });

  test('④书级对齐：按章数间隔触发 + 未写卷 goal 同步', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/alignment.js'), 'utf8');
    assert.ok(src.includes('intervalChapters = 8'), '书级对齐默认 8 章间隔');
    assert.ok(src.includes('doneCount - lastAlignChapters'), '按已完成章数判定');
    assert.ok(src.includes('书级对齐@${vols.length}卷${doneCount}章'), '日志记录卷数+章数');
    assert.ok(src.includes('patch.goal'), '未写卷 goal 同步');
    const pilot = fs.readFileSync(path.join(ROOT, 'server/engine/pilot.js'), 'utf8');
    assert.ok(pilot.includes('书级大纲自动对齐（回填实际+调整后续分卷）'), 'pilot 每章后检查书级对齐');
  });

  test('⑤性能：前端 usage 节流 + 续卷网格扩展 + 后端 costs 缓存', () => {
    const ws = fs.readFileSync(path.join(ROOT, 'web/js/views/workshop.js'), 'utf8');
    assert.ok(ws.includes('usageRefreshAt'), 'usage 刷新节流');
    assert.ok(ws.includes('Date.now() - usageRefreshAt > 3000'), '3 秒节流窗口');
    assert.ok(ws.includes('ensureGridCells'), '续卷新章动态扩展网格');
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(idx.includes('costsAggCache'), '后端成本聚合缓存');
    assert.ok(idx.includes('> 5000'), '缓存 5 秒 TTL');
  });

  test('⑤b 前端 workshop 语法完整（runPilot 可用）', async () => {
    // 静态检查：total 声明不重复（let 替换 const 后）
    const ws = fs.readFileSync(path.join(ROOT, 'web/js/views/workshop.js'), 'utf8');
    const runStart = ws.indexOf('async function runPilot');
    const runEnd = ws.indexOf('async function runPolishNow');
    const runBody = ws.slice(runStart, runEnd);
    const totalDecls = (runBody.match(/let total =|const total =/g) || []).length;
    assert.equal(totalDecls, 1, 'total 应只声明一次（let）');
    // V0.63 防 TDZ 回归：声明行必须在首次使用之前（V0.62 曾把 let total 声明放在使用之后 → ReferenceError → 点自动创作没反应）
    const lines = runBody.split('\n');
    let declLine = -1, useLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('let total =') && declLine < 0) declLine = i;
      if (lines[i].includes('total ?') && useLine < 0) useLine = i;
    }
    assert.ok(declLine >= 0 && useLine > declLine, `total 声明(${declLine})必须在首次使用(${useLine})之前`);
  });
});
