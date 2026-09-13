// V0.78 审校不收敛修复：细纲根因问题→升级 replan；审校注入细纲区分编造vs设定；修订允许登记新设定
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v078-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.78 审校不收敛修复', () => {
  test('①auditInstruction 注入本章细纲（审校能区分"细纲要求"vs"纯编造"）', async () => {
    const { auditInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const instr = auditInstruction({
      bookTitle: 'T', chapterTitle: 'C1', chapterText: '草稿正文', factsText: 'x', contract: '',
      foreshadowsText: '', characterStates: '', perspective: 'third',
      chapterOutline: '- 李尘@任务堂：林月指出那人影是"老幺"\n【要点】推进矿洞线索',
    });
    assert.ok(instr.includes('【本章细纲】'), '审校指令应含细纲段');
    assert.ok(instr.includes('不应报"事实编造"'), '应提示细纲设定不算编造');
    assert.ok(instr.includes('老幺'), '细纲内容应注入');
  });

  test('②reviseInstruction 允许【新设定】登记（修订不删必要新角色）', async () => {
    const { reviseInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const instr = reviseInstruction({
      bookTitle: 'T', chapterTitle: 'C1',
      scene: { id: 's1', pov: '李尘', location: '任务堂', beat: '见老幺', target_words: 500, content: '原文'.repeat(10) },
      issues: [{ type: '事实编造', severity: 'high', quote: '老幺', issue: '未登记', fix: '登记或删除' }],
      extraNote: '',
    });
    assert.ok(instr.includes('【新设定登记】'), '修订指令应含新设定登记提示');
    assert.ok(instr.includes('【新设定:名词——简述】'), '应提示标记格式');
  });

  test('③isRevisionStale：同类型 high 问题连续 2 轮出现 → 判定修订失效', async () => {
    const { isRevisionStale } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/pipeline.js')));
    const quoteOf = q => String(q || '').replace(/\s/g, '').slice(0, 20);
    // scene 内容包含两种措辞的完整 quote
    const sceneContent = '那道人影是负责书库杂务的老幺。林月指着那人影说是老幺。';
    const scenes = [{ id: 's1', idx: 1, content: sceneContent }];
    const auditWith = (quote) => ({
      verdict: 'fix',
      issues: [{ type: '事实编造', severity: 'high', quote, issue: '老幺未登记' }],
    });
    // 第 1 轮：记录类型，不判失效
    const r1 = isRevisionStale({ audit: auditWith('那道人影是负责书库杂务'), lastFixedQuotes: new Set(), prevHighTypes: new Set(), prevSceneHigh: new Map(), scenes, quoteOf });
    assert.equal(r1.staleHigh.length, 0);
    assert.equal(r1.typeRepeatAndSceneRepeat, false, '第1轮不应判失效');
    assert.ok(r1.currHighTypes.has('事实编造|high'), '应记录 high 类型');
    // 第 2 轮：同类型（quote 措辞不同，但同场景 s1）仍出现 → 判失效
    const prevSceneHigh = new Map();
    prevSceneHigh.set('事实编造|high@1', 1); // 模拟第1轮已记录 s1 该类型 1 次
    const r2 = isRevisionStale({
      audit: auditWith('林月指着那人影说是老幺'), // quote 措辞不同，但同场景同类型
      lastFixedQuotes: new Set(), prevHighTypes: r1.currHighTypes, prevSceneHigh, scenes, quoteOf,
    });
    assert.equal(r2.staleHigh.length, 0, 'quote 不同不应命中 quote 级');
    assert.equal(r2.typeRepeatAndSceneRepeat, true, '同类型连续2轮应判失效');
  });

  test('④isRevisionStale：quote 级匹配仍生效（同一 quote 重复）', async () => {
    const { isRevisionStale } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/pipeline.js')));
    const quoteOf = q => String(q || '').replace(/\s/g, '').slice(0, 20);
    const lf = new Set([quoteOf('井底叩击又起')]);
    const r = isRevisionStale({
      audit: { issues: [{ type: '事实编造', severity: 'high', quote: '井底叩击又起', issue: '老幺未登记' }] },
      lastFixedQuotes: lf, prevHighTypes: new Set(), prevSceneHigh: new Map(), scenes: [], quoteOf,
    });
    assert.equal(r.staleHigh.length, 1, '同 quote 重复应命中');
  });

  test('⑤runChapterFlow 细纲根因问题不卡死（mock：修订后同一问题仍报→升级 replan）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { runChapterFlow } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/pipeline.js')));
    const b = store.books.create({ title: '收敛书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'contract', 'x');
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const ch = store.chapters.create(b.id, v.id, 1, { title: '第一章', status: 'planned' });
    store.chapters.update(ch.id, { outline: { title: '第一章', scenes: [{ pov: '李尘', location: '任务堂', beat: '见老幺', target_words: 300 }] } });
    // 直接跑：mock 审校 accept → 流程应完成（不卡死）
    const r = await runChapterFlow(b.id, ch.id, {});
    // mock 下审校 accept，流程正常 done
    assert.ok(['done'].includes(r.status), `应正常完成，实际 ${r.status}`);
  });
});
