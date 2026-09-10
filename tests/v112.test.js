// V0.92 完本兑付台账：结构化债务与确定性完本准备度
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v112-ending-ledger-'));
const ROOT = process.cwd();

const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const lifecycle = await import(pathToFileURL(path.join(ROOT, 'server/engine/longform_lifecycle.js')));

const delivery = {
  final_opposition: '阻挡主角目标的最后力量',
  final_choice: '放弃独占胜果，把选择权还给众人',
  irreversible_cost: '永久失去最高权位与一位至亲战友',
  core_promise_payoff: '主角完成守护故土的核心誓言',
  protagonist_settlement: '从只求自保走到愿意承担共同命运',
  relationship_settlements: ['与师友和解', '送别牺牲的同伴'],
  world_settlement: '旧秩序被替换，新秩序开始运转',
  historical_settlement: '不适用',
  closing_image: '开篇那盏熄灭的灯在孩子手里重新亮起',
  last_chapter_mode: '余波→人物安顿→主题回声→闭幕，不设新主线悬念',
};

function makeFinaleBook(title = '终局测试书') {
  const book = store.books.create({
    title, genre: '玄幻', blurb: '主角守住故土并改变旧秩序',
    settings: { longformLifecycle: { plannedVolumes: 10 } },
  });
  store.materials.set(book.id, 'contract', '【书契约】核心卖点：守住故土，改变旧秩序');
  const volume = store.volumes.create(book.id, 10, {
    title: '终卷', goal: '完成最终选择', status: 'done',
    outline: {
      lifecycle_stage: 'finale', stage_turn: '完成终局选择并交代余波',
      arcs_advanced: [], arcs_closed: [], hooks_paid: [], new_major_arcs: [], ending_delivery: delivery,
    },
  });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '灯火归人', status: 'done' });
  store.scenes.create(chapter.id, 1, { content: '终局正文'.repeat(300), status: 'done' });
  lifecycle.ensureEndingBlueprint(book.id, {
    data: { ...delivery, core_promise: '守住故土，改变旧秩序' },
  });
  store.volumeReviews.upsert(book.id, volume.id, {
    grade: 'A', status: 'done', issues: [],
    report: {
      goal_met: true,
      stage_progress: { stage: 'finale', duty_met: true, note: '终局完成' },
      ending_readiness: { ready: true, missing: [] },
    },
  });
  return { book, volume, chapter };
}

describe('V0.92 结构化兑付台账', () => {
  test('台账覆盖核心承诺、故事弧、伏笔、长期读者期待和结局形式', () => {
    const { book } = makeFinaleBook('台账分类书');
    store.contractPromises.upsert(book.id, { text: '第1章前看见主角立誓', dueChapter: 1, status: 'open' });
    store.storyArcs.create(book.id, { name: '推翻旧秩序主线', type: '主线', openedChapter: 1, targetChapter: 1 });
    store.foreshadows.create(book.id, { desc: '王印真正归属', status: 'planted', importance: 'high', plantedChapter: 1 });
    store.pleasureHooks.create(book.id, { desc: '主角终有一日公开选择天下归属', kind: 'long', status: 'open', plantedChapter: 1, dueChapter: 1 });
    store.pleasureHooks.create(book.id, { desc: '最后一页保留轻微余韵', kind: 'short', status: 'open', plantedChapter: 1, dueChapter: 2 });

    const ledger = lifecycle.buildPayoffLedger(book.id);
    const types = new Set(ledger.obligations.map(item => item.type));
    for (const type of ['core_promise', 'story_arc', 'foreshadow', 'reader_promise', 'ending_form']) assert.ok(types.has(type), `缺少 ${type}`);
    assert.equal(ledger.obligations.find(item => item.label.includes('轻微余韵')).blocking, false, '短钩不应单独阻止完本');
    assert.ok(ledger.blockers.length >= 4, '未清主线债务必须成为硬阻塞');
  });

  test('未清主线债务时准备度为 false，逐项闭合后才为 true', () => {
    const { book } = makeFinaleBook('完本准备度书');
    const promise = store.contractPromises.upsert(book.id, { text: '第1章前完成核心誓言', dueChapter: 1, status: 'open' });
    const arc = store.storyArcs.create(book.id, { name: '故土主线', type: '主线', openedChapter: 1, targetChapter: 1 });
    const clue = store.foreshadows.create(book.id, { desc: '故土失守真相', status: 'planted', importance: 'high', plantedChapter: 1 });
    const hook = store.pleasureHooks.create(book.id, { desc: '守住故土的长期期待', kind: 'super', status: 'open', plantedChapter: 1, dueChapter: 1 });

    let readiness = lifecycle.endingReadiness(book.id);
    assert.equal(readiness.ready, false);
    assert.ok(readiness.blockers.some(item => item.type === 'story_arc'));

    store.contractPromises.update(promise.id, { status: 'met', checkedChapter: 1, fulfilledChapter: 1 });
    store.storyArcs.update(arc.id, { status: 'closed', lastActiveChapter: 1 });
    store.foreshadows.update(clue.id, { status: 'paid_off', payoffChapter: 1 });
    store.pleasureHooks.update(hook.id, { status: 'paid', lastProgressChapter: 1 });

    readiness = lifecycle.endingReadiness(book.id);
    assert.equal(readiness.ready, true, readiness.summary);
    assert.equal(readiness.blockers.length, 0);
  });

  test('结局蓝图持久化为 JSON，并能格式化为后两卷直接使用的指令', () => {
    const { book } = makeFinaleBook('蓝图持久化书');
    const material = store.materials.get(book.id, 'ending_blueprint');
    assert.ok(material?.content);
    const parsed = JSON.parse(material.content);
    assert.equal(parsed.core_promise, '守住故土，改变旧秩序');
    assert.match(lifecycle.endingBlueprintText(book.id), /最终选择/);
    assert.match(lifecycle.endingBlueprintText(book.id), /闭幕意象/);
    assert.equal(store.books.settings(book.id).longformLifecycle.endingBlueprintReady, true);
  });
});
