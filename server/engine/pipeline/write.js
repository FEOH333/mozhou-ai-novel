// server/engine/pipeline/write.js —— 场景正文生成（缓存感知：正文进历史堆；固定注入区 + 长度自愈）
'use strict';
import * as store from '../../db/store.js';
import { assembleReviewMessages, appendHistory } from '../../llm/cache.js';
import { assembleCreativeMessages } from '../../llm/context_planner.js';
import { runTask } from '../../llm/router.js';
import { estimateChineseChars } from '../../llm/tokenizer.js';
import { writeSceneInstruction } from '../prompts.js';
import { characterRollCallText, characterCardsText, growthStatus, longRunningStateDebtText, rivalCharactersInScene } from '../narrative/characters.js'; // V0.37：角色点名册（活跃/退场）；V0.49：角色卡关键字段；V0.74 题材感知成长状态 // V0.108：对手型角色出场检测（人物活性注入）
import { activateEntriesText } from '../narrative/worldbook.js';
import { styleRulesText } from '../../data/creative_packs.js';
import { techniqueInjection, guessSceneType, buildDynamicStyle, isWarfareText, WARFARE_BODY_TEXT, WARFARE_HISTORY_TEXT, isCourtIntrigueText, COURT_INTRIGUE_TEXT, COURT_HISTORY_TEXT, ENVIRONMENT_TEXT, ENVIRONMENT_HISTORY_TEXT, PSYCHOLOGY_TEXT, PSYCHOLOGY_HISTORY_TEXT, CONTINUITY_CRAFT_TEXT, VALLEY_FRAGMENT_TEXT } from '../../data/literary_techniques.js'; // V0.43 文学技法+动态文风 // V0.87 战役纪律 // V0.88 朝堂权谋纪律 // V0.89 环境+心理纪律 // V0.97 细节一致与章法轮换 // V0.98.13 近战残酷纪律(并入写审同源常量) // V0.101 低谷碎片（仅约束命中时注入）
import { activeForeshadowsText, approachingForeshadowsText, overdueForeshadowsText } from '../narrative/foreshadow.js';
import { relevantFacts, formatFacts, relevantFactsSmart } from '../narrative/factbook.js'; // V0.83 语义增强事实召回
import { locationCardText } from '../narrative/locations.js'; // V0.71：地点卡注入（稳定地点简短、变化地点强调）
import { buildPleasureContext } from '../quality/pleasure.js';
import { rollingText } from '../narrative/rolling.js'; // V0.95：滚动摘要两段式统一读取
import { narrativeMemoryText } from '../narrative/narrative_memory.js'; // V0.95：叙事记忆注入（人物声音/道具细节）
import { itemCardsText } from '../narrative/items.js'; // V0.95：物品/势力场景卡注入
import { ensureHistory } from '../planning/outline.js';
import { PLOT_DEAI_TEXT } from '../quality/plot_ai.js'; // V0.80 剧情发展去AI味（硬要求注入）
import { poetryForScene, eraContextText, eraBoundaryText, currentStoryYear, isHistoricalEraBook, eraRedLineCheck } from '../narrative/history.js'; // V0.81 诗词融入 + 时代红线节选 // V0.82 史实边界注入 // V0.88 宋末书锚点判定 // V0.105.7 时代器物写侧硬闸
import { HISTORY_DEAI_TEXT, WARFARE_ANCHORS, COURT_ANCHORS } from '../../data/history.js'; // V0.81 历史去AI味 // V0.87 宋蒙战争考据锚点 // V0.88 南宋朝堂考据锚点
import { historicalPhaseForVolume, historicalScaleRegisterText } from '../longform/historical_longform.js'; // V0.91 四十年章节坐标 // V0.95.8 山河尺度分层纪律
import { crossYearOpeningIssue } from '../longform/historical_guardrails.js'; // V0.95.7 跨年开篇写审同源核查
import { isCompletedChapter, transitionChapterStatus } from './chapter_status.js'; // V0.93.1：完成态单一真源 // V0.93.2：状态写入单一真源
import { sanitizeStoryMemoryText } from '../quality/rules.js'; // V0.97.2：故事记忆不得夹带编辑话语
import { openingReaderContractText } from '../planning/opening_intervention.js'; // V0.98：只注入读者结构契约，绝不注入前置正文
import { appendPublicationFeedback } from '../quality/publication_feedback.js'; // V0.99：推流审核/作品数据动态 L4
import { narrativeLessonsText } from '../quality/narrative_lessons.js';
import { buildCraftQuotaText } from '../quality/craft_quota.js';
import { compileBookDiversityContract } from '../quality/chapter_diversity.js';
import { compileBookCraftOccupancy, healCraftMorphology, buildBookLedgerBrief } from '../quality/craft_occupancy.js';
import { closeTrailingSentence } from '../quality/polish.js'; // V0.105.5：末句完整性收口（autoHealSceneLength 共用入口）

/**
 * V0.93.3 历史章节坐标帧（纯函数，可单测）。
 * 跨年章（year > prevYear）追加跨年过渡硬要求：本地护栏（historicalContinuityIssues）
 * 会核查正文开头（前 420 字）是否有"次年/年号"等明确跨年标记，此前模型不知道这条校验，
 * 跨年章开篇写成"七日后/翌日"被驳回后进入重规划连败。这里把校验口径写进帧文本（写审同源）。
 */
export function historicalFrameText(outline = {}, phase, prevYear = null) {
  const year = Number(outline.year) || Number(phase?.startYear) || null;
  if (!Number.isInteger(year)) return '';
  const age = Number(outline.protagonist_age) || (year - 1232);
  const frame = `公元${year}年｜${outline.era_year || '年号须据公元年核对'}｜主角${age}岁｜阶段：${outline.phase || phase?.title || '未标注'}｜回报：${outline.reward_mode || phase?.rewardModes?.[0] || '信息'}｜情绪：${outline.emotion || phase?.emotions?.[0] || '紧张5'}`;
  const crossed = Number.isInteger(Number(prevYear)) && year > Number(prevYear);
  if (!crossed) return frame;
  return `${frame}｜跨年：由${prevYear}年→${year}年，本章开篇场景（第一个场景）正文开头必须写"次年/${outline.era_year || '新年号'}"等明确跨年标记与季节，禁止写"七日后/翌日"等紧接上章的时间。`;
}

/** V0.89：环境/心理纪律注入判定（纯函数，可单测）
 *  @param {string} sceneType 场景类型（fight/emotion/suspense/dialogue/climax/daily/reveal）
 *  @param {number} sceneIdx 章内场景序号（1 起）
 * @param {boolean} isHistoricalEra 是否宋末书（决定是否拼历史质感段）
 *  @returns {{environmentText:string, psychologyText:string}} */
export function envPsyDisciplines(sceneType, sceneIdx, isHistoricalEra) {
  const env = (sceneType === 'daily' || sceneType === 'emotion' || (sceneIdx === 1 && sceneType !== 'fight'));
  const psy = (sceneType === 'emotion' || sceneType === 'suspense' || sceneType === 'dialogue' || sceneType === 'climax');
  return {
 environmentText: env ? (isHistoricalEra ? `${ENVIRONMENT_TEXT}\n\n${ENVIRONMENT_HISTORY_TEXT}` : ENVIRONMENT_TEXT) : '',
 psychologyText: psy ? (isHistoricalEra ? `${PSYCHOLOGY_TEXT}\n\n${PSYCHOLOGY_HISTORY_TEXT}` : PSYCHOLOGY_TEXT) : '',
  };
}

