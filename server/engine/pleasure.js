// V0.17 快感引擎（Pleasure Engine）
// 心理学依据：变量奖励(RPE)/好奇心缺口/蔡格尼克/替代性满足/代入感/心流/张力曲线/压抑-释放
// 数据：pleasure_hooks（期待-满足账本）、story_arcs（并行弧线）、chapter_health.notes（情绪标签）
import * as store from '../db/store.js';
import { runTask } from '../llm/router.js';
import { assembleMessages } from '../llm/cache.js';
import { bookPleasurePlanInstruction, pleasureAuditInstruction } from './prompts.js';
import { genrePackText } from '../data/creative_packs.js';
import { extractJSON } from '../util/json.js';
import { detectEmotionPattern } from './plot_ai.js'; // V0.80 情绪模式化检测
import { resolveBookStage } from './longform_lifecycle.js'; // V0.92：中后期起由开线改为汇流/清账
import { resolveCraftProfile } from './craft_profile.js';
import { hookDescriptionsMatch } from '../util/text.js'; // V0.93.2：期待描述匹配单一实现
import { REDLINES } from '../data/redlines.js'; // V0.95：节奏阈值单一真源（中爽间隔/平路上限/钩强度）
import { hooksDueToAge } from './horizon.js'; // V0.102：短中长钩超期老化单一实现

export { hookDescriptionsMatch }; // 兼容导出：v121 等测试与外部调用不变

const KIND_LABEL = { short: '短期待', medium: '中期待', long: '长期待', super: '超级期待' };

function arcEntityName(arcName) {
  const source = String(arcName || '').replace(/(?:主线|暗线|支线|关系线|兄弟线|师徒线|成长线|人物线)$/g, '');
  // 通用主题名没有具名人物，不用模糊词误推进；主线在下面单独处理。
  if (/山河守护|天下|时代|生存|成长|战争|朝堂|守城/.test(source)) return '';
  const match = source.match(/[一-鿿]{2,4}/);
  return match?.[0] || '';
}

/** 每章最终正文落定后，推进全书主线和正文真正出现的具名人物弧。 */
export function reconcileStoryArcsForChapter(bookId, chapterIdx, { chapterText = '', summary = '' } = {}) {
  const source = `${chapterText}\n${summary}`;
  const advanced = [];
  for (const arc of store.storyArcs.open(bookId, chapterIdx)) {
    const main = arc.type === '主线' || /主线$/.test(arc.name || '');
    const entity = arcEntityName(arc.name);
    if (!main && (!entity || !source.includes(entity))) continue;
    if (Number(arc.last_active_chapter || 0) >= Number(chapterIdx)) continue;
    const nextStatus = arc.status === 'opening' && Number(chapterIdx) > Number(arc.opened_chapter || 0)
      ? 'active'
      : arc.status;
    store.storyArcs.update(arc.id, { lastActiveChapter: chapterIdx, status: nextStatus });
    advanced.push(arc.name);
  }
  return { advanced };
}

// V0.93.5 台账-正文联动：称谓/身份类名字不做正文匹配（到处都是，会误触）
const CHARACTER_TOUCH_STOPWORDS = new Set([
  '母亲', '父亲', '弟弟', '哥哥', '妹妹', '兄长', '爹', '娘', '老人', '老翁', '老妇', '妇人',
  '汉子', '军士', '民夫', '工匠', '郎中', '马夫', '亲兵', '老卒', '候补兵', '副将', '校尉',
  '队长', '伙长', '书生', '少女', '少年', '孩子', '百姓', '流民', '难民', '商人', '衙役', '差役',
  '师傅', '工头', '师父', '兄弟', '姐妹', '夫', '妻', '儿子', '女儿',
]);

/**
 * V0.93.5 已登记角色 last_chapter 本地兜底（零 LLM，纯子串匹配）：
 * 角色名在正文出现即把 last_chapter 推进到本章——此前依赖结算模型 character_updates 自报，
 * 模型常漏报配角（实测：阿蛮 17-20 章连续出场但 last 停在 15，张老实停在 5）。
 * V0.93.7：last_chapter 为 null 的角色（AI 补全建卡路径常不写锚点，实测贾似道 first=17
 * last=null）在正文出现时直接设为本出现章；若全书再无出现，由 settle 联动补平 last=first。
 * @returns {string[]} 本次被推进的角色名
 */
export function touchCharacters(bookId, chapterText, chapterIdx) {
  if (!chapterText || !Number.isInteger(chapterIdx)) return [];
  const touched = [];
  for (const c of store.characters.list(bookId)) {
    const name = String(c.name || '').trim();
    if (name.length < 2 || CHARACTER_TOUCH_STOPWORDS.has(name)) continue;
    if (!chapterText.includes(name)) continue;
    const last = c.last_chapter == null ? null : Number(c.last_chapter);
    if (last === Number(chapterIdx)) continue;
    store.characters.update(c.id, { lastChapter: chapterIdx });
    touched.push(name);
  }
  return touched;
}

/**
 * V0.93.7 台账一致性自愈（纯本地）：last_chapter 为 null 的角色补平为 first_chapter——
 * AI 补全建卡（roster tidy）路径不写锚点，last=null 在角色库显示"未出现"误导。
 * 只增不覆盖：已有 last 的不动。@returns {string[]} 被补平的角色名
 */
export function normalizeCharacterAnchors(bookId) {
  const fixed = [];
  for (const c of store.characters.list(bookId)) {
    if (c.last_chapter != null || c.first_chapter == null) continue;
    store.characters.update(c.id, { lastChapter: Number(c.first_chapter) });
    fixed.push(c.name);
  }
  return fixed;
}

/**
 * V0.93.5 细纲场景地点名清洗（纯函数）：取分隔符前主干，2-14 字。
 * 例："北坡外围村庄废墟——老槐树下、民居院中、村后柴垛" → "北坡外围村庄废墟"
 */
