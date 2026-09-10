// V0.96.5 锁定：自动创作事件流全流程体检落地
// ① 同章流程 usage 透传全链路（A1-A6：复审 audit×4 / revise×3 / coverage / attraction / settle / pleasure）
// ② pilot 补写 writeScene 传 onUsage/onDelta（A7：此前传 onEvent——writeScene 不消费，补写零统计）
// ③ runPilot 观察面补角（audit_done/content_recovered/replan_rollback/quality_blocked）
// ④ chapter_done/done 事件带耗时与字数（效率观察面）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import './helper.js';

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---------- ① 同章流程 usage 透传全链路 ----------

test('V0.96.5 pipeline 复审 auditChapter 全部透传 usage（修订循环/replan 后/覆盖复审/吸引力复审）', () => {
  const src = read('server/engine/pipeline.js');
  const auditCalls = src.match(/auditChapter\(bookId/g)?.length ?? 0;
  const auditWithCb = src.match(/auditChapter\(bookId[^)]*streamCb/gs)?.length ?? 0;
  assert.ok(auditCalls >= 5, `pipeline 应有 ≥5 处 auditChapter 调用（实际 ${auditCalls}）`);
  assert.equal(auditWithCb, auditCalls, '每处 auditChapter 调用都应传 streamCb（V0.96 只修了第一处——修订轮越多统计漏得越多）');
});

test('V0.96.5 pipeline reviseScene 调用补传 onUsage/onUsageCost（修订 tokens 进本次统计）', () => {
  const src = read('server/engine/pipeline.js');
  const reviseCalls = [...src.matchAll(/reviseScene\(bookId,/g)].length;
  const reviseWithUsage = [...src.matchAll(/streamCb: \{[\s\S]*?onUsage:[\s\S]*?onUsageCost:[\s\S]*?\},/g)].length;
  assert.ok(reviseCalls >= 3, `应有 ≥3 处 reviseScene 调用（实际 ${reviseCalls}）`);
  assert.ok(reviseWithUsage >= 3, '每处 reviseScene 的 streamCb 应含 onUsage（内部已支持、此前只在修订循环传 onDelta）');
});

test('V0.96.5 coverageCheck/attractionGate/settleChapter/auditPleasure 签名与 runTask 均透传 streamCb', () => {
  const audit = read('server/engine/audit.js');
  assert.ok(/export async function coverageCheck\(bookId, chapterId, \{ signal, streamCb \} = \{\}\)/.test(audit),
    'coverageCheck 签名应接受 streamCb');
  assert.ok(/const usageCb = \{ onUsage: streamCb\?\.onUsage, onUsageCost: streamCb\?\.onUsageCost \};[\s\S]*task: 'coverage'[^}]*streamCb: usageCb/.test(audit),
    'coverage runTask 应透传 usage（截断重试处也要）');
  const attraction = read('server/engine/attraction.js');
  assert.ok(/export async function attractionGate\(bookId, chapterId, chapterIdx, \{ signal, streamCb \} = \{\}\)/.test(attraction),
    'attractionGate 签名应接受 streamCb');
  assert.ok(/task: 'attraction'[^}]*streamCb/s.test(attraction), 'attraction runTask 应透传');
  const settle = read('server/engine/settle.js');
  assert.ok(/export async function settleChapter\(bookId, chapterId, \{[^}]*streamCb[^}]*\} = \{\}\)/.test(settle),
    'settleChapter 签名应接受 streamCb（V0.100.1 起同时接受 onEvent，签名形态放宽但透传不变）');
  assert.ok(/task: 'settle'[^}]*streamCb/s.test(settle), 'settle runTask 应透传（结算 8000 tokens 此前完全漏出统计）');
  const pleasure = read('server/engine/pleasure.js');
  assert.ok(/export async function auditPleasure\(bookId, chapterId, chapterIdx, \{ onProgress, signal, streamCb \} = \{\}\)/.test(pleasure),
    'auditPleasure 签名应接受 streamCb');
  assert.ok(/task: 'pleasure_audit'[^}]*streamCb/s.test(pleasure), 'pleasure_audit runTask 应透传');
});

