// V0.105.7 审读落地四件（实测 ch35-52 读者审读实证）：
// ①时代器物穿帮写侧/审侧双闸（ch52「辣椒油」实证：eraRedLineCheck 词表存在但只被
//   吸引力门软消费，写侧落库与审校本地扫描都不拦）。
// ②词表扩容：辣子（ch44/45「辣子」不含「辣椒」子串）、旱烟已有、眼镜/视网膜/肾上腺素/
//   病毒/感染率/小数点/白银计价/校尉（历史读者审读清单）。
// ③场景正文对细纲 beat 的词根覆盖检测（ch49 s4 beat「软禁偏院/病榻掰算筹」被写飞成
//   「第二次对峙+伪造捷报」，与 s3 拼成同一场戏两版）。
// ④章首年号锚点核验（ch52 首句「开庆元年」倒退四年而章纲为景定五年，全章再无纪年）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1057-era-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const historyEngine = await import(pathToFileURL(path.join(ROOT, 'server/engine/history.js')));
const guardrails = await import(pathToFileURL(path.join(ROOT, 'server/engine/historical_guardrails.js')));

describe('V0.105.7 时代器物双闸 + 词表扩容 + beat 覆盖 + 年号锚点', () => {
  test('①eraRedLineCheck 命中辣椒油/辣子/旱烟/眼镜/白银（词表完整性）', () => {
 const text = '面条撒上一层红亮的辣椒油。今儿个的辣子够劲。旱烟杆敲了敲掌心。热气模糊了主角的眼镜。折合白银五千两。';
    const terms = historyEngine.eraRedLineCheck(text).map(h => h.term);
    for (const t of ['辣椒', '辣子', '旱烟', '眼镜', '白银']) {
      assert.ok(terms.includes(t), `${t} 必须命中（实际 ${JSON.stringify(terms)}）`);
    }
  });

  test('②写侧定向重写：healEraAnachronism 命中后替换并复检归零', async () => {
    const { healEraAnachronism } = await import(pathToFileURL(path.join(ROOT, 'server/engine/write.js')));
    const b = store.books.create({ title: '辣椒书', genre: '历史', blurb: 'x' });
    const ch = store.chapters.create(b.id, null, 1, { title: 'C1', status: 'planned' });
 const r = await healEraAnachronism(b.id, ch.id, '张老实的面馆里，主角吃下一碗浇了辣椒油的面，又抽了口旱烟。'.repeat(3), {});
    assert.ok(r.healed, 'mock 修订文本不含穿帮词，应视为已愈');
    assert.ok(!historyEngine.eraRedLineCheck(r.content).length, '愈合后复检归零');
  });

  test('③审侧接线：eraRedLineCheck 与 sceneBeatCoverageIssues 均进 localIssues（源码断言）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/engine/audit.js'), 'utf8');
    assert.ok(src.includes('eraRedLineCheck(chapterText).map'), 'audit localIssues 应接入 eraRedLineCheck');
    assert.ok(src.includes('...sceneBeatCoverageIssues(store.scenes.list(chapterId))'), 'audit localIssues 应接入 beat 覆盖检测');
    const { isImmediateReplanIssue } = guardrails;
    assert.equal(isImmediateReplanIssue({ type: '史实错误', severity: 'high', proseFix: true, issue: 'x', fix: 'y' }), false, '词表 fix 明确的穿帮必须 proseFix 修订，不得清场');
  });

  test('④场景 beat 覆盖：正文完全偏离 beat 时报大纲偏离（proseFix），同义词根在场不误报', async () => {
    const audit = await import(pathToFileURL(path.join(ROOT, 'server/engine/audit.js')));
    const bad = audit.sceneBeatCoverageIssues([
 { idx: 4, beat: '权臣被软禁在府衙偏院。主角回到王坚病榻前，从他紧握的手中掰开一张算筹。', content: '权臣再次登门，与主角对峙良久，言辞交锋互不相让。主角决定伪造一份捷报，与文书吏连夜誊录文书，又筹划了一套完整的反制之策，逐条写进密档，天将破晓才吹熄烛火，各归其位。' },
    ]);
    assert.ok(bad.length >= 1, `beat 关键节拍零覆盖应报偏离（实际 ${JSON.stringify(bad)}）`);
    assert.equal(bad[0].proseFix, true, 'beat 偏离是正文可修，proseFix 路由');
    const ok = audit.sceneBeatCoverageIssues([
 { idx: 4, beat: '权臣被软禁在府衙偏院。主角回到王坚病榻前，从他紧握的手中掰开一张算筹。', content: '权臣被亲兵押进偏院软禁。主角回到病榻前，掰开王坚的手指，取出那枚刻痕算筹，久久无言。'.repeat(2) },
    ]);
    assert.equal(ok.length, 0, `同义词根在场（软禁/病榻/算筹）不应误报（实际 ${JSON.stringify(ok)}）`);
  });

  test('⑤章首年号锚点：开庆元年撞景定五章纲 → 高危时间线冲突（proseFix）；同年号/回忆豁免', () => {
    const bad = guardrails.eraAnchorIssues('开庆元年。\n\n北崖的风像钝刀子，刮得窗纸簌簌作响。', { era_year: '景定五年', year: 1264 });
    assert.equal(bad.length, 1, '年号倒退必须报');
    assert.equal(bad[0].type, '时间线冲突');
    assert.equal(bad[0].proseFix, true, '改一处年号措辞即可，proseFix');
    assert.equal(guardrails.eraAnchorIssues('景定五年的冬天格外长。北崖的风像钝刀子。', { era_year: '景定五年', year: 1264 }).length, 0, '同年号不报');
    assert.equal(guardrails.eraAnchorIssues('他想起开庆元年的那个雪夜，父亲还在。此后一切。', { era_year: '景定五年', year: 1264 }).length, 0, '回忆引语豁免');
  });
});
