// V0.96.3 锁定：章名含蓄化与对齐系统判定
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helper.js';
import { isFlatTitle, titleHitsText } from '../server/engine/alignment.js';

test('V0.96.3 章名含蓄化：意象型章名不命中白描黑名单（对齐系统不会改回）', () => {
  for (const name of ['过路的人', '北渡', '空村']) {
    assert.equal(isFlatTitle(name), false, `《${name}》不应命中动作直述黑名单`);
  }
});

test('V0.96.3 新章名有正文锚定：titleHitsText 对正文原句可命中（防"脱节"标记）', () => {
  // 意象型标题：正文/摘要含该词窗口即判对齐
  assert.equal(titleHitsText('北渡', '人潮北渡，是被逼出来的。他们都在往钓鱼山的方向走'), true,
    '《北渡》应命中"人潮北渡"');
  assert.equal(titleHitsText('过路的人', '降将自称过路的人，试走验障露出破绽'), true,
    '摘要含"过路"窗口时《过路的人》应判对齐');
});

test('V0.96.3 动作直述式章名必须被判为平铺（含蓄化纪律的反向保证）', () => {
  // 与上一条互为反向：黑名单机制必须仍然生效，否则含蓄化纪律形同虚设
  for (const name of ['夜袭营门', '决战孤城', '反杀刺客']) {
    assert.equal(isFlatTitle(name), true, `《${name}》属于动作直述，必须命中黑名单`);
  }
  // 带章号前缀时也应先剥离前缀再判定
  assert.equal(isFlatTitle('第12章 夜袭'), true, '章号前缀必须先剥离再判平铺');
});
