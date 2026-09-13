// V0.105.5 存量修复：场景末句被输出预算截断的半句话（doctor.proseStructure 报
// boundaryFragments；实测 ch45-50 实证「…回荡在合州」）。写侧已加
// closeTrailingSentence 三道闸（autoHealSceneLength 共用入口 + 两个落库闸），
// 本脚本只处理闸上线前已落库的存量：确定性裁到完整句边界，走
// applyValidatedSceneRewrite 正规场景闸（换版、指纹、冲突清理一条龙）。
// 默认 dry-run，--apply 才写；备份 + 事务 + 幂等复验 + 8770 运行检测（防竞态）。
// 用法：node server/maintenance/repair-scene-trailing-sentence-v1055.js [--book=<id>] [--apply|--verify]
'use strict';
import * as store from '../db/store.js';
import { closeTrailingSentence, applyValidatedSceneRewrite } from '../engine/quality/polish.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERIFY = args.includes('--verify');
const bookArg = (args.find((a) => a.startsWith('--book=')) || '').split('=')[1];

async function serverRunning() {
  try {
    const res = await fetch('http://127.0.0.1:8770/api/health', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

function scanBook(book) {
  const findings = [];
  for (const ch of store.chapters.list(book.id)) {
    for (const sc of store.scenes.list(ch.id)) {
      const content = String(sc.content || '');
      if (!content.trim()) continue;
      const closed = closeTrailingSentence(content);
      if (closed !== content.trimEnd() && closed.trim()) {
        findings.push({ book, ch, sc, content, closed, cut: content.trimEnd().length - closed.length });
      }
    }
  }
  return findings;
}

const books = bookArg ? [store.books.get(bookArg)].filter(Boolean) : store.books.list();
const running = await serverRunning();
console.log(`模式：${APPLY ? 'APPLY' : VERIFY ? 'VERIFY' : 'DRY-RUN'}；8770 服务：${running ? '运行中' : '已停止'}`);
if ((APPLY || VERIFY) && running) {
  console.error('拒绝执行：8770 服务运行中，写入会与写作作业竞态（WAL 覆盖红线）。请先停止 start.bat 再跑。');
  process.exit(1);
}

const all = [];
for (const b of books) all.push(...scanBook(b));
if (!all.length) {
  console.log('扫描完成：全部场景末句完整，无需修复。');
  process.exit(0);
}
for (const f of all) {
  console.log(`  《${f.book.title}》ch${f.ch.idx}《${f.ch.title}》场景${f.sc.idx}（${f.sc.status}）：裁掉截断残余 ${f.cut} 字 →「…${f.closed.slice(-18)}」`);
}

if (!APPLY && !VERIFY) {
  console.log(`\n未加 --apply，只读扫描结束（共 ${all.length} 处）。确认后停止 8770 再加 --apply（自动备份 + applyValidatedSceneRewrite 正规闸 + 幂等复验）。`);
  process.exit(0);
}

await store.backup({ prefix: 'pre_v1055_trailing_' });
let fixed = 0;
store.transaction(() => {
  for (const f of all) {
    const applied = applyValidatedSceneRewrite(f.book.id, f.sc.id, f.closed, { preserveExistingLength: true });
    if (!applied.ok) throw new Error(`ch${f.ch.idx} 场景${f.sc.idx} 修复被闸拒绝：${applied.code} ${applied.message}`);
    fixed++;
  }
});
console.log(`已修复 ${fixed} 处（applyValidatedSceneRewrite 场景闸）。`);

// 幂等复验：重扫必须归零
const remain = [];
for (const b of books) remain.push(...scanBook(b));
if (remain.length) {
  console.error(`复验失败：仍有 ${remain.length} 处末句截断。`);
  process.exit(1);
}
console.log('复验通过：全部场景末句完整（幂等）。');
