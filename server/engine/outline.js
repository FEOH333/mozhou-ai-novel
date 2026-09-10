// server/engine/outline.js —— 大纲生成（书契约/书级/卷级/章细纲 + 写前五问自检）
'use strict';
import * as store from '../db/store.js';
import { assembleMessages, assembleReviewMessages, appendHistory } from '../llm/cache.js';
import { assembleCreativeMessages } from '../llm/context_planner.js';
import { runTask } from '../llm/router.js';
import { extractJSON } from '../util/json.js';
import {
  buildSystemPrompt, buildPublicMaterials, bookOutlineInstruction,
  volumeOutlineInstruction, chapterOutlineInstruction, bookContractInstruction, fiveQuestionsInstruction,
} from './prompts.js';
import { activeForeshadowsText, approachingForeshadowsText } from './foreshadow.js';
import { rollingText } from './rolling.js'; // V0.95：滚动摘要两段式统一读取
import { sanitizeStoryMemoryText, titleShapeStreakIssues, titleRootRepeatIssues } from './rules.js'; // V0.107：卷纲期章名句式族/近词根校验
import { openingReaderContractText } from './opening_intervention.js';
import { appendPublicationFeedback } from './publication_feedback.js'; // V0.99：推流审核/作品数据动态 L4
import { narrativePatternSignature, repeatedPatternIssue } from './narrative_patterns.js';
import { narrativeLessonsText } from './narrative_lessons.js';
import { compileBookDiversityContract, diversityContractIssues } from './chapter_diversity.js';
import {
  compileStageWindow, formatStageOccupancyText, fourElementIssues, stageTaskIssues, conflictFocusIssues,
} from './stage_window.js';

/**
 * V0.93.9 结局闭环校验（书纲分卷规划本地确定性检查，纯函数）：
 * 用户实测《本作》分卷"卷11才反攻、卷12和解"撑不起简介金句（"该轮到他们想想还能撑几年"）——
 * 反攻/逆转动作必须提前到倒数第二卷及以前展开，末卷必须有结算承诺，禁止"全守+末卷突然和解"断档。
 * 词表跨题材通用（反攻/登顶/证道/破局…），软性文学判断尽量宽松，只卡明确断档。
 * @returns {{ok:boolean, issues:string[]}}
 */
const OUTLINE_ACTION_WORDS = ['反攻', '收复', '光复', '北伐', '决战', '决胜', '反制', '逆转', '清算', '夺回', '翻盘', '破局', '反扑', '登顶', '证道', '开国', '立国', '反杀', '进击', '重整', '反推', '反压', '反击'];
const OUTLINE_SETTLEMENT_WORDS = ['兑现', '和解', '落幕', '余韵', '交代', '传承', '守护', '重建', '新生', '告慰', '释然', '完成', '收官', '终局', '归隐', '安顿', '延续'];
export function endingClosureCheck(volumes = []) {
  const issues = [];
  if (!Array.isArray(volumes) || volumes.length < 2) {
    return { ok: false, issues: ['分卷规划不足 2 卷，无法校验结局闭环'] };
  }
  const textOf = v => `${v.title || ''} ${v.goal || ''} ${v.summary || ''}`;
  const last = volumes[volumes.length - 1];
  const lastText = textOf(last);
  if (!OUTLINE_SETTLEMENT_WORDS.some(w => lastText.includes(w))) {
    issues.push(`末卷《${last.title || '?'}》无结算承诺（兑现/和解/传承/重建/落幕等），结局可能悬空`);
  }
  // 推进动作必须在倒数第二卷及以前就已展开（末卷本身可以有决战/清算，但绝不能是唯一出现处）
  const actionBeforeLast = volumes.slice(0, -1).some(v => OUTLINE_ACTION_WORDS.some(w => textOf(v).includes(w)));
  if (!actionBeforeLast) {
    const anyAction = OUTLINE_ACTION_WORDS.some(w => lastText.includes(w));
    issues.push(anyAction
      ? `反攻/逆转动作只出现在末卷《${last.title || '?'}》，倒数第二卷及以前无展开——虎头蛇尾断档结构`
      : '全部分卷未见反攻/逆转/清算类推进动作（反攻/破局/登顶/清算等），主线可能只有防守没有反转');
  }
  return { ok: issues.length === 0, issues };
}
import { forgottenList } from './foreshadow.js';
import { relevantFacts, formatFacts, relevantFactsSmart } from './factbook.js'; // V0.83 语义增强事实召回
import { buildPleasureContext, formatPleasurePlan } from './pleasure.js'; // V0.80 快感计划贯通
import { generateIdeaSeeds, scoreContract, generateBookTitle } from './idea.js';
import { characterRollCallText, growthStatus, longRunningStateDebtText } from './characters.js'; // V0.37：角色点名册（活跃/退场）；V0.74 题材感知成长状态
import { genrePackText, worldScaleFor, styleRulesText } from '../data/creative_packs.js'; // V0.76 世界版图阶梯 // V0.83 文风注入大纲
import { worldExpansionStatus } from './world_expansion.js'; // V0.76 世界展开状态
import { openingBlueprintForChapter } from './opening.js'; // V0.80 前20章开篇蓝图
import { syncContractPromises } from './promise.js'; // V0.80 契约承诺账本
import { historyAnchorsText, eraContextText, historyGrowthNote, poetryForScene, eraBoundaryText, currentStoryYear, historyNamingRules, isHistoricalEraBook } from './history.js'; // V0.81 史实锚定 + 时代背景卡 + 成长波动 + 诗词 // V0.82 史实边界 + 取名规则 // V0.88 宋末书锚点判定
import { HISTORY_DEAI_TEXT } from '../data/history.js'; // V0.81 历史去AI味
import { CONTRAST_BUILDUP_TEXT, BUILDUP_STRUCTURE_TEXT, VOLUME_BUILDUP_TEXT, isWarfareText, WARFARE_BODY_TEXT, WARFARE_HISTORY_TEXT, isCourtIntrigueText, COURT_INTRIGUE_TEXT, COURT_HISTORY_TEXT } from '../data/literary_techniques.js'; // V0.86 悲剧章细纲先立后破 // V0.87 战役纪律 // V0.88 朝堂权谋纪律 // V0.90 先立后破结构强化 // V0.98.13 近战残酷纪律(并入写审同源常量)
import { WARFARE_ANCHORS, COURT_ANCHORS } from '../data/history.js'; // V0.87 宋蒙战争考据锚点 // V0.88 南宋朝堂考据锚点
import { isCompletedChapter, transitionChapterStatus } from './chapter_status.js'; // V0.93.2：状态写入单一真源
import { historicalPhaseForVolume, historicalPhaseText, historicalLongformPlanText, normalizeHistoricalBookOutline, mergeHistoricalChapterFrame, validateHistoricalVolumeOutline, historicalScaleBeatRule } from './historical_longform.js'; // V0.91 四十年阶段/年代硬校验 // V0.95.8 山河尺度节拍（细纲层落实远景/全景配额）
import { historicalOutlineIssues, historicalYouthAuthorityIssues, healHistoricalCheckpointGap, sanitizeReconcileSeed, isPlanningMetaPhase, phaseHasVerifiableAction } from './historical_guardrails.js'; // V0.91.3：阶段任务/少年权限硬防线 // V0.95.6：checkpoint 缺口本地愈合 // V0.102.17：标题不得冒充规划种子
import {
  buildLifecycleContext, endingBlueprintText, ensureEndingBlueprint, lifecycleEnforcementEnabled, lifecyclePromptText, resolveBookStage, validateLifecycleVolumeOutline,
} from './longform_lifecycle.js'; // V0.92 全书阶段合同/收尾门
import {
  buildVolumeSeam, formatVolumeSeamText, validateVolumeSeam,
  buildChapterHorizon, formatChapterHorizonText, validateChapterHorizon, selectActiveForeshadowsForChapter,
} from './horizon.js'; // V0.102 卷缝/有界长线简报

/** 开篇蓝图槽位 → 注入文本（防平铺平淡；金手指里程碑/爽点/钩子/目标阶段） */
function formatChapterBlueprint(bookId, chapterIdx) {
  try {
    const slot = openingBlueprintForChapter(bookId, chapterIdx);
    if (!slot) return '';
    // V0.82：历史题材（史实流·无金手指）——金手指里程碑改称"立身之本确立"
    const isHistory = store.books.get(bookId)?.genre === '历史';
    const bits = [];
    if (slot.payoff) bits.push(`本章须兑现的爽点/期待：${slot.payoff}`);
    if (slot.pacingBeat) bits.push(`本章爽点节奏（${slot.pacingType}）：${slot.pacingBeat}`);
    if (slot.goldenFingerMilestone) {
      bits.push(isHistory
        ? `【立身之本确立（史实流）】${slot.goldenFingerMilestone.power}｜边界：${slot.goldenFingerMilestone.limit}｜首次亮相：${slot.goldenFingerMilestone.firstDisplay}`
        : `【金手指正式上线】能力：${slot.goldenFingerMilestone.power}｜限制：${slot.goldenFingerMilestone.limit}｜首次显威：${slot.goldenFingerMilestone.firstDisplay}`);
    }
    if (slot.goalStage) bits.push(`主角目标阶段（${slot.goalStageName || ''}）：${slot.goalStage}`);
    if (slot.hook) bits.push(`本章结尾钩子建议：${slot.hook}`);
    return bits.join('；');
  } catch { return ''; }
}

