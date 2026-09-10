// V0.86 创作质量与重写机制专项
// 覆盖：coverage 截断重试 / 覆盖判定放宽 / 收敛保护记债放行 / 对比铺垫·先立后破技法 /
// 事件≠暴力冲突 / 写作变通性 / rewriteChapterRange 章节重写
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v094-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.86 创作质量与重写机制', () => {
  test('①coverage 路由 maxTokens 提升 + 截断自动重试', async () => {
    const { DEFAULT_ROUTES } = await import(pathToFileURL(path.join(ROOT, 'server/config.js')));
    assert.ok(DEFAULT_ROUTES.coverage.maxTokens >= 6000, 'coverage maxTokens 提到 6000');
    const auditSrc = fs.readFileSync(path.join(ROOT, 'server/engine/audit.js'), 'utf8');
    assert.ok(auditSrc.includes("if (res.finishReason === 'length')"), '覆盖截断检测');
    assert.ok(auditSrc.includes('覆盖校验截断重试'), '截断重试记录');
  });

  test('②覆盖判定放宽：原句复刻/同义改写算覆盖；收敛保护记债放行', async () => {
    const { coverageInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const c = coverageInstruction({ bookTitle: 'X', chapterTitle: 'C', checkpoints: ['结尾出现"那面旗卷着烟火消失在尽头"'], chapterText: '正文' });
    assert.ok(c.includes('同义改写、意象等价、标点/用词差异均视为已覆盖'), '覆盖判定放宽原句类要点');
    assert.ok(c.includes('不必逐字复刻细纲'), '不要求逐字复刻');
    const pipeSrc = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline.js'), 'utf8');
    assert.ok(pipeSrc.includes('已记债放行'), '收敛保护记债放行');
    assert.ok(pipeSrc.includes('store.conflicts.create'), '遗漏要点记 conflicts');
    // 细纲 checkpoints 纪律：禁止强制原句
    const chOutline = fs.readFileSync(path.join(ROOT, 'server/engine/prompts.js'), 'utf8');
    assert.ok(chOutline.includes('禁止写"必须出现某原句/逐字复刻"类要点'), '细纲 checkpoints 纪律');
  });

  test('③对比铺垫·先立后破：千家灯火+羁绊人物入库 + 悲剧场景/细纲注入', async () => {
    const lt = await import(pathToFileURL(path.join(ROOT, 'server/data/literary_techniques.js')));
    assert.ok(lt.CONTRAST_BUILDUP_TEXT.includes('先立后破'), '对比铺垫纪律存在');
    assert.ok(lt.CONTRAST_BUILDUP_TEXT.includes('千家灯火'), '铺垫尺度=一座城千家灯火');
    assert.ok(lt.CONTRAST_BUILDUP_TEXT.includes('玩伴') && lt.CONTRAST_BUILDUP_TEXT.includes('大叔'), '羁绊人物（玩伴/大叔）');
    assert.ok(lt.CONTRAST_BUILDUP_TEXT.includes('兑现他们的命运'), '悲剧兑现人物命运');
    assert.ok(lt.CONTRAST_BUILDUP_TEXT.includes('让读者麻木而不是心疼'), '刀法核心：无铺垫的连续苦难会麻木');
    assert.ok(lt.TECHNIQUE_LIB.daily.some(t => t.name === '对比铺垫'), 'daily 技法含对比铺垫');
    // 场景笔法也补了先立后破
    const src = fs.readFileSync(path.join(ROOT, 'server/data/literary_techniques.js'), 'utf8');
    assert.ok(src.includes('重大悲剧前先立后破'), 'emotion 笔法含先立后破');
    const { writeSceneInstruction, chapterOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    // 城破/死亡类场景注入对比铺垫
    const loss = writeSceneInstruction({ bookTitle: 'X', chapterIdx: 1, chapterTitle: 'C', scene: { id: 's1', pov: 'A', location: 'L', beat: '城破之夜，蒙军屠城，父母惨死', target_words: 1000, scene_type: 'emotion' }, scenesBefore: [], sceneAfter: null, prevTail: '', rollingSummary: '', recentSummaries: [], timelineEvents: [], futureChapters: [], foreshadowsText: '', factsText: '', worldbookText: '', constraints: '', styleRules: '', sceneType: 'emotion', goal: '家破人亡', conflict: '蒙军破城' });
    assert.ok(loss.includes('对比铺垫·先立后破'), '重大悲剧场景注入对比铺垫');
    assert.match(loss, /已经具体建立的人、关系与生活/, '悲剧场景应承接本书已经建立的珍惜对象');
    assert.match(loss, /不另造一套通用温情意象/, '悲剧场景明确禁止用统一温情模板补铺垫');
    // 日常非悲剧场景不注入
    const daily = writeSceneInstruction({ bookTitle: 'X', chapterIdx: 1, chapterTitle: 'C', scene: { id: 's1', pov: 'A', location: 'L', beat: '市集买菜，讨价还价', target_words: 1000, scene_type: 'daily' }, scenesBefore: [], sceneAfter: null, prevTail: '', rollingSummary: '', recentSummaries: [], timelineEvents: [], futureChapters: [], foreshadowsText: '', factsText: '', worldbookText: '', constraints: '', styleRules: '', sceneType: 'daily', goal: '日常', conflict: '无' });
    assert.ok(!daily.includes('对比铺垫·先立后破'), '日常场景不注入');
    // 细纲层：悲剧章注入先立后破（场景安排先铺温情再变故）
    const cOutline = chapterOutlineInstruction({ bookTitle: 'X', chapterIdx: 3, volumeGoal: '城破守城', recentSummaries: [], rollingSummary: '', activeForeshadows: [], forgottenForeshadows: [], approachingForeshadows: [], retrieved: [], prevChapterTail: '', futureChapters: [], contrastBuildup: lt.CONTRAST_BUILDUP_TEXT });
    assert.ok(cOutline.includes('千家灯火'), '悲剧章细纲注入先立后破');
  });

  test('④事件≠暴力冲突：开篇蓝图定义扩展 + 先立后破指引', async () => {
    const { openingBlueprintInstruction, buildSystemPrompt } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const hist = openingBlueprintInstruction({ bookTitle: 'X', genre: '历史', platform: '番茄', contract: '', bookOutline: '', pleasurePlan: '', chapterCount: 20, isHistory: true });
    assert.ok(hist.includes('事件≠暴力冲突') || hist.includes('不必一上来就屠杀'), '事件定义扩展');
    assert.ok(hist.includes('开篇先立后破'), '开篇先立后破指引');
    assert.ok(hist.includes('千家灯火'), '开篇铺垫尺度=千家灯火');
    assert.ok(hist.includes('玩伴'), '开篇铺垫重要羁绊人物');
    assert.ok(hist.includes('兑现他们的命运'), '悲剧兑现人物命运');
    // 非历史但悲剧题材也触发先立后破
    const tragic = openingBlueprintInstruction({ bookTitle: 'X', genre: '玄幻', platform: '番茄', contract: '', bookOutline: '悲剧复仇流，主角灭门之仇', pleasurePlan: '', chapterCount: 20, isHistory: false });
    assert.ok(tragic.includes('开篇先立后破'), '非历史悲剧题材也触发先立后破');
    // 写作变通性铁律
    const sys = buildSystemPrompt({ title: 'X', genre: '历史', blurb: 'b', platform: '番茄', perspective: 'third' });
    assert.ok(sys.includes('叙事变通优先'), '写作变通性铁律');
    assert.ok(sys.includes('读者体验优先'), '读者体验优先');
  });

  test('⑤rewriteChapterRange 章节重写：快照+清场景/摘要/结算+facts superseded', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { rewriteChapterRange } = await import(pathToFileURL(path.join(ROOT, 'server/engine/signing.js')));
    const b = store.books.create({ title: '重写书', genre: '玄幻', blurb: 'x' });
    store.materials.set(b.id, 'world', 'w');
    const v = store.volumes.create(b.id, 1, { title: 'V1' });
    const ch1 = store.chapters.create(b.id, v.id, 1, { title: '第一章', status: 'done', word_count: 3000 });
    const ch2 = store.chapters.create(b.id, v.id, 2, { title: '第二章', status: 'done', word_count: 2000 });
    store.scenes.create(ch1.id, 1, { content: '正文一', status: 'done' });
    store.summaries.set(ch1.id, b.id, '摘要一');
    store.chapterSettlements.set(b.id, ch1.id, { contentHash: 'h', result: {} });
    store.facts.create(b.id, { subject: '甲', predicate: '位于', object: '乙', sourceChapter: 1 });
    // 中间章不能单独清空后留下已完成下游章；必须把完成尾部一起纳入。
    const unsafe = rewriteChapterRange(b.id, { fromIdx: 1, toIdx: 1, label: '测试重写' });
    assert.equal(unsafe.ok, false);
    assert.equal(unsafe.code, 'REWRITE_DOWNSTREAM_COMPLETED');
    assert.equal(store.scenes.list(ch1.id).length, 1, '失败关闭不得先清正文');
    const r = rewriteChapterRange(b.id, { fromIdx: 1, toIdx: 2, label: '测试重写' });
    assert.ok(r.ok, '重写执行');
    assert.equal(store.chapters.get(ch1.id).status, 'planned', '打回 planned');
    assert.equal(store.chapters.get(ch1.id).word_count, 0, '字数清零');
    assert.equal(store.scenes.list(ch1.id).length, 0, '场景清空');
    assert.equal(store.summaries.get(ch1.id), undefined, '摘要清除');
    assert.equal(store.chapterSettlements.get(ch1.id), undefined, '结算清除');
    const stale = store.narrativeRevisions.blocking(b.id);
    assert.equal(stale?.status, 'stale', '完成章打回重写后必须暂停自动创作等待同版重建');
    assert.deepEqual(stale?.manifest?.changed_chapters, [1, 2]);
    const facts = store.facts.list(b.id, { status: 'active' });
    assert.ok(!facts.some(f => f.subject === '甲'), '范围内 facts 标 superseded');
    const snaps = store.snapshots.list(b.id);
    assert.ok(snaps.some(s => s.label.includes('测试重写前')), '快照已存');
    // 已经清空的尾部章可重复指定，不会制造正文洞。
    const r2 = rewriteChapterRange(b.id, { fromIdx: 2, toIdx: 2 });
    assert.ok(r2.ok, '中间章可重写');
  });

  test('⑥重写端点 + 前端按钮接线', async () => {
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(idx.includes("route('POST', '/api/books/:id/chapters/:cid/rewrite'"), '重写端点存在');
    assert.ok(idx.includes('rewriteChapterRange'), '端点用 rewriteChapterRange');
    const ws = fs.readFileSync(path.join(ROOT, 'web/js/views/workshop.js'), 'utf8');
    assert.ok(ws.includes('重写本章'), '前端重写按钮');
    assert.ok(ws.includes('/rewrite'), '前端调用重写端点');
  });
});