export function extractOutlineLocationName(locationStr = '') {
  const raw = String(locationStr || '').trim();
  if (!raw) return '';
  const main = raw.split(/———|——|—|,|，|、|;|；|。|\s+/)[0].trim();
  if (main.length < 2 || main.length > 14) return '';
  if (/[。！？!?]$/.test(main)) return '';
  return main;
}

/**
 * V0.93.5 细纲场景地点自动登记（零 LLM）：结算时把本章细纲 scenes[].location 中
 * 未登记的地名补登记进 locations 表——此前依赖模型 new_entities 自报，漏报即脱节
 * （实测：ch19 核心地点"北坡外围村庄废墟"未登记）。
 * @returns {string[]} 新登记的地点名
 */
export function registerOutlineLocations(bookId, locationStrings, chapterIdx) {
  if (!Array.isArray(locationStrings) || !Number.isInteger(chapterIdx)) return [];
  const existing = new Set(store.locations.list(bookId).map(l => l.name));
  const registered = [];
  for (const loc of locationStrings) {
    const name = extractOutlineLocationName(loc);
    if (!name || existing.has(name)) continue;
    store.locations.create(bookId, {
      name,
      firstChapter: chapterIdx,
      lastChapter: chapterIdx,
      card: { note: '细纲场景地点自动登记', sourceChapter: chapterIdx },
    });
    existing.add(name);
    registered.push(name);
  }
  return registered;
}

function chaptersPerVolumeEstimate(bookId) {
  const populated = store.volumes.list(bookId)
    .map(volume => store.chapters.listByVolume(volume.id).length)
    .filter(Boolean);
  return populated.length ? Math.max(1, Math.round(populated.reduce((sum, count) => sum + count, 0) / populated.length)) : 8;
}

