import './helper.js';
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../server/db/store.js';
import { createSampleOpeningFixture } from './helpers/opening_fixture.js';
import {
  EMPTY_FACT_LOCKS, buildOpeningPlan, copySandboxModelConfig, parseOpeningArgs, validateOpeningFacts,
} from '../server/maintenance/plan-opening.js';

let fixture;
// 专属事实锁由调用方注入——框架本身不含任何具体作品的取值。
let locks;

beforeEach(() => {
  fixture = createSampleOpeningFixture(store);
  locks = {
    ...EMPTY_FACT_LOCKS,
    protagonist: '主角',
    opening_year: 1241,
    opening_age: 9,
    target_year: 1259,
    target_event_key: 'historical:1259:diaoyucheng-mongke-death',
    target_volume_idx: 5,
    genre_route: 'serious_immersive_history',
  };
});

test('开篇计划默认 dry-run，内嵌楔子进入第1章而不创建伪编号', () => {
  const before = store.snapshotBook(fixture.book.id);
  const result = buildOpeningPlan(fixture.book, { dryRun: true, locks });
  const after = store.snapshotBook(fixture.book.id);
  assert.equal(result.writes, 0);
  assert.deepEqual(after, before, 'dry-run 不得改变正文、设定或开篇资产');
  assert.deepEqual(result.candidates.map(item => item.kind),
    ['baseline', 'head_rewrite', 'chapter1_cold_open', 'composite_preview']);
  assert.equal(result.candidates.find(item => item.kind === 'chapter1_cold_open').placement, 'prepend_chapter1');
  assert.equal(JSON.stringify(result).includes('0.5章'), false);
  assert.equal(JSON.stringify(result).includes('第0章'), false);
  assert.equal(result.contract.target_volume_idx, 5);
  assert.equal(result.contract.target_volume_id, fixture.targetVolume.id);
  assert.equal(result.facts.protagonist, '主角');
  assert.equal(result.facts.opening_year, 1241);
  assert.equal(result.facts.opening_age, 9);
});

test('四个读者版本由候选正文自动合成，组合预览不伪造资产类型', () => {
  const original = store.chapters.fullText(fixture.chapter.id);
  const headText = original.replace('天边压着一线暗红。', '主角先把弟弟护到身后，再抬头看见天边压着一线暗红。');
  const coldContent = '开庆元年，钓鱼城头的风卷着砲石灰。主角先把身后百姓送下城墙。\n\n十八年前，淳祐元年的庙会仍在敲锣。';
  const result = buildOpeningPlan(fixture.book, {
    dryRun: true,
    locks,
    generatedCandidates: [
      { kind: 'head_rewrite', placement: 'scene_patch', reader_text: headText, content: headText,
        audit: { hard_failures: [], continue_question: '这个孩子能否护住弟弟？', chapter_one_independence: { ok: true } } },
      { kind: 'chapter1_cold_open', placement: 'prepend_chapter1', reader_text: `${coldContent}\n\n${original}`,
        content: coldContent, contract: { target_volume_id: fixture.targetVolume.id },
        audit: { hard_failures: [], continue_question: '他怎样从九岁孩子走到城头？', chapter_one_independence: { ok: true } } },
    ],
  });
  const head = result.candidates.find(item => item.kind === 'head_rewrite');
  const cold = result.candidates.find(item => item.kind === 'chapter1_cold_open');
  const composite = result.candidates.find(item => item.kind === 'composite_preview');
  assert.equal(head.reader_text, headText);
  assert.equal(cold.reader_text.startsWith(coldContent), true);
  assert.equal(composite.reader_text, `${coldContent}\n\n${headText}`);
  assert.equal(composite.persistable, false);
  assert.equal(result.assetKinds.includes('composite_preview'), false);
});

test('专属事实门拒绝错主角、错年份和错目标卷', () => {
  const facts = validateOpeningFacts(fixture.book, locks);
  assert.equal(facts.target_event_key, 'historical:1259:diaoyucheng-mongke-death');
  store.volumes.update(fixture.targetVolume.id, { outline: { year: 1260, event_keys: [] } });
  assert.throws(() => validateOpeningFacts(fixture.book, locks),
    error => error?.code === 'HISTORICAL_FACT_MISMATCH');
});

test('不传事实锁时退化为通用模式：只推断不拦错', () => {
  // 目标卷纲被改坏，但无锁时不应抛错——机器对任意作品可用
  store.volumes.update(fixture.targetVolume.id, { outline: { year: 1260, event_keys: [] } });
  const facts = validateOpeningFacts(fixture.book);
  assert.equal(facts.opening_year, 1241, '开篇年仍应被推断出来');
  assert.equal(facts.target_volume_idx, null, '未要求目标卷时不推断目标卷');
});

test('脚本只有同时给出 --apply 与受支持 candidate 才进入写模式', () => {
  assert.deepEqual(parseOpeningArgs([]).dryRun, true);
  assert.throws(() => parseOpeningArgs(['--apply']), /--candidate/);
  assert.throws(() => parseOpeningArgs(['--candidate', 'chapter1_cold_open']), /--apply/);
  const apply = parseOpeningArgs(['--apply', '--candidate', 'chapter1_cold_open']);
  assert.equal(apply.dryRun, false);
  assert.equal(apply.candidate, 'chapter1_cold_open');
  assert.throws(() => parseOpeningArgs(['--apply', '--candidate', 'composite_preview']), /不能直接应用/);
});

test('真实模型 dry-run 把配置复制进一次性沙箱，命令结束后可整体销毁', () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v098-config-source-'));
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v098-config-sandbox-'));
  try {
    const dbPath = path.join(sourceDir, 'novel.db');
    fs.writeFileSync(dbPath, 'fixture');
    fs.writeFileSync(path.join(sourceDir, 'config.json'),
      JSON.stringify({ apiKey: 'test-secret', provider: 'deepseek' }));
    const copied = copySandboxModelConfig(dbPath, sandboxDir);
    assert.equal(copied, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sandboxDir, 'config.json'), 'utf8')),
      { apiKey: 'test-secret', provider: 'deepseek' });
  } finally {
    try { fs.rmSync(sourceDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});
