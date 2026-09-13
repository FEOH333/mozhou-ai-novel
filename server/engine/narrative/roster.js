// server/engine/narrative/roster.js —— V0.50 角色库自动整理（AI 本位）
// 职责：①本地规则分级（cast 主角→protagonist / cast 配角库→major / 其余→minor/extra）
//      ②AI 批量补全空字段（personality/goal/fear/secret/arc/relation/abilities）——只填空不覆盖
//      ③角色与 cast（人物设计）对齐：设计里有的角色自动建档
import * as store from '../../db/store.js';
import { runTask } from '../../llm/router.js';
import { assembleMessages } from '../../llm/cache.js';
import { ensureHistory } from '../planning/outline.js';
import { extractJSON } from '../../util/json.js';
import { rosterTidyInstruction } from '../prompts.js';
import { inferEntityType } from './pending.js'; // V0.53：非人物卡净化（道具/地点误建角色）
import { logFlow } from '../../util/oplog.js';
import { isCompletedChapter, isCompletedVolume } from '../pipeline/chapter_status.js';

/** 角色是否被 cast 人物设计点名（兼容有/无 "- " 前缀的行：`阿福｜...` 或 `- 阿福｜...`） */
export function castMatched(castText, name) {
  if (!castText || !name) return false;
  const re = new RegExp(`(?:^|\\n)[-\\s]*${escapeReg(name)}[｜|]`);
  return re.test(castText);
}

/** 本地规则分级：按 cast 人物设计推断 tier（V0.53：兼容无前缀 cast 行；extra 不盲目固化；未匹配默认 minor） */
export function localTier(bookId, castText, c) {
  const cast = castText || '';
  // 已有 protagonist/major 且六维有内容 → 尊重（AI 补全会填缺的）
  if ((c.tier === 'protagonist' || c.tier === 'major') && (c.personality || c.goal || c.secret || c.arc)) return c.tier;
  // cast 主角（兼容【主角】林晚 与 【主角弧光】\n李尘｜ 两种格式）
  const pMatch = cast.match(/【主角(?:弧光)?】[^\S\n]*\n?\s*([^\s｜|]+)/);
  if (pMatch && (c.name === pMatch[1] || c.name.includes(pMatch[1]) || pMatch[1].includes(c.name))) return 'protagonist';
  // cast 配角库点名（带或不带 - 前缀）
  if (castMatched(cast, c.name)) return 'major';
  // 未匹配 cast：默认次要配角（不再默认龙套——防误杀；真正龙套由 AI 补全时判定或手动标记）
  return 'minor';
}

