// V0.91 《示例历史长篇》结构化年代阶段与史实越界闸门
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v103-history-longform-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

const longform = await import(pathToFileURL(path.join(ROOT, 'server/engine/longform/historical_longform.js')));
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));

const SAMPLE_BOOK = {
 title: '示例历史长篇', genre: '历史', perspective: 'third',
  blurb: '淳祐元年，他九岁。十八年后，他站上钓鱼城头。四十年只做一件事。',
};

describe('V0.91 四十年年代阶段', () => {
  test('十五卷阶段从1241推进到1294（12卷四十年节点+13-15反攻延伸期），年龄由同一出生年推导，钓鱼城落在1259', () => {
 assert.equal(longform.isHistoricalSampleBook(SAMPLE_BOOK), true);
 const phases = longform.historicalLongformPhases(SAMPLE_BOOK);
    // V0.93.9：12卷为四十年节点（反攻号角），13-15卷反攻延伸期（1282-1294）
    assert.equal(phases.length, 15);
    assert.equal(phases[0].startYear, 1241);
    assert.equal(phases[11].endYear, 1281, '卷12四十年节点在1281');
    assert.equal(phases.at(-1).endYear, 1294, '卷15反攻延伸期收束于忽必烈崩逝窗口');
    assert.equal(phases[0].startAge, 9);
    assert.equal(phases[11].endAge, 49, '四十年节点主角49岁');
    assert.equal(phases.at(-1).endAge, 62, '卷15主角62岁');
    assert.ok(phases.some(phase => phase.startYear <= 1259 && phase.endYear >= 1259 && phase.anchor.includes('钓鱼城')));
    assert.equal(longform.protagonistAgeInYear(1241), 9);
    assert.equal(longform.protagonistAgeInYear(1259), 27);
    assert.equal(longform.protagonistAgeInYear(1281), 49);
  });

  test('阶段注入明确贴身限知视野扩大与整卷任务，不把十八年压成一句跳时', () => {
 const text = longform.historicalPhaseText(SAMPLE_BOOK, 1);
    assert.match(text, /1241/);
    assert.match(text, /九岁|9岁/);
    assert.match(text, /贴身限知/);
    assert.match(text, /不得把十八年/);
    assert.match(text, /完整场景/);
  });

  test('书纲即使模型只返回少量卷，也会确定性归一为十五卷年代骨架', () => {
    const outline = longform.normalizeHistoricalBookOutline({
 title: SAMPLE_BOOK.title,
      volumes: [{ idx: 1, title: '模型卷名', goal: '模型目标', summary: '模型摘要' }],
 }, SAMPLE_BOOK);
    assert.equal(outline.volumes.length, 15);
    assert.deepEqual(outline.volumes[0], {
      idx: 1, title: '故园成灰', goal: '模型目标', summary: '模型摘要',
      start_year: 1241, end_year: 1243, start_age: 9, end_age: 11,
 historical_anchor: longform.historicalLongformPhases(SAMPLE_BOOK)[0].anchor,
      lifecycle_stage: 'opening',
 stage_turn: longform.historicalLongformPhases(SAMPLE_BOOK)[0].stageTurn,
 required_closures: longform.historicalLongformPhases(SAMPLE_BOOK)[0].requiredClosures,
      new_major_arc_budget: 3,
    });
    assert.equal(outline.volumes.at(-1).start_year, 1291);
    assert.equal(outline.volumes.at(-1).end_year, 1294);
    assert.equal(outline.volumes.at(-1).end_age, 62);
  });
});

