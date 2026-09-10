import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const api = fs.readFileSync('web/js/api.js', 'utf8');
const workshop = fs.readFileSync('web/js/views/workshop.js', 'utf8');

test('V0.98 前端 API 统一封装开篇创作闭环', () => {
  for (const endpoint of [
    'story-promise', 'opening-diagnosis', 'opening-assets', 'opening-compose',
    'opening-publish-patch', 'opening-feedback',
  ]) assert.ok(api.includes(endpoint), `缺少 ${endpoint} API 封装`);
  assert.ok(api.includes('selectOpeningAsset'));
  assert.ok(api.includes('applyOpeningAsset'));
});

test('V0.98 精读诊断失败后显示持久化错误而非停留在正在读取', async () => {
  const modulePath = path.resolve('web/js/opening-status.js');
  assert.equal(fs.existsSync(modulePath), true, '缺少可测试的诊断状态格式化模块');
  const {
    openingDiagnosisSummary,
    openingDiagnosisFailureMessage,
    openingDiagnosisProgressMessage,
  } = await import(`file:///${modulePath.replace(/\\/g, '/')}`);
  assert.equal(openingDiagnosisSummary({
    exists: false, stale: true,
    last_attempt_failed: { error: 'issues[0] 引文无法定位' },
  }), '上次诊断失败：issues[0] 引文无法定位');
  assert.equal(openingDiagnosisSummary({
    exists: true, stale: false,
    report: {
      issues: [{ severity: 'medium' }, { severity: 'low' }], tradeoffs: [{}],
      validation_warnings: [{ kind: 'issue', code: 'quote_not_found' }],
    },
  }), '当前诊断有效：1 条需处理问题，1 条轻微建议，1 条创作取舍，已隔离 1 条无法核验的模型意见');
  assert.equal(openingDiagnosisFailureMessage(new Error('字符范围校验失败')), '诊断失败：字符范围校验失败');
  assert.match(openingDiagnosisProgressMessage(42_000), /已等待 0:42/);
  assert.match(openingDiagnosisProgressMessage(95_000), /请勿重复点击/);
  assert.match(openingDiagnosisProgressMessage(305_000), /上游响应较慢/);
  assert.match(workshop, /openingDiagnosisSummary\(diagnosis\)/);
  assert.match(workshop, /onError:\s*error\s*=>[\s\S]*openingDiagnosisFailureMessage\(error\)/);
  assert.match(workshop, /openingDiagnosisProgressMessage\(Date\.now\(\) - startedAt\)/);
  assert.match(workshop, /setInterval\(updateProgress, 1_000\)/);
});

test('V0.98 写作台显示创作决策台而非工程分数板，并能一键采用候选', () => {
  for (const text of [
    '开篇创作决策台', '本书靠什么吸引人', '创作假设', '原稿会匿名参与比较',
    '顺叙强化', '第一章内嵌楔子', '独立楔子', '技术详情', '记录真实反馈',
  ]) assert.ok(workshop.includes(text), `界面缺少：${text}`);
  assert.ok(workshop.includes('openingApi.compose'));
  assert.ok(workshop.includes('autoPrepare: true'));
  assert.ok(workshop.includes('autoCompare: true'));
  assert.ok(workshop.includes('openingApi.selectOpeningAsset'));
  assert.ok(workshop.includes('openingApi.applyOpeningAsset'));
  assert.equal(/候选\s*A0|候选\s*A1|候选\s*A2/.test(workshop), false, '界面不得暴露 A0/A1 工程代号');
});

test('V0.98 生成开篇方案立即显示可见进度，并持续报告长请求仍在工作', async () => {
  const modulePath = path.resolve('web/js/opening-status.js');
  const { openingComposeProgressMessage } = await import(`file:///${modulePath.replace(/\\/g, '/')}`);

  assert.match(openingComposeProgressMessage({
    detail: '写作候选：战地冷开场', elapsedMs: 42_000,
  }), /写作候选：战地冷开场[\s\S]*已等待 0:42/);
  assert.match(openingComposeProgressMessage({
    detail: '审校候选 1\/2', elapsedMs: 95_000,
  }), /请勿重复点击/);
  assert.match(openingComposeProgressMessage({ elapsedMs: 305_000 }), /上游响应较慢/);

  assert.match(workshop, /openingComposeProgressMessage/);
  assert.match(workshop, /id:\s*'opening-action-status'/);
  assert.match(workshop, /'aria-live':\s*'polite'/);
  assert.match(workshop, /button\.textContent\s*=\s*'方案生成中…'/);
  assert.match(workshop, /setInterval\(updateProgress,\s*1_000\)/);
  assert.doesNotMatch(workshop, /body\.append\(status\)/,
    '进度若仍附在整张决策台底部，点击顶部按钮后用户看不到反馈');
  assert.doesNotMatch(workshop, /请勿刷新或离开本页/,
    '作业可重连后不得再要求人钉死在本页');
});