/**
 * 生成一个场景正文（流式）。长度自愈：不足下限自动续写（≤2 轮），超上限自动压缩重写。
 * @param {string} bookId @param {string} chapterId @param {string} sceneId
 * @param {object} [opts] { onDelta, onProgress, signal, autoHeal=true }
 * @returns {Promise<{content:string, scene:object, usage:object, cost:object, healed:boolean}>}
 */
export async function writeScene(bookId, chapterId, sceneId, opts = {}) {
  const { onDelta, onProgress, signal, autoHeal = true, onRetry, resilience } = opts;
  const chapter = store.chapters.get(chapterId);
  if (!chapter) throw new Error('章节不存在');
  const book = store.books.get(bookId);
  const outline = store.chapters.outline(chapterId);
  if (!outline?.scenes?.length) throw new Error('本章还没有细纲，请先生成细纲');
  const scenes = store.scenes.list(chapterId);
  const scene = scenes.find(s => s.id === sceneId);
  if (!scene) throw new Error('场景不存在');
  ensureHistory(bookId);

  const scenesBefore = scenes.filter(s => s.idx < scene.idx);
  const sceneAfter = scenes.find(s => s.idx > scene.idx);
  const prevScene = scenes.find(s => s.idx === scene.idx - 1);
  const prevTail = prevScene?.content ? prevScene.content.slice(-180) : '';
  const prevSceneSummary = prevScene ? `${prevScene.beat}（已完成）` : '';

  // 固定注入区（NovelClaw 式：不依赖检索的保底召回）+ 动态检索（全进最后一条 user 指令）
  const scanText = JSON.stringify(outline) + ' ' + outline.scenes.map(s => s.beat).join(' ');
  const worldbookText = activateEntriesText(bookId, scanText);
  const factsText = formatFacts(await relevantFactsSmart(bookId, scene.beat, 8));
  // V0.73：三种伏笔来源按 id 去重（同一伏笔可能同时出现在 active/approaching/overdue）
  const fsSections = [
    activeForeshadowsText(bookId),
    approachingForeshadowsText(bookId, chapter.idx),
    overdueForeshadowsText(bookId, chapter.idx),
  ].filter(Boolean);
  const seenFs = new Set();
  const foreshadowsText = fsSections.map(sec =>
    sec.split('\n').filter(l => {
      const m = l.match(/\[([^\]]+)\]/);
      if (!m) return true;
      if (seenFs.has(m[1])) return false;
      seenFs.add(m[1]);
      return true;
    }).join('\n')
  ).filter(Boolean).join('\n').split('\n').filter(Boolean).slice(0, 6).join('\n');
  const bookSettings = store.books.settings(bookId);
  const rules = bookSettings.userRules || '';
  // V0.22：反 AI 味风格纪律（风格画像 + 用户文风样本 + AI 高频词红线）
  // V0.95：isHistory 过滤与史实流回报纪律冲突的画像规则（如 fierce「打脸节奏」）
  const styleRules = styleRulesText(bookSettings.styleProfile, bookSettings.styleSample, {
    isHistory: book.genre === '历史', compact: true,
  });
  // 约束反哺（V0.16：漂移诊断产出的 extra_constraints 持续注入）
  // V0.73 缓存修复：改用限流版——全量 text() 会把 400+ 条累积约束（数十万字符）塞进每条
  // write 指令，尾部全 miss 且模型被过时指令干扰。全局约束必保，逐章反馈约束只取最近 12 条。
  const extraConstraints = store.constraints.recentText(bookId, { chapterIdx: chapter.idx, limit: 6, maxChars: 1600 });
  const rollingSummary = rollingText(bookId); // V0.95：两段式统一读取（兼容旧格式）
  const recentSummaries = store.chapters.list(bookId)
    .filter(c => c.idx < chapter.idx).slice(-2)
    .map(c => ({ idx: c.idx, summary: sanitizeStoryMemoryText(store.summaries.get(c.id)?.summary || '') }))
    .filter(row => row.summary);
  // V0.70：时间线注入限量（此前全量注入——长书上千条事件浪费 tokens 且稀释重点；取最近 20 条）
  const timelineEvents = store.timeline.list(bookId).map(t => t.event).slice(-8);
  const futureChapters = store.chapters.list(bookId)
    .filter(c => c.idx > chapter.idx).slice(0, 3)
    .map(c => ({ idx: c.idx, beat: store.chapters.outline(c.id)?.beat || '' }));
  // V0.37：角色点名册（活跃角色状态 + 已退场角色硬规则）
  const rollCallText = characterRollCallText(bookId, { limit: 6, chapterIdx: chapter.idx });
  // V0.49：角色卡关键字段注入（当前场景出场角色：性格/目标/秘密/心境/关系——人物戏硬要点）
  const sceneNames = [scene.pov, ...(scene.beat || '').match(/[一-龥]{2,4}(?=与|和|跟|对|向)/g) || []].filter(Boolean);
  const cardText = characterCardsText(bookId, { names: sceneNames, limit: 3, chapterIdx: chapter.idx });
  // V0.108：对手型角色出场（beat/POV 命中 rival 标记）→ 正文注入反派纪律 brief
  const rivalNames = rivalCharactersInScene(bookId, `${scene.beat || ''} ${scene.location || ''}`, scene.pov || '');
  // V0.50：按需注入——人物戏要点只注入 setup/payoff 节奏章（advance 推进章不强制人物戏，
  // 避免每章都情感/烟火气喧宾夺主）；pace 由细纲生成时自定
  const pace = outline.pace || 'advance';
  const characterBeat = (pace === 'setup' || pace === 'payoff') ? (outline.character_beat || null) : null;
  // V0.50：社会生态按场景地点动态注入（ecology 材料不进公共前缀——场景在市井地点才注入烟火气）
  let ecologyText = '';
  try {
    const ecoMat = store.materials.get(bookId, 'ecology');
    if (ecoMat?.content && scene.location) {
      const lines = ecoMat.content.split('\n');
      const matched = lines.filter(l => l.includes('【') && l.includes(scene.location)) ||
        lines.filter(l => l.includes('【') && (scene.beat || '').includes(l.match(/【([^】]+)】/)?.[1] || '____'));
      ecologyText = matched.join('\n').slice(0, 500) || '';
    }
  } catch { /* 无 ecology 材料忽略 */ }
  // V0.71：地点卡注入（场景所在地点的类型/描述/状态——稳定地点简短注入，变化地点强调）
  let locationText = '';
  try { locationText = locationCardText(bookId, scene.location); } catch { /* 无地点卡忽略 */ }
  // 存量兼容：ecology 材料缺失时从 world 提取【社会生态】段
  if (!ecologyText) {
    try {
      const w = store.materials.get(bookId, 'world')?.content || '';
      const i = w.indexOf('【社会生态】');
      if (i >= 0) ecologyText = w.slice(i, i + 400);
    } catch { /* ignore */ }
  }
  // V0.43：文学技法注入（按场景类型）+ 动态文风（题材×场景×情绪）
  // V0.83：场景类型持久化后直接用真实值（此前 scene.scene_type 从未落库 → 恒走 guessSceneType 猜测）
  const sceneType = scene.scene_type || guessSceneType(scene.beat, scene.pov);
  const techniqueText = techniqueInjection(sceneType);
  // V0.83：情绪判定扩充（此前只有"哭→虐/燃→燃"两态，紧张/甜/惧/惊/余韵永远触发不了）
  const beatLower = scene.beat || '';
  const detectEmotion = () => {
    if (/哭|泣|泪|悲|丧|痛|恸|殒|殉|诀别/.test(beatLower)) return '虐';
    if (/燃|战|杀|破|胜|捷|斩|攻|守城|破敌/.test(beatLower)) return '燃';
    if (/惧|恐|惊|怕|冷汗|毛骨悚然|瘆/.test(beatLower)) return '惊悚';
    if (/甜|笑|温|暖|依偎|柔情|告白/.test(beatLower)) return '甜';
    if (/紧张|对峙|逼近|压迫|围困|倒计时|危/.test(beatLower)) return '紧张';
    if (/余韵|回响|落定|尘埃|无言|沉默|凭吊|祭/.test(beatLower)) return '余韵';
    return '';
  };
  const dynamicStyle = buildDynamicStyle({
    genre: book.genre,
    sceneType,
    emotion: detectEmotion(),
  });

  // V0.74：题材感知主角成长状态注入（防成长线停滞——此前 100+ 章主角仍未入门练气）
  const powerStatus = [
    growthStatus(bookId, { chapterIdx: chapter.idx }).text,
    longRunningStateDebtText(bookId, chapter.idx),
  ].filter(Boolean).join('\n');
  // V0.95：叙事记忆注入（人物声音/道具细节/承诺——voice 按出场角色优先，长程质感一致性）
  const memoryText = narrativeMemoryText(bookId, {
    sceneText: `${scene.pov || ''} ${scene.location || ''} ${scene.beat || ''}`,
    characterNames: sceneNames,
  });
  // V0.95：物品/势力场景卡（场景提及才注入——防道具穿帮/势力设定漂移）
  const itemText = itemCardsText(bookId, { sceneText: `${scene.beat || ''} ${scene.location || ''}`, names: sceneNames });
  // V0.95：前文回响（语义召回早期相关场景片段——归档后早期细节可达；最近 3 章已在历史堆，跳过防重复）
  let sceneEchoText = '';
  try {
    const { semanticSearch } = await import('../../memory/vectorstore.js');
    const recentIds = new Set(store.chapters.list(bookId).filter(c => c.idx >= chapter.idx - 3).map(c => c.id));
    const rows = await semanticSearch(bookId, `${scene.beat || ''} ${scene.location || ''}`, 4, 'chapter');
    const echoes = rows.filter(r => r.score >= 0.5 && !recentIds.has(r.refId)).slice(0, 3);
    if (echoes.length) {
      const chapterIdxOf = new Map(store.chapters.list(bookId).map(c => [c.id, c.idx]));
      sceneEchoText = echoes.map(r => `- 第${chapterIdxOf.get(r.refId) ?? '?'}章片段：${r.chunk.replace(/\n+/g, ' ').slice(0, 90)}`).join('\n');
    }
  } catch { /* embedding 不可用/无索引 → 降级空（不阻断写作） */ }
  // V0.95：卷内曲线坐标（本卷第 X/Y 章 + 相位 + 距卷末章数——模型不再"盲写卷中位置"）
  const volChapters = chapter.volume_id ? store.chapters.listByVolume(chapter.volume_id) : [];
  const volPosIdx = volChapters.findIndex(c => c.idx === chapter.idx);
  let volumePosition = '';
  if (volChapters.length >= 3 && volPosIdx >= 0) {
    const ratio = volPosIdx / volChapters.length;
    const phase = ratio < 0.3 ? '铺垫期（埋设期待、积累矛盾，爽点以小为主）' : ratio < 0.75 ? '推进期（冲突升级、阶段性兑现，为卷末高潮蓄力）' : '收束期（优先兑现卷内旧账，高潮与卷级转折，节奏收紧）';
    volumePosition = `本卷第 ${volPosIdx + 1}/${volChapters.length} 章｜相位：${phase}｜距卷末 ${volChapters.length - volPosIdx - 1} 章${ratio < 0.33 ? '｜本卷高潮事件不得在本章提前透支' : ''}`;
  }
  // V0.95：场景节奏标注（细纲 scenes[].pacing → 句长/密度纪律——治 AI"匀速铺开"通病：
  // 全章一个速度没有爆发与沉淀的对比，读者感知不到节奏）
  const PACING_RULES = {
    爆发: '【本场景节奏：爆发】句句推进，平均句长压短（紧张段落每句不超过 15 字），动词优先，一段不超过 3 句；禁环境长描写与心理回溯——它们留给铺垫场景。',
    推进: '【本场景节奏：推进】信息与对抗交替，中等句长；每 3-4 段须有一次小钩或信息增量，不得匀速流水。',
    铺垫: '【本场景节奏：铺垫】慢速蓄力：环境细节、人物习惯、微小的异常信号都要埋；但必须有"指向性"——每个细节都在为爆发场景装弹药，禁止与后文无关的风光描写。',
    余韵: '【本场景节奏：余韵】长句慢镜头：让上一场景的冲击在人物身体与周遭环境上留下痕迹（手还在抖/茶凉了/远处声音传来的方式变了）；禁立即开新冲突。',
  };
  const pacingText = PACING_RULES[scene.pacing] || '';
  const prevYear = (() => {
    const prev = store.chapters.list(bookId).filter(c => c.idx < chapter.idx).sort((a, b) => b.idx - a.idx)[0];
    if (!prev) return null;
    return Number(store.chapters.outline(prev.id)?.year) || null;
  })();
  const volumeIdx = chapter.volume_id ? store.volumes.get(chapter.volume_id)?.idx : 1;
  const volumePhase = historicalPhaseForVolume(book, volumeIdx);
  const historicalChapterFrame = book.genre === '历史'
    ? historicalFrameText(outline, volumePhase, prevYear)
    : '';
  // V0.95.8 山河尺度纪律：随卷数/主角身份递增的远景→中景→全景配额（写审同源；
  // 仅结构化长篇生效，26 章一个焦距的"求生冒险文质感"根因是 povScale 只封顶从未抬升）
  const scaleRegisterText = book.genre === '历史' ? historicalScaleRegisterText(volumeIdx, volumePhase) : '';

  // V0.95.7 跨年开篇硬要求（仅跨年章第一个场景）：坐标帧里的要求埋在长行中，模型连续多版
  // 写成氛围开头（ch27 实证"晨雾…"无跨年标记被审校驳回）——独立成醒目硬要求块注入。
  const outlineYear = Number(outline.year) || null;
  const crossedYear = book.genre === '历史' && scene.idx === 1
    && Number.isInteger(outlineYear) && Number.isInteger(prevYear) && outlineYear > prevYear;
  const crossYearOpeningRule = crossedYear
    ? `本章从公元${prevYear}年跨入${outlineYear}年${outline.era_year ? `（${outline.era_year}）` : ''}。本场景是全章开篇，正文开头 100 字内必须出现明确的跨年标记——正例："次年开春，宝祐二年的雪化得早，工地的木桩冒出了新茬"或"一年过去，山里的樵夫换了新历"；随后一两句带出季节与人物近况。禁止用"七日后/翌日/次日/当夜"等紧接上章的时间写法开头。`
    : '';

  // V0.94.0：破折号场景预算（章红线 ≤20 按场景 target 占比分摊）——指令注入与写后硬闸同源
  const sumTargets = Math.max(1, (outline.scenes || []).reduce((acc, s) => acc + (Number(s.target_words) || 1000), 0));
  const dashBudget = Math.max(3, Math.round(20 * (Number(scene.target_words) || 1000) / sumTargets));
  // V0.101：章级动作/套话余量按未写场景分配（含本场）；已用满则本场禁止再写
  const chapterTextSoFar = scenesBefore.map(s => s.content || '').join('\n');
  const remainingSceneCount = scenes.filter(s => s.idx >= scene.idx).length;
  const craftQuotaText = buildCraftQuotaText(chapterTextSoFar, remainingSceneCount);
  // V0.105.2 章级字数预算：场景写作给章级视野（指令建议 + 自愈压缩上限收紧）
  const wordBudget = sceneWordBudget({
    lengthProfile: bookSettings.lengthProfile,
    scenesBefore, scene, scenesAfter: scenes.filter(s => s.idx > scene.idx),
  });
  const valleyText = /低谷|代价章/.test(String(extraConstraints || '')) ? VALLEY_FRAGMENT_TEXT : '';

  const instruction = writeSceneInstruction({
    bookTitle: book.title,
    chapterIdx: chapter.idx,
    chapterTitle: chapter.title,
    goal: outline.goal,
    conflict: outline.conflict,
    continuityFrom: outline.continuity_from,
    scene,
    scenesBefore,
    sceneAfter,
    prevTail,
    prevSceneSummary,
    worldbookText,
    factsText,
    foreshadowsText,
    rules,
    rollingSummary,
    recentSummaries,
    timelineEvents,
    futureChapters,
    constraints: extraConstraints,
    pleasureContext: buildPleasureContext(bookId, chapter.idx, { compact: true, maxChars: 1400 }),
    narrativeLessons: narrativeLessonsText(bookId, chapter.idx),
    openingContractText: openingReaderContractText(bookId, chapter.idx),
    styleRules,
    rollCallText,
    cardText, // V0.49：角色卡关键字段（人物戏硬要点）
    characterBeat, // V0.50：按 pace 注入（advance 章为 null，不强制人物戏）
    ecologyText, // V0.50：按场景地点注入的市井烟火气（非市井场景为空）
    locationText, // V0.71：地点卡（类型/描述/状态——稳定地点简短，变化地点强调）
    perspective: book.perspective || 'third', // V0.42 叙述视角
    techniqueText, // V0.43 文学技法
    dynamicStyle, // V0.43 动态文风
    powerStatus, // V0.73 主角修炼状态
    historicalChapterFrame,
    memoryText, // V0.95：叙事记忆（人物声音/道具细节/承诺）
    itemText, // V0.95：物品/势力场景卡
    sceneEchoText, // V0.95：前文回响（语义召回早期相关片段）
    volumePosition, // V0.95：卷内曲线坐标（相位/距卷末）
    isHistory: book.genre === '历史',
    dashBudget, // V0.94.0：破折号场景预算（指令红线与写后硬闸同源）
    chapterBudgetText: wordBudget.text, // V0.105.2：章字数预算（仅非首场景注入，动态内容不进公共前缀）
    sceneMaxWords: wordBudget.maxWords, // V0.105.2：动态上限（章超支趋势时收紧，指令与自愈同源）
    rivalNames, // V0.108：本场对手型角色（人物活性反派纪律条件注入）
    craftQuotaText, // V0.101：章级动作配额的场景余量（只点名已动用/用满）
    diversityText: compileBookDiversityContract(bookId, chapter.idx).text,
    craftOccupancyText: compileBookCraftOccupancy(bookId, chapter.idx).text,
    ledgerBriefText: buildBookLedgerBrief(bookId, chapter.idx, { beat: scene.beat, pov: scene.pov }),
    valleyText, // V0.101：仅当快感调度派了低谷/代价章时注入碎片纪律
    crossYearOpeningRule, // V0.95.7：跨年开篇硬要求（仅跨年章场景1，独立醒目块）
    scaleRegisterText, // V0.95.8：山河尺度纪律（分层配额，随卷数递增）
    continuityCraft: CONTINUITY_CRAFT_TEXT, // V0.97：细节一致与章法轮换纪律（常驻，全题材）
    // V0.80：章末钩子（细纲 ending_hook → 落正文结尾）+ 剧情发展去AI味（硬要求）
    endingHook: outline.ending_hook ? (typeof outline.ending_hook === 'string' ? outline.ending_hook : outline.ending_hook.desc || '') : '',
    plotDeAI: PLOT_DEAI_TEXT,
    // V0.81 历史：诗词融入（关键节点情感点睛）+ 历史去AI味 + 时代红线节选（防时代错误）
    poetryText: book.genre === '历史' ? poetryForScene(scene.beat || '', sceneType, 2).text : '',
    historyDeAI: book.genre === '历史' ? HISTORY_DEAI_TEXT : '',
    eraContext: book.genre === '历史' ? eraContextText(bookId, { scope: 'chapter', maxChars: 300 }) : '',
    // V0.82 历史：史实边界注入（已过节点不可改前因/未到节点不得提前——防"事件提前"硬伤）
    eraBoundary: book.genre === '历史' ? eraBoundaryText(bookId, Number(outline.year) || currentStoryYear(bookId)) : '',
    // V0.87：战役场景注入战役纪律（战术推演真实/全员智商在线）+ 宋蒙战争考据锚点（守城设施/围城战术/兵器）；史实锚定段仅宋末书
    // V0.98.13：近战残酷纪律并入同一常量（刀入肉的手感/生理余波/成长印记）
    warfareText: isWarfareText(scene.beat, outline.goal, outline.conflict)
 ? (isHistoricalEraBook(book) ? `${WARFARE_BODY_TEXT}\n\n${WARFARE_HISTORY_TEXT}\n\n【本时代战役考据锚点】\n${WARFARE_ANCHORS}` : WARFARE_BODY_TEXT)
      : '',
    // V0.88：朝堂/权谋场景注入权谋纪律（皇帝性格与决策/双层对话/信息差/暗线四阶段/代价）+ 南宋末朝堂考据锚点；史实质感段仅宋末书
    courtText: isCourtIntrigueText(scene.beat, outline.goal, outline.conflict)
 ? (isHistoricalEraBook(book) ? `${COURT_INTRIGUE_TEXT}\n\n${COURT_HISTORY_TEXT}\n\n【本时代朝堂考据锚点】\n${COURT_ANCHORS}` : COURT_INTRIGUE_TEXT)
      : '',
    // V0.89：环境/心理描写纪律按场景类型注入——日常/情感场景注环境纪律（开篇定调/市井/抒情环境权重高，
    // 章首非战斗场景也注（每章开场定调）；战斗场景首场景不注（动词优先，环境纪律由战役纪律覆盖）；
    // 情感/悬念/对话/高潮场景注心理纪律（心理戏主战场，高潮含爽点心理反差/预判）；历史书拼历史质感段
 environmentText: envPsyDisciplines(sceneType, scene.idx, isHistoricalEraBook(book)).environmentText,
 psychologyText: envPsyDisciplines(sceneType, scene.idx, isHistoricalEraBook(book)).psychologyText,
  });

  // V0.21 草稿续写：场景此前生成中断（status=draft 且有部分正文）→ 从断点续写，不丢字
  const draft = (scene.status === 'draft' && scene.content) ? scene.content : '';
  const instructionWithFeedback = appendPublicationFeedback(
    instruction, bookId, { targetChapterIdx: chapter.idx },
  );
  const instructionFinal = draft
    ? `${instructionWithFeedback}\n\n【草稿续写】该场景此前生成中断，已有草稿如下。请从断点自然续写完成整个场景：不要重写开头、不要重复已写内容，完成节拍「${scene.beat}」后自然收尾。\n\n${draft.slice(-600)}`
    : instructionWithFeedback;

  const messages = assembleCreativeMessages(bookId, [{ role: 'user', content: instructionFinal }], {
    chapterId, sceneId,
  });
  store.scenes.update(sceneId, { status: 'writing' });
  onProgress?.({ stage: 'write', sceneIdx: scene.idx, message: `写作场景 ${scene.idx}/${scenes.length}…` });

  let res;
  try {
    res = await runTask({
      task: 'write', bookId, chapterId, messages,
      streamCb: { onDelta, onUsage: u => opts.onUsage?.(u), onUsageCost: c => opts.onUsageCost?.(c) },
      onRetry,
      resilience, // V0.21：可覆盖韧性参数（测试/高级调优）
      signal,
    });
  } catch (e) {
    // V0.21 草稿保护：流中断的部分正文落草稿（重跑自动续写）；无部分内容则标记失败
    if (e.code === 'ABORTED') {
      // 用户主动暂停不是生成失败；立即恢复成可续跑状态，避免永久遗留 writing。
      store.scenes.update(sceneId, { status: String(scene.content || '').trim() ? 'draft' : 'planned' });
    } else {
      const partial = e.partialContent;
      if (partial && partial.trim().length > 20) {
        store.scenes.update(sceneId, { content: partial.trim(), status: 'draft' });
        store.conflicts.create(bookId, {
          chapterId, type: '生成中断', quote: '', issue: `场景${scene.idx}生成中断，已保存草稿 ${partial.trim().length} 字（重跑自动续写）：${e.message}`, severity: 'high',
        });
      } else {
        store.scenes.update(sceneId, { status: 'failed' });
        store.conflicts.create(bookId, {
          chapterId, type: '生成失败', quote: '', issue: `场景${scene.idx}生成失败（${e.code || 'UNKNOWN'}）：${e.message}`, severity: 'high',
        });
        // V0.72 缓存优化：失败回退**不再 truncate**——失败场景没有新正文写入历史堆，
        // 旧历史内容仍有效且缓存匹配；只清 historySeq 防悬空引用（补写成功时旧消息仍在 → replace 原位覆盖，前缀最小化断裂）
        // V0.73 修正：只清失败场景自身的 historySeq——后续已完成场景的正文仍有效且引用有效，
        // 不动它们的引用（此前清空会导致后续修订走 append 而非 replace → 历史堆出现孤儿重复正文）
        if (scene.history_seq) {
          try { store.scenes.update(sceneId, { historySeq: null }); } catch { /* ignore */ }
        }
      }
    }
    throw e;
  }

  let content = mergeDraftContinuation(draft, res.content);
  if (!content) throw new Error('场景生成结果为空，请重试');
  // V0.20：累计各轮（续写/压缩）usage/cost，前端展示与成本日志不再只含首轮
  let totalUsage = res.usage;
  let totalCost = res.cost;

  // V0.73：长度自愈提取为共享函数（writeScene 与 reviseScene 共用）
  let healed = false;
  const heal = await autoHealSceneLength({ bookId, chapterId, scene, content, autoHeal, maxWordsOverride: wordBudget.maxWords, onProgress, onDelta, onUsage: u => opts.onUsage?.(u), onUsageCost: c => opts.onUsageCost?.(c), signal });
  content = heal.content;
  healed = heal.healed;
  totalUsage = heal.totalUsage || totalUsage;
  totalCost = heal.totalCost || totalCost;

  // V0.94.0：破折号预算硬闸——确定性压缩超预算破折号（模型未遵守指令红线时的兜底，零 LLM 成本）
  content = enforceSceneDashBudget(content, dashBudget);
  const morph = healCraftMorphology(content);
  if (morph.healed) {
    content = morph.content;
    healed = true;
  }

  // V0.95.7 跨年开篇写侧硬闸：与审校同一把尺子（crossYearOpeningIssue 单一真源）。
  // 缺失时定向重写场景开头 1 次（隔离上下文，task=revise 低耗形态）；重写仍不过不硬拦——
  // 审校按 proseFix 路由修订兜底（不再 replan 整章重写，ch27 实证 3 轮耗尽卡死的根因）。
  if (crossedYear && autoHeal && crossYearOpeningIssue(outlineYear, prevYear, content)) {
    onProgress?.({ stage: 'write', message: '跨年开篇标记缺失，定向重写场景开头…' });
    try {
      const rwMsg = assembleReviewMessages(bookId, [{
        role: 'user',
        content: `本章从公元${prevYear}年跨入${outlineYear}年，但下面的场景正文开头缺少明确跨年标记（次年/年号/季节），已被本地校验驳回。请重写本场景：开头第一段必须以跨年过渡起笔（如"次年开春，${outline.era_year || '新年号'}的雪化得早"），并用一两句交代时间流逝与人物近况；其余节拍、人物动作与结尾保持原样，不得删减剧情。只输出重写后的完整正文，不要标题、解释或分析。\n\n当前正文：\n${content}`,
      }]);
      const rw = await runTask({
        task: 'revise', bookId, chapterId, messages: rwMsg,
        routeOverride: { thinking: 'disabled', reasoningEffort: 'low', temperature: 0.3, maxTokens: 8000 },
        streamCb: { onDelta, onUsage: u => opts.onUsage?.(u), onUsageCost: c => opts.onUsageCost?.(c) },
        signal,
      });
      const rwText = String(rw.content || '').trim();
      if (rwText && !crossYearOpeningIssue(outlineYear, prevYear, rwText)) {
        content = rwText;
        healed = true;
      }
      totalUsage = mergeUsage(totalUsage, rw.usage);
      totalCost = mergeCost(totalCost, rw.cost);
    } catch { /* 定向重写失败不阻断：审侧 proseFix 修订兜底 */ }
  }

  // V0.105.7 时代器物写侧硬闸：eraRedLineCheck 词表（辣椒/玉米/烟草/现代词…）此前只被
 // 吸引力门软消费，写侧/审侧都不拦——实测 ch52「辣椒油」实证穿帮落库。与跨年闸同款：
  // 命中→定向替换重写 1 次（词表自带 fix）→复检仍命中不硬拦，审侧 proseFix 兜底。
  if (book.genre === '历史' && autoHeal) {
    const healed2 = await healEraAnachronism(bookId, chapterId, content, {
      onProgress, signal,
      onUsage: u => opts.onUsage?.(u), onUsageCost: c => opts.onUsageCost?.(c), onDelta,
    });
    if (healed2.healed) { content = healed2.content; healed = true; }
    totalUsage = mergeUsage(totalUsage, healed2.usage);
    totalCost = mergeCost(totalCost, healed2.cost);
  }

  // 重写语义（V0.63 缓存优化）：若该场景此前已有正文（history_seq 存在），
  // 用 replace 原地替换同 seq 消息（此前 truncateFrom 删掉该场景之后全部历史 → 前缀断裂，
  // 之后所有请求全 miss 36 万 tokens —— 这是命中率 40% 的最大主源）。
  // 后续场景重置为 planned 但保留 history_seq（重写时各自 replace 自己的 seq，历史堆最终一致且前缀保持命中）。
  if (scene.history_seq) {
    const later = store.scenes.list(chapterId).filter(s => s.idx > scene.idx);
    for (const s of later) {
      store.scenes.update(s.id, { content: '', status: 'planned' }); // V0.63：保留 historySeq 供 replace
    }
  }

  // 正文落库 + 进历史堆（记录 seq 以便修订；重写=replace 同 seq，新写=append）
  // V0.70：replace 返回 0 行（悬空 seq）时回退 append 并同步 scene.historySeq，防正文静默丢失
  // V0.73 修复：剥离【新设定:xxx】标记（模型按指令写在正文末尾，若不清理会泄漏进成品文本）
  content = stripNewSettingMarkers(bookId, content, chapter.idx);
  let seq;
  if (scene.history_seq && store.history.replace(bookId, scene.history_seq, 'assistant', content) > 0) {
    seq = scene.history_seq;
  } else {
    seq = appendHistory(bookId, 'assistant', content);
  }
  store.scenes.update(sceneId, { content, status: 'done', historySeq: seq });
  const fullText = store.chapters.fullText(chapterId);
  // V0.70 修复：done/settled 章补写场景时不降级为 drafted（此前每次写场景都置 drafted →
  // pilot 主循环见 drafted 不跳过 → 整章重跑 → 重复结算/事实/时间线堆积）
  // V0.93.1：完成态判定收敛到 chapter_status.isCompletedChapter（兼容遗留 revised 完整章）
  if (isCompletedChapter(chapter)) {
    store.chapters.update(chapterId, { wordCount: estimateChineseChars(fullText) });
  } else {
    store.transaction(() => {
      store.chapters.update(chapterId, { wordCount: estimateChineseChars(fullText) });
      transitionChapterStatus(bookId, chapterId, 'drafted', { reason: '场景正文写入' });
    });
  }
  const publishedBoundary = store.publicationProfiles.get(bookId)?.published_chapter_count || 0;
  if (chapter.idx <= publishedBoundary) store.publicationProfiles.markPendingSync(bookId, [chapter.idx]);

  return { content, scene, usage: totalUsage, cost: totalCost, healed };
}