function isAbortError(error) {
  return error?.code === 'ABORTED' || error?.name === 'AbortError' || (typeof error?.code === 'number' && error.code === 20);
}

/** 取书的公共材料文本（world+characters+cast+outline+contract 拼接）；缺失时用空串 */
export function publicMaterialsText(bookId) {
  const mats = store.materials.all(bookId);
  const get = kind => mats.find(m => m.kind === kind)?.content || '';
  return { world: get('world'), characters: get('characters'), cast: get('cast'), outline: get('outline'), contract: get('contract') };
}

/** 格式化书契约为文本（存储/注入用） */
export function formatContract(c) {
  if (!c) return '';
  return `【书契约】
目标读者：${c.target_readers || ''}
核心卖点：${(c.selling_points || []).join('；')}
叙事承诺与节奏规则：${(c.promises || []).map(p => `· ${p}`).join('\n')}
硬约束：${(c.hard_constraints || []).map(p => `· ${p}`).join('\n')}
基调：${c.tone || ''}`;
}

/**
 * 生成书契约（AI 本位：从灵感/题材自动生成顶层合同）
 * @returns {Promise<object>} contract
 */
export async function generateBookContract(bookId, { idea, signal } = {}) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  ensureHistory(bookId);
  // V0.19：作者灵感为空/过短时，自动从本地高概念种子库取一个（AI 本位：不依赖作者创意水平）
  let ideaText = idea || book.blurb || '';
  if (ideaText.trim().length < 8) {
    const seeds = generateIdeaSeeds(book.genre, 1);
    ideaText = seeds[0]?.concept || ideaText;
    if (ideaText !== (idea || book.blurb)) store.books.update(bookId, { blurb: ideaText.slice(0, 500) });
  }
  const tail = [{
    role: 'user',
    content: bookContractInstruction({
      genre: book.genre, blurb: ideaText, idea: ideaText, platform: book.platform, genreText: genrePackText(book.genre),
      // V0.82：历史题材注入取名/避讳规则（角色名时代感硬约束）
      historyNaming: book.genre === '历史' ? historyNamingRules() : '',
    }),
  }];
  const messages = assembleMessages(bookId, tail);
  let res = await runTask({ task: 'book_contract', bookId, messages, jsonMode: true, signal });
  let contract = extractJSON(res.content);
  if (!contract || !contract.target_readers) throw new Error('书契约解析失败，请重试');
  // V0.19：概念评分门——总分 <6 且首次时，按新方向重生成一次（提升源头质量）
  try {
    // 先落库再评分（scoreContract 读 materials），评分前不 rebuildHistory（避免双重重建）
    store.materials.set(bookId, 'contract', formatContract(contract));
    const sc = await scoreContract(bookId);
    if (sc.ok && sc.verdict === 'regen' && sc.regenDirection) {
      const res2 = await runTask({ task: 'book_contract', bookId, messages: [...messages.slice(0, -1), { role: 'user', content: bookContractInstruction({ genre: book.genre, blurb: ideaText, idea: ideaText, platform: book.platform, regenDirection: sc.regenDirection, historyNaming: book.genre === '历史' ? historyNamingRules() : '' }) }], jsonMode: true, signal });
      const contract2 = extractJSON(res2.content);
      if (contract2?.target_readers) contract = contract2;
    }
  } catch (e) {
    if (isAbortError(e)) throw e;
    /* 评分门失败不阻断（降级为直接用当前契约） */
  }
  store.materials.set(bookId, 'contract', formatContract(contract));
  // V0.80：契约"前N章承诺"结构化落库（contract_promises 表 + settings_json.contractStructured）——供到期兑现校验
  try {
    syncContractPromises(bookId, contract);
    const settings = JSON.parse(store.books.get(bookId)?.settings_json || '{}');
    settings.contractStructured = contract;
    store.books.update(bookId, { settings_json: JSON.stringify(settings) });
  } catch { /* 承诺落库失败不影响主流程 */ }
  rebuildHistory(bookId); // 契约进公共材料（前缀），重建一次（此时一般无正文历史）
  // 用最新 blurb 判断（避免覆盖上面自动填入的种子概念）
  const latestBlurb = store.books.get(bookId)?.blurb || '';
  store.books.update(bookId, { blurb: latestBlurb || contract.selling_points?.[0] || '' });
  // V0.19：书名仍是'未命名'（创建时 AI 起名失败等）→ 契约生成后自动起名回填
  const cur = store.books.get(bookId);
  if (!cur?.title || cur.title === '未命名') {
    const named = await generateBookTitle(bookId, { idea: latestBlurb || ideaText });
    if (named.ok) {
      store.books.update(bookId, { title: named.title });
      // V0.29：书名是 system 前缀的一部分，回填后重建一次，保证前缀一致（此时无正文历史，重建廉价）
      if (store.history.count(bookId) > 0) rebuildHistory(bookId);
    }
  }
  return contract;
}

/** 初始化历史堆（幂等）：system + 公共材料 */
export function ensureHistory(bookId) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  if (store.history.count(bookId) === 0) {
    appendHistory(bookId, 'system', buildSystemPrompt(book));
    appendHistory(bookId, 'user', buildPublicMaterials(publicMaterialsText(bookId)));
  }
  return store.history.count(bookId);
}

/** 重建历史堆前缀（公共材料变更后调用）。
 * 原地替换第 1/2 条消息（system + 公共材料），正文历史与 seq 完全不变，
 * scenes.history_seq 引用依然有效；代价是后续请求的缓存前缀将重新构建。
 * 注意：归档记忆不写入 DB（由 assembleMessages 组装时现算拼入 history[1]），
 * 此处只写纯公共材料，避免与 assembleMessages 重复拼接归档记忆。 */
export function rebuildHistory(bookId, reason = '公共材料变更') {
  try { store.operationLogs.add({ ts: Date.now(), category: 'cache', level: 'info', op: 'rebuild', detail: reason, bookId }); } catch { /* ignore */ }
  const book = store.books.get(bookId);
  const seq = store.history.lastSeq(bookId);
  const newSystem = buildSystemPrompt(book);
  const newUser = buildPublicMaterials(publicMaterialsText(bookId));
  if (seq >= 1) store.history.replace(bookId, 1, 'system', newSystem);
  else appendHistory(bookId, 'system', newSystem);
  if (seq >= 2) store.history.replace(bookId, 2, 'user', newUser);
  else appendHistory(bookId, 'user', newUser);
  return store.history.count(bookId);
}

/** 校验章细纲结构（V0.54：checkpoints 允许为空——辅助字段缺失不废整章；scenes 必须非空且每场景有 beat） */
function validateChapterOutline(o) {
  if (!o || typeof o !== 'object') return false;
  if (!Array.isArray(o.scenes) || !o.scenes.length) return false;
  for (const s of o.scenes) {
    if (!s.beat || typeof s.beat !== 'string') return false;
  }
  return true;
}

/**
 * 场景 target_words 差几十到一两百就重掷整份细纲，是把可本地补的配额当成文学失败。
 * 只改正数：单场 <700 提到 700；总和低于 90% 目标时把差额均摊到各场；
 * V0.105.2：总和高于 110% 上限时按比例回收（ch43-48 连续 4 章破 135% 字数红线的源头——
 * 细纲 Σtarget=5500-5700 而章目标 5000，各场景写作再普遍超 20-40% 即必然破线）。
 */
export function healOutlineWordTargets(outline, chapterLength = 3200) {
  const scenes = Array.isArray(outline?.scenes) ? outline.scenes : [];
  if (!scenes.length) return false;
  const profile = Math.max(1500, Number(chapterLength) || 3200);
  const floor = Math.round(profile * 0.9);
  const cap = Math.round(profile * 1.1);
  let changed = false;
  for (const scene of scenes) {
    const n = Number(scene.target_words);
    if (Number.isFinite(n) && n > 0 && n < 700) {
      scene.target_words = 700;
      changed = true;
    }
  }
  const sumOf = () => scenes.reduce((acc, s) => acc + (Number(s.target_words) > 0 ? Number(s.target_words) : 1000), 0);
  // V0.105.2：超上限先等比回收再查下限（单场 ≥700 钳制优先于总和上限——极端多场景时上限允许小幅溢出）
  if (sumOf() > cap) {
    const scale = cap / sumOf();
    for (const scene of scenes) {
      const cur = Number(scene.target_words) > 0 ? Number(scene.target_words) : 1000;
      scene.target_words = Math.max(700, Math.round(cur * scale));
    }
    changed = true;
  }
  if (sumOf() >= floor) return changed;
  const bump = Math.ceil((floor - sumOf()) / scenes.length);
  for (const scene of scenes) {
    const cur = Number(scene.target_words) > 0 ? Number(scene.target_words) : 1000;
    scene.target_words = cur + bump;
  }
  return true;
}

