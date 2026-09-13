// V0.21 API 韧性层测试：重试/熔断/草稿保护/场景降级/健康度
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-v021-'));
process.env.NOVEL_DATA_DIR = tmp;
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_FAULT = '';

let client, resilience, store, pipeline, write;
let bookId, chapterId;

const FAST = { maxRetries: 2, rateLimitBackoffMs: 5, retryBackoffMs: 5, jitterMs: 0 };
const NO_CB = { circuitBreaker: { threshold: 100, openMs: 100 } };

before(async () => {
  client = await import('../server/llm/client.js');
  resilience = await import('../server/llm/resilience.js');
  store = await import('../server/db/store.js');
  pipeline = await import('../server/engine/pipeline/pipeline.js');
  write = await import('../server/engine/pipeline/write.js');
  bookId = store.books.create({ title: '韧性测试', genre: '玄幻', blurb: 'x' }).id;
  chapterId = store.chapters.create(bookId, null, 1, { title: '第一章' }).id;
});

after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ } });

function resetFault() { process.env.NOVEL_FAULT = ''; }

test('V0.21: 429 限流自动重试——重试后成功且计数正确', async () => {
  resilience.resetCircuits(); resetFault();
  process.env.NOVEL_FAULT = '429:1';
  const r = await client.chatCompletion({
    model: 'm', messages: [{ role: 'user', content: '生成细纲测试' }], jsonMode: true,
    baseUrl: 'http://x', apiKey: 'k', resilience: { ...FAST, ...NO_CB },
  });
  assert.equal(r.retries, 1, '应重试 1 次');
  assert.ok(r.content.length > 0);
});

test('V0.21: 5xx 重试耗尽——最终抛出且健康度记录失败', async () => {
  resilience.resetCircuits(); resetFault(); resilience.resetHealth();
  process.env.NOVEL_FAULT = '500:99';
  await assert.rejects(
    client.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'x' }], baseUrl: 'http://x', apiKey: 'k', resilience: { ...FAST, ...NO_CB } }),
    (e) => e.code === 'API_ERROR' || e.code === 'RATE_LIMIT',
  );
  const h = resilience.healthSnapshot();
  assert.ok(h.fail >= 1, '健康度应有失败记录');
});

test('V0.21: 熔断器——连续失败达阈值后快速失败 CIRCUIT_OPEN', async () => {
  resilience.resetCircuits(); resetFault();
  process.env.NOVEL_FAULT = '500:99';
  const cfg = { maxRetries: 0, rateLimitMaxRetries: 0, circuitBreaker: { threshold: 1, openMs: 60000 } };
  // rateLimitMaxRetries: 0 = 熔断开窗等待预算为 0，保持"快速失败"语义（V0.100.2 起默认等待开窗）
  await assert.rejects(
    client.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'x' }], baseUrl: 'http://breaker', apiKey: 'k', resilience: cfg }),
    (e) => e.code === 'API_ERROR',
  );
  // 第 2 次调用：熔断中，不发起请求直接 CIRCUIT_OPEN
  await assert.rejects(
    client.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'x' }], baseUrl: 'http://breaker', apiKey: 'k', resilience: cfg }),
    (e) => e.code === 'CIRCUIT_OPEN',
  );
  const snap = resilience.circuitSnapshot();
  assert.ok(snap.some(c => c.state === 'OPEN'), '熔断器应处于 OPEN');
});

test('V0.100.2: 熔断开窗不即死——等待窗口结束后探针恢复成功', async () => {
  resilience.resetCircuits(); resetFault();
  process.env.NOVEL_FAULT = '500:1';
  // threshold 1 → 第一次失败即熔断 100ms；第二次调用应等待开窗（计入限流耐心预算）后探针成功
  const cfg = {
    maxRetries: 0, rateLimitMaxRetries: 2, rateLimitBackoffMs: 1, retryBackoffMs: 1, jitterMs: 0,
    circuitBreaker: { threshold: 1, openMs: 100, maxOpenMs: 1000 },
  };
  await assert.rejects(
    client.chatCompletion({ model: 'm', messages: [{ role: 'user', content: 'x' }], baseUrl: 'http://breaker2', apiKey: 'k', resilience: cfg }),
    (e) => e.code === 'API_ERROR',
  );
  const retryEvents = [];
  const r = await client.chatCompletion({
    model: 'm', messages: [{ role: 'user', content: '生成细纲测试' }], jsonMode: true,
    baseUrl: 'http://breaker2', apiKey: 'k', resilience: cfg,
    onRetry: info => retryEvents.push(info),
  });
  assert.ok(r.content.length > 0, '熔断开窗后探针应恢复成功');
  assert.equal(retryEvents[0]?.reason, 'CIRCUIT_OPEN', '重试事件必须区分熔断等待');
});