/**
 * 将断点续写响应接回完整草稿。模型只收到草稿末尾，响应本身绝不能替换已保存的前缀；
 * 同时消除模型为衔接语义而复述的短边界，避免出现“天色渐暗天色渐暗”。
 */
export function mergeDraftContinuation(draft, continuation) {
  const before = String(draft || '').trimEnd();
  const after = String(continuation || '').trim();
  if (!before) return after;
  if (!after) return before;

  const maxOverlap = Math.min(800, before.length, after.length);
  let overlap = 0;
  for (let size = maxOverlap; size >= 4; size--) {
    if (before.endsWith(after.slice(0, size))) {
      overlap = size;
      break;
    }
  }
  const tail = after.slice(overlap);
  if (!tail) return before;
  return overlap ? before + tail : `${before}\n${tail}`;
}

/**
 * V0.94.0 长度自愈续写安全合并（双版本残留根因修复）。
 * 精读实证：ch24 场景4 前半完成完整闭环（看信→回帐→写"朝局"→望烟），后半整段重演一遍且
 * 细节自相矛盾（"灯芯拨高了半寸" vs "帐里没有点灯"）——autoHealSceneLength 此前的
 * `content + '\n' + cont` 盲拼接，模型不遵守"只续写"而重写时，两个互斥版本同时入库。
 * 本函数用 4-gram 包含度判定续写响应的形态：
 *  - existing ⊆ continuation（包含度 ≥0.66）→ continuation 是完整重写且覆盖原文 → **替换**；
 *  - continuation 大部分复述 existing（任一向包含度 ≥0.28）→ 模型在重述 → 取更长者**替换**，
 *    短者丢弃（绝不能拼接）；
 *  - 其余 → 正常续写，走 overlap 消解后拼接。
 * @returns {{content:string, mode:'append'|'replace'|'discard'|'empty'}}
 */