function emotionLineOpened(line, chapterIdx, chaptersPerVolume) {
  const phase = String(line?.phase_plan || '');
  const match = phase.match(/出场[（(]?第\s*(\d+)\s*卷/);
  if (!match) return true;
  return chapterIdx >= (Number(match[1]) - 1) * chaptersPerVolume + 1;
}

function lifecycleStageAtChapter(bookId, chapterIdx) {
  const chapter = store.chapters.list(bookId).find(item => Number(item.idx) === Number(chapterIdx));
  const volume = chapter?.volume_id ? store.volumes.get(chapter.volume_id) : null;
  return resolveBookStage(bookId, volume ? { volumeIdx: volume.idx } : {});
}

/** 快感上下文（注入细纲/正文指令；动态内容 → 尾部）
 *  V0.73 缓存+质量修复：钩子按相关性限流——只注入"最需要关注"的钩子，
 *  超期钩子摘要化（列条数+取最紧急若干条），禁止把 300+ 条累积钩子全量塞进指令
 *  （否则 write 尾部数十万 tokens 全 miss，模型也被海量旧期待淹没、抓不住重点）。 */
export function buildPleasureContext(bookId, chapterIdx, { compact = false, maxChars = compact ? 1800 : 20_000 } = {}) {
  const book = store.books.get(bookId);
  let plan = null;
  try { plan = book?.settings_json ? (JSON.parse(book.settings_json).pleasurePlan || null) : null; } catch { /* ignore */ }
  const allHooks = store.pleasureHooks.active(bookId);
  const expired = store.pleasureHooks.expired(bookId, chapterIdx);
  const arcs = store.storyArcs.open(bookId, chapterIdx);
  const staleArcs = store.storyArcs.stale(bookId, chapterIdx);
  const recentEmotions = recentEmotionLabels(bookId);
  const lifecycleStage = lifecycleStageAtChapter(bookId, chapterIdx);
  const parts = [];
  // V0.82：历史题材（史实流·无金手指）——"金手指"文案按"立身之本"语义注入
  const isHistory = book?.genre === '历史';
  if (lifecycleStage.id === 'late_middle') {
    parts.push('【中后期弧线纪律】现有战线必须汇流到最终问题；禁止新增重大主线，开放债务应逐卷净减少。');
  } else if (lifecycleStage.id === 'ending') {
    parts.push('【后期收尾纪律】只写既有因果的终局推进与清账；禁止新增长线期待或重大主线。');
  } else if (lifecycleStage.id === 'finale') {
    parts.push('【终卷纪律】只兑现既有期待并完成余波；不登记新期待，最后一章不设下一章悬念。');
  }

  // V0.73：钩子限流——未到期钩子优先（按到期紧迫度升序），其次超期钩子（按超期时长降序），
  // 最多注入 MAX_HOOKS 条。避免"超期钩子全挤掉近期期待"——近期期待是当前最该兑现的，
  // 超期钩子单独摘要（条数 + 最紧急 5 条）。
  const MAX_HOOKS = compact ? 4 : 12;
  const scored = allHooks
    .map(h => {
      const due = h.due_chapter || 0;
      const remaining = due ? due - chapterIdx : 9999;
      // 排序键：未到期（remaining>0）→ 按 remaining 升序；到期/超期 → 放后面按超期时长降序
      const isOverdue = due > 0 && remaining <= 0;
      const sortKey = isOverdue ? 100000 + (0 - remaining) : remaining;
      return { h, sortKey };
    })
    .sort((a, b) => a.sortKey - b.sortKey);
  const topHooks = scored.slice(0, MAX_HOOKS).map(x => x.h);
  const overdueList = expired.map(h => h.desc);

  if (plan) {
    const rr = plan.reward_rhythm || {}; const sr = plan.suppress_release || {};
    if (compact) {
      const palette = (plan.reward_palette || (isHistory
        ? ['依恋', '生存', '能力', '关系', '信息', '尊严', '战术', '战略', '余韵']
        : ['关系', '信息', '能力', '利益', '情绪'])).slice(0, 8);
      parts.push(`【本书阅读回报】可用类型：${palette.join('、')}。本章只选择与当前因果最贴合的一种推进或兑现；胜利写代价，失败换增量，不按固定模板轮流打卡。`);
    } else {
      parts.push(isHistory
        ? `【阅读回报计划】调色盘：${(plan.reward_palette || ['依恋', '生存', '能力', '关系', '信息', '尊严', '战术', '战略', '余韵']).join('、')}；逐章轮换：${rr.small || '每章一种具体回报'}；阶段兑现：${rr.medium || '每3-5章'}；阶段结算：${rr.large || '每8-12章'}；情绪轮换：${(plan.emotion_rotation || []).join(' → ') || '温暖→不安→紧张→燃→余韵'}；胜利写代价，失败换增量`
        : `【快感计划】小爽：${rr.small || '每1-3章'}；中爽：${rr.medium || '每5-10章'}；大爽：${rr.large || '每15-30章'}；情绪轮换：${(plan.emotion_rotation || []).join(' → ') || '紧张→小燃→放松→甜→虐→大燃→余韵'}；压抑:释放=${sr.ratio || '2:1~3:1'}，权威象征：${(sr.authority_symbols || []).join('、') || '无'}（主角经历服从→质疑→超越）`);
    }
    // V0.80 启用死字段：emotion_lines（情感线节奏）+ protagonist_recipe（含金手指克制）
    if (Array.isArray(plan.emotion_lines) && plan.emotion_lines.length) {
      const activeEmotionLines = plan.emotion_lines.filter(line => emotionLineOpened(line, chapterIdx, chaptersPerVolumeEstimate(bookId)));
      if (activeEmotionLines.length) parts.push(`【情感线规划】${activeEmotionLines.slice(0, compact ? 2 : activeEmotionLines.length).map(l => `${l.name || ''}：${l.phase_plan || ''}`).join('；')}`);
    }
    const recipe = plan.protagonist_recipe;
    if (recipe) {
      const anchors = (recipe.ordinary_anchors || []).join('、');
      const flaws = (recipe.flaws || []).join('、');
      const gf = recipe.golden_finger;
      const gfText = gf ? `${gf.power || ''}${gf.limit ? `（限制/解锁：${gf.limit}）` : ''}` : '';
      const bits = [];
      if (anchors) bits.push(`普通人锚点：${anchors}`);
      if (recipe.potential) bits.push(`非比寻常潜质：${recipe.potential}`);
      if (flaws) bits.push(`初始缺陷：${flaws}`);
      if (gfText) bits.push(isHistory ? `立身之本（史实流·无超常金手指，克制原则）：${gfText}` : `金手指（克制原则，不可开局无敌）：${gfText}`);
      if (bits.length) parts.push(`【主角代入感配方】${bits.join('；')}`);
    }
  }
  if (topHooks.length) {
    parts.push(`【未兑现期待】${topHooks.map(h => `[${KIND_LABEL[h.kind] || h.kind}·${h.type}·强度${h.intensity}] ${h.desc}${h.due_chapter ? `（计划第${h.due_chapter}章兑现）` : ''}`).join('；')}`);
  }
  if (overdueList.length) {
    const shownLimit = compact ? 2 : 5;
    const shown = overdueList.slice(0, shownLimit);
    const tail = overdueList.length > shownLimit ? `（另有 ${overdueList.length - shownLimit} 条，本章不强制全处理）` : '';
    parts.push(`【超期期待·共${overdueList.length}条】${shown.join('；')}${tail}——其中至少一条本章必须优先兑现或明确推进（长线期待需分期确认信号）`);
  }
  if (arcs.length) {
    const openCount = arcs.filter(a => a.status !== 'closed').length;
    const visibleArcs = arcs.slice(0, compact ? 4 : arcs.length);
    parts.push(`【并行弧线(${openCount}条)】${visibleArcs.map(a => `[${a.type}·${a.status === 'closing' ? '临门一脚' : a.status === 'opening' ? '刚开启' : '推进中'}] ${a.name}${a.last_active_chapter ? `（上次活动第${a.last_active_chapter}章）` : ''}`).join('；')}${compact && arcs.length > visibleArcs.length ? `（另有${arcs.length - visibleArcs.length}条未展示）` : ''}`);
  }
  if (staleArcs.length) {
    const action = ['late_middle', 'ending', 'finale'].includes(lifecycleStage.id)
      ? '本章应推进到合流、临门一脚或明确闭合；不得为维持数量再开新线'
      : '本章应安排回填（并行未闭合弧线保持3-5条且错峰收束）';
    parts.push(`【停滞弧线】${staleArcs.slice(0, compact ? 3 : staleArcs.length).map(a => a.name).join('、')}——${action}`);
  }
  if (recentEmotions.length) {
    parts.push(`【近期情绪节奏】${recentEmotions.map(e => `${e.emotion.type}${e.emotion.intensity}`).join(' → ')}${recentEmotions.length >= 3 ? (compact ? '（本章不要复制同档同向走势）' : '（避免连续3章强度≥7或≤3；每3章一次下探，每5章一次峰值）') : ''}`);
  }
  // V0.43：卷内阶段感知（按章节在卷中的位置推导：铺垫/推进/高潮，指导快感节奏弹性）
  try {
    const allChs = store.chapters.list(bookId);
    const cur = allChs.find(c => c.idx === chapterIdx);
    const chs = cur ? store.chapters.listByVolume(cur.volume_id) : [];
    const pos = chs.findIndex(c => c.idx === chapterIdx);
    if (chs.length >= 3 && pos >= 0) {
      const ratio = pos / chs.length;
      let phase;
      if (isHistory && ratio < 0.3) phase = '本卷铺垫期：以依恋/关系/信息回报建立人物与风险，预留钩子，不强迫打斗取胜';
      else if (isHistory && ratio < 0.75) phase = '本卷推进期：能力/信息/关系/战术回报交替，每2-3章一次可感知兑现，胜利写代价';
      else if (isHistory) phase = '本卷收束期：优先兑现卷内旧账与人物选择，以战术/尊严/余韵完成阶段结算并留新局势钩子';
      else if (compact && ratio < 0.3) phase = '本卷铺垫期：建立具体期待和风险，不提前透支卷中结果';
      else if (compact && ratio < 0.75) phase = '本卷推进期：让冲突、关系或信息形成阶段变化，并为卷末保留升级空间';
      else if (compact) phase = '本卷收束期：优先兑现卷内旧账，让人物选择和后果完成阶段结算';
      else if (ratio < 0.3) phase = '本卷铺垫期：重悬念埋设与期待积累，爽点以小为主（强度≤6），预留钩子给中段引爆';
      else if (ratio < 0.75) phase = '本卷推进期：小中爽交替兑现（强度5-8），每 2-3 章一次阶段结算，为卷末高潮蓄力';
      else phase = '本卷收束期：优先兑现卷内旧账/伏笔，大爽点（强度≥8）+ 卷级转折/钩子，节奏加快不拖泥带水';
      parts.push(`【卷内阶段】第${pos + 1}/${chs.length} 章，${phase}`);
    }
  } catch { /* ignore */ }
  if (!compact) return parts.join('\n');
  const selected = [];
  let used = 0;
  for (const part of parts) {
    const value = String(part || '').trim();
    if (!value) continue;
    if (used + value.length > maxChars) continue;
    selected.push(value);
    used += value.length + 1;
  }
  return selected.join('\n');
}

/** 细纲输出后：登记 new_hooks / ending_hook 进期待账本 */
export function registerHooksFromOutline(bookId, outline, chapterIdx) {
  const registered = [];
  const stage = lifecycleStageAtChapter(bookId, chapterIdx);
  // 终卷已进入兑现模式，任何新钩子都会制造一个没有后续章节可还的新债。
  if (stage.id === 'finale') return registered;
  const exists = desc => store.pleasureHooks.active(bookId).some(h => hookDescriptionsMatch(h.desc, desc));
  const dueFromText = desc => {
    const m = String(desc || '').match(/第\s*(\d+)\s*章\s*兑现/);
    return m ? Number(m[1]) : null;
  };
  const sameIdea = (a, b) => {
    if (!a || !b) return false;
    if (hookDescriptionsMatch(a, b)) return true;
    // V0.93.5 同章同意象宽松判定：共享 ≥4 个 2-gram 即视为同一事件钩子（防 ending_hook 与
    // new_hooks 对同一意象各注册一条——实测 ch20 两条"灰烟"钩子并存）。
    // 附加"开头命中"约束：至少一个共享 2-gram 必须落在较短描述的起始 1/3——
    // 同意象复述必然保留主语意象（开头，如"灰烟…偏东二里"）；仅共享尾部共同事件
    // 引用（如两条钩子同引"北帐点卯"）属巧合，不得误并。
    // 比较前剥离"（第N章兑现）"等括号模板，防通用注释污染共享计数。
    const clean = s => String(s).replace(/（[^）]*）|\([^)]*\)/g, '');
    const grams = s => {
      const zh = clean(s).replace(/[^一-鿿]/g, '');
      const set = new Set();
      for (let i = 0; i + 2 <= zh.length; i++) set.add(zh.slice(i, i + 2));
      return set;
    };
    const ga = grams(a), gb = grams(b);
    const shorter = ga.size <= gb.size ? [...ga] : [...gb];
    const head = new Set(shorter.slice(0, Math.max(1, Math.ceil(shorter.length / 3))));
    let hit = 0, headHit = false;
    for (const g of ga) {
      if (gb.has(g)) {
        hit++;
        if (head.has(g)) headHit = true;
      }
    }
    return hit >= 4 && headHit;
  };

  // V0.93.5：new_hooks 与 ending_hook 先合并去重（保留先出现的），再统一注册
  const candidates = [];
  for (const raw of outline?.new_hooks || []) {
    const desc = typeof raw === 'string' ? raw : (raw?.desc || raw?.description || '');
    if (!desc) continue;
    candidates.push({
      desc,
      kind: typeof raw === 'object' && raw.kind ? raw.kind : 'medium',
      type: typeof raw === 'object' && raw.type ? raw.type : '悬念钩',
      intensity: typeof raw === 'object' && raw.intensity ? raw.intensity : 3,
    });
  }
  const eh = outline?.ending_hook;
  if (eh) {
    const desc = typeof eh === 'string' ? eh : (eh?.desc || '');
    if (desc) {
      candidates.push({
        desc,
        kind: 'short',
        // V0.93.5：结尾钩子默认"下一章兑现"（+1），与 V0.17 语义一致
        dueOffset: 1,
        type: typeof eh === 'object' && eh.type ? eh.type : '悬念钩',
        intensity: typeof eh === 'object' && eh.intensity ? Math.min(5, Math.max(1, eh.intensity)) : 3,
      });
    }
  }
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c.desc) continue;
    // 同章同意象去重：与已保留的任一候选共享意象则跳过（保留先出现的）
    if (candidates.slice(0, i).some(prev => sameIdea(prev.desc, c.desc))) continue;
    if (exists(c.desc)) continue;
    if (stage.id === 'ending' && c.kind !== 'short') continue;
    if (stage.id === 'late_middle' && (c.kind === 'long' || c.kind === 'super')) continue;
    const due = dueFromText(c.desc)
      ?? (c.dueOffset != null
        ? chapterIdx + c.dueOffset
        : chapterIdx + (c.kind === 'short' ? 2 : c.kind === 'medium' ? 5 : c.kind === 'long' ? 15 : 30));
    store.pleasureHooks.create(bookId, {
      desc: c.desc, kind: c.kind, type: c.type, plantedChapter: chapterIdx, dueChapter: due, intensity: c.intensity,
    });
    registered.push(c.desc);
  }
  return registered;
}

