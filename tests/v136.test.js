// tests/v136.test.js —— V0.94.0 根因修复（一）：本地防线扩展
// 依据 2026-08-16 示例历史长篇 26 章三卷精读：
// 议论变体/动作母题/弱钩章末/章名脱节/跨章比喻复读/时间线锚点矛盾/场景尾部重演
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../server/engine/rules.js';
import { safelyMergeContinuation, enforceSceneDashBudget } from '../server/engine/write.js';

describe('V0.94 detectNotButPattern 变体与对话豁免', () => {
  test('「不是X，是Y」（无而/却）叙事句计入', () => {
    const issues = rules.detectNotButPattern('墙不是先垒起来的，是先弄清人、水和路。');
    assert.ok(issues.length >= 1, '无而/却变体应命中');
  });

  test('「不是X，更像Y」变体计入', () => {
    const issues = rules.detectNotButPattern('那不是恐惧，更像一根刺卡在喉咙里。');
    assert.ok(issues.length >= 1);
  });

  test('引号内对白豁免（口语否定允许）', () => {
    const issues = rules.detectNotButPattern('陈七说："不是石滑，是我让它滑的。"他说完就走了。');
    assert.equal(issues.length, 0, '对白中的口语否定不应计入');
  });

  test('同章 ≥2 处仍升 medium（既有 v126 行为保持）', () => {
    const two = rules.detectNotButPattern('这不是去打架，而是去送饭。那不是恐惧，而是平静。');
    assert.ok(two.length >= 2 && two.every(i => i.severity === 'medium'));
  });
});

describe('V0.94 detectCommentaryClosers 收束议论扩展', () => {
  test('「…，才是…的（部分/根基/答案）」式总结句计入', () => {
    const issues = rules.detectCommentaryClosers('号子、木杠、后绳，才是那道墙真正看不见的部分。');
    assert.ok(issues.length >= 1, '才是式总结应命中');
  });

  test('既有「这比一句…」模式保持', () => {
    const two = rules.detectCommentaryClosers('这比一句"没事"难写。这比一句"行了"更有用。');
    assert.ok(two.length >= 2 && two.every(i => i.severity === 'medium'));
  });
});

describe('V0.94 detectMotifRepetition 动作母题配额', () => {
  test('同章同母题 ≥4 次报 medium', () => {
    const text = Array.from({ length: 4 }, (_, i) => `第${i + 1}次，他的指节按在封皮上。`).join('');
    const issues = rules.detectMotifRepetition(text);
    assert.ok(issues.some(i => i.severity === 'medium' && i.issue.includes('指节')));
  });

  test('2 次以内不报（正常修辞）', () => {
    const issues = rules.detectMotifRepetition('他的指节发白。她喉结滚了一下。');
    assert.equal(issues.length, 0);
  });
});

describe('V0.94 detectWeakEnding 章末零钩收束', () => {
  test('末段静态比喻收束（无对白无悬念词）报 medium', () => {
    const text = '他忙完了一天。远处灯火在风里一明一灭，像一只只没有合上的眼睛。';
    const issues = rules.detectWeakEnding(text);
    assert.ok(issues.length === 1 && issues[0].severity === 'medium');
  });

  test('末段含对白/威胁/疑问不报', () => {
    const ok1 = rules.detectWeakEnding('陈七低声道："明早随我去北坡。"\n他应了一声。');
    assert.equal(ok1.length, 0);
    const ok2 = rules.detectWeakEnding('雨里踩出来的印子，不止他们的。\n他把这句话记在心里。');
    assert.equal(ok2.length, 0, '含具体威胁意象的收束不算零钩');
  });
});

describe('V0.94 detectTitleGap 章名兑现度', () => {
  test('章名核心词正文零出现报 low 提示（意象型章名可忽略，不入债）', () => {
    const text = '他随着队伍上了山，一路辨认草尖倒向与蹄印深浅。'.repeat(3);
    const issues = rules.detectTitleGap('伍字军旗', text);
    assert.ok(issues.length === 1 && issues[0].severity === 'low');
  });

  test('章名核心词正文出现不报', () => {
    const text = '药香混着热粥的白气漫出伙房。'.repeat(3);
    assert.equal(rules.detectTitleGap('药香沁甲', text).length, 0);
  });

  test('两字短章名不误报', () => {
    assert.equal(rules.detectTitleGap('北望', '他望向北方，山脊沉在夜色里。').length, 0);
  });
});

describe('V0.94 detectCrossChapterMetaphors 跨章比喻复读', () => {
  const prev = [{ idx: 1, text: '山脊黑沉沉的，像一头睡着的东西。他继续走。' }];

  test('跨章同比喻短语（≥6 归一字）报 medium', () => {
    const issues = rules.detectCrossChapterMetaphors('远处的山脊像一头睡着的东西，一动不动。', prev);
    assert.ok(issues.length === 1 && issues[0].severity === 'medium');
  });

  test('不同比喻不报', () => {
    const issues = rules.detectCrossChapterMetaphors('远处的山脊像一道压平的墨线，一动不动。', prev);
    assert.equal(issues.length, 0);
  });
});