export function safelyMergeContinuation(existing, continuation) {
  const before = String(existing || '').trim();
  const after = String(continuation || '').trim();
  if (!before) return { content: after, mode: after ? 'replace' : 'empty' };
  if (!after) return { content: before, mode: 'empty' };

  const normalized = text => text.replace(/[\s，。！？；：、“”‘’（）《》—…·]/g, '');
  const grams = text => {
    const value = normalized(text);
    const set = new Set();
    for (let i = 0; i <= value.length - 4; i++) set.add(value.slice(i, i + 4));
    return set;
  };
  const gBefore = grams(before);
  const gAfter = grams(after);
  if (!gBefore.size || !gAfter.size) return { content: `${before}\n${after}`, mode: 'append' };

  let shared = 0;
  for (const g of gBefore) if (gAfter.has(g)) shared++;
  // existing 在 continuation 中的覆盖度（continuation 是否完整包含/重写了原文）
  const beforeInAfter = shared / gBefore.size;
  // continuation 有多少是在复述 existing
  const afterInBefore = shared / gAfter.size;

  if (beforeInAfter >= 0.66) return { content: after, mode: 'replace' };
  if (afterInBefore >= 0.28 || beforeInAfter >= 0.28) {
    // 模型在重述而非续写：两个互斥版本绝不能拼接，取更完整的那个
    return normalized(after).length >= normalized(before).length
      ? { content: after, mode: 'replace' }
      : { content: before, mode: 'discard' };
  }
  // 正常续写：消解衔接处复述的短边界
  const maxOverlap = Math.min(800, before.length, after.length);
  let overlap = 0;
  for (let size = maxOverlap; size >= 4; size--) {
    if (before.endsWith(after.slice(0, size))) { overlap = size; break; }
  }
  const tail = after.slice(overlap);
  if (!tail) return { content: before, mode: 'discard' };
  return { content: overlap ? before + tail : `${before}\n${tail}`, mode: 'append' };
}

