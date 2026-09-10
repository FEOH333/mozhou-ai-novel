// V0.77 流协议可靠性：半截 EOF / 空闲超时必须失败，三协议正常终止不回归
import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NOVEL_MOCK_LLM = '0';

const { chatCompletion } = await import('../server/llm/client.js');
const { resetCircuits } = await import('../server/llm/resilience.js');

const originalFetch = globalThis.fetch;
let requestNo = 0;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetCircuits();
});

function responseFromChunks(chunks, { hang = false } = {}) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!hang) controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function streamCall(protocol, chunks, { hang = false } = {}) {
  globalThis.fetch = async () => responseFromChunks(chunks, { hang });
  requestNo += 1;
  return chatCompletion({
    model: 'stream-test-model',
    messages: [{ role: 'user', content: '写一段正文' }],
    stream: true,
    protocol,
    baseUrl: `http://stream-v077-${requestNo}.test`,
    apiKey: 'test-key',
    deepseekParams: false,
    resilience: {
      connectTimeoutMs: 200,
      idleTimeoutMs: 20,
      totalTimeoutMs: 500,
      maxRetries: 0,
      jitterMs: 0,
      circuitBreaker: { threshold: 100, openMs: 100 },
    },
  });
}

const incompleteCases = [
  {
    protocol: 'chat',
    partial: '半截-chat',
    chunks: ['data: {"choices":[{"delta":{"content":"半截-chat"},"finish_reason":null}]}\n\n'],
  },
  {
    protocol: 'responses',
    partial: '半截-responses',
    chunks: ['event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"半截-responses"}\n\n'],
  },
  {
    protocol: 'messages',
    partial: '半截-messages',
    chunks: ['event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"半截-messages"}}\n\n'],
  },
];

describe('V0.77 流协议完整性', () => {
  for (const { protocol, partial, chunks } of incompleteCases) {
    test(`${protocol}: 收到 delta 后直接 EOF 必须抛 STREAM_INCOMPLETE 并携带部分正文`, async () => {
      await assert.rejects(
        streamCall(protocol, chunks),
        error => {
          assert.equal(error.code, 'STREAM_INCOMPLETE');
          assert.equal(error.partialContent, partial);
          return true;
        },
      );
    });

    test(`${protocol}: 收到 delta 后空闲超时必须抛 STREAM_STALL 并携带部分正文`, async () => {
      await assert.rejects(
        streamCall(protocol, chunks, { hang: true }),
        error => {
          assert.equal(error.code, 'STREAM_STALL');
          assert.equal(error.partialContent, partial);
          return true;
        },
      );
    });
  }

  test('chat: finish_reason/[DONE] 正常完成', async () => {
    const result = await streamCall('chat', [
      'data: {"model":"m-chat","choices":[{"delta":{"content":"完整-chat"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ]);
    assert.equal(result.content, '完整-chat');
    assert.equal(result.finishReason, 'stop');
  });

  test('responses: response.completed 正常完成', async () => {
    const result = await streamCall('responses', [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"完整-responses"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"model":"m-responses","usage":{"input_tokens":2,"output_tokens":3}}}\n\n',
    ]);
    assert.equal(result.content, '完整-responses');
    assert.equal(result.finishReason, 'stop');
  });

  test('messages: message_stop 正常完成', async () => {
    const result = await streamCall('messages', [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"完整-messages"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    assert.equal(result.content, '完整-messages');
    assert.equal(result.finishReason, 'stop');
  });
});
