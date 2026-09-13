// V0.98.13 免费模型全流程冗余适配（思考拉满放行 + 韧性上调）+ 战争残酷度工艺（近战血肉纪律 + 成长印记协同）
import './helper.js';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// ---------- A. 免费模型适配 ----------

const FREE = { provider: 'opencode_go_free', writingModel: 'flash', routes: {} };
const DEEPSEEK = { provider: 'deepseek_official', writingModel: 'flash', routes: {} };

test('V0.98.13 免费档思考档位放行：high 保持、medium 归并 high（端点实测 medium→400、high 输出完整）、low 保持', async () => {
  const { capReasoningEffort } = await import('../server/config.js');
  assert.equal(capReasoningEffort('high', FREE), 'high', 'V0.98.13 实测：high 思考可用且输出不被吃空（134s/350字完整），必须放行');
  assert.equal(capReasoningEffort('medium', FREE), 'high', 'free 档 medium → HTTP 400（always engages in thinking），规划类任务归并思考拉满');
  assert.equal(capReasoningEffort('low', FREE), 'low', '判定门等 low 档保持稳定');
  assert.equal(capReasoningEffort('high', DEEPSEEK), 'high', '无 cap 的端点原样放行');
  assert.equal(capReasoningEffort('medium', DEEPSEEK), 'medium', '其他端点只降不升语义不变');
});

test('V0.98.13 免费档韧性冗余上调：总时长 15 分钟、空闲与连接 90 秒（high 思考单步 134s+，旧 600s 只能容 2-3 步）', async () => {
  const { DEFAULT_GLOBAL } = await import('../server/config.js');
  assert.equal(DEFAULT_GLOBAL.resilience.totalTimeoutMs, 900000, '总时长 10→15 分钟');
  assert.equal(DEFAULT_GLOBAL.resilience.idleTimeoutMs, 90000, '流空闲 60→90 秒（思考段流间隙更长）');
  assert.equal(DEFAULT_GLOBAL.resilience.connectTimeoutMs, 90000, '首字节 60→90 秒（high 任务 TTFB 40s+）');
});

test('V0.98.13 旧版韧性假定制迁移：V0.47 默认组合（420s/60s）自动让位新默认，真定制保留', async () => {
  const { migrateLegacyResilience } = await import('../server/config.js');
  const legacy = {
    connectTimeoutMs: 60000, idleTimeoutMs: 60000, totalTimeoutMs: 420000, maxRetries: 3,
    circuitBreaker: { threshold: 3, openMs: 60000, maxOpenMs: 600000 },
  };
  const migrated = migrateLegacyResilience({ resilience: { ...legacy } });
  assert.equal(migrated.resilience.totalTimeoutMs, 900000, 'V0.47 旧默认=从未定制，删除让新默认生效');
  assert.equal(migrated.resilience.idleTimeoutMs, 90000);
  const realCustom = { ...legacy, totalTimeoutMs: 777777 };
  const kept = migrateLegacyResilience({ resilience: realCustom });
  assert.equal(kept.resilience.totalTimeoutMs, 777777, '真定制保留');
  assert.equal(migrateLegacyResilience({}).resilience, undefined, '无 resilience 字段不受影响');
});

test('V0.98.13 免费档预设声明思考档位与冗余（配置真源）', async () => {
  const { PROVIDER_PRESETS } = await import('../server/config.js');
  const preset = PROVIDER_PRESETS.opencode_go_free;
  assert.equal(preset.reasoningEffortCap, 'high', '预设必须放行 high 思考');
  assert.equal(preset.models.flash, 'ox-alpha-free');
});

// ---------- B. 战争残酷度工艺 ----------

