// V0.96.2 锁定：母题同义变体合并组 + 收尾套子短语级检测（实测 ch27-31 精读实证）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helper.js';
import { detectMotifRepetition } from '../server/engine/quality/rules.js';
import { STRICT_MOTIFS, CLOSEOUT_TIC_PATTERNS } from '../server/data/redlines.js';

test('V0.96.2 蹲类变体合并计数：蹲下/蹲在/蹲回/蹲身求和达阈值即报', () => {
 // 旧检测只查「蹲下」：蹲下2+蹲在4=实际6次套路，旧算法计2不报（实测 ch29 实测漏报形态）
  const text = '他蹲下看桩。她蹲在灶边。他蹲回原处。阿蛮蹲在棚边。陈七蹲在泥地边。她又蹲身试了试。';
  const issues = detectMotifRepetition(text);
  const squat = issues.find(i => (i.issue || '').includes('蹲下/蹲在'));
  assert.ok(squat, '蹲类合并组 ≥3 应报 medium');
  assert.ok(squat.issue.includes('6 次'), '合并计数应为 6 次（非单变体计数）');
  // 单一变体不超阈值零误报
  const clean = detectMotifRepetition('他蹲下看了一眼，起身走了。');
  assert.ok(!clean.some(i => (i.issue || '').includes('蹲')), '蹲类合计 1 次不应报');
});

test('V0.96.2 收尾套子：「（收拢|收紧），又松开」同章 ≥2 报 medium', () => {
  const text = '他指节慢慢收拢，又松开。灯焰跳了一下。她把绳绕紧，收紧，又松开。';
  const issues = detectMotifRepetition(text);
  const tic = issues.find(i => (i.issue || '').includes('收尾套子'));
  assert.ok(tic, '收尾套子 ≥2 应报 medium');
  assert.equal(tic.severity, 'medium');
  // 单次出现不报（有力的一处允许保留）
  const single = detectMotifRepetition('他指节慢慢收拢，又松开，没有说话。');
  assert.ok(!single.some(i => (i.issue || '').includes('收尾套子')), '单次不报');
});

test('V0.96.2 词表单一真源：合并组与套子表在 redlines.js 导出', () => {
  assert.ok(STRICT_MOTIFS.some(m => Array.isArray(m) && m.includes('蹲在')), 'STRICT_MOTIFS 应含蹲类数组组');
  assert.ok(CLOSEOUT_TIC_PATTERNS.length >= 1, '应导出收尾套子正则表');
});

test('V0.96.2 真实形态回归：实测 ch27 形态（蹲类13次+套子3处）两项都报', () => {
  const ch27ish = Array.from({ length: 6 }, () => '蹲下').join('。') + '。' + Array.from({ length: 7 }, () => '蹲在').join('。')
    + '指节慢慢收拢，又松开。指节收紧，又松开。';
  const issues = detectMotifRepetition(ch27ish);
  const squat = issues.find(i => (i.issue || '').includes('蹲下/蹲在'));
  assert.ok(squat && squat.issue.includes('13 次'), '蹲类合计应计 13 次');
  assert.ok(issues.some(i => (i.issue || '').includes('收尾套子')), '套子 2 处应报');
});
