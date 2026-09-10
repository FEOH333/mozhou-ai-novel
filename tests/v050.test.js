// V0.50 稳定性测试：asyncWrap 同步异常不崩 + characters 接口字段 + busy_timeout + 启动防线
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v050-'));

describe('V0.50 稳定性防线', () => {
  test('index.js asyncWrap 用 Promise.resolve().then 包裹（同步异常也接住）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(src.includes('Promise.resolve().then(() => fn(req, res, params))'), 'asyncWrap 应包裹同步异常');
    assert.ok(!src.includes('Promise.resolve(fn(req, res, params))'), '旧写法应移除');
    assert.ok(src.includes("process.on('uncaughtException'"), '应有全局异常兜底');
    assert.ok(src.includes("process.on('unhandledRejection'"), '应有全局拒绝兜底');
  });

  test('index.js 有后端版 safeJsonParse（characters 接口不再引用前端函数）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(src.includes('function safeJsonParse'), '后端应有 safeJsonParse');
    // characters 接口返回弧光字段
    assert.ok(src.includes("personality: c.personality"), 'characters 接口应含 personality');
    assert.ok(src.includes("secret: c.secret"), 'characters 接口应含 secret');
    assert.ok(src.includes("arc: c.arc"), 'characters 接口应含 arc');
  });

  test('store.js db() 设置 busy_timeout（并发写库不崩）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/db/store.js'), 'utf8');
    assert.ok(src.includes('PRAGMA busy_timeout = 10000'), '应设置 busy_timeout');
  });

  test('server 不自动开浏览器（V0.95.4：无 NOVEL_NO_OPEN 依赖，start.bat 前台运行不设该变量）', () => {
    const bat = fs.readFileSync(path.join(ROOT, 'start.bat'), 'utf8');
    assert.ok(!bat.includes('NOVEL_NO_OPEN'), 'start.bat 不再设置 NOVEL_NO_OPEN（V0.61 起 server 无消费方）');
    const srv = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(!/start\s+http|shell:?open|opener/i.test(srv), 'server/index.js 不应残留自动开浏览器逻辑');
    assert.ok(srv.includes('浏览器请通过 start.bat 打开'), 'server 横幅应指引通过 start.bat 打开');
  });

  test('HTTP 冒烟：characters 接口 200 且含弧光字段（临时库起服务器太重，直接测 store+路由静态断言）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const b = store.books.create({ title: '冒烟书', genre: '玄幻', blurb: 'x' });
    const c = store.characters.create(b.id, { name: '张三', personality: '豪爽', goal: '当掌门', fear: '被背叛', secret: '前朝遗孤', arc: '鲁莽→沉稳', relation: '李四之师' });
    assert.equal(c.personality, '豪爽');
    const list = store.characters.list(b.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].secret, '前朝遗孤');
  });

  test('V0.50 按需注入：细纲 pace 字段 + advance 章不注入人物戏 + ecology 独立材料', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/prompts.js'), 'utf8');
    assert.ok(src.includes('"pace"'), '细纲应有 pace 字段');
    assert.ok(src.includes('画龙点睛'), '应强调按需不喧宾夺主');
    assert.ok(src.includes('ecologyText'), 'writeSceneInstruction 应接收 ecologyText');
    // q6 恢复建议制（不再强制）
    const outlineSrc = fs.readFileSync(path.join(ROOT, 'server/engine/outline.js'), 'utf8');
    assert.ok(!outlineSrc.includes('pass = all && q6'), 'q6 不应强制');
    // ecology 独立材料
    const settingsSrc = fs.readFileSync(path.join(ROOT, 'server/engine/settings.js'), 'utf8');
    assert.ok(settingsSrc.includes("'ecology'"), '社会生态应落独立 ecology 材料');
  });

  test('V0.50 角色库：tier/abilities 列 + roster 页 + tidy 路由 + tidy-all', () => {
    const storeSrc = fs.readFileSync(path.join(ROOT, 'server/db/store.js'), 'utf8');
    assert.ok(storeSrc.includes("'tier'") && storeSrc.includes("'abilities_json'") && storeSrc.includes("'exit_note'"), '应有三列迁移');
    const rosterSrc = fs.readFileSync(path.join(ROOT, 'web/js/views/roster.js'), 'utf8');
    assert.ok(rosterSrc.includes('roster-badge') && rosterSrc.includes('tier-protagonist'), '角色库页应有分级徽章');
    const idxSrc = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(idxSrc.includes('/characters/tidy') && idxSrc.includes('/tidy-all'), '应有 tidy 与 tidy-all 路由');
  });
});
