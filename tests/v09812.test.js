// V0.98.12 楔子主角在场（防纪录片念稿）本地判废 + 旧开篇方案可删除
import './helper.js';
import { test, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import * as store from '../server/db/store.js';
import { createOpeningFixture, validContract, sha256 } from './helpers/opening_fixture.js';

let book, volume, firstScene;

const promiseData = {
  premise_in_one_breath: '一个孩子在战乱中学会保护别人', primary_attraction_axis: '保护与成长', secondary_axes: [],
  protagonist_now: { lack: '弱小', immediate_need: '护住家人', agency_pattern: '观察后保护' },
  payoff_ladder: { near: ['有效选择'], middle: ['保护同伴'], long: ['守住山河'] },
  texture: { route: 'serious_immersive_history', pace: '稳', humor: 'low', historical_density: 'high', pov: 'close_third' },
  protected_elements: [], anti_promises: ['无系统'], author_locks: [], confidence: {},
};

beforeEach(async () => {
  ({ book, volume, firstScene } = createOpeningFixture(store));
});

// 创作宪章的 source_fingerprint 包含角色卡——必须先建主角卡、再建立宪章，否则判为 stale
async function buildPromise(bookId = book.id) {
  const { buildStoryPromiseProfile } = await import('../server/engine/planning/story_promise.js');
  await buildStoryPromiseProfile(bookId, { data: promiseData });
}

function addProtagonist(bookId = book.id) {
 store.characters.create(bookId, { name: '主角', tier: 'protagonist' });
}

const planFields = ({ kind, family, signature, content = '' }) => ({
  kind, strategy_family: family, entry_signature: signature,
 creative_hypothesis: `${family} 假设`, entry_time: '1241年', first_actor: '主角',
  immediate_problem: '北边反常', first_choice: '先护住弟弟', first_state_change: '一家人警觉',
  strongest_axis: 'question', transition_plan: '接回庙会', content,
});

function composeCold(storeRef, bookId, volumeId, content) {
  return import('../server/engine/planning/opening_intervention.js').then(({ composeOpeningCandidates }) =>
    composeOpeningCandidates(bookId, {
      mode: 'repair',
      data: {
        candidates: [{
          ...planFields({ kind: 'chapter1_cold_open', family: 'future_result_present_question', signature: '1259|守城少年|城下异动|回望', content }),
          contract: validContract(volumeId),
        }],
      },
    }));
}

// 念稿式楔子：全景事件陈述、全程无主角（第一屏 120 字内不含主角名）
const documentaryColdOpen = `开庆元年七月，钓鱼城头。砲石一发接一发砸上垛口，墙砖崩出一片白灰。守军压着垛口放箭，城下的攻城车推过壕沟，烟尘里隐约能看见九斿白旗。城头一片喊杀，号角响了第三遍。\n\n十八年前，淳祐元年。`;

test('V0.98.12 楔子第一屏主角姓名缺席 → high 判废（纪录片念稿防线：主角不在场直接禁止采用）', async () => {
  addProtagonist();
  await buildPromise();
  const { selectOpeningAsset } = await import('../server/engine/planning/opening_intervention.js');
  const composed = await composeCold(store, book.id, volume.id, documentaryColdOpen);
  const cold = composed.candidates.find(item => item.kind === 'chapter1_cold_open');
  const audit = JSON.parse(store.openingAssets.get(cold.asset_id).audit_json);
  assert.ok(audit.issues.some(item => item.code === 'cold_open_protagonist_absent' && item.severity === 'high'),
    '全景事件陈述、主角从未出场=念稿式开场，必须本地判废（此前只靠 LLM 审校软判，屡次漏网）');
  assert.throws(() => selectOpeningAsset(book.id, cold.asset_id), error => error?.code === 'OPENING_AUDIT_BLOCKED');
});

test('V0.98.12 主角在前 120 字内点名出场并立即动作 → 不误伤判废', async () => {
  addProtagonist();
  await buildPromise();
  const composed = await composeCold(store, book.id, volume.id,
 `开庆元年七月，钓鱼城东新门，第二拨砲石已经压进膛口。主角拽开挡在垛口前的传令兵，自己探身去看江面。\n\n十八年前，淳祐元年的灯影还没散。`);
  const cold = composed.candidates.find(item => item.kind === 'chapter1_cold_open');
  const audit = JSON.parse(store.openingAssets.get(cold.asset_id).audit_json);
  assert.equal(audit.issues.some(item => item.code === 'cold_open_protagonist_absent'), false,
    '主角在场并动作的楔子不得触发缺席判废');
  assert.equal(audit.issues.some(item => item.severity === 'high'), false, '锚定+在场+回切齐全时干净通过');
});

test('V0.98.12 无可解析主角名（角色卡未建）时判废自动跳过，其余防线照常', async () => {
  await buildPromise();
  const composed = await composeCold(store, book.id, volume.id, documentaryColdOpen);
  const cold = composed.candidates.find(item => item.kind === 'chapter1_cold_open');
  const audit = JSON.parse(store.openingAssets.get(cold.asset_id).audit_json);
  assert.equal(audit.issues.some(item => item.code === 'cold_open_protagonist_absent'), false,
    '没有可信主角名时不判废（防误杀），念稿风险交给纪律文本与审校');
});

test('V0.98.12 契约上下文携带主角名，写作/审校/压缩三处注入同源纪律', async () => {
  addProtagonist();
  await buildPromise();
  const { COLD_OPEN_CRAFT_TEXT } = await import('../server/data/literary_techniques.js');
  assert.ok(COLD_OPEN_CRAFT_TEXT.includes('主角姓名'), '工艺必须量化到第一屏主角点名');
  assert.ok(COLD_OPEN_CRAFT_TEXT.includes('正例'), '禁令必须结对正例');
  assert.ok(/[0-9]{4}年/.test(COLD_OPEN_CRAFT_TEXT), '正例必须至少一个带真实年份的具体场景');

  const { openingContractEventContext, inferOpeningContractTarget } = await import('../server/engine/planning/opening_intervention.js');
  const { openingCandidateInstruction, openingCandidateAuditInstruction, openingCandidateLengthRepairInstruction } = await import('../server/engine/prompts.js');
  const contractEvent = openingContractEventContext(book.id, inferOpeningContractTarget(book.id));
 assert.ok(contractEvent.protagonist_names.includes('主角'), '契约上下文必须携带主角名供模型点名');
  const strategy = { kind: 'chapter1_cold_open', strategy_family: 'future_result_present_question' };

  const write = openingCandidateInstruction({ book, strategy, contractEvent, budget: { preferred: [300, 800], hardMax: 1000 } });
  assert.ok(write.includes('神开局工艺'), '写作指令注入工艺');
 assert.ok(write.includes('主角：主角'), '契约块必须显示点名主角');

  const audit = openingCandidateAuditInstruction({ book, candidate: { kind: 'chapter1_cold_open' }, contractEvent });
  assert.ok(audit.includes('神开局工艺'), '审校与写作同源拿到同一工艺');
  assert.ok(audit.includes('主角'), '审校专项必须核对主角在场');

  const repair = openingCandidateLengthRepairInstruction({
    strategy, content: '超限正文', contractEvent, budget: { preferred: [300, 800], hardMax: 1000 },
  });
  assert.ok(repair.includes('神开局工艺'), '压缩不得丢工艺与主角在场要求');
});

// ---------- 旧开篇方案删除 ----------

function createChain(kind) {
  const placement = { head_rewrite: 'scene_patch', chapter1_cold_open: 'prepend_chapter1', standalone_prologue: 'before_chapter1' }[kind];
  return store.openingAssets.create(book.id, { kind, placement, title: `${kind}旧方案`, content: '旧方案正文' });
}

test('V0.98.12 旧方案可删除：candidate/audited/selected/rejected/retired 五种状态放行', async () => {
  const candidate = createChain('head_rewrite');
  const audited = createChain('head_rewrite');
  store.openingAssets.transition(audited.id, 'audited');
  const selected = createChain('head_rewrite');
  store.openingAssets.transition(selected.id, 'audited');
  store.openingAssets.transition(selected.id, 'selected');
  const retired = createChain('chapter1_cold_open');
  store.openingAssets.transition(retired.id, 'retired');
  const rejected = createChain('standalone_prologue');
  store.openingAssets.transition(rejected.id, 'rejected');

  for (const asset of [candidate, audited, selected, retired, rejected]) {
    const result = store.openingAssets.remove(asset.id);
    assert.ok(result.changes > 0, `状态 ${asset.status} 的旧方案必须可删除`);
    assert.equal(store.openingAssets.get(asset.id), undefined, `已删除资产不得残留（${asset.status}）`);
  }
});

test('V0.98.12 已应用（applied）方案禁止直接删除，防止在线/本地发布视图丢失', async () => {
  const applied = createChain('head_rewrite');
  store.openingAssets.transition(applied.id, 'audited');
  store.openingAssets.transition(applied.id, 'selected');
  store.openingAssets.transition(applied.id, 'applied');
  const result = store.openingAssets.remove(applied.id);
  assert.equal(result.changes, 0, 'applied 资产必须拒绝删除');
  assert.ok(store.openingAssets.get(applied.id), 'applied 资产删除失败后仍在库中');
});

test('V0.98.12 engine removeOpeningAsset：校验归属、拒绝 applied、删除后列表消失', async () => {
  const { removeOpeningAsset } = await import('../server/engine/planning/opening_intervention.js');
  const audited = createChain('chapter1_cold_open');
  store.openingAssets.transition(audited.id, 'audited');
  const removed = removeOpeningAsset(book.id, audited.id);
  assert.equal(removed.ok, true);
  assert.equal(store.openingAssets.list(book.id).some(asset => asset.id === audited.id), false, '删除后必须从列表消失');

  const applied = createChain('head_rewrite');
  for (const next of ['audited', 'selected', 'applied']) store.openingAssets.transition(applied.id, next);
  assert.throws(() => removeOpeningAsset(book.id, applied.id), error => error?.code === 'OPENING_ASSET_APPLIED');

  const otherBook = store.books.create({ title: '另一本书', genre: '都市', blurb: 'x' });
  const foreign = createChain('head_rewrite');
  assert.throws(() => removeOpeningAsset(otherBook.id, foreign.id), error => error?.code === 'OPENING_ASSET_NOT_OWNED');
});

test('V0.98.12 removeOpeningAsset 可删 selected（未应用的选中方案）', async () => {
  const { removeOpeningAsset } = await import('../server/engine/planning/opening_intervention.js');
  const selected = createChain('head_rewrite');
  store.openingAssets.transition(selected.id, 'audited');
  store.openingAssets.transition(selected.id, 'selected');
  const removed = removeOpeningAsset(book.id, selected.id);
  assert.equal(removed.ok, true);
  assert.equal(store.openingAssets.get(selected.id), undefined);
});

// ---------- 前端入口 ----------

test('V0.98.12 前端提供删除入口：api 封装 + 决策台删除按钮', () => {
  const api = fs.readFileSync('web/js/api.js', 'utf8');
  const workshop = fs.readFileSync('web/js/views/workshop.js', 'utf8');
  assert.ok(api.includes('removeOpeningAsset'), 'api.js 必须封装删除方法');
  assert.ok(api.includes("api('DELETE'") || api.includes('del('), '删除必须走 DELETE 动词');
  assert.ok(workshop.includes('removeOpeningAsset'), '候选卡片必须调用删除 API');
  assert.ok(workshop.includes('删除此方案'), '候选卡片必须提供「删除此方案」按钮');
  assert.ok(workshop.includes('confirmDialog'), '删除前必须二次确认');
  assert.match(workshop, /applied[\s\S]{0,120}删除|删除[\s\S]{0,120}撤下/, '已应用方案应提示先撤下而不是直接删除');
});

test('V0.98.12 async 事件处理器禁止在 await 之后访问 ev.currentTarget（点击无反应的根因回归）', () => {
  const workshop = fs.readFileSync('web/js/views/workshop.js', 'utf8');
  assert.equal(workshop.includes('await run(ev.currentTarget'), false,
    'confirmDialog/await 之后 currentTarget 已被 DOM 清空为 null——必须同步阶段捕获按钮（V0.98.12 实测：删除方案点击无反应、控制台 Cannot set properties of null）');
  assert.match(workshop, /删除此方案[\s\S]{0,300}const btn = ev\.currentTarget/,
    '删除按钮处理器必须在第一行同步捕获按钮引用');
  assert.match(workshop, /采用此方案[\s\S]{0,300}const btn = ev\.currentTarget/,
    '采用此方案按钮同款反模式必须同步修复');
});

// ---------- 真实 HTTP 冒烟 ----------

const httpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v09812-http-'));
let httpPort;
let httpBase;
let child;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close(error => error ? reject(error) : resolve(value));
    });
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${httpBase}/api/health`);
      if (response.ok) return;
    } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('test server did not start');
}

async function json(method, pathname, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json', Origin: httpBase };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${httpBase}${pathname}`, options);
  const raw = await response.text();
  return { response, body: raw ? JSON.parse(raw) : null, raw };
}

