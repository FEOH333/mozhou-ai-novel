// V0.102.8：修订失效升级 replan 必须排除 proseFix，否则 102.7 预算闸永远走不到。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { isRevisionStale } from '../server/engine/pipeline.js';

const quoteOf = q => String(q || '').replace(/\s/g, '').slice(0, 20);

test('V0.102.8 草稿用词类大纲偏离连续两轮不得升级 replan', () => {
 const scenes = [{ id: 's1', idx: 1, content: '主角站在门内阴影处看名册，让陈七先去安抚。' }];
  const audit = {
    verdict: 'fix',
    issues: [{
      type: '大纲偏离', severity: 'high',
 quote: '主角站在门内阴影处',
 issue: '细纲要求主角直接抛出冷酷规则（搬石换粮）。草稿中主角先犹豫、询问陈七。',
      fix: '改成当场立规矩',
    }],
  };
  const r1 = isRevisionStale({
    audit, lastFixedQuotes: new Set(), prevHighTypes: new Set(),
    prevSceneHigh: new Map(), scenes, quoteOf,
  });
  assert.equal(r1.staleHigh.length, 0);
  assert.equal(r1.typeRepeatAndSceneRepeat, false);
  assert.equal(r1.currHighTypes.size, 0, 'proseFix high 不进入失效计数');

  const prevSceneHigh = new Map();
  prevSceneHigh.set('大纲偏离|high@1', 1);
  const r2 = isRevisionStale({
    audit,
    lastFixedQuotes: new Set(),
    prevHighTypes: new Set(['大纲偏离|high']),
    prevSceneHigh, scenes, quoteOf,
  });
  assert.equal(r2.typeRepeatAndSceneRepeat, false, '正文可修的大纲偏离不得升级重规划');
});

test('V0.102.8 未登记角色类细纲硬伤仍判定修订失效', () => {
  const scenes = [{ id: 's1', idx: 1, content: '那道人影是负责书库杂务的老幺。林月指着那人影说是老幺。' }];
  const r1 = isRevisionStale({
    audit: { issues: [{ type: '事实编造', severity: 'high', quote: '那道人影是负责书库杂务', issue: '老幺未登记' }] },
    lastFixedQuotes: new Set(), prevHighTypes: new Set(), prevSceneHigh: new Map(), scenes, quoteOf,
  });
  const prevSceneHigh = new Map();
  prevSceneHigh.set('事实编造|high@1', 1);
  const r2 = isRevisionStale({
    audit: { issues: [{ type: '事实编造', severity: 'high', quote: '林月指着那人影说是老幺', issue: '老幺未登记' }] },
    lastFixedQuotes: new Set(), prevHighTypes: r1.currHighTypes, prevSceneHigh, scenes, quoteOf,
  });
  assert.equal(r2.typeRepeatAndSceneRepeat, true);
});
