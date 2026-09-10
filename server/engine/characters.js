// server/engine/characters.js —— V0.37 角色生命周期管理
// ①死亡自动退场：结算检测"状态=死亡" → 角色卡标记 deceased + 死亡章节
// ②动态点名册（roll call）：活跃角色名单 + 已退场角色档案，注入写作/细纲/审校尾部指令（缓存友好）
// ③配角卡自动丰富：结算 character_notes 并入卡片 description
'use strict';
import * as store from '../db/store.js';
import { sanitizeStoryMemoryText } from './rules.js';
import { growthSystemFor } from '../data/creative_packs.js'; // V0.74 题材成长体系

/** 死亡关键词（状态键或值命中即判退场） */
const DEATH_KEY_RE = /(死|陨落|牺牲|身亡|阵亡|领盒饭|退场)/;
const DEATH_VALUE_RE = /(死亡|战死|陨落|身亡|牺牲|被杀|身死|死了|已死|领盒饭|去世)/;

function safeJSONText(raw, key) {
  try { return String((JSON.parse(raw || '{}') || {})[key] || ''); } catch { return ''; }
}

/**
 * 从角色状态变更中检测死亡。
 * @param {string[]} changes 结算抽取的 changes 数组（如 ['位置=青云城', '状态=死亡']）
 * @returns {boolean}
 */
export function detectDeath(changes) {
  if (!Array.isArray(changes)) return false;
  for (const ch of changes) {
    if (typeof ch !== 'string') continue;
    const eq = ch.indexOf('=');
    if (eq <= 0) {
      if (DEATH_VALUE_RE.test(ch)) return true; // 裸描述如 "战死"
      continue;
    }
    const k = ch.slice(0, eq).trim();
    const v = ch.slice(eq + 1).trim();
    if (/死因|死亡原因|死法/.test(k)) return true; // 键本身即死亡语义
    if (DEATH_KEY_RE.test(k) && /(死|陨落|牺牲|亡|盒饭)/.test(v)) return true;
    if (DEATH_VALUE_RE.test(v)) return true;
  }
  return false;
}

/**
 * 角色点名册（动态尾部注入，缓存友好）：
 * - 活跃角色：名字 + 身份 + 关键状态（最多 limit 个）
 * - 已退场角色：名字 + 死亡章节 + 死因，附硬规则（除回忆/闪回外不得重新出场）
 * @returns {string} 空串表示无角色
 */
export function characterRollCallText(bookId, { limit = 12, chapterIdx = null } = {}) {
  const chars = store.characters.list(bookId);
  if (!chars.length) return '';
  const active = [];
  const deceased = [];
  for (const c of chars) {
    // 未来人物只在达到首登场章后进入点名册，避免模型把后期角色提前写入当前时间线。
    const firstChapter = Number(c.first_chapter);
    if (Number.isInteger(chapterIdx) && Number.isInteger(firstChapter) && firstChapter > chapterIdx) continue;
    let state = {};
    try { state = JSON.parse(c.state_json || '{}'); } catch { /* ignore */ }
    if (c.deceased) deceased.push({ name: c.name, state, deathChapter: c.death_chapter });
    else active.push({ name: c.name, state, card: (() => { try { return JSON.parse(c.card_json || '{}'); } catch { return {}; } })() });
  }
  const parts = [];
  if (active.length) {
    const lines = active.slice(0, limit).map(c => {
      const bits = [];
      if (c.card.role) bits.push(c.card.role);
      // V0.96：性格/心境不再进点名册——characterCardsText（六维+当前心境）才是性格唯一注入位；
      // 此前 rollCall 读 card.traits 与 cardText 读 personality 双源分歧（AI 补全/前端编辑只写
      // personality 列，card.traits 残留旧值），同一角色两种"性格"进同一指令。
      const statePriority = ['当前纪年', '公元年', '年龄', '职位', '身份', '位置', '状态'];
      const st = Object.entries(c.state)
        .filter(([k, v]) => k !== '性格' && v !== '' && v !== '无')
        .sort(([a], [b]) => {
          const ai = statePriority.indexOf(a), bi = statePriority.indexOf(b);
          return (ai < 0 ? statePriority.length : ai) - (bi < 0 ? statePriority.length : bi);
        })
        .slice(0, 4)
        .map(([k, v]) => `${k}=${String(v).slice(0, 20)}`);
      if (st.length) bits.push(st.join('，'));
      return `- ${c.name}${bits.length ? '：' + bits.join('；') : ''}`;
    });
    parts.push(`【当前出场角色】\n${lines.join('\n')}`);
  }
  if (deceased.length) {
    const lines = deceased.map(c => {
      const cause = c.state['死因'] || c.state['死亡原因'] || c.state['死'] || '未详';
      return `- ${c.name}（第${c.deathChapter || '?'}章死亡${cause !== '未详' ? '，' + cause : ''}）`;
    });
    parts.push(`【已退场角色（死亡）】\n${lines.join('\n')}\n硬规则：以上角色已死亡，不得在正文中以任何形式重新登场；仅可通过回忆/闪回/遗物/遗言提及。`);
  }
  return parts.join('\n\n');
}

