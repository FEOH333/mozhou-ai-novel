// V0.104.0：观察驾驶舱——死按钮修复、自动创作作业与浏览器解绑、写作台首屏可读。
'use strict';

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { clearBookLeasesForTests } from '../server/jobs/book-lease.js';
import { createRecoveryJobRegistry, writeJobs } from '../server/jobs/recovery-jobs.js';
import { isImmediateReplanIssue } from '../server/engine/longform/historical_guardrails.js';

const ROOT = process.cwd();
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => {
  clearBookLeasesForTests();
  writeJobs.clearForTests();
});

test('V0.104.0 源码：workshop/roster/outline 死引用与完成态字段', () => {
  const workshop = read('web/js/views/workshop.js');
  const roster = read('web/js/views/roster.js');
  const outline = read('web/js/views/outline.js');
  const ui = read('web/js/ui.js');

  assert.match(workshop, /import\s*\{[^}]*progressCard[^}]*\}\s*from\s*'\.\.\/ui\.js'/s,
    '生成细纲依赖 progressCard，必须从 ui.js 导入');
  assert.match(workshop, /ch\.word_count/, '完成卡片字数必须读 API 的 word_count');
  assert.doesNotMatch(workshop, /\bch\.wordCount/, '不得再用 camelCase wordCount 读章节字数（patch.wordCount 是事件载荷转存适配，不在禁列）');
  assert.match(workshop, /data-chapter-id/, '质量门卡住格子必须带 data-chapter-id 才能被 quality_blocked 事件点亮');
  assert.match(workshop, /id:\s*'flow-status'/, '一键写本章必须创建 #flow-status，否则 setStatus 空转');

  assert.match(roster, /import\s*\{[^}]*openModal[^}]*\}\s*from\s*'\.\.\/ui\.js'/s,
    'AI 取名依赖 openModal，必须从 ui.js 导入');

  const modalAt = outline.indexOf("title: `编辑第${v.idx}卷`");
  assert.ok(modalAt > 0, '应能定位卷编辑弹窗');
  const slice = outline.slice(Math.max(0, modalAt - 200), modalAt + 80);
  assert.match(slice, /(?:const|let)\s+m\s*=\s*openModal\s*\(/, 'openModal 返回值必须赋给 m，保存/取消才能关窗');

  assert.match(ui, /quality_blocked:\s*'卡住'/, 'CHAPTER_STATUS 必须覆盖卡住态');
  assert.match(ui, /partial:\s*'部分'/, 'CHAPTER_STATUS 必须覆盖 partial');
  assert.match(ui, /failed:\s*'失败'/, 'CHAPTER_STATUS 必须覆盖 failed');
  assert.match(workshop, /CHAPTER_STATUS/, '写作台必须真正使用 CHAPTER_STATUS，不能只定义不用');
  assert.match(ui, /users:\s*'/, '角色库导航需要 users 图标，不得落到文件图标');
});

test('V0.104.0 源码：空 CSS token、场景草稿态、过时文案', () => {
  const css = read('web/css/app.css');
  const workshop = read('web/js/views/workshop.js');
  const library = read('web/js/views/library.js');
  const opening = read('web/js/opening-status.js');

  assert.match(css, /\.scene-card\.drafted/, '场景草稿态 class 是 drafted，不是 draft');
  assert.match(css, /\.tag\.quality_blocked/, '卡住态标签要有样式');
  assert.match(css, /\.warn-text/, 'warn-text 必须定义，否则漂移警告看不见');
  assert.match(css, /\.ok-text/, 'ok-text 必须定义');
  assert.doesNotMatch(css, /var\(--bg-2\)/, '禁止引用未定义的 --bg-2');
  assert.doesNotMatch(css, /var\(--line\)/, '禁止引用未定义的 --line');
  assert.doesNotMatch(workshop, /var\(--bg-2\)/, '写作台不得再引用空 token --bg-2');
  assert.doesNotMatch(workshop, /var\(--line[,)]/, '写作台不得再引用空 token --line');

  assert.doesNotMatch(library, /墨舟 V0\.93/, '作品库副标题不得停留在过时版本号');
  assert.doesNotMatch(opening, /免费档思考拉满/, '开篇进度文案不得再主推过时免费档');
  assert.doesNotMatch(opening, /请勿重复点击或离开本页/, '作业可重连后不得再要求人钉死在本页');
  assert.doesNotMatch(workshop, /请勿刷新或离开本页/, '开篇决策台不得再要求人钉死在本页');
  assert.doesNotMatch(workshop, /斗破苍穹|凡人修仙传|庆余年|诛仙|大王饶命|道诡异仙/,
    '文风画像下拉不得使用当红书名样本');
});

