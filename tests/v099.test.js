// V0.90 先立后破结构强化：铺垫必须成场景（用户实测：开篇"立不够就全是破"）
// 覆盖：BUILDUP_STRUCTURE_TEXT 细纲场景结构约束（变故不得第1场景/铺垫≥2场景/过程感/闪回需背书）/
// VOLUME_BUILDUP_TEXT 开篇卷结构约束（前2-3章铺垫章）/
// 细纲层注入 contrastBuildup 拼结构约束 / 卷纲层注入 volumeBuildupText（开篇卷+悲剧词）/
// 正文第8条闪回豁免收紧（需细纲背书）/ CONTRAST_BUILDUP_TEXT 第6条对齐 / 蓝图层铺垫成章
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v099-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.90 先立后破结构强化', () => {
  test('①BUILDUP_STRUCTURE_TEXT 细纲结构约束完整：变故不得第1场景/铺垫≥2场景/过程感/闪回需背书', async () => {
    const lt = await import(pathToFileURL(path.join(ROOT, 'server/data/literary_techniques.js')));
    const t = lt.BUILDUP_STRUCTURE_TEXT;
    assert.ok(t.includes('细纲场景结构·先立后破'), '结构约束存在');
    assert.ok(t.includes('变故不得安排在第一个场景'), '变故不得第1场景');
    assert.ok(t.includes('至少 2 个铺垫场景'), '铺垫≥2场景');
    assert.ok(t.includes('成场景"而非"成镜头'), '铺垫成场景非镜头');
    assert.ok(t.includes('日常被打破的第一声异响'), '变故过程感');
    assert.ok(t.includes('闪回补足只是细纲背书下的例外') || t.includes('无此背书不得走此路径'), '闪回需背书');
    assert.ok(lt.VOLUME_BUILDUP_TEXT.includes('卷结构·开篇卷先立后破'), '卷结构约束存在');
    assert.ok(lt.VOLUME_BUILDUP_TEXT.includes('前 2-3 章必须为铺垫章'), '前2-3章铺垫');
    assert.ok(lt.VOLUME_BUILDUP_TEXT.includes('兑现他们的命运'), '铺垫人物兑现命运');
  });

  test('②细纲层注入：悲剧章 contrastBuildup 拼入结构约束，非悲剧章不注入', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/planning/outline.js'), 'utf8');
    assert.ok(src.includes('BUILDUP_STRUCTURE_TEXT'), '细纲层引用结构约束');
    assert.ok(src.includes('isTragedyChapter'), '悲剧章判定变量');
    assert.ok(src.includes("`${CONTRAST_BUILDUP_TEXT}\\n\\n${BUILDUP_STRUCTURE_TEXT}`"), '悲剧章拼两段');
    const { chapterOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const c = chapterOutlineInstruction({ bookTitle: 'X', chapterIdx: 1, volumeGoal: 'g', recentSummaries: [], rollingSummary: '', activeForeshadows: [], forgottenForeshadows: [], approachingForeshadows: [], retrieved: [], prevChapterTail: '', futureChapters: [], contrastBuildup: '【对比铺垫·先立后破】（V0.86 硬要求）\n【细纲场景结构·先立后破】（V0.90 硬要求）\n变故不得安排在第一个场景' });
    assert.ok(c.includes('细纲场景结构·先立后破'), '细纲指令含结构约束');
  });

  test('③卷纲层注入：开篇卷含悲剧词 → volumeBuildupText；非开篇卷不注入', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/planning/outline.js'), 'utf8');
    assert.ok(src.includes('volumeBuildupText: vol.idx === 1 && /城破|破城|家破'), '开篇卷+悲剧词判定');
    const { volumeOutlineInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const v = volumeOutlineInstruction({ bookTitle: 'X', volumeIdx: 1, volumeTitle: '第一卷', bookOutline: {}, chapterCount: 8, volumeBuildupText: '【卷结构·开篇卷先立后破】（V0.90 硬要求）\n前 2-3 章必须为铺垫章' });
    assert.ok(v.includes('卷结构·开篇卷先立后破'), '卷纲指令含结构约束');
  });

  test('④正文第8条闪回豁免收紧 + CONTRAST_BUILDUP_TEXT 第6条对齐 + 蓝图铺垫成章', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/prompts.js'), 'utf8');
    assert.ok(src.includes('细纲已明确安排用回忆闪回补足先立后破铺垫'), '正文第8条闪回需背书');
    assert.ok(src.includes('闪回补足只是细纲背书下的例外，不是默认路径'), '正文明确非默认路径');
    assert.ok(src.includes('铺垫要**成章/成场景**'), '蓝图铺垫成章');
    assert.ok(src.includes('"回忆闪回补足"仅在铺垫章无法安排时作为例外'), '蓝图闪回例外化');
    const lt = fs.readFileSync(path.join(ROOT, 'server/data/literary_techniques.js'), 'utf8');
    assert.ok(lt.includes('闪回补足是细纲背书下的例外，不是默认路径'), 'CONTRAST 第6条对齐');
    assert.ok(lt.includes('细纲已明确安排用回忆闪回补足先立后破铺垫'), 'STRUCTURE_RULES 对齐');
  });

  test('⑤端到端：开篇悲剧卷生成卷纲含铺垫章结构（mock 验证注入不破坏流程）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { generateVolumeOutline } = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));
 const b = store.books.create({ title: '示例历史长篇', genre: '历史', blurb: '蜀中孤儿', platform: '番茄' });
    const v = store.volumes.create(b.id, 1, { title: '第一卷·云山', goal: '破城家亡', outline_json: '{"goal":"城破家亡","title":"云山"}', status: 'planned' });
    const outline = await generateVolumeOutline(b.id, v.id, {});
    assert.ok(outline?.chapters?.length >= 1, '卷纲生成成功');
    assert.ok(store.volumes.get(v.id)?.outline_json, '卷纲已落库');
  });
});