/**
 * 卷目标已经明确承诺“升任/统领/防区升级”等责任变化时，临近卷末仍无落点就形成成长债务。
 * 只负责提示规划链建立授权与考核过程，绝不自动给主角升官。
 */
export function detectGrowthPlanDrift({ volumeGoal = '', currentState = '', volumeProgress = 0 } = {}) {
  if (Number(volumeProgress) < 0.65) return [];
  const goal = String(volumeGoal || '');
  const state = String(currentState || '');
  const targets = [];
  for (const match of goal.matchAll(/(?:升级|跃迁|升任|晋升|成为|担任|初掌|统领|指挥)[^，。；：\n]{0,8}[（(]([^）)\n]{2,16})[）)]/gu)) {
    targets.push(match[1].trim());
  }
  for (const match of goal.matchAll(/(?:升任|晋升为|成为|担任|初掌|统领|指挥)\s*([^，。；：\n（）()]{2,12})/gu)) {
    targets.push(match[1].trim());
  }
  if (!targets.length && /身份跃迁|责任升级|官位跃迁|军职跃迁|防区升级|统兵权/u.test(goal)) {
    targets.push('本卷责任/身份跃迁');
  }
  return [...new Set(targets)]
    .filter(target => target && !state.includes(target))
    .map(target => ({
      target,
      issue: `本卷已推进 ${Math.round(Number(volumeProgress) * 100)}%，卷目标承诺“${target}”，当前角色状态尚无对应责任变化`,
      fix: '在剩余章节先建立考核、授权、代价与职责变化，再兑现；若剧情已改向则同步调整卷目标，禁止凭空晋升',
    }));
}

/** 当前状态仍写着“监视/待核/等待证据”，跨过阈值后必须让线索发生质变或明确转为冷案。 */
export function detectLongRunningStateDebts(characters = [], { chapterIdx = 0, threshold = 8 } = {}) {
  const current = Number(chapterIdx) || 0;
  const limit = Math.max(1, Number(threshold) || 8);
  const frozenState = /监视中|调查中|追查中|审查中|待核|尚未定罪|等待[^；。]{0,16}(?:证据|交接|结果)|线索未明/u;
  const debts = [];
  for (const character of characters || []) {
    let state = {};
    try { state = JSON.parse(character?.state_json || '{}') || {}; } catch { state = {}; }
    const text = Object.entries(state).map(([key, value]) => `${key}=${value}`).join('；');
    if (!frozenState.test(text)) continue;
    const since = Number(state.状态起始章 || state.调查起始章 || character.first_chapter) || current;
    const span = current - since + 1;
    if (span < limit) continue;
    debts.push({
      name: character.name || '未具名角色', span, since, state: text.slice(0, 160), severity: 'medium',
      issue: `${character.name || '该角色'}的调查/监视状态已持续约 ${span} 章，长线可能冻结`,
      fix: '在后续1-3章让证据、嫌疑、关系或调查层级发生不可逆变化；也可明确转冷案并停止每章重复提醒，不得直接把嫌疑写成定罪',
    });
  }
  return debts;
}

export function longRunningStateDebtText(bookId, chapterIdx) {
  const debts = detectLongRunningStateDebts(store.characters.list(bookId), { chapterIdx, threshold: 8 });
  if (!debts.length) return '';
  return `【长线冻结债务】\n${debts.map(item => `⚠ ${item.issue}；${item.fix}`).join('\n')}`;
}

