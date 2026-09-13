// V0.105.3 锁定：目标章数输入语义 = 再写 N 章（相对增量）
// 真实场景实测（浏览器操作）：48 章存量书填 3 → 旧语义"全书写到第 3 章"100ms 空跑结束，
// 用户直觉是"再写 3 章"。前端边界翻译成绝对目标（已完成 + N），pilot 后端语义不动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import './helper.js';

const ROOT = process.cwd();
const load = async f => import(pathToFileURL(path.join(ROOT, f)));

test('V0.105.3 resolvePilotTarget：再写 N 章 → 绝对目标（已完成 + N）', async () => {
  const { resolvePilotTarget } = await load('web/js/pilot-observe.js');
  const chapters = Array.from({ length: 52 }, (_, i) => ({
    idx: i + 1,
    status: i < 48 ? 'done' : 'planned', // 48 章完成存量书
  }));
  assert.equal(resolvePilotTarget('3', chapters), 51, '48 完成 + 3 = 写到第 51 章');
  assert.equal(resolvePilotTarget('1', []), 1, '新书 0 完成 + 1 = 第 1 章（行为不变）');
  assert.equal(resolvePilotTarget('5', [{ status: 'revised' }, { status: 'planned' }]), 6, 'revised 计入已完成');
  assert.equal(resolvePilotTarget('', chapters), undefined, '留空 = 自动续写（undefined）');
  assert.equal(resolvePilotTarget('abc', chapters), undefined, '非数字忽略');
  assert.equal(resolvePilotTarget('0', chapters), undefined, '0 忽略');
  assert.equal(resolvePilotTarget('-2', chapters), undefined, '负数忽略');
});

test('V0.105.3 runPilot 使用边界翻译且 UI 文案改为「再写几章」', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web/js/views/workshop.js'), 'utf8');
  assert.ok(src.includes('const targetChapters = resolvePilotTarget(targetInput?.value'), 'runPilot 应走边界翻译');
  assert.ok(src.includes("placeholder: '再写几章'"), '输入框占位文案应为「再写几章」');
  assert.ok(src.includes('再写 N 章'), 'title 应说明相对语义');
  // 后端绝对语义不动（pilot 的 cap/完成判断保持既有行为）
  const pilot = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/pilot.js'), 'utf8');
  assert.ok(pilot.includes('targetChapters 表示本轮只推进到指定全书章号'), 'pilot 绝对语义注释应在');
});