/**
 * V0.94.0 章细纲质量门（纯函数，全部题材通用）——实测 26 章精读实证的细纲层缺口：
 * ① 单章字数无下限（卷2 全卷 2000-2500 字"一章只推一件事"）；② 场景功能重复
 * （ch6 场景2/3 同一"渗水验证"演示两遍）。返回问题清单（空=通过）。
 * @param {object} outline 细纲 JSON
 * @param {object} opts { chapterLength: 作品级每章目标字数, existingCharacterNames: 已登记角色名[] }
 */
export function chapterOutlineQualityIssues(outline, {
  chapterLength = 3200,
  existingCharacterNames = [],
  recentPatterns = [],
  strictDramaticContract = false,
  diversityContract = null,
  stageWindow = null,
} = {}) {
  const issues = [];
  const scenes = Array.isArray(outline?.scenes) ? outline.scenes : [];
  if (!scenes.length) return issues;
  const profile = Math.max(1500, Number(chapterLength) || 3200);
  if (diversityContract) {
    issues.push(...diversityContractIssues(outline, diversityContract));
  }
  // 四要素硬闸只在细纲生成的严格戏剧合同路径生效，避免旧测试/仅有 scenes 的细纲被误判全空。
  if (strictDramaticContract) issues.push(...fourElementIssues(outline));
  if (stageWindow) {
    issues.push(...stageTaskIssues(outline, stageWindow));
    issues.push(...conflictFocusIssues(
      outline.conflict_focus,
      stageWindow.previousFocus,
      { stageStart: stageWindow.stageStart },
    ));
  }

  const dramaticFields = [
    ['dramatic_question', '核心追问'], ['counterforce', '反作用力'], ['turn', '转折'],
    ['irreversible_change', '不可逆变化'], ['choice_cost', '人物选择与代价'],
    ['reader_gain', '读者获得'], ['reader_pull', '继续阅读余力'],
  ];
  const hasDramaticShape = dramaticFields.some(([field]) => Object.hasOwn(outline || {}, field));
  const missingDramatic = dramaticFields
    .filter(([field]) => !String(outline?.[field] || '').trim())
    .map(([, label]) => label);
  if ((strictDramaticContract || hasDramaticShape) && missingDramatic.length) {
    issues.push({
      code: 'OUTLINE_DRAMATIC_CONTRACT_MISSING', hard: true,
      issue: `细纲缺少完整戏剧契约：${missingDramatic.join('、')}。字段必须写成可由正文兑现的具体因果，不能填“无”、空泛主题或平台术语`,
    });
  }
  const signature = String(outline?._prospective_signature || '') || narrativePatternSignature({ outline });
  const repetition = repeatedPatternIssue(signature, recentPatterns);
  if (repetition) issues.push(repetition);

  // ① 单章字数下限：场景 target 总和 ≥ 90% 目标（target 缺省按 1000 估）
  const sumTargets = scenes.reduce((acc, s) => acc + (Number(s.target_words) > 0 ? Number(s.target_words) : 1000), 0);
  const floor = Math.round(profile * 0.9);
  if (sumTargets < floor) {
    issues.push({
      issue: `场景字数总和 ${sumTargets} 字低于单章硬下限 ${floor} 字（目标 ${profile} 的 90%）——短章=平台单次购买所得腰斩。请增加场景数或提高每场景 target_words（每场景 ≥700）`,
    });
  }
  // 每场景下限
  const thin = scenes.filter(s => Number(s.target_words) > 0 && Number(s.target_words) < 700);
  if (thin.length) {
    issues.push({ issue: `${thin.length} 个场景 target_words <700（${thin.map(s => s.id || '?').join(',')}）——单场景过薄撑不起节拍，请 ≥700` });
  }

  // ② 场景功能去重：两两 beat 归一 3-gram Jaccard ≥0.10 判为词汇级功能重复
  // （实测校准：真 ch6 语义重复对=0.000（词汇不同）——语义重复由细纲指令纪律+审校 3.9 兜底，
  //  本地门只拦"同一表述写两遍"的词汇级重复：实测重复对 0.125、合格对 0.000-0.05）
  const normalized = t => String(t || '').replace(/[\s，。！？；：、“”‘’（）《》—…·]/g, '');
  const grams = t => {
    const v = normalized(t);
    const set = new Set();
    for (let i = 0; i <= v.length - 3; i++) set.add(v.slice(i, i + 3));
    return set;
  };
  const beatGrams = scenes.map(s => grams(s.beat));
  for (let i = 0; i < scenes.length; i++) {
    for (let j = i + 1; j < scenes.length; j++) {
      const a = beatGrams[i], b = beatGrams[j];
      if (!a.size || !b.size) continue;
      let shared = 0;
      for (const g of a) if (b.has(g)) shared++;
      const union = a.size + b.size - shared;
      const jaccard = union ? shared / union : 0;
      if (jaccard >= 0.10) {
        issues.push({
          issue: `场景 ${scenes[i].id || i + 1} 与场景 ${scenes[j].id || j + 1} 功能重复（beat 相似度 ${(jaccard * 100).toFixed(0)}%）——两场景不得推同一件事（同一能力/规则/信息/错误只演示一次），请删一个或让后一个推进新信息`,
        });
      }
    }
  }

  // ③ 新角色近名硬闸：精读实证“刘三/吕三、马坤/马武”在相邻章节同台时，
  // 读者必须反复回忆身份。细纲已有【新设定:姓名——身份】标记，写前即可零成本拦截。
  const numeralChars = '零一二三四五六七八九十百千万两0123456789';
  const distance = (a, b) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
    }
    return dp[a.length][b.length];
  };
  const newNames = new Set();
  const marker = /【新设定[:：]\s*([^—–\-：:】\s]{2,4})\s*(?:——|--|-|：|:)/gu;
  for (const scene of scenes) {
    let match;
    while ((match = marker.exec(String(scene.beat || ''))) !== null) newNames.add(match[1].trim());
  }
  const roster = [...new Set((existingCharacterNames || []).map(name => String(name || '').trim()).filter(Boolean))];
  const acceptedNew = [];
  for (const name of newNames) {
    for (const existing of [...roster, ...acceptedNew]) {
      const numeralCollision = name[0] === existing[0]
        && [...name.slice(1)].some(char => numeralChars.includes(char))
        && [...existing.slice(1)].some(char => numeralChars.includes(char));
      if (name !== existing && !numeralCollision && distance(name, existing) > 1) continue;
      issues.push({
        hard: true,
        issue: `新角色「${name}」与点名册「${existing}」构成近名（只差一字/同姓数字名）——读者在对白和“他”字段落中难以区分。请换成字形、读音和姓氏轮廓都明显不同的名字`,
      });
    }
    acceptedNew.push(name);
  }
  return issues;
}

