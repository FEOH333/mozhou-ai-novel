// server/engine/longform/longform_lifecycle.js —— V0.92 全书生命周期与完本兑付台账
//
// 设计原则：
// 1. AI 负责创作，本地代码负责决定“现在该扩张、转向、汇流还是结算”；
// 2. 章节/卷局部合格不等于整书推进合格，所有规划共用同一阶段合同；
// 3. 完本必须有可核对的结构化兑付证据，不能仅凭字数或一次 AI 自报。
'use strict';

import * as store from '../../db/store.js';
import { isCompletedChapter } from '../pipeline/chapter_status.js';
import { namesMatch, reportNames } from '../../util/text.js'; // V0.93.2：名称匹配单一实现

const ACTIVE_PROMISE_STATUSES = new Set(['open', 'progressing', 'confirmed']);
const ACTIVE_FORESHADOW_STATUSES = new Set(['planted', 'advanced']);
const ENDING_FIELDS = Object.freeze([
  'final_opposition',
  'final_choice',
  'irreversible_cost',
  'core_promise_payoff',
  'protagonist_settlement',
  'relationship_settlements',
  'world_settlement',
  'historical_settlement',
  'closing_image',
  'last_chapter_mode',
]);

function frozenStage(stage) {
  return Object.freeze({ ...stage, forbidden: Object.freeze([...(stage.forbidden || [])]) });
}

export const LONGFORM_STAGES = Object.freeze({
  opening: frozenStage({
    id: 'opening', label: '开篇与前期',
    purpose: '让读者爱上人、地方与核心问题，建立主角最初欲望、缺陷和可持续的追读承诺。',
    requiredTurn: '主角从被动承受转为作出第一次主动选择，并获得进入更大故事的资格。',
    payoffDuty: '兑现开篇承诺与第一轮情感/能力回报，同时保留清晰但不过量的长线问题。',
    newMajorArcBudget: 3,
    hookPolicy: '可建立主线、关系线与暗线，但总活跃弧线控制在3—5条。',
    forbidden: ['只铺设定不发生选择', '提前揭完终局秘密', '用连续灾难代替人物建立'],
  }),
  early_middle: frozenStage({
    id: 'early_middle', label: '前中期',
    purpose: '扩大世界与责任半径，把开篇的个人问题升级为制度、阵营或时代问题。',
    requiredTurn: '主角作出一次不可逆选择；旧目标被抬高、改写或暴露出更深代价。',
    payoffDuty: '至少完成一个开篇长期待的阶段兑现，推进主角弧与一条关键关系线。',
    newMajorArcBudget: 2,
    hookPolicy: '允许新增少量重要弧线，但每新增一条必须推进或关闭一条旧弧线。',
    forbidden: ['换地图后重复新手村剧情', '反复用同型对手升级', '成长只有身份数字没有选择代价'],
  }),
  middle: frozenStage({
    id: 'middle', label: '中期',
    purpose: '完成全书中点变轨，让主角和读者对真正问题的理解发生不可逆变化。',
    requiredTurn: '揭示或制造中点真相/惨胜/背叛，使旧解法失效，主角必须改变战略和自我认知。',
    payoffDuty: '关闭至少一条已成熟的重要弧线，兑现一项长期承诺，并让最终冲突的轮廓可见。',
    newMajorArcBudget: 1,
    hookPolicy: '新增主线只能是既有因果的升级，不得凭空再开一部新故事。',
    forbidden: ['原地循环升级', '中点只有更强敌人没有目标转向', '所有旧账都推给后半本'],
  }),
  late_middle: frozenStage({
    id: 'late_middle', label: '中后期',
    purpose: '让分散战线汇流，确定最终对手与最终问题，为收尾腾出足够跑道。',
    requiredTurn: '主角承担一次无法撤销的战略/情感代价，主要弧线开始合流到同一个终局选择。',
    payoffDuty: '逐卷净减少开放弧线和长期待；明确哪些在结局前关闭、哪些允许留白。',
    newMajorArcBudget: 0,
    hookPolicy: '禁止新增重大主线；新信息只能解释、升级或合并既有因果。',
    forbidden: ['突然出现无前因终极反派', '继续扩地图却不汇流', '把所有人物命运拖到最后一章'],
  }),
  ending: frozenStage({
    id: 'ending', label: '后期收尾',
    purpose: '按结局蓝图逐项清账，把最终对手、最终选择、不可逆代价和世界去向全部推到台前。',
    requiredTurn: '终局条件就位，主角主动选择代价并进入不可回头的最后行动。',
    payoffDuty: '关闭主线弧、主要关系线、高重要度伏笔与长期读者期待；每卷开放债务必须净减少。',
    newMajorArcBudget: 0,
    hookPolicy: '只允许终局推进钩，不允许另开新主线；倒数第二卷必须把尾声空间保留下来。',
    forbidden: ['临结局新增核心设定', '一章连续解释全部伏笔', '靠突降外挂解决最终冲突'],
  }),
  finale: frozenStage({
    id: 'finale', label: '终卷与完本',
    purpose: '兑现全书核心承诺，完成主角、关键关系、世界/时代结果与开篇意象的多重结算。',
    requiredTurn: '主角在最终选择中付出不可逆代价；胜负之后必须留下人物安顿与世界余波。',
    payoffDuty: '核心承诺、主线弧、关键关系、世界结果全部有明确落点；最后一章以回声和闭幕意象结束。',
    newMajorArcBudget: 0,
    hookPolicy: '终章不设强制下一章悬念；可留世界仍向前的余韵，但不能留下未完成的当前主冲突。',
    forbidden: ['终战结束即戛然而止', '用旁白概述代替人物结算', '最后一页再抛新终极敌人', '以章节上限冒充完本'],
  }),
});

