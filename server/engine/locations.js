// server/engine/locations.js —— V0.71 地点库自动整理（AI 本位）
// 与角色库（roster.js）同构但语义不同：地点高度稳定（除非重大事件否则不变），
// 整理重点是①净化人物误入 ②补全 kind/desc ③变化记录（status/note）④写入注入。
import * as store from '../db/store.js';
import { runTask } from '../llm/router.js';
import { assembleMessages } from '../llm/cache.js';
import { ensureHistory } from './outline.js';
import { extractJSON } from '../util/json.js';
import { locationTidyInstruction } from './prompts.js';
import { logFlow } from '../util/oplog.js';

function escapeReg(s) { return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 地点卡是否已补全（kind + desc 均有内容） */
function isComplete(l) {
  return !!(l.kind && l.desc);
}

/**
 * V0.71 地点库净化：人物/生物误入地点表（名字已存在于 characters 表，或以人物词结尾）→ 删除。
 * 地点表只留真正的地点；角色另有 characters 卡，不重复保留。
 * @returns {string[]} 删除的名字
 */
export function purgeMisplacedLocationCards(bookId) {
  const removed = [];
  const charNames = new Set(store.characters.list(bookId).map(c => c.name));
  // 人物/生物/神秘存在特征词（含词匹配——"追捕者（乙）"以括号结尾也命中；地点名基本不含这些词）
  const PERSON_PAT = /(看守者|追捕者|乞食者|乞丐|流民|盗匪|修士|弟子|长老|管事|老者|女子|男子|少爷|小姐|掌柜|伙计|怪物|妖兽|人形|神秘人|石蜥)/;
  for (const l of store.locations.list(bookId)) {
    if (charNames.has(l.name) || PERSON_PAT.test(l.name)) {
      store.locations.remove(l.id);
      removed.push(l.name);
    }
  }
  return removed;
}

/**
 * V0.71 从 world 材料【主要地点】段同步补建地点卡（书级设定 → 地点库）。
 * world 材料格式示例：【主要地点】青阳镇｜镇子（描述）… 或 青阳镇：描述
 * @returns {string[]} 补建的名字
 */
export function syncWorldLocations(bookId) {
  const created = [];
  const wm = store.materials.get(bookId, 'world')?.content || '';
  const seg = (wm.match(/【主要地点】([\s\S]*?)(?=【|$)/) || [])[1];
  if (!seg) return created;
  const existing = new Set(store.locations.list(bookId).map(l => l.name));
  for (const line of seg.split('\n')) {
    const m = line.trim().match(/^([^｜|:：]{2,20})[｜|:：](.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    if (!name || existing.has(name)) continue;
    const desc = m[2].trim().slice(0, 200);
    store.locations.create(bookId, { name, card: { desc } });
    try { store.locations.update(store.locations.list(bookId).find(l => l.name === name)?.id, { kind: '', desc: desc.slice(0, 120) }); } catch { /* ignore */ }
    existing.add(name);
    created.push(name);
  }
  return created;
}

/**
 * V0.71 地点卡注入文本（写作时按场景 location 注入——稳定地点简短、变化地点强调）
 * V0.82：历史题材补行政层级/战略属性（路/州/县/寨/堡 + 三江汇流/锁江天堑）
 * @param {string} bookId @param {string} locationName
 * @returns {string} 注入文本（无卡返回空串）
 */
export function locationCardText(bookId, locationName) {
  if (!locationName) return '';
  const loc = store.locations.list(bookId).find(l => l.name === locationName)
    || store.locations.list(bookId).find(l => (l.name || '').includes(locationName) || (locationName || '').includes(l.name));
  if (!loc) return '';
  const parts = [];
  if (loc.kind) parts.push(loc.kind);
  if (loc.admin_level) parts.push(loc.admin_level);
  if (loc.desc) parts.push(loc.desc);
  if (loc.strategic) parts.push(`战略：${loc.strategic}`);
  if (loc.status && loc.status !== 'normal') parts.push(`【此地已${loc.status === 'changed' ? '发生变化' : loc.status}】${loc.note || ''}`);
  if (!parts.length) return '';
  return `【地点·${loc.name}】${parts.join('；').slice(0, 220)}`;
}

/**
 * V0.71 地点库自动整理（AI 本位）：
 * 1) purgeMisplacedLocationCards：人物误入净化
 * 2) syncWorldLocations：world 设定补建
 * 3) AI 批量补全 kind/desc（只填空不覆盖；分批 6 个）
 * @returns {{ok:boolean, note:string, purged:string[], created:string[], updated:number}}
 */
export async function tidyLocations(bookId, { onEvent, signal } = {}) {
  // 1) 净化
  const purged = purgeMisplacedLocationCards(bookId);
  // 2) world 设定同步
  const created = syncWorldLocations(bookId);
  // 3) AI 补全（kind/desc 空的候选）
  const candidates = store.locations.list(bookId).filter(l => !isComplete(l));
  let updated = 0;
  if (candidates.length && !process.env.NOVEL_MOCK_LLM_OFF) {
    ensureHistory(bookId);
    for (let i = 0; i < candidates.length; i += 6) {
      const batch = candidates.slice(i, i + 6);
      const listText = batch.map(l => `- ${l.name}（已有：类型=${l.kind || '空'}｜描述=${l.desc || '空'}）`).join('\n');
      const tail = [{
        role: 'user',
        content: locationTidyInstruction({
          bookTitle: store.books.get(bookId)?.title || '', listText,
          isHistory: store.books.get(bookId)?.genre === '历史', // V0.82 历史题材行政层级+战略属性
        }),
      }];
      const messages = assembleMessages(bookId, tail);
      try {
        const res = await runTask({ task: 'location_tidy', bookId, messages, jsonMode: true });
        const data = extractJSON(res.content) || {};
        const byName = new Map(store.locations.list(bookId).map(l => [l.name, l]));
        for (const row of (Array.isArray(data.locations) ? data.locations : [])) {
          const name = (row.name || '').trim();
          const loc = byName.get(name);
          if (!loc) continue;
          const patch = {};
          const kind = String(row.kind || '').trim().slice(0, 20);
          const desc = String(row.desc || '').trim().slice(0, 200);
          if (kind && !loc.kind) patch.kind = kind;
          if (desc && !loc.desc) patch.desc = desc;
          // V0.82：历史题材行政层级/战略属性（只填空）
          const adminLevel = String(row.admin_level || '').trim().slice(0, 20);
          const strategic = String(row.strategic || '').trim().slice(0, 60);
          if (adminLevel && !loc.admin_level) patch.adminLevel = adminLevel;
          if (strategic && !loc.strategic) patch.strategic = strategic;
          if (Object.keys(patch).length) { store.locations.update(loc.id, patch); updated++; }
        }
      } catch { /* 单批失败跳过 */ }
    }
  }
  const total = store.locations.list(bookId).length;
  logFlow({ op: '地点库自动整理', detail: `共 ${total} 个地点；净化 ${purged.length}；补建 ${created.length}；AI 补全 ${updated}`, bookId });
  return { ok: true, note: `共 ${total} 个地点；净化 ${purged.length}（${purged.join('、') || '无'}）；补建 ${created.length}（${created.join('、') || '无'}）；AI 补全 ${updated} 个`, purged, created, updated };
}
