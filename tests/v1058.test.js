// V0.105.8 金句跨章短语复读检测：整句级 detectCrossChapterRepeats 按句切分+长度闸，
// 抓不到嵌在变体长句里的名台词——实测三方审读实证：「墙修得再高，也挡不住人心的裂缝」
// ch49/51/52 ×4、「只要墙不倒，死人就是数字」×4、「你的心是石头做的吗」×3 全部漏检。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1058-golden-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const rules = await import(pathToFileURL(path.join(ROOT, 'server/engine/rules.js')));

const GOLDEN = '墙修得再高，也挡不住人心的裂缝'; // 15 字

describe('V0.105.8 金句跨章短语复读', () => {
  test('①事故复现：变体长句里嵌金句，整句检测漏、短语检测抓到', () => {
    const prev = [
 { idx: 49, text: `权臣掀帘而去。${GOLDEN}。主角没有回头。` },
      { idx: 51, text: `他写下名字，${GOLDEN}。今日你以势压人，明日便有人以势反噬。` },
    ];
    const cur = '王坚闭上眼：「你修的墙，挡得住鞑子，挡不住自己人。」这话与那夜如出一辙——墙修得再高也挡不住人心的裂缝，他比谁都清楚。';
    // 整句检测：本章没有与原文逐字相同的完整句（句子被改写嵌入）→ 不报
    const sentenceHits = rules.detectCrossChapterRepeats(cur, prev);
    assert.ok(!sentenceHits.some(i => i.quote.includes('墙修得再高')), '整句检测应漏检变体嵌入（复现漏检前提）');
    // 短语检测：10 字滑窗应命中
    const hits = rules.detectGoldenPhraseRepeats(cur, prev);
    assert.equal(hits.length, 1, `金句复读应报一条（实际 ${JSON.stringify(hits.map(h => h.issue))}）`);
    assert.ok(hits[0].quote.includes('墙修得再高') || hits[0].quote.includes('挡不住人心的裂缝'), 'quote 应含金句本体');
    assert.match(hits[0].issue, /第49\/51章/);
    assert.equal(hits[0].severity, 'medium');
    assert.equal(hits[0].proseFix, true, '应标 proseFix（措辞问题走修订不走重规划）');
  });

  test('②防误报：单章出现不报；通用短词组不报', () => {
    const single = [{ idx: 49, text: `他说：${GOLDEN}。` }];
    assert.deepEqual(rules.detectGoldenPhraseRepeats(`本章重复了：${GOLDEN}。但只出现过一次。`, single), [], '仅 1 个前文章命中不构成复读');
    // 通用称呼/短词组（<10 字）不在检测范围
 assert.deepEqual(rules.detectGoldenPhraseRepeats('主角喊了声大人。对方也是大人。', [{ idx: 1, text: '大人' }, { idx: 2, text: '大人' }]), [], '通用词组不报');
  });

  test('③正常写作不受影响：无重复的章零命中', () => {
    const prev = [
      { idx: 49, text: '权臣走了，带着他的弹章与铜钱，消失在雾里。' },
 { idx: 50, text: '西谷地的雪很深，踩下去没过脚踝，主角拄着铁锹喘气。' },
    ];
    assert.deepEqual(rules.detectGoldenPhraseRepeats('渠江口的急报在掌心被攥出了褶皱，火漆的碎屑混着汗渍往下掉。', prev), [], '无复读零命中');
  });

  test('④源码断言：audit 接线 + redlines 阈值单源', () => {
    const audit = fs.readFileSync(path.join(ROOT, 'server/engine/audit.js'), 'utf8');
    assert.ok(audit.includes('detectGoldenPhraseRepeats(chapterText'), 'audit 应接入金句检测');
    const red = fs.readFileSync(path.join(ROOT, 'server/data/redlines.js'), 'utf8');
    assert.match(red, /goldenPhraseMinChars: 10/, '阈值应进 redlines 单一真源');
    assert.match(red, /goldenPhraseWindow: 8/, '窗口应进 redlines 单一真源');
  });
});