function safeJSON(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function nonEmpty(value) {
  if (Array.isArray(value)) return value.some(item => String(item || '').trim());
  return String(value ?? '').trim().length > 0;
}

function outlineVolumeCount(bookId) {
  const text = store.materials.get(bookId, 'outline')?.content || '';
  const indexes = [...String(text).matchAll(/第\s*(\d+)\s*卷/g)].map(match => Number(match[1])).filter(Number.isInteger);
  return indexes.length ? Math.max(...indexes) : 0;
}

export function plannedVolumeCount(bookId, options = {}) {
  const explicit = Number(options.totalVolumes || options.plannedVolumes);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const book = store.books.get(bookId);
  if (!book) return 10;
  const settings = store.books.settings(bookId);
  const configured = Number(settings.longformLifecycle?.plannedVolumes || settings.plannedVolumes || settings.volumeCount);
  const fromOutline = outlineVolumeCount(bookId);
  const rows = store.volumes.list(bookId);
  const concreteMax = rows.reduce((max, volume) => {
    const outline = safeJSON(volume.outline_json);
    const meaningful = nonEmpty(volume.title) || nonEmpty(volume.goal)
      || nonEmpty(outline.summary) || nonEmpty(outline.chapters) || nonEmpty(outline.lifecycle_stage);
    return meaningful ? Math.max(max, Number(volume.idx) || 0) : max;
  }, 0);
  // 本工具定位长篇；只有一两个实体卷往往表示“目前只生成了近期卷”，不能把它误判为终卷。
  // 已经存在且有内容的后续卷比旧 settings 更接近用户当前意图，不能被 stale plannedVolumes 截断。
  return Math.max(10, fromOutline, concreteMax, Number.isInteger(configured) && configured > 0 ? configured : 0);
}

export function lifecycleStageIdForPosition(volumeIdx, totalVolumes) {
  const idx = Math.min(Math.max(1, Number(volumeIdx) || 1), Math.max(1, totalVolumes));
  if (idx >= totalVolumes) return 'finale';
  const ratio = idx / totalVolumes;
  if (ratio <= 0.20) return 'opening';
  if (ratio <= 0.40) return 'early_middle';
  if (ratio <= 0.70) return 'middle';
  if (ratio <= 0.80) return 'late_middle';
  return 'ending';
}

function completedChapterCount(bookId) {
  return store.chapters.list(bookId).filter(isCompletedChapter).length;
}

function latestRelevantVolumeIdx(bookId) {
  const volumes = store.volumes.list(bookId);
  if (!volumes.length) return 1;
  const firstIncomplete = volumes.find(volume => {
    const chapters = store.chapters.listByVolume(volume.id);
    return !chapters.length || chapters.some(chapter => !isCompletedChapter(chapter));
  });
  if (firstIncomplete) return firstIncomplete.idx;
  return Math.max(...volumes.map(volume => Number(volume.idx) || 1));
}

export function resolveBookStage(bookId, options = {}) {
  const book = store.books.get(bookId) || {};
  const totalVolumes = plannedVolumeCount(bookId, options);
  const volumeIdx = Math.min(
    Math.max(1, Number(options.volumeIdx || latestRelevantVolumeIdx(bookId)) || 1),
    totalVolumes,
  );
  const volume = store.volumes.list(bookId).find(item => Number(item.idx) === volumeIdx);
  const volumeOutline = safeJSON(volume?.outline_json);
  const explicitStage = String(options.stageId || volumeOutline.lifecycle_stage || '').trim();
  const positionalStage = lifecycleStageIdForPosition(volumeIdx, totalVolumes);
  // 终局是结构不变量：只能在最后一卷。旧书纲若在中途残留 finale，按真实位置降级；
  // 最后一卷即使漏标，也必须按 finale 合同审查，防止写完后没有兑付。
  const id = volumeIdx === totalVolumes
    ? 'finale'
    : (LONGFORM_STAGES[explicitStage] && explicitStage !== 'finale' ? explicitStage : positionalStage);
  return {
    ...LONGFORM_STAGES[id],
    volumeIdx,
    totalVolumes,
    progress: volumeIdx / totalVolumes,
    volumesRemaining: Math.max(0, totalVolumes - volumeIdx),
  };
}

/** 纯结构校验，供 doctor/维护脚本共用；不根据书名或题材硬编码卷数。 */
export function lifecycleStructureIssues(volumes = [], { configuredTotal = null } = {}) {
  const rows = [...(volumes || [])].sort((a, b) => Number(a.idx) - Number(b.idx));
  if (!rows.length) return [];
  const actualTotal = Math.max(...rows.map(row => Number(row.idx) || 0));
  const configured = Number(configuredTotal);
  const issues = [];
  if (Number.isInteger(configured) && configured > 0 && configured !== actualTotal) {
    issues.push({
      severity: 'high', type: '生命周期冲突',
      issue: `配置计划 ${configured} 卷，但实际存在 ${actualTotal} 卷；阶段判定会截断或提前完本`,
      volumeIdx: null,
    });
  }
  const stageRank = new Map(['opening', 'early_middle', 'middle', 'late_middle', 'ending', 'finale'].map((id, i) => [id, i]));
  let previousRank = -1;
  const finaleIndexes = [];
  for (const row of rows) {
    const outline = safeJSON(row.outline_json ?? row.outline);
    const stage = String(outline.lifecycle_stage || '').trim();
    if (stage === 'finale') finaleIndexes.push(Number(row.idx));
    if (stageRank.has(stage)) {
      const rank = stageRank.get(stage);
      if (rank < previousRank) {
        issues.push({ severity: 'high', type: '生命周期冲突', volumeIdx: Number(row.idx), issue: `第${row.idx}卷阶段 ${stage} 逆退，生命周期必须单调推进` });
      }
      previousRank = Math.max(previousRank, rank);
    }
    if (Number(row.idx) < actualTotal && outline.ending_delivery && Object.values(outline.ending_delivery).some(nonEmpty)) {
      issues.push({ severity: 'high', type: '生命周期冲突', volumeIdx: Number(row.idx), issue: `第${row.idx}卷在终卷前持有 ending_delivery，形成提前结局/双结局` });
    }
  }
  for (const idx of finaleIndexes.filter(idx => idx !== actualTotal)) {
    issues.push({ severity: 'high', type: '生命周期冲突', volumeIdx: idx, issue: `第${idx}卷被标为 finale，但实际终卷是第${actualTotal}卷` });
  }
  if (!finaleIndexes.includes(actualTotal)) {
    issues.push({ severity: 'medium', type: '生命周期冲突', volumeIdx: actualTotal, issue: `实际终卷第${actualTotal}卷未标记 finale，完本兑付门可能失效` });
  }
  return issues;
}

/**
 * 严格生命周期门只对显式启用的新书/迁移书生效。旧书仍可读取阶段提示，但不会
 * 因缺少 V0.92 新字段而被卷纲落库硬卡；它们可通过维护迁移逐步升级。
 */
export function lifecycleEnforcementEnabled(bookId) {
  const settings = store.books.settings(bookId);
  return Number(settings.longformLifecycle?.version) >= 1
    || Boolean(settings.longformLifecycle?.enforce);
}

function lastCompletedChapterIdx(bookId) {
  return store.chapters.list(bookId)
    .filter(isCompletedChapter)
    .reduce((max, chapter) => Math.max(max, Number(chapter.idx) || 0), 0);
}

function protagonistArc(bookId) {
  const protagonist = store.characters.list(bookId).find(character => character.tier === 'protagonist');
  if (protagonist) {
    const card = safeJSON(protagonist.card_json);
    return protagonist.arc || card.arc || '';
  }
  const cast = store.materials.get(bookId, 'cast')?.content || '';
  const match = cast.match(/(?:成长弧线|弧线)[：:]([^\n]+)/);
  return match?.[1]?.trim() || '';
}

function contractCorePromise(bookId) {
  const contract = store.materials.get(bookId, 'contract')?.content || '';
  const selling = contract.match(/核心卖点[：:]([^\n]+)/)?.[1]?.trim();
  if (selling) return selling;
  const promises = contract.match(/叙事承诺与节奏规则[：:]([^\n]+)/)?.[1]?.trim();
  if (promises) return promises;
  const blurb = store.books.get(bookId)?.blurb || '';
  return blurb.trim().slice(0, 180);
}

function endingBlueprint(bookId) {
  return safeJSON(store.materials.get(bookId, 'ending_blueprint')?.content, null);
}

function completedFinaleDelivery(bookId) {
  const totalVolumes = plannedVolumeCount(bookId);
  const finalVolume = store.volumes.list(bookId).find(volume => Number(volume.idx) === totalVolumes);
  if (!finalVolume) return null;
  const chapters = store.chapters.listByVolume(finalVolume.id);
  const volumeComplete = chapters.length > 0 && chapters.every(isCompletedChapter);
  const outline = safeJSON(finalVolume.outline_json);
  if (!volumeComplete || outline.lifecycle_stage !== 'finale') return null;
  return outline.ending_delivery && typeof outline.ending_delivery === 'object' ? outline.ending_delivery : null;
}

function obligation({ id, type, label, status = 'open', blocking = true, evidence = '', source = '', ...meta }) {
  return { id, type, label, status, blocking, evidence, source, ...meta };
}

/**
 * 汇总全书尚待兑现的结构化债务。短章钩只影响追读，不单独阻止完本；主线弧、
 * 高/中重要伏笔、长期待、契约承诺与结局形式属于硬阻塞。
 */
export function buildPayoffLedger(bookId) {
  const currentChapter = lastCompletedChapterIdx(bookId);
  const obligations = [];
  const blueprint = endingBlueprint(bookId);
  const delivered = completedFinaleDelivery(bookId);
  const corePromise = blueprint?.core_promise || contractCorePromise(bookId) || '全书核心承诺';

  obligations.push(obligation({
    id: 'core-promise', type: 'core_promise', label: corePromise,
    status: nonEmpty(delivered?.core_promise_payoff) ? 'resolved' : 'open',
    blocking: true,
    evidence: delivered?.core_promise_payoff || '', source: 'contract',
  }));

  for (const promise of store.contractPromises.list(bookId)) {
    const resolved = ['met', 'paid', 'resolved', 'closed'].includes(String(promise.status));
    obligations.push(obligation({
      id: `contract-${promise.id}`, type: 'core_promise', label: promise.text || '契约承诺',
      status: resolved ? 'resolved' : 'open', blocking: !resolved,
      evidence: promise.note || '', source: 'contract_promises', dueChapter: Number(promise.due_chapter) || null,
    }));
  }

  for (const arc of store.storyArcs.list(bookId)) {
    const activated = (Number(arc.opened_chapter) || 0) <= currentChapter || (Number(arc.target_chapter) || 0) <= currentChapter;
    const resolved = arc.status === 'closed';
    const major = arc.type === '主线' || arc.type === '感情线' || /主线|终局|核心/.test(`${arc.name || ''} ${arc.note || ''}`);
    obligations.push(obligation({
      id: `arc-${arc.id}`, type: 'story_arc', label: arc.name || '未命名弧线',
      status: resolved ? 'resolved' : (activated ? 'open' : 'future'),
      blocking: !resolved && activated && major,
      evidence: arc.note || '', source: 'story_arcs',
      openedChapter: Number(arc.opened_chapter) || null, dueChapter: Number(arc.target_chapter) || null,
    }));
  }

  for (const item of store.foreshadows.list(bookId)) {
    const open = ACTIVE_FORESHADOW_STATUSES.has(item.status);
    const highEnough = item.importance !== 'low';
    obligations.push(obligation({
      id: `foreshadow-${item.id}`, type: 'foreshadow', label: item.desc || '未命名伏笔',
      status: open ? 'open' : 'resolved', blocking: open && highEnough,
      evidence: item.note || '', source: 'foreshadows',
      dueChapter: Number(item.payoff_chapter) || null, importance: item.importance || 'medium',
    }));
  }

  for (const hook of store.pleasureHooks.list(bookId)) {
    const open = ACTIVE_PROMISE_STATUSES.has(hook.status);
    const longPromise = hook.kind === 'long' || hook.kind === 'super';
    const overdueMedium = hook.kind === 'medium' && Number(hook.due_chapter) > 0 && currentChapter >= Number(hook.due_chapter);
    obligations.push(obligation({
      id: `reader-${hook.id}`, type: 'reader_promise', label: hook.desc || '未命名读者期待',
      status: open ? 'open' : 'resolved', blocking: open && (longPromise || overdueMedium),
      evidence: hook.note || '', source: 'pleasure_hooks',
      dueChapter: Number(hook.due_chapter) || null, kind: hook.kind || 'medium',
    }));
  }

  for (const field of ENDING_FIELDS) {
    const resolved = nonEmpty(delivered?.[field]);
    obligations.push(obligation({
      id: `ending-${field}`, type: 'ending_form', label: endingFieldLabel(field),
      status: resolved ? 'resolved' : 'open', blocking: !resolved,
      evidence: resolved ? formatValue(delivered[field]) : '', source: 'ending_blueprint',
    }));
  }

  if (protagonistArc(bookId)) {
    obligations.push(obligation({
      id: 'protagonist-arc', type: 'story_arc', label: `主角弧：${protagonistArc(bookId)}`,
      status: nonEmpty(delivered?.protagonist_settlement) ? 'resolved' : 'open',
      blocking: !nonEmpty(delivered?.protagonist_settlement),
      evidence: delivered?.protagonist_settlement || '', source: 'characters',
    }));
  }

  const blockers = obligations.filter(item => item.blocking && item.status === 'open');
  return {
    currentChapter,
    obligations,
    blockers,
    openCount: obligations.filter(item => item.status === 'open').length,
    resolvedCount: obligations.filter(item => item.status === 'resolved').length,
    blockingCount: blockers.length,
  };
}

function endingFieldLabel(field) {
  return ({
    final_opposition: '最终对手/最后阻力',
    final_choice: '主角最终选择',
    irreversible_cost: '不可逆代价',
    core_promise_payoff: '核心承诺兑现',
    protagonist_settlement: '主角弧结算',
    relationship_settlements: '关键关系结算',
    world_settlement: '世界/秩序结算',
    historical_settlement: '历史/时代结果',
    closing_image: '闭幕意象',
    last_chapter_mode: '最后一章余波结构',
  })[field] || field;
}

function formatValue(value) {
  return Array.isArray(value) ? value.join('；') : String(value || '');
}

export function endingReadiness(bookId, options = {}) {
  const ledger = buildPayoffLedger(bookId);
  const stage = resolveBookStage(bookId, options);
  const finalVolume = store.volumes.list(bookId).find(volume => Number(volume.idx) === stage.totalVolumes);
  const finalChapters = finalVolume ? store.chapters.listByVolume(finalVolume.id) : [];
  const finaleWritten = finalChapters.length > 0 && finalChapters.every(isCompletedChapter);
  const blockers = [...ledger.blockers];
  if (!finaleWritten && !blockers.some(item => item.id === 'finale-volume')) {
    blockers.push(obligation({
      id: 'finale-volume', type: 'ending_form', label: `第${stage.totalVolumes}卷终卷尚未完整写完`,
      status: 'open', blocking: true, source: 'volumes',
    }));
  }
  if (finaleWritten && options.requireFinalReview !== false) {
    const review = finalVolume ? store.volumeReviews.byVolume(bookId, finalVolume.id) : null;
    const report = safeJSON(review?.report_json);
    const issues = safeJSON(review?.issues_json, []);
    const severe = Array.isArray(issues) && issues.some(issue => issue?.severity === 'P0' || issue?.severity === 'P1');
    const reviewPassed = review?.status === 'done'
      && report.goal_met !== false
      && report.stage_progress?.duty_met === true
      && report.ending_readiness?.ready !== false
      && !severe;
    if (!reviewPassed) {
      blockers.push(obligation({
        id: 'finale-review', type: 'ending_form', label: '终卷尚未通过生命周期卷体检',
        status: 'open', blocking: true, source: 'volume_reviews',
      }));
    }
  }
  const ready = blockers.length === 0;
  return {
    ready,
    stage,
    ledger,
    blockers,
    summary: ready
      ? '核心承诺、主线债务与终卷结算均已形成可核对落点'
      : `完本门仍有 ${blockers.length} 项未结：${blockers.slice(0, 4).map(item => item.label).join('；')}`,
  };
}

export function buildLifecycleContext(bookId, options = {}) {
  const stage = resolveBookStage(bookId, options);
  const payoffLedger = buildPayoffLedger(bookId);
  const endingPlan = endingBlueprint(bookId);
  // 终局蓝图是全书完本时的硬门，但不应从第一卷起把十项终局字段当成
  // “本卷立刻要还的债”反复塞给模型。阶段上下文只展示当前应处理的项目，
  // endingReadiness 仍使用 payoffLedger.blockers 做最终完整核验。
  const stageBlockers = payoffLedger.blockers.filter((item) => {
    if (stage.id === 'finale' || stage.id === 'ending') return true;
    if (item.type === 'ending_form') return false;
    // 中后期开始建立完整收束跑道：所有已经激活的主线、关系、伏笔与长期待
    // 都要进入视野，但结局形式由单独蓝图指导，不在这里伪装成当卷欠债。
    if (stage.id === 'late_middle') return true;
    if (item.id === 'core-promise' || item.id === 'protagonist-arc') return false;
    // 前中期以前只显示临近或已经逾期的结构债。长线目标本身仍在台账中，
    // 但不会从第一卷起每章催促“现在就结局”。
    const dueChapter = Number(item.dueChapter);
    if (!Number.isFinite(dueChapter) || dueChapter <= 0) return false;
    const horizon = stage.id === 'middle' ? 8 : 4;
    return dueChapter <= payoffLedger.currentChapter + horizon;
  });
  return {
    stage,
    payoffLedger,
    stageBlockers,
    endingBlueprint: endingPlan,
    endingBlueprintText: endingPlan ? endingBlueprintText(bookId) : '',
    currentChapter: payoffLedger.currentChapter,
    completedChapters: completedChapterCount(bookId),
  };
}

export function lifecyclePromptText(context = {}) {
  const stage = context.stage || LONGFORM_STAGES.opening;
  const blockers = context.stageBlockers || context.payoffLedger?.blockers || [];
  return `【全书生命周期合同（本地硬规则）】
阶段ID：${stage.id}｜阶段：${stage.label}｜第${stage.volumeIdx || '?'}卷/计划${stage.totalVolumes || '?'}卷
本阶段职责：${stage.purpose}
必须发生的阶段转折：${stage.requiredTurn}
兑付职责：${stage.payoffDuty}
新主线额度：最多 ${stage.newMajorArcBudget} 条；${stage.hookPolicy}
当前阶段到期/应收束债务：${blockers.length ? blockers.slice(0, 12).map(item => `[${item.type}]${item.label}`).join('；') : '（当前无到期硬债；仍须完成本阶段职责）'}
禁止捷径：${stage.forbidden.join('；')}
卷纲必须输出 lifecycle_stage、stage_turn、arcs_advanced、arcs_closed、hooks_paid、new_major_arcs、ending_delivery。后四项即使为空也要输出数组/对象；不得用模糊“推进主线”代替可核对的具体名称。`;
}

/** 卷纲落库前的本地生命周期校验。 */
export function validateLifecycleVolumeOutline(outline, context = {}) {
  const stage = context.stage || LONGFORM_STAGES.opening;
  const issues = [];
  const stageId = String(outline?.lifecycle_stage || '');
  if (stageId !== stage.id) {
    issues.push({ code: 'LIFECYCLE_STAGE_MISMATCH', message: `lifecycle_stage 应为 ${stage.id}，不是 ${stageId || '未填'}` });
  }
  if (!nonEmpty(outline?.stage_turn)) {
    issues.push({ code: 'STAGE_TURN_MISSING', message: `缺少本卷必须发生的阶段转折 stage_turn` });
  }
  const newMajorArcs = Array.isArray(outline?.new_major_arcs) ? outline.new_major_arcs.filter(nonEmpty) : [];
  if (newMajorArcs.length > stage.newMajorArcBudget) {
    issues.push({
      code: ['late_middle', 'ending', 'finale'].includes(stage.id) ? 'LATE_MAJOR_ARC_OPENED' : 'MAJOR_ARC_BUDGET_EXCEEDED',
      message: `${stage.label}新重大主线额度为 ${stage.newMajorArcBudget}，实际新增 ${newMajorArcs.length} 条：${newMajorArcs.join('、')}`,
    });
  }

  if (stage.id === 'ending' || stage.id === 'finale') {
    const blockers = context.payoffLedger?.blockers || [];
    const closed = Array.isArray(outline?.arcs_closed) ? outline.arcs_closed.filter(nonEmpty) : [];
    const paid = Array.isArray(outline?.hooks_paid) ? outline.hooks_paid.filter(nonEmpty) : [];
    const delivery = outline?.ending_delivery && typeof outline.ending_delivery === 'object' ? outline.ending_delivery : {};
    if (blockers.length && !closed.length && !paid.length && !Object.values(delivery).some(nonEmpty)) {
      issues.push({ code: 'ENDING_PAYOFF_MISSING', message: `${stage.label}仍有 ${blockers.length} 项硬债务，但本卷未列 arcs_closed、hooks_paid 或 ending_delivery 兑付动作` });
    } else if (stage.id === 'ending' && blockers.some(item => item.type === 'story_arc') && !closed.length) {
      issues.push({ code: 'ENDING_PAYOFF_MISSING', message: '收尾期存在未闭合故事弧，本卷必须在 arcs_closed 中明确关闭或在 stage_turn 中推进到临门一脚' });
    }
  }

  if (stage.id === 'finale') {
    const delivery = outline?.ending_delivery && typeof outline.ending_delivery === 'object' ? outline.ending_delivery : {};
    const missing = ENDING_FIELDS.filter(field => !nonEmpty(delivery[field]));
    if (missing.length) {
      issues.push({
        code: 'FINALE_SETTLEMENT_MISSING',
        message: `终卷结算字段缺失：${missing.map(field => `${field}（${endingFieldLabel(field)}）`).join('、')}`,
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

function defaultEndingBlueprint(bookId) {
  const book = store.books.get(bookId) || {};
  const corePromise = contractCorePromise(bookId) || book.blurb || '兑现全书核心承诺';
  const protagonist = store.characters.list(bookId).find(character => character.tier === 'protagonist');
  const protagonistName = protagonist?.name || '主角';
  const openArcs = store.storyArcs.list(bookId).filter(arc => arc.status !== 'closed').map(arc => arc.name).filter(Boolean);
  return {
    version: 1,
    generated_at: Date.now(),
    core_promise: corePromise,
    final_opposition: openArcs.find(name => /主线|敌|国|朝|终局/.test(name)) || `阻止${protagonistName}兑现核心承诺的既有力量（必须从前文因果中确定，不得凭空新增）`,
    final_choice: `${protagonistName}必须在个人所得与核心承诺之间作出不可撤销的主动选择`,
    irreversible_cost: '由前文已建立的人、权力、身份或安全中支付一项永久代价，禁止无代价完胜',
    protagonist_settlement: protagonistArc(bookId) || `${protagonistName}的起点缺陷被最后一次挑战，并以行动完成改变`,
    relationship_settlements: ['为主要关系线分别安排行动性结算，不用旁白一句带过'],
    world_settlement: '展示胜负如何改变普通人的生活、秩序与未来，而非只报战果',
    historical_settlement: book.genre === '历史' ? '交代架空分岔后的政治、军事、财政与民生后果' : '不适用',
    closing_image: '回到开篇核心意象，让同一意象因主角四十年/全书历程获得新含义',
    last_chapter_mode: '终局余波→关键人物安顿→世界落点→主题回声→闭幕意象；不再开启当前故事的新主线',
  };
}

/**
 * 幂等建立结局蓝图。可由维护脚本/测试传入 data；自动路径则从现有契约、人物弧与弧线台账
 * 生成确定性初稿，后续卷纲必须把它具体化，不会因为 AI 调用失败而缺席。
 */
export function ensureEndingBlueprint(bookId, { data, force = false } = {}) {
  const existing = endingBlueprint(bookId);
  if (existing && !force && !data) return existing;
  const blueprint = { ...defaultEndingBlueprint(bookId), ...(existing || {}), ...(data || {}) };
  store.materials.set(bookId, 'ending_blueprint', JSON.stringify(blueprint, null, 2));
  const settings = store.books.settings(bookId);
  settings.longformLifecycle = {
    ...(settings.longformLifecycle || {}),
    plannedVolumes: plannedVolumeCount(bookId),
    endingBlueprintReady: true,
    endingBlueprintVersion: Number(blueprint.version) || 1,
    endingBlueprintUpdatedAt: Date.now(),
  };
  store.books.update(bookId, { settings });
  return blueprint;
}

export function endingBlueprintText(bookId) {
  const blueprint = endingBlueprint(bookId);
  if (!blueprint) return '';
  return `【结局蓝图（后两卷逐项兑现，不得临时改题）】
核心承诺：${blueprint.core_promise || '（未填）'}
最终对手/最后阻力：${blueprint.final_opposition || '（未填）'}
最终选择：${blueprint.final_choice || '（未填）'}
不可逆代价：${blueprint.irreversible_cost || '（未填）'}
主角弧结算：${blueprint.protagonist_settlement || '（未填）'}
关键关系结算：${formatValue(blueprint.relationship_settlements) || '（未填）'}
世界/秩序结算：${blueprint.world_settlement || '（未填）'}
历史/时代结果：${blueprint.historical_settlement || '（未填）'}
闭幕意象：${blueprint.closing_image || '（未填）'}
最后一章结构：${blueprint.last_chapter_mode || '（未填）'}`;
}

/** 卷完成后的低成本检查点：持久化当前阶段与债务摘要，供断点续跑和界面事件使用。 */
export function persistLifecycleCheckpoint(bookId, options = {}) {
  const context = buildLifecycleContext(bookId, options);
  if ((context.stage.id === 'ending' || context.stage.id === 'finale') && !context.endingBlueprint) {
    ensureEndingBlueprint(bookId);
    context.endingBlueprint = endingBlueprint(bookId);
    context.endingBlueprintText = endingBlueprintText(bookId);
  }
  const checkpoint = {
    version: 1,
    updated_at: Date.now(),
    stage: context.stage.id,
    stage_label: context.stage.label,
    volume_idx: context.stage.volumeIdx,
    total_volumes: context.stage.totalVolumes,
    required_turn: context.stage.requiredTurn,
    payoff_duty: context.stage.payoffDuty,
    blocking_count: context.stageBlockers.length,
    blockers: context.stageBlockers.slice(0, 20).map(item => ({ id: item.id, type: item.type, label: item.label })),
    finish_blocking_count: context.payoffLedger.blockingCount,
  };
  store.materials.set(bookId, 'longform_lifecycle', JSON.stringify(checkpoint, null, 2));
  return { context, checkpoint };
}

/**
 * 卷体检只有在摘要/正文证据确认“已推进/已闭合/已兑现”后才调用本函数；规划字段本身
 * 不能提前销账。匹配采用名称精确或足够长的包含关系（namesMatch 在 util/text.js），
 * 避免模型略写标点造成漏记。
 */
export function reconcileLifecycleLedger(bookId, volumeId, report = {}) {
  const volume = store.volumes.get(volumeId);
  const chapters = volume ? store.chapters.listByVolume(volume.id) : [];
  const chapterIdx = chapters.reduce((max, chapter) => Math.max(max, Number(chapter.idx) || 0), 0);
  const closedNames = reportNames(report.arc_movement?.closed || report.arcs_closed);
  const advancedNames = reportNames(report.arc_movement?.advanced || report.arcs_advanced);
  const paidNames = reportNames(report.payoff_movement?.paid || report.hooks_paid);
  const result = { arcsClosed: 0, arcsAdvanced: 0, hooksPaid: 0, foreshadowsPaid: 0 };

  for (const arc of store.storyArcs.list(bookId)) {
    if (closedNames.some(name => namesMatch(name, arc.name))) {
      store.storyArcs.update(arc.id, { status: 'closed', lastActiveChapter: chapterIdx || arc.last_active_chapter });
      result.arcsClosed++;
    } else if (advancedNames.some(name => namesMatch(name, arc.name))) {
      store.storyArcs.update(arc.id, { status: arc.status === 'closing' ? 'closing' : 'progressing', lastActiveChapter: chapterIdx || arc.last_active_chapter });
      result.arcsAdvanced++;
    }
  }
  for (const hook of store.pleasureHooks.list(bookId)) {
    if (!ACTIVE_PROMISE_STATUSES.has(hook.status)) continue;
    if (paidNames.some(name => namesMatch(name, hook.desc))) {
      store.pleasureHooks.update(hook.id, {
        status: 'paid', lastProgressChapter: chapterIdx || hook.last_progress_chapter,
        note: `${hook.note ? `${hook.note}；` : ''}第${chapterIdx || '?'}章卷体检确认兑现`,
      });
      result.hooksPaid++;
    }
  }
  for (const clue of store.foreshadows.list(bookId)) {
    if (!ACTIVE_FORESHADOW_STATUSES.has(clue.status)) continue;
    if (paidNames.some(name => namesMatch(name, clue.desc))) {
      store.foreshadows.update(clue.id, {
        status: 'paid_off', payoffChapter: chapterIdx || clue.payoff_chapter,
        note: `${clue.note ? `${clue.note}；` : ''}第${chapterIdx || '?'}章卷体检确认回收`,
      });
      result.foreshadowsPaid++;
    }
  }
  return result;
}
