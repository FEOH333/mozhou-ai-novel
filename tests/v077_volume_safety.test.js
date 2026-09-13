// V0.77 开新卷安全：卷纲幂等、下一卷上下文、世界回填纯读/版本及中断传播
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-v077-volume-'));
process.env.NOVEL_DATA_DIR = tmp;
process.env.NOVEL_MOCK_LLM = '0';
process.env.NOVEL_NO_OPEN = '1';

const store = await import('../server/db/store.js');
const { getGlobal, saveGlobal } = await import('../server/config.js');
const outlineEngine = await import('../server/engine/planning/outline.js');
const growthEngine = await import('../server/engine/planning/growth.js');
const worldEngine = await import('../server/engine/planning/world_expansion.js');
const continuation = await import('../server/engine/pipeline/continuation.js');

const originalFetch = globalThis.fetch;
let savedConfig;

before(() => {
  savedConfig = getGlobal();
  saveGlobal({
    apiKey: 'test-key',
    baseUrl: 'http://volume-v077.test',
    provider: 'custom',
    protocol: 'chat',
    deepseekParams: false,
    resilience: {
      connectTimeoutMs: 200,
      idleTimeoutMs: 200,
      totalTimeoutMs: 1000,
      maxRetries: 0,
      jitterMs: 0,
      circuitBreaker: { threshold: 100, openMs: 100 },
    },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  try { store.db().exec('DROP TRIGGER IF EXISTS v077_fail_entity_backfill'); } catch { /* ignore */ }
});

after(() => {
  saveGlobal(savedConfig);
  globalThis.fetch = originalFetch;
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* ignore */ }
});

function chatResponse(payload) {
  return new Response(JSON.stringify({
    model: 'volume-test-model',
    choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function promptFromRequest(init) {
  const body = JSON.parse(init.body);
  return [...(body.messages || [])].reverse().find(message => message.role === 'user')?.content || '';
}

function defaultPayload(prompt) {
  if (prompt.includes('"target_readers"')) {
    return { target_readers: '读者', selling_points: ['卖点'], promises: ['承诺'], hard_constraints: ['约束'], tone: '热血' };
  }
  if (prompt.includes('"scores"')) {
    return { scores: { novelty: 8, conflict: 8, market: 8, executable: 8 }, total: 8, verdict: 'pass', regen_direction: '' };
  }
  if (prompt.includes('"finished"')) return { finished: false, reason: '未完', remaining: ['主线'] };
  if (prompt.includes('"q1_visible_harm"')) {
    return { q1_visible_harm: '有', q4_ending_hook: '危机', q6_emotional_change: '有', pass: true, fail_reason: '' };
  }
  if (prompt.includes('"scenes"')) {
    return { title: '章细纲', goal: '推进', conflict: '冲突', scenes: [{ beat: '具体冲突', pov: '主角', location: '城门', target_words: 800 }], checkpoints: ['推进'] };
  }
  if (prompt.includes('"volumes"')) {
    return { title: '书纲', logline: '长篇故事', volumes: [{ idx: 1, title: '卷一', goal: '开局', summary: '出发' }] };
  }
  if (prompt.includes('"chapters"')) {
    const seamBlock = String(prompt).match(/【卷缝】[\s\S]*?(?=\n【卷缝纪律】|$)/)?.[0] || '';
    const seamLine = (seamBlock.match(/第\d+章《[^》]*》[^\n]*/) || [])[0] || '';
    const tail = (seamBlock.match(/章末余势：([^\n]+)/) || [])[1] || '';
    const stale = ((seamBlock.match(/停滞弧[^：\n]*：([^\n]+)/) || [])[1] || '')
      .split('、').map(s => s.replace(/（[^）]*）/g, '').trim()).filter(Boolean);
    const beat = (seamLine || tail)
      ? `承接上卷已经发生的事：${(seamLine + tail).slice(0, 80)}。主角据此作出不可逆选择`
      : '推进剧情';
    // V0.107：按指令请求章数返回（章数承诺硬校验）；标题句式轮换防 TITLE_SHAPE 连排
    const asked = parseInt((String(prompt).match(/本卷计划\s*(\d+)\s*章/) || [])[1], 10) || 12;
    const shapes = ['风起', '山雨欲来', '灯下旧刀', '踏出这一步的门', '旧约新签', '谁在墙外？', '雨停', '答案在路上'];
    const n = Math.min(Math.max(asked, 2), 20);
    return {
      title: '卷纲', goal: '推进', arc: '展开',
      lifecycle_stage: (prompt.match(/阶段ID[：:]\s*(opening|early_middle|middle|late_middle|ending|finale)/) || [])[1] || 'opening',
      stage_turn: '主角作出不可逆选择',
      arcs_advanced: stale.length ? stale.slice(0, 2) : ['主线'],
      arcs_closed: [], hooks_paid: [], new_major_arcs: [], ending_delivery: {},
      chapters: Array.from({ length: n }, (_, i) => ({ idx: i + 1, title: shapes[i % shapes.length], beat: i === 0 ? beat : '局势升级当场决策', pov: '主角' })),
    };
  }
  return { title: '续卷', goal: '继续主线', arc: '承接上卷', chapterCount: 6 };
}

function installResponder(handler = ({ prompt }) => defaultPayload(prompt)) {
  globalThis.fetch = async (_url, init) => {
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const prompt = promptFromRequest(init);
    return chatResponse(await handler({ prompt, init }));
  };
}

function makeBook({ title = '测试书', genre = '玄幻' } = {}) {
  const book = store.books.create({ title, genre, blurb: '测试灵感' });
  store.materials.set(book.id, 'contract', '【书契约】每10章至少一次境界突破');
  return book;
}

function addDoneChapters(bookId, volumeId, count, { withText = false } = {}) {
  const start = store.chapters.list(bookId).reduce((max, chapter) => Math.max(max, chapter.idx), 0);
  for (let offset = 1; offset <= count; offset += 1) {
    const chapter = store.chapters.create(bookId, volumeId, start + offset, {
      title: `第${start + offset}章`, status: 'done',
    });
    if (withText) store.scenes.create(chapter.id, 1, { content: `第${start + offset}章正文`, status: 'done' });
  }
}

function standardOutline(volumeCount, specialTitles = {}) {
  return outlineEngine.formatBookOutline({
    title: '长篇书', logline: '逐卷展开', protagonist: {}, main_characters: [],
    volumes: Array.from({ length: volumeCount }, (_, index) => {
      const idx = index + 1;
      return { idx, title: specialTitles[idx] || `规划卷${idx}`, goal: `目标${idx}`, summary: `走向${idx}` };
    }),
  });
}

describe('V0.77 开新卷安全', () => {
  test('同一卷重复生成卷大纲不追加章节，已写章不变，未写章按卷内位置更新', async () => {
    const book = makeBook();
    const volume = store.volumes.create(book.id, 1, { title: '第一卷', goal: '开局', status: 'planned' });
    const responses = [
      {
        title: '第一卷', goal: '旧目标', arc: '旧走向',
        // V0.107：标题句式多样（旧一/旧二/旧三 三连极简族会触发 TITLE_SHAPE 软校验烧掉重试）
        chapters: [
          { idx: 1, title: '旧账', beat: '旧节拍一', pov: '主角' },
          { idx: 2, title: '旧桥的约', beat: '旧节拍二', pov: '主角' },
          { idx: 3, title: '不该来的信', beat: '旧节拍三', pov: '主角' },
        ],
      },
      {
        title: '第一卷·新规划', goal: '新目标', arc: '新走向',
        chapters: [
          { idx: 1, title: '不应覆盖已写章', beat: '不应覆盖已写节拍', pov: '主角' },
          { idx: 2, title: '新二', beat: '新节拍二', pov: '配角' },
          { idx: 3, title: '新三', beat: '新节拍三', pov: '主角' },
        ],
      },
    ];
    let responseIndex = 0;
    installResponder(() => responses[responseIndex++]);

    await outlineEngine.generateVolumeOutline(book.id, volume.id, { chapterCount: 3 });
    const before = store.chapters.listByVolume(volume.id);
    const written = before[0];
    const scene = store.scenes.create(written.id, 1, { content: '已经写好的正文，绝不能覆盖。', status: 'done' });
    store.chapters.update(written.id, { status: 'done' });
    const unwrittenIds = before.slice(1).map(chapter => chapter.id);

    await outlineEngine.generateVolumeOutline(book.id, volume.id, { chapterCount: 3 });
    const afterRows = store.chapters.listByVolume(volume.id);
    assert.equal(afterRows.length, 3, '重复生成不得把三章翻倍为六章');
    assert.equal(afterRows[0].id, written.id);
    assert.equal(store.scenes.get(scene.id).content, '已经写好的正文，绝不能覆盖。');
    assert.equal(afterRows[0].title, '旧账', '已写章规划也不应被新卷纲覆盖');
    assert.deepEqual(afterRows.slice(1).map(chapter => chapter.id), unwrittenIds, '未写章应原位 upsert，不换 ID');
    assert.deepEqual(afterRows.slice(1).map(chapter => chapter.title), ['新二', '新三']);
    assert.equal(store.chapters.outline(afterRows[1].id).beat, '新节拍二');
  });

  test('成长和世界补救按已建卷选择第10卷，不取书纲最后卷', async () => {
    const outlineText = standardOutline(12, { 10: '星门初启', 12: '终局天穹' });

    const growthBook = makeBook({ title: '成长补救书' });
    for (let idx = 1; idx <= 9; idx += 1) store.volumes.create(growthBook.id, idx, { title: `已建卷${idx}`, status: 'done' });
    addDoneChapters(growthBook.id, store.volumes.list(growthBook.id)[8].id, 100);
    store.characters.create(growthBook.id, { name: '主角', tier: 'protagonist', state: { 丹田微流: '近干涸' }, abilities: '[]' });
    store.materials.set(growthBook.id, 'outline', outlineText);
    let growthPrompt = '';
    installResponder(({ prompt }) => {
      growthPrompt = prompt;
      return {
        reinterpretation: [],
        breakthrough: { startChapter: 101, fromStage: '练气', toStage: '筑基', steps: [] },
        volume_plan: '进入星门', state_cleanup: { keep: [], drop_examples: [] },
      };
    });
    const growthResult = await growthEngine.planRemedyBridge(growthBook.id, {});
    assert.equal(growthResult.planned, 1);
    assert.ok(growthPrompt.includes('【下一卷规划方向】星门初启'), growthPrompt);
    assert.ok(!growthPrompt.includes('终局天穹'), '不得误取书纲最后一卷');
    assert.ok(growthEngine.growthRemedyText(growthBook.id).includes('第10卷及后续'), '补救材料也应绑定实际下一卷');

    const worldBook = makeBook({ title: '世界补救书' });
    for (let idx = 1; idx <= 9; idx += 1) store.volumes.create(worldBook.id, idx, { title: `已建卷${idx}`, status: 'done' });
    addDoneChapters(worldBook.id, store.volumes.list(worldBook.id)[8].id, 100);
    const town = store.locations.create(worldBook.id, { name: '青阳镇', card: {} });
    const sect = store.locations.create(worldBook.id, { name: '青云宗', card: {} });
    store.locations.update(town.id, { firstChapter: 1 });
    store.locations.update(sect.id, { firstChapter: 2 });
    store.materials.set(worldBook.id, 'outline', outlineText);
    let worldPrompt = '';
    installResponder(({ prompt }) => {
      worldPrompt = prompt;
      return {
        reinterpretation: [],
        expansion: { startChapter: 101, fromLevel: '宗门', toLevel: '大陆', region: '星门', steps: [] },
        volume_plan: '进入星门', state_cleanup: { keep: [], drop_examples: [] },
      };
    });
    const worldResult = await worldEngine.planWorldExpansion(worldBook.id, {});
    assert.equal(worldResult.planned, 1);
    assert.ok(worldPrompt.includes('【下一卷规划方向】星门初启'), worldPrompt);
    assert.ok(!worldPrompt.includes('终局天穹'), '不得误取书纲最后一卷');
  });

  test('续卷能提取 formatBookOutline 的“第N卷”规划', async () => {
    const book = makeBook({ title: '书纲衔接书' });
    const volume = store.volumes.create(book.id, 1, { title: '旧城卷', goal: '离城', status: 'done' });
    addDoneChapters(book.id, volume.id, 1, { withText: true });
    store.materials.set(book.id, 'outline', standardOutline(3, { 2: '天门试炼', 3: '群星之海' }));
    let nextVolumePrompt = '';
    installResponder(({ prompt }) => {
      if (prompt.includes('续卷大纲')) {
        nextVolumePrompt = prompt;
        return { title: '天门试炼', goal: '通过试炼', arc: '进入天门', chapterCount: 6 };
      }
      return defaultPayload(prompt);
    });

    await continuation.generateNextVolume(book.id, {});
    assert.ok(nextVolumePrompt.includes('【书纲已规划的本书】第2卷《天门试炼》'), nextVolumePrompt);
    assert.ok(nextVolumePrompt.includes('目标2'), '应把该卷目标一并注入');
  });

  test('mild 世界展开提醒也触发补救（V0.83：60章仍困基层即生成补救桥段，不设100章门槛）', () => {
    const book = makeBook({ title: '温和提醒书' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷', status: 'done' });
    addDoneChapters(book.id, volume.id, 60);
    const town = store.locations.create(book.id, { name: '青阳镇', card: {} });
    const sect = store.locations.create(book.id, { name: '青云宗', card: {} });
    store.locations.update(town.id, { firstChapter: 1 });
    store.locations.update(sect.id, { firstChapter: 2 });

    const result = worldEngine.detectWorldStagnation(book.id);
    assert.equal(result.severity, 'mild');
    // V0.83：mild（60章仍困基层）也判 stagnant=true → planWorldExpansion 生成补救（此前仅 severe 100章才补救）
    assert.equal(result.stagnant, true, 'mild 也触发世界展开补救');
  });

  test('worldExpansionStatus 是纯读，不隐式回填实体或完成标记', () => {
    const book = makeBook({ title: '纯读状态书' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷', status: 'done' });
    const chapter = store.chapters.create(book.id, volume.id, 1, { title: '第一章', status: 'done' });
    store.scenes.create(chapter.id, 1, { content: '主角第一次走进青云宗。', status: 'done' });
    const location = store.locations.create(book.id, { name: '青云宗', card: {} });

    worldEngine.worldExpansionStatus(book.id);

    assert.equal(store.locations.get(location.id).first_chapter, null);
    assert.equal(store.materials.get(book.id, 'entity_chapters'), undefined);
  });

  test('实体章节回填任一章失败时不写完成标记', () => {
    const book = makeBook({ title: '回填失败书' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷', status: 'done' });
    const chapter = store.chapters.create(book.id, volume.id, 1, { title: '第一章', status: 'done' });
    store.scenes.create(chapter.id, 1, { content: '主角抵达青云宗。', status: 'done' });
    const location = store.locations.create(book.id, { name: '青云宗', card: {} });
    store.db().exec(`
      CREATE TRIGGER v077_fail_entity_backfill
      BEFORE UPDATE ON locations
      WHEN OLD.id = '${location.id}'
      BEGIN
        SELECT RAISE(ABORT, 'injected entity backfill failure');
      END
    `);

    try { worldEngine.ensureEntityChaptersBackfilled(book.id); } catch { /* failure may propagate */ }
    assert.equal(store.materials.get(book.id, 'entity_chapters'), undefined);
  });

  test('实体章节回填完成标记带版本且同版本幂等', () => {
    const book = makeBook({ title: '回填版本书' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷', status: 'done' });
    const chapter = store.chapters.create(book.id, volume.id, 1, { title: '第一章', status: 'done' });
    store.scenes.create(chapter.id, 1, { content: '主角抵达青云宗。', status: 'done' });
    store.locations.create(book.id, { name: '青云宗', card: {} });

    assert.equal(worldEngine.ensureEntityChaptersBackfilled(book.id), true);
    assert.match(store.materials.get(book.id, 'entity_chapters').content, /^v\d+$/);
    assert.equal(worldEngine.ensureEntityChaptersBackfilled(book.id), false);
  });

  test('outline 与 continuation 的 runTask 调用传播 AbortSignal', async () => {
    installResponder();
    const abortedSignal = () => {
      const controller = new AbortController();
      controller.abort();
      return controller.signal;
    };
    const expectAborted = promise => assert.rejects(promise, error => {
      assert.equal(error.code, 'ABORTED');
      return true;
    });

    const contractBook = makeBook({ title: '契约中断书' });
    await expectAborted(outlineEngine.generateBookContract(contractBook.id, { idea: '足够长的测试灵感', signal: abortedSignal() }));

    const bookOutlineBook = makeBook({ title: '书纲中断书' });
    await expectAborted(outlineEngine.generateBookOutline(bookOutlineBook.id, {}, { signal: abortedSignal() }));

    const volumeBook = makeBook({ title: '卷纲中断书' });
    const volume = store.volumes.create(volumeBook.id, 1, { title: '第一卷', status: 'planned' });
    await expectAborted(outlineEngine.generateVolumeOutline(volumeBook.id, volume.id, {}, { signal: abortedSignal() }));

    const chapterBook = makeBook({ title: '章纲中断书' });
    const chapterVolume = store.volumes.create(chapterBook.id, 1, { title: '第一卷', status: 'planned' });
    const chapter = store.chapters.create(chapterBook.id, chapterVolume.id, 1, { title: '第一章', status: 'planned' });
    await expectAborted(outlineEngine.generateChapterOutline(chapterBook.id, chapter.id, { signal: abortedSignal() }));
    await expectAborted(outlineEngine.fiveQuestionsCheck(chapterBook.id, chapter.id, { title: '第一章', scenes: [{ beat: '冲突' }] }, { signal: abortedSignal() }));

    const endingBook = makeBook({ title: '完本检查中断书' });
    await expectAborted(continuation.aiEndingCheck(endingBook.id, { signal: abortedSignal() }));

    const nextBook = makeBook({ title: '续卷中断书' });
    const doneVolume = store.volumes.create(nextBook.id, 1, { title: '第一卷', status: 'done' });
    addDoneChapters(nextBook.id, doneVolume.id, 1, { withText: true });
    await expectAborted(continuation.generateNextVolume(nextBook.id, { signal: abortedSignal() }));
  });

  test('续卷补救阶段收到 abort 后立即停止，不吞错继续请求或建卷', async () => {
    const book = makeBook({ title: '补救中断书' });
    const volume = store.volumes.create(book.id, 1, { title: '第一卷', status: 'done' });
    addDoneChapters(book.id, volume.id, 100);
    store.characters.create(book.id, { name: '主角', tier: 'protagonist', state: { 丹田微流: '近干涸' }, abilities: '[]' });
    const town = store.locations.create(book.id, { name: '青阳镇', card: {} });
    const sect = store.locations.create(book.id, { name: '青云宗', card: {} });
    store.locations.update(town.id, { firstChapter: 1 });
    store.locations.update(sect.id, { firstChapter: 2 });

    let requests = 0;
    globalThis.fetch = async (_url, init) => {
      requests += 1;
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return chatResponse(defaultPayload(promptFromRequest(init)));
    };
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      continuation.generateNextVolume(book.id, { signal: controller.signal }),
      error => {
        assert.equal(error.code, 'ABORTED');
        return true;
      },
    );
    assert.equal(requests, 1, '成长补救请求被取消后不得继续世界补救/续卷/卷纲请求');
    assert.equal(store.volumes.list(book.id).length, 1, '取消后不得新建卷');
  });
});
