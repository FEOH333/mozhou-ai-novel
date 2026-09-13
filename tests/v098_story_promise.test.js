import './helper.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as store from '../server/db/store.js';

let book;

beforeEach(() => {
  book = store.books.create({
 title: '示例历史长篇',
    genre: '历史',
    platform: '番茄',
    perspective: 'third',
    blurb: '九岁流民十八年后站上钓鱼城头，见证蒙古大汗死于此地。',
  });
 store.materials.set(book.id, 'contract', '主角主角，非穿越，无系统；从无力保护家人到保护山河。');
  store.materials.set(book.id, 'outline', '1241年故园陷落；1259年钓鱼城；严肃历史成长史。');
});

test('V0.98 平台指导区分官方事实、创作指导、样本观察与未证实假设', async () => {
  const { platformGuidanceText } = await import('../server/data/platform_guidance.js');
  const text = platformGuidanceText('番茄');
  assert.match(text, /推荐评估.*推荐验证/s);
  assert.match(text, /官方创作指导/);
  assert.match(text, /单一维度|一个.*吸引/);
  assert.match(text, /未证实.*第0章.*小数章节/s);
  const officialSections = text.split('【未证实，禁止当作规则】')[0];
  assert.doesNotMatch(officialSections, /第20章必然|第0章.*支持|留存率\s*[><=]/);
  assert.doesNotMatch(text, /预计首章完读率|留存率\s*[><=]/);
});

test('V0.98 三类开篇提示词使用分层证据且不预测平台指标', async () => {
  const promptsSource = fs.readFileSync('server/engine/prompts.js', 'utf8');
  const attractionSource = fs.readFileSync('server/engine/quality/attraction.js', 'utf8');
  assert.doesNotMatch(promptsSource, /番茄铁律|三秒原则|expected_retention|expected_follow_rate|avg_chapter_completion/);
  assert.doesNotMatch(attractionSource, /番茄铁律|三秒原则/);

  const { openingBlueprintInstruction, signingReviewInstruction, attractionGateInstruction } = await import('../server/engine/prompts.js');
  const evidence = {
    platformGuidance: '【官方创作指导（不是审核阈值）】\n- 先呈现核心吸引点\n【编辑启发，不是平台阈值】\n- 减少空转',
    genreProfile: '【题材样本观察（不是因果规则）】\n- 具体困局中的人物选择',
  };
  for (const text of [
    openingBlueprintInstruction({ bookTitle: '测试', genre: '历史', platform: '番茄', isHistory: true, ...evidence }),
    signingReviewInstruction({ bookTitle: '测试', genre: '历史', opening: '正文', ...evidence }),
    attractionGateInstruction({ bookTitle: '测试', chapterTitle: '一', chapterIdx: 1, chapterText: '正文', ...evidence }),
  ]) {
    assert.match(text, /官方创作指导/);
    assert.match(text, /题材样本观察/);
    assert.match(text, /不是.*阈值|不是.*规则/);
    assert.doesNotMatch(text, /预估.*完读|预估.*追更|签约概率\s*[><=]|留存率\s*[><=]/);
  }

  const signing = signingReviewInstruction({ bookTitle: '测试', genre: '历史', opening: '正文', ...evidence });
  assert.match(signing, /evidence_limits/);
  assert.match(signing, /文本审阅，不预测平台流量或签约概率/);
  assert.match(signing, /observation_plan/);
});

test('V0.98 结构规则以作品吸引点为目标，不把黄金三章写成统一公式', async () => {
  const { STRUCTURE_RULES } = await import('../server/data/literary_techniques.js');
  const text = STRUCTURE_RULES.join('\n');
  assert.match(text, /开篇目标.*真正依靠的吸引点/s);
  assert.match(text, /具体速度服从题材/);
  assert.doesNotMatch(text, /黄金三章.*第 1 章给.*第 2 章给.*第 3 章给/s);
});

test('V0.98 历史题材画像保留严肃沉浸路线，不强塞系统与打脸', async () => {
  const { fanqieGenreProfile } = await import('../server/data/fanqie_genre_profiles.js');
  const profile = fanqieGenreProfile('历史', 'serious_immersive_history');
  assert.ok(profile.entryPatterns.includes('具体困局中的人物选择'));
  assert.ok(profile.payoffTranslations.includes('能力使身边人少付代价'));
  assert.ok(profile.antiPatterns.includes('为追榜强加系统'));
  assert.equal(profile.observations.every(item => item.sourceTier === 'rank_sample'), true);
  assert.doesNotMatch(JSON.stringify(profile), /必须.*系统|每章.*打脸|固定留存率/);
});

