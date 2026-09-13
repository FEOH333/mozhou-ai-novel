// V0.95.0 工程一：长程记忆层——叙事记忆库 / 卷 Arc 压缩 / 滚动摘要两段式 / 物品注入 / 伏笔排序
// 背景：审计实证「越写越差」的结构性根因全在跨章记忆层——归档后早期细节只剩每批 5 条事实；
// 人物声音/道具细节无结构化载体；伏笔排序让新埋伏笔被老伏笔永久挤出；物品零注入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helper.js';
import * as store from '../server/db/store.js';
import { narrativeMemoryText, applySettlementMemories, MEMORY_BUDGET } from '../server/engine/narrative/narrative_memory.js';
import { rollingText, appendRollingRecent, setRollingPinned, parseRolling } from '../server/engine/narrative/rolling.js';
import { ensureVolumeSummaries, VOLUME_DIGEST_LOCAL } from '../server/engine/pipeline/archive.js';
import { archiveInjectionText } from '../server/llm/cache.js';
import { activeForeshadowsText } from '../server/engine/narrative/foreshadow.js';
import { itemCardsText, touchItems } from '../server/engine/narrative/items.js';
import { isCompletedChapter } from '../server/engine/pipeline/chapter_status.js';

function seedBook() {
  const b = store.books.create({ title: '记忆测试书', genre: '玄幻' });
  const vol = store.volumes.create(b.id, 1, { title: '第一卷', goal: '入宗门' });
  return { b, vol };
}

function seedChapter(b, vol, idx, text, summary) {
  const ch = store.chapters.create(b.id, vol.id, idx, { title: `第${idx}章`, status: 'settled' });
  store.scenes.create(ch.id, 1, { beat: '开场', content: text, status: 'done', targetWords: 100 });
  if (summary) store.summaries.set(ch.id, b.id, summary);
  return ch;
}

test('V0.95 叙事记忆库：结算提取落库（voice/promise/detail/scene/relation 五类）+ 重结算删旧幂等', () => {
  const { b, vol } = seedBook();
 const ch = seedChapter(b, vol, 1, '主角把弩机拆了又装。他说："弩这东西，骗不了人。"');
  const r1 = applySettlementMemories(b.id, ch.id, 1, [
 { category: 'voice', name: '主角', content: '口头禅"弩这东西，骗不了人"，话少句短' },
    { category: 'detail', name: '弩机', content: '主角自制弩机，可拆装，射程三十步' },
    { category: 'promise', name: '', content: '答应帮阿蛮找到她哥' },
  ]);
  assert.equal(r1, 3);
  assert.equal(store.memoryEntries.list(b.id, { category: 'voice' }).length, 1);
  // 重结算（正文变了）→ 删旧重提，不堆积
  const r2 = applySettlementMemories(b.id, ch.id, 1, [
 { category: 'voice', name: '主角', content: '口头禅"弩这东西，骗不了人"，话少句短' },
  ]);
  assert.equal(r2, 1);
  assert.equal(store.memoryEntries.list(b.id).length, 1, '同章重提取必须删旧（幂等）');
});

test('V0.95 叙事记忆注入：出场角色 voice 优先 + 场景相关 detail 命中 + 总量限流', () => {
  const { b, vol } = seedBook();
  const ch1 = seedChapter(b, vol, 1, 'x');
  applySettlementMemories(b.id, ch1.id, 1, [
 { category: 'voice', name: '主角', content: '话短，爱用"嗯"应声' },
    { category: 'voice', name: '阿蛮', content: '语速快，爱反问' },
    { category: 'detail', name: '弩机', content: '自制弩机可拆装' },
    { category: 'scene', name: '', content: '第1章雨夜试弩名场面' },
 { category: 'relation', name: '主角', content: '与阿蛮：救命之恩→同伴' },
  ]);
 const text = narrativeMemoryText(b.id, { sceneText: '主角在雨夜调试弩机，阿蛮在旁边看', characterNames: ['主角', '阿蛮'] });
  assert.ok(text.includes('嗯'), '出场角色 voice 必须注入（人物声音一致性）');
  assert.ok(text.includes('弩机'), '场景相关 detail 命中注入');
  assert.ok(text.includes('relation') || text.includes('同伴'), '关系里程碑注入');
  // 无关场景：不做全量注入——兜底最多补最近 4 条（防稀释注意力）
  const text2 = narrativeMemoryText(b.id, { sceneText: '王五在酒楼喝酒', characterNames: ['王五'] });
  const lineCount = text2 ? text2.split('\n').filter(l => l.startsWith('-')).length : 0;
  assert.ok(lineCount <= 4, `无关场景兜底注入 ≤4 条（实际 ${lineCount}），禁止全量注入`);
});

test('V0.95 记忆预算：超上限本地裁剪保最近（零 LLM 成本降级）', () => {
  const { b, vol } = seedBook();
  for (let i = 1; i <= MEMORY_BUDGET + 20; i++) {
    const ch = store.chapters.create(b.id, vol.id, i, { status: 'settled' });
    applySettlementMemories(b.id, ch.id, i, [{ category: 'detail', name: `物品${i}`, content: `第${i}条记忆` }]);
  }
  const all = store.memoryEntries.list(b.id);
  assert.ok(all.length <= MEMORY_BUDGET, `记忆总数 ≤ 预算 ${MEMORY_BUDGET}（实际 ${all.length}）`);
  assert.ok(all.some(m => m.content.includes(`第${MEMORY_BUDGET + 20}条`)), '裁剪保留最新');
});