test('V0.98.13 近战残酷纪律文本：禁-正例-量化三要素齐备，且与既有战役纪律合并为写审同源常量', async () => {
  const { WARFARE_BLOOD_TEXT, WARFARE_BODY_TEXT, WARFARE_TEXT } = await import('../server/data/literary_techniques.js');
  assert.ok(WARFARE_BLOOD_TEXT.includes('手感'), '必须写刀入肉的手感（正例言传身教）');
  assert.ok(WARFARE_BLOOD_TEXT.includes('正例') && WARFARE_BLOOD_TEXT.includes('反例'), '禁令必须结对正例');
  assert.ok(WARFARE_BLOOD_TEXT.includes('呕吐') || WARFARE_BLOOD_TEXT.includes('余波') || WARFARE_BLOOD_TEXT.includes('发抖'), '杀后必须有生理余波（成长印记起点）');
  assert.ok(/[0-9]+\s*[—–-]\s*[0-9]+\s*字/.test(WARFARE_BLOOD_TEXT), '残酷段必须量化体量');
  assert.ok(WARFARE_BODY_TEXT.includes(WARFARE_TEXT), '合并常量含既有战役纪律');
  assert.ok(WARFARE_BODY_TEXT.includes('短兵'), '合并常量含近战残酷纪律');
});

test('V0.98.13 卷纲/章纲/正文三处拼接统一用写审同源常量（防第四处漂移）', () => {
  const outline = fs.readFileSync('server/engine/planning/outline.js', 'utf8');
  const write = fs.readFileSync('server/engine/pipeline/write.js', 'utf8');
  const occurrences = (outline.match(/WARFARE_BODY_TEXT/g) || []).length + (write.match(/WARFARE_BODY_TEXT/g) || []).length;
  assert.ok(occurrences >= 3, `卷纲/章纲/正文拼接点必须统一为 WARFARE_BODY_TEXT（当前 ${occurrences} 处）`);
});

test('V0.98.13 审校 1.6 战争边界与写作纪律同源：短兵残酷/成长印记进入战役章核查', async () => {
  const { auditInstruction } = await import('../server/engine/prompts.js');
  const withWarfare = auditInstruction({
    bookTitle: 'X', chapterTitle: '守城', chapterText: '云梯架到垛口，砲石砸进城内。',
    factsText: '', foreshadowsText: '', characterStates: '', contract: '', warfareCheck: true,
  });
  assert.ok(withWarfare.includes('手感'), '战役章审校必须拿到近战残酷核查边界（写审同源）');
  const without = auditInstruction({
    bookTitle: 'X', chapterTitle: '日常', chapterText: '普通的一天。',
    factsText: '', foreshadowsText: '', characterStates: '', contract: '', warfareCheck: false,
  });
  assert.equal(without.includes('手感'), false, '非战役章不注入');
});

test('V0.98.13 战斗章无血肉痕迹本地检测：medium 提示智斗化，非战斗章零影响', async () => {
  const { detectBloodlessCombat } = await import('../server/engine/quality/rules.js');
  const bloodless = detectBloodlessCombat(
    '他提刀冲上垛口，一刀劈翻一个敌兵，又抬起盾顶住第二刀，反手再砍。',
    { title: '守城', outline: '攻城云梯填壕' },
  );
  assert.ok(bloodless.some(item => item.severity === 'medium' && item.issue.includes('血肉')), '战斗章全程无血肉痕迹=智斗化，必须 medium 提示');
  const bloody = detectBloodlessCombat(
    '他提刀冲上垛口，一刀劈进敌兵的脖子，血喷了他一脸。他干呕了一声，手还在抖。',
    { title: '守城', outline: '攻城云梯填壕' },
  );
  assert.equal(bloody.length, 0, '有血肉手感与生理余波不触发');
  const daily = detectBloodlessCombat('他走在集市上，买了两个饼。', { title: '日常', outline: '赶集' });
  assert.equal(daily.length, 0, '非战斗章零影响');
});

test('V0.98.13 成长印记入主角状态白名单：战历/伤疤/杀敌不被状态压缩误删', async () => {
  const { PROTAGONIST_KEEP_KEYS } = await import('../server/engine/planning/growth.js');
  for (const key of ['战历', '伤疤', '杀敌']) {
    assert.ok(PROTAGONIST_KEEP_KEYS.includes(key), `主角状态白名单必须保留 ${key}（残酷经历→成长印记的协同载体）`);
  }
});

test('V0.98.13 本地防线挂载进章节审校（战斗章无血肉痕迹进入 localIssues）', () => {
  const audit = fs.readFileSync('server/engine/pipeline/audit.js', 'utf8');
  assert.ok(audit.includes('detectBloodlessCombat'), '审校本地规则链必须调用近战残酷检测');
});