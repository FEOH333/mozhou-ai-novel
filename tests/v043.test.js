// V0.43 第一阶段：文学技巧引擎——技巧库/场景类型/动态文风/转折设计/文学性审校
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
const ROOT = process.cwd();

describe('V0.43 文学技巧引擎', () => {
  test('技巧库：7 类场景、每类 ≥4 技法、均含 how/example', async () => {
    const { TECHNIQUE_LIB, SCENE_TYPE_LABELS } = await import(pathToFileURL(path.join(ROOT, 'server/data/literary_techniques.js')));
    const types = Object.keys(TECHNIQUE_LIB);
    assert.deepEqual(types.sort(), ['climax', 'daily', 'dialogue', 'emotion', 'fight', 'reveal', 'suspense'].sort());
    for (const t of types) {
      assert.ok(TECHNIQUE_LIB[t].length >= 4, `${t} 技法数不足`);
      for (const tech of TECHNIQUE_LIB[t]) {
        assert.ok(tech.name && tech.when && tech.how && tech.example, `${t}.${tech.name} 字段不全`);
      }
      assert.ok(SCENE_TYPE_LABELS[t], `${t} 应有中文标签`);
    }
  });

  test('guessSceneType 场景分类', async () => {
    const { guessSceneType } = await import(pathToFileURL(path.join(ROOT, 'server/data/literary_techniques.js')));
    assert.equal(guessSceneType('林晚一剑斩断铁索'), 'fight');
    assert.equal(guessSceneType('她终于等到他回来，泪如雨下'), 'emotion');
    assert.equal(guessSceneType('深夜发现一封没有署名的信'), 'suspense');
    assert.equal(guessSceneType('当众打脸，全场震惊'), 'climax');
    assert.equal(guessSceneType('主角回到宗门，日常修行'), 'daily');
    assert.equal(guessSceneType('身份揭晓，令牌落地'), 'reveal');
  });

  test('techniqueInjection：注入格式含标签与选用约束', async () => {
    const { techniqueInjection } = await import(pathToFileURL(path.join(ROOT, 'server/data/literary_techniques.js')));
    const t = techniqueInjection('suspense');
    assert.ok(t.includes('【文学技法（悬念推进场景）】'));
    assert.ok(t.includes('不为炫技而用'), '应约束按需选用');
    assert.ok(t.split('\n').length >= 4, '应含多条技法');
  });

  test('buildDynamicStyle：题材×场景×情绪组合', async () => {
    const { buildDynamicStyle } = await import(pathToFileURL(path.join(ROOT, 'server/data/literary_techniques.js')));
    const s1 = buildDynamicStyle({ genre: '玄幻', sceneType: 'fight' });
    assert.ok(s1.includes('玄幻') && s1.includes('短句'), '玄幻打斗笔法');
    const s2 = buildDynamicStyle({ genre: '言情', sceneType: 'emotion', emotion: '甜' });
    assert.ok(s2.includes('言情') && s2.includes('甜'), '言情情感笔法');
    assert.equal(buildDynamicStyle({}), '', '无参数返回空');
  });

  test('写正文指令注入技法+动态文风（mock 冒烟）', async () => {
    const { writeSceneInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const { techniqueInjection, buildDynamicStyle } = await import(pathToFileURL(path.join(ROOT, 'server/data/literary_techniques.js')));
    const inst = writeSceneInstruction({
      bookTitle: 'T', chapterIdx: 1, chapterTitle: 'C',
      scene: { id: 's1', beat: '对决', target_words: 1000 }, scenesBefore: [], prevTail: '',
      techniqueText: techniqueInjection('fight'), dynamicStyle: buildDynamicStyle({ genre: '玄幻', sceneType: 'fight' }),
    });
    assert.ok(inst.includes('【文学技法（打斗对抗场景）】'));
    assert.ok(inst.includes('【动态文风】'));
    // write.js 接线
    const w = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/write.js'), 'utf8');
    assert.ok(w.includes('guessSceneType'), 'write.js 应组装场景类型');
    assert.ok(w.includes('techniqueText'), 'write.js 应传技法');
  });

  test('细纲/卷大纲指令含 scene_type 与转折设计 + 审校文学性检查', async () => {
    const { chapterOutlineInstruction, volumeOutlineInstruction, auditInstruction } = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
    const co = chapterOutlineInstruction({ bookTitle: 'T', chapterIdx: 1 });
    assert.ok(co.includes('scene_type'), '细纲应要求 scene_type');
    assert.ok(co.includes('场景类型需有变化'), '细纲应要求类型变化');
    const vo = volumeOutlineInstruction({ bookTitle: 'T', volumeIdx: 1, volumeTitle: 'V', bookOutline: {}, chapterCount: 8 });
    assert.ok(vo.includes('卷级转折'), '卷大纲应要求转折设计');
    // V0.43 修正：转折按需而非强制（不得出现"必须有/必须设置"式强制措辞）
    assert.ok(vo.includes('按需设计'), '转折应为按需设计而非强制');
    assert.ok(!vo.includes('必须有 1 个'), '不得强制每卷必须有转折');
    assert.ok(!vo.includes('必须有 1 个"卷级转折"'), '不得强制每卷必须有转折');
    assert.ok(vo.includes('倒叙'), '卷大纲应约束倒叙使用');
    const ai = auditInstruction({ bookTitle: 'T', chapterTitle: 'C', chapterText: 'x' });
    assert.ok(ai.includes('文学性硬问题'), '审校应有文学性检查');
    assert.ok(ai.includes('平铺直叙'), '审校应识别平铺直叙');
  });
});
