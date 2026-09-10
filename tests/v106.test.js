// V0.91 四十年阶段贯穿书纲、开篇、细纲与正文
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v106-history-throughline-'));
const ROOT = process.cwd();
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
const history = await import(pathToFileURL(path.join(ROOT, 'server/engine/historical_longform.js')));
const book = { title: '示例历史长篇', genre: '历史', blurb: '1241年九岁，1259年钓鱼城，四十年山河。' };

describe('V0.91 历史长篇贯通', () => {
  test('书纲收到完整十五阶段：12卷为四十年节点（反攻号角），13-15卷反攻延伸期', () => {
    const plan = history.historicalLongformPlanText(book);
    assert.match(plan, /第1卷.*1241/);
    assert.match(plan, /第12卷.*1281/);
    assert.match(plan, /第15卷.*1294/);
    // V0.93.9：不再"必须严格生成12卷"——12卷吹响反攻号角不是完结
    const text = prompts.bookOutlineInstruction({ genre: '历史', blurb: book.blurb, volumes: 12, historicalLongformText: plan });
    assert.doesNotMatch(text, /严格生成12卷/);
    assert.match(text, /反攻号角/);
    assert.match(text, /禁止在12卷强行和解收尾/);
    assert.match(text, /第15卷/);
  });

  test('开篇蓝图锁在1241阶段，不得在前20章跳到1259围城', () => {
    const phase = history.historicalPhaseText(book, 1);
    const text = prompts.openingBlueprintInstruction({ bookTitle: book.title, genre: '历史', isHistory: true, chapterCount: 20, historicalPhaseText: phase });
    assert.match(text, /1241/);
    assert.match(text, /不得.*1259|1259.*不得/);
    assert.match(text, /不得把十八年/);
  });

  test('章细纲和正文提示均携带公元年、年号、年龄、阶段、回报和情绪', () => {
    const frame = '公元1241年｜淳祐元年｜主角9岁｜阶段：故园成灰｜回报：依恋｜情绪：温暖4';
    const outlineText = prompts.chapterOutlineInstruction({
      bookTitle: book.title, chapterIdx: 1, recentSummaries: [], activeForeshadows: [],
      forgottenForeshadows: [], approachingForeshadows: [], retrieved: [], futureChapters: [], historicalChapterFrame: frame,
    });
    assert.match(outlineText, /历史章节坐标/);
    assert.match(outlineText, /公元1241年/);
    const writeText = prompts.writeSceneInstruction({
      bookTitle: book.title, chapterIdx: 1, chapterTitle: '灯火', scene: { id: 's1', beat: '母亲教他认路', pov: '陆止戈', location: '家' },
      scenesBefore: [], historicalChapterFrame: frame, isHistory: true,
    });
    assert.match(writeText, /历史章节坐标/);
    assert.match(writeText, /回报：依恋/);
    assert.doesNotMatch(writeText, /反击时像神|给足碾压快感/);
  });

  test('历史章节元数据可合并进模型细纲，正文不会退回卷首年份', () => {
    const planned = { year: 1258, era_year: '宝祐六年', protagonist_age: 26, phase: '备战', reward_mode: '信息', emotion: '紧张7' };
    const merged = history.mergeHistoricalChapterFrame({ title: '新细纲', scenes: [{ beat: '侦察粮道' }] }, planned, { startYear: 1254, title: '风雨欲来', rewardModes: ['能力'], emotions: ['紧张'] });
    assert.equal(merged.year, 1258);
    assert.equal(merged.protagonist_age, 26);
    assert.equal(merged.reward_mode, '信息');
  });

  test('历史签约评审按依恋与阅读回报审，不要求每章当众爽', () => {
    const text = prompts.signingReviewInstruction({ bookTitle: book.title, genre: '历史', opening: '正文' });
    assert.match(text, /依恋建立/);
    assert.match(text, /阅读回报/);
    assert.doesNotMatch(text, /一章一小冲突、五章一小爽/);
  });
});
