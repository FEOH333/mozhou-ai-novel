// V0.100.16 场景分段修复：返工落盘事故（绕过引擎的脚本把整章候选剥掉换行按场景写入，
// 12 章每场景 800-1350 字零换行）。候选存档（recommendation_recovery_runs.result_json
// 的 candidates[].after）保留着原始 \n\n 分段——本脚本从候选逐字找回被剥离的换行，
// 并同步 history 历史堆换版（防无换行版从缓存上下文复活）。
// 默认 dry-run，--apply 才写；备份 + 单事务 + 幂等跳过 + --verify 独立复验。
// 用法：node server/maintenance/repair-scene-paragraphs-v10016.js --run <runId> [--apply|--verify]
'use strict';
import * as store from '../db/store.js';
import { restoreSceneParagraphBreaks } from '../engine/polish.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERIFY = args.includes('--verify');
const runIdArg = (args.find((a) => a.startsWith('--run=')) || '').split('=')[1];

function loadRun() {
  const runId = runIdArg;
  if (!runId) throw new Error('缺少 --run=<runId>（候选存档所在返工运行）');
  const run = store.db().prepare('SELECT id, book_id, result_json FROM recommendation_recovery_runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`返工运行不存在：${runId}`);
  const result = JSON.parse(run.result_json || '{}');
  const candidates = (result.candidates || []).filter((c) => c && c.after);
  return { run, candidates };
}

function buildPlan(run, candidates) {
  const chapters = store.chapters.list(run.book_id);
  const plan = [];
  const skipped = [];
  for (const cand of candidates) {
    const chapter = chapters.find((c) => c.idx === cand.chapter);
    if (!chapter) throw new Error(`候选章 ${cand.chapter} 不在库内`);
    const scenes = store.scenes.list(chapter.id).slice().sort((a, b) => a.idx - b.idx);
    if (!scenes.length) throw new Error(`ch${chapter.idx} 无场景`);
    const currentContents = scenes.map((s) => String(s.content || ''));
    const restored = restoreSceneParagraphBreaks(cand.after, currentContents);
    if (!restored) {
      // 定位失败 = 该章当前正文不是这个候选的产物（候选未落盘，正文仍是旧稿）。
      // 跳过并报告；只有"正文确实来自候选却定位失败"才是需要人工介入的异常。
      const currentFlat = currentContents.join('').replace(/[\r\n]+/g, '');
      const candFlat = String(cand.after).replace(/[\r\n]+/g, '');
      skipped.push({
        idx: chapter.idx,
        matchesCandidate: currentFlat === candFlat,
        note: currentFlat === candFlat ? '整章剥换行一致但场景切分定位失败（需人工核对）' : '正文非该候选产物（候选未落盘，保持旧稿）',
      });
      continue;
    }
    const changed = restored.some((piece, i) => piece !== currentContents[i]);
    plan.push({ chapter, scenes, restored, currentContents, changed });
  }
  return { plan, skipped };
}

const { run, candidates } = loadRun();
const book = store.books.get(run.book_id);
console.log(`目标书：${book?.title}（${run.book_id}）；候选 ${candidates.length} 章；模式：${APPLY ? 'APPLY' : VERIFY ? 'VERIFY' : 'DRY-RUN'}`);

const { plan, skipped } = buildPlan(run, candidates);
for (const s of skipped) {
  if (s.matchesCandidate) throw new Error(`ch${s.idx} ${s.note}`);
  console.log(`  ch${s.idx} 跳过：${s.note}`);
}
const todo = plan.filter((p) => p.changed);
console.log(`扫描完成：${plan.length} 章可恢复，待写 ${todo.length} 章${todo.length ? '：' : ''}`);
for (const p of todo) {
  const beforeParas = p.currentContents.map((c) => c.split(/\n+/).filter(Boolean).length).join('/');
  const afterParas = p.restored.map((c) => c.split(/\n+/).filter(Boolean).length).join('/');
  console.log(`  ch${p.chapter.idx}《${p.chapter.title}》 段落 ${beforeParas} → ${afterParas}`);
}

if (!APPLY && !VERIFY) {
  console.log('\n未加 --apply，只读扫描结束。确认后加 --apply（自动备份 + 单事务 + history 同步换版 + 幂等复验）；--verify 只复验不写。');
  process.exit(0);
}

if (APPLY && todo.length) {
  await store.backup({ prefix: 'pre_v10016_paragraphs_' });
  store.transaction(() => {
    for (const p of todo) {
      for (let i = 0; i < p.scenes.length; i++) {
        const scene = p.scenes[i];
        const next = p.restored[i] || '';
        if (!next) throw new Error(`ch${p.chapter.idx} 场景${scene.idx} 恢复块为空`);
        if (String(scene.content || '') === next) continue; // 幂等：已恢复跳过
        // 保真断言：只能加换行，不得改动任何字符
        if (next.replace(/[\r\n]+/g, '') !== String(scene.content || '').replace(/[\r\n]+/g, '')) {
          throw new Error(`ch${p.chapter.idx} 场景${scene.idx} 恢复结果与现文剥换行后不一致，中止`);
        }
        store.scenes.update(scene.id, { content: next });
        if (scene.history_seq) {
          const replaced = store.history.replace(run.book_id, scene.history_seq, 'assistant', next);
          if (replaced <= 0) throw new Error(`ch${p.chapter.idx} 场景${scene.idx} 历史堆换版失败（seq ${scene.history_seq}）`);
        }
      }
    }
  });
  console.log(`已写入 ${todo.length} 章（scenes.content + history 同步换版）。`);
}

// 复验：逐场景有换行、剥换行与候选逐字一致、history 与场景一致
const problems = [];
const verifyLoaded = loadRun();
const { plan: verifyPlan } = buildPlan(verifyLoaded.run, verifyLoaded.candidates);
for (const p of verifyPlan) {
  const scenes = store.scenes.list(p.chapter.id).slice().sort((a, b) => a.idx - b.idx);
  for (let i = 0; i < scenes.length; i++) {
    const content = String(scenes[i].content || '');
    if (content.length > 300 && !/[\r\n]/.test(content)) problems.push(`ch${p.chapter.idx} 场景${scenes[i].idx} 仍是超长零换行`);
    if (content.replace(/[\r\n]+/g, '') !== p.restored[i].replace(/[\r\n]+/g, '')) problems.push(`ch${p.chapter.idx} 场景${scenes[i].idx} 正文与候选剥换行不一致`);
    if (scenes[i].history_seq) {
      const row = store.db().prepare('SELECT content FROM history WHERE book_id=? AND seq=?').get(run.book_id, scenes[i].history_seq);
      if (!row || String(row.content || '').trim() !== content.trim()) problems.push(`ch${p.chapter.idx} 场景${scenes[i].idx} 历史堆与场景正文不一致`);
    }
  }
}
if (problems.length) {
  console.error(`[复验失败] ${problems.join('；')}`);
  process.exit(1);
}
console.log(`复验通过：${verifyPlan.length} 章场景分段已恢复，正文与候选存档逐字一致，历史堆同步（V0.100.16）。`);