/**
 * V0.93.8 快感审计输入钩子排序（纯函数，可单测）：
 * 还债优先级——超期未兑现（due < 当前章）最优先，其次最近埋设。
 * 此前 slice(0,8) 按 planted 升序=最老 8 条，ch20+ 新埋钩子进不了审计输入，
 * 审计模型不知道欠债 → 兑现全靠自觉（实测 ch21 名册钩正文已兑现但台账 open）。
 * @param {Array} hooks 全部 open 钩子（含 due_chapter 字段）
 * @param {number} chapterIdx 当前章
 * @returns {Array} 排序后待注入的钩子（超期在前 + 最近埋设，限流 limit 条）
 */
export function prioritizeAuditHooks(hooks, chapterIdx, limit = 12) {
  const all = (hooks || []).filter(h => h && h.desc);
  const isOverdue = h => h.due_chapter != null && Number(h.due_chapter) < Number(chapterIdx);
  const overdue = all.filter(isOverdue);
  // 非超期按 planted 显式降序（不依赖输入顺序——最近埋设最需要关注）
  const recent = all.filter(h => !isOverdue(h))
    .sort((a, b) => Number(b.planted_chapter || 0) - Number(a.planted_chapter || 0));
  return [...overdue, ...recent].slice(0, Math.max(1, Number(limit) || 12));
}

