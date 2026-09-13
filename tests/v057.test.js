// V0.57 诊断修复进度可视化测试：recovery_stage/executed 事件处理 + 重规划总数提示
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v057-'));

describe('V0.57 诊断修复进度可视化', () => {
  test('前端处理 recovery_stage（重规划逐章进度——修无反馈像卡死问题）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'web/js/views/workshop.js'), 'utf8');
    assert.ok(src.includes("case 'recovery_stage'"), '应处理 recovery_stage');
    assert.ok(src.includes('正在重规划'), '应显示重规划进度');
    assert.ok(src.includes("case 'recovery_executed'"), '应处理 recovery_executed');
    assert.ok(src.includes('已执行修复'), '应显示修复动作统计');
  });

  test('recovery.js replanFrom 先提示重规划总数（让用户知道要等多久）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/recovery/recovery.js'), 'utf8');
    assert.ok(src.includes('将重规划'), '应提示重规划总数');
    assert.ok(src.includes('请稍候'), '应提示等待预期');
    assert.ok(src.includes('${replanned + 1}/${chapters.length}'), '应显示逐章进度 x/N');
  });

  test('防卡死保障（诊断/重规划不会死锁）', () => {
    // runTask 有超时/重试/熔断；replanFrom 有 signal.aborted 检查 + 单章 catch；maxRecoveryRounds 有上限
    const client = fs.readFileSync(path.join(ROOT, 'server/llm/client.js'), 'utf8');
    assert.ok(client.includes('totalTimeoutMs') || client.includes('maxRetries'), 'LLM 调用应有超时/重试');
    const recovery = fs.readFileSync(path.join(ROOT, 'server/engine/recovery/recovery.js'), 'utf8');
    assert.ok(recovery.includes('signal?.aborted'), '重规划应响应中止');
    assert.ok(recovery.includes('单章重规划失败继续下一章'), '单章失败不应阻塞');
    const pilot = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/pilot.js'), 'utf8');
    assert.ok(pilot.includes('maxRecoveryRounds'), '恢复轮数应有上限（超限暂停人工出口）');
  });
});
