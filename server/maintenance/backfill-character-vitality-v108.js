// V0.108 人物活性存量回填：为存量角色卡补 backstory/motive_root/web
// 与对手型角色三件（rival/agenda/no_retreat/stance）。幂等只填空不覆盖已有键；不动正文。
// 默认只读扫描（列出缺失计划）；应用：加 --apply。目标书必传 --book <bookId>，
// 或用 NOVEL_BOOK_ID 环境变量；不硬编码任何具体作品 id。
// 用法：node server/maintenance/backfill-character-vitality-v108.js --book bk-xxx [--apply]
'use strict';

import * as store from '../db/store.js';
import { runTask } from '../llm/router.js';
import { extractJSON } from '../util/json.js';

const bookArgIdx = process.argv.indexOf('--book');
const BOOK_ID = (bookArgIdx >= 0 ? process.argv[bookArgIdx + 1] : null) || process.env.NOVEL_BOOK_ID || null;
if (!BOOK_ID) {
  console.error('缺少目标书：请传 --book <bookId>，或设置 NOVEL_BOOK_ID。');
  process.exit(1);
}
const APPLY = process.argv.includes('--apply');
// 已退场角色不再出场，注入无意义——跳过
const RIVAL_HINT = /对手|反派|敌|权奸|佞|逆|争|政敌|构陷|构陷|降元|主和|议和派|构祸/i;

const book = store.books.get(BOOK_ID);
if (!book) throw new Error(`找不到目标书 ${BOOK_ID}`);

// 只补"还会出场且有档案实质"的角色：protagonist/major 全补；minor 仅补有目标设定的（龙套
// （父亲/抬桶男孩/斗笠汉子式泛名与无档案角色）不会再承担剧情，补活性键只会污染指令）。
const chars = store.characters.list(BOOK_ID)
  .filter(c => !c.deceased)
  .filter(c => {
    const tier = String(c.tier || 'minor');
    if (tier === 'protagonist' || tier === 'major') return true;
    return tier === 'minor' && String(c.goal || '').trim().length >= 4 && String(c.personality || '').trim().length >= 4;
  });
const readCard = c => { try { return JSON.parse(c.card_json || '{}') || {}; } catch { return {}; } };

// —— 缺失扫描（幂等：已有键不再生成） ——
const plan = [];
for (const c of chars) {
  const card = readCard(c);
  const rival = card.rival === true
    || (String(c.tier) === 'major' && RIVAL_HINT.test(`${card.role || ''} ${c.goal || ''} ${c.relation || ''}`));
  const missing = [];
  if (!card.backstory) missing.push('backstory');
  if (!card.motive_root) missing.push('motive_root');
  if (!card.web) missing.push('web');
  if (rival) {
    if (card.rival !== true) missing.push('rival');
    if (!card.agenda) missing.push('agenda');
    if (!card.no_retreat) missing.push('no_retreat');
    if (!card.stance) missing.push('stance');
  }
  if (missing.length) plan.push({ id: c.id, name: c.name, missing, rival, row: c, card });
}

console.log(`未退场角色 ${chars.length} 人，其中 ${plan.length} 人缺人物活性键：`);
for (const p of plan) {
  console.log(`  ${p.name}（${p.rival ? '对手型' : '常规'}）缺：${p.missing.join(', ')}`);
}
if (!plan.length) {
  console.log('无需回填（全部齐全或无角色）。');
  process.exit(0);
}
if (!APPLY) {
  console.log('\n未加 --apply，只读扫描结束。确认后加 --apply（自动备份 + 事务 + 幂等只填空）。');
  process.exit(0);
}

// —— 生成（一次批量 LLM 调用；cast_design 任务路由） ——
const contract = (store.materials.get(BOOK_ID, 'contract')?.content || '').slice(0, 800);
const volumes = store.volumes.list(BOOK_ID).sort((a, b) => a.idx - b.idx)
  .map(v => `第${v.idx}卷《${v.title}》：${v.goal || ''}`.slice(0, 90)).join('\n');
const rosterText = plan.map(p => {
  const c = p.row;
  const card = p.card;
  return `- ${c.name}｜身份:${card.role || '?'}｜性格:${(c.personality || '').slice(0, 40)}｜目标:${(c.goal || '').slice(0, 40)}｜软肋:${(c.fear || '').slice(0, 30)}｜秘密:${(c.secret || '').slice(0, 30)}｜关系:${(c.relation || '').slice(0, 40)}${p.rival ? '｜【对手型】' : ''}`;
}).join('\n');

const instruction = `你是资深网文角色设计师。为《${book.title}》的以下角色补全"人物活性"档案——基于既有设定推断，不得与已有性格/目标/秘密矛盾；历史题材须符合该时代人物处境与观念。

【书契约（节选）】${contract || '（无）'}
【分卷脉络】
${volumes}

【待补全角色】
${rosterText}

请为每个角色输出（只输出其缺失的字段，已有字段不要重复输出）：
- backstory：关键经历（解释其性格/立场成因的 1-2 个事件，40-60 字，与已写正文相容）
- motive_root：底层动因（他为什么非要这个不可，30 字内——恐惧/亏欠/执念/身份所系）
- web：与主角之外的另一角色的关系线一条（20-40 字，如"欠某人一条命/与某人旧识"，须是名单内角色或已登场人物）
- 【对手型角色必填】rival: true（固定）；agenda：独立目标（他为自己要什么——保位/复仇/护住某人/压过某人，禁止"阻止主角"式依附目标）；no_retreat：退不了的理由（一旦停手会失去什么）；stance：他认为自己对在哪（局部正确，让读者"不认同但理解"）

请输出 JSON 数组（不要 JSON 以外的任何内容）：
[{"name": "角色名", "backstory": "…", "motive_root": "…", "web": "…", "agenda": "…", "no_retreat": "…", "stance": "…"}]`;

const res = await runTask({
  task: 'cast_design', bookId: BOOK_ID,
  messages: [{ role: 'user', content: instruction }],
});
const fills = extractJSON(res.content);
if (!Array.isArray(fills) || !fills.length) throw new Error('回填生成失败：模型输出不是 JSON 数组');

// —— 应用（备份 + 事务 + 只填空） ——
await store.backup({ prefix: 'pre_vitality_backfill_' });
const FILLABLE = ['backstory', 'motive_root', 'web', 'agenda', 'no_retreat', 'stance'];
let applied = 0;
store.transaction(() => {
  for (const f of fills) {
    const name = String(f?.name || '').trim();
    const p = plan.find(x => x.name === name);
    if (!p) continue; // 模型输出的名单外角色，忽略
    const nextCard = { ...p.card };
    let changed = false;
    for (const key of FILLABLE) {
      const value = String(f[key] || '').trim();
      if (value && !nextCard[key]) { nextCard[key] = value.slice(0, 80); changed = true; }
    }
    if (p.rival && nextCard.rival !== true) { nextCard.rival = true; changed = true; }
    if (changed) {
      store.characters.update(p.id, { card: nextCard });
      applied++;
    }
  }
});
console.log(`已应用：${applied}/${plan.length} 人补全人物活性键（幂等可重跑；已有键未覆盖）。`);
const remaining = plan.filter(p => {
  const card = readCard(store.characters.get(p.id));
  return p.missing.some(k => k === 'rival' ? card.rival !== true : !card[k]);
});
if (remaining.length) console.log(`注意：${remaining.length} 人仍有缺键（模型未输出或内容为空），可重跑本脚本补齐：${remaining.map(r => r.name).join('、')}`);
