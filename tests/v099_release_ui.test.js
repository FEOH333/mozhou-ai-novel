import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const apiSource = fs.readFileSync(new URL('../web/js/api.js', import.meta.url), 'utf8');
const workshopSource = fs.readFileSync(new URL('../web/js/views/workshop.js', import.meta.url), 'utf8');
const cssSource = fs.readFileSync(new URL('../web/css/app.css', import.meta.url), 'utf8');

test('V0.99 UI：发布反馈 API 覆盖保存、同步、审核、数据、诊断、执行和同步确认', () => {
  assert.match(apiSource, /publicationApi/);
  for (const path of [
    '/publication`', '/publication/sync', '/publication/reviews', '/publication/metrics',
    '/recommendation-recovery/diagnose', '/recommendation-recovery/${runId}/execute',
    '/publication/pending-sync/confirm',
  ]) assert.ok(apiSource.includes(path), `缺少 API 路径 ${path}`);
});

test('V0.99 UI：推流质量驾驶舱仍存在且默认可折叠，不挡在正文前', () => {
  const auto = workshopSource.indexOf('renderAutoCreationCard(book, mainRoot)');
  const chapter = workshopSource.indexOf('renderChapter(book, chapter)');
  const publication = workshopSource.indexOf('renderPublicationDashboard(book)');
  const opening = workshopSource.indexOf('renderOpeningDecisionCard(book)');
  assert.ok(auto >= 0 && chapter > auto, '当前章正文必须紧跟自动创作卡');
  assert.ok(publication > chapter && opening > chapter, '驾驶舱/开篇不得挡在正文前');
  assert.match(workshopSource, /el\('details', \{ class: 'fold' \}/);
  assert.match(workshopSource, /P0 内容质量事故/);
  assert.match(workshopSource, /一键诊断并返工/, '诊断与执行集成为单按钮一键流程');
  assert.match(workshopSource, /const suspectedTurn = Math\.min\(recoveryScopeEnd, Math\.max\(1, Number\(profile\.suspected_turn_chapter\) \|\| 7\)\)/,
    '驾驶舱风险区间应以作品档案的疑似质量拐点为单一真源');
  assert.match(workshopSource, /第 1—\$\{suspectedTurn - 1\} 章 · 疑似基线/);
  assert.match(workshopSource, /第 \$\{suspectedTurn\}—\$\{recoveryScopeEnd\} 章 · 高风险严审/);
  assert.doesNotMatch(workshopSource, /第 1—6 章 · 疑似基线|第 7—\$\{recoveryScopeEnd\} 章 · 高风险严审/,
    '不能把默认第 7 章写死成所有作品的风险拐点');
  assert.match(workshopSource, /startChapter: 1, endChapter: end, forceFresh/, '诊断可强制全新（弹窗选择全部重来时）');
  assert.match(workshopSource, /const end = Math\.max\(1, dashboard\.localChapterCount \|\| 20\)/, '诊断范围必须覆盖全部完成章，不得写死前 20 章');
  assert.match(workshopSource, /选择要沿用的返工进度/, '有既往进度时必须弹出选择窗，让用户挑一条继续，不得逼用户从零重跑');
  assert.match(workshopSource, /全部重新诊断/, '弹窗必须提供全部重来选项');
  assert.match(workshopSource, /resumeRunId/, '弹窗钉选的进度必须传给后端做严格校验');
  assert.match(workshopSource, /reusePriorCandidates/, '执行入口保留兼容参数，但持久运行策略决定实际复用范围');
  assert.match(workshopSource, /未获曝光.*0.*正常/);
  assert.match(workshopSource, /明确确认.*已发布正文/);
  assert.match(workshopSource, /待线上同步/);
});

test('V0.100.7 UI：候选验证层级与部分完成必须用真实口径展示', () => {
  assert.match(workshopSource, /本运行局部通过检查点|局部通过候选/, '同运行检查点必须明确只是局部通过');
  assert.match(workshopSource, /整段已通过候选|整段验证通过/, '整段通过候选必须有独立口径');
  assert.match(workshopSource, /旧版无来源候选.*已隔离.*需重生/, '升级前无 provenance 候选必须显式隔离，不能冒充本运行检查点');
  assert.match(workshopSource, /局部通过.*等待整段|等待整段复核/, '单章双审通过不能冒充最终验证');
  assert.match(workshopSource, /部分落盘/, '仍有未解决 tune 章时必须显示部分落盘');
  assert.match(workshopSource, /unresolvedChapters/, '部分完成必须展示未解决章号');
  assert.match(workshopSource, /recovery_snapshot_reused/, '同一基准重试应显示复用恢复快照');
  assert.match(workshopSource, /recovery_synthesizing/, '五章取证之后的全范围综合阶段必须可见');
});

test('V0.100.7 UI：断网后可重连后台返工，只有显式按钮才能取消', () => {
  assert.match(apiSource, /observeRecoveryJob/);
  assert.match(apiSource, /cancelRecoveryJob/);
  assert.match(workshopSource, /activeRecoveryJob/);
  assert.match(workshopSource, /重新连接返工进度/);
  assert.match(workshopSource, /明确停止服务端返工/);
  assert.match(workshopSource, /recovery_job_cancelled/);
  assert.match(workshopSource, /断开页面只停止观察，不会取消服务端任务/);
});

test('V0.99 UI：驾驶舱有清晰状态层级、质量曲线和窄屏布局', () => {
  for (const selector of [
    '.publication-cockpit', '.publication-alert', '.publication-stats',
    '.quality-curve', '.quality-cell', '.sync-chapter-list',
  ]) assert.ok(cssSource.includes(selector), `缺少样式 ${selector}`);
  assert.match(cssSource, /@media\s*\(max-width:\s*760px\)[\s\S]*publication-cockpit/);
});
