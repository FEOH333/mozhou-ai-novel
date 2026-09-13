// V0.97.2 《示例历史长篇》十五卷内容阶段与通用生命周期单源
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v115-sample-lifecycle-'));
const ROOT = process.cwd();

const history = await import(pathToFileURL(path.join(ROOT, 'server/engine/longform/historical_longform.js')));
const lifecycle = await import(pathToFileURL(path.join(ROOT, 'server/engine/longform/longform_lifecycle.js')));

const BOOK = {
 title: '示例历史长篇', genre: '历史',
  blurb: '淳祐元年九岁失家，十八年后站上钓鱼城头，四十年让山河不再需要孩子跪求救家。',
};

describe('V0.92 本作生命周期（V0.93.9：15卷——12卷节点+13-15反攻延伸）', () => {
  test('每卷同时具备年代阶段、通用生命周期、不可逆转折、清账职责和支线额度', () => {
    const phases = history.historicalLongformPhases(BOOK);
    assert.equal(phases.length, 15);
    for (const phase of phases) {
      assert.ok(phase.lifecycleStage, `第${phase.idx}卷缺 lifecycleStage`);
      assert.ok(phase.stageTurn, `第${phase.idx}卷缺 stageTurn`);
      assert.ok(Array.isArray(phase.requiredClosures), `第${phase.idx}卷缺 requiredClosures`);
      assert.equal(Number.isInteger(phase.newMajorArcBudget), true, `第${phase.idx}卷缺 newMajorArcBudget`);
    }
    // V0.97.2：历史适配器只给每卷内容，阶段 ID 与通用位置映射逐卷完全一致。
    assert.deepEqual(
      phases.map(phase => phase.lifecycleStage),
      phases.map(phase => lifecycle.lifecycleStageIdForPosition(phase.idx, phases.length)),
    );
    assert.equal(phases[7].newMajorArcBudget, 0, '第8卷起不得再开重大主线');
    assert.equal(phases[11].lifecycleStage, 'late_middle', '卷12是主线汇流与反攻号角，不能提前当终局');
    assert.equal(phases[12].lifecycleStage, 'ending', '卷13开始进入后期收尾');
  });

  test('第15卷（反攻延伸收束）明确兑现核心誓言、最终选择、代价、人物/关系/世界结算和普通孩子闭幕意象', () => {
    const final = history.historicalLongformPhases(BOOK).at(-1);
    assert.equal(final.idx, 15);
    const blueprint = final.endingBlueprint;
    for (const field of [
      'core_promise', 'final_opposition', 'final_choice', 'irreversible_cost', 'protagonist_settlement',
      'relationship_settlements', 'world_settlement', 'historical_settlement', 'closing_image', 'last_chapter_mode',
    ]) assert.ok(blueprint?.[field], `结局蓝图缺 ${field}`);
    assert.match(blueprint.core_promise, /孩子.*求人救|跪/);
    assert.match(blueprint.closing_image, /孩子/);
    assert.match(blueprint.last_chapter_mode, /余波|安顿/);
    assert.match(blueprint.core_promise, /北方.*忌惮|忌惮.*北方/, '反攻完成的承诺含"让北方忌惮"');
  });

  test('阶段文本把生命周期职责和后期收束要求注入卷纲', () => {
    const middleText = history.historicalPhaseText(BOOK, 10);
    assert.match(middleText, /生命周期：中期/);
    const endingText = history.historicalPhaseText(BOOK, 13);
    assert.match(endingText, /生命周期：后期收尾/);
    assert.match(endingText, /新重大主线额度：0/);
    assert.match(endingText, /必须关闭或结算/);
  });
});

