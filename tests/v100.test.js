// V0.90 叙事视角专项（贴身第三人称/限知视角——对照资深网文叙事方案落地）
// 覆盖：POV_DISCIPLINE_TEXT（限知/禁全知旁白/切镜头替代/视角切换需场景分隔/80-20/视野扩大）/
// 正文指令 2.5 注入 / 审校 1.8 叙事视角核查（全知跳脑/他不知道的是）/
// rules.js 本地扫描补全知旁白词
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v100-'));
process.env.NOVEL_NO_OPEN = '1';
const ROOT = process.cwd();

describe('V0.90 叙事视角专项', () => {
  test('①POV_DISCIPLINE_TEXT 完整：限知/禁全知旁白/切镜头替代/切换场景分隔/80-20/视野扩大', async () => {
    const lt = await import(pathToFileURL(path.join(ROOT, 'server/data/literary_techniques.js')));
    const t = lt.POV_DISCIPLINE_TEXT;
    assert.ok(t.includes('叙事视角纪律'), '视角纪律存在');
    assert.ok(t.includes('限知视角') && t.includes('读者知道的信息不超过 POV 角色'), '限知核心');
    assert.ok(t.includes('禁全知旁白') && t.includes('他不知道的是'), '禁全知旁白');
    assert.ok(t.includes('直接切镜头') && t.includes('另起段落'), '切镜头替代');
    assert.ok(t.includes('完整章节或明确场景分隔') && t.includes('禁止同一场景内频繁跳脑'), '视角切换纪律');
    assert.ok(t.includes('80%'), '主角占比 80%');
    assert.ok(t.includes('视野随成长扩大'), '视野扩大');
  });

  test('②正文指令注入：第 2.5 条贴身限知视角纪律', async () => {
    const { writeSceneInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const inst = writeSceneInstruction({ bookTitle: 'X', chapterIdx: 1, chapterTitle: 'C', scene: { id: 's1', pov: '陆沉', location: 'L', beat: '逃出火海', target_words: 800, scene_type: 'fight' }, scenesBefore: [], sceneAfter: null, prevTail: '', rollingSummary: '', recentSummaries: [], timelineEvents: [], futureChapters: [], foreshadowsText: '', factsText: '', worldbookText: '', constraints: '', styleRules: '', perspective: 'third' });
    assert.ok(inst.includes('2.5 【叙事视角纪律】'), '正文指令含视角纪律');
    assert.ok(inst.includes('用"他/她/角色名"叙述'), '基础人称约束保留');
  });

  test('③审校 1.8 叙事视角核查：全知跳脑/他不知道的是 → medium 人称视角', async () => {
    const { auditInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const a = auditInstruction({ bookTitle: 'X', chapterTitle: 'C', chapterText: 't', factsText: '', foreshadowsText: '', characterStates: '', contract: '' });
    assert.ok(a.includes('1.8 叙事视角核查'), '1.8 边界存在');
    assert.ok(a.includes('同一场景内视角从当前 POV 跳到其他角色内心'), '全知跳脑检查');
    assert.ok(a.includes('"他不知道的是/他并不知道/然而他不知道/命运的齿轮"类廉价信息揭示句式使用 ≥2 处'), '他不知道的是检查');
    assert.ok(a.includes('用直接切镜头替代'), '切镜头替代指导');
  });

  test('④rules.js 本地扫描：他不知道的是/命运的齿轮 命中，正常文本不命中', async () => {
    const rules = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/rules.js')));
    const hits = rules.detectClichés('他不知道的是，此时千里之外的临安，一场风暴正在酝酿。命运的齿轮缓缓转动。');
    assert.ok(hits.some(h => h.issue.includes('他不知道的是') || h.issue.includes('命运的齿轮')), '全知旁白词命中');
    assert.equal(rules.detectClichés('陆沉把断箭扔进火里，第一次觉得蒙古人也没什么了不起。').length, 0, '正常限知文本不命中');
  });

  test('⑤端到端：mock 写正文（限知纪律注入不破坏流程）', async () => {
    const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
    const { writeScene } = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/write.js')));
 const b = store.books.create({ title: '示例历史长篇', genre: '历史', blurb: 'x', platform: '番茄' });
    const v = store.volumes.create(b.id, 1, { title: 'V1', goal: 'g' });
    const ch = store.chapters.create(b.id, v.id, 1, { title: 'C1', status: 'outlined', outline: { goal: 'g', conflict: 'c', scenes: [{ idx: 1, pov: '陆沉', location: 'L', beat: '逃出火海', target_words: 200, scene_type: 'fight' }] } });
    const sc = store.scenes.create(ch.id, 1, { idx: 1, pov: '陆沉', location: 'L', beat: '逃出火海', target_words: 200, scene_type: 'fight' });
    const r = await writeScene(b.id, ch.id, sc.id, {});
    assert.ok(r.content.length > 0, '正文生成成功');
  });
});
