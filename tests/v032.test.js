// V0.32：el() 节点误用防御 + 调用点修正（路由表/事实库/大纲表格单元格内容丢失的根因修复）
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.resolve('web');

describe('V0.32 el() 误用防御', () => {
  test('ui.js el() 包含节点降级防御（第二参数是 DOM 节点/数组时视为 children）', () => {
    const ui = fs.readFileSync(path.join(WEB, 'js/ui.js'), 'utf8');
    assert.ok(ui.includes("attrs.nodeType || Array.isArray(attrs)"), 'el() 应有 nodeType/Array 降级判断');
    assert.ok(ui.includes('children = [attrs, ...children]'), '应把节点参数并入 children');
  });

  test('路由表/事实库/大纲表格不再有 el(\'td\', 节点) 误用', () => {
    const files = ['views/settings.js', 'views/facts.js', 'views/outline.js'];
    for (const f of files) {
      const src = fs.readFileSync(path.join(WEB, 'js', f), 'utf8');
      const lines = src.split('\n');
      lines.forEach((ln, i) => {
        const m = ln.match(/el\('td',\s*((?:el\()|tempInput|maxInput|thinkSel)/);
        assert.ok(!m, `${f}:${i + 1} 仍存在 el('td', 节点) 误用: ${ln.trim()}`);
      });
    }
  });

  test('修复后的调用使用 {} 空属性占位', () => {
    const s = fs.readFileSync(path.join(WEB, 'js/views/settings.js'), 'utf8');
    assert.ok(s.includes("el('td', {}, tempInput)"), 'settings.js 应有 el(\'td\', {}, tempInput)');
    assert.ok(s.includes("el('td', {}, el('div', { class: 'model-cell' }"), 'model-cell 单元格应带 {} 占位');
  });

  test('全前端 JS 无其他 el(\'td\', 变量节点) 模式残留', () => {
    const views = fs.readdirSync(path.join(WEB, 'js/views'));
    let bad = 0;
    for (const f of views) {
      const src = fs.readFileSync(path.join(WEB, 'js/views', f), 'utf8');
      const lines = src.split('\n');
      lines.forEach((ln, i) => {
        // el('td', X) 且 X 后紧跟 , 或 ) 且 X 不是对象/字符串/数字
        const m = ln.match(/el\('td',\s*([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*[,)])/);
        if (m && !ln.includes("'td', {")) {
          // 排除合法字符串/文本变量——这里只报驼峰变量（节点引用惯例）
          if (/[A-Z]/.test(m[1]) && !/^(text|class|style|value|id|name|type|title)$/.test(m[1])) {
            console.log(`  ⚠ ${f}:${i + 1}: ${ln.trim().slice(0, 80)}`);
            bad++;
          }
        }
      });
    }
    assert.equal(bad, 0, `存在 ${bad} 处可疑 el('td', 变量) 调用`);
  });
});
