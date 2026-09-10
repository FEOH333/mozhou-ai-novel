// V0.93.4 自动创作新章反馈修复：破折号/段落量化约束注入 L4、套话词表补漏、
// 议论句审校升级（≥2 处 medium 触发自愈）、比喻重复检测、ABORTED 静默退出
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v126-feedback-'));
const ROOT = process.cwd();
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));
const rules = await import(pathToFileURL(path.join(ROOT, 'server/engine/rules.js')));
const packs = await import(pathToFileURL(path.join(ROOT, 'server/data/creative_packs.js')));

describe('V0.93.4 新章反馈修复', () => {
  test('L4 写作指令注入量化红线：破折号≤20、段落≤200、高频套话≤2', () => {
    const text = prompts.writeSceneInstruction({
      bookTitle: 'T', chapterIdx: 1, chapterTitle: 'C',
      scene: { id: 's1', beat: 'b', target_words: 1000 },
      scenesBefore: [], sceneAfter: null, prevTail: '', perspective: 'third',
    });
    assert.match(text, /破折号/, '写作指令应含破折号约束');
    assert.match(text, /20/, '破折号上限数字');
    assert.match(text, /200/, '段落上限数字');
    // V0.95：示例词列表升级为分级红线表述；全量词表经 styleRulesText 注入（v140 锁定全量注入）
    assert.match(text, /高频套话词同词每章不超过 2 次/, '高频套话红线（分级表述）');
  });

  test('写作禁用词表补漏：目光落在/视线落在进 AI_CLICHE_WORDS', () => {
    assert.ok(packs.AI_CLICHE_WORDS.includes('目光落在'), '目光落在应入写作禁用词表');
    assert.ok(packs.AI_CLICHE_WORDS.includes('视线落在'), '视线落在应入写作禁用词表');
  });

  test('议论句审校升级：同章命中≥2处升 medium（触发修订自愈），1处保持 low', () => {
    const one = rules.detectNotButPattern('这不是去打架，而是去送饭。其余都是日常。');
    assert.equal(one.length, 1);
    assert.equal(one[0].severity, 'low', '单处命中保持 low');
    const two = rules.detectNotButPattern('这不是去打架，而是去送饭。那不是恐惧，而是平静。');
    assert.equal(two.length, 2);
    assert.ok(two.every(i => i.severity === 'medium'), '两处命中升 medium');
    const closerTwo = rules.detectCommentaryClosers('这比一句"没事"难写。这比一句"行了"更有用。');
    assert.equal(closerTwo.length, 2);
    assert.ok(closerTwo.every(i => i.severity === 'medium'), '点题句两处命中升 medium');
  });

  test('比喻重复检测：同章≥2处"像…的眼睛/灰钉子"升 medium', () => {
    const one = rules.detectClichéMetaphors('远处火把亮着，像一只没有合上的眼睛。');
    assert.equal(one.length, 0, '单处不报（low 级噪声，不参与判定）');
    const two = rules.detectClichéMetaphors('火把像一只竖直的眼睛。烟像一只竖直的眼睛。');
    assert.ok(two.length >= 1 && two[0].severity === 'medium', '同章两处"像…的眼睛"升 medium');
    const nail = rules.detectClichéMetaphors('灰烟像一根钉在黄土地上的灰钉子。夜烟像一根钉在黄土地上的灰钉子。');
    assert.ok(nail.length >= 1 && nail[0].severity === 'medium', '同章两处"灰钉子"升 medium');
  });

  test('ABORTED 静默退出：不弹 need_human、健康记 aborted 非 error', () => {
    const src = read('server/engine/pilot.js');
    assert.match(src, /ABORTED/, 'pilot 应识别 ABORTED');
    assert.match(src, /'aborted'/, '健康快照用 aborted 状态');
    const abortBranch = src.slice(src.indexOf("e.code === 'ABORTED'"), src.indexOf("e.code === 'ABORTED'") + 400);
    assert.ok(abortBranch.length > 0);
    assert.ok(!abortBranch.includes('need_human'), 'ABORTED 分支不得弹人工提示');
  });
});
