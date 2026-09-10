// server/engine/settle.js —— 章结算：抽取事实/角色状态/时间线/伏笔动作/摘要/新设定
'use strict';
import { createHash } from 'node:crypto';
import * as store from '../db/store.js';
import { assembleReviewMessages } from '../llm/cache.js';
import { runTask } from '../llm/router.js';
import { extractJSON } from '../util/json.js';
import { settleInstruction } from './prompts.js';
import { applyFacts, characterNames } from './factbook.js';
import { applyForeshadowActions, allForeshadowsText } from './foreshadow.js';
import { applyDeathAndCardEnrich } from './characters.js'; // V0.37：死亡自动退场 + 卡片丰富
import { tidyPendingEntities } from './pending.js'; // V0.40：待登记实体自动治理
import { compressProtagonistState } from './growth.js'; // V0.75 主角 state_json 压缩（防过时叙事键堆积）
import { touchEntities } from './world_expansion.js'; // V0.76 记录地点/势力登场章节（世界展开检测数据源）
import { extractEraMarkers } from './history.js'; // V0.82 历史纪年抽取（公元年/年号纪年/季节 → timeline 锚点）
import { isSaneName, entityNamePlausible } from './names.js'; // V0.83 角色名质量门（占位名/称谓名不建卡） // V0.93.11 实体类型名合理性门（物品名/短语名不冒充地点/势力）
import { historicalChapterFrame, syncHistoricalProtagonistState } from './historical_state.js';
import { reconcileStoryArcsForChapter, touchCharacters, registerOutlineLocations, normalizeCharacterAnchors } from './pleasure.js'; // V0.93.5 台账联动 // V0.93.7 last 补平
import { transitionChapterStatus } from './chapter_status.js'; // V0.93.2：状态写入单一真源
import { applySettlementMemories } from './narrative_memory.js'; // V0.95：叙事记忆提取落库（人物声音/承诺/道具细节）
import { appendRollingRecent, rollingText } from './rolling.js'; // V0.95：滚动摘要两段式（settle 只写 recent 段）
import { touchItems } from './items.js'; // V0.95：物品/势力锚点推进
import { ensureVolumeSummaries } from './archive.js'; // V0.95：卷完成懒生成卷摘要（卷速查表）
import { sanitizeStoryMemoryText, detectEditorialVoiceLeak } from './rules.js';
import {
  assertNarrativeStateReady, recordSettledNarrativeExtension, validateNarrativeProjection,
  deterministicChapterProjection,
} from './narrative_state.js';
import { recordChapterDiversityFeatures } from './chapter_diversity.js';

// 仅供显式 data 测试钩子兼容旧 fixture；真实模型响应绝不自动补证据。
function coerceInjectedSettlementProjection(raw, chapterText, outline = {}) {
  const evidence = String(chapterText || '').trim().slice(0, 24);
  const withEvidence = item => ({ ...(item && typeof item === 'object' ? item : {}), evidence });
  const actual = raw?.outline_actual || {};
  const sceneRows = Array.isArray(actual.scenes) && actual.scenes.length
    ? actual.scenes
    : (Array.isArray(outline.scenes) && outline.scenes.length
      ? outline.scenes.map((scene, index) => ({ id: scene.id || `s${index + 1}`, beat: scene.beat || '本章场景发生变化' }))
      : [{ id: 's1', beat: '本章人物采取行动并改变局面' }]);
  const pick = (field, fallback) => String(actual[field] || outline[field] || fallback);
  return {
    ...(raw || {}),
    summary: String(raw?.summary || '本章发生关键行动。'),
    rolling_update: String(raw?.rolling_update || raw?.summary || '本章发生关键行动。'),
    outline_actual: {
      goal: pick('goal', '处理眼前问题'),
      conflict: pick('conflict', '行动与保留退路不可兼得'),
      dramatic_question: pick('dramatic_question', '人物是否愿意承担行动后果？'),
      counterforce: pick('counterforce', '局势与他人阻止行动'),
      turn: pick('turn', '原有办法失效'),
      irreversible_change: pick('irreversible_change', '行动后无法无成本回到原状'),
      choice_cost: pick('choice_cost', '人物作出选择并承担代价'),
      reader_gain: pick('reader_gain', '读者看到行动及其后果'),
      reader_pull: pick('reader_pull', '行动后果仍需继续处理'),
      evidence,
      scenes: sceneRows.map(withEvidence),
    },
    facts: (raw?.facts || []).map(withEvidence),
    character_updates: (raw?.character_updates || []).map(withEvidence),
    character_notes: (raw?.character_notes || []).map(withEvidence),
    character_emotional: (raw?.character_emotional || []).map(withEvidence),
    timeline: (raw?.timeline || []).map(item => withEvidence(
      typeof item === 'string' ? { event: item } : item,
    )),
    foreshadow_actions: (raw?.foreshadow_actions || []).map(withEvidence),
    memory_entries: (raw?.memory_entries || []).map(withEvidence),
    new_entities: (raw?.new_entities || []).map(withEvidence),
  };
}