describe('V0.94 detectTimelineAnchorConflict 接续时间锚点矛盾', () => {
  test('「禁足第三日」+ 跨年 → high 时间线冲突', () => {
    const issues = rules.detectTimelineAnchorConflict({
      headText: '淳祐十一年，春。禁足第三日，晨光刚亮。',
      year: 1251,
      prevYear: 1250,
    });
    assert.ok(issues.length === 1 && issues[0].severity === 'high' && issues[0].type === '时间线冲突');
  });

  test('同年接续不报', () => {
    const issues = rules.detectTimelineAnchorConflict({
      headText: '淳祐十年，春。禁足第三日，晨光刚亮。',
      year: 1250,
      prevYear: 1250,
    });
    assert.equal(issues.length, 0);
  });

  test('跨年但无接续标记不报（正常跨年章）', () => {
    const issues = rules.detectTimelineAnchorConflict({
      headText: '淳祐十一年，春。新年的第一场雨落在城头。',
      year: 1251,
      prevYear: 1250,
    });
    assert.equal(issues.length, 0);
  });
});

describe('V0.94 detectSceneTailDuplication 场景尾部重演（双版本残留）', () => {
  test('场景1尾部复述场景2事件 → high', () => {
    const scenes = [
      { idx: 1, content: ('他伏在土坎后数呼吸，一下，两下。风把灰烟的焦味送过来，他压低身子，又数了一遍。'.repeat(10)) + '\n回到营门时天边泛出一线冷白，他把夜里的事从头到尾说了一遍，陈七听完挥挥手让他回去。' },
      { idx: 2, content: '陈七提灯等在营门。他把夜里的事从头到尾说了一遍。陈七听完，让军士把何平带下去，又吩咐秦月来给他裹伤。'.repeat(7) },
    ];
    const issues = rules.detectSceneTailDuplication(scenes);
    assert.ok(issues.length >= 1 && issues[0].severity === 'high');
  });

  test('正常顺承（前场景结尾≠后场景事件）不报', () => {
    const scenes = [
      { idx: 1, content: '他把弓挂回架上，掌心还留着弦的震颤。夜里他翻来覆去，想着白天脱靶的那两箭，睡得很不踏实。'.repeat(5) },
      { idx: 2, content: '次日天不亮，独耳陈把他叫到坡下，让他先空手拉二十次麻绳，再碰弓。'.repeat(5) },
    ];
    assert.equal(rules.detectSceneTailDuplication(scenes).length, 0);
  });
});

describe('V0.94 safelyMergeContinuation 续写安全合并（双版本根因）', () => {
  const existing = '他掀帘进帐，把灯芯拨高了半寸，摊开工册，写了两个字：朝局。写完他走到帐口，望着西北那道灰烟。'.repeat(3);

  test('正常续写（不复述原文）→ append', () => {
    const cont = '一阵马蹄声从坡下传来，由远及近，在他的帐前停住了。';
    const merged = safelyMergeContinuation(existing, cont);
    assert.equal(merged.mode, 'append');
    assert.ok(merged.content.includes('马蹄声'));
    assert.ok(merged.content.includes('朝局'));
  });

  test('模型重述同一事件（复述原文大部分）→ replace 或 discard，绝不拼接', () => {
    const replay = '他掀帘进帐，把灯芯拨高了半寸，摊开工册，写了两个字：朝局。写完他走到帐口，望着西北那道灰烟。'.repeat(3);
    const merged = safelyMergeContinuation(existing, replay);
    assert.ok(['replace', 'discard'].includes(merged.mode));
    assert.ok(!merged.content.includes(`${existing}\n${replay}`), '不得出现双版本拼接');
  });

  test('续写包含原文且更长（完整重写）→ replace', () => {
    const superset = existing + '\n他把工册合上，压在枕下。帐外传来第一声梆子。';
    const merged = safelyMergeContinuation(existing, superset);
    assert.equal(merged.mode, 'replace');
    assert.ok(merged.content.includes('梆子'));
  });

  test('衔接处短边界复述被消解', () => {
    const merged = safelyMergeContinuation('他把绳头缠在腕上，缠了三圈。', '缠了三圈。他开始往上爬。');
    assert.equal(merged.mode, 'append');
    assert.ok(!merged.content.includes('三圈。缠了三圈'));
  });
});

describe('V0.94 enforceSceneDashBudget 破折号预算硬闸', () => {
  test('超预算的破折号被替换为逗号，预算内保留', () => {
    const src = Array.from({ length: 6 }, (_, i) => `句子${i}——后半${i}。`).join('');
    const out = enforceSceneDashBudget(src, 3);
    assert.equal((out.match(/——/g) || []).length, 3, '只保留预算数量');
    assert.ok(out.includes('，'), '多余破折号替换为逗号');
    assert.ok(out.startsWith('句子0——'), '靠前的破折号优先保留');
  });

  test('未超预算原样返回', () => {
    const src = '一句——两句。三句——四句。';
    assert.equal(enforceSceneDashBudget(src, 5), src);
  });
});
