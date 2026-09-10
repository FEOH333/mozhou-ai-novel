// 推荐返工的纯状态合同：运行策略、工单身份、候选血缘与失败账本必须同源。
'use strict';

import { createHash } from 'node:crypto';

export const RECOVERY_CONTRACT_VERSION = 'recovery-contract-v10014.1';
// 计划 schema 未变：保留 V0.100.13 已付费生成的全范围蓝图，执行时本地规范化即可。
export const RECOVERY_PLAN_CONTRACT_VERSION = 'recovery-plan-v10013.1';

// V0.100.15 场景窗口篇幅比例单一真源：本地闸（validateRecoveryWindowRewrite）与候选
// 生成指令（recommendationRecoveryRewriteInstruction）共用——此前指令只注入下限，
// 上限只存在于本地闸，模型放开改写后 1.9× 天花板必然踩线（实测 ch27 实证 3422/3416）。
export const RECOVERY_WINDOW_LENGTH_RATIOS = Object.freeze({
  tuneMin: 0.65, rebuildMin: 0.58, tuneMax: 1.65, rebuildMax: 1.9,
});

const CANDIDATE_REUSE_LEVEL = Object.freeze({
  none: 0,
  same_run: 1,
  exact_cross_run: 2,
});
const REJECTION_HISTORY_LEVEL = Object.freeze({
  none: 0,
  compatible: 1,
});
const VALIDATION_STATES = new Set([
  'generated',
  'local_passed',
  'global_passed',
  'global_rejected',
  'applied',
  'rejected',
  'frozen',
  // 无来源契约的存量候选：只能作为审计材料，不能冒充本运行检查点。
  'legacy_untrusted',
]);

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function normalizedText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function objectValue(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function allowed(value, levels, fallback) {
  const key = String(value || '');
  return Object.hasOwn(levels, key) ? key : fallback;
}

export function normalizeRecoveryPolicy(value = {}) {
  const input = objectValue(value);
  return {
    candidateReuse: allowed(input.candidateReuse ?? input.candidate_reuse, CANDIDATE_REUSE_LEVEL, 'same_run'),
    rejectionHistory: allowed(input.rejectionHistory ?? input.rejection_history, REJECTION_HISTORY_LEVEL, 'compatible'),
  };
}

/** 恢复请求只能收紧已经持久化的策略，不能把 fresh 运行悄悄放宽成跨运行复用。 */
export function resolveRecoveryPolicy(persisted = {}, requested = {}) {
  const current = normalizeRecoveryPolicy(persisted);
  const requestedInput = objectValue(requested);
  const desired = normalizeRecoveryPolicy({ ...current, ...requestedInput });
  const candidateReuse = Object.entries(CANDIDATE_REUSE_LEVEL)
    .find(([, level]) => level === Math.min(CANDIDATE_REUSE_LEVEL[current.candidateReuse], CANDIDATE_REUSE_LEVEL[desired.candidateReuse]))?.[0];
  const rejectionHistory = Object.entries(REJECTION_HISTORY_LEVEL)
    .find(([, level]) => level === Math.min(REJECTION_HISTORY_LEVEL[current.rejectionHistory], REJECTION_HISTORY_LEVEL[desired.rejectionHistory]))?.[0];
  return { candidateReuse, rejectionHistory };
}

export function recoveryWorkOrderFingerprint(order = {}) {
  const evidence = [...new Set((Array.isArray(order.evidence) ? order.evidence : [])
    .map(normalizedText)
    .filter(Boolean))].sort();
  const dependsOn = [...new Set((Array.isArray(order.depends_on) ? order.depends_on : [])
    .map(Number)
    .filter(Number.isInteger))].sort((left, right) => left - right);
  const planArc = objectValue(order.plan_arc);
  return sha256(stableJson({
    contractVersion: RECOVERY_CONTRACT_VERSION,
    chapter: Number(order.chapter) || 0,
    action: normalizedText(order.action).toLowerCase(),
    objective: normalizedText(order.objective ?? order.rebuild_objective),
    reason: normalizedText(order.reason),
    evidence,
    planArcId: normalizedText(order.plan_arc_id ?? planArc.id),
    dependsOn,
    mustHandoff: normalizedText(order.must_handoff),
    planArc: Object.keys(planArc).length ? {
      id: normalizedText(planArc.id),
      problem: normalizedText(planArc.problem),
      entryState: normalizedText(planArc.entry_state),
      exitState: normalizedText(planArc.exit_state),
      causalSteps: (Array.isArray(planArc.causal_steps) ? planArc.causal_steps : []).map(step => ({
        chapter: Number(step?.chapter) || 0,
        requiredChange: normalizedText(step?.required_change),
      })),
      protectedFacts: (Array.isArray(planArc.protected_facts) ? planArc.protected_facts : [])
        .map(normalizedText)
        .filter(Boolean),
    } : null,
  }));
}

export function recoveryFailureLedgerKey(order = {}, before = '') {
  return `${RECOVERY_CONTRACT_VERSION}:${recoveryWorkOrderFingerprint(order)}:${sha256(before)}`;
}

export function normalizeCandidateProvenance(value = {}, { checkpointRunId = '' } = {}) {
  const input = objectValue(value?.provenance || value);
  const validationState = String(input.validationState ?? input.validation_state ?? 'generated');
  return {
    sourceRunId: String(input.sourceRunId ?? input.source_run_id ?? ''),
    checkpointRunId: String(checkpointRunId || input.checkpointRunId || input.checkpoint_run_id || ''),
    sourceDiagnosisFingerprint: String(input.sourceDiagnosisFingerprint ?? input.source_diagnosis_fingerprint ?? ''),
    sourceWorkOrderFingerprint: String(input.sourceWorkOrderFingerprint ?? input.source_work_order_fingerprint ?? ''),
    sourceBeforeHash: String(input.sourceBeforeHash ?? input.source_before_hash ?? ''),
    sourceNeighborFingerprint: String(input.sourceNeighborFingerprint ?? input.source_neighbor_fingerprint ?? ''),
    contractVersion: String(input.contractVersion ?? input.contract_version ?? RECOVERY_CONTRACT_VERSION),
    validationState: VALIDATION_STATES.has(validationState) ? validationState : 'generated',
  };
}

export {
  VALIDATION_STATES,
};

/**
 * 候选验证状态的唯一判定入口。驾驶舱统计、断点复用和可续性标注必须共用它——
 * 过去各层各自解释 `accepted`，导致“单章盲审通过”被当成“整段已验证”对外宣称。
 */
export function candidateValidationState(candidate = {}) {
  const provenance = normalizeCandidateProvenance(candidate?.provenance || {});
  const explicit = String(
    candidate?.provenance?.validationState ?? candidate?.provenance?.validation_state ?? '',
  );
  // 显式验证标签只有在来源契约完整时才可信；空壳标签（旧逻辑补默认值/半迁移）一律降级。
  if (explicit && VALIDATION_STATES.has(explicit)
    && hasCompleteCandidateProvenance(candidate.provenance)) {
    return explicit;
  }
  const status = String(candidate?.status || '');
  if (status === 'accepted') return 'legacy_untrusted';
  if (VALIDATION_STATES.has(status)) return status;
  return 'generated';
}

/** 按验证层级汇总候选数量；驾驶舱与可续性标注共用同一份口径。 */
export function candidateValidationStats(candidates = []) {
  const stats = {};
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const state = candidateValidationState(candidate);
    stats[state] = (stats[state] || 0) + 1;
  }
  return stats;
}

/** 缺任一来源字段都不能把候选提升为可复用检查点；默认值不得替历史未知来源背书。 */
export function hasCompleteCandidateProvenance(value = {}) {
  const input = objectValue(value?.provenance || value);
  const provenance = normalizeCandidateProvenance(value);
  const explicitContract = String(input.contractVersion ?? input.contract_version ?? '');
  return explicitContract === RECOVERY_CONTRACT_VERSION
    && Boolean(provenance.sourceRunId)
    && Boolean(provenance.checkpointRunId)
    && Boolean(provenance.sourceDiagnosisFingerprint)
    && Boolean(provenance.sourceWorkOrderFingerprint)
    && Boolean(provenance.sourceBeforeHash)
    && Boolean(provenance.sourceNeighborFingerprint);
}
