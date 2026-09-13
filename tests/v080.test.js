// V0.78 细纲新角色登记 + replan 冲突原因注入：防"细纲引入未登记角色→无限循环"
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v080-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.78 细纲新角色登记 + replan 注入', () => {
  test('①chapterOutlineInstruction 含【新角色登记硬约束】', async () => {
    const { chapterOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const instr = chapterOutlineInstruction({ bookTitle: 'T', chapterIdx: 1 });
    assert.ok(instr.includes('【新角色登记硬约束】'), '应含新角色登记硬约束');
    assert.ok(instr.includes('【新设定:人物名——身份简述】'), '应提示标记格式');
    assert.ok(instr.includes('禁止用"灰衣人/某人/那道身影"这类无名指代'), '应禁止无名指代替代细纲指定角色');
  });

  test('②generateChapterOutline 支持 replanReason 注入', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { generateChapterOutline } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));
    const b = store.books.create({ title: '重规划书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', 'x');
    store.materials.set(b.id, 'outline', JSON.stringify({ title: '重规划书', volumes: [{ idx: 1 }] }));
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const ch = store.chapters.create(b.id, v.id, 1, { title: '第一章', status: 'planned' });
    // 传 replanReason，应正常生成（mock 返回细纲），不报错
    const outline = await generateChapterOutline(b.id, ch.id, {
      onEvent: (ev) => {
        if (ev.type === 'setup') console.log('  setup:', ev.message?.slice(0, 60));
      },
      replanReason: '- [事实编造] 未登记角色"老幺"\n- [事实矛盾] 骨片出处不一致',
    });
    assert.ok(outline, '应生成细纲');
    assert.ok(Array.isArray(outline.scenes) && outline.scenes.length > 0, '应有场景');
  });

  test('③pipeline replan 分支传 replanReason（不抛错）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { runChapterFlow } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/pipeline.js')));
    const b = store.books.create({ title: '流程书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', 'x');
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const ch = store.chapters.create(b.id, v.id, 1, { title: '第一章', status: 'planned' });
    store.chapters.update(ch.id, { outline: { title: '第一章', scenes: [{ pov: '李尘', location: '镇', beat: '事件', target_words: 300 }] } });
    // mock 下审校 accept → 正常完成，replan 分支不触发（验证不破坏正常流程）
    const r = await runChapterFlow(b.id, ch.id, {});
    assert.ok(['done'].includes(r.status), `应正常完成，实际 ${r.status}`);
  });
});