test('V0.104.0 作业：断开观察流后 runBookPilot 仍 running，cancel 才停', async () => {
  const registry = createRecoveryJobRegistry({ retentionMs: 1_000 });
  const releaseTask = deferred();
  let taskSignal;
  const started = registry.start({
    bookId: 'book-write', taskKey: 'pilot', type: 'pilot',
    task: async ({ signal, emit }) => {
      taskSignal = signal;
      emit({ type: 'chapter_start', idx: 4, title: '观察不断写' });
      await releaseTask.promise;
      return { written: 1 };
    },
  });

  const firstObserver = [];
  const detach = registry.subscribe(started.id, event => firstObserver.push(event));
  assert.equal(started.status, 'running');
  assert.equal(taskSignal.aborted, false, '观察者订阅不得 abort 任务 signal');
  detach();
  assert.equal(taskSignal.aborted, false, '观察者断开不得取消服务端写作');
  assert.equal(registry.get(started.id).status, 'running');
  assert.equal(registry.findActiveByBook('book-write').id, started.id);
  assert.equal(registry.findActiveByBook('book-write').lastEvent.idx, 4,
    '顶栏/API 必须能从 lastEvent 读到当前章号');

  const cancelled = registry.cancel(started.id, { bookId: 'book-write' });
  assert.equal(cancelled.status, 'cancelling');
  assert.equal(taskSignal.aborted, true, '只有显式 cancel 才中止任务');
  releaseTask.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  const terminal = await registry.wait(started.id);
  assert.equal(terminal.status, 'cancelled');
});

test('V0.104.0 HTTP：POST /pilot 与 /polish 不得 abortOnDisconnect', () => {
  const src = read('server/index.js');
  const api = read('web/js/api.js');
  const app = read('web/js/app.js');
  assert.match(src, /writeJobs/, '自动创作必须走独立作业注册器');
  for (const routeMarker of ["'/api/books/:id/pilot'", "'/api/books/:id/polish'"]) {
    const at = src.indexOf(`route('POST', ${routeMarker}`);
    assert.ok(at > 0, `缺少路由 ${routeMarker}`);
    const nextRoute = src.indexOf("route('", at + 10);
    const block = src.slice(at, nextRoute > 0 ? nextRoute : undefined);
    assert.ok(!block.includes('abortOnDisconnect'), `${routeMarker} 不得随断连中止任务`);
    assert.match(block, /writeJobs\.start\s*\(/, `${routeMarker} 必须由后台任务注册器持有 Promise`);
    assert.match(block, /attach(?:Write|Job|Recovery)JobStream\s*\(/, `${routeMarker} 应把 SSE 作为可拆卸观察者`);
  }
  assert.match(src, /write-jobs\/:jobId\/observe/);
  assert.match(src, /write-jobs\/:jobId\/cancel/);
  assert.match(src, /jobs\/active/);
  assert.match(api, /writeApi/);
  assert.match(api, /observeWriteJob|write-jobs\/\$\{jobId\}\/observe/);
  assert.match(app, /run-chip|#run-chip/, '顶栏必须能显示进行中作业');
  assert.match(app, /abortAllControllers\(state\._activeSSE\)/, '路由切换仍取消观察流');
  assert.match(app, /观察/, '路由切换注释必须写明只断观察、不取消服务端作业');
});

test('V0.104.0 写作台 DOM：自动创作卡之后即可到达章节正文，驾驶舱默认可折叠', () => {
  const src = read('web/js/views/workshop.js');
  const auto = src.indexOf('renderAutoCreationCard(book, mainRoot)');
  const chapter = src.indexOf('renderChapter(book, chapter)');
  const publication = src.indexOf('renderPublicationDashboard(book)');
  const opening = src.indexOf('renderOpeningDecisionCard(book)');
  assert.ok(auto >= 0 && chapter > auto, '当前章正文必须紧跟自动创作卡');
  assert.ok(publication > chapter, '推流驾驶舱不得挡在正文前');
  assert.ok(opening > chapter, '开篇决策台不得挡在正文前');
  assert.match(src, /id:\s*'chapter-read'/, '章节正文容器必须可定位');
  assert.match(src, /<details|el\('details'/, '驾驶舱/开篇/书务应收进折叠');
  assert.match(src, /class: 'fold'[\s\S]{0,200}推流质量驾驶舱|推流质量驾驶舱[\s\S]{0,80}fold/s);
});

test('V0.104.0 导航与状态映射零依赖书名；清场合同本轮不碰', () => {
  const app = read('web/js/app.js');
  const workshop = read('web/js/views/workshop.js');
  const library = read('web/js/views/library.js');
  assert.match(app, /navItem\('#\/library'/, '书内导航必须有作品库入口');
 assert.doesNotMatch(app, /示例历史长篇/);
 assert.doesNotMatch(workshop, /示例历史长篇/);
 assert.doesNotMatch(library, /示例历史长篇/);
  assert.equal(typeof isImmediateReplanIssue, 'function', '本轮前端改动不得改写清场合同');
  const guard = read('server/engine/longform/historical_guardrails.js');
  assert.match(guard, /export function isImmediateReplanIssue/);
});
