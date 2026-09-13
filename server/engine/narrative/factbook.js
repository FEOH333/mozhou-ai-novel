// server/engine/narrative/factbook.js —— 事实库读写、相关性选取、冲突处理
'use strict';
import * as store from '../../db/store.js';
import { detectEditorialVoiceLeak, sanitizeStoryMemoryText } from '../quality/rules.js';

/**
 * 选取与查询相关的 active 事实（关键词评分；向量增强由 vectorstore 接入，此处为降级基线）
 */
export function relevantFacts(bookId, query, topK = 8) {
  const facts = store.facts.list(bookId, { status: 'active' })
    .filter(f => !detectEditorialVoiceLeak(`${f.subject || ''} ${f.predicate || ''} ${f.object || ''}`).length);
  if (!facts.length) return [];
  const terms = extractTerms(query);
  const scored = facts.map(f => {
    const hay = `${f.subject} ${f.predicate} ${f.object} ${f.note || ''}`;
    let score = 0;
    for (const t of terms) {
      if (hay.includes(t)) score += t.length >= 2 ? 2 : 1;
    }
    return { f, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter(s => s.score > 0).slice(0, topK);
  // 兜底：无关键词命中时，取最新 topK 事实
  if (!top.length) return facts.slice(0, topK);
  return top.map(s => s.f);
}

/**
 * V0.83：智能事实召回 = 关键词召回 + 语义召回（长书/零命中时增强）。
 * 语义检索仅当 ①零关键词命中 或 ②已完成章数 > 50（长书早期事实易跌出关键词窗口）才触发，
 * embedding 不可用/无索引自动降级回纯关键词（零失败风险）。
 * @returns {Promise<Array>} facts
 */
export async function relevantFactsSmart(bookId, query, topK = 8) {
  const kwHits = relevantFacts(bookId, query, topK);
  const chapterCount = store.chapters.list(bookId).length;
  const zeroHit = !kwHits.some(f => f.subject && extractTerms(query).some(t => t.length >= 2 && `${f.subject} ${f.object} ${f.note || ''}`.includes(t)));
  const longBook = chapterCount > 50;
  if (zeroHit || longBook) {
    try {
      const { semanticSearch } = await import('../../memory/vectorstore.js');
      const rows = await semanticSearch(bookId, query, 6, 'fact');
      if (rows?.length) {
        const factById = new Map(store.facts.list(bookId, { status: 'active' }).map(f => [f.id, f]));
        const semanticFacts = rows
          .map(r => factById.get(r.refId))
          .filter(Boolean)
          .filter(f => !kwHits.some(k => k.id === f.id));
        if (semanticFacts.length) {
          return [...kwHits, ...semanticFacts].slice(0, topK + 4);
        }
      }
    } catch { /* embedding 不可用/无索引 → 降级纯关键词 */ }
  }
  return kwHits;
}

/** 事实 → 文本行 */
export function formatFacts(facts, { withStatus = false } = {}) {
  return facts.map(f => {
    const base = `${f.subject}${f.predicate ? ' ' + f.predicate : ''}${f.object ? ' ' + f.object : ''}`;
    return withStatus && f.status !== 'active' ? `${base}（已修正）` : base;
  }).join('\n');
}

/** 角色状态快照文本（供审校/写作注入） */
export function characterStatesText(bookId, { chapterIdx = null } = {}) {
  const chars = store.characters.list(bookId).filter(c => {
    const firstChapter = Number(c.first_chapter);
    return !(Number.isInteger(chapterIdx) && Number.isInteger(firstChapter) && firstChapter > chapterIdx);
  });
  if (!chars.length) return '';
  return chars.map(c => {
    let state = '';
    try {
      const s = JSON.parse(c.state_json || '{}');
      state = Object.entries(s)
        .map(([k, v]) => sanitizeStoryMemoryText(`${k}=${v}`).trim())
        .filter(Boolean).join('；');
    } catch { /* ignore */ }
    let card = '';
    // V0.96：settle 建卡占位 role='（待完善）' 会拼出"（（待完善））"双括号，剥一层占位标记
    try { const cd = JSON.parse(c.card_json || '{}'); const role = String(cd.role || '').replace(/[（(]\s*待完善\s*[)）]/g, '').trim(); card = role ? `（${role}）` : ''; } catch { /* ignore */ }
    return `- ${c.name}${card}${state ? '：' + state : ''}`;
  }).join('\n');
}

/** 已登记角色名列表 */
export function characterNames(bookId) {
  return store.characters.list(bookId).map(c => c.name);
}

/**
 * 应用结算抽取的事实：冲突检测（同 subject+predicate 不同 object → supersede 旧事实），写入库。
 * @returns {{created:number, superseded:number, conflicts:Array}}
 */
/** 谓词同义词归一（V0.68：防同义不同文的事实重复——"获得/得到/拿到"算同一事实） */
const PRED_SYNONYMS = {
  // “发现/找到”是认知事件，不是“获得物品”。把它们归入获得会让
  // “发现裂缝”覆盖“获得学弓资格”，长篇事实链因此被无声抹掉。
  获得: ['得到', '拿到', '取得', '弄到', '捡到'],
  得知: ['知晓', '知道', '了解到', '听说'],
  持有: ['拥有', '携带'],
  杀死: ['击杀', '斩杀', '干掉', '灭杀'],
  击败: ['打败', '战胜', '打退'],
  进入: ['来到', '抵达', '到达', '潜入'],
  离开: ['走出', '逃离', '逃出', '告别'],
  交给: ['递给', '递给', '送给', '给予'],
  看见: ['看到', '瞧见', '望见', '瞥见'],
  告诉: ['告知', '透露', '对.*说'],
  怀疑: ['起疑', '警觉'],
};
const PRED_NORM = new Map();
for (const [base, alts] of Object.entries(PRED_SYNONYMS)) {
  for (const a of alts) PRED_NORM.set(a, base);
}
export function normalizePredicate(p) {
  if (!p) return '';
  const t = p.trim();
  // 含"对...说"模式 → 告诉
  if (/对.{1,6}说$/.test(t)) return '告诉';
  return PRED_NORM.get(t) || t;
}

/**
 * 只有“当前状态”型谓词才能用新对象覆盖旧对象。其余谓词按事件/关系记录处理：
 * 精确重复会去重，不同对象必须并存。默认选择并存，是为了在无法判断谓词语义时
 * fail-safe；多一条可整理的事实，远好于无声删除已经发生过的剧情。
 */
const SINGLE_VALUE_PREDICATES = new Set([
  '位置', '位于', '所在地', '年龄', '身份', '职位', '官职', '军职', '状态', '心境',
  '实力', '实力达到', '境界', '修为', '等级', '所属', '阵营', '立场', '生死', '死亡',
  '健康', '伤势', '婚姻状态', '当前目标', '当前任务', '公元年', '当前纪年',
]);

export function isSingleValuePredicate(predicate) {
  return SINGLE_VALUE_PREDICATES.has(normalizePredicate(predicate));
}

/**
 * V0.68 事实归档：active 事实超上限（默认 1200 条）时，把最老的归档（status='archived'，不再注入检索，
 * 保留供追溯——防库无限膨胀损害检索质量）。
 * @returns {number} 归档数
 */
export function archiveOldFacts(bookId, { cap = 1200 } = {}) {
  const acts = store.facts.list(bookId, { status: 'active' });
  if (acts.length <= cap) return 0;
  // acts 为 DESC（最新在前）：保留前 cap 条（最新），归档其后（最老）——slice 起点不得为负
  const excess = acts.slice(cap, acts.length);
  let n = 0;
  for (const f of excess) {
    try { store.facts.setStatus(f.id, 'archived'); n++; } catch { /* ignore */ }
  }
  return n;
}

/**
 * V0.68 事实库整理（防混乱）：
 * ①同义词谓词近似合并（同 subject+同 object+同义词 predicate → 后者 supersede）
 * ②上限归档（active 超 1200 → 最老归档）
 * @returns {{merged:number, archived:number}}
 */
export function tidyFacts(bookId, { cap = 1200 } = {}) {
  let merged = 0;
  const acts = store.facts.list(bookId, { status: 'active' });
  const seen = new Map(); // key: subject|normPred|object → id
  for (const f of acts) {
    const norm = normalizePredicate(f.predicate);
    const key = `${f.subject}|${norm}|${f.object}`;
    if (seen.has(key)) {
      try { store.facts.supersede(f.id); merged++; } catch { /* ignore */ }
    } else {
      seen.set(key, f.id);
    }
  }
  const archived = archiveOldFacts(bookId, { cap });
  return { merged, archived };
}

export function applyFacts(bookId, facts, sourceChapter) {
  const result = { created: 0, superseded: 0, skipped: 0, conflicts: [] };
  for (const f of facts || []) {
    const subject = (f.subject || '').trim();
    const predicate = (f.predicate || '').trim();
    const object = (f.object || '').trim();
    if (!subject || !object) continue;
    // V0.68：谓词同义词归一后查重（"获得/得到/拿到"算同一事实，防同义不同文堆积）
    const norm = normalizePredicate(predicate);
    // 查同 subject+归一谓词 的 active 事实
    const existing = store.facts.list(bookId, { status: 'active' })
      .filter(x => x.subject === subject && normalizePredicate(x.predicate) === norm);
    if (existing.some(x => x.object === object)) {
      result.skipped++;
      continue;
    }
    // 事件事实是可累积历史；只有单值状态才存在“新值替换旧值”。
    const clashes = isSingleValuePredicate(norm)
      ? existing.filter(x => x.object !== object)
      : [];
    if (clashes.length) {
      const nf = store.facts.create(bookId, { subject, predicate, object, sourceChapter, note: `第${sourceChapter}章更新` });
      result.created++;
      for (const clash of clashes) {
        store.facts.supersede(clash.id, nf.id);
        result.superseded++;
        result.conflicts.push({ old: `${subject}${predicate} ${clash.object}`, next: `${subject}${predicate} ${object}`, chapter: sourceChapter });
      }
    } else {
      store.facts.create(bookId, { subject, predicate, object, sourceChapter });
      result.created++;
    }
  }
  return result;
}

/** 提取查询词（中文子串：2-6 字窗口 + 英文词） */
export function extractTerms(text) {
  if (!text) return [];
  const terms = new Set();
  // 英文/数字词
  for (const m of text.matchAll(/[a-zA-Z0-9_]{2,}/g)) terms.add(m[0].toLowerCase());
  // 中文：2-4 字连续窗口（人名地名通常 2-4 字）
  const zh = text.replace(/[^\u4e00-\u9fff]/g, '');
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i + len <= zh.length; i++) {
      if (terms.size > 40) break;
      terms.add(zh.slice(i, i + len));
    }
  }
  return [...terms];
}