/** 生成书级大纲：写入 materials(kind=outline) + 批量创建卷 */
export async function generateBookOutline(bookId, { genre, blurb, hook, volumeCount = 4 } = {}, opts = {}) {
  const onEvent = opts.onEvent;
  const signal = opts.signal;
  const emit = (stage, message) => onEvent?.({ type: 'stage', stage, message });
  emit('setup', '读取灵感与题材，准备书级大纲…');
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  ensureHistory(bookId);
  // V0.93.9：结局闭环校验 + 失败自动重试 ≤2 次（对齐卷纲 V0.85 重试模式）——
  // 此前书纲只做结构校验，模型可输出"卷11才反攻、卷12和解"的断档规划而直接通过。
  let outline = null;
  let lastReason = '';
  for (let attempt = 0; attempt < 3 && !outline; attempt++) {
    const tail = [{
      role: 'user',
      content: bookOutlineInstruction({
        genre: genre || book.genre,
        blurb: blurb || book.blurb, genreText: genrePackText(genre || book.genre),
        hook,
        volumes: volumeCount,
        worldScaleText: worldScaleFor(genre || book.genre).example, // V0.76 防新书困在同一小地域
        historyAnchors: (genre || book.genre) === '历史' ? historyAnchorsText() : '', // V0.81 史实骨架+主角改史
        historicalLongformText: historicalLongformPlanText({ ...book, genre: genre || book.genre, blurb: blurb || book.blurb }),
      }) + (lastReason ? `\n\n【上次生成未通过（V0.93.9 结局闭环重试）】${lastReason}\n请修订分卷规划：反攻/逆转/清算类动作提前到倒数第二卷及以前展开；末卷写清结算动作与结局承诺的兑现，不只写和解情绪。` : ''),
    }];
    const messages = assembleMessages(bookId, tail);
    const res = await runTask({ task: 'book_outline', bookId, messages, jsonMode: true, signal });
    const parsed = extractJSON(res.content);
    // V0.90 修复：书纲 volumes 与卷纲 chapters 同源问题——模型偶发把 volumes 输出为对象形式
    // （{"1":{...},"2":{...}}）→ 转数组；再校验，避免"书级大纲解析失败"卡死一键创作。
    let volumes = parsed?.volumes;
    if (volumes && !Array.isArray(volumes)) volumes = Object.values(volumes);
    if (!parsed || !parsed.title || !Array.isArray(volumes) || !volumes.length) {
      lastReason = '结构不完整（缺 title 或 volumes 数组）';
      continue;
    }
    const closure = endingClosureCheck(volumes);
    if (!closure.ok) {
      lastReason = closure.issues.join('；');
      continue;
    }
    outline = parsed;
    outline.volumes = volumes;
  }
  if (!outline) {
    throw new Error(`书级大纲解析失败，请重试（已自动重试 3 次：${lastReason || '模型返回结构异常'}）`);
  }
  let volumes = outline.volumes;
  const normalizedOutline = normalizeHistoricalBookOutline(outline, { ...book, genre: genre || book.genre, blurb: blurb || book.blurb });
  if (normalizedOutline !== outline) {
    outline.volumes = normalizedOutline.volumes;
    volumes = outline.volumes;
  }
  // 书纲一生成就固化总卷数与每卷阶段，不再依赖“目前数据库里有几卷”猜测。
  // 这也是断点续跑与后期完本门能稳定判断当前阶段的基础。
  const lifecycleSettings = store.books.settings(bookId);
  const lifecyclePlannedVolumes = Math.max(10, volumes.length);
  lifecycleSettings.longformLifecycle = {
    ...(lifecycleSettings.longformLifecycle || {}),
    version: 1,
    plannedVolumes: lifecyclePlannedVolumes,
    initializedAt: lifecycleSettings.longformLifecycle?.initializedAt || Date.now(),
  };
  store.books.update(bookId, { settings: lifecycleSettings });
  volumes = volumes.map((volume, index) => {
    const idx = (typeof volume.idx === 'number' && volume.idx > 0) ? volume.idx : index + 1;
    const stage = resolveBookStage(bookId, { volumeIdx: idx, totalVolumes: lifecyclePlannedVolumes });
    return {
      ...volume,
      idx,
      lifecycle_stage: volume.lifecycle_stage || stage.id,
      stage_turn: volume.stage_turn || stage.requiredTurn,
      arcs_advanced: Array.isArray(volume.arcs_advanced) ? volume.arcs_advanced : [],
      arcs_closed: Array.isArray(volume.arcs_closed) ? volume.arcs_closed : [],
      hooks_paid: Array.isArray(volume.hooks_paid) ? volume.hooks_paid : [],
      new_major_arcs: Array.isArray(volume.new_major_arcs) ? volume.new_major_arcs : [],
      ending_delivery: volume.ending_delivery || {},
    };
  });
  outline.volumes = volumes;
  // 保存到公共材料（kind=outline）——注意：这会改变公共材料，缓存将重建（设定阶段无历史，影响为零）
  const text = formatBookOutline(outline);
  store.materials.set(bookId, 'outline', text);
  emit('setup', '书级大纲生成完成，正在回填书名与建卷…');
  // V0.25 修复：作者灵感（blurb）是全书源头，不再被 AI 生成的 logline 覆盖（此前书纲生成后原始灵感彻底丢失）
  // V0.26：按大纲取名——书纲是全书骨架，其 title/logline 是全书最佳命名依据。
  //   a) 书名仍为"未命名"（创建时起名失败）→ 用书纲 title 回填；outline.title 缺失 → 用 logline 再起名一次；
  //   b) 用户已手填书名（非"未命名"）→ 不覆盖。
  const curBook = store.books.get(bookId);
  const curTitle = (curBook?.title || '').trim();
  let finalTitle = curTitle;
  if (!curTitle || curTitle === '未命名') {
    const outlineTitle = (outline.title || '').trim();
    if (outlineTitle && outlineTitle !== '未命名' && outlineTitle !== '无题') {
      finalTitle = outlineTitle.slice(0, 30);
    } else {
      // 大纲没给好名字 → 基于 logline 再起名一次
      // V0.83 修复：latestBlurb 是 generateBookContract 内局部变量，此处作用域不存在（触发即 ReferenceError 崩掉一键创作）
      const named2 = await generateBookTitle(bookId, { idea: outline.logline || outline.title || book.blurb });
      if (named2.ok) finalTitle = named2.title;
    }
  }
  store.books.update(bookId, { title: finalTitle, genre: genre || book.genre, blurb: book.blurb || outline.logline || '' });
  // V0.49：角色弧光与配角库落库 materials(kind='cast')——供公共前缀注入与写作/续卷读取
  // 格式：主角弧光段 + 配角库段（含 secret/fate），纯文本便于 LLM 直接消费
  try {
    const p = outline.protagonist || {};
    const castLines = [`【主角】${p.name || '主角'}`];
    if (p.role) castLines.push(`身份处境：${p.role}`);
    if (p.goal) castLines.push(`核心目标：${p.goal}`);
    if (p.flaw) castLines.push(`性格缺陷（必须被反复挑战并缓慢克服）：${p.flaw}`);
    if (p.arc) castLines.push(`成长弧线（能力+心境双线）：${p.arc}`);
    castLines.push('', '【配角库】（命运线要在后续分卷逐步兑现，禁止工具人化）');
    for (const m of (Array.isArray(outline.main_characters) ? outline.main_characters : [])) {
      castLines.push(`- ${m.name || '无名'}｜${m.role || ''}｜性格：${m.traits || ''}｜秘密：${m.secret || '（无）'}｜命运线：${m.fate || '（待定）'}`);
    }
    store.materials.set(bookId, 'cast', castLines.join('\n'));
  } catch { /* cast 材料失败不影响主流程 */ }
  // 在人物弧和十二卷骨架已确定后建立结局蓝图；它先作为本地长期方向保存，
  // 到中后期才完整注入模型，避免开篇被终局字段淹没或过早剧透式写作。
  const plannedEnding = volumes.find(volume => volume.ending_blueprint)?.ending_blueprint;
  ensureEndingBlueprint(bookId, plannedEnding ? { data: plannedEnding } : {});
  // V0.84 修复：rebuildHistory 挪到 cast 落库之后——此前 cast 写入前就重建，重建出的前缀不含 cast，
  // 下一次请求组装含 cast 的新前缀仍全量 miss（一次重建被浪费）
  rebuildHistory(bookId); // V0.20 修复：书纲必须进公共材料前缀（此前书纲全程丢失）
  // 建卷
  const existing = store.volumes.list(bookId);
  if (!existing.length) {
    for (let vi = 0; vi < volumes.length; vi++) {
      const v = volumes[vi];
      // V0.90 修复：模型偶发不给 idx → 按数组序兜底（卷纲 chapters 同款防御）
      const idx = (typeof v.idx === 'number' && v.idx > 0) ? v.idx : vi + 1;
      store.volumes.create(bookId, idx, { title: v.title, goal: v.goal, outline: v, status: 'planned' });
    }
  }
  return outline;
}

