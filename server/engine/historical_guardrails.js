// server/engine/historical_guardrails.js —— 历史长篇的确定性连续性硬防线
'use strict';

/**
 * V0.93.2：宋末钓鱼城题材锚定判定——收敛为题材开关。
 * 生产路径（audit/outline）已按 genre==='历史' 门控，显式传 genre 即可；
 * 书名正则只作为无 genre 信息时的兼容回退（维护脚本等），单一实现不再四处复制。
 */
export function isHistoricalEraGuard({ genre = '', bookTitle = '' } = {}) {
  if (genre) return genre === '历史';
 return /示例历史长篇|宋|钓鱼城/.test(String(bookTitle || ''));
}

function compact(value) {
  return String(value || '').replace(/\s+/g, '');
}

function issue(type, quote, message, fix, extra = {}) {
  return {
    type,
    severity: 'high',
    quote: String(quote || '').slice(0, 180),
    issue: message,
    fix,
    ...extra,
  };
}

/**
 * 历史阶段常见任务的同义词。这里不追求语言学完备，只识别会造成剧情根因漂移的核心动作。
 * 词组按“概念”计数，因此“安葬和营中安置”可覆盖“安葬与安置，建立生存根基”。
 */
const PHASE_CONCEPTS = [
  ['安葬', /安葬|下葬|埋葬|入土|归葬|立坟|新坟/],
  ['安置', /安置|留在营中|留营|获准留下|住下|落脚|容身/],
  ['生存根基', /生存根基|扎根|立足|活路|落脚|容身/],
  ['筑城', /筑城|营城|营造|筑垒|砌墙|城墙|垒石/],
  ['勘线', /勘线|勘测|测线|测绘|验图|定线|量地/],
  ['职责', /职责|职分|差事|任用|分工|当差/],
  ['从军', /从军|入伍|投军|编入军中|军籍/],
  ['识字', /识字|认字|读书|写字/],
  ['生存', /求生|活下去|生存|觅食|逃难/],
  ['山城防御体系', /山城防御|山城全局|三江.{0,16}城线|城线.{0,16}(?:水池|道路|暗门)/],
  ['拓宽视野', /拓宽视野|理解.{0,8}(?:全局|体系)|认识.{0,8}(?:全局|体系)|巡看.{0,20}(?:三江|城线|水池|暗门)/],
  ['警戒', /警戒|夜哨|巡哨|哨情|回灯/],
  ['信息交接', /信息交接|(?<!权力)交接(?!前奏)|传讯|口信|回报|呈报/],
  ['工地险情', /工地险情|塌方|山石滚落|料道.{0,8}(?:裂|滑)/],
  ['同伴担当', /同伴担当|护住同伴|推出.{0,6}(?:阿蛮|同伴)|拉绳撤离|救人/],
  ['有限工组责任', /有限工组责任|工组.{0,8}(?:记录|守绳|分绳|轮歇)|承担.{0,8}工组/],
  ['承担失败', /承担失败|接受追责|承担.{0,8}(?:责任|迟报)|撤去.{0,8}责任|认错/],
  ['预警程序', /预警程序|撤离程序|观雨.{0,8}看水|撤离.{0,8}(?:表|次序|演练)/],
  ['工程结算', /工程结算|工程验收|阶段工程.{0,8}(?:完成|验收)|工簿.{0,8}验收/],
  ['羁绊', /羁绊|可靠同伴|彼此信任|共同劳作/],
  ['志向', /志向|守护动机|想守住|正式从军|守土/],
  ['难民', /难民|流民|逃户|饥民|撤民|进寨|入寨|避入城/],
  ['围城', /围城|合围|围困|攻城|临战|入蜀|城下/],
  ['越权', /越权|请领|独立处置|自行决断|临时调度/],
];

const PHASE_META_TOKEN = /^(?:接住上卷出口|承接上卷(?:出口|结果|后果)?|上卷出口|建立新压力源|新压力源|成长补救|布局|高潮前奏|卷级转折|卷末结算|代价面|阶段任务)$/;
const PHASE_META_PREFIX = /^(?:接住上卷出口|承接上卷(?:出口|结果|后果)?|上卷出口|建立新压力源|新压力源|成长补救|布局|高潮前奏|卷级转折|卷末结算|代价面|阶段任务)/;
/** 文学结果口号：可当细纲目标，不能当 scene.beat 必须逐字抄写的在场动作。 */
const PHASE_OUTCOME_SLOGAN = /受挫.{0,16}代价|付代价|确立.{0,16}(?:逻辑|战术|打法)|新战术逻辑|战术跃迁|信念重塑|视野跃迁|政治压力|压力初现|战后清理|朝堂权谋|权谋介入|介入战场|内部信任|信任危机|战略预警|历史转折|情感事件|权力交接|交接前奏|政治博弈|新区域展开|阵营内部|身份跃迁/;

/** 南宋末年号→公元年映射（本书时间轴覆盖段；单一真源，检测复用）。 */
export const ERA_YEAR_MAP = Object.freeze({
  '端平': 1234, '嘉熙': 1237, '淳祐': 1241, '宝祐': 1253,
  '开庆': 1259, '景定': 1260, '咸淳': 1265, '德祐': 1275,
});