before(async () => {
  httpPort = await freePort();
  httpBase = `http://127.0.0.1:${httpPort}`;
  child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, NOVEL_DATA_DIR: httpDataDir, NOVEL_PORT: String(httpPort), NOVEL_NO_OPEN: '1', NOVEL_MOCK_LLM: '1', NOVEL_FAULT: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  await waitForHealth();
});

after(async () => {
  if (child && child.exitCode === null) child.kill();
});

test('V0.98.12 真实 HTTP：DELETE 删除属于本书的旧候选，外书资产 404，applied 拒绝', async () => {
  const created = await json('POST', '/api/books', { title: '删除冒烟书', genre: '历史', platform: '番茄', blurb: '测试' });
  assert.equal(created.response.status, 200, created.raw);
  const bookId = created.body.id;
  const db = new DatabaseSync(path.join(httpDataDir, 'novel.db'));
  const volumeId = 'vol-v09812-1';
  const targetVolumeId = 'vol-v09812-2';
  const chapterId = 'ch-v09812-1';
  db.prepare(`INSERT INTO volumes (id,book_id,idx,title,goal,outline_json,status) VALUES (?,?,1,'第一卷','活下来','{}','planned')`).run(volumeId, bookId);
  db.prepare(`INSERT INTO volumes (id,book_id,idx,title,goal,outline_json,status) VALUES (?,?,2,'目标卷','兑现长期事件',?,'planned')`).run(targetVolumeId, bookId,
    JSON.stringify({ year: 1259, event_keys: ['historical:1259:test-event'] }));
  db.prepare(`INSERT INTO chapters (id,book_id,volume_id,idx,title,outline_json,status,word_count,created_at)
    VALUES (?,?,?,1,'灯影','{}','done',30,?)`).run(chapterId, bookId, volumeId, Date.now());
  const assetId = 'oa-v09812-1';
  db.prepare(`INSERT INTO opening_assets
    (id,book_id,kind,placement,title,anchor_scene_id,anchor_start,anchor_end,source_excerpt,source_hash,
     content,contract_json,audit_json,rank_json,creative_hypothesis,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    assetId, bookId, 'chapter1_cold_open', 'prepend_chapter1', '旧楔子', null, null, null, '', '',
    '旧方案正文', JSON.stringify({}), JSON.stringify({}), JSON.stringify({}), '', 'audited', Date.now(), Date.now());
  const appliedId = 'oa-v09812-2';
  db.prepare(`INSERT INTO opening_assets
    (id,book_id,kind,placement,title,anchor_scene_id,anchor_start,anchor_end,source_excerpt,source_hash,
     content,contract_json,audit_json,rank_json,creative_hypothesis,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    appliedId, bookId, 'head_rewrite', 'scene_patch', '已应用顺叙', null, null, null, '', '',
    '已应用正文', JSON.stringify({}), JSON.stringify({}), JSON.stringify({}), '', 'applied', Date.now(), Date.now());
  db.close();

  const removed = await json('DELETE', `/api/books/${bookId}/opening-assets/${assetId}`);
  assert.equal(removed.response.status, 200, removed.raw);
  assert.equal(removed.body.ok, true);
  const listed = await json('GET', `/api/books/${bookId}/opening-assets`);
  assert.equal(listed.body.assets.some(asset => asset.id === assetId), false, '删除后列表不再返回该候选');

  const foreign = await json('POST', '/api/books', { title: '另一本书', genre: '都市', platform: '番茄', blurb: '测试' });
  const cross = await json('DELETE', `/api/books/${foreign.body.id}/opening-assets/${assetId}`);
  assert.equal(cross.response.status, 404, '外书资产必须 404');

  const denied = await json('DELETE', `/api/books/${bookId}/opening-assets/${appliedId}`);
  assert.equal(denied.response.status, 409, denied.raw);
  assert.equal(denied.body.code, 'OPENING_ASSET_APPLIED', '已应用方案拒绝删除并给出明确原因');
});