test('V0.98 本作画像把情感债翻译为行动回报并记录来源', async () => {
  const { buildStoryPromiseProfile } = await import('../server/engine/planning/story_promise.js');
  const profile = await buildStoryPromiseProfile(book.id, {
    data: {
      premise_in_one_breath: '九岁失去故园的孩子，用四十年学会让山河不再抛下百姓',
      primary_attraction_axis: '从无人回头救他，到他有能力回头救别人',
      secondary_axes: ['真实战争中的能力成长'],
      protagonist_now: { lack: '无力保护家人', immediate_need: '护住幼弟', agency_pattern: '先观察，再保护最弱的人' },
      payoff_ladder: { near: ['前三章作出一次有效保护'], middle: ['能力使同伴少付代价'], long: ['1259年钓鱼城见证历史转折'] },
      texture: { route: 'serious_immersive_history', pace: '沉浸中持续推进', humor: 'low', historical_density: 'high', pov: 'close_third' },
      protected_elements: ['糖兔子', '父亲短猎刀'],
      anti_promises: ['无系统', '非穿越'],
      author_locks: ['严肃历史质感'],
      confidence: { primary_attraction_axis: 'source_text', payoff_ladder: 'inferred' },
    },
  });
  assert.equal(profile.version, 1);
  assert.equal(profile.texture.route, 'serious_immersive_history');
  assert.match(profile.primary_attraction_axis, /回头救别人/);
  assert.ok(profile.anti_promises.includes('无系统'));
  assert.ok(profile.payoff_ladder.near.some(item => /保护/.test(item)));
  assert.equal(profile.source_fingerprint.length, 64);
  assert.equal(store.books.settings(book.id).storyPromiseProfile.primary_attraction_axis, profile.primary_attraction_axis);
});

test('V0.98 重建画像不得覆盖作者锁定字段', async () => {
  const { buildStoryPromiseProfile, lockStoryPromiseFields } = await import('../server/engine/planning/story_promise.js');
  await buildStoryPromiseProfile(book.id, { data: {
    premise_in_one_breath: '初始', primary_attraction_axis: '亲情', secondary_axes: [],
    protagonist_now: { lack: '弱小', immediate_need: '活下去', agency_pattern: '观察' },
    payoff_ladder: { near: ['选择'], middle: ['成长'], long: ['守城'] },
    texture: { route: 'serious_immersive_history', pace: '稳', humor: 'low', historical_density: 'high', pov: 'close_third' },
    protected_elements: [], anti_promises: ['无系统'], author_locks: [], confidence: {},
  } });
  lockStoryPromiseFields(book.id, {
    'texture.route': 'serious_immersive_history',
    anti_promises: ['无系统', '非穿越'],
  });
  const next = await buildStoryPromiseProfile(book.id, { force: true, data: {
    premise_in_one_breath: ' flashy ', primary_attraction_axis: '系统升级', secondary_axes: [],
    protagonist_now: { lack: '等级低', immediate_need: '抽奖', agency_pattern: '领取奖励' },
    payoff_ladder: { near: ['打脸'], middle: ['打脸'], long: ['无敌'] },
    texture: { route: 'high_concept_fast', pace: '极快', humor: 'high', historical_density: 'low', pov: 'omniscient' },
    protected_elements: [], anti_promises: [], author_locks: [], confidence: {},
  } });
  assert.equal(next.texture.route, 'serious_immersive_history');
  assert.deepEqual(next.anti_promises, ['无系统', '非穿越']);
  assert.equal(next.confidence['texture.route'], 'author_confirmed');
});

