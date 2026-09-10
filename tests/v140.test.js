// V0.95.0 工程六.1+四：量化红线单一来源 + 写审同源批量校准
// 背景：四路审计实证——同一纪律（去 AI 味红线）分散 5 处维护（system/write指令/审校边界/
// creative_packs/rules），V0.93.4/0.93.7 两次脱节；动作母题指令 ≤2 检测 ≥4（三度脱节）；
// 禁词注入 slice(0,40) 检测全表 106 词（注入≠可检双向断裂）；实测本作衰减母题「站起/转身」无防线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helper.js';
import { REDLINES, AI_TASTE_FULL, STRICT_MOTIFS, COMMON_MOTIFS } from '../server/data/redlines.js';
import { AI_CLICHE_WORDS, styleRulesText } from '../server/data/creative_packs.js';
import { detectMotifRepetition, detectDialogueBalance } from '../server/engine/rules.js';

test('V0.95 红线单一来源：AI_TASTE_FULL = 注入词表 ∪ 检测黑名单（注入必可检/检出必注入）', () => {
  // 检测表覆盖注入表全量（写审同源铁律）
  for (const w of AI_CLICHE_WORDS) assert.ok(AI_TASTE_FULL.includes(w), `注入词未入检测表: ${w}`);
  // V0.95 补漏 12 词（审计 E1：闻言/苦笑 是中文网文头号 AI 腔，此前两表皆无）
  for (const w of ['闻言', '苦笑', '暗自', '暗暗', '垂眸', '怔了怔', '愣了一下', '心跳漏了一拍', '面无表情', '颔首', '眸色']) {
    assert.ok(AI_TASTE_FULL.includes(w), `补漏词未入统一词表: ${w}`);
  }
});

test('V0.95 红线常量：写作指令与检测器共用同一把尺（阈值数字单一真源）', () => {
  assert.equal(REDLINES.dashPerChapter, 20);
  assert.equal(REDLINES.paragraphMaxChars, 200);
  assert.equal(REDLINES.clicheSameWordMax, 2);
  assert.equal(REDLINES.motifDetectMedium, 3); // 对齐指令「≤2」——3 次破线必报
  assert.deepEqual(REDLINES.dialogueRatioRange, [0.15, 0.85]);
});

test('V0.95 动作母题阈值对齐：特征母题 ×3 必报 medium（此前 ≥4 漏报 3 次破线）', () => {
  const text = '他蹲下。她又蹲下。老人蹲下。'; // 蹲下 ×3（指令红线 ≤2）
  const issues = detectMotifRepetition(text);
  assert.ok(issues.length >= 1, '蹲下×3 必须被检出');
  assert.equal(issues[0].severity, 'medium');
});

test('V0.95 动作母题两级制：普通动作（站起/转身）×3 不报、×5 报 medium（防正常文误伤）', () => {
 assert.ok(COMMON_MOTIFS.includes('转身') && COMMON_MOTIFS.includes('站起'), '实测衰减母题（实测 ch25 转身×11）必须入表');
  const three = '他转身。她转身。老人转身。';
  assert.equal(detectMotifRepetition(three).length, 0, '普通母题 ×3 属正常范围不报');
  let five = '';
  for (let i = 0; i < 5; i++) five += '他转身看了看。';
  const issues = detectMotifRepetition(five);
  assert.ok(issues.length >= 1, '普通母题 ×5 报 medium');
  assert.equal(issues[0].severity, 'medium');
  // 特征母题表仍然存在（指节/喉结等）
  assert.ok(STRICT_MOTIFS.includes('指节'));
});

test('V0.95 禁词注入全量：styleRulesText 不再 slice(0,40)——检出必注入', () => {
  const text = styleRulesText('fierce', '');
  for (const w of AI_TASTE_FULL) {
    assert.ok(text.includes(w), `检测词表中的「${w}」必须注入写作指令（否则模型不知道它被禁）`);
  }
});

test('V0.95 历史书风格画像冲突过滤：isHistory 时过滤打脸节奏规则', () => {
  const normal = styleRulesText('fierce', '', {});
  const history = styleRulesText('fierce', '', { isHistory: true });
  assert.ok(normal.includes('打脸'), '非历史书保留打脸规则');
  assert.ok(!history.match(/打脸节奏/), '历史书不得注入「打脸节奏」（与史实流回报纪律冲突）');
});

test('V0.95 对话占比防线：修仙 ch43-76 式「无对话章」必须被本地检出', () => {
  // 无对话章（修仙实证 ch61-64 连续 4 章对话 0%）
  const noDialogue = '他走进山门。\n他看见石阶。\n他想起往事。\n他继续往前走。\n夜色降临了。\n他回到住处。';
  const issues = detectDialogueBalance(noDialogue);
  assert.ok(issues.length >= 1, '对话占比 <15% 必须报');
  assert.equal(issues[0].severity, 'medium');
 // 正常章（本作健康区间 28-66%）不报
  const healthy = '他推门进来。\n“回来了？”她问。\n“嗯。”他说。\n他坐下，把刀放在桌上。\n“外面冷不冷？”\n“冷。”';
  assert.equal(detectDialogueBalance(healthy).length, 0);
  // 全对话章（>85%）也报
  let allDialogue = '';
  for (let i = 0; i < 10; i++) allDialogue += `“第${i}句话。”\n`;
  assert.ok(detectDialogueBalance(allDialogue).length >= 1, '对话占比 >85% 报 medium');
});