/**
 * V0.94.0 破折号预算硬闸（确定性，零 LLM 成本）。
 * 精读实证：ch17-22 破折号实测 23-32 个（红线 ≤20/章），写作指令红线只约束了"章"而
 * 场景生成时模型没有章级视野。按场景字数占比分配章预算（20/章），超预算的多余破折号
 * 从后往前替换为逗号（破折号的停顿语义在中文里逗号可承接，替换安全）。
 * @param {string} content 场景正文
 * @param {number} budget 本场景破折号预算（章预算 × 场景字数占比，≥3）
 * @returns {string} 压缩后的正文（未超预算时原样返回）
 */
export function enforceSceneDashBudget(content, budget) {
  const src = String(content || '');
  const positions = [];
  let idx = 0;
  while ((idx = src.indexOf('——', idx)) >= 0) { positions.push(idx); idx += 2; }
  const limit = Math.max(3, Math.floor(Number(budget) || 0));
  if (positions.length <= limit) return src;
  // 超出预算的破折号（靠后的）替换为逗号；保留靠前的——通常承担真正的语义突转
  const cut = new Set(positions.slice(limit));
  let out = '';
  let cursor = 0;
  for (const pos of positions) {
    if (!cut.has(pos)) continue;
    out += src.slice(cursor, pos) + '，';
    cursor = pos + 2;
  }
  out += src.slice(cursor);
  return out;
}

