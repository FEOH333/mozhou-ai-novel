// V0.99.1：推荐返工长诊断的网络韧性。
// 回归用户实证：第 1—5 章诊断连续等待约 308 秒后只显示 `fetch failed`，
// 既重复使用同一首字节上限，也丢失前三轮超时与底层 socket 原因。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-v0991-'));
process.env.NOVEL_DATA_DIR = tmp;
process.env.NOVEL_MOCK_LLM = '';

const client = await import('../server/llm/client.js');
const resilience = await import('../server/llm/resilience.js');
const store = await import('../server/db/store.js');
const {
  diagnoseRecommendationRecovery, validateRecoveryDiagnosis,
} = await import('../server/engine/recommendation_recovery.js');

after(() => {
  try { store.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function sseOk(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  sseOkBody(res);
}

function sseOkBody(res) {
  res.end([
    'data: {"model":"mock","choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'));
}

test('V0.99.1 推流驾驶舱不把 recovery_started 内部事件名直接显示给用户', () => {
  const workshop = fs.readFileSync(path.join(process.cwd(), 'web/js/views/workshop.js'), 'utf8');
  assert.match(workshop, /event === 'recovery_started'.*返工诊断已启动/s);
});

test('V0.99.1 首字节已到后必须解除连接计时器，长流只受空闲/总时长约束', async () => {
  resilience.resetCircuits();
  // 这里要验证的是“fetch 已返回 Response 后连接计时器是否解除”，不应把本机 TCP
  // 调度速度也混进断言。全量测试并行初始化模型时，旧夹具的本地 HTTP 服务器偶尔
  // 100ms 内拿不到事件循环，产生与产品逻辑无关的假红。用立即返回响应头、延迟正文
  // 的标准 Response 精确隔离被测生命周期；若计时器未解除，100ms 时仍会掐断正文流。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode([
          'data: {"model":"mock","choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n')));
        controller.close();
      }, 180);
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  try {
    const result = await client.chatCompletion({
      model: 'mock', apiKey: 'test-key', baseUrl: 'http://timer-lifecycle.test',
      messages: [{ role: 'user', content: '慢慢回答好' }], stream: true,
      resilience: {
        connectTimeoutMs: 100, idleTimeoutMs: 400, totalTimeoutMs: 1000,
        maxRetries: 0,
        circuitBreaker: { threshold: 99, openMs: 1, maxOpenMs: 1 },
      },
    });
    assert.equal(result.content, '好');
    assert.ok(result.durationMs >= 170, '响应体应允许跨过首字节上限继续完成');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('V0.99.1 流式首字节超时后扩大下一轮窗口，不再用同一上限机械失败', async () => {
  resilience.resetCircuits();
  const server = http.createServer((_req, res) => {
    setTimeout(() => {
      if (!res.destroyed) sseOk(res);
    }, 750);
  });
  const baseUrl = await listen(server);
  const retryEvents = [];
  try {
    const result = await client.chatCompletion({
      model: 'mock', apiKey: 'test-key', baseUrl,
      messages: [{ role: 'user', content: '只回答好' }],
      stream: true, onRetry: event => retryEvents.push(event),
      resilience: {
        connectTimeoutMs: 500, idleTimeoutMs: 1500, totalTimeoutMs: 4000,
        maxRetries: 1, retryBackoffMs: 1, jitterMs: 0,
        circuitBreaker: { threshold: 99, openMs: 1, maxOpenMs: 1 },
      },
    });
    assert.equal(result.content, '好');
    assert.equal(retryEvents.length, 1);
    assert.equal(retryEvents[0].reason, 'HTTP_TIMEOUT');
    assert.equal(retryEvents[0].timeoutExtended, true);
    assert.ok(retryEvents[0].nextConnectTimeoutMs >= 1000);
  } finally {
    await close(server);
  }
});

test('V0.99.1 fetch failed 展开底层原因并保留重试链，不让最后一次错误覆盖前三次', async () => {
  assert.equal(typeof client.formatTransportFailure, 'function', '应提供统一的底层网络错误解释器');
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7890'), {
    code: 'ECONNREFUSED', address: '127.0.0.1', port: 7890,
  });
  const source = new TypeError('fetch failed', { cause });
  const message = client.formatTransportFailure(source, '连接失败');
  assert.match(message, /连接被拒绝/);
  assert.match(message, /ECONNREFUSED/);
  assert.match(message, /127\.0\.0\.1:7890/);

  resilience.resetCircuits();
  const server = http.createServer((_req, res) => res.socket.destroy());
  const baseUrl = await listen(server);
  try {
    await assert.rejects(client.chatCompletion({
      model: 'mock', apiKey: 'test-key', baseUrl,
      messages: [{ role: 'user', content: 'ping' }], stream: true,
      resilience: {
        connectTimeoutMs: 500, idleTimeoutMs: 500, totalTimeoutMs: 1000,
        maxRetries: 1, retryBackoffMs: 1, jitterMs: 0,
        // V0.100.2：网络中断已有独立耐心预算，本测试钉住 1 次重试的旧断言口径
        networkMaxRetries: 1, networkBackoffMs: 1,
        circuitBreaker: { threshold: 99, openMs: 1, maxOpenMs: 1 },
      },
    }), error => {
      assert.equal(error.code, 'NETWORK_ERROR');
      assert.equal(error.retries, 1);
      assert.equal(error.attempts?.length, 2);
      assert.match(error.message, /连续 2 次/);
      assert.doesNotMatch(error.message, /^fetch failed$/);
      return true;
    });
  } finally {
    await close(server);
  }
});

