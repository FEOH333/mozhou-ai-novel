// V0.61 双开根治测试：服务器不再自动打开浏览器（唯一入口 start.bat）+ 单实例锁
import fs from 'node:fs';
import path from 'node:path';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = process.cwd();

describe('V0.61 双开根治', () => {
  test('index.js 不再自动打开浏览器（删除 spawn start 块）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    // 旧的自动打开逻辑必须消失：spawn('cmd', ['/c', 'start', ...)
    assert.ok(!/spawn\('cmd', \['\/c', 'start'/.test(src), '不应再有自动打开浏览器的 spawn start');
    assert.ok(!src.includes("NOVEL_NO_OPEN !== '1'"), '不应再有 NOVEL_NO_OPEN 自动打开判断');
    assert.ok(src.includes('不再自动打开'), '应有注释说明（防双开）');
  });

  test('start.bat 是纯 ASCII（中文注释会破坏 GBK 解析）', () => {
    const buf = fs.readFileSync(path.join(ROOT, 'start.bat'));
    for (let i = 0; i < buf.length; i++) {
      assert.ok(buf[i] < 0x80, `start.bat 第 ${i} 字节是非 ASCII（必须全英文注释）`);
    }
  });

  test('start.bat 含单实例锁（anw_start.lock，V0.95.4 括号块形态）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'start.bat'), 'utf8');
    assert.ok(src.includes('anw_start.lock'), '应有锁文件路径');
    assert.ok(src.includes('TotalSeconds -lt 30'), '锁有效期 30 秒');
    assert.ok(src.includes('Another launcher is starting'), '锁有效时应提示另一个启动器在跑并退出');
  });

  test('start.bat 仍由本脚本打开浏览器（V0.95.4 两处受控打开点：already 分支 + helper）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'start.bat'), 'utf8');
    const opens = (src.match(/start "" "http/g) || []).length;
    assert.equal(opens, 2, '浏览器打开应恰有两处（already-running 即开 + helper 健康后开），server 自身零打开');
    // 单窗口红线：node 必须前台运行（窗口即服务器，关窗即停），不得再 start /min 分离
    assert.ok(/^node server\\index\.js$/m.test(src), 'node 应在主窗口前台运行');
    assert.ok(!/start[^\n]*\/min[^\n]*node/.test(src), '不得再把 node 丢进最小化后台窗口（用户找不到/关不掉后端的根因）');
  });
});