/**
 * V0.105.2 章级字数预算——场景生成没有章级视野（与破折号预算同根因）：
 * 细纲 Σtarget 可超章目标（ch48 实测 5500/5000，指令此前只有 90% 下限）、
 * 各场景又普遍超 target 20-40%（压缩阈值 1.7× 前不设防），两层叠加实测
 * 4/8 章破 135% 红线（ch43=7618/ch44=7845/ch48=7412，红线 6750）。
 * 本函数按「章红线 135% − 已写 − 未写场景最低需求（target×85%）」给本场动态上限：
 * 余量充足时不收紧（保持既有 1.7× 行为）；超支趋势时收紧到 target×1.05 以上
 * （不为守预算砍剧情节拍——章级超标的主治在指令视野，硬闸只是兜底）。
 * @returns {{maxWords:number, minWords:number, ceiling:number, written:number, trendingOver:boolean, text:string}}
 */
export function sceneWordBudget({ lengthProfile = 3000, scenesBefore = [], scene = {}, scenesAfter = [] } = {}) {
  const target = Number(scene.target_words) || 1000;
  const minWords = Math.max(700, Math.round(target * 0.85));
  const profile = Math.max(1500, Number(lengthProfile) || 3000);
  const ceiling = Math.round(profile * 1.35);
  const written = (scenesBefore || []).reduce((acc, s) => acc + estimateChineseChars(s?.content || ''), 0);
  const afterNeed = (scenesAfter || []).reduce(
    (acc, s) => acc + Math.max(700, Math.round((Number(s?.target_words) || 1000) * 0.85)), 0);
  const remaining = ceiling - written - afterNeed; // 本场写完后章仍不破线的可用余量
  const staticMax = Math.round(target * 1.7);
  const dynamicMax = Math.max(Math.round(target * 1.05), remaining);
  const maxWords = Math.max(minWords + 50, Math.min(staticMax, dynamicMax));
  const trendingOver = remaining < staticMax * 0.9; // 余量已明显吃紧（非首场景的正常波动）
  let text = '';
  if (written > 0) {
    text = `【章字数预算】本章目标 ${profile} 字（硬上限 ${ceiling}，超限将被压缩）；前面场景已写 ${written} 字，本场目标 ${target} 字。`;
    if (trendingOver) {
      text += `章累计已吃紧——本场务必收在 ${maxWords} 字内，删冗余描写不删节拍。`;
    }
  }
  return { maxWords, minWords, ceiling, written, trendingOver, text };
}