test('V0.98 书契约或大纲变化会让画像变陈旧，作者锁仍保留', async () => {
  const { buildStoryPromiseProfile, lockStoryPromiseFields, storyPromiseStatus } = await import('../server/engine/planning/story_promise.js');
  await buildStoryPromiseProfile(book.id, { data: {
    premise_in_one_breath: '初始', primary_attraction_axis: '亲情', secondary_axes: [],
    protagonist_now: { lack: '弱小', immediate_need: '活下去', agency_pattern: '观察' },
    payoff_ladder: { near: ['选择'], middle: ['成长'], long: ['守城'] },
    texture: { route: 'serious_immersive_history', pace: '稳', humor: 'low', historical_density: 'high', pov: 'close_third' },
    protected_elements: [], anti_promises: ['无系统'], author_locks: [], confidence: {},
  } });
  lockStoryPromiseFields(book.id, { primary_attraction_axis: '保护与成长' });
  assert.equal(storyPromiseStatus(book.id).stale, false);
  store.materials.set(book.id, 'outline', '改过的书纲');
  const status = storyPromiseStatus(book.id);
  assert.equal(status.stale, true);
  assert.equal(status.locks.primary_attraction_axis, '保护与成长');
});

test('V0.98 开篇蓝图必须消费最新创作宪章，只有显式跳过才允许降级', async () => {
  const { generateOpeningBlueprint } = await import('../server/engine/planning/opening.js');
  const { buildStoryPromiseProfile } = await import('../server/engine/planning/story_promise.js');
  const draft = {
    hook_ladder: [{ chapter: 1, title: '开篇', hook: '问题', payoff: '选择', beat: '行动' }],
    pleasure_pacing: [], golden_finger: null, protagonist_goal_ladder: [], promise_deadlines: [],
  };
  const missing = await generateOpeningBlueprint(book.id, { force: true, data: draft });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'STORY_PROMISE_REQUIRED');

  await buildStoryPromiseProfile(book.id, { data: {
    premise_in_one_breath: '孩子学会保护别人', primary_attraction_axis: '保护', secondary_axes: [],
    protagonist_now: { lack: '弱小', immediate_need: '活下去', agency_pattern: '观察后行动' },
    payoff_ladder: { near: ['有效选择'], middle: ['保护同伴'], long: ['守住山河'] },
    texture: { route: 'serious_immersive_history', pace: '稳', humor: 'low', historical_density: 'high', pov: 'close_third' },
    protected_elements: [], anti_promises: ['无系统'], author_locks: [], confidence: {},
  } });
  const ready = await generateOpeningBlueprint(book.id, { force: true, data: draft });
  assert.equal(ready.ok, true);
  assert.equal(ready.blueprint.story_promise_fingerprint.length, 64);

  const legacyBook = store.books.create({ title: '显式降级', genre: '都市', platform: '番茄' });
  const legacy = await generateOpeningBlueprint(legacyBook.id, { force: true, data: draft, allowWithoutStoryPromise: true });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.blueprint.story_promise_fingerprint, 'explicit-skip');
});

test('V0.98 mock 主流程能生成严格创作宪章', async () => {
  const { ensureStoryPromiseProfile } = await import('../server/engine/planning/story_promise.js');
  const fresh = store.books.create({ title: '画像主流程', genre: '历史', platform: '番茄', blurb: '一个孩子在乱世学会保护别人' });
  store.materials.set(fresh.id, 'contract', '无系统，严肃历史成长');
  store.materials.set(fresh.id, 'outline', '从流民到守城者');
  const before = process.env.NOVEL_MOCK_LLM;
  process.env.NOVEL_MOCK_LLM = '1';
  const result = await ensureStoryPromiseProfile(fresh.id);
  if (before === undefined) delete process.env.NOVEL_MOCK_LLM; else process.env.NOVEL_MOCK_LLM = before;
  assert.equal(result.ok, true);
  assert.ok(result.profile.primary_attraction_axis);
  assert.equal(result.profile.texture.route, 'serious_immersive_history');
});

test('V0.98 pilot 顺序是设定完成后建立宪章，再生成开篇蓝图', () => {
  const source = fs.readFileSync('server/engine/pipeline/pilot.js', 'utf8');
  const settingsAt = source.indexOf('await generateBookSettings');
  const promiseAt = source.indexOf('await ensureStoryPromiseProfile');
  const openingAt = source.indexOf('generateOpeningBlueprint');
  assert.ok(settingsAt > 0 && promiseAt > settingsAt && openingAt > promiseAt);
  assert.match(source, /skipStoryPromise/);
  assert.match(source, /STORY_PROMISE_REQUIRED|创作画像未完成/);
});