/** 快感审计（每章结算后一次调用；输出情绪/钩子/兑现/问题，落库+生成约束） */
export async function auditPleasure(bookId, chapterId, chapterIdx, { onProgress, signal, streamCb } = {}) {
  const book = store.books.get(bookId);
  const chapter = store.chapters.get(chapterId);
  if (!book || !chapter) return { ok: false, error: '章节不存在' };
  const scenes = store.scenes.list(chapterId);
  const chapterText = scenes.map(s => s.content).join('\n\n');
  // V0.93.8：超期欠债优先注入（此前 slice(0,8) 按 planted 升序，新钩子被最老钩子挤出审计输入）
  const activeHooks = prioritizeAuditHooks(store.pleasureHooks.active(bookId), chapterIdx, 12)
    .map(h => `[${KIND_LABEL[h.kind]}·${h.type}·强度${h.intensity}${h.due_chapter && Number(h.due_chapter) < chapterIdx ? '·超期' : ''}] ${h.desc}（埋设第${h.planted_chapter}章${h.due_chapter ? `，计划第${h.due_chapter}章兑现` : ''}）`).join('；');
  const openArcs = store.storyArcs.open(bookId, chapterIdx).map(a => `${a.name}(${a.type},${a.status})`).join('、');
  const recentEmotions = recentEmotionLabels(bookId).slice(-5).map(e => `${e.emotion.type}${e.emotion.intensity}`).join('、');
  let protagonist = '';
  try {
    // V0.20 修复：characters 无 is_protagonist 列——从公共材料主角标记/首个角色兜底
    const chars = store.characters.list(bookId);
    const marked = chars.find(c => { try { return JSON.parse(c.card_json || '{}').isProtagonist === true; } catch { return false; } });
    const first = marked || chars[0];
    if (first) protagonist = first.name + '：' + (first.card_json || '');
  } catch { /* 兼容旧库 */ }

  onProgress?.({ stage: '快感审计' });
  // V0.29：走 assembleMessages，复用历史堆前缀（每章一次，缓存命中收益最大）
  // V0.96.5：usage 透传（快感审计 tokens 此前漏出"本次运行"统计）
  const res = await runTask({ bookId, chapterId, task: 'pleasure_audit', jsonMode: true, signal, streamCb: { onUsage: streamCb?.onUsage, onUsageCost: streamCb?.onUsageCost }, messages: assembleMessages(bookId, [
    { role: 'user', content: pleasureAuditInstruction({ bookTitle: book.title, chapterTitle: chapter.title || `第${chapterIdx}章`, chapterIdx, chapterText, activeHooks, openArcs, recentEmotions, protagonist, isHistory: book.genre === '历史', plannedRewardMode: store.chapters.outline(chapterId)?.reward_mode || '' }) },
  ]) });
  const audit = extractJSON(res.content);
  if (!audit) return { ok: false, error: '快感审计解析失败' };

  // 情绪标签 → chapter_health.notes
  const health = store.chapterHealth.getByChapter(chapterId);
  const notes = { ...(health?.notes ? JSON.parse(health.notes) : {}) };
  notes.emotion = audit.emotion || { type: '平淡', intensity: 5 };
  notes.hook = audit.hook || null;
  notes.agency = audit.agency_ratio || null;
  // V0.80：爽点计数（供漂移检测"近15章爽点密度过低"信号）
  notes.payoff_count = Array.isArray(audit.payoffs) ? audit.payoffs.length : 0;
  if (health) store.chapterHealth.update(health.id, { notes: JSON.stringify(notes) });
  else {
    store.chapterHealth.add({ bookId, chapterId, idx: chapterIdx, verdict: 'ok', issues: 0 });
    store.chapterHealth.update(store.chapterHealth.getByChapter(chapterId).id, { notes: JSON.stringify(notes) });
  }

  // 兑现 → 期待账本标记 paid
  const paid = [];
  const payoffs = Array.isArray(audit.payoffs) ? audit.payoffs : [];
  for (const p of payoffs) {
    const hit = store.pleasureHooks.active(bookId).find(h => p.desc && hookDescriptionsMatch(h.desc, p.desc));
    if (hit) { store.pleasureHooks.update(hit.id, { status: 'paid', note: `第${chapterIdx}章兑现${p.was_surprising ? '（超额）' : ''}` }); paid.push(hit.desc); }
  }
  // 无匹配但声明兑现的 → 登记为已兑现的短期爽点（不计账本）
  const openHooks = store.pleasureHooks.active(bookId);
  for (const p of payoffs) {
    if (!paid.includes(p.desc) && openHooks.every(h => !hookDescriptionsMatch(h.desc, p.desc))) {
      store.pleasureHooks.create(bookId, { desc: p.desc, kind: 'short', type: p.kind || '其他', plantedChapter: chapterIdx, dueChapter: chapterIdx, status: 'paid', intensity: 2, note: '审计识别即时兑现' });
    }
  }

  // 问题 → 约束反哺（high/medium）
  const constraints = [];
  for (const issue of Array.isArray(audit.issues) ? audit.issues : []) {
    if (issue.severity === 'low') continue;
    store.constraints.add(bookId, {
      content: `【快感】${issue.detail}（第${chapterIdx}章）——${issue.fix || '后续写作注意'}`,
      source: 'pleasure', key: `pleasure:${issue.type || issue.detail?.slice(0, 48) || 'issue'}`,
      scopeStart: chapterIdx + 1, scopeEnd: chapterIdx + 3,
    });
    constraints.push(issue);
  }
  return { ok: true, audit, paid, constraints };
}