/**
 * V0.73：长度自愈（NovelClaw 式硬约束）——writeScene 与 reviseScene 共用。
 * 不足续写（≤2 轮，append 不破坏缓存前缀），超限压缩重写（1 轮）。
 * @param {object} p { bookId, chapterId, scene, content, autoHeal=true, onProgress, onDelta, onUsage, onUsageCost, signal }
 * @returns {{content:string, healed:boolean, totalUsage?:object, totalCost?:object}}
 */
export function chooseCompressedScene(original, candidates, minWords, maxWords) {
  const usable = (candidates || [])
    .map(content => ({ content: String(content || '').trim(), words: estimateChineseChars(content) }))
    .filter(item => item.content && item.words >= minWords);
  const bounded = usable.filter(item => item.words <= maxWords).sort((a, b) => a.words - b.words);
  if (bounded.length) return bounded[0].content;

  // 模型若越压越长，宁可保留原稿，也不能让“自愈”反向放大正文。
  const fallback = [{ content: original, words: estimateChineseChars(original) }, ...usable]
    .sort((a, b) => a.words - b.words)[0];
  return fallback.content;
}

/**
 * V0.105.7 时代器物定向重写：eraRedLineCheck 命中→词表 fix 告知模型逐处替换→复检。
 * 写侧（writeScene）与审侧（audit localIssues proseFix 修订）同源词表；重写失败不阻断。
 * @returns {{content:string, healed:boolean, usage?:object, cost?:object}}
 */
export async function healEraAnachronism(bookId, chapterId, content, { onProgress, signal, onUsage, onUsageCost, onDelta } = {}) {
  const hits = eraRedLineCheck(content);
  if (!hits.length) return { content, healed: false };
  onProgress?.({ stage: 'write', message: `时代器物穿帮（${hits.map(r => r.term).join('、')}），定向重写…` });
  try {
    const hitList = hits.map(r => `「${r.term}」${r.issue}（${r.fix}）`).join('；');
    const rwMsg = assembleReviewMessages(bookId, [{
      role: 'user',
      content: `下面的场景正文出现了时代器物/用语穿帮，已被本地校验驳回：${hitList}。请逐处替换这些词所在的表述为符合南宋时代的等价物，其余内容逐字保持不变，不得增删剧情或改写其他句子。只输出替换后的完整正文，不要标题、解释或分析。\n\n当前正文：\n${content}`,
    }]);
    const rw = await runTask({
      task: 'revise', bookId, chapterId, messages: rwMsg,
      routeOverride: { thinking: 'disabled', reasoningEffort: 'low', temperature: 0.3, maxTokens: 8000 },
      streamCb: { onDelta, onUsage, onUsageCost },
      signal,
    });
    const rwText = String(rw.content || '').trim();
    if (rwText && !eraRedLineCheck(rwText).length && rwText.length > content.length * 0.5) {
      return { content: rwText, healed: true, usage: rw.usage, cost: rw.cost };
    }
    return { content, healed: false, usage: rw.usage, cost: rw.cost };
  } catch {
    return { content, healed: false };
  }
}