/** 生成卷大纲：卷内章节批量创建（planned） */
export async function generateVolumeOutline(bookId, volumeId, { chapterCount = 12, remedyText = '', worldRemedyText = '' } = {}, opts = {}) {
  const onEvent = opts.onEvent;
  const signal = opts.signal;
  const emit = (stage, message) => onEvent?.({ type: 'stage', stage, message });
  emit('setup', '生成卷大纲（章节规划中）…');
  const onRetry = (info) => onEvent?.({
    type: 'api_retry',
    attempt: info.attempt,
    reason: info.reason,
    message: info.message,
    waitMs: info.waitMs,
  });
  const vol = store.volumes.get(volumeId);
  if (!vol) throw new Error('卷不存在');
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const bookSettings = store.books.settings(bookId); // V0.83：文风注入卷大纲
  ensureHistory(bookId);
  const bookOutline = publicMaterialsText(bookId).outline;
  // V0.74：题材感知主角成长状态注入卷大纲（防整卷无成长）；remedyText 透传成长补救桥段
  // V0.76：世界展开状态注入（防整卷困在同一小地域）；worldRemedyText 透传世界展开补救桥段
  const growth = growthStatus(bookId);
  const world = worldExpansionStatus(bookId);
  // V0.80：快感计划贯通——卷大纲对齐全书快感节奏（reward_rhythm/情绪轮换/金手指克制）
  // V0.82：历史题材（史实流）金手指字段按"立身之本"语义注入
  const isHistory = book.genre === '历史';
  const longformPhase = historicalPhaseForVolume(book, vol.idx);
  const seam = buildVolumeSeam(bookId, vol.idx);
  const previousExitYear = Number(seam.lastChapter?.year);
  const longformPhaseText = historicalPhaseText(book, vol.idx, {
    previousExitYear: Number.isInteger(previousExitYear) ? previousExitYear : undefined,
  });
  const lifecycle = buildLifecycleContext(bookId, { volumeIdx: vol.idx });
  const lifecycleText = lifecyclePromptText(lifecycle);
  const pleasurePlanText = (() => {
    try {
      const mat = store.materials.get(bookId, 'pleasure')?.content;
      if (mat) return mat;
      const settings = JSON.parse(book.settings_json || '{}');
      return settings.pleasurePlan ? formatPleasurePlan(settings.pleasurePlan, { isHistory }) : '';
    } catch { return ''; }
  })();
  const tail = [{
    role: 'user',
    content: volumeOutlineInstruction({
      bookTitle: book.title, volumeIdx: vol.idx, volumeTitle: vol.title || `第${vol.idx}卷`,
      bookOutline, chapterCount,
      protagonistPower: growth.text,
      growthDimension: growth.dimension,
      growthExample: growth.example,
      remedyText,
      worldExpansion: world.text,
      worldRemedyText,
      pleasurePlanText,
      // V0.81 历史：时代背景卡（史实锚点/官职/地理/红线）+ 成长波动节奏（蛰伏卷/跃升卷交替）
      eraContext: book.genre === '历史' ? eraContextText(bookId, { scope: 'volume', maxChars: 700 }) : '',
      historyGrowthNote: book.genre === '历史' ? historyGrowthNote() : '',
      // V0.83：文风注入卷大纲（大纲层基调先定对，正文才不漂移）
      styleRules: styleRulesText(bookSettings.styleProfile, bookSettings.styleSample, {
        isHistory: book.genre === '历史', compact: true,
      }),
      // V0.87：战争卷卷纲按战役纪律设计（卷内章节覆盖五段战役节奏：兵临城下→试探→拉锯→转折→收尾）；史实锚定段仅宋末书
      // V0.98.13：短兵血与痛纪律并入同一常量（每战争卷至少一场主角亲历白刃）
      warfareText: isWarfareText(vol.title, vol.goal, vol.outline_json)
 ? (isHistoricalEraBook(book) ? `${WARFARE_BODY_TEXT}\n\n${WARFARE_HISTORY_TEXT}\n\n【本时代战役考据锚点】\n${WARFARE_ANCHORS}` : WARFARE_BODY_TEXT)
        : '',
      // V0.88：权谋/朝堂卷卷纲按权谋纪律设计（皇帝性格定调/暗线四阶段分布/朝堂引爆节奏）；史实锚点段仅宋末书
      courtText: isCourtIntrigueText(vol.title, vol.goal, vol.outline_json)
 ? (isHistoricalEraBook(book) ? `${COURT_INTRIGUE_TEXT}\n\n${COURT_HISTORY_TEXT}\n\n【本时代朝堂考据锚点】\n${COURT_ANCHORS}` : COURT_INTRIGUE_TEXT)
        : '',
      // V0.90：开篇卷含悲剧事件（城破/家破/灭门/覆灭）→ 前 2-3 章必须为铺垫章（结构约束），
 // 防"第 1 章直接破城/开局即屠杀"（用户实测：开篇铺垫不足就全是破）
      volumeBuildupText: vol.idx === 1 && /城破|破城|家破|灭门|覆灭|屠城|沦陷|陷落|屠/.test(`${vol.title || ''} ${vol.goal || ''} ${vol.outline_json || ''}`)
        ? VOLUME_BUILDUP_TEXT
        : '',
      historicalPhaseText: longformPhaseText,
      lifecycleText,
      endingBlueprintText: ['late_middle', 'ending', 'finale'].includes(lifecycle.stage.id) ? lifecycle.endingBlueprintText : '',
      seamText: formatVolumeSeamText(seam),
    }),
  }];
  const messages = assembleMessages(bookId, tail);
  // V0.85：卷大纲解析容错——模型偶发输出坏 JSON（截断/thinking 混入/chapters 非数组）时
  // 自动重试 ≤2 次（注入上次失败提示），仍失败才 throw；此前一次性失败即"卷大纲解析失败"卡死。
  let outline = null;
  let lastReason = '';
  for (let attempt = 0; attempt < 3 && !outline; attempt++) {
    emit('setup', lastReason
      ? `卷大纲第 ${attempt + 1}/3 次生成（上次未过闸：${String(lastReason).slice(0, 180)}）…`
      : `卷大纲第 ${attempt + 1}/3 次生成中…`);
    const content = lastReason ? `${tail[0].content}\n\n【上次生成失败（V0.85 重试）】${lastReason}\n请输出完整的卷大纲 JSON：必须包含 title/goal/chapters 数组（每个章节含 idx/title/beat/pov）。` : tail[0].content;
    const res = await runTask({ task: 'volume_outline', bookId, messages: [{ role: 'user', content }], jsonMode: true, signal, onRetry });
    const parsed = extractJSON(res.content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // chapters 可能是对象（如 {"1":{...}}）→ 转数组；否则视为结构不完整
      let chapters = parsed.chapters;
      if (chapters && !Array.isArray(chapters)) chapters = Object.values(chapters);
      if (Array.isArray(chapters) && chapters.length) {
        const candidate = { ...parsed, chapters };
        const historyValidation = longformPhase
          ? validateHistoricalVolumeOutline(candidate, longformPhase, {
            previousExitYear: Number.isInteger(previousExitYear) ? previousExitYear : undefined,
          })
          : { ok: true, issues: [] };
        const lifecycleValidation = lifecycleEnforcementEnabled(bookId)
          ? validateLifecycleVolumeOutline(candidate, lifecycle)
          : { ok: true, issues: [] };
        const seamValidation = validateVolumeSeam(candidate, seam);
        const issues = [...historyValidation.issues, ...lifecycleValidation.issues, ...seamValidation.issues];
        // V0.107 章数承诺硬校验：章数偏离承诺（容差下 1 上 2）视为结构不完整——
        // 此前三类校验器都不查数量，模型少给章也无感（每卷 12 章的新档位必须真实生效）。
        const targetCount = Math.max(1, Number(chapterCount) || 12);
        if (candidate.chapters.length < targetCount - 1 || candidate.chapters.length > targetCount + 2) {
          issues.push({
            code: 'VOLUME_CHAPTER_COUNT',
            message: `章数 ${candidate.chapters.length} 偏离承诺 ${targetCount} 章（容差 -1/+2）——按承诺章数补足或收敛章节规划，章数服务于卷级节拍（铺垫收紧/升级展开/转折高潮给足/余波短促）`,
          });
        }
        // V0.107 章名句式族/近词根校验：首轮全量纠正（连排 ≥3、占比 >70%、同词根），
        // 后续轮只拦连排 ≥4 硬项（占比/词根类软项不再喂，防重试死循环——番茄实证连续同公式读者疲劳）。
        const shapeIssues = titleShapeStreakIssues(candidate.chapters.map(c => c.title));
        const rootIssues = titleRootRepeatIssues(candidate.chapters.map(c => c.title));
        const shapeFeed = attempt === 0
          ? [...shapeIssues, ...rootIssues]
          : shapeIssues.filter(s => s.hard);
        for (const s of shapeFeed) {
          issues.push({ code: 'TITLE_SHAPE', message: `章名命名：${s.detail}——按【章名工艺】换句式族（极简名词/四字格/动宾/长句/问句轮换）或换词根` });
        }
        if (!issues.length) {
          outline = candidate;
          break;
        }
        lastReason = issues.map(issue => `${issue.chapter ? `第${issue.chapter}章` : '卷级'}[${issue.code}] ${issue.message}`).join('；');
        continue;
      }
    }
    lastReason = `输出未包含有效的 chapters 数组（模型返回结构异常）`;
  }
  if (!outline) {
    throw new Error(`卷大纲解析失败，请重试（已自动重试 3 次，模型返回结构异常）`);
  }
  store.volumes.update(volumeId, {
    outline,
    status: vol.status === 'done' ? 'done' : 'outlined',
    title: outline.title || vol.title,
    goal: outline.goal || vol.goal,
  });
  // 建章（保留已存在章节）。
  // V0.35 修复：章节 idx 必须全书全局连续——AI 生成的卷大纲每卷 idx 都从 1 开始，
  // 直接插入会与前面卷冲突（UNIQUE constraint failed: chapters.book_id, chapters.idx），
  // 导致 pilot 在第二卷建章时崩溃。改用"书内最大 idx + 卷内枚举序"计算全局 idx。
  const allExisting = store.chapters.list(bookId);
  const volumeChapters = store.chapters.listByVolume(volumeId);
  let nextGlobalIdx = allExisting.reduce((m, c) => Math.max(m, c.idx), 0) + 1;
  outline.chapters.forEach((ch, i) => {
    const chapterFrame = {
      beat: ch.beat, pov: ch.pov,
      ...(longformPhase ? {
        year: ch.year, era_year: ch.era_year, protagonist_age: ch.protagonist_age,
        phase: ch.phase, reward_mode: ch.reward_mode, emotion: ch.emotion,
      } : {}),
    };
    const existing = volumeChapters[i];
    if (existing) {
      const hasContent = isCompletedChapter(existing) || store.chapters.fullText(existing.id).trim().length > 0;
      if (!hasContent) {
        store.chapters.update(existing.id, {
          title: ch.title,
          outline: chapterFrame,
          status: 'planned',
        });
      }
    } else {
      store.chapters.create(bookId, volumeId, nextGlobalIdx++, {
        title: ch.title,
        outline: chapterFrame,
        status: 'planned',
      });
    }
  });
  // V0.83：本卷下一层级命中软告警——检查卷内 beat 是否含"下一层级"关键词（新区域落地）；不命中仅提示不硬卡
  try {
    const { worldScaleFor } = await import('../data/creative_packs.js');
    const ws = worldScaleFor(book.genre);
    const nextLevel = (store.volumes.list(bookId).find(v => v.id === volumeId)?.idx || 1) > 1 ? 2 : 1;
    if (ws?.ladderKeywords?.[nextLevel]) {
      const beats = (outline.chapters || []).map(c => `${c.title || ''} ${c.beat || ''}`).join(' ');
      if (!ws.ladderKeywords[nextLevel].test(beats)) {
        emit('setup', `提示：本卷 beat 未出现「${ws.ladder[nextLevel]}」级新区域/势力关键词——若本卷应推进世界展开，请留意（软提示，不阻断）`);
      }
    }
  } catch { /* 世界展开软告警失败不阻塞 */ }
  return outline;
}

