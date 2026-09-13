// V0.93.7 写审同源闭环：①破折号≤20 升 medium（ch21=29/ch22=26 超限曾放行）；
// ②段落≤200 升 medium；③套话词阈值对齐指令红线（同词≥3 次 medium，注入词表并入检测词表）；
// ④角色 last=null 台账补平（AI 补全建卡不写锚点，实测贾似道 first=17 last=null）
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v129-write-audit-'));
const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const rules = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/rules.js')));
const pleasure = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/pleasure.js')));

describe('V0.93.7 写审同源闭环', () => {
  test('破折号超限升 medium：>20 触发审校 verdict（此前 low 不参与）', () => {
    const text = Array.from({ length: 24 }, () => '他顿了顿——又补了一句。').join('\n');
    const issues = rules.detectDashDensity(text);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, 'medium', '破折号>20 应为 medium（写审同源，参与 verdict 强制修订）');
    assert.ok(issues[0].issue.includes('24'), '问题描述应含实际数量');
    assert.equal(rules.detectDashDensity('他顿了顿——又补了一句。').length, 0, '≤20 不报');
  });

  test('段落超限升 medium：>200 字触发修订（此前 low）', () => {
    const longPara = '甲'.repeat(250);
    const issues = rules.detectLongParagraphs(longPara);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].severity, 'medium', '段落>200 应为 medium');
    assert.equal(rules.detectLongParagraphs('甲'.repeat(150)).length, 0, '≤200 不报');
  });

  test('套话词阈值对齐指令红线：同词 ≥3 次 medium、注入词表并入检测', () => {
    // ≥3 次 → medium（指令第 11 条：同词每章 ≤2 次，3 次破线）
    const three = '他目光落在案上，目光落在窗外，目光落在门外。';
    const m = rules.detectClichés(three);
    const hit = m.find(i => i.issue.includes('目光落在'));
    assert.ok(hit, '应检出目光落在');
    assert.equal(hit.severity, 'medium', '同词 3 次应 medium（此前 ≥4 才 medium，3 次破线漏网）');
    // 2 次 → low（轻微提示，不强制修订）
    const two = '他目光落在案上，又目光落在窗外。';
    const low = rules.detectClichés(two).find(i => i.issue.includes('目光落在'));
    assert.ok(low && low.severity === 'low', '同词 2 次应为 low');
    // V0.93.4 注入词表补词可检测（目光扫过/目光移向——此前只注入不检测）
    const scan = '他目光扫过案头，目光扫过窗棂，目光扫过门缝。';
    const s = rules.detectClichés(scan);
    assert.ok(s.some(i => i.issue.includes('目光扫过') && i.severity === 'medium'), '注入词表目光扫过应可检测且 3 次 medium');
  });

  test('角色 last=null 台账补平：出现即设 last，无再出现由 normalizeCharacterAnchors 补平 first', () => {
    const book = store.books.create({ title: '锚点补平测试', genre: '历史' });
    // AI 补全建卡路径：first 有值、last 为 null
    store.characters.create(book.id, { name: '贾待补', tier: 'major', firstChapter: 17 });
    const c0 = store.characters.list(book.id).find(x => x.name === '贾待补');
    assert.equal(c0.first_chapter, 17);
    assert.equal(c0.last_chapter, null, '前置：last 为 null');
    // 正文再次出现 → touchCharacters 直接推进
    const touched = pleasure.touchCharacters(book.id, '贾待补掀开帐帘走了进去。', 25);
    assert.deepEqual(touched, ['贾待补']);
    assert.equal(store.characters.list(book.id).find(x => x.name === '贾待补').last_chapter, 25);
    // 从未再出现：last=null → normalizeCharacterAnchors 补平 last=first（只增不覆盖）
    store.characters.create(book.id, { name: '从未再现', tier: 'extra', firstChapter: 9 });
    const fixed = pleasure.normalizeCharacterAnchors(book.id);
    assert.ok(fixed.includes('从未再现'), 'last=null 角色应被补平');
    assert.equal(store.characters.list(book.id).find(x => x.name === '从未再现').last_chapter, 9, '补平为 first_chapter');
    assert.ok(!fixed.includes('贾待补'), '已有 last 的不动');
  });
});