test('V0.99.1 推荐返工把模型重试实时转成 recovery_retry 事件', async () => {
  const book = store.books.create({ title: '返工重试可见性', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '空转', status: 'done', wordCount: 60,
  });
  store.scenes.create(chapter.id, 1, {
 content: '众人商量到深夜，主角始终没有作出决定，局势仍停在原处。',
    status: 'done', targetWords: 60,
  });
  store.publicationProfiles.upsert(book.id, {
    recommendationStage: 'failed', remainingAttempts: 2, suspectedTurnChapter: 1,
  });
  const events = [];
  const run = await diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 1, onEvent: event => events.push(event),
    runTaskImpl: async (options) => {
      assert.equal(typeof options.onRetry, 'function');
      options.onRetry({
        attempt: 1, reason: 'HTTP_TIMEOUT', message: '连接超时（90 秒）——服务商无响应',
        timeoutExtended: true, nextConnectTimeoutMs: 180000,
      });
      return {
        content: JSON.stringify({
          quality_curve: [{
            chapter: 1, score: 25, action: 'rebuild', evidence: ['没有作出决定'],
            effective_events: [], irreversible_change: '', character_cost: '', promise_delivery: '',
            filler_signals: ['反复商量但局势不变'], ending_pull: '',
 reason: '整章没有有效推进', rebuild_objective: '让主角作出有代价的选择并改变局势',
          }],
          segment_verdict: { deterioration_found: true, turn_chapter: 1, reason: '本章空转' },
        }),
        finishReason: 'stop',
      };
    },
  });
  assert.equal(run.status, 'planned');
  const retry = events.find(event => event.type === 'recovery_retry');
  assert.ok(retry, '返工事件流应显示自动重试，而不是静默等待数分钟');
  assert.equal(retry.from, 1);
  assert.equal(retry.to, 1);
  assert.equal(retry.nextConnectTimeoutMs, 180000);
});

test('V0.99.1 诊断证据含两段真实对白时逐段定位，不把中间省略叙述误判成杜撰', () => {
  const text = '夜太静。\n“……若真到那一步，”是父亲的声音，“你带两个孩子先走，我断后。”\n沉默。';
  const result = validateRecoveryDiagnosis({
    quality_curve: [{
      chapter: 1, score: 65, action: 'tune',
      evidence: ['“……若真到那一步，” “你带两个孩子先走，我断后。”'],
      effective_events: ['父亲安排退路'], irreversible_change: '', character_cost: '',
      promise_delivery: '', filler_signals: [], ending_pull: '父亲为何准备断后',
      reason: '家庭危机进入行动准备', rebuild_objective: '让安排在后续行动中产生代价',
    }],
    segment_verdict: { deterioration_found: false, turn_chapter: 1, reason: '本章仍有有效行动' },
  }, [{ idx: 1, title: '夜话', text }], { suspectedTurnChapter: 1 });
  assert.deepEqual(result.quality_curve[0].evidence, [
    '“……若真到那一步，”',
    '“你带两个孩子先走，我断后。”',
  ]);

  assert.throws(() => validateRecoveryDiagnosis({
    quality_curve: [{
      chapter: 1, score: 65, action: 'tune',
      evidence: ['“……若真到那一步，” “我会从天而降救你。”'],
      effective_events: [], irreversible_change: '', character_cost: '', promise_delivery: '',
      filler_signals: [], ending_pull: '', reason: '测试', rebuild_objective: '测试',
    }],
    segment_verdict: { deterioration_found: false, turn_chapter: 1, reason: '测试' },
  }, [{ idx: 1, title: '夜话', text }], { suspectedTurnChapter: 1 }), /无法在原文定位/,
  '任一拆分片段不存在时仍须失败关闭');
});

