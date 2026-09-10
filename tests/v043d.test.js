// V0.43 第三阶段：可视化大升级——pilot 面板静态断言
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

describe('V0.43 自动创作可视化', () => {
  test('pilot 面板含章节网格/当前章/停止按钮', () => {
    const w = fs.readFileSync(path.join(ROOT, 'web/js/views/workshop.js'), 'utf8');
    assert.ok(w.includes('ch-grid'), '章节进度网格');
    assert.ok(w.includes('ch-cell active'), '当前章高亮');
    assert.ok(w.includes('pilot-cur'), '当前章指示');
    assert.ok(w.includes('pilot-stop'), '停止按钮');
    assert.ok(w.includes('AbortError'), '停止走 abort 断点续跑');
  });

  test('实时成本条累计 usage 帧（V0.96 起收进 runStatsBar 工厂，自动创作与单章共用）', () => {
    const w = fs.readFileSync(path.join(ROOT, 'web/js/views/workshop.js'), 'utf8');
    assert.ok(w.includes('cost-mini'), '成本条');
    assert.ok(w.includes('function runStatsBar()'), '统计条工厂（累计 tokens 的单一实现）');
    assert.ok(w.includes('promptCacheHitTokens'), '累计命中');
    assert.ok(w.includes('fmtPct'), '命中率显示');
  });

  test('已完成章节卡片与事件流', () => {
    const w = fs.readFileSync(path.join(ROOT, 'web/js/views/workshop.js'), 'utf8');
    assert.ok(w.includes('ch-done-cards'), '完成卡片容器');
    assert.ok(w.includes('ch-done-item'), '完成卡片');
    assert.ok(w.includes('ev-feed'), '事件流');
    assert.ok(w.includes('volume_review_done'), '卷体检事件入流');
    assert.ok(w.includes('feed('), 'feed 函数');
  });

  test('CSS 网格/卡片样式就绪', () => {
    const c = fs.readFileSync(path.join(ROOT, 'web/css/app.css'), 'utf8');
    assert.ok(c.includes('.ch-grid'), '网格样式');
    assert.ok(c.includes('.ch-cell.active'), '高亮动画');
    assert.ok(c.includes('.ev-feed'), '事件流样式');
    assert.ok(c.includes('.cost-mini'), '成本条样式');
  });
});
