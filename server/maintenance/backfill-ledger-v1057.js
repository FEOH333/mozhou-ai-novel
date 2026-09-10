// V0.105.7 台账联动回填：存量一致性清偿——①角色补登记（正文在场却零登记的群众角色）
// ②死亡状态回填（exit_note 写明死亡、deceased 仍为 0 的自相矛盾行）③核心伏笔补种
// ④地点补登记（正文高频出现但只有碎片变体、无本体行）⑤章首年号戳与章纲 era_year 对齐。
// 默认 dry-run；--apply 才写；备份 + 事务 + 幂等（只增不覆盖既有值）；--apply 需 8770 已停。
// 用法：
//   node server/maintenance/backfill-ledger-v1057.js --db data/novel.db            # 只读扫描
//   node server/maintenance/backfill-ledger-v1057.js --db data/novel.db --apply    # 落库
// 事实清单通过 --facts <facts.json> 传入（不传则用下方内置的通用示例骨架）：
//   {
//     "bookId": "bk-...",
//     "chars":      [{ "name": "...", "first": 46, "last": 51, "exitNote": "..." }],
//     "deaths":     [{ "name": "...", "death": 35, "exitNote": "..." }],
//     "foreshadows":[ { "desc": "...", "planted": 49, "payoff": 57, "type": "物证" }],
//     "locs":       [{ "name": "...", "first": 1, "note": "..." }],
//     "rename":     { "from": "误名", "to": "正名", "first": 41, "last": 41, "exitNote": "..." },
//     "anchor":     { "chapter": 52, "from": "开庆元年", "to": "景定五年" }
//   }
'use strict';
import fs from 'node:fs';
import * as store from '../db/store.js';
import { applyValidatedSceneRewrite } from '../engine/polish.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const readFlag = name => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const FACTS_FILE = readFlag('--facts');
const BOOK_ID = readFlag('--book') || (FACTS_FILE ? null : process.env.NOVEL_BOOK_ID || null);

if (!BOOK_ID) {
  console.error('缺少目标书：请传 --book <bookId>，或 --facts <facts.json>（内含 bookId）。');
  process.exit(1);
}

/** 无 --facts 时的空骨架：不硬编码任何具体作品取值，只演示结构。 */
const EMPTY_FACTS = { bookId: BOOK_ID, chars: [], deaths: [], foreshadows: [], locs: [], rename: null, anchor: null };

function loadFacts() {
  if (!FACTS_FILE) return EMPTY_FACTS;
  const raw = JSON.parse(fs.readFileSync(FACTS_FILE, 'utf8'));
  return {
    bookId: raw.bookId || BOOK_ID,
    chars: Array.isArray(raw.chars) ? raw.chars : [],
    deaths: Array.isArray(raw.deaths) ? raw.deaths : [],
    foreshadows: Array.isArray(raw.foreshadows) ? raw.foreshadows : [],
    locs: Array.isArray(raw.locs) ? raw.locs : [],
    rename: raw.rename || null,
    anchor: raw.anchor || null,
  };
}

/** 章节首句年号戳修复计划（纯函数，便于测试）。 */
export function planAnchorFix(chapters, scenesByChapter, anchor) {
  if (!anchor || !anchor.chapter) return { changed: false, note: '未指定年号戳修复目标' };
  const ch = chapters.find(c => c.idx === Number(anchor.chapter));
  if (!ch) return { changed: false, note: `ch${anchor.chapter} 不存在` };
  const scenes = (scenesByChapter(ch.id) || []).slice().sort((a, b) => a.idx - b.idx);
  if (!scenes.length) return { changed: false, note: `ch${anchor.chapter} 无场景` };
  const s1 = scenes[0];
  const content = String(s1.content || '');
  if (!content.startsWith(anchor.from)) {
    return { changed: false, note: `ch${anchor.chapter} 首句无「${anchor.from}」戳（可能已修复）` };
  }
  return {
    changed: true,
    scene: s1,
    next: content.replace(anchor.from, anchor.to),
    note: `ch${anchor.chapter} 首句年号「${anchor.from}」→「${anchor.to}」`,
  };
}

const facts = loadFacts();
const book = store.books.get(facts.bookId);
if (!book) throw new Error(`找不到目标书 ${facts.bookId}`);
const charRows = store.characters.list(facts.bookId);
const existing = new Set(charRows.map(c => c.name));
const locNames = new Set(store.locations.list(facts.bookId).map(l => l.name));
const fsDescs = store.foreshadows.list(facts.bookId).map(f => f.desc);

const plan = {
  chars: [], deaths: [], foreshadows: [], locs: [],
  chAnchor: planAnchorFix(store.chapters.list(facts.bookId), id => store.scenes.list(id), facts.anchor),
};

const renamePlan = facts.rename
  ? (() => {
      const row = charRows.find(c => c.name === facts.rename.from);
      return { id: row ? row.id : null, from: facts.rename.from, to: facts.rename.to, spec: facts.rename };
    })()
  : null;
