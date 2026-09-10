// V0.91.3：历史连续性硬防线（遗体跨时段 / 真实人物任职窗 / 阶段任务落实）
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_FAULT = '';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v110-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const guardrails = await import(pathToFileURL(path.join(ROOT, 'server/engine/historical_guardrails.js')))
  .catch(() => ({}));
const audit = await import(pathToFileURL(path.join(ROOT, 'server/engine/audit.js')));
const characters = await import(pathToFileURL(path.join(ROOT, 'server/engine/characters.js')));
const factbook = await import(pathToFileURL(path.join(ROOT, 'server/engine/factbook.js')));
const pleasure = await import(pathToFileURL(path.join(ROOT, 'server/engine/pleasure.js')));

function historyFixture() {
 const book = store.books.create({ title: '示例历史长篇', genre: '历史' });
  const volume = store.volumes.create(book.id, 1, { title: '故园成灰' });
  return { book, volume };
}

describe('V0.91.3 历史连续性硬防线', () => {
  test('明确跨季或跨年后仍携带完整遗体时报告 high', () => {
    assert.equal(typeof guardrails.historicalContinuityIssues, 'function');
    const issues = guardrails.historicalContinuityIssues({
 bookTitle: '示例历史长篇',
      year: 1242,
      previousYear: 1241,
 chapterText: '春天来了。草席走了几个月，主角掀开一角，替弟弟拨开额前碎发，又摸了摸弟弟的手。',
    });
    assert.ok(issues.some(issue => issue.type === '时间线冲突' && issue.severity === 'high'));
  });

  test('及时火化、安葬或只携骨殖时不误报遗体跨时段', () => {
    assert.equal(typeof guardrails.historicalContinuityIssues, 'function');
    for (const chapterText of [
      '第三日，他在废窑火化弟弟，将骨灰收进陶罐。',
      '次年春天，他背着装有弟弟骨殖的陶罐来到营地，余玠替他择地安葬。',
      '他在新坟前放下糖兔子，起身回营。',
    ]) {
      const issues = guardrails.historicalContinuityIssues({
 bookTitle: '示例历史长篇', year: 1242, previousYear: 1241, chapterText,
      });
      assert.equal(issues.some(issue => /遗体|尸身/.test(issue.issue || '')), false);
    }
  });

  test('王坚不得在1254年前以合州知州或钓鱼城主将身份主持防务', () => {
    assert.equal(typeof guardrails.historicalContinuityIssues, 'function');
    const issues = guardrails.historicalContinuityIssues({
 bookTitle: '示例历史长篇', year: 1244,
      chapterText: '钓鱼城主将王坚坐在案后，下令五县民丁增筑城墙。',
    });
    const issue = issues.find(item => item.type === '史实错误');
    assert.equal(issue?.severity, 'high');
    assert.equal(issue?.earliestYear, 1254);
  });

  test('1254年前普通提及王坚不武断误报，1254年主持防务合法', () => {
    assert.equal(typeof guardrails.historicalContinuityIssues, 'function');
    assert.deepEqual(guardrails.historicalContinuityIssues({
 bookTitle: '示例历史长篇', year: 1244,
      chapterText: '军报上偶然提到王坚之名，余玠将纸压在案角。',
    }), []);
    assert.deepEqual(guardrails.historicalContinuityIssues({
 bookTitle: '示例历史长篇', year: 1254,
      chapterText: '知合州王坚主持钓鱼城防务，下令增筑城墙。',
    }), []);
  });

  test('正文不得把钓鱼山正式筑城提前到1242年', () => {
    const issues = guardrails.historicalContinuityIssues({
 bookTitle: '示例历史长篇', year: 1242,
      chapterText: '余玠下令在钓鱼山开挖基槽、砌筑城墙，料石队当日进场。',
    });
    assert.ok(issues.some(issue => issue.type === '史实错误' && issue.earliestYear === 1243));
    assert.deepEqual(guardrails.historicalContinuityIssues({
 bookTitle: '示例历史长篇', year: 1243,
      chapterText: '余玠采纳冉氏兄弟建议，在钓鱼山开挖基槽、砌筑城墙。',
    }), []);
  });

  test('正文不得把丁家洲之战提前到1274年', () => {
    const issues = guardrails.historicalContinuityIssues({
 bookTitle: '示例历史长篇', year: 1274,
      chapterText: '贾似道在丁家洲统率宋军与元军决战，随后兵败。',
    });
    assert.ok(issues.some(issue => issue.type === '史实错误' && issue.earliestYear === 1275));
    assert.deepEqual(guardrails.historicalContinuityIssues({
 bookTitle: '示例历史长篇', year: 1275,
      chapterText: '贾似道在丁家洲统率宋军与元军决战，随后兵败。',
    }), []);
  });

  test('历史章阶段任务必须同时进入 scene beat 和 checkpoint', () => {
    assert.equal(typeof guardrails.historicalOutlineIssues, 'function');
    const missing = guardrails.historicalOutlineIssues({
      year: 1244,
      phase: '安葬与安置，建立生存根基',
 scenes: [{ beat: '主角验图并发现北坡鞋印' }],
      checkpoints: ['完成北坡地图验收'],
    });
    assert.ok(missing.some(issue => issue.type === '大纲偏离' && issue.severity === 'high'));

    assert.deepEqual(guardrails.historicalOutlineIssues({
      year: 1244,
      phase: '安葬与安置，建立生存根基',
 scenes: [{ beat: '主角将弟弟骨殖安葬，并获准留在营中安置' }],
      checkpoints: ['完成弟弟安葬和本人营中安置'],
    }), []);
  });

  test('audit 的阶段覆盖要点不因长阶段短语采用同义表达而重复注入', () => {
    assert.deepEqual(audit.coverageCheckpointsFor(
      { genre: '历史' },
      {
        phase: '安葬与安置，建立生存根基',
        checkpoints: ['完成弟弟安葬和本人营中安置'],
      },
    ), ['完成弟弟安葬和本人营中安置']);
  });

  test('筑城劳役与基本技能的同义表述可覆盖阶段任务', () => {
    const outline = {
      phase: '参与筑城劳役，学习基本技能',
      scenes: [{ beat: '少年参加筑城劳役，在工匠指导下学习撬杠与木辊的基本技能' }],
      checkpoints: ['完成筑城劳役，并掌握搬石、守绳和排水的基本技能'],
    };
    assert.deepEqual(guardrails.historicalOutlineIssues(outline), []);
  });

  test('建设卷的巡城、夜哨、塌方、工组、追责与验收阶段可由具体动作覆盖', () => {
    const cases = [
      ['了解山城防御体系，拓宽视野', '巡看三江、城线、水池与暗门，理解山城全局。'],
      ['守规参与警戒，学会信息交接', '夜哨警戒异常，少年只负责传讯和信息交接。'],
      ['工地险情与同伴担当', '料场塌方时按规程撤离，并护住同伴。'],
      ['承担有限工组责任', '在工头主持下承担有限工组责任，负责分绳轮歇。'],
      ['承担失败，建立预警程序', '接受追责并建立观雨看水与撤离预警程序。'],
      ['阶段工程结算，形成羁绊与志向', '阶段工程验收完成，与同伴形成羁绊并明确守护志向。'],
    ];
    for (const [phase, text] of cases) {
      assert.deepEqual(guardrails.historicalOutlineIssues({
        phase, scenes: [{ beat: text }], checkpoints: [text],
      }), [], phase);
    }
  });

  test('十六岁前不得靠独立杀敌、统领成人或正式军职制造成长爽点', () => {
    assert.equal(typeof guardrails.historicalYouthAuthorityIssues, 'function');
    const bad = guardrails.historicalYouthAuthorityIssues({
 bookTitle: '示例历史长篇', year: 1245, protagonistAge: 13,
      outline: {
        title: '夜半刀光', phase: '首次实战',
 scenes: [{ beat: '主角独立设伏，指挥成年军卒迎敌，并手刃蒙古骑兵。' }],
        checkpoints: ['十三岁主角独立杀敌并获得都头军职'],
      },
    });
    assert.ok(bad.some(item => item.type === '角色越权' && item.severity === 'high'));

    assert.deepEqual(guardrails.historicalYouthAuthorityIssues({
 bookTitle: '示例历史长篇', year: 1246, protagonistAge: 14,
      outline: {
        title: '十人一绳', phase: '工组协作',
 scenes: [{ beat: '主角只在成年人主持下承担十人民夫工组的守绳、记号与轮歇责任，不得指挥军队。' }],
        checkpoints: ['完成有限工组责任，军务仍由成人负责'],
      },
    }), []);
  });

  test('历史连续性规则已接入章节审校的本地问题集合', async () => {
    assert.equal(typeof guardrails.historicalContinuityIssues, 'function');
    const { book, volume } = historyFixture();
    const chapter = store.chapters.create(book.id, volume.id, 1, {
      title: '错年主将',
      outline: { year: 1244, era_year: '淳祐四年', protagonist_age: 12, phase: '筑城' },
    });
    store.scenes.create(chapter.id, 1, {
      content: '钓鱼城主将王坚下令增筑城墙。'.repeat(30), status: 'done',
    });
    const result = await audit.auditChapter(book.id, chapter.id);
    assert.ok(result.localIssues.some(issue => issue.type === '史实错误'));
    assert.equal(result.verdict, 'fix');
  });

  test('角色点名册不向当前章注入尚未到首登场章的未来人物', () => {
    const { book } = historyFixture();
    store.characters.create(book.id, {
 name: '主角', firstChapter: 1, tier: 'protagonist', card: { role: '主角' },
    });
    store.characters.create(book.id, {
      name: '王坚', firstChapter: 25, tier: 'major', card: { role: '后期合州守将' },
    });

    const chapter10 = characters.characterRollCallText(book.id, { chapterIdx: 10 });
 assert.match(chapter10, /主角/);
    assert.doesNotMatch(chapter10, /王坚/);
    assert.doesNotMatch(factbook.characterStatesText(book.id, { chapterIdx: 10 }), /王坚/);

    const chapter25 = characters.characterRollCallText(book.id, { chapterIdx: 25 });
    assert.match(chapter25, /王坚/);
    assert.match(factbook.characterStatesText(book.id, { chapterIdx: 25 }), /王坚/);
  });

  test('场景人物卡即使被细纲误点名，也不得提前注入未来人物', () => {
    const { book } = historyFixture();
    store.characters.create(book.id, {
 name: '主角', firstChapter: 1, tier: 'protagonist',
      personality: '谨慎', card: { role: '主角' },
    });
    store.characters.create(book.id, {
      name: '秦月', firstChapter: 17, tier: 'major',
      personality: '坚韧', secret: '后期秘密', card: { role: '后期医官' },
    });

    const chapter10 = characters.characterCardsText(book.id, {
 names: ['主角', '秦月'], chapterIdx: 10,
    });
 assert.match(chapter10, /主角/);
    assert.doesNotMatch(chapter10, /秦月|后期秘密/);

    const chapter17 = characters.characterCardsText(book.id, {
      names: ['秦月'], chapterIdx: 17,
    });
    assert.match(chapter17, /秦月/);
  });

  test('未来卷故事弧在开启章之前不进入快感上下文或停滞提醒', () => {
    const { book } = historyFixture();
    store.storyArcs.create(book.id, {
      name: '当前生存线', type: '主线', openedChapter: 1, targetChapter: 16,
    });
    store.storyArcs.create(book.id, {
      name: '后期朝堂线', type: '暗线', openedChapter: 25, targetChapter: 80,
    });

    const chapter10 = pleasure.buildPleasureContext(book.id, 10);
    assert.match(chapter10, /当前生存线/);
    assert.doesNotMatch(chapter10, /后期朝堂线/);
    assert.equal(store.storyArcs.stale(book.id, 20, 8).some(arc => arc.name === '后期朝堂线'), false);

    assert.match(pleasure.buildPleasureContext(book.id, 25), /后期朝堂线/);
  });

  test('按卷标注的故事弧会换算为未来章节窗，不会全部从第1章开启', () => {
    assert.deepEqual(pleasure.parseArcWindow('第2-12卷', { chaptersPerVolume: 10 }), {
      openedChapter: 11, targetChapter: 120,
    });
    assert.deepEqual(pleasure.parseArcWindow('第3-9卷', { chaptersPerVolume: 8 }), {
      openedChapter: 17, targetChapter: 72,
    });
    assert.deepEqual(pleasure.parseArcWindow('第4-20章'), {
      openedChapter: 4, targetChapter: 20,
    });
  });

  test('尚未到出场卷的情感线不会提前注入少年阶段', () => {
    const { book } = historyFixture();
    const settings = store.books.settings(book.id);
    settings.pleasurePlan = {
 emotion_lines: [{ name: '主角×秦月', phase_plan: '出场（第3卷）→确认（第6卷）' }],
    };
    store.books.update(book.id, { settings });
    const volume = store.volumes.list(book.id)[0];
    for (let i = 1; i <= 8; i++) store.chapters.create(book.id, volume.id, i, { title: `第${i}章` });
    assert.doesNotMatch(pleasure.buildPleasureContext(book.id, 8), /秦月/);
    assert.match(pleasure.buildPleasureContext(book.id, 17), /秦月/);
  });
});
