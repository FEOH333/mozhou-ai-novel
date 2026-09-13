// V0.102.17：卷纲规划套话不得当下一章 phase；标题不能冒充规划种子目标。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlanningMetaPhase, sanitizeReconcileSeed } from '../server/engine/longform/historical_guardrails.js';
import { futureOutlineBase } from '../server/engine/narrative/narrative_state.js';

test('V0.102.17 布局/成长补救/卷级转折是规划套话，临战收网不是', () => {
  assert.equal(isPlanningMetaPhase('布局：利用敌方情报链反制'), true);
  assert.equal(isPlanningMetaPhase('成长补救：主动争取条件，尝试越权'), true);
  assert.equal(isPlanningMetaPhase('卷级转折：蒙哥之死与信念重塑'), true);
  assert.equal(isPlanningMetaPhase('高潮前奏：战术胜利与心理冲击'), true);
  assert.equal(isPlanningMetaPhase('接住上卷出口，建立新压力源（难民+围城前夕）'), true);
  assert.equal(isPlanningMetaPhase('临战收网'), false);
  assert.equal(isPlanningMetaPhase('百姓进寨'), false);
  assert.equal(isPlanningMetaPhase(''), false);
});

test('V0.102.17 换版时丢掉规划套话 phase，保留可落地行动', () => {
  const dropped = futureOutlineBase({
    year: 1259, phase: '布局：利用敌方情报链反制', goal: '应被丢掉的动态目标', beat: '也应丢掉',
  });
  assert.equal(dropped.year, 1259);
  assert.equal(dropped.phase, undefined);
  assert.equal(dropped.goal, undefined);
  const kept = futureOutlineBase({ year: 1258, phase: '临战收网' });
  assert.equal(kept.phase, '临战收网');
});

test('V0.102.17 标题不能当下一章目标，桥接实际结果才是种子', () => {
  const bad = sanitizeReconcileSeed({
    chapter: 37, goal: '血染干沟', conflict: '必须处理上一章已经造成的后果',
 bridge_from_actual: '主角抓获灰袍人，逼问出老槐树根部地道与三日后爆破计划。',
    reader_gain: '看见后果落地', reader_pull: '三日窗口',
  }, { title: '血染干沟' });
  assert.notEqual(bad.goal, '血染干沟');
  assert.match(bad.goal, /老槐树|地道|爆破/);
  const kept = sanitizeReconcileSeed({
    chapter: 3, goal: '摆脱追兵', conflict: '救人还是赶路',
 bridge_from_actual: '主角弃马救下受伤斥候',
    reader_gain: '代价', reader_pull: '山口',
  }, { title: '山口' });
  assert.equal(kept.goal, '摆脱追兵');
});

test('V0.102.17 非历史题材同样不用标题当目标', () => {
  const next = sanitizeReconcileSeed({
    chapter: 2, goal: '秘境', conflict: '抢机缘',
    bridge_from_actual: '李尘在任务堂接下灰衣人留下的残卷。',
  }, { title: '秘境' });
  assert.notEqual(next.goal, '秘境');
  assert.match(next.goal, /残卷|任务堂|灰衣人/);
});