plan.rename = renamePlan;

for (const c of facts.chars) if (!existing.has(c.name)) plan.chars.push(c);
for (const d of facts.deaths) {
  const row = charRows.find(x => x.name === d.name);
  if (row && !row.deceased) plan.deaths.push({ ...d, id: row.id });
}
for (const f of facts.foreshadows) {
  if (!fsDescs.some(d => d.includes(String(f.desc).slice(0, 5)))) plan.foreshadows.push(f);
}
for (const l of facts.locs) if (!locNames.has(l.name)) plan.locs.push(l);

console.log(`模式：${APPLY ? 'APPLY' : 'DRY-RUN'}`);
console.log(`目标书：${facts.bookId}（${book.title || ''}）`);
console.log(`角色补登记 ${plan.chars.length}：${plan.chars.map(c => c.name).join('、') || '无'}`);
console.log(`死亡回填 ${plan.deaths.length}：${plan.deaths.map(d => `${d.name}(ch${d.death})`).join('、') || '无'}`);
console.log(`伏笔补种 ${plan.foreshadows.length}：${plan.foreshadows.map(f => String(f.desc).slice(0, 8)).join('、') || '无'}`);
console.log(`地点补登记 ${plan.locs.length}：${plan.locs.map(l => l.name).join('、') || '无'}`);
console.log(`改名：${plan.rename ? `${plan.rename.from} → ${plan.rename.to}${plan.rename.id ? '' : '（库内无此行，将新建）'}` : '无'}`);
console.log(`年号戳：${plan.chAnchor.note}`);
if (!APPLY) {
  console.log('\n未加 --apply，只读扫描结束。停止 8770 后加 --apply（备份 + 事务 + 幂等只增）。');
  process.exit(0);
}
async function serverRunning() {
  try {
    const res = await fetch('http://127.0.0.1:8770/api/health', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

if (await serverRunning()) {
  console.error('拒绝执行：8770 运行中（WAL 竞态红线）。先停止 start.bat。');
  process.exit(1);
}

await store.backup({ prefix: 'pre_v1057_ledger_' });
store.transaction(() => {
  for (const c of plan.chars) {
    const row = store.characters.create(facts.bookId, { name: c.name, firstChapter: c.first });
    store.characters.update(row.id, { lastChapter: c.last, tier: 'minor', exitNote: c.exitNote });
  }
  const rp = plan.rename;
  if (rp) {
    if (rp.id) {
      store.characters.update(rp.id, { name: rp.to });
      store.characters.update(rp.id, {
        firstChapter: rp.spec.first ?? null, lastChapter: rp.spec.last ?? null,
        deceased: 1, deathChapter: rp.spec.last ?? null, exitNote: rp.spec.exitNote || '',
      });
    } else {
      const row = store.characters.create(facts.bookId, { name: rp.to, firstChapter: rp.spec.first ?? null });
      store.characters.update(row.id, {
        lastChapter: rp.spec.last ?? null, tier: 'minor',
        deceased: 1, deathChapter: rp.spec.last ?? null, exitNote: rp.spec.exitNote || '',
      });
    }
  }
  for (const d of plan.deaths) store.characters.update(d.id, { deceased: 1, deathChapter: d.death, exitNote: d.exitNote });
  for (const f of plan.foreshadows) {
    store.foreshadows.create(facts.bookId, {
      desc: f.desc, type: f.type, plantedChapter: f.planted, payoffChapter: f.payoff, status: 'planted',
    });
  }
  for (const l of plan.locs) {
    const row = store.locations.create(facts.bookId, { name: l.name, firstChapter: l.first, lastChapter: l.first });
    store.locations.update(row.id, { note: l.note });
  }
});
console.log('台账回填完成。');

if (plan.chAnchor.changed) {
  const applied = applyValidatedSceneRewrite(facts.bookId, plan.chAnchor.scene.id, plan.chAnchor.next, { preserveExistingLength: true });
  console.log(applied.ok ? `年号戳已修：${plan.chAnchor.note}` : `年号戳修复被闸拒绝：${applied.code} ${applied.message}`);
}

// 幂等复验
const re = new Set(store.characters.list(facts.bookId).map(c => c.name));
const missChars = facts.chars.filter(c => !re.has(c.name)).map(c => c.name);
if (plan.rename && !re.has(plan.rename.to)) missChars.push(plan.rename.to);
const reFs = store.foreshadows.list(facts.bookId).map(f => f.desc).join('');
const missFs = facts.foreshadows.filter(f => !reFs.includes(String(f.desc).slice(0, 5))).length;
if (missChars.length || missFs) { console.error(`复验失败：角色缺 ${missChars.join('、')}；伏笔缺 ${missFs}`); process.exit(1); }
console.log('复验通过（幂等）。');