test('V0.100.2: 网络中断走独立耐心预算——普通预算耗尽后仍按网络预算等待重试', async () => {
  resilience.resetCircuits(); resetFault();
  process.env.NOVEL_FAULT = 'NETWORK_ERROR:4';
  const retryWaits = [];
  const r = await client.chatCompletion({
    model: 'm', messages: [{ role: 'user', content: '生成细纲测试' }], jsonMode: true,
    baseUrl: 'http://x-net', apiKey: 'k',
    resilience: {
      maxRetries: 1, networkMaxRetries: 5, networkBackoffMs: 1, rateLimitBackoffMs: 1,
      retryBackoffMs: 1, jitterMs: 0, circuitBreaker: { threshold: 100, openMs: 100 },
    },
    onRetry: info => retryWaits.push(info),
  });
  assert.equal(r.retries, 4, '网络故障必须重试满独立预算，不被普通预算（1 次）截断');
  assert.ok(retryWaits.every(info => Number.isFinite(info.waitMs)), '重试事件必须带等待毫秒数（前端要显示等待时长）');
});

test('V0.100.2: 网络耐心预算耗尽 fail-closed，终态提示断点续跑', async () => {
  resilience.resetCircuits(); resetFault();
  process.env.NOVEL_FAULT = 'NETWORK_ERROR:9';
  await assert.rejects(
    client.chatCompletion({
      model: 'm', messages: [{ role: 'user', content: 'x' }], jsonMode: true,
      baseUrl: 'http://x-net-exhaust', apiKey: 'k',
      resilience: {
        maxRetries: 1, networkMaxRetries: 3, networkBackoffMs: 1, rateLimitBackoffMs: 1,
        retryBackoffMs: 1, jitterMs: 0, circuitBreaker: { threshold: 100, openMs: 100 },
      },
    }),
    (e) => e.code === 'NETWORK_ERROR' && /断点继续/.test(e.message),
  );
});

test('V0.21: 流中断草稿保护——stall 后部分正文落 draft', async () => {
  resilience.resetCircuits(); resetFault();
  store.chapters.update(chapterId, { outline: { title: '第一章', scenes: [
    { pov: '林晚', location: '青云城', beat: '林晚在城门遇到旧敌', target_words: 800 },
  ] } });
  const scene = store.scenes.create(chapterId, 1, { pov: '林晚', location: '青云城', beat: 'a', targetWords: 800, status: 'planned' });
  // 第一次：流卡死（stall ×3 = 3 次尝试全失败，耗尽重试）→ 草稿保护
  process.env.NOVEL_FAULT = 'stall:3';
  await assert.rejects(write.writeScene(bookId, chapterId, scene.id, {
    onDelta: () => {}, resilience: { ...FAST, ...NO_CB },
  }));
  const draft = store.scenes.get(scene.id);
  assert.equal(draft.status, 'draft', '失败后应落草稿');
  assert.ok(draft.content.includes('雨还在下'), '草稿应包含部分正文');
  // 冲突记录
  const conflicts = store.conflicts.list(bookId);
  assert.ok(conflicts.some(c => c.type === '生成中断'), '应记录生成中断冲突');
});

test('V0.21: 草稿续写——draft 场景重跑从断点续写并完成', async () => {
  resilience.resetCircuits(); resetFault();
  const scene = store.scenes.list(chapterId)[0];
  assert.equal(scene.status, 'draft');
  const originalDraft = scene.content;
  const r = await write.writeScene(bookId, chapterId, scene.id, { resilience: { ...FAST, ...NO_CB } });
  const after = store.scenes.get(scene.id);
  assert.equal(after.status, 'done', '重跑后应完成');
  assert.ok(after.content.includes('草稿续写'), '应走草稿续写分支（mock 标记）');
  assert.ok(after.content.startsWith(originalDraft), '续写成功后必须保留已落库草稿前缀，不能用新响应覆盖');
  assert.ok(r.content.length > 50);
});