/**
 * 生成章细纲（写入 chapters.outline_json）。校验失败自动重试最多 2 次；
 * 生成后做"写前五问"套路自检，未通过则重生成（最多 2 轮）。
 * @param {string} bookId @param {string} chapterId
 */
export async function generateChapterOutline(bookId, chapterId, opts = {}) {
  const onEvent = opts.onEvent;
  const signal = opts.signal;
  const emit = (stage, message) => onEvent?.({ type: 'stage', stage, message });
  const chapter = store.chapters.get(chapterId);
  if (!chapter) throw new Error('章节不存在');
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const bookSettings = store.books.settings(bookId); // V0.83：文风注入细纲
  ensureHistory(bookId);
  // V0.78：重规划原因（replan 时由 pipeline 传入上次审校冲突，注入细纲指令防重蹈覆辙）
  const replanReason = opts.replanReason || '';

  // 上下文：卷目标 + 最近 3 章摘要 + 滚动摘要 + 上一章结尾 + 未来 3 章 + 活跃/遗忘/临近伏笔 + 检索事实
  const vol = chapter.volume_id ? store.volumes.get(chapter.volume_id) : null;
  let volumeOutlineChapters = [];
  try { volumeOutlineChapters = JSON.parse(vol?.outline_json || '{}')?.chapters || []; } catch { volumeOutlineChapters = []; }
  const stageWindow = compileStageWindow(volumeOutlineChapters, chapter.idx);
  const chapters = store.chapters.list(bookId);
  const prevChapters = chapters.filter(c => c.idx < chapter.idx).slice(-3);
  const recentSummaries = prevChapters.map(c => {
    const s = store.summaries.get(c.id);
    const o = store.chapters.outline(c.id);
    return { idx: c.idx, title: c.title, summary: sanitizeStoryMemoryText(s?.summary || o?.actual_beat || o?.goal || '') };
  });
  const rollingSummary = rollingText(bookId); // V0.95：两段式统一读取（兼容旧格式）
  const prevChapter = chapters.find(c => c.idx === chapter.idx - 1);
  // V0.87 修复：store.chapters.get() 返回 DB 原始行（只有 outline_json 串，无 outline 属性），
  // 细纲需经 store.chapters.outline(id) 解析——此前对比铺垫/战役检测的 chapter.outline?.beat 恒为 undefined
  const chOutline = store.chapters.outline(chapterId);
  const lockedChapterFrame = Object.fromEntries(Object.entries(chOutline || {}).filter(([key, value]) => {
    if (![
      'year', 'era_year', 'protagonist_age', 'phase', 'reward_mode', 'emotion',
      'obligations', 'forbidden', 'author_locks', 'authorLocks', 'locked_fields',
      'historical_anchor', 'historical_anchors', 'era_event', 'era_events', 'era_event_ids',
      'must_include', 'must_not', 'constraints', 'contract_promises', 'lifecycle_stage',
      'opening_blueprint', 'opening_slot', 'opening_contract', 'location_lock', 'pov_lock',
    ].includes(key)) return false;
    if (key === 'phase' && isPlanningMetaPhase(value)) return false;
    return true;
  }));
  const historicalChapterFrame = (() => {
    if (book.genre !== '历史') return '';
    const phase = historicalPhaseForVolume(book, vol?.idx || 1);
    if (!phase) return '';
    const year = Number(chOutline?.year) || phase.startYear;
    const age = Number(chOutline?.protagonist_age) || (year - 1232);
    const chapterPhase = (chOutline?.phase && phaseHasVerifiableAction(chOutline.phase))
      ? chOutline.phase
      : '';
    return `公元${year}年｜${chOutline?.era_year || '年号须据公元年核对'}｜主角${age}岁｜阶段：${chapterPhase || '须写可在场的人物行动，勿填卷名或文学结果口号'}｜回报：${chOutline?.reward_mode || phase.rewardModes?.[0] || '信息'}｜情绪：${chOutline?.emotion || phase.emotions?.[0] || '紧张5'}`;
  })();
  // V0.95.8 山河尺度节拍：细纲层就把远景/中景/全景配额落到具体场景与载体（写作才有得执行）
  const scaleBeatRule = book.genre === '历史'
    ? historicalScaleBeatRule(vol?.idx || 1, historicalPhaseForVolume(book, vol?.idx || 1))
    : '';
  const lifecycle = buildLifecycleContext(bookId, { volumeIdx: vol?.idx || 1 });
  const volumeChapters = vol ? store.chapters.listByVolume(vol.id).sort((a, b) => a.idx - b.idx) : [];
  const lastVolumeChapter = volumeChapters.at(-1);
  const finalChapterMode = lifecycle.stage.id === 'finale' && lastVolumeChapter?.id === chapter.id;
  // V0.83：上一章结尾优先取 ending_hook 原文 + 末 400 字正文（此前只取末 300 字再被模板二次截到 200，
  // 若上一章正处在动作中段而非钩子处，细纲拿到的就不是钩子文本）
  const prevChapterTail = (() => {
    if (!prevChapter) return '';
    const o = store.chapters.outline(prevChapter.id);
    const hook = o?.ending_hook ? (typeof o.ending_hook === 'string' ? o.ending_hook : o.ending_hook.desc || '') : '';
    const tail = store.chapters.fullText(prevChapter.id).slice(-400);
    return hook ? `${tail}\n【上章结尾钩子】${hook}` : tail;
  })();
  const futureChapters = chapters.filter(c => c.idx > chapter.idx).slice(0, 3).map(c => {
    const o = store.chapters.outline(c.id);
    return { idx: c.idx, title: c.title, beat: o?.beat || '' };
  });
  const horizon = buildChapterHorizon(bookId, chapter.idx);
  const horizonText = formatChapterHorizonText(horizon);
  const active = selectActiveForeshadowsForChapter(bookId, chapter.idx);
  const selectedIds = new Set(active.map(f => f.id));
  const forgotten = store.foreshadows.forgotten(bookId, chapter.idx).filter(f => selectedIds.has(f.id));
  const approaching = store.foreshadows.approachingPayoff(bookId, chapter.idx).filter(f => selectedIds.has(f.id));
  const relFacts = await relevantFactsSmart(bookId, `第${chapter.idx}章 ${chapter.title || ''}`, 8);
  // V0.83：上一章"为后续铺垫"承诺（章间铺垫传递闭环）
  const prevContinuityTo = prevChapter ? (store.chapters.outline(prevChapter.id)?.continuity_to || '') : '';
  // V0.86：悲剧/变故章细纲按"先立后破"设计——城破/灭门/大战/死亡/家破/殉难等章节，
  // 细纲场景安排先铺千家灯火市井风情与羁绊人物（玩伴/大叔），再让变故降临（细纲层就定好铺垫节奏）
  // V0.90：结构硬约束——"立"必须成场景（≥2 铺垫场景在变故前），变故不得默认放第 1 场景（用户实测：铺垫不够就全是破）
  const isTragedyChapter = /城破|灭门|屠|覆灭|家破|殉|殁|遇害|惨死|大战|决战|陷落/.test(`${chapter.title || ''} ${vol?.goal || ''} ${chOutline?.beat || ''} ${prevContinuityTo || ''}`);
  const contrastBuildup = isTragedyChapter
    ? `${CONTRAST_BUILDUP_TEXT}\n\n${BUILDUP_STRUCTURE_TEXT}`
    : '';
  // V0.87：战役章细纲按战役纪律设计（五段节奏/战术逻辑/信息差/视角/史实锚定）；V0.98.13 并入近战残酷纪律；史实锚定段仅宋末书
  const warfareText = isWarfareText(chapter.title, vol?.goal, chOutline?.beat, futureChapters.map(f => f.beat || '').join(' '))
 ? (isHistoricalEraBook(book) ? `${WARFARE_BODY_TEXT}\n\n${WARFARE_HISTORY_TEXT}\n\n【本时代战役考据锚点】\n${WARFARE_ANCHORS}` : WARFARE_BODY_TEXT)
    : '';
  // V0.88：朝堂/权谋章细纲按权谋纪律设计（皇帝性格定调/双层对话/信息差/暗线四阶段/代价）；史实锚点段仅宋末书
  const courtText = isCourtIntrigueText(chapter.title, vol?.goal, chOutline?.beat, futureChapters.map(f => f.beat || '').join(' '))
 ? (isHistoricalEraBook(book) ? `${COURT_INTRIGUE_TEXT}\n\n${COURT_HISTORY_TEXT}\n\n【本时代朝堂考据锚点】\n${COURT_ANCHORS}` : COURT_INTRIGUE_TEXT)
    : '';

  // V0.94.0：上一章钩型（钩型多样性纪律——同型钩不得连用）
  const prevHookType = (() => {
    if (!prevChapter) return '';
    const h = store.chapters.outline(prevChapter.id)?.ending_hook;
    return (h && typeof h === 'object' && h.type) ? String(h.type) : '';
  })();

  const diversityContract = compileBookDiversityContract(bookId, chapter.idx);

  const content = appendPublicationFeedback(chapterOutlineInstruction({
    bookTitle: book.title, chapterIdx: chapter.idx,
    volumeGoal: vol?.goal || '',
    recentSummaries,
    rollingSummary,
    prevChapterTail,
    futureChapters,
    activeForeshadows: active,
    forgottenForeshadows: forgotten,
    approachingForeshadows: approaching,
    retrieved: relFacts.length ? formatFacts(relFacts).split('\n') : [],
    pleasureContext: buildPleasureContext(bookId, chapter.idx, { compact: true, maxChars: 1700 }),
    narrativeLessons: narrativeLessonsText(bookId, chapter.idx),
    rollCallText: characterRollCallText(bookId, { limit: 10, chapterIdx: chapter.idx }),
    perspective: book.perspective || 'third', // V0.42 叙述视角 // V0.37：角色点名册
    chapterLength: lengthProfileOf(book), // V0.43：作品级每章目标字数
    // V0.74：题材感知主角成长状态（防成长停滞；维度/示例按题材注入）
    powerStatus: [growthStatus(bookId, { chapterIdx: chapter.idx }).text, longRunningStateDebtText(bookId, chapter.idx)].filter(Boolean).join('\n'),
    growthDimension: growthStatus(bookId, { chapterIdx: chapter.idx }).dimension,
    growthExample: growthStatus(bookId, { chapterIdx: chapter.idx }).example,
    // V0.76：世界展开轻量提示（本卷新区域落地）
    worldExpansion: worldExpansionStatus(bookId).shortText,
    // V0.80：前20章开篇蓝图·本章槽位（钩子/爽点/金手指里程碑/目标阶段——防前N章平淡、防承诺落空）
    openingBlueprint: formatChapterBlueprint(bookId, chapter.idx),
    openingContractText: openingReaderContractText(bookId, chapter.idx),
    historicalChapterFrame,
    scaleBeatRule, // V0.95.8：山河尺度节拍（远景/中景/全景配额落场景与载体）
    // V0.81 历史：时代红线/可改史点节选 + 历史去AI味 + 诗词候选
    eraContext: book.genre === '历史' ? eraContextText(bookId, { scope: 'chapter', maxChars: 300 }) : '',
    historyDeAI: book.genre === '历史' ? HISTORY_DEAI_TEXT : '',
    poetryText: book.genre === '历史' ? poetryForScene(`${chapter.title || ''} ${(vol?.goal || '')} ${(chOutline?.beat || '')}`.trim(), '').text : '',
    // V0.82 历史：史实边界（细纲阶段就防"事件提前/改写前因"硬伤）
    eraBoundary: book.genre === '历史' ? eraBoundaryText(bookId, Number(chOutline?.year) || currentStoryYear(bookId)) : '',
    // V0.83：文风注入章细纲 + 上一章"为后续铺垫"承诺（章间铺垫传递闭环）
    styleRules: styleRulesText(bookSettings.styleProfile, bookSettings.styleSample, {
      isHistory: book.genre === '历史', compact: true,
    }),
    prevContinuityTo,
    reconcileSeed: sanitizeReconcileSeed(chOutline?.reconcile_seed || null, { title: chapter.title || '' }),
    lockedChapterFrame,
    // V0.86：悲剧/变故章细纲按"先立后破"设计——城破/灭门/大战/死亡/家破/殉难等章节，
    // 细纲场景安排先铺千家灯火市井风情与羁绊人物（玩伴/大叔），再让变故降临（细纲层就定好铺垫节奏）
    contrastBuildup,
    // V0.87：战役章细纲按战役纪律设计
    warfareText,
    // V0.88：朝堂/权谋章细纲按权谋纪律设计
    courtText,
    lifecycleText: lifecyclePromptText(lifecycle),
    endingBlueprintText: ['late_middle', 'ending', 'finale'].includes(lifecycle.stage.id) ? lifecycle.endingBlueprintText : '',
    finalChapterMode,
    prevHookType, // V0.94.0：钩型多样性（同型钩不得连用）
    horizonText, // V0.102：章级有界长线简报，禁止整表灌入
    diversityText: diversityContract.text, // V0.103：近窗换轴，不灌同构考卷
    stageOccupancyText: formatStageOccupancyText(stageWindow),
  }), bookId, { targetChapterIdx: chapter.idx });

  let lastErr = null;
  let lastFailReason = '';
  let lastGoodOutline = null; // V0.35：记录最后一次合法细纲，供降级放行复用
  for (let attempt = 0; attempt < 3; attempt++) {
    emit('outline', `章细纲第 ${attempt + 1}/3 版生成中，模型正在推演结构与连续性…`);
    // V0.35：第 2 次起把上次未通过原因注入指令，要求按原因修订（此前每次全新重生成，3 轮全浪费）
    // V0.78：replan 重规划时注入上次审校冲突原因，避免重生成细纲又引入同一问题（如未登记角色"老幺"）
    let extra = '';
    if (replanReason) extra += `\n\n【上次审校冲突（本次重规划必须避免）】\n${replanReason}\n请调整细纲设计以消除这些冲突：若冲突涉及未登记角色，请用【新设定:人物名——身份】登记或改用已有角色；若涉及事实矛盾，请改用与既定事实一致的设定。不要重复引入同一问题。`;
    if (lastFailReason) extra += `\n\n【上一版未通过写前自检】${lastFailReason}\n请保留章节结构与核心设计，针对未通过项逐条修改，不要整体重写，不要为过闸补远方钩或审讯。`;
    const content2 = extra ? content + extra : content;
    const messages = assembleCreativeMessages(bookId, [{ role: 'user', content: content2 }], {
      chapterId,
      recentChapterCount: 2,
    });
    const res = await runTask({ task: 'chapter_outline', bookId, chapterId, messages, jsonMode: true, signal });
    const outline = extractJSON(res.content);
    // V0.54：结构不合法降级——只要解析出 scenes（每场景有 beat）就补默认 checkpoints 放行，
    // 不再因 checkpoints/pace/character_beat 等辅助字段缺失而废掉整章（此前 3 次失败直接中断全书创作）
    let usable = outline && validateChapterOutline(outline);
    if (!usable && outline && Array.isArray(outline.scenes) && outline.scenes.length &&
        outline.scenes.every(s => s && s.beat && typeof s.beat === 'string')) {
      usable = true;
      outline.checkpoints = Array.isArray(outline.checkpoints) && outline.checkpoints.length
        ? outline.checkpoints : (outline.scenes || []).map(s => s.beat || '');
    }
    if (usable) {
      const framedOutline = mergeHistoricalChapterFrame(outline, chOutline, historicalPhaseForVolume(book, vol?.idx || 1) || {});
      Object.assign(outline, framedOutline);
      // V0.95.6：beat 已落实、仅 checkpoint 缺概念词时本地愈合——不再为措辞差异整版重掷
 //（实测 ch27 实证 8 连败：指令要求写关键词，模型 8 次都只写进 beat 不写进 checkpoint）
      if (book.genre === '历史' && healHistoricalCheckpointGap(outline)) {
        emit('setup', '阶段任务检查点已本地补全（场景节拍已落实，仅检查点措辞缺词），细纲予以放行');
      }
      if (healOutlineWordTargets(outline, lengthProfileOf(book))) {
        emit('setup', '场景字数配额已本地补到单章硬下限（只改正数，不改节拍）');
      }
      const historicalIssues = book.genre === '历史'
        ? [
            ...historicalOutlineIssues(outline),
            ...historicalYouthAuthorityIssues({
              bookTitle: book.title,
              genre: book.genre,
              year: outline.year,
              protagonistAge: outline.protagonist_age,
              outline,
            }),
          ]
        : [];
      if (historicalIssues.length) {
        lastFailReason = historicalIssues.map(item => item.issue).join('；');
        lastErr = Object.assign(new Error(`历史细纲硬防线未通过：${lastFailReason}`), { code: 'OUTLINE_GUARD_FAILED' }); // V0.93.3：带码上抛，供失败策略归类质量门
        emit('setup', `历史阶段或人物权限未通过硬校验（${lastFailReason.slice(0, 80)}），正在重做细纲…`);
        continue;
      }
      // V0.94.0：细纲质量门（单章字数下限 + 场景功能去重，全部题材）——不过则带原因重试
      const qualityIssues = chapterOutlineQualityIssues(outline, {
        chapterLength: lengthProfileOf(book),
        existingCharacterNames: store.characters.list(bookId).map(character => character.name),
        recentPatterns: store.narrativePatterns.list(bookId, { beforeChapter: chapter.idx, limit: 5 }),
        strictDramaticContract: true,
        diversityContract,
        stageWindow,
      });
      const hasHardQualityIssue = qualityIssues.some(issue => issue.hard);
      if (qualityIssues.length && (attempt < 2 || hasHardQualityIssue)) {
        lastFailReason = qualityIssues.map(i => i.issue).join('；');
        lastErr = Object.assign(new Error(`细纲质量门未通过：${lastFailReason}`), { code: 'OUTLINE_GUARD_FAILED' });
        emit('setup', `细纲质量门未通过（${lastFailReason.slice(0, 40)}…），正在重做…`);
        continue;
      }
      const horizonIssues = validateChapterHorizon(outline, horizon).issues;
      if (horizonIssues.length) {
        lastFailReason = horizonIssues.map(issue => issue.message).join('；');
        lastErr = Object.assign(new Error(`细纲长线简报未通过：${lastFailReason}`), { code: 'OUTLINE_GUARD_FAILED' });
        emit('setup', '细纲未通过长线简报校验，正在重做…');
        continue;
      }
      lastGoodOutline = outline;
      // V0.100：reader_pull 已由戏剧契约硬门负责；ending_hook 只表示“新未决事件”，
      // 不再按平台强迫每章填写，避免烟柱/密信/脚步声式万能悬崖连续复读。
      // 写前五问自检（AI 本位套路质检，不过则修订重试）
      const five = await fiveQuestionsCheck(bookId, chapterId, outline, { signal });
      if (five.pass) {
        if (chOutline?.reconcile_seed && chOutline?._narrative_revision?.id) {
          outline._narrative_revision = {
            id: chOutline._narrative_revision.id,
            state: 'aligned',
            source: 'reconcile_seed',
          };
        }
        store.chapters.update(chapterId, { outline }); // V0.45：不覆盖章名（章名由卷大纲定+对齐系统检测修正；细纲 title 存 outline 内）
        transitionChapterStatus(bookId, chapterId, 'outlined', { reason: '细纲生成完成' });
        emit('setup', '细纲生成完成，五问自检通过');
        return outline;
      }
      lastFailReason = five.failReason || '未说明';
      lastErr = new Error(`套路自检未通过：${lastFailReason}`);
      emit('setup', `套路自检未通过（${lastFailReason.slice(0, 40)}），正在修订细纲…`);
    } else {
      lastErr = new Error(`章细纲结构不合法（第 ${attempt + 1} 次尝试）`);
    }
  }
  // V0.35：3 轮仍不过 → 降级放行（AI 本位：质检不阻断成书，记债继续；此前直接抛错导致全书卡死）
  if (lastErr?.message?.startsWith('套路自检') && lastGoodOutline) {
    if (chOutline?.reconcile_seed && chOutline?._narrative_revision?.id) {
      lastGoodOutline._narrative_revision = {
        id: chOutline._narrative_revision.id,
        state: 'aligned',
        source: 'reconcile_seed',
      };
    }
    store.chapters.update(chapterId, { outline: lastGoodOutline, title: lastGoodOutline.title || '' });
    transitionChapterStatus(bookId, chapterId, 'outlined', { reason: '自检降级放行' });
    emit('setup', `套路自检 3 次未通过（${lastErr.message.slice(0, 50)}），已降级放行继续写作`);
    return lastGoodOutline;
  }
  throw lastErr;
}