/**
 * V0.74 通用化主角成长状态：从题材包 growthSystem 读取成长维度/阶梯/词表，替换 V0.73 的修仙硬编码。
 * 支持玄幻(境界)/都市(阶层)/科幻(科技等级)/悬疑(真相层)/言情(情感阶段)等所有题材。
 * 用于细纲/正文注入（强制成长进展）与成长线偏离检测（growth.js）。
 * @returns {{text:string, dimension:string, stageIndex:number, stageLabel:string|null,
 *            hasGrowth:boolean, stagnant:boolean, example:string, genre:string|undefined}}
 *   text=注入文本（题材适配）；dimension=成长维度名（境界/阶层/真相层…）；
 *   stageIndex=当前在成长阶梯的序号（-1=无匹配，视作最低）；stageLabel=当前阶段名；
 *   hasGrowth=是否已有成长维度状态；stagnant=是否有停滞信号；
 *   example=成长阶梯示例；genre=书题材
 */
export function growthStatus(bookId, { chapterIdx = null } = {}) {
  const book = store.books.get(bookId);
  const gs = growthSystemFor(book?.genre);
  const chars = store.characters.list(bookId);
  const protag = chars.find(c => c.tier === 'protagonist') || chars[0];
  if (!protag) {
    return { text: '', dimension: gs.dimension, stageIndex: -1, stageLabel: '', hasGrowth: false, stagnant: false, setback: false, hiddenPower: false, example: gs.example, genre: book?.genre };
  }
  let state = {};
  try { state = JSON.parse(protag.state_json || '{}'); } catch { /* ignore */ }
  // 按题材 keyFields 提取维度字段（不再写死修仙白名单）
  const hits = gs.keyFields
    .map(k => (state[k] !== undefined && state[k] !== '' && state[k] !== '无') ? { k, v: String(state[k]).slice(0, 60) } : null)
    .filter(Boolean);
  // 阶段匹配（题材 ladderRegex）
  const stageMatch = (protag.state_json + ' ' + (protag.abilities_json || '')).match(gs.ladderRegex);
  const stageLabel = stageMatch ? stageMatch[0] : null;
  const stageIndex = stageLabel ? gs.ladder.findIndex(s => stageLabel.includes(s)) : -1;
  const hasGrowth = hits.length > 0 || !!stageLabel;
  // 停滞检测（题材 stallMarks / progressMarks；排除"已突破/已晋升"等进展标记）
  // V0.81：setbacks（贬黜/夺职等）天然豁免"停滞"——历史文官场浮沉是剧情波动不是成长停滞
  const all = Object.entries(state).map(([k, v]) => `${k}=${v}`).join(' ');
  const hasStallMark = gs.stallMarks.some(w => all.includes(w));
  const hasProgressMark = gs.progressMarks.some(w => all.includes(w));
  const hasSetback = (gs.setbacks || []).some(w => all.includes(w));
  const hasHiddenPower = (gs.hiddenPowerMarks || []).some(w => all.includes(w));
  const stagnant = (hasStallMark && !hasProgressMark) && !hasSetback;
  let planDebt = [];
  try {
    const chapters = store.chapters.list(bookId);
    const inferredIdx = Number.isInteger(Number(chapterIdx)) ? Number(chapterIdx) : chapters
      .filter(chapter => !['planned', 'outlined'].includes(chapter.status))
      .reduce((max, chapter) => Math.max(max, Number(chapter.idx) || 0), 0);
    const currentChapter = chapters.find(chapter => Number(chapter.idx) === inferredIdx);
    const volume = currentChapter?.volume_id ? store.volumes.get(currentChapter.volume_id) : null;
    const volumeChapters = volume ? store.chapters.listByVolume(volume.id) : [];
    const position = volumeChapters.findIndex(chapter => chapter.id === currentChapter?.id);
    const progress = position >= 0 && volumeChapters.length ? (position + 1) / volumeChapters.length : 0;
    let card = {};
    try { card = JSON.parse(protag.card_json || '{}'); } catch { /* ignore */ }
    planDebt = detectGrowthPlanDrift({
      volumeGoal: `${volume?.goal || ''} ${safeJSONText(volume?.outline_json, 'goal')}`,
      currentState: `${protag.state_json || ''} ${card.role || ''} ${protag.abilities_json || ''}`,
      volumeProgress: progress,
    });
  } catch { /* 成长债务是辅助观察面，失败不阻断 */ }
  if (!hasGrowth && !stagnant) {
    const debtText = planDebt.length ? `【主角成长债务】\n${planDebt.map(item => `⚠ ${item.issue}；${item.fix}`).join('\n')}` : '';
    return { text: debtText, dimension: gs.dimension, stageIndex, stageLabel, hasGrowth, stagnant, setback: hasSetback, hiddenPower: hasHiddenPower, planDebt, example: gs.example, genre: book?.genre };
  }
  const lines = hits.map(h => `${h.k}=${h.v}`);
  if (stageLabel) lines.unshift(`${gs.dimension}=${stageLabel}`);
  const stagnantNote = stagnant
    ? `\n⚠ 主角${gs.dimension}长期停滞（长期无实质提升），本章必须安排${gs.progressVerbs[0]}——至少达到一个新阶段（如：${gs.example}）`
    : '';
  return {
    text: `【主角成长状态】\n${lines.join('\n')}${stagnantNote}${planDebt.length ? `\n${planDebt.map(item => `⚠ ${item.issue}；${item.fix}`).join('\n')}` : ''}`,
    dimension: gs.dimension, stageIndex, stageLabel, hasGrowth, stagnant, setback: hasSetback, hiddenPower: hasHiddenPower,
    planDebt, example: gs.example, genre: book?.genre,
  };
}