test('V0.96.5 pipeline 各判定门调用点统一传 usageCb（coverage/attraction/settle/pleasure 不再漏）', () => {
  const src = read('server/engine/pipeline.js');
  assert.ok(/coverageCheck\(bookId, chapterId, \{ signal, streamCb: usageCb \}\)/.test(src), '两处 coverageCheck 都应传 usageCb');
  assert.ok(src.match(/coverageCheck\(bookId, chapterId, \{ signal, streamCb: usageCb \}\)/g)?.length >= 2, '覆盖初审+复审都要传');
  assert.ok(/attractionGate\(bookId, chapterId, chapterIdx, \{ signal, streamCb: usageCb \}\)/.test(src), 'attractionGate 应传 usageCb');
  assert.ok(/settleChapter\(bookId, chapterId, \{\s*signal,[\s\S]*?streamCb: usageCb[\s\S]*?\}\)/.test(src), 'settleChapter 应传 usageCb（V0.100.1 起同传 onEvent，调用形态放宽但 usage 透传不变）');
  assert.ok(/auditPleasure\(bookId, chapterId, chapterIdx, \{ onProgress[^}]*streamCb: usageCb \}\)/.test(src), 'auditPleasure 应传 usageCb');
});

// ---------- ② pilot 补写通道 usage 透传 ----------

test('V0.96.5 pilot backfill writeScene 传 onUsage/onDelta（不再传无效的 onEvent）', () => {
  const src = read('server/engine/pilot.js');
  const seg = src.slice(src.indexOf('const backfillMissed'));
  assert.ok(!/writeScene\(bookId, ch\.id, scene\.id, \{ onEvent, signal \}\)/.test(seg),
    'writeScene 不消费 onEvent——传了等于补写零统计零流式（A7 根因）');
  assert.ok(/writeScene\(bookId, ch\.id, scene\.id, \{[\s\S]*?onDelta:[\s\S]*?onUsage:[\s\S]*?onUsageCost:[\s\S]*?signal,?\s*\}\)/.test(seg),
    '补写 writeScene 应传 onDelta/onUsage/onUsageCost');
});

// ---------- ③④ 事件增强与前端观察面 ----------

test('V0.96.5 chapter_done/done 事件带耗时与字数（效率观察面）', () => {
  const src = read('server/engine/pilot.js');
  assert.ok(/emit\('chapter_done', \{ chapterId: ch\.id, idx: ch\.idx, settled: r\.settled, partial: false, wordCount: chapterWordCount, durationMs: Date\.now\(\) - chapterStartedAt \}\)/.test(src),
    'chapter_done 应带 wordCount/durationMs');
  assert.ok(/emit\('done',\s*\{[\s\S]*?written:\s*reportedWritten,[\s\S]*?total:\s*reportedTotal,[\s\S]*?durationMs:[\s\S]*?writtenWords[\s\S]*?\}\);/.test(src),
    '全书 done 应带 durationMs/writtenWords');
});

test('V0.96.5 runPilot 观察面补角：audit_done/content_recovered/replan_rollback/quality_blocked', () => {
  const ws = read('web/js/views/workshop.js');
  const runPilotSrc = ws.slice(ws.indexOf('async function runPilot'));
  assert.ok(/case 'audit_done':/.test(runPilotSrc), 'runPilot 应处理 audit_done（每章审校结论——runFlow 有、runPilot 缺）');
  assert.ok(/case 'content_recovered':/.test(runPilotSrc), 'runPilot 应处理 content_recovered（快照只增恢复是重大数据事件）');
  assert.ok(/case 'replan_rollback':/.test(runPilotSrc), 'runPilot 应处理 replan_rollback');
  assert.ok(/case 'quality_blocked':/.test(runPilotSrc), 'runPilot 应处理 quality_blocked');
  // chapter_done 显示效率
  assert.ok(/data\.durationMs/.test(runPilotSrc) && /data\.wordCount/.test(runPilotSrc), 'chapter_done 应展示耗时与字数');
});

test('V0.96.5 pilot 轮末书纲对齐：过时文案与 stage 误用清理', () => {
  const src = read('server/engine/pilot.js');
  assert.ok(!src.includes('已写满 3 卷'), '"已写满 3 卷"文案过时（bookAlignDue 已是每章后间隔检查，非每 3 卷）');
  assert.ok(!/stage: 'done', message: `书纲对齐失败/.test(src), '对齐失败不得用 stage done 报告（语义混乱）');
});