export async function autoHealSceneLength(p) {
  const { bookId, chapterId, scene, autoHeal = true, maxWordsOverride = 0, onProgress, onDelta, onUsage, onUsageCost, signal } = p;
  let { content } = p;
  let healed = false;
  let totalUsage = null;
  let totalCost = null;
  // V0.105.5：末句完整性收口（writeScene 与 reviseScene 共用入口）。超长输出被
 // maxTokens 掐断时字数常已达标，下方字数闸全部跳过，半句话直接落库（本作
  // ch45/ch50「…回荡在合州」实证）。先确定性裁到完整句边界，再进长度判定——
  // 裁掉半句后若字数跌破下限会自然触发续写补全，两道闸形成闭环。
  const closed = closeTrailingSentence(content);
  if (closed !== String(content || '').trimEnd() && closed.trim()) {
    onProgress?.({ stage: 'write', message: '末句被输出预算截断，本地裁剪到完整句边界…' });
    content = closed;
    healed = true;
  }
  // V0.100：场景达到目标 85% 才算完成；章级结算前另有硬门兜底。
  // 上限仍保留 1.7：只有超 70% 才压缩，避免为轻微超长整段重写并破坏缓存。
  // V0.105.2：maxWordsOverride（章级预算动态上限）更紧时收紧压缩触发线——章超支
  // 趋势下各场仍按 1.7× 放行是 4/8 章破 135% 红线的直接原因。
  const target = scene.target_words || 1000;
  const minWords = Math.max(700, Math.round(target * 0.85));
  const staticMax = Math.round(target * 1.7);
  const maxWords = maxWordsOverride > 0
    ? Math.max(minWords + 50, Math.min(staticMax, Math.round(maxWordsOverride)))
    : staticMax;
  const words = estimateChineseChars(content);

  if (autoHeal && words < minWords) {
    // 续写（≤2 轮）：承接已写内容，不重写开头
    for (let i = 0; i < 2 && estimateChineseChars(content) < minWords; i++) {
      onProgress?.({ stage: 'write', message: `字数不足（${estimateChineseChars(content)}/${minWords}），续写中…` });
      const contMsg = assembleCreativeMessages(bookId, [{
        role: 'user',
        content: `继续续写当前场景：场景「${scene.id}」要求 ${minWords}-${maxWords} 字，现有 ${estimateChineseChars(content)} 字。\n\n已写内容（结尾部分）：\n${content.slice(-400)}\n\n请只续写后面部分，承接上文，不要重写开头、不要重复已写内容，完成场景节拍「${scene.beat}」后自然收尾。只输出续写正文。`,
      }], { chapterId, sceneId: scene.id });
      const cont = await runTask({
        task: 'write', bookId, chapterId, messages: contMsg,
        streamCb: { onDelta, onUsage, onUsageCost },
        signal,
      });
      // V0.94.0：续写安全合并——模型违反"只续写"而重写时，盲拼接会产生双版本残留
      // （精读实证 ch24 场景4 前后半互斥重演）。替换/丢弃决策见 safelyMergeContinuation。
      const merged = safelyMergeContinuation(content, cont.content);
      if (merged.mode !== 'discard' && merged.mode !== 'empty') healed = true;
      content = merged.content;
      if (estimateChineseChars(content) < minWords && (merged.mode === 'discard' || merged.mode === 'empty')) break;
      // V0.73：多轮续写累加 usage/cost（此前每轮覆盖，首轮与原文 usage 丢失、成本统计偏低）
      totalUsage = mergeUsage(totalUsage, cont.usage);
      totalCost = mergeCost(totalCost, cont.cost);
    }
  } else if (autoHeal && words > maxWords) {
    // 压缩重写（保留剧情删冗余）。使用隔离上下文，避免历史中的相邻场景被拼进结果；
    // 首次不收敛时再做一次更严格压缩，最终绝不接受比原稿更长的失控输出。
    onProgress?.({ stage: 'write', message: `字数超限（${words}/${maxWords}），压缩重写中…` });
    const original = content;
    const candidates = [];
    let source = content;
    for (let attempt = 0; attempt < 2; attempt++) {
      const preferredMax = Math.max(minWords, Math.round(maxWords * (attempt ? 0.8 : 0.9)));
      const compMsg = assembleReviewMessages(bookId, [{
        role: 'user',
        content: `请压缩重写当前场景，正文必须在 ${minWords}-${preferredMax} 字之间，绝对不得超过 ${maxWords} 字（当前 ${estimateChineseChars(source)} 字）。只删冗余描写与重复表达，保留原有剧情节拍和结尾，不得补写后续场景。\n\n原文：\n${source}\n\n只输出压缩后的正文；不要标题、解释或分析。`,
      }]);
      const comp = await runTask({
        task: 'revise', bookId, chapterId, messages: compMsg,
        routeOverride: {
          thinking: 'disabled', reasoningEffort: 'low', temperature: 0.3,
          // V0.95.3：effort low + 下限 6000——正文型任务同端点实证 medium 全烧推理零正文
          maxTokens: Math.max(6000, Math.min(12000, Math.ceil(maxWords * 1.8))),
        },
        streamCb: { onDelta, onUsage, onUsageCost },
        signal,
      });
      const compText = comp.content.trim();
      if (compText) candidates.push(compText);
      totalUsage = mergeUsage(totalUsage, comp.usage);
      totalCost = mergeCost(totalCost, comp.cost);
      const compWords = estimateChineseChars(compText);
      if (compWords >= minWords && compWords <= maxWords) break;
      if (compWords >= minWords && compWords < estimateChineseChars(source)) source = compText;
    }
    content = chooseCompressedScene(original, candidates, minWords, maxWords);
    healed = true;
  }

  return { content, healed, totalUsage, totalCost };
}

/** 累加 usage（多轮续写/压缩合并；V0.73） */
function mergeUsage(a, b) {
  if (!b) return a || null;
  if (!a) return b;
  const out = { ...a };
  for (const k of ['promptTokens', 'completionTokens', 'promptCacheHitTokens', 'promptCacheMissTokens', 'reasoningTokens']) {
    if (typeof b[k] === 'number') out[k] = (out[k] || 0) + b[k];
  }
  return out;
}

/** 累加 cost（多轮合并；V0.73） */
function mergeCost(a, b) {
  if (!b) return a || null;
  if (!a) return b;
  const out = { ...a };
  for (const k of ['cost', 'costIfMiss', 'saving']) {
    if (typeof b[k] === 'number') out[k] = (out[k] || 0) + b[k];
  }
  return out;
}

/**
 * V0.73 P0 修复：剥离模型按指令写在正文末尾的【新设定:xxx】标记并登记为待确认实体。
 * 此前全链路无清理逻辑，标记会随场景正文进历史堆、进 fullText、进最终成品。
 * 支持两种格式：`【新设定:名词——简述】` 与 `【新设定:名词】`；允许出现在行内或独立一行。
 * @returns {string} 剥离标记后的纯正文
 */
export function stripNewSettingMarkers(bookId, content, chapterIdx = 0) {
  if (!content || typeof content !== 'string') return content;
  const lines = content.split('\n');
  const kept = [];
  for (const line of lines) {
    let remaining = line;
    let match;
    const re = /【新设定[:：]\s*([^】]+)】/g;
    while ((match = re.exec(remaining)) !== null) {
      const raw = (match[1] || '').trim();
      const [name, ...descParts] = raw.split(/[——–]/);
      const name2 = (name || '').trim();
      const desc = descParts.join('—').replace(/^[—–-]+/, '').trim();
      if (name2) {
        try {
          store.pendingEntities.add(bookId, {
            name: name2.slice(0, 40),
            context: (desc || '').slice(0, 200),
            sourceChapter: chapterIdx || undefined,
          });
        } catch { /* 登记失败不阻断写作 */ }
      }
    }
    remaining = remaining.replace(/【新设定[:：][^】]+】/g, '').trim();
    if (remaining) kept.push(remaining);
  }
  // 若整个文本只剩空行（标记占据了全部内容），保留空字符串由上层处理
  return kept.join('\n').trim();
}