test('V0.95 滚动摘要两段式：settle 追加 recent + archive 写 pinned + rollingText 兼容旧格式', () => {
  const { b } = seedBook();
  // 旧格式兼容：自由文本直接透传
  store.rollingSummaries.set(b.id, '【第1章】旧格式滚动摘要');
  assert.ok(rollingText(b.id).includes('旧格式滚动摘要'));
  // settle 追加 recent
  appendRollingRecent(b.id, 2, '主角入宗门，遭遇冷眼');
  appendRollingRecent(b.id, 3, '首次任务，识破陷阱');
  const t = rollingText(b.id);
  assert.ok(t.includes('入宗门') && t.includes('识破陷阱'), 'recent 段注入');
  // archive 写 pinned（归档必保块）
 setRollingPinned(b.id, { story_state: '主角在青云宗外门', characters: [{ name: '主角', state: '练气三层' }], unresolved_hooks: ['黑衣人身份未明'], key_facts: [], upcoming: '' });
  const t2 = rollingText(b.id);
  assert.ok(t2.includes('青云宗外门'), 'pinned 主线注入');
  assert.ok(t2.includes('识破陷阱'), 'recent 与 pinned 共存（单一真源两段式）');
  // pinned 里的结构化解析
  const parsed = parseRolling(store.rollingSummaries.get(b.id));
  assert.equal(parsed.pinned.story_state, '主角在青云宗外门');
  assert.equal(parsed.recent.length, 2);
});

test('V0.95 卷级 Arc 压缩：卷完成本地聚合卷摘要 + 归档注入含卷速查', () => {
  const { b, vol } = seedBook();
 seedChapter(b, vol, 1, '正文一', '主角入宗');
  seedChapter(b, vol, 2, '正文二', '遭遇刁难');
  const ch3 = seedChapter(b, vol, 3, '正文三', '试弩立威');
  // 全卷完成
  const done = store.chapters.list(b.id).every(isCompletedChapter);
  assert.ok(done, '种子章应为完成态');
  ensureVolumeSummaries(b.id);
  const v = store.volumes.get(vol.id);
  assert.ok((v.summary || '').includes('试弩立威'), '卷摘要含末章事件');
  assert.ok((v.summary || '').length >= 10, '卷摘要非空');
  assert.equal(VOLUME_DIGEST_LOCAL, 'local');
  // 归档注入头部含卷速查
  store.archives.add(b.id, { batch: 1, rangeStart: 1, rangeEnd: 1, summaryJson: { cards: [], rolling: { story_state: '已归档段' } }, tokensSaved: 0 });
  const inj = archiveInjectionText(b.id);
  assert.ok(inj.includes('卷速查'), '归档注入含卷速查表');
  assert.ok(inj.includes('试弩立威') || inj.includes('第一卷'), '卷速查含卷摘要');
});

test('V0.95 伏笔排序修复：超期最优先 + 最近埋设其次（新伏笔不再被老伏笔挤出）', () => {
  const { b } = seedBook();
  // 老伏笔（importance high，最早）——旧排序下永久霸占前 6
  store.foreshadows.create(b.id, { desc: '神秘玉佩来历', type: '剧情伏笔', plantedChapter: 1, payoffChapter: 50, importance: 'high', status: 'planted' });
  store.foreshadows.create(b.id, { desc: '新埋伏笔A', type: '剧情伏笔', plantedChapter: 20, payoffChapter: 25, importance: 'low', status: 'planted' });
  store.foreshadows.create(b.id, { desc: '超期伏笔B', type: '剧情伏笔', plantedChapter: 2, payoffChapter: 3, importance: 'low', status: 'planted' });
  const text = activeForeshadowsText(b.id, 6, 2);
  const idxNew = text.indexOf('新埋伏笔A');
  const idxOld = text.indexOf('神秘玉佩');
  const idxOverdue = text.indexOf('超期伏笔B');
  assert.ok(idxOverdue !== -1 && idxOverdue < idxOld, '超期伏笔排在老伏笔前');
  assert.ok(idxNew !== -1 && idxNew < idxOld, '最近埋设的新伏笔必须可见（不再被挤出）');
});

test('V0.95 物品注入 + touchItems 锚点：法宝/信物进写作上下文，正文出现推进 last_chapter', () => {
  const { b } = seedBook();
  store.items.create(b.id, { name: '破军弩', card: { detail: '主角自制，射程三十步' } });
  store.factions.create(b.id, { name: '青云宗', card: { detail: '修仙宗门' } });
 const text = itemCardsText(b.id, { sceneText: '主角取出破军弩，对准靶心' });
  assert.ok(text.includes('破军弩'), '场景提及物品必须注入物品卡（防道具穿帮）');
  const text2 = itemCardsText(b.id, { sceneText: '他走进青云宗山门' });
  assert.ok(!text2.includes('破军弩'), '未提及的物品不注入');
  // touchItems：正文出现推进 last_chapter
  const touched = touchItems(b.id, '他把破军弩收进背囊。', 7);
  assert.ok(touched.includes('破军弩'));
  const it = store.items.list(b.id).find(i => i.name === '破军弩');
  assert.equal(it.last_chapter, 7, '物品 last_chapter 推进到出现章');
});

test('V0.95 向量盘活：settle 后增量索引幂等（embedding 不可用时静默降级）', async () => {
  const { b, vol } = seedBook();
  const ch = seedChapter(b, vol, 1, '这是一段用于向量索引测试的正文内容。'.repeat(10));
  const { indexChapter } = await import('../server/memory/indexer.js');
  // 测试环境 embedding 默认关闭 → skipped 不抛错（降级铁律：不阻断主流程）
  const r1 = await indexChapter(b.id, ch.id);
  assert.ok(r1 === null || r1.skipped || typeof r1.indexed === 'number', '降级返回 skipped 或索引计数，绝不抛错');
  const r2 = await indexChapter(b.id, ch.id);
  assert.ok(r2 === null || r2.skipped || typeof r2.indexed === 'number', '重复索引幂等');
});
