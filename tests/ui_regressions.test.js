// UI 关键路径回归：空书自动创作、SSE 生命周期、卷审阅映射、模态框与设置默认值
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('UI 核心路径回归', () => {
  test('空书在章节判空前挂载独立的自动创作控制卡', () => {
    const src = read('web/js/views/workshop.js');
    const renderStart = src.indexOf('export async function renderWorkshop');
    const emptyGuard = src.indexOf('if (!chapterId)', renderStart);
    assert.ok(renderStart >= 0 && emptyGuard > renderStart, '应能定位写作台与章节判空');
    assert.match(src, /function renderAutoCreationCard\s*\(/, '自动创作控制卡应提取为独立函数');
    assert.match(
      src.slice(renderStart, emptyGuard),
      /append\(renderAutoCreationCard\(/,
      '自动创作控制卡必须在无章节 return 之前挂载',
    );

    const chapterStart = src.indexOf('function renderChapter');
    const sceneStart = src.indexOf('// ---- 场景卡 ----', chapterStart);
    assert.doesNotMatch(src.slice(chapterStart, sceneStart), /id:\s*'pilot-btn'/, '章节视图不应重复创建 pilot 按钮');
  });

  test('SSE 控制器注册表可追踪、注销并一次取消全部任务', async () => {
    const modulePath = path.join(ROOT, 'web/js/sse-registry.js');
    assert.ok(fs.existsSync(modulePath), '应提供独立且可测试的 SSE 控制器注册表');
    const registryModule = await import(pathToFileURL(modulePath).href + `?t=${Date.now()}`);
    const { registerAbortController, unregisterAbortController, abortAllControllers } = registryModule;
    const registry = new Set();
    let firstAborts = 0;
    let secondAborts = 0;
    const first = { abort() { firstAborts++; } };
    const second = { abort() { secondAborts++; throw new Error('already closed'); } };

    assert.equal(registerAbortController(registry, first), first);
    registerAbortController(registry, second);
    assert.equal(registry.size, 2);
    assert.equal(unregisterAbortController(registry, first), true);
    assert.equal(registry.size, 1);
    registerAbortController(registry, first);

    assert.equal(abortAllControllers(registry), 2);
    assert.equal(firstAborts, 1);
    assert.equal(secondAborts, 1);
    assert.equal(registry.size, 0, '取消后必须清空，finally 重复注销应无害');
  });

  test('app 路由取消观察 SSE，workshop 每条流都注册和注销', () => {
    const app = read('web/js/app.js');
    const workshop = read('web/js/views/workshop.js');
    assert.match(app, /_activeSSE:\s*new Set\(\)/, '全局状态应持有控制器集合');
    assert.match(app, /abortAllControllers\(state\._activeSSE\)/, '路由切换应取消观察流');
    assert.match(app, /不取消服务端作业/, '路由切换不得被理解成取消自动创作作业');
    assert.doesNotMatch(workshop, /state\._activeSSE\s*=/, '视图不得再覆盖全局单控制器');
    assert.equal((workshop.match(/registerSSE\(\)/g) || []).length, 8,
      '章节细纲、场景、全章、pilot、polish、开篇候选、推荐诊断+返工执行（已合并为一条一键流）、叙事状态重建八条流均应注册');
    assert.equal((workshop.match(/unregisterSSE\(ctrl\)/g) || []).length >= 8, true, '每条流都应在 finally 注销自身');
    assert.equal((workshop.match(/ctrl\.signal/g) || []).length, 13,
      '每条 SSE 请求都应接收对应 signal（含 observeWriteJob 重连；一键流内互斥分支共用同一 ctrl；路由切换只断观察，不取消服务端作业）');
    assert.match(workshop, /observeRecoveryJob\([^;]+ctrl\.signal\)/s,
      '后台返工的重连观察流也必须受页面 AbortController 管理，避免离开页面后残留读流');
    assert.match(workshop, /observeWriteJob\([^;]+ctrl\.signal\)/s,
      '自动创作重连观察流也必须受页面 AbortController 管理');
  });

  test('卷审阅使用 volume UUID 而非卷序号匹配', () => {
    const src = read('web/js/views/outline.js');
    assert.match(src, /reviewByVol\.get\(v\.id\)/);
    assert.doesNotMatch(src, /reviewByVol\.get\(v\.idx\)/);
  });

  test('快感页导入 toast 并复用统一模态系统', () => {
    const src = read('web/js/views/pleasure.js');
    assert.match(src, /import\s*\{[^}]*toast[^}]*openModal[^}]*\}\s*from\s*'\.\.\/ui\.js'/s);
    assert.equal((src.match(/openModal\s*\(\s*\{/g) || []).length, 2, '两个新建表单均应使用 openModal');
    assert.doesNotMatch(src, /document\.addEventListener\('keydown'/, '不应遗留手写全局 Esc 监听器');
  });

  test('设置页 fallback 与当前配置默认值一致且协议提示保守准确', () => {
    const src = read('web/js/views/settings.js');
    for (const expected of [
      's.contextBudgetTokens ?? 500000',
      's.maxReviseRounds ?? 3',
      's.keepRecentChapters ?? 15',
      's.maxRecoveryRounds ?? 3',
      's.worldbookBudgetTokens ?? 4000',
      's.resilience?.totalTimeoutMs ?? 420000',
      's.resilience?.idleTimeoutMs ?? 60000',
    ]) assert.ok(src.includes(expected), `缺少当前默认值：${expected}`);

    assert.ok(src.includes("(s.protocol ?? 'chat')"), '协议缺省应与服务端 chat 一致');
    assert.match(src, /Chat Completions（默认推荐/);
    assert.doesNotMatch(src, /自动（推荐|三种格式实测均支持前缀缓存命中（约 97%/);
    assert.match(src, /默认 500K/);
  });

  test('重写安全闸拒绝正文时，自动创作与手动打磨都给出可见警告', () => {
    const src = read('web/js/views/workshop.js');
    assert.equal((src.match(/case 'chapter_rewrite_rejected'/g) || []).length, 2,
      'pilot 与 polish 两条事件流都应显示重写拒绝原因');
    assert.match(src, /data\.code/);
    assert.match(src, /matchedChapter/);
  });
});