/**
 * 章结算（抽取并落库）。
 * @returns {Promise<{facts:object, characters:number, timeline:number, foreshadows:object, newEntities:number, summary:string}>}
 */
export async function settleChapter(bookId, chapterId, { signal, data, streamCb, onEvent } = {}) {
  const narrativeReady = assertNarrativeStateReady(bookId);
  const parentNarrativeRevisionId = narrativeReady.revision?.id || null;
  const chapter = store.chapters.get(chapterId);
  if (!chapter) throw new Error('章节不存在');
  const book = store.books.get(bookId);
  const chapterFrame = historicalChapterFrame(bookId, chapterId);
  const chapterText = store.chapters.fullText(chapterId);
  if (!chapterText) throw new Error('本章还没有正文');
  const contentHash = createHash('sha256').update(chapterText).digest('hex');
  const previousSettlement = store.chapterSettlements.get(chapterId);
  if (previousSettlement?.content_hash === contentHash) {
    recordChapterDiversityFeatures(bookId, chapterId, {
      revisionId: previousSettlement.result?.narrativeRevision || '',
      sourceHash: contentHash,
      outline: store.chapters.outline(chapterId) || {},
      text: chapterText,
    });
    return { ...previousSettlement.result, reused: true };
  }
  if (previousSettlement && previousSettlement.content_hash !== contentHash) {
    const error = new Error('章节正文已在结算后发生变化，需要先重建该章派生状态');
    error.code = 'SETTLEMENT_STALE';
    throw error;
  }
  // V0.73：knownFacts 限流为最近 100 条——此前全量 active（长书 1000+ 条）塞进结算尾部，
  // 烧 token 且淹没模型。事实库用于"对照冲突"，旧事实已被滚动摘要/归档记忆覆盖。
  const knownFacts = store.facts.recent(bookId, { status: 'active', limit: 100 });
  const knownCharacters = characterNames(bookId);
  const knownForeshadows = store.foreshadows.list(bookId);
  const rollingSummary = rollingText(bookId); // V0.95：两段式统一读取（兼容旧格式）
  // V0.73 伏笔兑现修复：超期或临近回收的伏笔必须由结算强制判定 payoff/advance
  const overdueFs = store.foreshadows.forgotten(bookId, chapter.idx, 3);
  const approachingFs = store.foreshadows.approachingPayoff(bookId, chapter.idx, 2);
  const dueForeshadows = [...overdueFs, ...approachingFs];

  const instruction = settleInstruction({
    bookTitle: book.title, chapterTitle: chapter.title, chapterIdx: chapter.idx,
    chapterText, outline: store.chapters.outline(chapterId) || {}, knownFacts, knownCharacters,
    knownForeshadows: knownForeshadows.length ? knownForeshadows : [],
    rollingSummary,
    dueForeshadows,
    // V0.82：历史题材提示结算写纪年（年号+公元年+季节），供时间线锚点与史实边界注入
    eraNote: book.genre === '历史'
      ? `（历史题材：本章权威坐标为${chapterFrame ? `${chapterFrame.eraYear || ''}（${chapterFrame.year}年），主角${chapterFrame.age ?? '?'}岁` : '章细纲所列年代'}。timeline 不得另行猜测年代；事件务必带年号+公元年+季节。）`
      : '',
  });
  const messages = assembleReviewMessages(bookId, [{ role: 'user', content: instruction }]);
  // V0.28：data 可注入（测试友好；生产仍走 LLM 抽取）
  // V0.96.5：usage 透传（结算 8000 tokens 此前完全漏出"本次运行"统计）
  // V0.100.1：正常结算与重建投影同权——结构残缺/证据定位失败把本地原错误连同被拒输出
  // 退回模型重答一次（只准一次），第二次仍错 fail-closed。此前 SETTLEMENT_INVALID 直接卡章，
  // pilot 只能整章盲重试（同一提示词重掷骰子），弱网/免费档的输出瑕疵被放大成卡章事故。
  const SETTLEMENT_RETRYABLE = new Set(['SETTLEMENT_INVALID', 'PROJECTION_EVIDENCE_MISSING', 'PROJECTION_INVALID']);
  let parsed = null;
  let correction = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const attemptMessages = correction
      ? [...messages,
        { role: 'assistant', content: correction.badContent },
        { role: 'user', content: correction.text }]
      : messages;
    const res = data ? { content: JSON.stringify(data) } : await runTask({ task: 'settle', bookId, chapterId, messages: attemptMessages, jsonMode: true, signal, streamCb: { onUsage: streamCb?.onUsage, onUsageCost: streamCb?.onUsageCost } });
    const extracted = extractJSON(res.content);
    try {
      if (res.finishReason === 'length' || !extracted || typeof extracted !== 'object' || typeof extracted.summary !== 'string' || !extracted.summary.trim()) {
        const error = new Error(res.finishReason === 'length' ? '章结算输出被截断' : '章结算输出无效或缺少摘要');
        error.code = 'SETTLEMENT_INVALID';
        throw error;
      }
      const projectionCandidate = data
        ? coerceInjectedSettlementProjection(extracted, chapterText, store.chapters.outline(chapterId) || {})
        : extracted;
      parsed = validateNarrativeProjection(projectionCandidate, chapterText, chapter);
      break;
    } catch (error) {
      error.code = error.code || 'SETTLEMENT_INVALID';
      const canCorrect = attempt === 0 && !data && SETTLEMENT_RETRYABLE.has(error.code);
      if (canCorrect) {
        correction = {
          badContent: String(res.content || '').slice(0, 20000) || '(上一版输出为空)',
          text: `本地确定性校验拒绝了上一版输出：${error.message}\n\n`
            + 'evidence 必须是本章正文中逐字连续出现的原句（可省略标点引号，但每个汉字都必须与正文一致；逐字找不到原句支撑的条目直接删除该条）。'
            + '禁止用省略号拼接不相邻的两段。引用对白只取连续的一段。'
            + '输出必须是完整合法的 JSON：summary/outline_actual/facts/timeline 等字段齐全，不截断、不加 markdown 围栏、不加解释。'
            + '其余内容不变，只修校验点出的问题，重新输出完整 JSON。',
        };
        onEvent?.({
          type: 'settlement_retry', chapterId, reason: error.message,
          message: `章结算输出未通过本地校验（${String(error.message).slice(0, 60)}），已退回模型重答一次…`,
        });
        continue;
      }
      // V0.102.9：重答后证据仍无法逐字定位，不得把已写正文卡成 quality_blocked。
      // 注入 data 与空/截断 JSON 仍 fail-closed；仅投影证据/结构在第二轮失败时改走正文截取降级。
      const canDegrade = !data
        && (error.code === 'PROJECTION_EVIDENCE_MISSING' || error.code === 'PROJECTION_INVALID');
      if (!canDegrade) throw error;
      parsed = validateNarrativeProjection(
        deterministicChapterProjection(chapterText, chapter),
        chapterText,
        chapter,
      );
      onEvent?.({
        type: 'settlement_degraded', chapterId, reason: error.message,
        message: '章结算两轮取证仍无法逐字定位，已按当前正文截取确定性投影降级放行（幻觉引文未入账）',
      });
      break;
    }
  }
  parsed.summary = sanitizeStoryMemoryText(parsed.summary).trim();
  parsed.rolling_update = sanitizeStoryMemoryText(parsed.rolling_update || parsed.summary).trim();
  if (!parsed.summary) {
    const error = new Error('章结算摘要只含编辑/自检话语，拒绝写入故事记忆');
    error.code = 'SETTLEMENT_EDITORIAL_MEMORY';
    throw error;
  }
  const facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
    .filter(fact => !detectEditorialVoiceLeak(`${fact?.subject || ''} ${fact?.predicate || ''} ${fact?.object || ''}`).length);
  if (Array.isArray(parsed.memory_entries)) {
    parsed.memory_entries = parsed.memory_entries
      .map(entry => ({ ...entry, content: sanitizeStoryMemoryText(entry?.content || '').trim() }))
      .filter(entry => entry.content);
  }
  const charUpdates = Array.isArray(parsed.character_updates) ? parsed.character_updates : [];
  const timelineEvents = Array.isArray(parsed.timeline) ? parsed.timeline : [];
  const fsActions = Array.isArray(parsed.foreshadow_actions) ? parsed.foreshadow_actions : [];
  const newEntities = Array.isArray(parsed.new_entities) ? parsed.new_entities : [];
  const charNotes = Array.isArray(parsed.character_notes) ? parsed.character_notes : []; // V0.37：配角表现注记

  // LLM 调用在事务外；以下所有派生投影与章节状态必须原子提交。
  const settled = store.transaction(() => {
  // 1) 事实
  const factResult = applyFacts(bookId, facts, chapter.idx);
  // 2) 角色状态
  let charCount = 0;
  let placeholderNames = 0; // V0.83：占位名/称谓名不建卡（进 pending 等待具名），防止"灰衣人/老者"稳定入角色库
  for (const cu of charUpdates) {
    const name = (cu.name || '').trim();
    const changes = Array.isArray(cu.changes) ? cu.changes : [];
    if (!name) continue;
    // V0.83 名字质量门：占位名/纯称谓名不建卡；已存在角色仍更新状态（具名角色不受影响）
    if (!store.characters.list(bookId).some(c => c.name === name) && !isSaneName(name)) {
      try {
        store.pendingEntities.add(bookId, { name, context: `结算抽取待具名（来源章节 ch${chapter.idx}）`, sourceChapter: chapter.idx });
      } catch { /* ignore */ }
      placeholderNames++;
      continue;
    }
    const existing = store.characters.list(bookId).find(c => c.name === name);
    if (existing) {
      let state = {};
      try { state = JSON.parse(existing.state_json || '{}'); } catch { state = {}; }
      for (const ch of changes) {
        if (typeof ch !== 'string') continue; // V0.20：模型输出非字符串时跳过，防结算崩溃
        const eq = ch.indexOf('=');
        if (eq > 0) state[ch.slice(0, eq).trim()] = ch.slice(eq + 1).trim();
      }
      store.characters.update(existing.id, { state, lastChapter: chapter.idx });
    } else {
      const state = {};
      for (const ch of changes) {
        if (typeof ch !== 'string') continue; // V0.20：模型输出非字符串时跳过，防结算崩溃
        const eq = ch.indexOf('=');
        if (eq > 0) state[ch.slice(0, eq).trim()] = ch.slice(eq + 1).trim();
      }
      store.characters.create(bookId, { name, card: { role: '（待完善）' }, state });
      const nc = store.characters.list(bookId).find(c => c.name === name);
      if (nc) store.characters.update(nc.id, { firstChapter: chapter.idx, lastChapter: chapter.idx });
    }
    charCount++;
  }
  // 3) 时间线（V0.82：历史题材本地纪年抽取——公元年/年号纪年/季节 → timeline 新列）
  for (const ev of timelineEvents) {
    const event = typeof ev === 'string' ? ev : String(ev?.event || '').trim();
    if (event) {
      const markers = book.genre === '历史' ? extractEraMarkers(event) : { year: null, eraYear: '', season: '' };
      store.timeline.add(bookId, {
        chapterId, event,
        year: chapterFrame?.year ?? markers.year,
        eraYear: chapterFrame?.eraYear || markers.eraYear,
        season: markers.season,
      });
    }
  }
  // 4) 伏笔（含事件流水：note 写入 events）
  const fsResult = applyForeshadowActions(bookId, fsActions, chapter.idx, { chapterText });
  // 5) 摘要 + 滚动摘要增量（V0.70：截断保留最近 12 章——此前无限追加，
  // 归档前可累积数万字且全量注入每次指令 → 上下文膨胀/预算压力）
  if (parsed.summary) store.summaries.set(chapterId, bookId, parsed.summary);
  reconcileStoryArcsForChapter(bookId, chapter.idx, { chapterText, summary: parsed.summary || '' });
  // V0.93.5 台账-正文联动（零 LLM，不依赖模型自报）：
  // ① 已登记角色正文出现即推进 last_chapter（模型 character_updates 常漏报配角）；
  // ② 本章细纲 scenes[].location 自动补登记缺失地点（模型 new_entities 常漏报地点）。
  try { touchCharacters(bookId, chapterText, chapter.idx); } catch { /* 联动失败不阻塞结算 */ }
  // V0.93.7：last=null 的角色补平 last=first（AI 补全建卡不写锚点；只增不覆盖）
  try { normalizeCharacterAnchors(bookId); } catch { /* 联动失败不阻塞结算 */ }
  try {
    const outline = store.chapters.outline(chapterId) || {};
    registerOutlineLocations(bookId, (outline.scenes || []).map(s => s.location || ''), chapter.idx);
  } catch { /* 联动失败不阻塞结算 */ }
  if (parsed.rolling_update || parsed.summary) {
    // V0.95：滚动摘要两段式——settle 只追加 recent 段（保最近 12 段），归档必保块（pinned）
    // 由 archive 写入，两个写入路径不再互相覆盖（单一真源）
    appendRollingRecent(bookId, chapter.idx, parsed.rolling_update || parsed.summary);
  }
  // V0.95：叙事记忆提取落库（复用本次结算调用输出 memory_entries，零新增 LLM 成本）
  try { applySettlementMemories(bookId, chapterId, chapter.idx, parsed.memory_entries); } catch { /* 记忆失败不阻塞结算 */ }
  // V0.95：物品/势力锚点推进（零 LLM，仿 touchCharacters）
  try { touchItems(bookId, chapterText, chapter.idx); } catch { /* 联动失败不阻塞结算 */ }
  // V0.37：死亡自动退场 + 配角卡自动丰富（character_notes 并入卡片）
  const lifeCycle = applyDeathAndCardEnrich(bookId, charUpdates, charNotes, chapter.idx);
  if (lifeCycle.deceased.length) {
    store.timeline.add(bookId, { chapterId, event: `${lifeCycle.deceased.join('、')}死亡退场` });
  }
  // V0.49：心境/关系变化回写角色卡（character_emotional → state.心境 + relation 列；防膨胀限 30 字）
  for (const em of parsed.character_emotional || []) {
    const name = (em.name || '').trim();
    if (!name) continue;
    const existing = store.characters.list(bookId).find(c => c.name === name);
    if (!existing) continue;
    const mood = (em.mood || '').trim().slice(0, 30);
    const relDelta = (em.relation_delta || '').trim().slice(0, 30);
    const patch = {};
    if (mood && mood !== '无') {
      let st = {};
      try { st = JSON.parse(existing.state_json || '{}'); } catch { st = {}; }
      st['心境'] = mood;
      patch.state = st;
    }
    if (relDelta && relDelta !== '无') {
      const prevRel = (existing.relation || '').slice(0, 120);
      patch.relation = prevRel ? `${prevRel}；${relDelta}` : relDelta;
    }
    if (Object.keys(patch).length) store.characters.update(existing.id, patch);
  }
  // 6) 待登记新设定
  for (const ne of newEntities) {
    const name = (ne.name || '').trim();
    if (!name) continue;
    // V0.28：带 type 的实体自动写入对应卡表（设定自动化闭环：地点/物品/势力/角色）
    const kindMap = { location: 'locations', item: 'items', faction: 'factions', character: 'characters' };
    const kind = kindMap[(ne.type || '').toLowerCase()];
    if (kind) {
      const existing = store[kind].list(bookId).find(e => e.name === name);
      // V0.83：角色卡名字质量门——占位名/称谓名不建卡（进 pending 等待具名），防"灰衣人"稳定入角色库
      if (kind === 'characters' && !existing && !isSaneName(name)) {
        try { store.pendingEntities.add(bookId, { name, context: `${ne.context || ''}（结算抽取待具名，ch${chapter.idx}）`, sourceChapter: chapter.idx }); } catch { /* ignore */ }
        placeholderNames++;
        continue;
      }
      // V0.93.11：实体类型名合理性门——模型自报 type=location/faction/item 但名字明显是
      // 另一种东西（物品/地点/短语）时不建卡，进 pending 等待人工确认（doctor 曾实证
      // "青铜薄片/守碑人手札"入 locations、"旧阵基石门"入 factions——写审同源词表）。
      if (kind !== 'characters' && !existing && entityNamePlausible(kind, name).length) {
        try { store.pendingEntities.add(bookId, { name, context: `${ne.context || ''}（实体类型存疑，ch${chapter.idx}）`, sourceChapter: chapter.idx }); } catch { /* ignore */ }
        continue;
      }
      const card = { type: ne.subtype || '', detail: ne.context || '' };
      if (existing) store[kind].update(existing.id, { card });
      else {
        // V0.76：新登场地点/势力直接记录首现章节（世界展开检测依赖 first_chapter）
        const created = store[kind].create(bookId, { name, card });
        if (created && (kind === 'locations' || kind === 'factions')) {
          store[kind].update(created.id, { firstChapter: chapter.idx });
        }
      }
    } else {
      store.pendingEntities.add(bookId, { name, context: ne.context || '', sourceChapter: chapter.idx });
    }
  }
  // V0.40：待登记实体自动治理（去重/类型推断建卡/超期归档，零 LLM 成本）
  const tidy = tidyPendingEntities(bookId, { currentChapter: chapter.idx });
  if (tidy.confirmed || tidy.archived) {
    store.timeline.add(bookId, { chapterId, event: `待登记自动整理：登记 ${tidy.confirmed} 项、归档 ${tidy.archived} 项` });
  }
  // V0.76：记录本章登场的地点/势力首现/最近章节（世界展开检测数据源；放在 tidy 之后保证自动建卡也计入）
  try {
    const touched = touchEntities(bookId, chapterText, chapter.idx);
    if (touched.length) {
      store.timeline.add(bookId, { chapterId, event: `登场地点/势力：${touched.slice(0, 8).join('、')}${touched.length > 8 ? '等' : ''}` });
    }
  } catch { /* 记录失败不阻塞结算 */ }
  // V0.60 防屎山：清理过期债务（只保留最近 5 章的活跃债务，更早的圆场窗口已过）
  store.conflicts.pruneBefore(bookId, chapter.idx - 4);
  // V0.75 主角 state_json 压缩：键数 >30 时收敛到关键维度字段（丢弃"发现X""判断Y"等过时叙事键）
  try { compressProtagonistState(bookId, {}); } catch { /* 压缩失败不阻塞结算 */ }
  try { syncHistoricalProtagonistState(bookId, chapterId); } catch { /* 年代同步失败不阻塞结算 */ }

  transitionChapterStatus(bookId, chapterId, 'settled', { reason: '结算事务' });
  const result = {
    facts: factResult,
    characters: charCount,
    timeline: timelineEvents.length,
    foreshadows: fsResult,
    newEntities: newEntities.length,
    summary: parsed.summary || '',
  };
  const extension = recordSettledNarrativeExtension(bookId, chapterId, {
    parentRevisionId: parentNarrativeRevisionId,
    summary: parsed.summary || '',
    projection: parsed,
  });
  if (extension) result.narrativeRevision = extension.id;
  store.chapterSettlements.set(bookId, chapterId, { contentHash, result });
  recordChapterDiversityFeatures(bookId, chapterId, {
    revisionId: result.narrativeRevision || '',
    sourceHash: contentHash,
    outline: { ...(store.chapters.outline(chapterId) || {}), ...(parsed.outline_actual || {}) },
    text: chapterText,
  });
  return result;
  });
  // V0.95 事务后副作用（同步事务回调外执行——失败不回滚正文结算，也不阻塞主流程）：
  // ① 增量向量索引（盘活语义召回——embedding 未启用时静默 skip）
  try {
    const { indexChapter } = await import('../memory/indexer.js');
    await indexChapter(bookId, chapterId);
  } catch { /* 索引失败不影响结算 */ }
  // ② 卷完成懒生成卷摘要（卷速查表；内部只处理"全完成且无摘要"的卷，开销可忽略）
  try { ensureVolumeSummaries(bookId); } catch { /* 卷摘要失败不影响结算 */ }
  return settled;
}

/** 引用伏笔文本（结算指令需要） */
export { allForeshadowsText };