/**
 * V0.73 钩子积压治理：每章结算后统计超期期待账本，返回积压压力指标。
 * V0.95.0 钩子老化：长线钩（long/super）超期 >15 章且从未推进 → expired，并转 foreshadows。
 * V0.102：短/中线同样超期无推进则 expire，**不转伏笔**（否则 90 条短钩会再变成 90 条坑）。
 * 有推进的钩子不老化。判定单一真源：horizon.hooksDueToAge。
 * @returns {{abandoned:number, kept:number, overdueCount:number}}
 */
export function settleHookLedger(bookId, currentChapter) {
  const open = store.pleasureHooks.list(bookId).filter(h => h.status === 'open');
  const due = hooksDueToAge(open, currentChapter);
  let abandoned = 0;
  for (const h of due) {
    const overdueChapters = (Number(h.due_chapter) || 0) > 0
      ? Number(currentChapter) - Number(h.due_chapter)
      : 0;
    const convert = ['long', 'super'].includes(h.kind);
    store.pleasureHooks.update(h.id, {
      status: 'expired',
      note: convert
        ? `第${currentChapter}章老化（超期${overdueChapters}章无推进），转伏笔台账`
        : `第${currentChapter}章老化（超期${overdueChapters}章无推进，短中线不转伏笔）`,
    });
    if (convert) {
      const exists = store.foreshadows.list(bookId).some(f => (f.desc || '').includes(String(h.desc || '').slice(0, 12)));
      if (!exists) {
        store.foreshadows.create(bookId, {
          desc: h.desc, type: '剧情伏笔', plantedChapter: h.planted_chapter,
          status: 'planted', importance: 'high', note: `长线期待老化转入（原快感钩，埋于第${h.planted_chapter}章）`,
          events: [{ chapter: Number(currentChapter), note: '由快感账本老化转入' }],
        });
      }
    }
    abandoned++;
  }
  const kept = store.pleasureHooks.list(bookId).filter(h => ['open', 'progressing', 'confirmed'].includes(h.status)).length;
  const overdueCount = store.pleasureHooks.list(bookId)
    .filter(h => ['open', 'progressing', 'confirmed'].includes(h.status) && h.due_chapter && currentChapter > h.due_chapter).length;
  return { abandoned, kept, overdueCount };
}

/**
 * V0.95 钩型轮换检测（零 LLM）：最近 3 条已兑现章末钩同型 → 轮换约束。
 * 依据：钩型轮换占比表（危机 40%/反转 25%/悬念 20%/战斗 15%）——同型钩连用 6 次
 * 边际感染力归零（V0.94 精读实证灰烟钩）；台账 type 比正文正则可靠（细纲自报）。
 */
export function hookTypeStreakCheck(bookId, chapterIdx, streakLimit = 3) {
  const rules = [];
  try {
    const recent = store.pleasureHooks.list(bookId)
      .filter(h => h.kind === 'short' && Number(h.planted_chapter) <= Number(chapterIdx))
      .sort((a, b) => Number(b.planted_chapter) - Number(a.planted_chapter))
      .slice(0, streakLimit);
    if (recent.length >= streakLimit) {
      const types = recent.map(h => String(h.type || '其他'));
      if (types.every(t => t === types[0])) {
        rules.push(`章末钩型「${types[0]}」已连续 ${streakLimit} 章使用——本章必须换型（危机/悬念/反转/挑衅/倒计时/情感期待轮换；同型钩边际感染力归零）`);
      }
    }
  } catch { /* 台账读取失败忽略 */ }
  return rules;
}