const ERA_TITLE_NUMERALS = '元一二三四五六七八九十';

/** 纯字符串扫描：text 中所有「年号+元/数字+年」标题（如 开庆元年/景定五年）。 */
function findEraTitles(text) {
  const found = [];
  for (const era of Object.keys(ERA_YEAR_MAP)) {
    let idx = text.indexOf(era);
    while (idx >= 0) {
      const rest = text.slice(idx + era.length);
      let offset = 0;
      while (offset < rest.length && ERA_TITLE_NUMERALS.includes(rest[offset]) && offset < 3) offset++;
      if (offset > 0 && rest[offset] === '年') {
        found.push({ era, title: text.slice(idx, idx + era.length + offset + 1), index: idx });
      }
      idx = text.indexOf(era, idx + era.length);
    }
  }
  return found;
}

/**
 * V0.105.7 章首年号锚点核验：正文开头出现的年号与章纲 era_year 不一致 → 年号倒退/
 * 跳跃硬错（实测 ch52 首句「开庆元年」而章纲为景定五年，倒退四年且全章再无纪年，
 * 章名「帝星陨落」承诺的理宗驾崩剧情零着墨——读者审读实证）。回忆引语豁免。
 * proseFix：一处措辞改年号即可，绝不 replan。
 */
export function eraAnchorIssues(chapterText, { era_year, year } = {}) {
  const head = String(chapterText || '').slice(0, 240);
  const outlineEra = String(era_year || '').trim();
  if (!head || (!outlineEra && !year)) return [];
  const issues = [];
  for (const hit of findEraTitles(head)) {
    if (outlineEra && outlineEra.startsWith(hit.era)) continue;
    const before = head.slice(Math.max(0, hit.index - 12), hit.index);
    if (/想起|回忆|那年|当年|犹记|曾于|犹在/.test(before)) continue;
    issues.push({
      type: '时间线冲突', severity: 'high', proseFix: true,
      quote: hit.title,
      issue: '正文开头年号「' + hit.title + '」与本章章纲年号「' + (outlineEra || year + '年') + '」不一致——年号倒退或跳跃，读者会直接失向',
      fix: '把开头年号统一为「' + (outlineEra || '') + '」（公元' + (year || '?') + '年），或改写为明确的回忆引语',
    });
  }
  return issues;
}

/** 「情感事件/权力交接前奏」这类斜杠分类标签不是可在场落地的人物行动。 */
function isSlashCategoryTag(phase) {
  const raw = String(phase || '').trim();
  if (!/[\/／]/.test(raw)) return false;
  const parts = compact(raw).split(/[\/／]/).filter(Boolean);
  if (parts.length < 2) return false;
  if (!parts.every((part) => part.length >= 2 && part.length <= 8 && !/[。！？]/.test(part))) return false;
  return !parts.some((part) => phaseHasKnownActionConcept(part) || phaseHasTransitionShape(part));
}

function phaseHasKnownActionConcept(phase) {
  const original = compact(phase);
  const source = normalizePhaseSource(phase);
  return PHASE_CONCEPTS.some(([, matcher]) => matcher.test(source) || matcher.test(original));
}

function phaseHasTransitionShape(phase) {
  const source = compact(normalizePhaseSource(phase));
  return /^从.{1,24}到.{1,24}/.test(source) || /^从.{1,24}到.{1,24}/.test(compact(phase));
}

/** 卷/章 phase 若只是规划套话，不能当可在 scene.beat 落地的人物行动。 */
export function isPlanningMetaPhase(phase) {
  const raw = String(phase || '').trim();
  if (!raw) return false;
  const head = compact(raw.split(/[:：]/)[0]);
  if (PHASE_META_TOKEN.test(head)) return true;
  if (PHASE_META_PREFIX.test(compact(raw))) return true;
  if (isSlashCategoryTag(raw)) return true;
  const blob = compact(raw);
  if (PHASE_OUTCOME_SLOGAN.test(blob) || PHASE_OUTCOME_SLOGAN.test(head)) {
    return !phaseHasKnownActionConcept(raw);
  }
  return false;
}

/** 本地硬闸只核验在场动作（难民/围城/越权、从A到B、具体行动短语），不核验文学结果口号。 */
export function phaseHasVerifiableAction(phase) {
  const raw = String(phase || '').trim();
  if (!raw) return false;
  if (phaseHasKnownActionConcept(raw) || phaseHasTransitionShape(raw)) return true;
  if (isPlanningMetaPhase(raw)) return false;
  // 卷名/章名式短标签（钓鱼城头、血染干沟）不是可核验在场动作；「巡逻队带队考验」更长且含工序，仍走硬闸。
  const token = compact(raw);
  if (token.length <= 6 && !/[，,、；;]/.test(raw)) return false;
  return true;
}

/** 章名不是目标。标题/过短 goal 改从已发生结果编译，避免下一章细纲只接到空壳。 */
export function sanitizeReconcileSeed(seed, { title = '' } = {}) {
  if (!seed || typeof seed !== 'object') return seed;
  const next = { ...seed };
  const goal = String(next.goal || '').trim();
  const heading = String(title || '').trim();
  const bridge = String(next.bridge_from_actual || '').trim();
  if (!goal || (heading && goal === heading)) {
    next.goal = bridge
      ? `从已发生结果继续：${bridge.slice(0, 100)}`
      : '处理上一章造成的新局面';
  }
  return next;
}