function escapeReg(s) { return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 角色档案是否完整（六维 + 能力均有内容） */
function isComplete(c) {
  const abis = (() => { try { return JSON.parse(c.abilities_json || '[]'); } catch { return []; } })();
  return !!(c.personality && c.goal && c.fear && c.secret && c.arc && c.relation && abis.length);
}

/** 角色六维是否全空（疑似非人物卡——道具/地点误建） */
function isEmptyCard(c) {
  return !(c.personality || c.goal || c.fear || c.secret || c.arc || c.relation) &&
    !(JSON.parse(c.abilities_json || '[]') || []).length;
}

/**
 * 角色卡净化（V0.53）：六维全空且不在 cast 的角色卡，用类型推断识别——
 * 判为地点/物品/势力的（历史遗留：早期版本把新名词直接建成角色卡）→ 迁移到对应表并移出角色库
 * @returns {{migrated:string[]}}
 */
export function purgeMisplacedCharacterCards(bookId, castText) {
  const migrated = [];
  const kindMap = { location: 'locations', item: 'items', faction: 'factions' };
  // V0.53：类型推断兜底——名字后缀启发式（inferEntityType 词表覆盖不全时用）
  // V0.65：双轨净化——多字词后缀（箭头/门槛/令牌…）强命中（不管六维是否补全，物品卡逃不过）；
  // 单字后缀（光/灰/丝/纹…）弱命中（仅六维全空的卡才用，防误杀"王光"类真角色名）
  const ITEM_STRONG = /(箭头|门槛|令牌|符纸|药瓶|玉佩|玉牌|金线|布条|木匣|石轮|骨片|残片|断玉|碎片|铁剑|钥匙|图谱|印记|刻痕|血纹|手记|功法|丹药|灵米|妖丹|法宝|法器|令旗|储物袋)$/;
  const ITEM_WEAK = /(碑|骨|玉|石|符|印|剑|刀|珠|镜|鼎|炉|丹|药|卷|图|令|牌|环|戒|坠|幡|伞|钟|鼓|琴|笛|册|匣|盒|钥|锁|轮|片|穗|绳|链|棒|杖|筒|碗|盏|灯|烛|香|签|光|丝|纹|痕|疤|块|粒|袋|囊|瓶|罐|盆|铲|锄|犁|网|钩|针|线|布|帛|纸|墨|砚|笔|灰)$/;
  const LOC_SUFFIX = /(城|镇|村|山|峰|谷|岭|崖|洞|窟|宫|殿|楼|阁|台|坊|街|巷|桥|河|湖|江|林|原|庙|寺|观|井|泉|塔|田|坡|沟|渠|坝|堤|院|园|廊|亭|房|屋|窑|市|集|铺|栈|驿)$/;
  const FAC_SUFFIX = /(家族|宗门|门派|帮派|世家|皇朝|商会|联盟|部落)$/;
  // V0.53 修正：生物/怪物/神秘存在是"角色"（哪怕无名），不得净化（如 石蜥/人形/妖兽）
  const BIO_SUFFIX = /(蜥|兽|妖|怪|蛇|狼|虎|熊|鹰|蛟|龙|龟|蟹|蛛|蜂|蚁|虫|魂|鬼|尸|影|人)$/;
  // V0.65：名称含"的"且长度>6 → 高度疑似非人名（"孙伯家门口白石头门槛"）
  const POSSESSIVE_NAME = /^[^的]{2,6}的[^的]+$/;
  for (const c of store.characters.list(bookId)) {
    if (c.deceased) continue;
    if (castMatched(castText, c.name)) continue; // cast 点名的保留（等 AI 补全）
    if (BIO_SUFFIX.test(c.name)) continue; // 生物/人物/神秘存在 → 保留为角色
    let type = null;
    if (ITEM_STRONG.test(c.name)) type = 'item'; // 多字词强命中（六维补全过也清）
    else if (LOC_SUFFIX.test(c.name)) type = 'location';
    else if (FAC_SUFFIX.test(c.name)) type = 'faction';
    else if (POSSESSIVE_NAME.test(c.name)) type = 'item';
    else if (isEmptyCard(c)) {
      // 弱命中：六维全空的卡才用单字后缀/词表兜底（防误杀真角色）
      if (ITEM_WEAK.test(c.name)) type = 'item';
      else {
        try {
          const inferred = inferEntityType(c.name, (c.card_json || '') + ' ' + (c.state_json || ''));
          if (inferred === 'item' || inferred === 'location' || inferred === 'faction') type = inferred;
        } catch { /* ignore */ }
      }
    }
    const table = kindMap[type];
    if (!table) continue; // 角色/概念/未知 → 保留
    // 迁移：目标表有同名 → 合并 note；无 → 建卡
    const existing = store[table].list(bookId).find(e => e.name === c.name);
    const card = { detail: `（自角色库迁移）${c.exitNote || c.card_json || ''}`.slice(0, 200), migratedFrom: c.id };
    if (existing) store[table].update(existing.id, { card });
    else store[table].create(bookId, { name: c.name, card });
    store.characters.remove(c.id);
    migrated.push(c.name);
  }
  return { migrated };
}

/** 从 cast 材料中补建缺失的角色（cast 配角库里的名字若不在 characters 表则建档）——V0.53 兼容无 "- " 前缀行 */
export function syncCastCharacters(bookId, castText) {
  const created = [];
  if (!castText) return created;
  const existing = new Set(store.characters.list(bookId).map(c => c.name));
  // 配角库行：`[-\s]*名字｜身份｜性格｜目标｜秘密｜命运线｜关系`
  for (const line of castText.split('\n')) {
    const m = line.match(/^[-\s]*([^｜|]+)[｜|](.+)$/);
    if (!m) continue;
    const name = m[0].replace(/^[-\s]*/, '').split('｜')[0].trim();
    if (!name || existing.has(name)) continue;
    // 跳过【主角弧光】等标题行（名字可能是'主角'）
    if (name.includes('主角') || name.includes('配角')) continue;
    const parts = m[0].replace(/^[-\s]*/, '').split('｜').map(s => s.trim());
    // parts: [名字, 身份, 性格, 目标, 秘密/苦衷, 命运线, 关系]
    // V0.96：card.traits 退役——不再双写性格（AI 补全/前端编辑只写 personality 列，
    // 双写必然发散；注入侧 characterRollCallText 已改不读 traits，性格单源=personality 列）
    store.characters.create(bookId, {
      name, tier: 'major',
      personality: parts[2] || '', goal: parts[3] || '', secret: parts[4] || '',
      relation: parts[6] || '', arc: parts[5] ? `命运线：${parts[5]}` : '',
      card: { role: parts[1] || '' },
    });
    existing.add(name);
    created.push(name);
  }
  return created;
}

/** 出场频率统计（V0.65：摘要中出现次数——分级参考） */
export function countAppearances(bookId, name) {
  if (!name) return 0;
  let n = 0;
  for (const ch of store.chapters.list(bookId)) {
    const s = store.summaries.get(ch.id);
    if (!s?.summary) continue;
    const m = s.summary.match(new RegExp(escapeReg(name), 'g'));
    if (m) n += m.length;
  }
  return n;
}

/**
 * V0.65 本地合并建议：名称包含关系的疑似同人（"灰影" ⊂ "灰影人"；"黑衣人" vs "黑衣人（阿影）"）。
 * 规则：A⊂B → 低频并入高频（高频名做主名）；长度差 ≤6（允许括号别名"（阿影）"）；
 * 所有格保护（"李尘的剑"剩余以"的"开头 → 不合并）。
 * @returns {Array<{from:string,to:string,reason:string}>}
 */
export function localMergeSuggest(bookId) {
  const chars = store.characters.list(bookId).filter(c => !c.deceased);
  const freq = new Map(chars.map(c => [c.name, countAppearances(bookId, c.name)]));
  const merges = [];
  for (const a of chars) {
    if (a.tier === 'protagonist') continue; // 主角绝不并入别人
    // V0.93.8：settle 占位标记名（"X（提及）/X（待具名）"）不参与合并——
    // 占位名曾作为合并目标吞掉真名卡（实测 贾似道→贾似道（提及））
    if (/[（(](?:提及|待具名|占位|未具名)[）)]/.test(a.name)) continue;
    for (const b of chars) {
      if (a.name === b.name || b.tier === 'protagonist') continue;
      if (/[（(](?:提及|待具名|占位|未具名)[）)]/.test(b.name)) continue;
      const [short, long] = a.name.length <= b.name.length ? [a.name, b.name] : [b.name, a.name];
      if (short === long) continue;
      if (long.length - short.length > 6) continue;
      if (!long.startsWith(short) && !long.includes(short)) continue;
      const rest = long.slice(short.length);
      if (rest.startsWith('的')) continue; // 所有格（"李尘的剑"）→ 不是同一角色
      // 短名是长名的前缀/子串 → 低频并入高频
      const from = (freq.get(short) || 0) <= (freq.get(long) || 0) ? short : long;
      const to = from === short ? long : short;
      if (merges.some(m => m.from === from && m.to === to)) continue;
      merges.push({ from, to, reason: `名称包含关系（${short} ⊂ ${long}）疑似同一角色` });
    }
  }
  return merges;
}

/**
 * V0.65 执行角色合并：from 的事实/提及迁移到 to，删除 from 卡（保留 to 卡）
 * @returns {number} 合并数
 */
export function applyMerges(bookId, merges) {
  let n = 0;
  for (const m of merges || []) {
    const from = store.characters.list(bookId).find(c => c.name === m.from);
    const to = store.characters.list(bookId).find(c => c.name === m.to);
    if (!from || !to) continue;
    if (from.tier === 'protagonist' || to.tier === 'protagonist') continue; // 主角不可被合并
    // 事实迁移（subject 更新：新建 to 的事实 + 废弃 from 的旧事实；同 subject+predicate+object 去重）
    for (const f of store.facts.list(bookId).filter(f => f.subject === m.from)) {
      const dup = store.facts.list(bookId).some(f2 => f2.subject === m.to && f2.predicate === f.predicate && f2.object === f.object && f2.status === 'active');
      if (dup) { try { store.facts.supersede(f.id); } catch { /* ignore */ } }
      else {
        try {
          store.facts.create(bookId, { subject: m.to, predicate: f.predicate, object: f.object, sourceChapter: f.source_chapter });
          store.facts.supersede(f.id);
        } catch { /* ignore */ }
      }
    }
    // 合并备注到 to 卡（别名记录）
    const alias = `${from.name}（${m.reason || '同人合并'}）`;
    const note = (to.exitNote || to.note || '');
    try { store.characters.update(to.id, { exitNote: note ? `${note}；别名：${alias}` : `别名：${alias}` }); } catch { /* ignore */ }
    store.characters.remove(from.id);
    n++;
  }
  if (n > 0) logFlow({ op: '角色合并', detail: `合并 ${n} 组：${(merges || []).slice(0, n).map(m => `${m.from}→${m.to}`).join('、')}`, bookId });
  return n;
}

/**
 * V0.65 出场频率分级：未被 cast 点名的角色按出场次数调整（高频未点名→major/minor；极低频→extra）
 * 规则：≥15 次 major / ≥5 次 minor / <5 次 extra；已 deceased 或已有 major+ 不降级
 * @returns {number} 调整数
 */
export function tierByFrequency(bookId, castText) {
  let changed = 0;
  for (const c of store.characters.list(bookId)) {
    if (c.deceased || c.tier === 'protagonist') continue;
    if (castMatched(castText, c.name)) continue; // cast 点名的走设计 tier
    if (c.tier === 'major' || c.tier === 'extra') {
      // major 不降级（防误杀）；extra 升级
      if (c.tier === 'extra' && countAppearances(bookId, c.name) >= 5) {
        store.characters.update(c.id, { tier: 'minor' }); changed++;
      }
      continue;
    }
    const freq = countAppearances(bookId, c.name);
    const want = freq >= 15 ? 'major' : (freq >= 5 ? 'minor' : 'extra');
    if (want !== c.tier) { store.characters.update(c.id, { tier: want }); changed++; }
  }
  return changed;
}

/**
 * 角色库自动整理（AI 本位）：
 * 1) purgeMisplacedCharacterCards：道具/地点误建角色 → 迁移（V0.65 双轨词表扩充）
 * 2) 合并：本地包含关系合并（灰影→灰影人）+ AI 语义合并（安师兄→安承）
 * 3) syncCastCharacters：cast 配角库补建缺失角色
 * 4) localTier + tierByFrequency 分级（cast 优先、频率兜底）
 * 5) AI 批量补全空字段（只填空不覆盖）
 * @returns {{ok:boolean, note:string, created:string[], updated:number, merged:number, migrated:number}}
 */
export async function tidyRoster(bookId, { onEvent, signal } = {}) {
  const mats = store.materials.all(bookId);
  const castText = mats.find(m => m.kind === 'cast')?.content || '';
  // 0) 角色卡净化：道具/地点误建角色 → 迁移到对应表（历史遗留清理）
  const { migrated } = purgeMisplacedCharacterCards(bookId, castText);
  // 0.5) 合并：本地包含关系（零成本）
  let merged = 0;
  try {
    const local = localMergeSuggest(bookId);
    if (local.length) merged += applyMerges(bookId, local.slice(0, 10));
  } catch { /* 合并失败不阻塞 */ }
  // 1) 补建
  const created = syncCastCharacters(bookId, castText);
  // 2) 本地分级（cast 优先）
  let tierChanged = 0;
  for (const c of store.characters.list(bookId)) {
    const t = localTier(bookId, castText, c);
    if (t !== c.tier) { store.characters.update(c.id, { tier: t }); tierChanged++; }
  }
  // 2.5) 出场频率分级（未点名角色按出场次数）
  tierChanged += tierByFrequency(bookId, castText);
  // 3) AI 批量补全（六维不全的角色；cast 点名的 extra 也补，其余 extra 跳过省 token）
  // V0.53：分批（每批 6 个）——一次输出过多角色档案会超 maxTokens 截断导致补全失败
  const chars = store.characters.list(bookId);
  const candidates = chars.filter(c => !c.deceased && !isComplete(c) && (c.tier !== 'extra' || castMatched(castText, c.name)));
  let updated = 0;
  if (candidates.length && !process.env.NOVEL_MOCK_LLM_OFF) {
    ensureHistory(bookId);
    for (let i = 0; i < candidates.length; i += 6) {
      const batch = candidates.slice(i, i + 6);
      const listText = batch.map(c => `- ${c.name}（已有：性格=${c.personality || '空'}｜说话=${c.speech || '空'}｜禁腔=${c.speech_forbid || '空'}｜目标=${c.goal || '空'}｜软肋=${c.fear || '空'}｜秘密=${c.secret || '空'}｜弧线=${c.arc || '空'}｜关系=${c.relation || '空'}）`).join('\n');
      const tail = [{
        role: 'user',
        content: rosterTidyInstruction({ bookTitle: store.books.get(bookId)?.title || '', castText: castText.slice(0, 2000), listText }),
      }];
      const messages = assembleMessages(bookId, tail);
      const res = await runTask({ task: 'roster_tidy', bookId, messages, jsonMode: true });
      const data = extractJSON(res.content) || {};
      const byName = new Map(chars.map(c => [c.name, c]));
      for (const row of (Array.isArray(data.characters) ? data.characters : [])) {
        const name = (row.name || '').trim();
        const c = byName.get(name);
        if (!c || c.deceased) continue;
        const patch = {};
        for (const col of ['personality', 'goal', 'fear', 'secret', 'arc', 'relation', 'speech']) {
          const val = String(row[col] || '').trim();
          if (val && !c[col]) patch[col] = val.slice(0, 300);
        }
        const speechForbid = String(row.speech_forbid || row.speechForbid || '').trim();
        if (speechForbid && !c.speech_forbid) patch.speechForbid = speechForbid.slice(0, 300);
        const abis = Array.isArray(row.abilities) ? row.abilities.filter(a => a?.name).map(a => ({ name: String(a.name).slice(0, 40), type: String(a.type || '').slice(0, 20), desc: String(a.desc || '').slice(0, 120) })) : [];
        if (abis.length && !(JSON.parse(c.abilities_json || '[]') || []).length) patch.abilities = abis.slice(0, 12);
        if (Object.keys(patch).length) { store.characters.update(c.id, patch); updated++; }
      }
    }
  }
  const total = store.characters.list(bookId).length;
  logFlow({ op: '角色库自动整理', detail: `共 ${total} 人；净化 ${migrated.length}；补建 ${created.length}；分级调整 ${tierChanged}；AI 补全 ${updated}`, bookId });
  return { ok: true, note: `共 ${total} 人；净化 ${migrated.length}（${migrated.join('、') || '无'}）；补建 ${created.length}（${created.join('、') || '无'}）；分级 ${tierChanged}；AI 补全 ${updated} 人`, created, updated, migrated };
}

/**
 * V0.83：cast 角色弧光补设计（接线此前死代码 castDesignInstruction）——pilot 每完成一卷触发一次。
 * 产出：①cast 材料更新（主角弧光/配角库含 secret/fate）②social_ecology 并入 world 材料。
 * @returns {{ok:boolean, updated?:boolean, error?:string}}
 */
export async function runCastDesign(bookId, { signal } = {}) {
  try {
    const book = store.books.get(bookId);
    if (!book) return { ok: false, error: '作品不存在' };
    const outlineText = store.materials.get(bookId, 'outline')?.content || '';
    const contract = store.materials.get(bookId, 'contract')?.content || '';
    const openForeshadows = store.foreshadows.list(bookId).filter(f => f.status === 'planted' || f.status === 'advanced');
    const chars = store.characters.list(bookId).slice(0, 25).map(c => `${c.name}（${c.tier || 'minor'}${c.personality ? '，' + c.personality.slice(0, 20) : ''}）`).join('；');
    const written = store.chapters.list(bookId).filter(isCompletedChapter).length;
    const { castDesignInstruction } = await import('../prompts.js');
    const res = await runTask({
      task: 'cast_design', bookId, jsonMode: true, signal,
      messages: assembleMessages(bookId, [{
        role: 'user',
        content: castDesignInstruction({ bookTitle: book.title, outlineText, contract, openForeshadows, chars, writtenChapters: written }),
      }]),
    });
    const data = extractJSON(res.content) || {};
    if (!data.cast_text) return { ok: false, error: 'cast 设计解析失败' };
    // 更新 cast 材料（角色弧光/配角库——进公共前缀供后续写作/续卷消费）
    store.materials.set(bookId, 'cast', data.cast_text.trim());
    // social_ecology 并入 world 材料（市井烟火气按场景注入）
    if (data.social_ecology) {
      const wm = store.materials.get(bookId, 'world')?.content || '';
      if (!wm.includes(data.social_ecology.slice(0, 12))) {
        store.materials.set(bookId, 'world', `${wm}\n【社会生态】${data.social_ecology}`);
      }
    }
    // 同步角色建档（cast 里的角色 → characters 表）
    try { syncCastCharacters(bookId, data.cast_text); } catch { /* ignore */ }
    logFlow({ op: 'cast 补设计', detail: `卷末角色弧光/配角库更新（${written} 章时）`, bookId });
    return { ok: true, updated: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * V0.105.4：完成卷 cast 设计幂等 sweep（pilot 每章结算后调用）。
 *
 * 此前 pilot 用进程内存 Set 记"已设计的卷"，重启即丢——自动创作每次重启都会对
 * 全部历史完成卷重跑全书级 cast_design（实测 49 章实证：vol1-5 连烧 5 次、首拍
 * miss 198K，cast_text 被重写 5 次导致 L2 公共前缀反复失效）。runCastDesign 是
 * 全书级操作（重写整个 cast_text），因此一次成功就把当前全部完成卷标记进
 * books.settings.castDesignedVolumes（持久化），跨进程幂等。
 * @returns {{ran:boolean, designed?:boolean, volumes?:string[], error?:string, note:string}}
 */
export async function sweepVolumeCastDesign(bookId, { onEvent, signal } = {}) {
  try {
    const vols = store.volumes.list(bookId);
    const marked = new Set((store.books.settings(bookId) || {}).castDesignedVolumes || []);
    const pending = vols.filter(v => isCompletedVolume(v) && !marked.has(v.id));
    if (!pending.length) return { ran: false, note: '无待设计的完成卷' };
    onEvent?.('stage', { stage: 'setup', message: `卷末配角弧光补全（${pending.length} 卷完结，1 次全书设计）…` });
    const cd = await runCastDesign(bookId, { signal });
    if (!cd.ok) return { ran: true, designed: false, error: cd.error, note: 'cast 设计失败，下轮重试' };
    const nowMarked = [...new Set([...marked, ...pending.map(v => v.id)])];
    try {
      store.books.update(bookId, { settings: { ...store.books.settings(bookId), castDesignedVolumes: nowMarked } });
    } catch { /* 持久化失败只丢幂等（下轮重烧一次），不阻塞写作 */ }
    onEvent?.('stage', { stage: 'setup', message: `配角弧光已写入角色卡（标记 ${pending.map(v => v.idx).join('、')} 卷）` });
    return { ran: true, designed: true, volumes: nowMarked, note: `已设计 ${pending.length} 卷` };
  } catch (e) {
    return { ran: false, error: e.message, note: 'cast 设计 sweep 异常，不阻塞写作' };
  }
}
