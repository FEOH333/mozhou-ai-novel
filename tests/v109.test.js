// V0.91.2：历史长篇坐标同步、卷审阅真实状态与健康记录收敛
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_FAULT = '';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v109-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const history = await import(pathToFileURL(path.join(ROOT, 'server/engine/longform/historical_longform.js')));
const historicalState = await import(pathToFileURL(path.join(ROOT, 'server/engine/longform/historical_state.js'))).catch(() => ({}));
const volumeReview = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/volumereview.js')));
const { settleChapter } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/settle.js')));
const pipeline = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/pipeline.js')));
const characters = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/characters.js')));
const audit = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/audit.js')));

function historicalBook() {
  const book = store.books.create({
 title: '示例历史长篇', genre: '历史',
    blurb: '淳祐元年九岁起步，十八年后守钓鱼城，四十年山河。',
  });
 store.materials.set(book.id, 'outline', '主角：主角（蜀中孤儿）');
  return book;
}

describe('V0.91.2 历史坐标与卷审阅修复', () => {
  test('前20章约束不得把第2卷1244年误锁回1241—1243年', () => {
    const text = history.historicalLongformPlanText({
 title: '示例历史长篇', blurb: '淳祐元年，四十年山河，钓鱼城。',
    });
    assert.doesNotMatch(text, /前20章只能写1241[—-]1243/);
    assert.match(text, /第1卷[^\n]*1241[—-]1243/);
    assert.match(text, /前20章[^\n]*不得提前[^\n]*1259/);
  });

  test('章节年代帧应覆盖人物库中过期年龄，且能在多个 protagonist 中锁定书纲主角', () => {
    assert.equal(typeof historicalState.syncHistoricalProtagonistState, 'function');
    const book = historicalBook();
    const volume = store.volumes.create(book.id, 2, { title: '山城余火' });
    const chapter = store.chapters.create(book.id, volume.id, 9, {
      title: '灰烬生根',
      outline: { year: 1244, era_year: '淳祐四年', protagonist_age: 12, scenes: [{ beat: '验图' }] },
    });
    store.characters.create(book.id, { name: '余玠', tier: 'protagonist', state: { 年龄: '39岁' } });
 store.characters.create(book.id, { name: '主角', tier: 'protagonist', state: { 年龄: '9岁（淳祐元年秋）', 位置: '料场' } });

    const result = historicalState.syncHistoricalProtagonistState(book.id, chapter.id);
    const chars = store.characters.list(book.id);
 const hero = chars.find(c => c.name === '主角');
    const mentor = chars.find(c => c.name === '余玠');
    assert.equal(result.updated, true);
    assert.deepEqual(JSON.parse(hero.state_json), {
      年龄: '12岁（淳祐四年）', 位置: '料场', 公元年: '1244年', 当前纪年: '淳祐四年',
    });
    assert.equal(JSON.parse(mentor.state_json).年龄, '39岁');
  });

  test('历史章结算应以章细纲年代为时间线权威坐标，并同步主角年龄', async () => {
    assert.equal(typeof historicalState.syncHistoricalProtagonistState, 'function');
    const book = historicalBook();
    const volume = store.volumes.create(book.id, 2, { title: '山城余火' });
    const chapter = store.chapters.create(book.id, volume.id, 9, {
      title: '灰烬生根',
      outline: { year: 1244, era_year: '淳祐四年', protagonist_age: 12, scenes: [{ beat: '验图' }] },
    });
 store.scenes.create(chapter.id, 1, { content: '晨光中，主角带陈七查验北坡地图。', status: 'done' });
 store.characters.create(book.id, { name: '主角', tier: 'protagonist', state: { 年龄: '9岁（淳祐元年秋）' } });

    await settleChapter(book.id, chapter.id, { data: {
 facts: [], character_updates: [], timeline: ['晨，主角带陈七查验北坡地图'],
 foreshadow_actions: [], new_entities: [], summary: '主角验图成功。', rolling_update: '主角验图成功。',
    } });

    const event = store.timeline.list(book.id).find(row => row.event.includes('验北坡'));
 const hero = store.characters.list(book.id).find(c => c.name === '主角');
    assert.equal(event.year, 1244);
    assert.equal(event.era_year, '淳祐四年');
    assert.equal(JSON.parse(hero.state_json).年龄, '12岁（淳祐四年）');
  });

  test('卷审阅必须按卷 UUID 幂等落库，不能把卷序号当 volume_id', async () => {
    const book = store.books.create({ title: '卷审 UUID', genre: '历史' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷', goal: '立住人物' });
    const chapter = store.chapters.create(book.id, volume.id, 1, { title: '灯影', status: 'done' });
 store.scenes.create(chapter.id, 1, { content: '主角走出庙会，望见山火。'.repeat(40), status: 'done' });
 store.summaries.set(chapter.id, book.id, '主角在庙会后发现山火。');

    await volumeReview.runVolumeReview(book.id, volume.id, {});

    assert.ok(store.volumeReviews.byVolume(book.id, volume.id));
    const stored = store.db().prepare('SELECT volume_id FROM volume_reviews WHERE book_id=?').get(book.id);
    assert.equal(stored.volume_id, volume.id);
    assert.equal(volumeReview.reviewDueVolumes(book.id).length, 0);
  });

  test('旧库中用卷序号保存的审阅记录应无损迁移到卷 UUID', () => {
    assert.equal(typeof store.volumeReviews.repairLegacyRefs, 'function');
    const book = store.books.create({ title: '旧卷审迁移', genre: '历史' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
    const chapter = store.chapters.create(book.id, volume.id, 1, { title: '第一章', status: 'done' });
    store.summaries.set(chapter.id, book.id, '完成');
    store.db().prepare(`INSERT INTO volume_reviews
      (book_id,volume_id,grade,report_json,issues_json,status,revised_count,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(book.id, 1, 'B', '{}', '[]', 'done', 0, Date.now());

    const repaired = store.volumeReviews.repairLegacyRefs(book.id);
    const row = store.db().prepare('SELECT * FROM volume_reviews WHERE book_id=?').get(book.id);
    assert.equal(repaired, 1);
    assert.equal(row.volume_id, volume.id);
    assert.equal(volumeReview.reviewDueVolumes(book.id).length, 0);
  });

  test('卷审解析失败必须显示失败待重试，不能显示为 C 级零工单', () => {
    assert.equal(typeof volumeReview.volumeReviewDisplayEvent, 'function');
    const failed = volumeReview.volumeReviewDisplayEvent({
      volumeIdx: 1, grade: 'C', issues: [], revised: 0, failed: true,
    });
    assert.equal(failed.type, 'volume_review_error');
    assert.match(failed.data.error, /解析失败|未完成|重试/);
    assert.doesNotMatch(failed.data.error, /C\s*级/);
  });

  test('成功健康快照应清除旧的纯文本失败说明，同时保留结构化快感审计 notes', () => {
    const book = store.books.create({ title: '健康收敛', genre: '历史' });
    const chapter = store.chapters.create(book.id, null, 1, { title: '第一章' });
    store.chapterHealth.upsert({ bookId: book.id, chapterId: chapter.id, idx: 1, verdict: 'error', failed: true, notes: '质量门失败' });
    store.chapterHealth.upsert({ bookId: book.id, chapterId: chapter.id, idx: 1, verdict: 'accept', failed: false, notes: '' });
    assert.equal(store.chapterHealth.getByChapter(chapter.id).notes, '');

    store.chapterHealth.update(store.chapterHealth.getByChapter(chapter.id).id, { notes: JSON.stringify({ hook: { present: true } }) });
    store.chapterHealth.upsert({ bookId: book.id, chapterId: chapter.id, idx: 1, verdict: 'accept', failed: false, notes: '' });
    assert.deepEqual(JSON.parse(store.chapterHealth.getByChapter(chapter.id).notes), { hook: { present: true } });
  });

  test('细纲与正文只有可定位的数量口径不一致时应局部修订，不应整章重规划', () => {
    const audit = {
      verdict: 'fix',
      issues: [{
        type: '事实矛盾', severity: 'high',
        quote: '剩下三骑冲出沟口……四骑在沟外散开',
        issue: '细纲明确要求三骑逃脱，而草稿中写成四骑，数量与细纲冲突',
        fix: '将四骑统一改为三骑',
      }],
    };
    assert.equal(pipeline.auditIssueRepairMode(audit), 'revise');
  });

  test('人物点名册优先注入当前纪年和职责，不能让早期见闻挤掉最新状态', () => {
    const book = historicalBook();
    store.characters.create(book.id, {
 name: '主角', tier: 'protagonist',
      state: {
        年龄: '12岁（淳祐四年）',
        位置: '钓鱼山探哨队营地',
        状态: '正式转入探哨队，专管画图',
        得知: '淳祐元年时听见鞑子过散关的传闻',
        心境: '警惕',
        职位: '探哨队画图',
        公元年: '1244年',
        当前纪年: '淳祐四年',
      },
    });
    const text = characters.characterRollCallText(book.id);
    assert.match(text, /当前纪年=淳祐四年/);
    assert.match(text, /职位=探哨队画图/);
    assert.doesNotMatch(text, /鞑子过散关/);
  });

  test('审校应区分同一意象的不同事件，不能仅因山火方向不同判伏笔矛盾', async () => {
    const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const text = prompts.auditInstruction({
 bookTitle: '示例历史长篇', chapterTitle: '伏兵', chapterText: '北山信号火亮起。',
      factsText: '', foreshadowsText: '- 东南山脊的烧村火\n- 北山斥候信号火',
      characterStates: '', contract: '', perspective: 'third', chapterOutline: '追查北山斥候',
    });
    assert.match(text, /不同事件|不同来源/);
    assert.match(text, /方向不同[^\n]*不能[^\n]*伏笔/);
  });

  test('历史章的阶段任务必须自动进入正文覆盖校验，不能只校验细纲自报的 checkpoints', () => {
    assert.equal(typeof audit.coverageCheckpointsFor, 'function');
    assert.deepEqual(audit.coverageCheckpointsFor(
      { genre: '历史' },
      { phase: '安葬与安置，建立生存根基', checkpoints: ['完成北坡地图验收'] },
    ), ['阶段任务：安葬与安置，建立生存根基', '完成北坡地图验收']);
    assert.deepEqual(audit.coverageCheckpointsFor(
      { genre: '历史' },
      { phase: '安葬与安置', checkpoints: ['本章完成安葬与安置'] },
    ), ['本章完成安葬与安置']);
  });
});