/** 写前六问自检（V0.49：五问→六问，加 q6 人物情感变化；平台差异化判定） */
export async function fiveQuestionsCheck(bookId, chapterId, outline, opts = {}) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const chapter = store.chapters.get(chapterId);
  const messages = assembleReviewMessages(bookId, [{
    role: 'user',
    content: fiveQuestionsInstruction({
      bookTitle: book.title, chapterIdx: chapter.idx, chapterTitle: outline.title || chapter.title, outline,
      isHistory: book.genre === '历史',
    }),
  }]);
  const res = await runTask({ task: 'coverage', bookId, chapterId, messages, jsonMode: true, signal: opts.signal });
  const parsed = extractJSON(res.content);
  if (!parsed) return { pass: false, failReason: '自检解析失败' };
  return evaluateOutlineQuestions(parsed, {
    platform: book.platform || '通用',
    isHistory: book.genre === '历史',
    pace: outline?.pace || '',
    rewardMode: outline?.reward_mode || '',
    readerPull: outline?.reader_pull || '',
  });
}

/** 纯判定器：把平台/题材分流从模型自报 pass 中分离，避免历史铺垫章被物理冲突模板误杀。 */
export function evaluateOutlineQuestions(parsed, { platform = '通用', isHistory = false, pace = '', rewardMode = '', readerPull = '' } = {}) {
  if (!parsed || typeof parsed !== 'object') return { pass: false, failReason: '自检解析失败' };
  const pull = String(readerPull || parsed.reader_pull || '').trim();
  const hasConcretePull = pull.length >= 4 && pull !== '无';
  const q4Hook = !!parsed.q4_ending_hook && !String(parsed.q4_ending_hook).includes('无');
  const q4 = q4Hook || hasConcretePull;
  if (isHistory) {
    const q6 = !!parsed.q6_emotional_change && parsed.q6_emotional_change !== '无';
    const rv = parsed.reader_value;
    const rvType = typeof rv === 'object' ? rv?.type : '';
    const rvGain = typeof rv === 'object' ? rv?.gain : rv;
    const legacyGain = parsed.q3_satisfaction;
    const hasReaderValue = (!!rvGain && rvGain !== '无' && rvType !== '无')
      || (!!legacyGain && legacyGain !== '无');
    const setupLike = pace === 'setup' || pace === 'daily';
    const pass = q4 && (hasReaderValue || (setupLike && q6));
    const failBits = [];
    if (!q4) failBits.push('缺少有效章末钩子或由本章因果长出的阅读余力');
    if (!hasReaderValue && !(setupLike && q6)) failBits.push(`缺少具体阅读回报${rewardMode ? `（计划类型：${rewardMode}）` : ''}`);
    return { pass, detail: parsed, failReason: pass ? '' : (failBits.join('；') || parsed.fail_reason || '未说明') };
  }

  // 非历史题材保持旧平台判定：番茄信任全项 pass；起点 q1+q4；通用 q4。
  const q1 = !!parsed.q1_visible_harm && parsed.q1_visible_harm !== '无';
  const all = parsed.pass === true;
  if (all) return { pass: true, detail: parsed, failReason: '' };
  let pass;
  if (platform === '番茄') pass = all;
  else if (platform === '起点') pass = q1 && q4;
  else pass = q4;
  return { pass, detail: parsed, failReason: pass ? '' : (parsed.fail_reason || (q4 ? '未说明' : '缺少有效章末钩子或由本章因果长出的阅读余力')) };
}