const PHASE_PREFIX = /^(?:阶段任务|完成|建立|获得|开始|进入|推进|实现|进行|主动|尝试)/;

function normalizePhaseSource(phase) {
  const extras = [];
  let source = compact(phase).replace(/[（(]([^）)]+)[）)]/g, (_, inner) => {
    extras.push(String(inner).replace(/[+＋]/g, '，'));
    return '，';
  });
  source = source.replace(/[+＋]/g, '，').replace(/[:：]/g, '，');
  if (extras.length) source = `${source}，${extras.join('，')}`;
  return source;
}

/**
 * V0.95.5 结构分词：过渡式/无分隔长短语兜底。
 * 「从A到B的C」→ [A, B, C]（两端点在场=任务落实）；无分隔长句按「的」切分。
 * 背景：ch27 阶段任务「从执行者到布防者的过渡起点」在概念表无命中、无连接词可切，
 * 退化为整句 13 字精确匹配——重规划候选把「过渡起点」写成「转变」即 5 连败卡章。
 * 单调放松：整句原文命中时所有子概念必然命中，旧通过者不受影响。
 */
function structuralConcepts(source) {
  const transition = source.match(/^从(.+?)到(.+?)(?:的(.+))?$/);
  if (transition) {
    const parts = [transition[1], transition[2], ...(transition[3] ? [transition[3]] : [])]
      .map(p => p.trim()).filter(p => p.length >= 2);
    if (parts.length >= 2) return parts;
  }
  if (source.length >= 8 && source.includes('的')) {
    const parts = source.split('的').map(p => p.trim()).filter(p => p.length >= 2);
    if (parts.length >= 2) return parts;
  }
  return null;
}

function phaseConcepts(phase) {
  const original = compact(phase);
  const source = normalizePhaseSource(phase);
  const known = PHASE_CONCEPTS.filter(([, matcher]) => matcher.test(source) || matcher.test(original));
  if (known.length) {
    // “生存根基”已包含“生存”时只算一个概念，避免派生词重复抬高命中阈值。
    return known.filter(([label]) => !known.some(([other]) => other !== label && other.includes(label)))
      .map(entry => [...entry, 'table']);
  }

  const connectorSplit = source
    .split(/[，,、；;\/]|(?:以及|并且|同时|然后|与|和|及)/)
    .map(part => part.replace(PHASE_PREFIX, ''))
    .filter(part => part.length >= 2 && !PHASE_META_TOKEN.test(part));
  if (connectorSplit.length > 1) {
    // V0.105.6：连接词切出的复合口号（北崖善后/粮道破局）用域内窗匹配——语义等价
    // 本地不可判，本地闸只拦结构性完全换题（零交集），任务完成度交审校语义核验。
    return connectorSplit.map(part => [part, slidingWindowMatcher(part), 'cut']);
  }
  // V0.95.5：连接词切不动时走结构分词，防单概念=整句精确匹配误杀同义改写
  const structural = structuralConcepts(source) || structuralConcepts(original);
  if (structural) {
    // 过渡式「从执行者到布防者」两端点在场才算完成转变——保持字面匹配与多数命中
    // 契约（v148：仅一端点在场判未落实）。
    return structural
      .filter(part => !PHASE_META_TOKEN.test(part))
      .map(part => [part, literalMatcher(part), 'structural']);
  }
  return connectorSplit.map(part => [part, literalMatcher(part), 'single']);
}