test('V0.77: 草稿续写合并——任意续写响应都保留前缀并去掉边界重复', () => {
  assert.equal(
    write.mergeDraftContinuation('旧草稿完整前缀', '这是模型的新续写'),
    '旧草稿完整前缀\n这是模型的新续写',
  );
  assert.equal(
    write.mergeDraftContinuation('雨声渐远，天色渐暗', '天色渐暗。他推门而入。'),
    '雨声渐远，天色渐暗。他推门而入。',
  );
});

test('V0.77: 场景级降级——保留后续场景，但不完整章节不得审校结算或标记完成', async () => {
  resilience.resetCircuits(); resetFault();
  // 新章节：场景1 写失败（fault 500:3 = 3 次尝试全失败耗尽重试），场景2 正常
  const ch2 = store.chapters.create(bookId, null, 2, { title: '第二章' }).id;
  store.chapters.update(ch2, { outline: { title: '第二章', scenes: [
    { pov: '林晚', location: '青云城', beat: 'b1', target_words: 500 },
    { pov: '林晚', location: '青云城', beat: 'b2', target_words: 500 },
  ] } });
  store.scenes.create(ch2, 1, { pov: '林晚', location: '青云城', beat: 'b1', targetWords: 500, status: 'planned' });
  store.scenes.create(ch2, 2, { pov: '林晚', location: '青云城', beat: 'b2', targetWords: 500, status: 'planned' });

  process.env.NOVEL_FAULT = '500:6'; // V0.29：场景失败自动重试一次——需 6 个故障（client 3 次尝试 × pipeline 自动重试 3 次）才能让场景1 彻底失败
  const events = [];
  const r = await pipeline.runChapterFlow(bookId, ch2, {
    autoConfirm: true,
    onEvent: ev => events.push(ev),
    resilience: { ...FAST, ...NO_CB },
  });
  assert.deepEqual(r.failedScenes, [1], '场景1应标记失败');
  assert.ok(events.some(e => e.type === 'scene_failed'), '应 emit scene_failed');
  assert.ok(events.some(e => e.type === 'chapter_partial'), '应 emit chapter_partial');
  const s1 = store.scenes.list(ch2).find(s => s.idx === 1);
  const s2 = store.scenes.list(ch2).find(s => s.idx === 2);
  assert.equal(s1.status, 'failed', '场景1 保持 failed');
  assert.equal(s2.status, 'done', '场景2 正常完成');
  assert.equal(r.status, 'partial', '整章应保持可恢复的 partial，而不是伪装完成');
  assert.equal(r.settled, undefined, '不完整章节不得结算派生事实');
  const ch2row = store.chapters.get(ch2);
  assert.equal(ch2row.status, 'partial');
  assert.equal(store.summaries.get(ch2), undefined, '不完整章节不得生成摘要');
});

test('V0.21: 重跑自动补写——failed 场景在下次 flow 被重写为 done', async () => {
  resilience.resetCircuits(); resetFault();
  const ch2 = store.chapters.list(bookId).find(c => c.idx === 2);
  assert.ok(ch2, '找到第二章');
  const r = await pipeline.runChapterFlow(bookId, ch2.id, { autoConfirm: true });
  assert.equal(r.failedScenes.length, 0, '补写后无失败场景');
  const s1 = store.scenes.list(ch2.id).find(s => s.idx === 1);
  // V0.93.11：跨章复读防线（mock 场景正文相同）会命中补写场景并触发自动修订 → 场景为完成态 revised（同 done 语义，settle 视为完成）
  assert.ok(['done', 'revised'].includes(s1.status), `场景1 已补写完成（实际 ${s1.status}）`);
});

test('V0.21: 健康度快照——成功率与平均耗时统计正确', () => {
  resilience.resetHealth();
  resilience.recordHealth({ ok: true, durationMs: 100, provider: 'http://x' });
  resilience.recordHealth({ ok: true, durationMs: 300, provider: 'http://x' });
  resilience.recordHealth({ ok: false, durationMs: 50, provider: 'http://x', code: 'API_ERROR' });
  const h = resilience.healthSnapshot();
  assert.equal(h.total, 3);
  assert.equal(h.ok, 2);
  assert.equal(h.successRate, 66.7);
  assert.equal(h.avgDurationMs, 150);
  assert.equal(h.lastErrors.length, 1);
});

