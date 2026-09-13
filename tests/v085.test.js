// V0.80 章间钩子链 + 剧情发展去AI味
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v085-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.80 章间钩子链 + 剧情去AI味', () => {
  test('①细纲 ending_hook 登记到期待账本且 due=chN+1', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { registerHooksFromOutline } = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/pleasure.js')));
    const b = store.books.create({ title: '钩子书', genre: '玄幻', blurb: 'x' });
    const outline = { ending_hook: { desc: '门外传来沉重的脚步声', type: '危机钩', intensity: 4 } };
    const registered = registerHooksFromOutline(b.id, outline, 3);
    assert.ok(registered.length >= 1, 'ending_hook 应登记');
    const hooks = store.pleasureHooks.list(b.id);
    assert.ok(hooks.some(h => h.desc.includes('脚步声')), '钩子应进账本');
    assert.ok(hooks.some(h => h.planted_chapter === 3), '应在第3章埋设');
  });

  test('②章细纲 schema 支持 ending_hook（mock 返回含钩子）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { generateChapterOutline } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));
    const b = store.books.create({ title: '钩子书2', genre: '玄幻', blurb: 'x', platform: '番茄' });
    store.materials.set(b.id, 'contract', 'x');
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const ch = store.chapters.create(b.id, v.id, 1, { title: '第一章', status: 'planned' });
    const o = await generateChapterOutline(b.id, ch.id, {});
    assert.ok(o.ending_hook, '细纲应含 ending_hook');
    assert.ok(o.ending_hook.desc, '应含钩子描述');
  });

  test('③detectPlotAiMarkers：巧合词过密 / 解决太干净 / 情绪标签', async () => {
    const { detectPlotAiMarkers } = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/plot_ai.js')));
    // 巧合词 3 次
    const ai1 = detectPlotAiMarkers('恰好此时他赶到，正好撞见，偏偏那人也在场。');
    assert.ok(ai1.some(i => i.type === '剧情AI味'), '巧合词过密应命中');
    // 解决太干净
    const ai2 = detectPlotAiMarkers('他彻底解决了所有麻烦，一劳永逸，再无后患。');
    assert.ok(ai2.some(i => i.type === '剧情AI味'), '解决太干净应命中');
    // 正常文本不命中
    const clean = detectPlotAiMarkers('他蹲下身，指节发麻，把那半块饼塞进怀里。');
    assert.equal(clean.length, 0, '正常文本不应命中');
  });

  test('④PLOT_DEAI_TEXT 注入写场景指令', async () => {
    const { PLOT_DEAI_TEXT } = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/plot_ai.js')));
    assert.ok(PLOT_DEAI_TEXT.includes('因果别太顺'), '应含反模式1');
    assert.ok(PLOT_DEAI_TEXT.includes('配角别都懂事'), '应含反模式3');
    assert.ok(PLOT_DEAI_TEXT.includes('巧合要限流'), '应含反模式5');
  });

  test('⑤detectEmotionPattern：3连情绪重复2次 → 模式化', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { detectEmotionPattern } = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/plot_ai.js')));
    const b = store.books.create({ title: '情绪书', genre: '玄幻', blurb: 'x' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    // 构造 9 章：情绪序列 紧张→爆发→余韵 重复 3 次
    const seq = ['紧张', '爆发', '余韵', '紧张', '爆发', '余韵', '紧张', '爆发', '余韵'];
    for (let i = 0; i < seq.length; i++) {
      const ch = store.chapters.create(b.id, v.id, i + 1, { title: `第${i + 1}章`, status: 'done' });
      store.chapterHealth.add({ bookId: b.id, chapterId: ch.id, idx: i + 1, notes: JSON.stringify({ emotion: { type: seq[i], intensity: 6 } }) });
    }
    const r = detectEmotionPattern(b.id);
    assert.equal(r.patterned, true, '情绪序列重复应判模式化');
  });
});
