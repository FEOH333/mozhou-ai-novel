// V0.70 五轮大检查修复测试：熔断复位/前端事件/竞态/prune 类型/悬空引用/计价/滚动截断/abort
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v070-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));

describe('V0.70 五轮大检查修复', () => {
  test('①熔断复位：成功路径调用 reportSuccess（client.js 证据）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/llm/client.js'), 'utf8');
    const successIdx = src.indexOf('recordHealth({ ok: true');
    const seg = src.slice(successIdx, successIdx + 300);
    assert.ok(seg.includes('reportSuccess'), '成功路径应复位熔断器');
    assert.ok(src.includes("e.name === 'AbortError'"), 'abort 应保留 ABORTED 语义');
    assert.ok(src.includes("err.code = 'ABORTED'"), 'abort 显式 code');
  });

  test('②前端 pilot 事件补全 + 成本页竞态防护', () => {
    const ws = fs.readFileSync(path.join(ROOT, 'web/js/views/workshop.js'), 'utf8');
    for (const ev of ["case 'backfill':", "case 'backfill_done':", "case 'continuation':", "case 'book_done':",
      "case 'align_chapter':", "case 'align_volume':", "case 'align_book':", "case 'auto_tidy':",
      "case 'volume_review_start':", "case 'volume_review_recheck':"]) {
      assert.ok(ws.includes(ev), `runPilot 应处理 ${ev}`);
    }
    const cs = fs.readFileSync(path.join(ROOT, 'web/js/views/costs.js'), 'utf8');
    assert.ok(cs.includes('generation'), '成本页应有 generation 竞态防护');
    assert.ok(cs.includes("state.route?.name !== 'costs'"), '切页后放弃渲染');
  });

  test('③pruneBefore 类型修复（JOIN chapters 按 idx）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/db/store.js'), 'utf8');
    assert.ok(src.includes('JOIN chapters'), 'pruneBefore 应 JOIN chapters');
    assert.ok(!src.includes("chapter_id IS NOT NULL AND chapter_id < ?"), '不再直接比较 TEXT/INTEGER');
  });

  test('④replace 返回 changes + 失败回退置空当前场景 seq（防悬空）', () => {
    const w = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/write.js'), 'utf8');
    assert.ok(w.includes('store.history.replace(bookId, scene.history_seq') , 'replace 校验');
    assert.ok(w.includes('historySeq: null }'), '失败回退置空当前场景');
    assert.ok(w.includes('done/settled 章补写场景时不降级'), 'done 章不降级 drafted');
    const a = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/audit.js'), 'utf8');
    assert.ok(a.includes('applyValidatedSceneRewrite(bookId, liveScene.id, content')
      || a.includes('applyValidatedSceneRewrite(bookId, sceneId, content'), 'audit 修订必须走共享原子安全门');
    const st = fs.readFileSync(path.join(ROOT, 'server/db/store.js'), 'utf8');
    assert.ok(st.includes('return r.changes || 0;'), 'replace 返回影响行数');
  });

  test('⑤archive 缝隙误删修复（全量章节查找 next）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/archive.js'), 'utf8');
    assert.ok(src.includes('allChapters'), '应从全量章节找下一章');
    assert.ok(!src.includes('删除 firstSeq 之后全部'), '不再删到 lastSeq');
  });

  test('⑥计价用 route.model + 滚动摘要截断 + timeline 限量', () => {
    const r = fs.readFileSync(path.join(ROOT, 'server/llm/router.js'), 'utf8');
    assert.ok(r.includes('computeCost(route.model'), '计价用配置侧模型名');
    const s = fs.readFileSync(path.join(ROOT, 'server/engine/narrative/rolling.js'), 'utf8');
    assert.ok(s.includes('RECENT_KEEP') && s.includes('slice(-RECENT_KEEP)'), '滚动摘要截断（V0.95 两段式，settle 侧截断迁入 rolling.js）');
    const w = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/write.js'), 'utf8');
    assert.ok(w.includes('slice(-8)'), 'timeline 注入应采用有界窗口');
    assert.ok(!w.includes('slice(-20)'), '不得恢复旧的 20 条膨胀窗口');
  });

  test('⑦动态 import 静态化 + continuationCount 死代码删除', () => {
    const p = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/pilot.js'), 'utf8');
    assert.ok(!p.includes("await import('./roster.js')") && !p.includes("await import('./factbook.js')"), '动态 import 静态化');
    assert.ok(p.includes("from '../narrative/roster.js'"), '静态 import roster'); // V0.83：runCastDesign 随行静态导入
    const c = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/continuation.js'), 'utf8');
    assert.ok(!c.includes('continuationCount'), '死代码删除');
  });
});