/** V0.73 兼容封装：返回旧结构 { text, realm, powerLevel, hasPower, stagnant }（旧调用点/测试仍可用） */
export function protagonistPowerStatus(bookId) {
  const g = growthStatus(bookId);
  return { text: g.text, realm: g.stageLabel, powerLevel: g.stageLabel, hasPower: g.hasGrowth, stagnant: g.stagnant };
}

/**
 * V0.49：角色卡关键字段摘要（写作注入用——性格/目标/秘密/心境/关系，每角色 ≤3 行）
 * 只取当前场景相关角色（按名字过滤，最多 limit 个），防止 token 膨胀。
 * @returns {string} 注入文本（无角色时为空串）
 */
export function characterCardsText(bookId, { names = [], limit = 3, chapterIdx = null } = {}) {
  const chars = store.characters.list(bookId);
  if (!chars.length) return '';
  const eligible = chars.filter(c => {
    if (c.deceased) return false;
    const firstChapter = Number(c.first_chapter);
    return !(Number.isInteger(chapterIdx) && Number.isInteger(firstChapter) && firstChapter > chapterIdx);
  });
  const wanted = names.length ? eligible.filter(c => names.includes(c.name)) : eligible.slice(0, limit);
  const selected = (names.length ? wanted : eligible).slice(0, limit);
  if (!selected.length) return '';
  const lines = selected.map(c => {
    const bits = [];
    const safe = (value, limitChars) => sanitizeStoryMemoryText(value || '').trim().slice(0, limitChars);
    // V0.96：身份（card.role）进人物卡——此前只在点名册出现，cardText 按场景过滤的 3 人
    // 可能不含 rollCall 里的角色，模型对同一角色身份认知不一致
    let roleCard = {};
    try { roleCard = JSON.parse(c.card_json || '{}'); } catch { /* ignore */ }
    if (safe(roleCard.role, 30)) bits.push(`身份：${safe(roleCard.role, 30)}`);
    // V0.108 人物活性：backstory 并入性格行（行为能从经历解释得通的材料）
    const origin = safe(roleCard.backstory, 60);
    const personality = safe(c.personality, 60);
    if (personality) bits.push(`性格：${personality}${origin ? `（成因：${origin}）` : ''}`);
    if (safe(c.speech, 80)) bits.push(`说话：${safe(c.speech, 80)}`);
    if (safe(c.speech_forbid, 60)) bits.push(`禁腔：${safe(c.speech_forbid, 60)}`);
    // V0.108：motive_root（底层动因）并入目标行
    const root = safe(roleCard.motive_root, 30);
    const goal = safe(c.goal, 50);
    if (goal) bits.push(`目标：${goal}${root ? `（因为${root}，非要不可）` : ''}`);
    if (safe(c.fear, 40)) bits.push(`软肋/恐惧：${safe(c.fear, 40)}`);
    if (safe(c.secret, 40)) bits.push(`秘密：${safe(c.secret, 40)}`);
    // V0.108：web（多边关系）并入关系行——与主角之外角色的关系线
    const web = safe(roleCard.web, 40);
    const relation = safe(c.relation, 50);
    if (relation || web) bits.push(`关系：${[relation, web].filter(Boolean).join('；')}`);
    // V0.108：对手型角色三件（独立目标/退不了的理由/局部正确）——出场注入，写作时反派不降智的材料
    if (roleCard.rival) {
      const agenda = safe(roleCard.agenda, 40);
      const noRetreat = safe(roleCard.no_retreat, 40);
      const stance = safe(roleCard.stance, 40);
      if (agenda || noRetreat || stance) {
        bits.push(`他的立场（行动须由此解释，非无脑针对主角）：${[agenda, noRetreat ? `退路：无——${noRetreat}` : '', stance].filter(Boolean).join('；')}`);
      }
    }
    let state = {};
    try { state = JSON.parse(c.state_json || '{}'); } catch { /* ignore */ }
    const mood = state['心境'] || state['情绪'] || '';
    if (mood) bits.push(`当前心境：${String(mood).slice(0, 40)}`);
    const arcText = safe(c.arc, 100);
    const arc = arcText ? `\n  弧线（须逐步兑现）：${arcText}` : '';
    return `- ${c.name}：${bits.join('；')}${arc}`;
  });
  return `【角色人物卡（写作时必须让角色符合其性格/说话方式/目标/秘密/关系，人物戏硬要点）】\n${lines.join('\n')}`;
}