describe('V0.91 史实越界校验', () => {
  test('拒绝余玠死后召见、1259年前围城、年龄错误与十八年写成十年', () => {
    const phase = { startYear: 1254, endYear: 1259, startAge: 22, endAge: 27, anchor: '1259钓鱼城' };
    const bad = {
      chapters: [
        { idx: 1, year: 1254, protagonist_age: 19, beat: '十年后，余玠召见陆止戈，命他守钓鱼城。' },
        { idx: 2, year: 1258, protagonist_age: 26, beat: '蒙哥围钓鱼城，诸军轮攻七门。' },
      ],
    };
    const result = longform.validateHistoricalVolumeOutline(bad, phase);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.code === 'PROTAGONIST_AGE_MISMATCH'));
    assert.ok(result.issues.some(issue => issue.code === 'REAL_PERSON_AFTER_DEATH'));
    assert.ok(result.issues.some(issue => issue.code === 'EVENT_TOO_EARLY'));
    assert.ok(result.issues.some(issue => issue.code === 'TIMESKIP_MISMATCH'));
  });

  test('合法的1241童年到1259钓鱼城年序通过', () => {
    const phase = { startYear: 1254, endYear: 1259, startAge: 22, endAge: 27, anchor: '1259钓鱼城' };
    const good = {
      chapters: [
        { idx: 1, year: 1254, era_year: '宝祐二年', protagonist_age: 22, phase: '从军', reward_mode: '能力', emotion: '新奇4', beat: '王坚扩建钓鱼城，陆止戈以新卒身份参加运石。' },
        { idx: 2, year: 1258, era_year: '宝祐六年', protagonist_age: 26, phase: '备战', reward_mode: '信息', emotion: '紧张7', beat: '蒙哥率主力入蜀，陆止戈随军撤入山城体系。' },
        { idx: 3, year: 1259, era_year: '开庆元年', protagonist_age: 27, phase: '守城', reward_mode: '战术', emotion: '燃9', beat: '二月蒙哥围钓鱼城，守军应对第一轮试探。' },
      ],
    };
    assert.deepEqual(longform.validateHistoricalVolumeOutline(good, phase), { ok: true, issues: [] });
  });

  test('拒绝公元年与南宋年号错位，并拒绝同卷重复章名', () => {
 const phase = longform.historicalPhaseForVolume(SAMPLE_BOOK, 2);
    const bad = {
      chapters: [
        { idx: 1, title: '夜哨', year: 1245, era_year: '淳祐四年', protagonist_age: 13, beat: '北坡夜哨。' },
        { idx: 2, title: '夜哨', year: 1246, era_year: '淳祐六年', protagonist_age: 14, beat: '雨后巡坡。' },
      ],
    };
    const result = longform.validateHistoricalVolumeOutline(bad, phase);
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(issue => issue.code === 'ERA_YEAR_MISMATCH'));
    assert.ok(result.issues.some(issue => issue.code === 'DUPLICATE_CHAPTER_TITLE'));
    assert.equal(longform.expectedSouthernSongEraYear(1245), '淳祐五年');
  });

  test('钓鱼山正式筑城不得提前到1242年', () => {
 const phase = longform.historicalPhaseForVolume(SAMPLE_BOOK, 1);
    const bad = {
      chapters: [{
        idx: 6, title: '营中余火', year: 1242, era_year: '淳祐二年', protagonist_age: 10,
 phase: '筑城起步', beat: '余玠在钓鱼山开挖基槽、营造城墙，主角进入料石队。',
      }],
    };
    const result = longform.validateHistoricalVolumeOutline(bad, phase);
    assert.ok(result.issues.some(issue => issue.code === 'EVENT_TOO_EARLY'));

    const good = structuredClone(bad);
    good.chapters[0].year = 1243;
    good.chapters[0].era_year = '淳祐三年';
    good.chapters[0].protagonist_age = 11;
    assert.deepEqual(longform.validateHistoricalVolumeOutline(good, phase), { ok: true, issues: [] });
  });

  test('丁家洲之战不得提前到1274年', () => {
 const phase = longform.historicalPhaseForVolume(SAMPLE_BOOK, 9);
    const bad = {
      chapters: [{
        idx: 1, title: '江上危局', year: 1274, era_year: '咸淳十年', protagonist_age: 42,
        phase: '朝局震荡', beat: '贾似道率军在丁家洲迎战元军，宋军大败。',
      }],
    };
    const result = longform.validateHistoricalVolumeOutline(bad, phase);
    assert.ok(result.issues.some(issue => issue.code === 'EVENT_TOO_EARLY' && /丁家洲/.test(issue.message)));

    const good = structuredClone(bad);
    good.chapters[0].year = 1275;
    good.chapters[0].era_year = '德祐元年';
    good.chapters[0].protagonist_age = 43;
    assert.deepEqual(longform.validateHistoricalVolumeOutline(good, phase), { ok: true, issues: [] });
  });

  test('卷纲提示词携带年代字段、年龄公式与历史阶段', () => {
 const phaseText = longform.historicalPhaseText(SAMPLE_BOOK, 3);
    const prompt = prompts.volumeOutlineInstruction({
 bookTitle: SAMPLE_BOOK.title, volumeIdx: 3, volumeTitle: '砺刃山城', bookOutline: {},
      chapterCount: 8, historicalPhaseText: phaseText,
    });
    for (const field of ['"year"', '"era_year"', '"protagonist_age"', '"phase"', '"reward_mode"', '"emotion"']) {
      assert.ok(prompt.includes(field), `卷纲 schema 应含 ${field}`);
    }
    assert.match(prompt, /出生年固定为1232/);
  });
});