/** 书级大纲 → 公共材料文本（kind=outline 存储格式） */
export function formatBookOutline(o) {
  const vols = (o.volumes || []).map(v => {
    const lifecycle = v.lifecycle_stage ? `【${v.lifecycle_stage}｜转折：${v.stage_turn || '待细化'}】` : '';
    return `第${v.idx}卷《${v.title}》：${v.goal}。${v.summary || ''}${lifecycle}`;
  }).join('\n');
  const chars = (o.main_characters || []).map(c => `- ${c.name}：${c.role}（${c.traits || ''}）`).join('\n');
  return `书名：《${o.title}》
一句话梗概：${o.logline || ''}
主题：${o.theme || ''}｜基调：${o.tone || ''}

世界观：${o.worldview || ''}

主角：${o.protagonist?.name || ''}（${o.protagonist?.role || ''}）
目标：${o.protagonist?.goal || ''}｜缺陷：${o.protagonist?.flaw || ''}｜弧线：${o.protagonist?.arc || ''}

主要配角：
${chars || '（无）'}

【分卷规划】（V0.83 标记：buildPublicMaterials 按此前缀剥离书纲世界观段，消除与 world 详设重复）
${vols}

黄金三章要求：${o.golden_first_chapters || ''}`;
}

/** V0.43：作品级每章目标字数（settings.lengthProfile，默认按题材推荐） */
export function lengthProfileOf(book) {
  const s2 = (() => { try { return JSON.parse(book?.settings_json || '{}'); } catch { return {}; } })();
  if (s2.lengthProfile) return s2.lengthProfile;
  const map = { '玄幻': 3500, '仙侠': 3500, '都市': 3000, '科幻': 3000, '悬疑': 2800, '言情': 3000, '历史': 3500, '游戏': 3000, '无限流': 3200 };
  return map[book?.genre] || 3200;
}

/** V0.83：卷章数统一（此前 pilot 硬编码 6、continuation 8、卷纲默认 8 散落不一致）。
 *  V0.107：分章科学化——首卷 8 / 常规 12 / 丰满 14（用户定调"每卷分章更多、更科学"：
 * 实测 15 卷恒 8 章太碎，卷是完整叙事弧不是事件片段；已写卷不动，新建卷起生效）。 */
export function volumeChapterCount(book, { isFirst = false } = {}) {
  const len = lengthProfileOf(book);
  if (len >= 4500) return 14; // 丰满档位
  if (isFirst) return 8;      // 首卷（黄金开篇，前 8 章走完立人设+首个不可逆转折）
  return 12;                  // 常规卷（完整走过铺垫→升级→转折→高潮→余波节拍）
}
