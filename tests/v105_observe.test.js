// V0.105 观察面：目标章数网格、事件章号、长等待心跳（真实自动创作跑到 48 时发现）
import './helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chapterIdxFromEvent, pilotGridSize } from '../web/js/pilot-observe.js';

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('V0.105 目标 48 已建 42 时网格是 48 格，不是 min 截成 42', () => {
  assert.equal(pilotGridSize(48, 42), 48);
  assert.equal(pilotGridSize(undefined, 42), 42);
  assert.equal(pilotGridSize(10, 42), 42);
  assert.equal(pilotGridSize(0, 0), 0);
});

test('V0.105 事件章号认「第 N 章」，不把细纲 1/3 误成第 1 章', () => {
  assert.equal(chapterIdxFromEvent({ idx: 42 }), 42);
  assert.equal(chapterIdxFromEvent({ message: '续写第 42 章…' }), 42);
  assert.equal(chapterIdxFromEvent({ message: '自动修复卡住的第 41 章《飞丸断桅》' }), 41);
  assert.equal(chapterIdxFromEvent({ message: '章细纲第 1/3 版生成中，模型正在推演结构与连续性…' }), 0);
  assert.equal(chapterIdxFromEvent({ message: '一致性审校…' }), 0);
  assert.equal(chapterIdxFromEvent({ message: '卷大纲第 2/3 次生成（上次未过闸：第1章[YEAR_OUTSIDE_PHASE] 1259年越出本卷1261—1264年边界）…' }), 0);
  assert.equal(chapterIdxFromEvent({ message: '续写第 43 章…' }), 43);
});