/** 本地节奏规则检查（零成本；返回需注入的约束） */
export function schedulerCheck(bookId, chapterIdx) {
  const rules = [];
  const stage = lifecycleStageAtChapter(bookId, chapterIdx);
  const emotions = recentEmotionLabels(bookId);
  // 1) 连续 3 章强度 ≥7 或 ≤3 → 疲劳/寡淡
  if (emotions.length >= 3) {
    const last3 = emotions.slice(-3);
    if (last3.every(e => e.emotion.intensity >= 7)) rules.push('连续3章高强度紧张（≥7），下一章必须安排放松/甜蜜/余韵下探（张力曲线：紧张-释放振荡）');
    if (last3.every(e => e.emotion.intensity <= 3)) rules.push('连续3章低强度（≤3），下一章必须安排冲突升级或爽点兑现（读者流失风险）');
  }
  // V0.95 爽点三级调度（3-5 章法则 + 平路红线——top10% 作品每 1.8 章一次情绪高峰，
  // bottom10% 4.7 章；修仙书对话空心化带实证"连续平路"是中段弃书主因）
  const notesOf = (bookId2) => store.chapters.list(bookId2).map(c => {
    const h = store.chapterHealth.getByChapter(c.id);
    if (!h?.notes) return null;
    try { return { idx: c.idx, ...JSON.parse(h.notes) }; } catch { return null; }
  }).filter(Boolean).sort((a, b2) => a.idx - b2.idx);
  const allNotes = notesOf(bookId);
  const withPayoff = allNotes.filter(n => (n.payoff_count || 0) > 0);
  if (withPayoff.length) {
    const lastPayoffIdx = withPayoff[withPayoff.length - 1].idx;
    const gap = chapterIdx - lastPayoffIdx;
    if (gap >= REDLINES.midPayoffGapMax) {
      rules.push(`距上一次可感知爽点/回报已 ${gap} 章（红线 ≤${REDLINES.midPayoffGapMax} 章），本章必须安排一次中爽兑现（完整打脸/突破/收获/关系突破任选其一，当众+有见证）——读者没爽到会弃书`);
    }
  } else if (allNotes.length >= 3) {
    rules.push('已连写多章零可感知回报，本章必须安排至少一次具体爽点/阅读回报（读者没有获得感就是弃书点）');
  }
  // 平路红线：连续 3 章低强度且零回报
  const last3Notes = allNotes.slice(-3);
  if (last3Notes.length >= 3 && last3Notes.every(n => (n.emotion?.intensity ?? 5) <= 3 && !(n.payoff_count > 0))) {
    rules.push('连续3章平路（低强度+零回报），下一章必须新冲突进场或悬念引爆（平路超3章=追读率断崖）');
  }
  // 2) 连续 3 章无有效钩子
  const hooks = emotions.slice(-3).map(e => e.hook);
  if (stage.id !== 'finale' && hooks.length >= 3 && hooks.every(h => !h || !h.present || h.intensity < 3)) { // V0.95：<3 统一视为无钩
    rules.push('最近3章均无有效章末钩子（<3级），本章 reader_pull 须由已有因果长出阅读余力，不要为过闸点名补危机/倒计时钩类型');
  }
  // V0.95 钩型轮换（同型钩边际感染力归零）
  rules.push(...hookTypeStreakCheck(bookId, chapterIdx));
  // 3) 弧线失衡：<3 条开新支线，>5 条简化
  const openCount = store.storyArcs.open(bookId, chapterIdx).filter(a => a.status !== 'closed').length;
  if (stage.id === 'late_middle') {
    rules.push(`当前为中后期：${openCount}条开放弧线须向最终问题汇流，禁止新增重大主线；每卷至少推进或关闭一条旧线。`);
    if (openCount > 4) rules.push(`中后期仍有${openCount}条开放弧线，近期须合并或收束1-2条，开放债务必须净减少。`);
  } else if (stage.id === 'ending') {
    rules.push(`当前为后期收尾：${openCount}条开放弧线只许推进或关闭，不得再开长线；优先结算主线、关系线与高重要伏笔。`);
  } else if (stage.id === 'finale') {
    rules.push(`当前为终卷：${openCount}条开放弧线必须完成最终结算；不得新增期待，终章不留下一章悬念。`);
  } else {
    if (openCount < 3) rules.push(`当前并行弧线仅${openCount}条（应保持3-5条），本章或近期需开启新支线/感情线/暗线（蔡格尼克效应驱动追读）`);
    if (openCount > 5) rules.push(`当前并行弧线${openCount}条（超过5条上限），近期应收束1-2条（弧线过多读者负担重）`);
  }
  // 4) 钩子超期（V0.73：摘要化——此前把全部超期钩子拼进一条约束 → 单条 13K 字符巨约束，
  //    accumulate 进 constraints 后每章 write 都注入，撑爆缓存尾部且淹没重点）
  const expired = store.pleasureHooks.expired(bookId, chapterIdx);
  if (expired.length) {
    const shown = expired.slice(0, 3).map(h => h.desc).join('、');
    const tail = expired.length > 3 ? `等 ${expired.length} 条` : '';
    rules.push(`超期待兑现（共${expired.length}条）：${shown}${tail}——本章应优先兑现最紧急的（期待疲劳会转成弃书）`);
  }
  // 5) 停滞弧线回填
  const stale = store.storyArcs.stale(bookId, chapterIdx);
  if (stale.length) rules.push(`停滞弧线回填：${stale.map(a => a.name).join('、')}——本章安排推进（长线期待需每3-5章分期确认）`);
  // 6) V0.80 情绪模式化检测（同一情绪循环重复 → 换节奏）
  try {
    const pat = detectEmotionPattern(bookId);
    if (pat.patterned) rules.push(pat.note);
  } catch { /* 检测失败忽略 */ }
  // V0.101：连续兑现后必须派低谷——调度此前只催回报，压抑-释放缺另一半
  try {
    const book = store.books.get(bookId);
    const profile = resolveCraftProfile(book, store.books.settings(bookId));
    const cadence = profile.valleyCadence;
    // 成章后调度下一章：pipeline 传入刚完成的章号，故含本章（idx <= chapterIdx）
    const prior = allNotes.filter(n => n.idx <= chapterIdx).slice(-cadence);
    if (prior.length >= cadence
      && prior.every(n => (n.payoff_count || 0) > 0)
      && prior.every(n => !n.valley)) {
      rules.push(`连续${cadence}章都有可感知回报且没有低谷，本章必须是低谷/代价章：用一件具体物象写损失或受阻，禁止直写情绪标签，也禁止本章立刻全额讨回。`);
    }
  } catch { /* 偏好槽失败不阻断节奏调度 */ }
  return rules;
}