test('V0.99.1 模型给对白内连续短句补上合引号时，重定位为原文真实切片', () => {
  const text = '那人退回灶边：“我叫张老实，管这口锅。粥放那儿，你肯吃就吃。”';
  const result = validateRecoveryDiagnosis({
    quality_curve: [{
      chapter: 5, score: 70, action: 'keep', evidence: ['“我叫张老实，管这口锅。”'],
      effective_events: ['张老实给粥'], irreversible_change: '', character_cost: '',
      promise_delivery: '陌生人提供有限善意', filler_signals: [], ending_pull: '是否接粥',
      reason: '人物以行动建立信任', rebuild_objective: '',
    }],
    segment_verdict: { deterioration_found: false, turn_chapter: 5, reason: '本章仍有实质推进' },
  }, [{ idx: 5, title: '归骨', text }], { suspectedTurnChapter: 5 });
  assert.deepEqual(result.quality_curve[0].evidence, ['我叫张老实，管这口锅。']);
});

test('V0.99.1 诊断报告未过本地证据校验时自动纠正一次，仍不合格才交给用户', async () => {
  const book = store.books.create({ title: '诊断结构自愈', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '抉择', status: 'done', wordCount: 60,
  });
  store.scenes.create(chapter.id, 1, {
 content: '主角把退路文书按进火盆，带着十个人冲向营门。', status: 'done', targetWords: 60,
  });
  const validPayload = {
    quality_curve: [{
      chapter: 1, score: 72, action: 'keep', evidence: ['退路文书按进火盆'],
      effective_events: ['烧掉退路并出营'], irreversible_change: '失去撤退文书',
      character_cost: '失去安全退路', promise_delivery: '主角主动选择', filler_signals: [],
      ending_pull: '营门外如何应敌', reason: '行动、代价和后果同场成立', rebuild_objective: '',
    }],
    segment_verdict: { deterioration_found: false, turn_chapter: 1, reason: '本章有实质推进' },
  };
  let calls = 0;
  const prompts = [];
  const events = [];
  const run = await diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 1, onEvent: event => events.push(event),
    runTaskImpl: async ({ messages }) => {
      calls++;
      prompts.push(messages.at(-1)?.content || '');
      const payload = calls === 1
        ? { ...validPayload, quality_curve: [{ ...validPayload.quality_curve[0], evidence: ['原文从未出现的幻觉句'] }] }
        : validPayload;
      return { content: JSON.stringify(payload), finishReason: 'stop' };
    },
  });
  assert.equal(run.status, 'planned');
  assert.equal(calls, 2, '无效结构只允许一次有反馈的完整重答');
  assert.match(prompts[1], /上轮.*无法在原文定位/s);
  assert.ok(events.some(event => event.type === 'recovery_validation_retry'));
});

test('V0.99.1 诊断纠正严格限为一次，不能用无限重答绕过失败关闭', async () => {
  // V0.100.6 口径更新：诊断批次纠正上限 1→2 次（打地鼠实证：修一条又踩一条，一轮不够），
  // 上限仍然有界（1 初始 + 2 纠正），耗尽照样失败关闭，不是无限自愈。
  const book = store.books.create({ title: '诊断失败上限', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, {
    title: '抉择', status: 'done', wordCount: 60,
  });
  store.scenes.create(chapter.id, 1, {
 content: '主角把退路文书按进火盆，带着十个人冲向营门。', status: 'done', targetWords: 60,
  });
  let calls = 0;
  const alwaysInvalid = {
    quality_curve: [{
      chapter: 1, score: 72, action: 'keep', evidence: ['原文从未出现的幻觉句'],
      effective_events: ['烧掉退路并出营'], irreversible_change: '失去撤退文书',
      character_cost: '失去安全退路', promise_delivery: '主角主动选择', filler_signals: [],
      ending_pull: '营门外如何应敌', reason: '行动、代价和后果同场成立', rebuild_objective: '',
    }],
    segment_verdict: { deterioration_found: false, turn_chapter: 1, reason: '本章有实质推进' },
  };
  await assert.rejects(() => diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 1,
    runTaskImpl: async () => {
      calls++;
      return { content: JSON.stringify(alwaysInvalid), finishReason: 'stop' };
    },
  }), /无法在原文定位/);
  assert.equal(calls, 3, '诊断批次 = 1 次初始 + 2 次纠正，第三轮仍无效必须停止');
});

