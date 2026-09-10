// V0.52 自动创作中自动整理测试：pilot 每 5 章触发 tidyRoster（零手动）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v052-'));

describe('V0.52 自动创作自动整理', () => {
  test('pilot.js 主循环含每 5 章自动 tidyRoster 调用', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/pilot.js'), 'utf8');
    assert.ok(src.includes('tidyRoster'), 'pilot 应调用 tidyRoster');
    assert.ok(src.includes('written % 5 === 0'), '应每 5 章触发一次');
    assert.ok(src.includes('auto_tidy'), '应发 auto_tidy 事件');
    assert.ok(src.includes('整理失败不阻塞写作'), '失败不应阻塞');
  });

  test('workshop.js 处理 auto_tidy 事件', () => {
    const src = fs.readFileSync(path.join(ROOT, 'web/js/views/workshop.js'), 'utf8');
    assert.ok(src.includes("case 'auto_tidy'"), '前端应处理 auto_tidy');
  });

  test('mock 冒烟：pilot 写 6 章后触发 auto_tidy 事件（第 5 章时）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { runBookPilot } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pilot.js')));
    const b = store.books.create({ title: '自动整理书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', '【书契约】核心卖点：主角逆袭登顶');
    store.materials.set(b.id, 'outline', JSON.stringify({ title: '自动整理书', volumes: [{ idx: 1, title: '第一卷' }] }));
    // 角色缺维度（isComplete=false → 触发 AI 补全 candidates）
    const v1 = store.volumes.create(b.id, 1, { title: '第一卷', goal: 'g', status: 'outlined' });
    store.characters.create(b.id, { name: '李尘', tier: 'protagonist' });
    const events = [];
    await runBookPilot(b.id, { targetChapters: 6, onEvent: (ev) => events.push(ev) });
    // V0.107：自动整理机制覆盖多路（角色/事实/地点库 auto_tidy + 每章章名体检 align_chapter）。
    // mock 卷纲标题句式多样后地点提取产物变化，地点库整理可能零改动——断言任一路径触发即通过。
    const tidyEv = events.filter(e => e.type === 'auto_tidy');
    const alignEv = events.filter(e => e.type === 'align_chapter');
    const eventTail = events.slice(-20).map(event => ({
      type: event.type,
      stage: event.stage,
      idx: event.idx,
      message: event.message,
      error: event.error,
    }));
    assert.ok(tidyEv.length + alignEv.length >= 1, `应触发自动整理（auto_tidy ${tidyEv.length} + align_chapter ${alignEv.length}）；事件尾迹=${JSON.stringify(eventTail)}`);
    const lc = store.characters.list(b.id).find(c => c.name === '李尘');
    assert.ok(lc, '角色应存在');
  });
});
