// server/data/issue_types.js —— V0.109.3 issue 类型语义单一真源
//
// 背景（为什么需要这层）：审校 issue 的 type 一直是自由字符串，而「哪些类型可经修订自愈、
// 哪些必须记债由后章圆场、哪些纯文本级多轮不消就放行」这套语义，此前**硬编码在 5 处消费点**：
//   audit.js:480-481 hasFixable / audit.js:487 verdict 强制 fix / audit.js:493-500 记债白名单
//   pipeline.js:376 textOnly / chapter_diversity.js:308 clicheOnlyIssues
//
// 后果是新增一个纪律（例如 V0.109.3 引入的「AI 腔」）若不同时改全这 5 处，medium 命中就
// **不会触发修订自愈**，检测器沦为摆设——这正是 audit.js:479 注释里记录的 V0.73 失败模式
// （"否则整套 AI 味检测形同虚设"）。类型语义必须收敛为单一真源，新增纪律才能零成本接入。
//
// 设计要点：每个语义一个独立开关，消费点各取所需——**不做"一个大而全的可修布尔"**，
// 因为各消费点口径本就不完全一致（如「文学性」进 pipeline 的 textOnly，却不在 audit 的
// medium 可修集内）。拆开才能逐点对齐现行为，把重构做成零行为变化。
'use strict';

/**
 * 语义开关含义：
 * - fixableAtMedium  该类型在 medium 严重度下即视为可修（参与 verdict 强制 fix / hasFixable）
 * - textOnly         纯文本级问题（pipeline 多轮修订不消时记债放行，不死磕整章）
 * - clicheOnly       属"仅 AI 味文本问题"（chapter_diversity 据此走较宽的回归判定）
 * - roundup          需后续章节圆场 → 落 conflicts 台账（记债）
 *
 * 未登记的语义一律为 false —— 与重构前「不在白名单即不记债/不可修」完全一致。
 */
const FLAGS = { fixableAtMedium: false, textOnly: false, clicheOnly: false, roundup: false };

const RAW_REGISTRY = {
  // —— 文本级：本地检测为主，经修订即可了结，不需后章圆场 ——
  '语句质量': { fixableAtMedium: true, textOnly: true, clicheOnly: true },
  '文学性': { textOnly: true }, // 注意：不在 medium 可修集内（与 audit 现行为一致）
  // V0.109.3：通用中文 AI 腔（抽象黑话/翻译腔/句式同质化/假升华/上帝视角等）。
  // 与「语句质量」（网文套话，如"嘴角勾起一抹"）职责不同，故独立成类，便于分别统计与调参。
  'AI 腔': { fixableAtMedium: true, textOnly: true, clicheOnly: true },

  // —— 需后续章节圆场（原 audit.js NEEDS_ROUNDUP 白名单原样迁入）——
  '伏笔遗忘': { roundup: true },
  '设定冲突': { roundup: true },
  '时间线冲突': { roundup: true },
  '角色矛盾': { roundup: true },
  '事实编造': { roundup: true },
  '事实矛盾': { roundup: true },
  '大纲偏离': { roundup: true },
  '史实错误': { roundup: true },
  '战争逻辑': { roundup: true },
  '权谋逻辑': { roundup: true },

  // —— 仅提示，既不自动改写也不记债 ——
  '人称视角': {},
  '情感连贯性': {},
  '环境描写缺失': {},
  '心理描写标签化': {},
  '审校异常': {},
};

/** 冻结的注册表：消费点只读，防运行期被改写导致语义漂移 */
export const ISSUE_TYPE_REGISTRY = Object.freeze(
  Object.fromEntries(
    Object.entries(RAW_REGISTRY).map(([type, flags]) => [type, Object.freeze({ ...FLAGS, ...flags })]),
  ),
);

/** 未登记类型的语义兜底：全部 false，等价于重构前的默认分支 */
const UNREGISTERED = Object.freeze({ ...FLAGS });

function flagsOf(type) {
  return ISSUE_TYPE_REGISTRY[type] || UNREGISTERED;
}

/** 该类型是否需记债（需后续章节圆场）——替代 audit.js 的 NEEDS_ROUNDUP 白名单 */
export function needsRoundup(type) {
  return flagsOf(type).roundup === true;
}

/** 该类型是否纯文本级问题（多轮修订不消即记债放行）——原 pipeline.js textOnly 判定 */
export function isTextOnlyType(type) {
  return flagsOf(type).textOnly === true;
}

/** 该类型是否属"仅 AI 味文本问题"——原 chapter_diversity.js clicheOnlyIssues 判定 */
export function isClicheOnlyType(type) {
  return flagsOf(type).clicheOnly === true;
}

/**
 * 单条 issue 是否可通过修订自愈（不看具体证据，只看类型与严重度）。
 * high 一律可修（客观问题需要修订正文）；medium 仅当该类型登记了 fixableAtMedium。
 * 替代 audit.js 里 `severity === 'high' || (severity === 'medium' && type === '语句质量')`。
 */
export function isFixableIssue(issue) {
  if (!issue) return false;
  const severity = issue.severity;
  if (severity === 'high') return true;
  if (severity !== 'medium') return false;
  return flagsOf(issue.type).fixableAtMedium === true;
}

/**
 * 整组 issue 是否全为可修项（textOnly 语义）。
 * 替代 pipeline.js 的 `fixable.every(i => i.type === '语句质量' || i.type === '文学性')`。
 */
export function isAllTextOnly(issues) {
  const list = Array.isArray(issues) ? issues : [];
  return list.length > 0 && list.every(i => isTextOnlyType(i?.type));
}

/** 该类型是否已登记（供测试做"新增类型漏注册"守卫） */
export function isRegisteredIssueType(type) {
  return Object.prototype.hasOwnProperty.call(ISSUE_TYPE_REGISTRY, type);
}

/** 全部已登记类型（供测试与诊断工具枚举） */
export function registeredIssueTypes() {
  return Object.keys(ISSUE_TYPE_REGISTRY);
}
