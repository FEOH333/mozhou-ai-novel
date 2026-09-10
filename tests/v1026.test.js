// V0.102.6：修订时场景行短暂找不到不得把已有五场草稿打回 planned 并停写全书。
'use strict';

import './helper.js';
process.env.NOVEL_MOCK_LLM = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterFailurePolicy } from '../server/engine/pilot.js';
import { groupIssuesByScene } from '../server/engine/pipeline.js';

test('V0.102.6 已有草稿时普通失败保持 drafted，不打回 planned', () => {
  assert.equal(chapterFailurePolicy('API_ERROR').status, 'planned');
  assert.equal(chapterFailurePolicy('REWRITE_SCENE_MISSING', { hasDraftContent: true }).status, 'drafted');
  assert.equal(chapterFailurePolicy('QUALITY_GATE_FAILED', { hasDraftContent: true }).status, 'quality_blocked');
});

test('V0.102.6 按 idx 找回场景：id 变化后仍能对上同一场', () => {
  const scenes = [
    { id: 'sc-old-1', idx: 1, content: '开庆元年的风还没吹透北崖墙根。' },
    { id: 'sc-old-2', idx: 2, content: '陈七掀帘入内，带进湿冷泥腥味。' },
  ];
  const groups = groupIssuesByScene(scenes, [
    { type: '人称视角', severity: 'high', quote: '开庆元年的风还没吹透', issue: '元话语', fix: '删章号' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].scene.idx, 1);
  const live = [{ id: 'sc-new-1', idx: 1, content: scenes[0].content }];
  const resolved = live.find(s => s.id === groups[0].scene.id) || live.find(s => s.idx === groups[0].scene.idx);
  assert.equal(resolved.id, 'sc-new-1');
});
