// server/engine/narrative/narrative_memory.js —— V0.95 叙事记忆库（show-me-the-story MemoryEntry 同构落地）
// 定位：与 facts（SPO 三元组，管"发生了什么"）互补——本模块管"它读起来是什么质感"：
// 人物声音（口头禅/句式/语气）、具体承诺、道具细节、名场面、关系里程碑。
// 动机：归档压缩后早期正文从历史堆删除，rolling 只保每批 5 条事实——人物怎么说话、
// 信物长什么样在长程上系统性丢失，正是"越写越没味/配角工具人化"的根因之一。
// 铁律：记忆库只诚实记录正文已发生的细节，不替 AI 决定剧情（spark StoryMemory 原则）。
'use strict';
import * as store from '../../db/store.js';
import { sanitizeStoryMemoryText } from '../quality/rules.js';

/** 记忆预算（条）：超限本地裁剪保最新（零 LLM 降级；300 章书 ×6 条/章上限的内控） */
export const MEMORY_BUDGET = 400;

/** 记忆类别（枚举白名单——防模型自造类别污染） */
export const MEMORY_CATEGORIES = new Set(['voice', 'promise', 'detail', 'scene', 'relation']);
const CATEGORY_LABEL = { voice: '人物声音', promise: '承诺', detail: '道具细节', scene: '名场面', relation: '关系' };

/**
 * 结算后应用提取的记忆（幂等：同章删旧重提——正文修订重结算时不堆积）。
 * settle 指令让结算模型顺带输出 memory_entries（零新增 LLM 调用）。
 * @param {Array<{category:string,name?:string,content:string}>} entries
 * @returns {number} 落库条数
 */
export function applySettlementMemories(bookId, chapterId, chapterIdx, entries) {
  if (!Array.isArray(entries)) return 0;
  store.memoryEntries.removeByChapter(bookId, chapterIdx);
  let saved = 0;
  for (const e of entries.slice(0, 8)) {
    const category = MEMORY_CATEGORIES.has(e?.category) ? e.category : null;
    const content = sanitizeStoryMemoryText(e?.content || '').trim();
    if (!category || !content || content.length < 4) continue;
    store.memoryEntries.create(bookId, { category, name: e.name || '', content: content.slice(0, 80), chapter: chapterIdx });
    saved++;
    if (saved >= 6) break; // 每章 ≤6 条（防单章刷爆预算）
  }
  // 预算裁剪（本地降级：宁可丢最老记忆，不做 LLM 裁剪——LLM 裁剪属优化非必需）
  if (store.memoryEntries.count(bookId) > MEMORY_BUDGET) {
    store.memoryEntries.pruneToBudget(bookId, MEMORY_BUDGET);
  }
  return saved;
}

/**
 * 写作注入文本（纯函数式读取；voice 优先 + 场景相关 + 最近兜底，总量限流）。
 * @param {object} opts { sceneText: 场景节拍/地点/POV 拼接文本, characterNames: 出场角色名 }
 */
export function narrativeMemoryText(bookId, { sceneText = '', characterNames = [] } = {}) {
  const all = store.memoryEntries.list(bookId)
    .map(row => ({ ...row, content: sanitizeStoryMemoryText(row.content).trim() }))
    .filter(row => row.content);
  if (!all.length) return '';
  const scene = String(sceneText || '');
  const names = new Set((characterNames || []).filter(Boolean));
  const picked = [];
  const seen = new Set();
  const push = m => {
    const key = `${m.category}|${m.content}`;
    if (seen.has(key)) return;
    seen.add(key);
    picked.push(m);
  };
  // ① 出场角色的 voice（人物声音一致性——每人最新 2 条）
  const voiceByName = new Map();
  for (const m of all.filter(x => x.category === 'voice')) {
    if (!m.name) continue;
    if (!voiceByName.has(m.name)) voiceByName.set(m.name, []);
    if (voiceByName.get(m.name).length < 2) { push(m); voiceByName.get(m.name).push(m); }
  }
  // ② 场景文本直接提及的记忆（detail/scene/promise/relation 的 name 或 content 命中）
  for (const m of all) {
    if (picked.length >= 10) break;
    if (m.category === 'voice') continue;
    const hit = (m.name && scene.includes(m.name))
      || (names.has(m.name))
      || (m.category === 'relation' && m.name && names.has(m.name));
    if (hit) push(m);
  }
  // ③ 最近记忆兜底：仅当①②命中过少时补足（保证写作上下文不至于零记忆），
  // 且只补最近 4 条——无关记忆全量注入会稀释注意力并鼓励复述
  if (picked.length < 4) {
    for (const m of all) {
      if (picked.length >= 4) break;
      push(m);
    }
  }
  if (!picked.length) return '';
  const lines = picked.slice(0, 12).map(m =>
    `- [${CATEGORY_LABEL[m.category] || m.category}]${m.name ? `${m.name}：` : ''}${m.content}（第${m.chapter}章）`);
  return `【叙事记忆】（前文沉淀的质感细节——人物怎么说话/信物细节/已立承诺，写作时保持一致，不重复原句）\n${lines.join('\n')}`;
}
