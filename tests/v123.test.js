// V0.93.1 全面审查清理（2026-08 审查 → P0/P1 技术债收敛）
// 覆盖：题材包复制粘贴去重 / 快感计划 schema 去嵌套 / 完成态单一真源收敛 /
// 死导出清理 / 历史特判去双写 / 重复实现抽取到 util/text.js
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v123-review-cleanup-'));
const ROOT = process.cwd();
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
const packs = await import(pathToFileURL(path.join(ROOT, 'server/data/creative_packs.js')));

/** 取指令文本里第一个 JSON 骨架（自 "请输出 JSON" 标记后的首个 { 起配平） */
function jsonSkeleton(text, marker = '请输出 JSON（不要输出 JSON 以外的任何内容）') {
  const start = text.indexOf(marker);
  if (start === -1) return null;
  const braceStart = text.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(braceStart, i + 1); }
  }
  return null;
}

describe('V0.93.1 全面审查清理', () => {
  test('P0-1 题材包源码无整块复制粘贴：每个题材段恰好一个 name 字段', () => {
    const src = read('server/data/creative_packs.js');
    const body = src.slice(src.indexOf('export const GENRE_PACKS = {'), src.indexOf('export const DEFAULT_GROWTH_SYSTEM'));
    for (const genre of ['玄幻', '仙侠', '都市', '科幻', '悬疑', '言情', '历史']) {
      const start = body.indexOf(`\n  ${genre}: {`);
      assert.notEqual(start, -1, `${genre} 段存在`);
      const rest = body.slice(start + 1);
      const nextMatch = rest.search(/\n  [^\s:]+: \{/);
      const section = body.slice(start, nextMatch === -1 ? body.length : start + 1 + nextMatch);
      const nameLines = section.split('\n').filter(line => /^\s{4}name:/.test(line));
      assert.equal(nameLines.length, 1, `${genre} 段应只有一个 name 字段，实际 ${nameLines.length} 行`);
    }
  });

  test('P0-1 六个题材包结构完整：成长体系与世界版图阶梯齐备', () => {
    const expected = ['name', 'worldview', 'tropes', 'forbidden', 'openings', 'rewardRhythm', 'growthSystem', 'worldScale'];
    for (const genre of ['玄幻', '仙侠', '都市', '科幻', '悬疑', '言情', '历史']) {
      const pack = packs.genrePack(genre);
      assert.ok(pack, `${genre} 题材包存在`);
      assert.deepEqual(Object.keys(pack).sort(), [...expected].sort(), `${genre} 字段集合完整`);
      assert.ok(Array.isArray(pack.growthSystem.ladder) && pack.growthSystem.ladder.length >= 3, `${genre} 成长阶梯`);
      assert.ok(Array.isArray(pack.worldScale.ladder) && pack.worldScale.ladder.length >= 3, `${genre} 版图阶梯`);
    }
    // 去重后值不得漂移（仙侠阶梯抽查）
    assert.deepEqual(packs.genrePack('仙侠').growthSystem.ladder, ['练气', '筑基', '结丹', '元婴', '化神', '大乘', '渡劫']);
    assert.equal(packs.genrePack('都市').worldScale.ladder[0], '小城');
  });

  test('P0-2 快感计划模板 reward_rhythm 只出现一次且 JSON 骨架配平', () => {
    for (const isHistory of [false, true]) {
      const text = prompts.bookPleasurePlanInstruction({ bookTitle: '测试书', genre: isHistory ? '历史' : '玄幻', platform: '番茄' });
      const occurrences = text.split('"reward_rhythm": {').length - 1;
      assert.equal(occurrences, 1, `isHistory=${isHistory} 模板中 "reward_rhythm": { 应只出现一次`);
      const skeleton = jsonSkeleton(text);
      assert.ok(skeleton, `isHistory=${isHistory} 模板应含配平的 JSON 骨架`);
    }
  });

  test('P0-2 写前六问两种分支 JSON 骨架配平且字段邻接合法', () => {
    for (const isHistory of [false, true]) {
      const text = prompts.fiveQuestionsInstruction({ bookTitle: '测试书', chapterIdx: 1, chapterTitle: '第一章', outline: { scenes: [] }, isHistory });
      const skeleton = jsonSkeleton(text);
      assert.ok(skeleton, `isHistory=${isHistory} 六问模板应含配平的 JSON 骨架`);
      if (isHistory) {
        assert.equal(skeleton.split('"reader_value"').length - 1, 1, '历史分支恰好一个 reader_value');
        assert.match(skeleton, /"q6_emotional_change"[^\n]*,\n\s+"reader_value"/, 'q6 与 reader_value 逗号邻接合法');
      } else {
        assert.ok(!skeleton.includes('reader_value'), '非历史分支不注入 reader_value');
        assert.match(skeleton, /"q6_emotional_change"[^\n]*,\n\s+"pass"/, 'q6 与 pass 逗号邻接合法');
      }
    }
  });

  test('P1 完成态判定收敛：五个模块不再裸写 done/settled 终态比较', () => {
    const files = ['server/engine/write.js', 'server/engine/pilot.js', 'server/engine/pipeline.js', 'server/engine/polish.js', 'server/index.js'];
    for (const rel of files) {
      const src = read(rel);
      assert.ok(!/=== ['"]settled['"]/.test(src), `${rel} 不得再裸写 === 'settled' 比较（收敛到 chapter_status）`);
      assert.ok(!/!== ['"]settled['"]/.test(src), `${rel} 不得再裸写 !== 'settled' 比较（收敛到 chapter_status）`);
      assert.ok(!/curStatus === ['"]done['"]/.test(src), `${rel} 不得裸写 curStatus === 'done'`);
      assert.ok(!/r\.status === ['"]done['"]/.test(src), `${rel} 不得裸写 r.status === 'done'`);
    }
  });

  test('P1 生命周期去双写：历史适配器反向依赖通用单源', () => {
    const generic = read('server/engine/longform_lifecycle.js');
    const historical = read('server/engine/historical_longform.js');
 assert.doesNotMatch(generic, /isHistoricalSampleBook|示例历史长篇/,
      '通用生命周期不得反向依赖具体书名特判');
    assert.match(historical, /import\s*\{[^}]*LONGFORM_STAGES[^}]*lifecycleStageIdForPosition[^}]*\}\s*from\s*['"]\.\/longform_lifecycle\.js['"]/s,
      '历史适配器应从通用模块派生阶段 ID 与标签');
 const contentTable = historical.match(/const SAMPLE_VOLUME_DUTIES[\s\S]*?(?=const HISTORICAL_SAMPLE_PHASES)/)?.[0] || '';
 assert.ok(contentTable, '应存在只承载专属卷内任务的 SAMPLE_VOLUME_DUTIES');
    assert.doesNotMatch(contentTable, /\blifecycleStage\s*:|\bstageLabel\s*:/,
      '专用内容表不得存第二套阶段 ID 或标签');
  });

  test('P1 重复实现抽取：lastChapterTail/extractVolumeTitle 只存在于 util/text.js', async () => {
    const textUtil = await import(pathToFileURL(path.join(ROOT, 'server/util/text.js')));
    assert.equal(typeof textUtil.extractVolumeTitle, 'function');
    assert.equal(typeof textUtil.lastChapterTail, 'function');
    for (const rel of ['server/engine/growth.js', 'server/engine/world_expansion.js']) {
      const src = read(rel);
      assert.ok(!/^function (lastChapterTail|extractVolumeTitle)/m.test(src), `${rel} 不得再本地定义 ${rel.includes('growth') ? 'lastChapterTail/extractVolumeTitle' : 'lastChapterTail/extractVolumeTitle'}`);
      assert.match(src, /util\/text\.js/, `${rel} 应导入 util/text.js`);
    }
    assert.equal(textUtil.extractVolumeTitle('第3卷《砺刃山城》', 3), '砺刃山城');
    assert.equal(textUtil.extractVolumeTitle('卷10《四十年》', 10), '四十年');
    assert.equal(textUtil.extractVolumeTitle('无此卷', 2), '');
    const tailSummary = '一路携带的骨殖终于安葬。'.repeat(20);
    assert.equal(
      textUtil.lastChapterTail([{ id: 'c1', idx: 5, title: '归骨' }], id => tailSummary),
      `第5章《归骨》：${tailSummary.slice(0, 120)}`,
    );
    assert.equal(textUtil.lastChapterTail([], () => ''), '');
  });

  test('P1 死导出清理：summarizeInstruction/protagonistFixInstruction 移除，perspectiveText 收敛为唯一视角纪律源', () => {
    assert.ok(!('summarizeInstruction' in prompts), 'summarizeInstruction 已移除');
    assert.ok(!('protagonistFixInstruction' in prompts), 'protagonistFixInstruction 已移除');
    const src = read('server/engine/prompts.js');
    assert.ok(!/export function summarizeInstruction/.test(src));
    assert.ok(!/export function protagonistFixInstruction/.test(src));
    const sig = /export function buildPublicMaterials\(\{([^}]*)\}\)/.exec(src);
    assert.ok(sig && !sig[1].includes('characters'), 'buildPublicMaterials 不再声明死形参 characters');
    // perspectiveText 成为细纲与审校两处视角纪律的唯一实现（内联三元不再重复）
    const calls = (src.match(/perspectiveText\(/g) || []).length;
    assert.ok(calls >= 3, `perspectiveText 应有 1 处定义 + 细纲/审校调用，实际 ${calls} 处`);
    assert.equal((src.match(/【本书叙述视角】/g) || []).length, 1, '审校视角纪律只在 perspectiveText 内定义一次');
  });

  test('P1 视角纪律收敛后：细纲/审校指令内容与既有断言一致', () => {
    const co = prompts.chapterOutlineInstruction({ bookTitle: 'T', chapterIdx: 1, perspective: 'first' });
    assert.ok(co.includes('【叙述视角】') && co.includes('POV 必须全程是主角'), '细纲第一人称 POV 约束保留');
    const ai = prompts.auditInstruction({ bookTitle: 'T', chapterTitle: 'C', chapterText: 'x', perspective: 'first' });
    assert.ok(ai.includes('【本书叙述视角】') && ai.includes('人称视角'), '审校人称检查保留');
  });
});