test('V0.105 写作台：目标章数在主行、网格用 pilotGridSize、记债进事件流、等待心跳', () => {
  const ws = read('web/js/views/workshop.js');
  assert.match(ws, /from '\.\.\/pilot-observe\.js'/);
  assert.match(ws, /pilotGridSize\(/);
  assert.match(ws, /id: 'pilot-target'/);
  assert.doesNotMatch(ws, /Math\.min\(targetChapters \|\| chapters\.length, chapters\.length\)/);
  const card = ws.slice(ws.indexOf('function renderAutoCreationCard'), ws.indexOf('const PUBLICATION_STAGE_META'));
  assert.match(card, /id: 'pilot-target'/);
  assert.match(card, /auto-create-main/);
  assert.doesNotMatch(card, /id: 'pilot-polish',\s*checked: true/);
  const runPilotSrc = ws.slice(ws.indexOf('async function runPilot'));
  assert.match(runPilotSrc, /case 'debt':/);
  assert.match(runPilotSrc, /feed\('记债'/);
  assert.match(runPilotSrc, /setInterval/);
  assert.match(runPilotSrc, /emittedAt/);
  assert.match(runPilotSrc, /mozhou-pilot-idx/);
  assert.match(runPilotSrc, /livePatchChapterList/);
});

test('V0.105 自动创作中侧栏状态要跟作业走，切过滤不得拆掉观察流', () => {
  const ws = read('web/js/views/workshop.js');
  assert.match(ws, /data-chapter-idx/);
  assert.match(ws, /data-ch-filter/);
  assert.match(ws, /function chapterListState/);
  const sidebar = ws.slice(ws.indexOf('侧栏：章列表'), ws.indexOf('view.append(deskFold)'));
  assert.doesNotMatch(sidebar, /chFilter = key; rerender\(\)/);
  assert.match(sidebar, /livePatchChapterList = /);
});

test('V0.105 顶栏作业花片从 lastEvent 文案提取章号', () => {
  const app = read('web/js/app.js');
  assert.match(app, /from '\.\/pilot-observe\.js'/);
  assert.match(app, /chapterIdxFromEvent/);
});

test('V0.105 卷审事件必须发给作业对象而不是字符串名', async () => {
  const { emitVolumeReviewEvent } = await import('../server/engine/planning/volumereview.js');
  const seen = [];
  emitVolumeReviewEvent((ev) => seen.push(ev), 'volume_review_start', { volumeIdx: 5, title: '天倾石坠' });
  assert.equal(seen[0].type, 'volume_review_start');
  assert.equal(seen[0].volumeIdx, 5);
  emitVolumeReviewEvent((ev) => seen.push(ev), { type: 'volume_review_revising', count: 2 });
  assert.equal(seen[1].type, 'volume_review_revising');
  const src = read('server/jobs/recovery-jobs.js');
  assert.match(src, /if \(!event \|\| typeof event !== 'object'\) return/);
});

test('V0.105 卷大纲重试可见、限流等待可取消', () => {
  const outline = read('server/engine/planning/outline.js');
  const gen = outline.slice(outline.indexOf('export async function generateVolumeOutline'));
  assert.match(gen, /卷大纲第 \$\{attempt \+ 1\}\/3 次生成/);
  assert.match(gen, /onRetry/);
  assert.match(gen, /type: 'api_retry'/);
  const cont = read('server/engine/pipeline/continuation.js');
  assert.match(cont, /generateVolumeOutline\([\s\S]*onEvent, signal/);
  assert.doesNotMatch(cont, /onEvent: \(ev\) => emit\(ev\.stage \|\| 'setup'/);
  const client = read('server/llm/client.js');
  assert.match(client, /function sleep\(ms, signal\)/);
  assert.match(client, /signal\?\.addEventListener\('abort'/);
  const ws = read('web/js/views/workshop.js');
  const runPilotSrc = ws.slice(ws.indexOf('async function runPilot'));
  assert.match(runPilotSrc, /case 'api_retry':/);
  assert.match(runPilotSrc, /feed\('重试'/);
  assert.match(runPilotSrc, /waitMs/);
});

test('V0.105 懒加载下一卷：安全闸拦截不得再烧一遍缝前体检', () => {
  const vr = read('server/engine/planning/volumereview.js');
  assert.match(vr, /export function shouldReviewVolumeBeforeLazyOutline/);
  const pilot = read('server/engine/pipeline/pilot.js');
  assert.match(pilot, /\.filter\(shouldReviewVolumeBeforeLazyOutline\)/);
  assert.match(pilot, /卷缝前体检/);
  const auto = vr.slice(vr.indexOf('export async function autoReviewVolumes'), vr.indexOf('export function volumeReviewDisplayEvent'));
  assert.match(auto, /r\.status !== 'failed'/);
  assert.doesNotMatch(auto, /r\.status !== 'failed' && r\.status !== 'needs_attention'/);
});

test('V0.105 卷审修订过程要进标题和事件流，不能停在宪章完成', () => {
  const ws = read('web/js/views/workshop.js');
  const runPilotSrc = ws.slice(ws.indexOf('async function runPilot'));
  const startCase = runPilotSrc.slice(runPilotSrc.indexOf("case 'volume_review_start'"), runPilotSrc.indexOf("case 'volume_review_error'"));
  assert.match(startCase, /setCur\(/);
  assert.match(runPilotSrc, /case 'volume_review_revise'/);
  assert.match(runPilotSrc, /case 'volume_review_revision_building'/);
});

test('V0.105 完结卷配角弧光补全必须进事件流，不能停在恢复完成像卡死', () => {
  // V0.105.4：cast 设计改为 roster.sweepVolumeCastDesign（持久化幂等），事件流文案随迁；
  // 断言改为 sweep 内的进度文案 + pilot 调用点。
  const pilot = read('server/engine/pipeline/pilot.js');
  const rosterSrc = read('server/engine/narrative/roster.js');
  assert.match(rosterSrc, /配角弧光补全/);
  assert.match(rosterSrc, /await runCastDesign/);
  assert.match(pilot, /sweepVolumeCastDesign/);
});