test('V0.100.1: 429 走独立耐心预算——普通预算为 0 时限流仍重试到成功', async () => {
  resilience.resetCircuits(); resetFault();
  // OpenRouter upstream_provider_shared_pool 实证：上游共享池限流窗口常达数分钟，
  // 与普通故障共用 maxRetries 会在窗口内耗尽（混合故障 4 次 2 分钟全灭）。
  // 429 独立预算：普通预算 maxRetries=0 时仍按 rateLimitMaxRetries 重试。
  process.env.NOVEL_FAULT = '429:2';
  const r = await client.chatCompletion({
    model: 'm', messages: [{ role: 'user', content: 'x' }], jsonMode: true,
    baseUrl: 'http://x-rl-patient', apiKey: 'k',
    resilience: {
      maxRetries: 0, rateLimitBackoffMs: 1, retryBackoffMs: 1, jitterMs: 0,
      circuitBreaker: { threshold: 100, openMs: 100 },
    },
  });
  assert.equal(r.retries, 2, '429 独立预算：普通预算为 0 也应重试 2 次后成功');
  assert.ok(r.content.length > 0);
});

test('V0.100.1: 429 耐心预算耗尽即 fail-closed（有界，不无界自愈烧费）', async () => {
  resilience.resetCircuits(); resetFault();
  process.env.NOVEL_FAULT = '429:9';
  await assert.rejects(
    client.chatCompletion({
      model: 'm', messages: [{ role: 'user', content: 'x' }], jsonMode: true,
      baseUrl: 'http://x-rl-bounded', apiKey: 'k',
      resilience: {
        maxRetries: 3, rateLimitMaxRetries: 2, rateLimitBackoffMs: 1, jitterMs: 0,
        circuitBreaker: { threshold: 100, openMs: 100 },
      },
    }),
    (e) => e.code === 'RATE_LIMIT' && e.retries === 2 && e.attempts?.length === 3,
  );
});

test('V0.100.1: 混合故障中 429 不挤占普通重试预算', async () => {
  resilience.resetCircuits(); resetFault();
  // 1 次网络中断（普通预算）+ 2 次 429（耐心预算）后成功——旧逻辑共享预算 maxRetries=1 时第二次失败即抛
  process.env.NOVEL_FAULT = '500:1,429:2';
  const r = await client.chatCompletion({
    model: 'm', messages: [{ role: 'user', content: 'x' }], jsonMode: true,
    baseUrl: 'http://x-rl-mixed', apiKey: 'k',
    resilience: {
      maxRetries: 1, rateLimitMaxRetries: 3, rateLimitBackoffMs: 1, retryBackoffMs: 1, jitterMs: 0,
      circuitBreaker: { threshold: 100, openMs: 100 },
    },
  });
  assert.equal(r.retries, 3, '网络中断耗 1 次普通预算，2 次限流走独立预算，总重试 3 次');
});

test('V0.100.1: 限流主导的失败终态消息必须提示断点续跑（进度已保存）', async () => {
  resilience.resetCircuits(); resetFault();
  // OpenRouter upstream_provider_shared_pool 实证：共享池限流窗口可持续一小时以上，
  // 重试预算耗尽后用户最需要知道的是"进度已保存、稍后从断点继续"，而非裸错误。
  process.env.NOVEL_FAULT = '429:9';
  await assert.rejects(
    client.chatCompletion({
      model: 'm', messages: [{ role: 'user', content: 'x' }], jsonMode: true,
      baseUrl: 'http://x-rl-terminal-msg', apiKey: 'k',
      resilience: {
        maxRetries: 3, rateLimitMaxRetries: 2, rateLimitBackoffMs: 1, jitterMs: 0,
        circuitBreaker: { threshold: 100, openMs: 100 },
      },
    }),
    (e) => e.code === 'RATE_LIMIT'
      && /进度已保存/.test(e.message)
      && /断点继续/.test(e.message),
  );
});

test('V0.100.1: 非限流主导的失败终态消息不追加断点提示（防误注入）', async () => {
  resilience.resetCircuits(); resetFault();
  process.env.NOVEL_FAULT = '500:9';
  await assert.rejects(
    client.chatCompletion({
      model: 'm', messages: [{ role: 'user', content: 'x' }], jsonMode: true,
      baseUrl: 'http://x-500-no-hint', apiKey: 'k',
      resilience: {
        maxRetries: 3, retryBackoffMs: 1, rateLimitBackoffMs: 1, jitterMs: 0,
        circuitBreaker: { threshold: 100, openMs: 100 },
      },
    }),
    (e) => !/断点继续/.test(e.message),
  );
});