/** 取主角名：优先分级 protagonist 角色卡，其次 cast 材料首行，最后空串 */
export function protagonistName(bookId) {
  try {
    const proto = store.characters.list(bookId).find(c => c.tier === 'protagonist');
    if (proto?.name) return proto.name;
    const cast = store.materials.get(bookId, 'cast')?.content || '';
    const m = cast.match(/【主角】(.+)/);
    if (m?.[1]) return m[1].split(/[（(]/)[0].trim();
  } catch { /* ignore */ }
  return '';
}

/** 快感计划 → 注入文本（供 settings.js:56 / 卷大纲消费；纯文本不进缓存前缀）
 *  V0.82：历史题材（史实流·无金手指）不注入"金手指"字段，改注入"立身之本"语义 */
export function formatPleasurePlan(plan, { isHistory = false } = {}) {
  if (!plan) return '';
  const rr = plan.reward_rhythm || {};
  const sr = plan.suppress_release || {};
  const lines = [];
  lines.push(isHistory
    ? `【全书阅读回报】调色盘：${(plan.reward_palette || ['依恋', '生存', '能力', '关系', '信息', '尊严', '战术', '战略', '余韵']).join('、')}；逐章：${rr.small || '一种具体回报'}；阶段兑现：${rr.medium || '每3-5章'}；阶段结算：${rr.large || '每8-12章'}`
    : `【全书爽点节奏】小爽：${rr.small || '每1-3章'}；中爽：${rr.medium || '每5-10章'}；大爽：${rr.large || '每15-30章'}`);
  if (Array.isArray(plan.emotion_rotation) && plan.emotion_rotation.length) lines.push(`情绪轮换：${plan.emotion_rotation.join(' → ')}`);
  if (sr.ratio) lines.push(`压抑:释放=${sr.ratio}${sr.authority_symbols?.length ? `，权威象征：${sr.authority_symbols.join('、')}` : ''}`);
  if (plan.protagonist_recipe?.golden_finger) {
    const gf = plan.protagonist_recipe.golden_finger;
    if (isHistory) {
      lines.push(`立身之本（史实流·无金手指）：${gf.power || ''}${gf.limit ? `（资本边界：${gf.limit}）` : ''}`);
    } else {
      lines.push(`主角金手指：${gf.power || ''}${gf.limit ? `（限制：${gf.limit}）` : ''}`);
    }
  }
  return lines.join('\n');
}

/** 书级快感计划（pilot 骨架阶段调用；结果存 settings_json.pleasurePlan）
 *  V0.80 贯通：传真实书契约/题材包/主角/卷数（此前 contract=''、volumeCount=0 → 计划与契约题材脱节）；
 *  落 materials('pleasure') 激活 settings.js 死读；arc_plan 播种 story_arcs 表。 */
export async function planBookPleasure(bookId, { onProgress } = {}) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  onProgress?.({ stage: '快感计划' });
  const contract = store.materials.get(bookId, 'contract')?.content || '';
  const genreText = genrePackText(book.genre);
  const protagonist = protagonistName(bookId);
  const volumeCount = store.volumes.list(bookId).length;
  const res = await runTask({ bookId, task: 'pleasure_plan', jsonMode: true, messages: assembleMessages(bookId, [
    { role: 'user', content: bookPleasurePlanInstruction({ bookTitle: book.title, genre: book.genre, platform: book.platform || '通用', contract, protagonist, volumeCount, genreText }) },
  ]) });
  const plan = extractJSON(res.content);
  if (!plan) return { ok: false, error: '快感计划解析失败' };
  const settings = book.settings_json ? JSON.parse(book.settings_json) : {};
  settings.pleasurePlan = plan;
  store.books.update(book.id, { settings_json: JSON.stringify(settings) });
  // V0.80：写 materials('pleasure') —— settings.js:56 一直读它但从无写入（死读）；不进公共前缀，只供 settings/卷纲消费
  // V0.82：历史题材（史实流）金手指字段按"立身之本"语义格式化
  try { store.materials.set(bookId, 'pleasure', formatPleasurePlan(plan, { isHistory: book.genre === '历史' })); } catch { /* ignore */ }
  // V0.80：arc_plan 播种 story_arcs（并行弧线追踪立即生效；同名跳过）
  try {
    const chaptersPerVolume = chaptersPerVolumeEstimate(bookId);
    for (const arc of (Array.isArray(plan.arc_plan) ? plan.arc_plan : [])) {
      const name = (arc.name || '').trim();
      if (!name) continue;
      if (store.storyArcs.list(bookId).some(a => a.name === name)) continue;
      const window = parseArcWindow(arc.span, { chaptersPerVolume });
      store.storyArcs.create(bookId, {
        name, type: arc.type || '支线', openedChapter: window.openedChapter, targetChapter: window.targetChapter, note: arc.note || '',
      });
    }
  } catch { /* 播种失败不阻塞 */ }
  return { ok: true, plan };
}

/** “第2-12卷”或“第4-20章” → 实际章节开启/目标窗口。 */
export function parseArcWindow(span, { chaptersPerVolume = 8 } = {}) {
  const source = String(span || '');
  const m = source.match(/第?\s*(\d+)\s*[-~至]\s*(\d+)\s*(卷|章)/);
  if (!m) return { openedChapter: 1, targetChapter: null };
  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  if (m[3] === '卷') {
    const size = Math.max(1, Number(chaptersPerVolume) || 8);
    return { openedChapter: (start - 1) * size + 1, targetChapter: end * size };
  }
  return { openedChapter: start, targetChapter: end };
}

/** 最近 N 章情绪标签（读 chapter_health.notes） */
export function recentEmotionLabels(bookId, n = 6) {
  const chapters = store.chapters.list(bookId);
  const out = [];
  for (const ch of chapters) {
    const health = store.chapterHealth.getByChapter(ch.id);
    if (!health?.notes) continue;
    try {
      const notes = JSON.parse(health.notes);
      if (notes.emotion) out.push({ chapterIdx: ch.idx, emotion: notes.emotion, hook: notes.hook || null });
    } catch { /* ignore */ }
  }
  return out.slice(-n);
}

/** 情绪节奏审计报告（供 UI/调度使用） */
export function pleasureStatus(bookId) {
  const hooks = store.pleasureHooks.list(bookId);
  const arcs = store.storyArcs.list(bookId);
  const emotions = recentEmotionLabels(bookId, 10);
  return {
    hooks: {
      total: hooks.length,
      open: hooks.filter(h => ['open', 'progressing', 'confirmed'].includes(h.status)).length,
      paid: hooks.filter(h => h.status === 'paid').length,
      expired: hooks.filter(h => h.status === 'open' && h.due_chapter).length,
      list: hooks.slice(-30).reverse(),
    },
    arcs: {
      open: arcs.filter(a => a.status !== 'closed').length,
      list: arcs.slice(-30).reverse(),
    },
    emotions: emotions.map(e => ({ chapter: e.chapterIdx, type: e.emotion.type, intensity: e.emotion.intensity, hook: e.hook })),
    rhythmIssues: schedulerCheck(bookId, emotions.length ? emotions[emotions.length - 1].chapterIdx : 0),
  };
}
