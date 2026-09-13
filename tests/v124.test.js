// V0.93.2 收尾审查：状态机收敛 / 未过闸写路径修复 / 历史书名开关收敛 /
// 名称匹配归 util / 短章与点题议论防线 / 闪回连续性审计
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v124-finish-cleanup-'));
const ROOT = process.cwd();
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const cs = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/chapter_status.js')));
const polish = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/polish.js')));
const rules = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/rules.js')));
const textUtil = await import(pathToFileURL(path.join(ROOT, 'server/util/text.js')));

function freshBook(title, genre = '玄幻') {
  return store.books.create({ title, genre, settings: { lengthProfile: 5000 } });
}

describe('V0.93.2 收尾审查', () => {
  test('状态机：章状态只能经 transitionChapterStatus 写入，非法迁移抛错', () => {
    const book = freshBook('状态机测试');
    const vol = store.volumes.create(book.id, 1, { title: '卷' });
    const ch = store.chapters.create(book.id, vol.id, 1, { title: '章' });
    // 合法：planned → outlined → drafted → done → settled → done
    cs.transitionChapterStatus(book.id, ch.id, 'outlined', { reason: '细纲完成' });
    cs.transitionChapterStatus(book.id, ch.id, 'drafted', { reason: '正文写入' });
    cs.transitionChapterStatus(book.id, ch.id, 'done', { reason: '管线结算' });
    cs.transitionChapterStatus(book.id, ch.id, 'settled', { reason: '结算事务' });
    assert.equal(store.chapters.get(ch.id).status, 'settled');
    // 非法：完成态降级为 drafted（V0.70 保护被状态机硬编码）
    assert.throws(() => cs.transitionChapterStatus(book.id, ch.id, 'drafted', { reason: '测试' }), /迁移被拒/);
    // 非法目标
    assert.throws(() => cs.transitionChapterStatus(book.id, ch.id, 'ghost', { reason: '测试' }), /非法目标状态/);
    // planned 是重置语义：任意来源可回退（失败回退/签约重评）
    cs.transitionChapterStatus(book.id, ch.id, 'planned', { reason: '重置' });
    assert.equal(store.chapters.get(ch.id).status, 'planned');
  });

  test('状态机：所有章状态写入点均收敛（源码无直写残留）', () => {
    const sites = [
      ['server/engine/pipeline/settle.js', /chapters\.update\(chapterId, \{ status/],
      ['server/engine/pipeline/pipeline.js', /chapters\.update\(chapterId, \{ status/],
      ['server/engine/pipeline/write.js', /chapters\.update\(chapterId, \{ wordCount: estimateChineseChars\(fullText\), status/],
      ['server/engine/planning/outline.js', /chapters\.update\(chapterId, \{ outline, status/],
      ['server/engine/recovery/recovery.js', /chapters\.update\(ch\.id, \{ status/],
      ['server/engine/planning/signing.js', /chapters\.update\(ch\.id, \{ status/],
      ['server/engine/pipeline/pilot.js', /chapters\.update\(ch\.id, \{ status/],
      ['server/engine/quality/polish.js', /chapters\.update\(current\.id, \{[\s\S]{0,200}?status:/],
    ];
    for (const [rel, pattern] of sites) {
      const src = read(rel);
      assert.ok(!pattern.test(src), `${rel} 不得再直写章状态`);
    }
  });

  test('场景级门禁写入：完成章改字后废止旧结算并登记同版重建，空文拒绝', () => {
    const book = freshBook('场景门禁测试');
    const vol = store.volumes.create(book.id, 1, { title: '卷' });
    const ch = store.chapters.create(book.id, vol.id, 1, { title: '章' });
    const prose1 = [
 '山道上的石阶被夜露打湿，踩上去一步一滑。主角把背篓往肩上紧了紧，回头去看坡下的灯火。',
      '营寨里的火把在风里晃，像一把把收不拢的扇子。巡哨的梆子响了三声，远远地贴着山壁传过来。',
      '他数着脚下，一步，两步，走到第七级时停住。石缝里长着一丛草，被风压得伏下去，又弹起来。',
      '远处传来骡子的响鼻，有人低声吆喝了一句，随即被夜风吞掉。他听见自己的呼吸，比梆子声更急。',
    ].join('');
    const prose2 = [
      '料道拐过山嘴，视野忽然开阔。江面在月光下发白，像一条晾在夜色里的长布。',
      '陈七蹲在崖边，指了指对岸三处新起的火堆。火堆之间隔着半里地，照见一小片营地轮廓。',
 '主角没有吭声，只把白日记下的水位又默了一遍。涨三寸，退两寸，第三次巡沟时水色发浑。',
      '风从北面压过来，带着江水的腥气。陈七站起身，把弓斜挎在肩上，说，走，回营再说。',
    ].join('');
    store.scenes.create(ch.id, 1, { content: prose1, targetWords: 400, status: 'done' });
    store.scenes.create(ch.id, 2, { content: prose2, targetWords: 400, status: 'done' });
    store.summaries.set(ch.id, book.id, '本章摘要');
    store.chapterSettlements.set(book.id, ch.id, {
      contentHash: createHash('sha256').update(store.chapters.fullText(ch.id)).digest('hex'),
      result: { summary: '本章摘要' },
    });
    cs.transitionChapterStatus(book.id, ch.id, 'done', { reason: '测试准备' });
    const scene = store.scenes.list(ch.id)[0];
    const before = store.chapters.fullText(ch.id);
    const revised = [
 '山道上的石阶被夜露打湿，踩上去一步一滑。主角把背篓往肩上紧了紧，回头去看坡下的灯火，火光在他眼底缩成一小粒。',
      '营寨里的火把在风里晃，像一把把收不拢的扇子。巡哨的梆子响了三声，贴着山壁传过来，第三声落下去时，他数到了石阶第七级。',
      '石缝里长着一丛草，被风压得伏下去，又弹起来。远处传来骡子的响鼻，有人低声吆喝了一句，随即被夜风吞掉。',
 '他想起白日里老兵甲的话：夜路不要抢，一步踩实再迈下一步。他把这话在心里又过了一遍，才继续往上走。',
      '转过山嘴，坡下的灯火忽然近了许多，像有人在夜里把整个营寨往他脚下挪了挪。',
    ].join('');
    const applied = polish.applyValidatedSceneRewrite(book.id, scene.id, revised);
    assert.equal(applied.ok, true, applied.message);
    const after = store.chapters.fullText(ch.id);
    assert.notEqual(after, before);
    // 旧结算/摘要来自旧正文，不能只刷新 hash 后继续冒充同版；必须废止并阻断续写。
    assert.equal(store.chapterSettlements.get(ch.id), undefined);
    assert.equal(store.summaries.get(ch.id), undefined);
    assert.equal(store.narrativeRevisions.blocking(book.id).status, 'stale');
    assert.equal(applied.requiresStateRebuild, true);
    // 空文拒绝
    const empty = polish.applyValidatedSceneRewrite(book.id, scene.id, '   ');
    assert.equal(empty.ok, false);
    assert.equal(empty.code, 'REWRITE_EMPTY');
  });

  test('HTTP 层：手工编辑路由走门禁（PATCH 场景内容走 applyValidatedSceneRewrite；PATCH 章状态受限）', () => {
    const idx = read('server/index.js');
    assert.match(idx, /PATCH', '\/api\/books\/:id\/scenes\/:sid'[\s\S]{0,600}?applyValidatedSceneRewrite/, '场景 PATCH 内容编辑必须过闸');
    assert.match(idx, /章状态只能经正式管线流转/, '章 PATCH 状态写入受限');
    assert.match(idx, /transitionChapterStatus/, 'HTTP 层状态流转走状态机');
  });

  test('smoothTransitions 不再直写场景正文（过闸）', () => {
    const src = read('server/engine/quality/polish.js');
    const fn = src.slice(src.indexOf('export async function smoothTransitions'), src.indexOf('export async function midStoryReview'));
    assert.ok(fn.length > 0, '能定位 smoothTransitions 函数体');
    assert.ok(!/store\.scenes\.update/.test(fn), 'smoothTransitions 不得直写场景');
    assert.match(fn, /applyValidatedSceneRewrite/, 'smoothTransitions 走门禁写入');
  });

  test('点题议论扫描：命中"不是X，而是Y"抽象对比，不误伤普通否定', () => {
    assert.equal(rules.isAbstractContrastText('此次险情不是他的独胆救人，也不是一次漂亮的胜负。').length, 1);
    assert.equal(rules.isAbstractContrastText('这比一句"都没事"难写，也更有用。').length, 0, '无对比结构不算');
    assert.equal(rules.isAbstractContrastText('它不是一个十四岁少年凭嗓门压服十名成年人的功劳，而是众人共同换来的。').length, 1);
    assert.equal(rules.isAbstractContrastText('责任本就不是挂在身上的牌子；出了错，先让更可靠的人接手。').length, 0, '无而是配对不算');
    assert.equal(rules.isAbstractContrastText('他不是去打架的，只是去送饭。').length, 0, '日常否定不误伤');
    assert.equal(rules.isAbstractContrastText('不是他打的我，是我哥。').length, 0);
  });

  test('元话语检测：叠词"一卷一卷"不误报"卷一"，真卷号仍拦截', () => {
    assert.equal(rules.detectMetaWords('火舌舔过柴心的纹路，一卷一卷的，卷到最深处就黑下去。').length, 0, '叠词不是卷号');
    const hit = rules.detectMetaWords('正文开头写着卷一，这是元话语。');
    assert.ok(hit.length >= 1 && hit[0].issue.includes('卷一'), '真卷号元话语仍报');
  });

  test('短章下限：checkChapterLength 按 lengthProfile 定地板并返回可读诊断（V0.94 地板 0.4→0.75）', () => {
    const ok = rules.checkChapterLength('长'.repeat(4000), { lengthProfile: 5000 });
    assert.equal(ok.belowFloor, false);
    const short = rules.checkChapterLength('短'.repeat(1500), { lengthProfile: 5000 });
    assert.equal(short.belowFloor, true);
    assert.equal(short.floorChars, 3750, 'V0.94：地板为 profile 的 75%（防平台短章）');
    const noProfile = rules.checkChapterLength('短'.repeat(800), {});
    assert.equal(noProfile.belowFloor, true, '无 profile 用默认 3000 地板');
  });

  test('短章防线接线：pipeline 结算后确定性检查并记债', () => {
    const src = read('server/engine/pipeline/pipeline.js');
    assert.match(src, /checkChapterLength/, 'pipeline 应接入短章检查');
  });

  test('历史题材开关收敛：书名正则单一定义且仅用于题材锚定', () => {
    const hl = read('server/engine/longform/historical_longform.js');
 const matches = (hl.match(/\/示例历史长篇\//g) || []).length;
    assert.ok(matches <= 1, '书名正则只在一处定义');
    const lg = read('server/engine/longform/longform_lifecycle.js');
 assert.ok(!/\/示例历史长篇\//.test(lg), 'longform_lifecycle 不复制书名正则');
  });

  test('名称匹配归 util/text.js：namesMatch/hookDescriptionsMatch 单一实现且语义不变', () => {
    assert.equal(typeof textUtil.namesMatch, 'function');
    assert.equal(typeof textUtil.hookDescriptionsMatch, 'function');
    assert.equal(textUtil.namesMatch('山河守护主线', '山河守护主线'), true);
    assert.equal(textUtil.namesMatch('余玠师徒传承线', '余玠师徒传承'), true, '≥6字包含关系');
    assert.equal(textUtil.namesMatch('阿蛮', '阿朱'), false);
    assert.equal(textUtil.hookDescriptionsMatch('识破工地细作并记入工册', '工地细作被识破并记录在册'), true, 'n-gram 语义指纹');
    assert.equal(textUtil.hookDescriptionsMatch('A', 'B'), false);
    const lg = read('server/engine/longform/longform_lifecycle.js');
    assert.ok(!/^function namesMatch/m.test(lg), 'longform_lifecycle 不本地定义 namesMatch');
  });

  test('闪回连续性审计：auditInstruction 注入插叙/闪回核查边界（写审同源）', async () => {
    const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const text = prompts.auditInstruction({ bookTitle: 'T', chapterTitle: 'C', chapterText: 'x', perspective: 'third' });
    assert.match(text, /闪回|插叙/, '审校应核查闪回与前文一致性');
  });
});
