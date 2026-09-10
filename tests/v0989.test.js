// V0.98.9 JSON 字符串裸控制字符修复：ox-alpha-free 实证——楔子候选正文质量完好，
// 但每次都把 content 里的换行写成裸 \n（JSON.parse 报 Bad control character），
// V0.98.8 的"瞬时坏响应"归因不成立，真实原因是确定性序列化故障；本地修复后 3/3 解析成功。
import './helper.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJSON } from '../server/util/json.js';

const Q1 = '\u201c', Q2 = '\u201d';

test('V0.98.9 字符串内裸换行/制表符被确定性修复为合法转义，内容一字不差', () => {
  const proseA = '开庆元年七月，钓鱼城北崖，第二拨砲石已经压进膛口。';
 const proseB = '主角拽开挡在垛口前的传令兵，自己探身去看江面。';
  const bad = '{\n  "kind": "chapter1_cold_open",\n  "content": "' + proseA + '\n\n' + proseB + '\t收束。\n\n' + Q1 + '报数。' + Q2 + '他说。",\n  "contract": {"target_year": 1259}\n}';
  const parsed = extractJSON(bad);
  assert.ok(parsed && parsed.content, '裸换行 JSON 必须修复后解析成功');
  assert.equal(parsed.content, proseA + '\n\n' + proseB + '\t收束。\n\n' + Q1 + '报数。' + Q2 + '他说。', '内容逐字保留（含换行结构）');
  assert.equal(parsed.contract.target_year, 1259);
});

test('V0.98.9 合法 JSON 与既有容错路径零影响', () => {
  assert.deepEqual(extractJSON('{"a":"行一\\n行二","b":[1,2]}'), { a: '行一\n行二', b: [1, 2] });
  assert.deepEqual(extractJSON('```json\n{"x":1}\n```'), { x: 1 });
  assert.deepEqual(extractJSON('前言混入{"x":{"y":"z"}}'), { x: { y: 'z' } });
  // 根级截断走既有 auto-close 容错（V0.85 设计行为），修复层不改变它
  assert.deepEqual(extractJSON('{"truncated":"未闭合'), { truncated: '未闭合' });
  // 引号外（结构层）的换行与缩进保持原样，不影响解析
  assert.deepEqual(extractJSON('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}'), { a: 1, b: [1, 2] });
});

test('V0.98.9 候选指令声明半角引号禁令（裸换行已容错、未转义半角引号无法修复）', async () => {
  const { openingCandidateInstruction } = await import('../server/engine/prompts.js');
  const text = openingCandidateInstruction({ book: { title: '书' }, strategy: { kind: 'chapter1_cold_open' } });
  assert.ok(text.includes('全角引号'), '对白引号规范必须显式声明');
  assert.ok(text.includes('不得出现未转义的半角引号'));
});