function literalMatcher(label) {
  return new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/** 切分短语的全部 2 字滑窗联合（地名锚/动作核/任意词根在场即视为同域）。 */
function slidingWindowMatcher(label) {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const windows = [];
  for (let i = 0; i + 2 <= label.length; i++) windows.push(esc(label.slice(i, i + 2)));
  return new RegExp(windows.length ? windows.join('|') : esc(label));
}

/** 给章纲指令用：列出本地会核验的动作，禁止把规划套话当正文任务。 */
export function formatPhaseDutyRule(phase) {
  const trimmed = String(phase || '').trim();
  if (!trimmed || !phaseHasVerifiableAction(trimmed)) return '';
  const concepts = phaseConcepts(trimmed);
  const labels = [...new Set(concepts.map(([label]) => label))];
  if (!labels.length) return '';
  // V0.105.6 写审同源：复合短语按「域内窗」核验（任意两字词根/地名锚/动作核在场即
  // 同域），指令如实告知——域内同义事件即可，完成度由审校语义核验，不必逐字抄短语。
  const cutLabels = concepts.filter(([, , mode]) => mode === 'cut').map(([label]) => label);
  return `【阶段任务落实硬要求（本地核验动作，不满足将被驳回）】
本章必须落实：${labels.join('、')}${cutLabels.length ? `\n- 上述任务用同义在场事件落实即可（短语中任意两字词根/动作核在场即视为同域，如“北崖善后”可写“清理北崖案卷余波”），不必逐字抄写复合短语` : ''}
- 至少一个 scene.beat、一条 checkpoint 须出现上述动作或其同义在场事件（难民可写成流民/进寨，围城可写成合围/入蜀/临战）；
- 不必抄写规划套话（接住上卷出口/成长补救/建立新压力源/卷级转折）；真正换题（任务域内动作全不在场）驳回。\n`;
}

/** 判断一段正文/要点是否已经以等价表达落实阶段任务。 */
export function phaseCoveredByText(phase, text) {
  const source = compact(text);
  if (!source || !compact(phase)) return false;
  if (source.includes(compact(phase))) return true;
  const concepts = phaseConcepts(phase);
  if (!concepts.length) return false;
  const hits = concepts.filter(([, matcher]) => matcher.test(source)).length;
  // V0.105.6：仅连接词切分的复合口号（mode='cut'，≥2 概念且非过渡式）降为域内命中
 // ≥1——零交集=结构性换题仍拦，同义落实交审校（实测 ch53 三连败卡章根因：复合
  // 短语字面匹配把“清理余波/私盐引换粮”全判负）。词表/过渡式/单概念契约不变。
  const allCut = concepts.length > 1 && concepts.every(([, , mode]) => mode === 'cut');
  const required = allCut ? 1 : (concepts.length === 1 ? 1 : Math.max(2, Math.ceil(concepts.length * 0.6)));
  return hits >= required;
}

/**
 * 对已经生成的章细纲做结构级核验。阶段任务必须同时出现在正文节拍和事后检查点，
 * 避免模型只在元数据里保留 phase，正文却被另一个高光事件完全替换。
 */
export function historicalOutlineIssues(outline = {}) {
  const phase = String(outline?.phase || '').trim();
  if (!phase || !phaseHasVerifiableAction(phase)) return [];
  const sceneText = Array.isArray(outline?.scenes)
    ? outline.scenes.map(scene => scene?.beat || '').join('\n')
    : '';
  const checkpointText = Array.isArray(outline?.checkpoints)
    ? outline.checkpoints.join('\n')
    : '';
  const missingScene = !phaseCoveredByText(phase, sceneText);
  const missingCheckpoint = !phaseCoveredByText(phase, checkpointText);
  if (!missingScene && !missingCheckpoint) return [];
  const missing = [missingScene ? 'scene.beat' : '', missingCheckpoint ? 'checkpoint' : ''].filter(Boolean).join(' 与 ');
  return [issue(
    '大纲偏离',
    phase,
    `历史阶段任务“${phase}”没有落实到 ${missing}，仅保留元数据会导致正文换题。`,
    '至少用一个场景实际完成阶段任务，并用一个可独立判断的 checkpoint 记录等价结果。',
  )];
}

/**
 * V0.95.6 checkpoint 缺口本地愈合：beat 已落实阶段任务、仅 checkpoint 用了结果性措辞
 * （如"隘口第一根桩钉下"）不含概念词时，本地补一条阶段任务检查点（phase 原文）。
 * 实测 ch27 实证：重规划候选 8 版（V0.95.5 前后各一轮）全部 beat 合格、checkpoint 缺词被毙——
 * 指令要求模型写关键词连续 8 次只执行一半，重掷每版 80-160s 纯浪费。
 * 边界（防滥用）：beat 未落实（真换题）绝不愈合；checkpoints 非数组不愈合；
 * 愈合后复检 historicalOutlineIssues 必须归零，否则视同未愈合。
 * @returns {boolean} 是否愈合成功（调用方据此放行候选）
 */
export function healHistoricalCheckpointGap(outline = {}) {
  const phase = String(outline?.phase || '').trim();
  if (!phase) return false;
  if (!Array.isArray(outline?.checkpoints)) return false;
  const sceneText = Array.isArray(outline?.scenes)
    ? outline.scenes.map(scene => scene?.beat || '').join('\n')
    : '';
  // 前置：beat 必须已落实（防线核心——正文真的会写这个任务）
  if (!phaseCoveredByText(phase, sceneText)) return false;
  // 已有 checkpoint 合格则无需愈合
  const checkpointText = outline.checkpoints.join('\n');
  if (phaseCoveredByText(phase, checkpointText)) return false;
  outline.checkpoints.push(`${phase}（本章完成，见对应场景节拍）`);
  // 复检必须全绿（防理论上的边界遗漏）
  return historicalOutlineIssues(outline).length === 0;
}

/**
 * V0.95.7 跨年开篇检查单一真源（写/审同源）：
 * 章纲跨年（year > previousYear）时，正文开头（前 420 归一字）必须有"次年/年号"等明确跨年标记。
 * 实测 ch27 实证：模型连续多版把跨年章开篇写成氛围铺陈（"晨雾像一匹没洗透的旧布…"），
 * 该问题被路由成 replan 整章重写 → 新正文犯同样毛病 → 3 轮耗尽卡死。
 * 它是正文级可修问题（开头补一句跨年过渡即可），带 proseFix 标记供管线走 revise 而非 replan。
 * @returns {object|null} 缺跨年标记时返回 issue（proseFix: true），合格返回 null
 */
export function crossYearOpeningIssue(year, previousYear, chapterText = '') {
  const text = compact(chapterText);
  if (!text) return null;
  // null 守卫：Number(null)===0 会把"无上章年份"误判成跨年到公元 0 年（V0.95.7 测试逮出的潜伏 bug）
  if (year == null || previousYear == null || year === '' || previousYear === '') return null;
  if (!(Number.isFinite(Number(year)) && Number.isFinite(Number(previousYear))
    && Number(year) > Number(previousYear))) return null;
  const opening = text.slice(0, 420);
  const explicitLeap = /(?:次年|翌年|来年|又一年|一年(?:过去|以后|之后|后)|数月后|半年后|跨年|新岁|岁末|年初|开春|入春|春天(?:来|到)了|淳祐[一二三四五六七八九十]+年|宝祐[一二三四五六]+年|开庆[元一二三四五]+年|景定[一二三四五]+年|咸淳[一二三四五六七八九十]+年|德祐[一二]+年|公元\d{3,4}年)/;
  const immediateContinuation = /(?:七日后|数日后|三日后|翌日|次日|第二日|当夜|翌晨|雨(?:还|仍)在|伤口.{0,16}(?:结痂|未愈))/;
  if (!explicitLeap.test(opening) || immediateContinuation.test(opening) && !/(?:一年|次年|翌年|来年|又一年|淳祐|宝祐|开庆|景定|咸淳|德祐|公元)/.test(opening)) {
    return issue(
      '时间线冲突',
      opening.slice(0, 180),
      `章纲从公元${previousYear}年跨年到${year}年，但正文开头没有可信的跨年过渡，或仍写成“七日后/翌日”等紧接上章的时间。`,
      `开头明确写“一年后/次年”及对应年号、季节，再交代人物年龄、旧伤和工程状态；若情节确实只过数日，应把本章元数据年份改回${previousYear}年。`,
      { previousYear: Number(previousYear), year: Number(year), proseFix: true },
    );
  }
  return null;
}

const OPENING_TIMELINE_HINT = /开篇|开头|跨年|次年|翌年|年号|接续时间标记|开庆|宝祐|淳祐/;
const CONTINUITY_HARD_HINT = /遗体|尸身|骨殖|安葬|入土/;
const FLASHBACK_HINT = /想起|回忆|那时候|那年/;
const META_CHAPTER_HINT = /第[0-9零一二三四五六七八九十百]+章|元话语|沉浸感/;
const DRAFT_VS_OUTLINE_HINT = /草稿|正文叙述|写成|写为|呈现方式/;
const INTRA_CHAPTER_CONTINUITY_HINT = /前文刚写|上一段|前一场景|场景时间线|场景逻辑|空间连续性|前文设定|伤情|紧接着.{0,16}(动作|描写)|道具.{0,20}(跳变|矛盾)|位置.{0,8}跳变|状态跳变/;
const REPLAN_HINT = /重做细纲|重新规划|改细纲|细纲应/;
const INJURY_STATUS_HINT = /角色状态|伤势|重伤|箭伤/;
const CHARACTER_PORTRAYAL_HINT = /人物性格|人设|职责严重冲突|性格与职责|性格冲突/;

/**
 * 审校模型常把正文可修问题写成无标记的 high 细纲根因，管线会清掉已写五场。
 * 开篇年号、元话语、草稿用词、章内道具跳变、开庆被标成史实错误或事实矛盾、人设/职责冲突、回忆误判遗体、伤势出场：打 proseFix。
 * 遗体跨年硬伤、明确要求重做细纲、未登记角色：保持原样。
 */
export function stampOpeningTimelineProseFix(issues = []) {
  return (issues || []).map(issue => {
    if (issue?.proseFix) return issue;
    const blob = `${issue.issue || ''}${issue.fix || ''}`;
    const quote = String(issue.quote || '');
    const type = issue?.type;
    if (type === '大纲偏离' && META_CHAPTER_HINT.test(`${blob}${quote}`) && !REPLAN_HINT.test(blob)) {
      return { ...issue, proseFix: true };
    }
    if ((type === '事实矛盾' || type === '大纲偏离')
      && (DRAFT_VS_OUTLINE_HINT.test(blob) || INTRA_CHAPTER_CONTINUITY_HINT.test(blob)
        || OPENING_TIMELINE_HINT.test(blob) || CHARACTER_PORTRAYAL_HINT.test(blob))
      && !REPLAN_HINT.test(blob)) {
      return { ...issue, proseFix: true };
    }
    if (type === '角色矛盾' && CHARACTER_PORTRAYAL_HINT.test(blob) && !REPLAN_HINT.test(blob)) {
      return { ...issue, proseFix: true };
    }
    if (type === '事实编造' && INJURY_STATUS_HINT.test(blob) && quote && !REPLAN_HINT.test(blob)) {
      return { ...issue, proseFix: true };
    }
    // V0.102.12：审校常把开庆元年章纲坐标标成「史实错误」，与时间线冲突同为正文可修。
    if (type === '史实错误' && OPENING_TIMELINE_HINT.test(blob) && !REPLAN_HINT.test(blob)) {
      return { ...issue, proseFix: true };
    }
    if (type !== '时间线冲突') return issue;
    if (CONTINUITY_HARD_HINT.test(blob) && !FLASHBACK_HINT.test(quote)) return issue;
    if (OPENING_TIMELINE_HINT.test(blob) || FLASHBACK_HINT.test(quote)) return { ...issue, proseFix: true };
    return issue;
  });
}

/**
 * 已有草稿时仍立刻清场的硬根因：未登记角色、明确要求重做细纲、无回忆的遗体硬伤。
 * 其余细纲标签先给修订机会（V0.102.15）。
 */
export function isImmediateReplanIssue(issue) {
  if (!issue || issue.proseFix || issue.severity !== 'high') return false;
  if (issue.type === '事实编造' || issue.type === '史实错误') return true;
  const blob = `${issue.issue || ''}${issue.fix || ''}`;
  if (REPLAN_HINT.test(blob)) return true;
  if (CONTINUITY_HARD_HINT.test(blob) && !FLASHBACK_HINT.test(String(issue.quote || ''))) return true;
  return false;
}

/**
 * 对正文做无需 LLM 的史实/物理连续性核验。
 * 规则刻意保持窄而确定：只有明确的时间跃迁 + 完整遗体细节、或明确的真实人物任职越界才拦截。
 */
export function historicalContinuityIssues({ bookTitle = '', genre = '', year, previousYear, chapterText = '' } = {}) {
  const text = compact(chapterText);
  if (!text) return [];

  const issues = [];

  // 章纲跨年时，正文开头必须把时间跳跃明示给读者（V0.95.7 抽为 crossYearOpeningIssue 单一真源）
  const openingIssue = crossYearOpeningIssue(year, previousYear, text);
  if (openingIssue) issues.push(openingIssue);

  const timeMatcher = /春天(?:来|到)了|入春|开春|次年|翌年|来年|几个月|数月|半年|一年后|跨年/;
  const intactAfterLeap = /(?:草席|包袱|尸身|尸体|遗体|弟弟).{0,100}(?:拨开.{0,12}(?:碎发|头发)|摸了?摸.{0,12}(?:手|脸|额头)|脸还|头发|皮肉|手指)/;
  const timeMatch = timeMatcher.exec(text);
  if (timeMatch) {
    const afterLeap = text.slice(timeMatch.index);
    const intactMatch = intactAfterLeap.exec(afterLeap);
    const handledBeforeLeap = /火化|焚化|安葬|下葬|埋葬|入土/.test(text.slice(0, timeMatch.index));
    if (intactMatch && !handledBeforeLeap) {
      const around = afterLeap.slice(Math.max(0, intactMatch.index - 24), intactMatch.index + intactMatch[0].length);
      if (/想起|回忆|那时候|那年/.test(around)) {
        // 回忆里的手指/头发不是跨年携带遗体
      } else {
        const quote = afterLeap.slice(Math.max(0, intactMatch.index - 20), intactMatch.index + intactMatch[0].length + 20);
        issues.push(issue(
          '时间线冲突',
          quote,
          `正文明确跨过数月或季节，却仍把未防腐遗体写成可辨面容、头发或肢体的完整状态${previousYear && Number(year) > Number(previousYear) ? '，且章节已跨年' : ''}。`,
          '把火化或安葬安排在死亡后的合理时段；跨季后只能携带骨殖、骨灰或纪念物。',
        ));
      }
    }
  }

  // 王坚在1254年才到合州主持钓鱼城防务。普通提名不拦截，只拦明确的职务/统辖行为。
 if (isHistoricalEraGuard({ genre, bookTitle }) && Number(year) < 1254 && /王坚/.test(text)) {
    const prematureRole = /(?:钓鱼城主将|合州知州|知合州).{0,12}王坚|王坚.{0,40}(?:钓鱼城主将|合州知州|知合州|主持.{0,16}(?:钓鱼城|城防|防务)|下令.{0,28}(?:五县民丁|增筑|筑城|城墙|城防))/;
    const roleMatch = prematureRole.exec(text);
    if (roleMatch) {
      issues.push(issue(
        '史实错误',
        roleMatch[0],
        `公元${Number(year) || '当前'}年让王坚以合州知州、钓鱼城主将或防务主持者身份行动，早于其1254年到合州任职的时间窗。`,
        '改由当时在任或明确虚构的营造/军务负责人承担；王坚的合州防务主职最早放到1254年。',
        { earliestYear: 1254, person: '王坚' },
      ));
    }
  }

 if (isHistoricalEraGuard({ genre, bookTitle }) && Number(year) < 1243
    && /钓鱼山/.test(text)) {
    const earlyConstruction = /钓鱼山.{0,60}(?:筑城|营造|开挖?基槽|砌筑?城墙|城墙.{0,8}(?:开工|动工)|料石队.{0,8}(?:进场|开工))/;
    const constructionMatch = earlyConstruction.exec(text);
    if (constructionMatch) {
      issues.push(issue(
        '史实错误',
        constructionMatch[0],
        `公元${Number(year) || '当前'}年把钓鱼山正式筑城写早了；余玠采纳冉氏兄弟建议并筑城于钓鱼山的锚点为1243年。`,
        '1242年可写余玠赴任、收拢流民和冉氏兄弟献策；钓鱼山开基槽、料石进场与城墙营造放到1243年。',
        { earliestYear: 1243, event: '钓鱼山正式筑城' },
      ));
    }
  }

  // 丁家洲之战发生在德祐元年（1275）。1274年是宋度宗去世、幼帝即位，不能把次年战事并入同年。
 if (isHistoricalEraGuard({ genre, bookTitle }) && Number(year) < 1275
    && /丁家洲/.test(text) && /(?:战|迎战|决战|兵败|溃败|大败)/.test(text)) {
    const battleMatch = /(?:贾似道.{0,40})?丁家洲.{0,40}(?:战|迎战|决战|兵败|溃败|大败)|(?:战|迎战|决战|兵败|溃败|大败).{0,40}丁家洲/.exec(text);
    issues.push(issue(
      '史实错误',
      battleMatch?.[0] || '丁家洲之战',
      `公元${Number(year) || '当前'}年写丁家洲之战过早；该战发生在德祐元年（1275）。`,
      '1274年写宋度宗去世与幼帝即位；丁家洲交战、溃败及其直接后果放到1275年。',
      { earliestYear: 1275, event: '丁家洲之战' },
    ));
  }

  return issues;
}

/**
 * 章细纲里的“少年权限”硬闸门。历史成长可以快，但不能靠让未成年人凭空获得
 * 成年军官权限来制造爽点；建设、传讯、记图、工组协作等有限责任不在拦截范围内。
 */
export function historicalYouthAuthorityIssues({ bookTitle = '', genre = '', year, protagonistAge, outline = {} } = {}) {
  const age = Number(protagonistAge ?? outline?.protagonist_age);
  const text = compact([
    outline?.title, outline?.phase, outline?.goal, outline?.beat,
    outline?.continuity_from, outline?.continuity_to,
    ...(Array.isArray(outline?.checkpoints) ? outline.checkpoints : []),
    ...(Array.isArray(outline?.scenes) ? outline.scenes.map(scene => scene?.beat || '') : []),
  ].join('\n'));
 if (!text || !Number.isFinite(age) || age >= 16 || !isHistoricalEraGuard({ genre, bookTitle })) return [];

  const forbidden = /(?:独立|亲自|自行|率领|带领|指挥|统领|统率|调度|布置|设伏|下令|命令).{0,20}(?:军队|军卒|士卒|宋军|兵马|斥候|哨队|骑兵|民兵|乡勇|成人)|(?:手刃|杀死|斩杀|击杀).{0,12}(?:蒙古|敌人|敌兵|骑兵)|(?:授|升|任|擢).{0,12}(?:校尉|都头|军官|将领|统制|将军|知州)/;
  const allowedContext = /不得|不能|不可|并非|不是|未曾|没有|禁止|只(?:负责|参与|承担)|有限责任|成年人(?:带领|复核|主持)|工组|料石队|传讯|记图|记账|守绳|搬石|民夫/;
  const match = forbidden.exec(text);
  if (!match || allowedContext.test(text.slice(Math.max(0, match.index - 30), match.index + match[0].length + 40))) return [];
  return [issue(
    '角色越权',
    match[0],
    `公元${Number(year) || '当前'}年主角仅${age}岁，细纲却让其独立杀敌、统领成年军队或获得正式军职，成长阶梯失真。`,
    '改为在成年人主持下承担记图、传讯、搬运、守绳或有限工组责任；实战杀敌与正式入伍至少放到十六岁阶段。',
    { protagonistAge: age },
  )];
}

/**
 * V0.93.10 历史人物登场窗校验（正文级确定性检查）：
 * ①章节年份早于人物登场年 → 时代错误（high）："尚未登场"；
 * ②章节年份晚于人物卒年且人物有在场行动（说/率/攻/到 等动词）→ 时代错误（medium）——纯提及/追忆不拦。
 * figures 由调用方传入（historicalFiguresFor：DB 优先+内置种子兜底）。
 */
const FIGURE_ACTION_RE = /(?:说|道|喝|令|率|领|攻|守|入|出|到|至|见|召|命|拜|奏|献|举|发|屯|渡|引|统|任|授|斩|杀|擒|降|战|死|卒)(?:了|过|之|军|兵|师|城|营)?/;
export function historicalFigureTimelineIssues({ bookTitle = '', genre = '', year, chapterText = '', figures = [] } = {}) {
  const y = Number(year);
  const text = String(chapterText || '');
 if (!text || !Number.isFinite(y) || !figures.length || !isHistoricalEraGuard({ genre, bookTitle })) return [];
  const issues = [];
  for (const f of figures) {
    const name = String(f.name || '').trim();
    if (!name || name.length < 2) continue;
    if (!text.includes(name) && !(f.aliases || []).some(a => a && text.includes(String(a)))) continue;
    const firstYear = f.firstYear != null ? Number(f.firstYear) : null;
    const deathYear = f.deathYear != null ? Number(f.deathYear) : null;
    if (firstYear && y < firstYear) {
      issues.push(issue(
        '时代错误', name,
        `公元${y}年「${name}」尚未登场（史实${firstYear}年才${f.office || '登场'}），人物提前出现破坏时间线。`,
        `将「${name}」的出场推迟到${firstYear}年之后，或改为提及/传闻而非在场活动。`,
      ));
      continue;
    }
    if (deathYear && y > deathYear) {
      // 卒年后仅提及/追忆不拦；有在场行动动词才拦
      const actionNear = new RegExp(`(?:${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}).{0,18}(?:${FIGURE_ACTION_RE.source})`, 'g');
      if (actionNear.test(text)) {
        issues.push(issue(
          '时代错误', name,
          `公元${y}年「${name}」已卒于${deathYear}年，正文却让其在场行动——人死不能复出（追忆/提及不在此列）。`,
          `改为回忆、遗物、追赠或后代相关写法；除非架空因果明确救活（须在细纲注明）。`,
          { severity: 'medium' },
        ));
      }
    }
  }
  return issues;
}

/**
 * 正文级少年权限闸。细纲通过不代表模型正文不会临场升级权限，因此审校前再做一次
 * 确定性检查。规则只拦明确的机密掌握和对成年人的独立号令，避免误伤正常学习、
 * 传讯、守绳、记号与经成人批准的工组协作。
 */
export function historicalYouthAuthorityTextIssues({ bookTitle = '', genre = '', year, protagonistAge, chapterText = '' } = {}) {
  const age = Number(protagonistAge);
  const text = compact(chapterText);
 if (!text || !Number.isFinite(age) || age >= 16 || !isHistoricalEraGuard({ genre, bookTitle })) return [];

  const issues = [];
 const permissionContext = /(?:不得|不能|不可|不许|没有|未曾|并未|只(?:负责|记|抄)|公开|另册|成人|军士|工头|通判|校尉).{0,24}(?:保管|复核|批准|主持|下令|掌握)|(?:由|交由).{0,18}(?:成人|军士|工头|通判|校尉|老兵甲|什长乙|冉璞).{0,18}(?:保管|复核|批准|主持|下令)|(?:提出|提议).{0,24}(?:核过|批准|下令)/;

  const secretPatterns = [
    /(?:暗门|密道|秘道).{0,70}(?:准确位置|所在|路线).{0,36}(?:画入|记入|写入|工册|随身|掌握|保管)/,
    /(?:画入|记入|写入|掌握|保管).{0,36}(?:暗门|密道|秘道).{0,40}(?:准确位置|路线|所在)?/,
    /(?:哨探|军情|敌情|暗门|密道).{0,40}(?:图|图纸|舆图|密页).{0,36}(?:交给|保管|随身|烧了|烧毁|焚毁)/,
    /(?:烧了|烧毁|焚毁).{0,24}(?:第[一二三四五六七八九十\d]+页|哨探图|军情图|敌情图|舆图|密页)/,
  ];
  for (const matcher of secretPatterns) {
    const match = matcher.exec(text);
    if (!match) continue;
    const context = text.slice(Math.max(0, match.index - 80), match.index + match[0].length + 80);
    const explicitlyDenied = /(?:没有|并未|未曾|不曾|不得|不能|不可|不许).{0,40}(?:哨探图|军情图|敌情图|舆图|密页|暗门|密道|秘道).{0,40}(?:交给|保管|随身|烧|画入|记入|写入)?/.test(context);
    if (permissionContext.test(context) || explicitlyDenied) continue;
    issues.push(issue(
      '角色越权', match[0],
      `公元${Number(year) || '当前'}年主角仅${age}岁，正文却让其掌握、随身记录、保管或销毁暗门/军情机密，超出少年工役与学徒的可信权限。`,
      '机密原图、暗门准确位置和销毁权限由具名成人军士或官员另册掌握；少年只能接触完成任务所需的公开工序或局部信息。',
      { protagonistAge: age },
    ));
    break;
  }

  // 号令必须具备明确的“少年施事者 → 成人受事者 → 行动”结构。此前把任何“叫/让”
 // 和后文偶然出现的什长乙、老兵甲拼在一起，会把“叫钓鱼山”“让墨快些干”误判，
  // 甚至把成年人命令少年反向解释成少年命令成年人。
 const command = /(?:主角|少年|他).{0,16}(?:重新分组|分派|调度|安排|下令|命令|号令).{0,45}(?:成年|民夫|工匠|军卒|士卒|众人|老兵甲|什长乙)|(?:主角|少年)(?:说|喊|喝道|开口)?[：，,:“”"']{0,3}(?:命|叫|让)(?:老兵甲|什长乙|成年民夫|工匠|军卒)(?:立即|马上)?(?:去|守|撤|搬|拉|带人)/;
  const commandMatch = command.exec(text);
  if (commandMatch) {
    const context = text.slice(Math.max(0, commandMatch.index - 100), commandMatch.index + commandMatch[0].length + 100);
 const adultApproved = /(?:向|先向).{0,12}(?:老兵甲|什长乙|工头|军士|成人).{0,24}(?:提出|提议|请示)|(?:老兵甲|什长乙|工头|军士|成人).{0,36}(?:核过|批准|主持|亲自|下令)|按(?:照)?(?:老兵甲|什长乙|工头|军士|成人).{0,16}(?:分派|命令|号令|安排)/.test(context);
    const limitedRole = /只负责(?:记号|记录|复诵|报时|守绳|传讯)|不得指挥|并非号令/.test(context);
    if (!adultApproved && !limitedRole) {
      issues.push(issue(
        '角色越权', commandMatch[0],
        `公元${Number(year) || '当前'}年主角仅${age}岁，正文让其未经成人授权独立调度、号令成年工役或军卒，责任阶梯失真。`,
        '改为少年提出观察或方案，由具名成人逐项复核并正式下令；少年只负责记号、复诵、报时、传讯或守绳。',
        { protagonistAge: age },
      ));
    }
  }
  return issues;
}