test('V0.99.1 分批诊断遇到上游故障时保存已验证检查点，正文未变即可续跑剩余批次', async () => {
  const book = store.books.create({ title: '诊断检查点', genre: '历史', platform: '番茄' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  for (let index = 1; index <= 6; index++) {
    const chapter = store.chapters.create(book.id, volume.id, index, {
      title: `第${index}章`, status: 'done', wordCount: 60,
    });
    store.scenes.create(chapter.id, 1, {
 content: `第${index}章主角烧掉第${index}张退路文书，冲出营门。`, status: 'done', targetWords: 60,
    });
  }
  const payloadFor = indexes => ({
    quality_curve: indexes.map(index => ({
      chapter: index, score: 70, action: 'keep', evidence: [`烧掉第${index}张退路文书`],
      effective_events: ['烧文书并出营'], irreversible_change: '失去退路', character_cost: '承担正面风险',
      promise_delivery: '主动选择', filler_signals: [], ending_pull: '营门外的敌情',
      reason: '行动与后果同场成立', rebuild_objective: '',
    })),
    segment_verdict: { deterioration_found: false, turn_chapter: indexes[0], reason: '本批仍有实质推进' },
  });
  let calls = 0;
  await assert.rejects(() => diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 6,
    runTaskImpl: async () => {
      calls++;
      if (calls === 2) {
        const error = new Error('上游连续 503');
        error.code = 'API_ERROR';
        throw error;
      }
      return { content: JSON.stringify(payloadFor([1, 2, 3, 4, 5])), finishReason: 'stop' };
    },
  }), /上游连续 503/);
  const failed = store.recommendationRecoveryRuns.list(book.id)[0];
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.quality_curve.map(item => item.chapter), [1, 2, 3, 4, 5]);

  const events = [];
  const resumed = await diagnoseRecommendationRecovery(book.id, {
    startChapter: 1, endChapter: 6, onEvent: event => events.push(event),
    runTaskImpl: async () => {
      calls++;
      return { content: JSON.stringify(payloadFor([6])), finishReason: 'stop' };
    },
  });
  assert.equal(resumed.id, failed.id, '相同正文与反馈应续跑原审计运行，不制造重复半成品');
  assert.equal(calls, 3, '续跑只请求尚未完成的第 6 章，不重复烧第 1—5 章');
  assert.deepEqual(resumed.quality_curve.map(item => item.chapter), [1, 2, 3, 4, 5, 6]);
  assert.ok(events.some(event => event.type === 'recovery_resumed' && event.nextChapter === 6));
});

test('V0.100.7 返工端点把任务所有权交给后台注册器，浏览器只负责观察', () => {
  const src = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(src, /import\s*\{[^}]*recoveryJobs[^}]*\}\s*from\s*['"]\.\/jobs\/recovery-jobs\.js['"]/s);
  for (const routeMarker of ['recommendation-recovery/diagnose', 'recommendation-recovery/:runId/execute']) {
    const at = src.indexOf(routeMarker);
    assert.ok(at > 0, `缺少路由 ${routeMarker}`);
    const nextRoute = src.indexOf("route('", at + 10);
    const block = src.slice(at, nextRoute > 0 ? nextRoute : undefined);
    assert.ok(!block.includes('abortOnDisconnect'), `${routeMarker} 不得随断连中止任务（断连只解除观察）`);
    assert.match(block, /recoveryJobs\.start\s*\(/, `${routeMarker} 必须由后台任务注册器持有 Promise 与 AbortController`);
    assert.match(block, /attachRecoveryJobStream\s*\(/, `${routeMarker} 应把 SSE 作为可拆卸观察者附着到后台任务`);
  }
  assert.match(src, /recommendation-recovery\/jobs\/:jobId\/observe/);
  assert.match(src, /recommendation-recovery\/jobs\/:jobId\/cancel/);
  assert.match(src, /recoveryJobs\.cancel\s*\(/);
  assert.match(src, /activeRecoveryJob\s*=\s*recoveryJobs\.findActiveByBook/);
  assert.match(src, /Promise\.race\(\[\s*(?:recoveryJobs|registry)\.wait\([^\]]+observerClosed,?\s*\]\)/s,
    '观察连接关闭后 HTTP handler 应立即释放，不能为每次刷新保留到数小时任务结束；后台 Promise 仍由注册器持有');
});
