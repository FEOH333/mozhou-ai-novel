// V0.95.6 checkpoint 缺口本地愈合 + 章细纲预算根修（ch27 重规划 8 连败卡章实证）
// 现场（8/16 晚）：V0.95.5 结构分词上线后重规划候选仍 8 版全灭——
// beat 全部合格（两端点概念在场），仅 checkpoints 用结果性措辞（"隘口第一根桩钉下"）
// 不含概念词 → historicalOutlineIssues 判 missingCheckpoint 驳回。
// 指令要求"关键词连续写进 beat 与 checkpoint"模型 8 次只执行一半——
// 措辞合规不该赌模型重掷（每版 80-160s 纯浪费），beat 已落实即可本地补 checkpoint。
// 同轮：chapter_outline 预算 12000→15000（细纲 JSON 截断连败实测；PLANNING_TASKS +30% 兜底保留）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import './helper.js';
import {
  healHistoricalCheckpointGap, historicalOutlineIssues,
} from '../server/engine/historical_guardrails.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHASE = '从执行者到布防者的过渡起点';

/** ch27 实证形态：beat 两端点概念在场、checkpoint 结果性措辞缺概念词 */
function ch27Shape() {
  return {
    phase: PHASE,
    scenes: [
 { beat: '主角向王坚汇报新线获准负责隘口设障，完成从执行者到布防者的转变' },
 { beat: '工组按主角勘定的桩位钉下第一排木桩，各杆间隙由他定夺' },
    ],
    checkpoints: ['隘口第一根桩钉下，位置与间距经王坚认可'],
  };
}

describe('V0.95.6 checkpoint 缺口本地愈合', () => {
  test('RED→GREEN：beat 落实、checkpoint 缺概念词 → 愈合成功且防线归零（ch27 八连败形态）', () => {
    const outline = ch27Shape();
    // 前置确认：这正是 8 连败现场——beat 合格、checkpoint 被毙
    const before = historicalOutlineIssues(outline);
    assert.equal(before.length, 1, '愈合前应恰有一个 checkpoint 缺口 issue');
    assert.ok(before[0].issue.includes('checkpoint'), '缺口应指向 checkpoint');

    const healed = healHistoricalCheckpointGap(outline);
    assert.equal(healed, true, 'beat 已落实 → 本地补 phase 原文 checkpoint，应愈合放行');
    assert.equal(historicalOutlineIssues(outline).length, 0, '愈合后复检必须全绿');
    assert.ok(
      outline.checkpoints.some(cp => cp.includes(PHASE)),
      '追加的 checkpoint 应含阶段任务原文（供审校正文核查同源使用）',
    );
  });

  test('beat 未落实（真换题）绝不愈合——防线核心不变', () => {
    const offTopic = {
      phase: PHASE,
 scenes: [{ beat: '主角在重庆城中采买皮料，与郑货郎周旋' }],
 checkpoints: ['主角带回一捆皮料'],
    };
    const before = historicalOutlineIssues(offTopic).length;
    assert.equal(healHistoricalCheckpointGap(offTopic), false, '换题候选不得被措辞补丁放行');
    assert.equal(offTopic.checkpoints.length, 1, '未愈合时不追加任何 checkpoint');
    assert.equal(historicalOutlineIssues(offTopic).length, before, '拦截语义保持');
  });

  test('边界：checkpoints 非数组 / checkpoint 已合格 → 均不愈合', () => {
    assert.equal(healHistoricalCheckpointGap({ phase: PHASE, scenes: ch27Shape().scenes }), false,
      'checkpoints 非数组不愈合（交由下游结构校验兜底）');
    const fine = {
      phase: PHASE,
 scenes: [{ beat: '完成从执行者到布防者的转变，主角获准负责隘口设障' }],
      checkpoints: ['由执行者转为布防者，隘口钉下第一根桩'],
    };
    assert.equal(historicalOutlineIssues(fine).length, 0, '前置确认该细纲本就合格');
    assert.equal(healHistoricalCheckpointGap(fine), false, '已合格无需愈合');
    assert.equal(fine.checkpoints.length, 1, '合格细纲不追加冗余 checkpoint');
  });
});

describe('V0.95.6 outline 接线与预算护栏', () => {
  test('generateChapterOutline 历史门内已接入 heal（源断言：写审同源单点）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(path.join(ROOT, 'server/engine/outline.js'), 'utf8');
    assert.ok(
      src.includes('healHistoricalCheckpointGap(outline)'),
      '细纲校验前应先尝试 checkpoint 缺口愈合（beat 落实即放行，不再整版重掷）',
    );
    assert.ok(src.includes("book.genre === '历史' && healHistoricalCheckpointGap"),
      '愈合仅历史题材门控（非历史零影响）');
  });

  test('chapter_outline 预算 12000→15000 防回退护栏（细纲 JSON 截断实测）', async () => {
    const { DEFAULT_ROUTES } = await import(pathToFileURL(path.join(ROOT, 'server/config.js')));
    assert.equal(DEFAULT_ROUTES.chapter_outline.maxTokens, 15000,
      'ch27 实证细纲长 JSON 在 12000 打满截断连败；15000 + PLANNING_TASKS +30% 兜底');
  });
});
