// V0.93.9 反攻延伸期（用户定调：12卷吹响反攻号角不和解，13-15卷完成反攻）：
// ①历史锚点扩展到 15 卷（1282-1294 忽必烈晚年窗口）；②normalize 不再强制压回 12 卷；
// ③planText 明确"12卷不是完结"；④书纲对齐注入十五卷总表
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v132-extend-'));
const ROOT = process.cwd();
const hl = await import(pathToFileURL(path.join(ROOT, 'server/engine/longform/historical_longform.js')));
const outline = await import(pathToFileURL(path.join(ROOT, 'server/engine/planning/outline.js')));
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));

const sample = { title: '示例历史长篇', genre: '历史', blurb: '淳祐元年蒙古铁骑再入蜀地，钓鱼城四十年' };

describe('V0.93.9 反攻延伸期（12卷节点 + 13-15卷反攻）', () => {
  test('历史锚点扩展到 15 卷：卷13-15 有公元年/年龄/生命周期', () => {
 const phases = hl.historicalLongformPhases(sample);
    assert.equal(phases.length, 15, '锚点应为 15 卷');
    assert.equal(phases[11].title, '四十年');
    assert.ok(phases[11].anchor.includes('反攻号角'), '卷12 定位为反攻号角（呼应简介金句），不是收尾');
    assert.equal(phases[12].startYear, 1282, '卷13 反攻延伸期起点');
    assert.equal(phases[13].startYear, 1286);
    assert.equal(phases[14].startYear, 1291);
    assert.equal(phases[14].endYear, 1294, '卷15 收在忽必烈崩逝窗口');
    assert.equal(phases[12].startAge, 50, '1282年主角50岁');
    assert.equal(phases[14].endAge, 62, '1294年主角62岁');
    assert.ok(phases[12].lifecycleStage === 'ending' && phases[14].lifecycleStage === 'finale', '13-14 ending、15 finale');
    // 历史帧对卷13+ 可用
 assert.ok(hl.historicalPhaseForVolume(sample, 13), '卷13 有历史帧');
 assert.ok(hl.historicalPhaseForVolume(sample, 15), '卷15 有历史帧');
  });

  test('书纲年代总表：12卷为四十年节点（反攻号角），可延伸13-15卷，不再锁死12卷', () => {
 const text = hl.historicalLongformPlanText(sample);
    assert.ok(text.includes('十五卷年代总表'), '总表应为十五卷');
    assert.ok(!text.includes('必须严格生成12卷'), '不再强制 12 卷');
    assert.ok(text.includes('吹响全面反攻号角') && text.includes('不是完结'), '明确 12 卷不是完结');
    assert.ok(text.includes('第13-15卷为反攻延伸期'), '延伸期条款存在');
    assert.ok(text.includes('禁止在12卷强行和解收尾'), '禁止强行和解');
  });

  test('normalize 不再把 13+ 卷压回 12 卷：模型输出 15 卷时保留延伸卷', () => {
    const generated = {
 title: '示例历史长篇',
      volumes: Array.from({ length: 15 }, (_, i) => ({
        idx: i + 1, title: `卷${i + 1}`, goal: `目标${i + 1}`, summary: `剧情${i + 1}`,
      })),
    };
 const norm = hl.normalizeHistoricalBookOutline(generated, sample);
    assert.equal(norm.volumes.length, 15, '15卷规划不得被压回12卷');
    assert.equal(norm.volumes[11].title, '四十年', '前12卷按锚点归一');
    assert.equal(norm.volumes[11].start_year, 1281);
    assert.equal(norm.volumes[12].title, '江淮反攻', '卷13 用锚点卷名（延伸期锚点存在）');
    assert.equal(norm.volumes[12].start_year, 1282);
    assert.equal(norm.volumes[12].goal, '目标13', '延伸卷保留模型输出 goal');
    assert.equal(norm.volumes[12].lifecycle_stage, 'ending', '延伸卷生命周期按锚点');
    assert.equal(norm.volumes[14].title, '北望无惧', '卷15 锚点卷名');
    // V0.97.2：专属年代合同明确为 15 卷，模型少给不能把终局再截回 12 卷。
 const gen12 = { title: '示例历史长篇', volumes: Array.from({ length: 12 }, (_, i) => ({ idx: i + 1, title: `卷${i + 1}` })) };
 const norm12 = hl.normalizeHistoricalBookOutline(gen12, sample);
    assert.equal(norm12.volumes.length, 15);
    assert.equal(norm12.volumes[14].title, '北望无惧');
  });

  test('结局闭环校验：12卷反攻号角+13-15反攻完成 → 通过（用户场景回归）', () => {
    const volumes = [
      { title: '守土期', goal: '守住南国', summary: '山城坚守' },
      { title: '北望山河', goal: '发起反攻', summary: '守势转入有限反攻，收复江淮方向' },
      { title: '四十年', goal: '吹响全面反攻号角', summary: '四十年节点，反攻号角吹响，呼应简介金句' },
      { title: '江淮反攻', goal: '光复江淮', summary: '反攻展开，收复江淮与临安方向' },
      { title: '中原回望', goal: '光复中原决战', summary: '决战中原，光复襄阳汴梁方向' },
      { title: '北望无惧', goal: '反攻完成与新秩序', summary: '草原收尾，南北新格局成立，誓言终兑现，圆满落幕' },
    ];
    const r = outline.endingClosureCheck(volumes);
    assert.equal(r.ok, true, '12卷号角+13-15反攻完成应通过: ' + r.issues.join('；'));
  });

  test('书纲对齐指令注入十五卷总表', () => {
 const plan = hl.historicalLongformPlanText(sample);
    const inst = prompts.bookOutlineRewriteInstruction({ bookTitle: 'T', contract: '', writtenVolumes: '', pendingVolumes: '', openForeshadows: [], totalVolumes: 12, historicalLongformText: plan });
    assert.ok(inst.includes('十五卷年代总表'), '对齐指令应含十五卷总表');
    assert.ok(inst.includes('结局倒推硬要求'), '对齐指令应含结局倒推纪律');
  });
});
