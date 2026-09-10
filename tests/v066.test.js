// V0.66 大纲与设定冲突修复：buildPublicMaterials 注入时剥离 outline 世界观段（world 唯一源）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v066-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const prompts = await import(pathToFileURL(path.join(ROOT, 'server/engine/prompts.js')));

describe('V0.66 大纲设定冲突', () => {
  test('outline 含世界观初稿段时，注入剥离该段（保留标题+分卷规划）', () => {
    const outline = '书名：《测试》\n世界观：灵气世界，境界炼气到化神。\n这里是详细设定内容……\n【分卷规划】\n卷1：第一章到第五章';
    const text = prompts.buildPublicMaterials({ world: '灵气世界（正式设定）', cast: '', outline, contract: '' });
    assert.ok(!text.includes('这里是详细设定内容'), '世界观初稿段不应注入');
    assert.ok(!text.includes('世界观：灵气世界'), '世界观初稿段不应注入');
    assert.ok(text.includes('书名：《测试》'), '标题段保留');
    assert.ok(text.includes('【分卷规划】'), '分卷规划保留');
    assert.ok(text.includes('灵气世界（正式设定）'), 'world 材料正常注入');
  });

  test('outline 无【分卷规划】或无世界观段时原样注入', () => {
    const o1 = '书名：《测试》\n【分卷规划】\n卷1';
    const t1 = prompts.buildPublicMaterials({ world: 'w', cast: '', outline: o1, contract: '' });
    assert.ok(t1.includes('书名：《测试》') && t1.includes('卷1'), '无世界观段 → 原样');
    const o2 = '书名：《测试》\n只有标题没有分卷';
    const t2 = prompts.buildPublicMaterials({ world: 'w', cast: '', outline: o2, contract: '' });
    assert.ok(t2.includes('只有标题没有分卷'), '无分卷规划 → 原样');
  });

  test('world 是唯一世界观注入源（两处不重复）', () => {
    const outline = '书名：《测试》\n世界观：初稿设定\n【分卷规划】\n卷1';
    const text = prompts.buildPublicMaterials({ world: '正式设定', cast: '', outline, contract: '' });
    const worldCount = (text.match(/世界观/g) || []).length;
    assert.equal(worldCount, 1, '世界观字样应只出现一次（【世界观设定】标题）');
  });
});
