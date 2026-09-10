// web/js/opening-status.js —— 开篇诊断状态的纯函数格式化（供界面与测试共用）
'use strict';

function errorText(value, fallback = '未知错误') {
  const text = String(value || '').trim();
  return text || fallback;
}

export function openingDiagnosisSummary(diagnosis = {}) {
  if (diagnosis.exists && !diagnosis.stale) {
    const issues = Array.isArray(diagnosis.report?.issues) ? diagnosis.report.issues : [];
    const priority = issues.filter(issue => issue?.severity !== 'low').length;
    const low = issues.filter(issue => issue?.severity === 'low').length;
    const tradeoffs = Array.isArray(diagnosis.report?.tradeoffs) ? diagnosis.report.tradeoffs.length : 0;
    const warnings = Array.isArray(diagnosis.report?.validation_warnings)
      ? diagnosis.report.validation_warnings.length : 0;
    return `当前诊断有效：${priority} 条需处理问题`
      + (low ? `，${low} 条轻微建议` : '')
      + (tradeoffs ? `，${tradeoffs} 条创作取舍` : '')
      + (warnings ? `，已隔离 ${warnings} 条无法核验的模型意见` : '');
  }
  if (diagnosis.last_attempt_failed?.error) {
    return `上次诊断失败：${errorText(diagnosis.last_attempt_failed.error)}`;
  }
  if (diagnosis.exists && diagnosis.stale) return '正文或创作宪章已变化，旧诊断已过期';
  return '尚未精读正文';
}

export function openingDiagnosisFailureMessage(error) {
  return `诊断失败：${errorText(error?.message || error)}`;
}

function elapsedClock(elapsedMs) {
  const seconds = Math.max(0, Math.floor(Number(elapsedMs) / 1000) || 0);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** 长请求也应该让作者看得出“仍在工作”，而不是像卡死。 */
export function openingDiagnosisProgressMessage(elapsedMs = 0) {
  const seconds = Math.max(0, Math.floor(Number(elapsedMs) / 1000) || 0);
  const elapsed = `已等待 ${elapsedClock(elapsedMs)}`;
  if (seconds >= 600) return `模型思考较久，单步可能超过 10 分钟… ${elapsed}。仍在工作，请勿重复点击。`;
  if (seconds >= 300) return `上游响应较慢，仍在等待… ${elapsed}。完成或失败后会显示明确结果，请勿重复点击。`;
  if (seconds >= 90) return `模型正在深度审阅… ${elapsed}。复杂正文可能需数分钟，请勿重复点击。`;
  return `正在精读第1—3章全文及第4—10章实际片段… ${elapsed}。`;
}

/** 开篇方案会经过构思、逐稿写作、审校和两轮比较；阶段事件之间也持续显示计时。 */
export function openingComposeProgressMessage({ detail = '', elapsedMs = 0 } = {}) {
  const seconds = Math.max(0, Math.floor(Number(elapsedMs) / 1000) || 0);
  const phase = errorText(detail, '正在构思并生成开篇方案');
  const elapsed = `已等待 ${elapsedClock(elapsedMs)}`;
  if (seconds >= 600) {
    return `模型思考较久，单步可能超过 10 分钟：${phase}。${elapsed}。连接中断也会自动重试续跑，请勿重复点击。`;
  }
  if (seconds >= 300) {
    return `上游响应较慢，当前仍在工作：${phase}。${elapsed}。请勿重复点击。`;
  }
  if (seconds >= 90) {
    return `${phase}… ${elapsed}。生成、审校和两轮比较可能需要数分钟，请勿重复点击。`;
  }
  return `${phase}… ${elapsed}。`;
}
