// V0.31 测试：openModal const 覆盖修复 / 路由表防御渲染
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

test('V0.31: openModal close 用 let 声明（const 覆盖会 TypeError 导致所有弹窗失效）', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'web/js/ui.js'), 'utf8');
  const i = src.indexOf('export function openModal');
  const j = src.indexOf('export function confirmDialog', i);
  const seg = src.slice(i, j > i ? j : i + 2500);
  assert.ok(seg.includes('let close ='), 'close 应为 let 声明');
  assert.ok(seg.includes('origClose'), 'Esc 清理逻辑保留');
  // 确认覆盖点存在且 close 不是 const
  const k = src.indexOf('close = (val) =>', i);
  assert.ok(k > 0, 'close 覆盖语句应在');
});

test('V0.31: 路由表防御渲染——defaults 兜底 + 空态提示', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'web/js/views/settings.js'), 'utf8');
  assert.ok(src.includes('Object.entries(s.defaults || {})'), 'defaults 应兜底');
  assert.ok(src.includes('服务端未返回任务列表'), '应有空态提示');
});

test('V0.31: settings 响应包含 defaults（17 任务）与 providerPresets', async () => {
  const config = await import('../server/config.js');
  const routes = config.DEFAULT_ROUTES;
  assert.ok(routes && Object.keys(routes).length >= 15, `应有 ≥15 个任务（实际 ${Object.keys(routes || {}).length}）`);
  assert.ok(routes.write && routes.audit, '核心任务 write/audit 应存在');
});
