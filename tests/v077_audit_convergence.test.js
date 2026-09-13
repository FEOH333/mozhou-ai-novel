// V0.77 审校收敛：隔离旧正文、校验引用、按场景修订、异常停止不打磨
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v077-audit-convergence-'));
process.env.NOVEL_NO_OPEN = '1';

const store = await import('../server/db/store.js');
const cache = await import('../server/llm/cache.js');
const audit = await import('../server/engine/pipeline/audit.js');
const pipeline = await import('../server/engine/pipeline/pipeline.js');
const pilot = await import('../server/engine/pipeline/pilot.js');
const rules = await import('../server/engine/quality/rules.js');

test('审校消息只携带固定材料和本章指令，不把旧章节正文当成本章', () => {
  assert.equal(typeof cache.assembleReviewMessages, 'function', '应提供隔离式审校消息组装器');
  const book = store.books.create({ title: '审校隔离测试', genre: '玄幻' });
  store.history.append(book.id, 'system', '系统写作规则');
  store.history.append(book.id, 'user', '固定世界观材料');
  store.history.append(book.id, 'assistant', '旧章正文：灰衣人袍角冒起青烟');

  const messages = cache.assembleReviewMessages(book.id, [{ role: 'user', content: '只审校本章：井边突破。' }]);
  const joined = messages.map(m => m.content).join('\n');
  assert.match(joined, /系统写作规则/);
  assert.match(joined, /固定世界观材料/);
  assert.match(joined, /只审校本章/);
  assert.doesNotMatch(joined, /灰衣人袍角冒起青烟/);
  assert.equal(messages.at(-1).role, 'user');
});

test('审校会丢弃本章不存在的引用，并在误判全部移除后改为 accept', () => {
  assert.equal(typeof audit.sanitizeAuditResult, 'function', '应提供审校证据清洗器');
  const chapterText = '井底叩击又起。李尘按住井沿，决定服下药灰。';
  const result = audit.sanitizeAuditResult({
    verdict: 'fix',
    grade: 'C',
    issues: [
      { type: '设定冲突', severity: 'high', quote: '灰衣人收手迅速，袍角焦痕泛起青烟', issue: '与旧章矛盾', fix: '删除' },
      { type: '事实矛盾', severity: 'medium', quote: '井底叩击又起', issue: '该事件此前已经停止', fix: '说明来源不同' },
    ],
  }, chapterText);

  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].quote, '井底叩击又起');
  assert.equal(result.verdict, 'fix');

  const falseOnly = audit.sanitizeAuditResult({
    verdict: 'fix',
    issues: [{ type: '事实矛盾', severity: 'high', quote: '天际线涌起一道白光', issue: '本章时间线冲突' }],
  }, chapterText);
  assert.deepEqual(falseOnly.issues, []);
  assert.equal(falseOnly.verdict, 'accept');
});

test('同一轮的多场景问题会分别路由，不再全部塞给第一条引用所在场景', () => {
  assert.equal(typeof pipeline.groupIssuesByScene, 'function', '应提供按场景分组的修订计划');
  const scenes = [
    { id: 's1', idx: 1, content: '昨夜只薄薄一层，现在厚得能按出指纹。' },
    { id: 's2', idx: 2, content: '白光脉沿着右臂灌入丹田。' },
    { id: 's3', idx: 3, content: '林月递来布巾。' },
  ];
  const issues = [
    { type: '时间线冲突', quote: '昨夜只薄薄一层' },
    { type: '设定冲突', quote: '白光脉沿着右臂灌入丹田' },
  ];

  const groups = pipeline.groupIssuesByScene(scenes, issues);
  assert.deepEqual(groups.map(g => [g.scene.id, g.issues.length]), [['s1', 1], ['s2', 1]]);
});

test('一个重复事件问题跨越多个场景时按引用片段命中全部相关场景', () => {
  const scenes = [
    { id: 's1', idx: 1, content: '我把粉末倒进嘴里。丹田骤然炸开，最终踏入炼气初期。' },
    { id: 's2', idx: 2, content: '灰白碎屑沾在舌尖。灵气重组，再次写到炼气初期。' },
    { id: 's3', idx: 3, content: '林月递来布巾，两人离开枯井。' },
  ];
  const duplicate = {
    type: '事实矛盾', severity: 'high',
    quote: '我把粉末倒进嘴里……炼气初期……灰白碎屑沾在舌尖……再次写到炼气初期',
    issue: '同一突破事件被完整描写两遍',
  };

  const groups = pipeline.groupIssuesByScene(scenes, [duplicate]);
  assert.deepEqual(groups.map(g => g.scene.id), ['s1', 's2']);
  assert.ok(groups.every(g => g.issues[0] === duplicate));
});

test('质量失败或用户取消后不得进入全书打磨', () => {
  assert.equal(typeof pilot.shouldRunFinalPolish, 'function', '应提供收尾打磨门控');
  assert.equal(pilot.shouldRunFinalPolish({ requested: true, fatal: false, aborted: false }), true);
  assert.equal(pilot.shouldRunFinalPolish({ requested: true, fatal: true, aborted: false }), false);
  assert.equal(pilot.shouldRunFinalPolish({ requested: true, fatal: false, aborted: true }), false);
  assert.equal(pilot.shouldRunFinalPolish({ requested: false, fatal: false, aborted: false }), false);
});

test('revised 不是已结算终态，质量门异常应由一键流程先自动重试', () => {
  assert.equal(pilot.isCompletedChapter({ status: 'done' }), true);
  assert.equal(pilot.isCompletedChapter({ status: 'settled' }), true);
  assert.equal(pilot.isCompletedChapter({ status: 'revised' }), false);
  assert.equal(pilot.qualityAutoRetryLimit('AUDIT_INVALID'), 2);
  assert.equal(pilot.qualityAutoRetryLimit('QUALITY_GATE_FAILED'), 1);
  assert.equal(pilot.qualityAutoRetryLimit('SETTLEMENT_STALE'), 0);
});

test('本地规则在LLM漏检时仍拦住跨场景重复事件', () => {
  assert.equal(typeof rules.runSceneContinuityRules, 'function', '应提供跨场景确定性质量闸');
  const sharedEvent = '灰白粉末顺着喉咙滑下，丹田里的微流被热力骤然炸开。月牙疤边五道金线依次亮起，白光脉沿着经脉灌入丹田。灵气与封印力量反复碰撞，他运转吐纳法把乱流压向一处。灵台深处传来清晰的碎裂声，散乱微流重新凝聚成稳定灵气，境界终于跨入炼气初期。守在旁边的林月按住剑柄，确认他的气息稳定后才放松肩背。';
  const first = `第一场先写吞服药灰。${sharedEvent}${sharedEvent}随后他靠在井沿调整呼吸，记录五道金线的变化。`;
  const second = `第二场本应推进新事件，却再次从吞服开始。${sharedEvent}${sharedEvent}随后两人收拾东西，准备去任务堂查询旧卷宗。`;
  const distinct = `${'突破结束后，他查看井底青石刻痕，决定转去任务堂查询旧卷宗。林月收起短棍，两人并肩离开演武场。'.repeat(10)}`;
  const issues = rules.runSceneContinuityRules([
    { idx: 1, content: first }, { idx: 2, content: second }, { idx: 3, content: distinct },
  ]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, '事实矛盾');
  assert.equal(issues[0].severity, 'high');
  assert.match(issues[0].issue, /场景 1.*场景 2.*重复/);
});