/**
 * V0.108：本场是否有对手型角色出场（card.rival 标记 + 名字命中场景文本/POV）。
 * 用于正文指令条件注入反派纪律（防无脑反派）——参照 isWarfareText 零成本粗筛先例。
 * @returns {string[]} 出场的对手型角色名
 */
export function rivalCharactersInScene(bookId, sceneText = '', pov = '') {
  const src = `${String(sceneText || '')} ${String(pov || '')}`;
  if (!src.trim()) return [];
  return store.characters.list(bookId)
    .filter(c => !c.deceased)
    .filter(c => {
      let card = {};
      try { card = JSON.parse(c.card_json || '{}'); } catch { /* ignore */ }
      return card.rival === true;
    })
    .filter(c => c.name && src.includes(c.name))
    .map(c => c.name);
}

/**
 * 结算后处理：检测死亡并标记退场；新角色卡片用抽取信息初始化。
 * @returns {{deceased: string[]}} 本次新标记退场的角色名
 */
export function applyDeathAndCardEnrich(bookId, charUpdates, charNotes, chapterIdx) {
  const deceasedNow = [];
  if (Array.isArray(charUpdates)) {
    for (const cu of charUpdates) {
      const name = (cu.name || '').trim();
      const changes = Array.isArray(cu.changes) ? cu.changes : [];
      if (!name) continue;
      const existing = store.characters.list(bookId).find(c => c.name === name);
      if (existing && !existing.deceased && detectDeath(changes)) {
        // 提取死因（优先 死因/死亡原因 键，其次死亡值本身）
        let cause = '';
        for (const ch of changes) {
          if (typeof ch !== 'string') continue;
          const eq = ch.indexOf('=');
          if (eq <= 0) continue;
          const k = ch.slice(0, eq).trim();
          const v = ch.slice(eq + 1).trim();
          if (/死因|死亡原因|死/.test(k)) { cause = v; break; }
        }
        store.characters.update(existing.id, { deceased: true, deathChapter: chapterIdx, exitNote: cause || '死亡', state: { ...(JSON.parse(existing.state_json || '{}')), 死因: cause || undefined } });
        deceasedNow.push(name);
      }
    }
  }
  // 配角卡丰富：character_notes 并入卡片（上限防膨胀）
  if (Array.isArray(charNotes)) {
    for (const n of charNotes) {
      const name = (n.name || '').trim();
      const note = String(n.note || n.trait || '').trim();
      if (!name || !note || note === '无') continue;
      const existing = store.characters.list(bookId).find(c => c.name === name);
      if (!existing) continue;
      let card = {};
      try { card = JSON.parse(existing.card_json || '{}'); } catch { /* ignore */ }
      const desc = String(card.description || '');
      if (desc.length < 200 && !desc.includes(note.slice(0, 12))) {
        card.description = desc ? `${desc}；${note}` : note;
        store.characters.update(existing.id, { card });
      }
    }
  }
  return { deceased: deceasedNow };
}
