// V0.93.10 历史人物档案自动化：①era_context 自动产出结构化人物档案并落库；
// ②登场窗逐卷注入（历史帧）；③人物级时间校验（登场年前出现/卒年后行动 → 时代错误）
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v133-figures-'));
const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const history = await import(pathToFileURL(path.join(ROOT, 'server/engine/history.js')));
const guardrails = await import(pathToFileURL(path.join(ROOT, 'server/engine/historical_guardrails.js')));
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
const hl = await import(pathToFileURL(path.join(ROOT, 'server/engine/historical_longform.js')));

describe('V0.93.10 历史人物档案自动化', () => {
  test('era_context 指令要求结构化人物档案（登场窗/官职/立场/卒年）', () => {
    const inst = prompts.eraContextInstruction({ bookTitle: 'X', genre: '历史', era: '南宋末年', seed: '考据种子' });
    assert.ok(inst.includes('figures'), '指令应要求 figures 数组');
    assert.ok(inst.includes('firstYear'), '应要求首次登场年');
    assert.ok(inst.includes('deathYear'), '应要求卒年');
    assert.ok(inst.includes('登场窗'), '应说明用途（登场窗注入）');
  });

  test('seedHistoricalFigures 落库 + historicalFiguresFor 窗口过滤（DB 优先）', () => {
    const book = store.books.create({ title: '人物档案测试', genre: '历史' });
    history.seedHistoricalFigures(book.id, {
      figures: [
        { name: '甲将军', aliases: ['甲公'], firstYear: 1268, deathYear: 1273, office: '襄阳守将', stance: '守城', constraint: '卷8核心', alterable: '高' },
        { name: '乙宰相', aliases: [], firstYear: 1259, deathYear: null, office: '宰相', stance: '专权', alterable: '中' },
        { name: '丙元老', aliases: [], firstYear: 1241, deathYear: 1250, office: '老将', stance: '守土', alterable: '低' },
      ],
    });
    const rows = store.historicalFigures.list(book.id);
    assert.equal(rows.length, 3, '落库 3 条');
    assert.deepEqual(rows.find(r => r.name === '甲将军').aliases, ['甲公'], 'aliases 解析');
    // 窗口过滤：1268-1273 在世的
    const w = history.historicalFiguresFor(book.id, { startYear: 1268, endYear: 1273 });
    assert.deepEqual(w.map(f => f.name).sort(), ['乙宰相', '甲将军'], '窗口内=在世且已登场（丙元老卒于1250排除）');
    // DB 优先：清空后回退内置种子
    store.historicalFigures.clear(book.id);
    const seed = history.historicalFiguresFor(book.id, { startYear: 1259, endYear: 1260, limit: 5 });
    assert.ok(seed.length > 0 && seed.some(f => f.name === '贾似道'), '无 DB 时用内置宋末种子兜底');
  });

  test('人物级时间校验：登场年前出现（high）与卒年后行动（medium）', () => {
    const figures = [
      { name: '文天祥', aliases: [], firstYear: 1275, deathYear: 1283, office: '右相' },
      { name: '贾似道', aliases: [], firstYear: 1259, deathYear: 1275, office: '宰相' },
    ];
    // 登场年前：1241 年文天祥出现 → 时代错误 high
 const early = guardrails.historicalFigureTimelineIssues({ genre: '历史', bookTitle: '本作', year: 1241, chapterText: '文天祥站在城头，看着远方的烟。', figures });
    assert.equal(early.length, 1);
    assert.equal(early[0].type, '时代错误');
    assert.equal(early[0].severity, 'high');
    assert.ok(early[0].issue.includes('尚未登场'), '应指出未登场');
    // 卒年后行动：1277 年贾似道率军 → medium；纯提及不拦
 const dead = guardrails.historicalFigureTimelineIssues({ genre: '历史', bookTitle: '本作', year: 1277, chapterText: '众将想起贾似道当年的作为，摇头不语。', figures });
    assert.equal(dead.length, 0, '卒年后纯提及/追忆不拦');
 const dead2 = guardrails.historicalFigureTimelineIssues({ genre: '历史', bookTitle: '本作', year: 1277, chapterText: '贾似道率军出城，要再战一场。', figures });
    assert.equal(dead2.length, 1);
    assert.equal(dead2[0].severity, 'medium');
    assert.ok(dead2[0].issue.includes('已卒'), '应指出已卒');
    // 登场窗内正常 → 无问题
 const ok = guardrails.historicalFigureTimelineIssues({ genre: '历史', bookTitle: '本作', year: 1260, chapterText: '贾似道在临安理事。', figures });
    assert.equal(ok.length, 0);
    // 非历史题材零影响
    assert.equal(guardrails.historicalFigureTimelineIssues({ genre: '都市', year: 1241, chapterText: '文天祥登场', figures }).length, 0);
  });

  test('历史帧注入本卷人物登场窗', () => {
 const book = store.books.create({ title: '示例历史长篇', genre: '历史', blurb: '1241年九岁，钓鱼城，四十年' });
    history.seedHistoricalFigures(book.id, {
      figures: [
        { name: '吕文德', aliases: [], firstYear: 1259, deathYear: 1269, office: '襄阳主帅', stance: '守城', alterable: '低' },
        { name: '刘整', aliases: [], firstYear: 1259, deathYear: 1275, office: '泸州知州→降元', stance: '降元', alterable: '高' },
      ],
    });
    const text = hl.historicalPhaseText(book, 8); // 卷8 襄樊（1270-1273）
    assert.ok(text.includes('本卷历史人物登场窗'), '历史帧应含人物窗');
    assert.ok(text.includes('刘整'), '窗口内人物应注入');
    assert.ok(!text.includes('吕文德'), '吕文德卒于1269，卷8（1270-1273）不应注入（史实正确）');
    const text7 = hl.historicalPhaseText(book, 7); // 卷7（1265-1269）
    assert.ok(text7.includes('吕文德'), '卷7 窗口含吕文德（1269 卒于窗口内）');
  });
});
