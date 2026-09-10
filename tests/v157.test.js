// V0.105.1 锁定：名场面工艺三处一线（剑来差评经验：读者骂水、骂文青，却对雪中名场面如数家珍——
// 名场面=具体地名+可数规模+单一决定性动作，是读者原谅一切毛病的理由）
// ① 卷纲/续卷大纲：高潮结算须策划成可转述名场面（既有意象的收束，不临时空降新舞台）
// ② 高潮场景硬要求：释放定格成可转述画面（地点/决定性动作/可数之物三者至少其二），不议论升华
// ③ 审校 3.14 写审同源：高潮释放段只有顿悟议论而无具体定格 → medium「文学性」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import './helper.js';

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const load = async f => import(pathToFileURL(path.join(ROOT, f)));

// ---------- ① 卷纲/续卷：名场面策划 ----------

test('V0.105.1 卷纲叙事结构要求含名场面策划（可转述+铺垫章先出现）', async () => {
  const { volumeOutlineInstruction } = await load('server/engine/prompts.js');
  const s = volumeOutlineInstruction({ bookTitle: 'T', volumeIdx: 2, volumeTitle: 'V', bookOutline: '{}', chapterCount: 8 });
  assert.ok(s.includes('名场面'), '卷纲应要求高潮结算落成名场面');
  assert.ok(/可转述/.test(s) && /有名字的地方/.test(s) && /决定性动作/.test(s) && /可数/.test(s),
    '名场面要素须具体：谁/有名字的地点/决定性动作/规模或代价可数');
  assert.ok(s.includes('铺垫章先出现'), '名场面地点与器物须在铺垫章先出现（既有意象的收束，非临时空降）');
  assert.ok(s.includes('斩获三百级'), '正例示范可数的名场面（非"大获全胜"式笼统）');
});

test('V0.105.1 续卷大纲快感节奏要求含名场面', async () => {
  const { nextVolumeInstruction } = await load('server/engine/prompts.js');
  const s = nextVolumeInstruction({ bookTitle: 'T', volumeCount: 2, chapterCount: 10 });
  assert.ok(/名场面/.test(s) && /决定性动作/.test(s) && /可数/.test(s),
    '续卷大纲高潮结算同样须策划成可转述名场面');
  assert.ok(s.includes('既有意象的收束'), '续卷名场面同样禁止临时空降新舞台');
});

// ---------- ② 高潮场景硬要求：可转述画面定格 ----------

test('V0.105.1 climax 场景硬要求注入可转述画面定格（地点/动作/可数三者至少其二）', async () => {
  const { writeSceneInstruction } = await load('server/engine/prompts.js');
  const s = writeSceneInstruction({
 bookTitle: 'T', chapterIdx: 9, scene: { id: 's1', pov: '主角', scene_type: 'climax', beat: '巷战收束' }, scenesBefore: [],
  });
  assert.ok(s.includes('【高潮戏硬要求】'), 'climax 场景应注入高潮硬要求');
  assert.ok(s.includes('一句话能转述的画面'), '释放须定格成读者一句话能转述的画面');
  assert.ok(/有名字的地点/.test(s) && /决定性动作/.test(s) && /可数的规模或代价/.test(s),
    '画面定格三要素：地点/决定性动作/可数规模或代价');
  assert.ok(s.includes('三者至少其二'), '三要素至少其二（量化边界）');
  assert.ok(s.includes('议论升华'), '明令不用顿悟议论升华收束（剑来式说教高潮的反面）');
});

test('V0.105.1 非 climax 场景不注入高潮硬要求（条件注入零误伤）', async () => {
  const { writeSceneInstruction } = await load('server/engine/prompts.js');
  const s = writeSceneInstruction({
 bookTitle: 'T', chapterIdx: 3, scene: { id: 's1', pov: '主角', scene_type: 'fight', beat: '夜哨' }, scenesBefore: [],
  });
  assert.ok(!s.includes('【高潮戏硬要求】'), 'fight 场景不应带高潮硬要求');
});

// ---------- ③ 审校写审同源 ----------

test('V0.105.1 审校 3.14 含高潮释放段定格核查（与写作指令同一把尺）', async () => {
  const { auditInstruction } = await load('server/engine/prompts.js');
  const s = auditInstruction({ bookTitle: 'T', chapterTitle: 'C', chapterText: 'x' });
  assert.ok(s.includes('scene_type=climax'), '审校应知道按细纲 scene_type=climax 定位高潮场景');
  assert.ok(/顿悟\/议论升华/.test(s) && /他终于明白/.test(s), '判定形态须点名顿悟议论式总结');
  assert.ok(/有名字的地点、决定性动作或可数之物/.test(s), '判定标准与写作指令三要素同源');
  assert.ok(/medium「文学性」/.test(s.slice(s.indexOf('高潮场景'))), '高潮议论化定格缺失应判 medium（参与 verdict）');
});

// ---------- 工艺互斥自查：既有防线不重复、不冲突 ----------

test('V0.105.1 名场面工艺不与既有议论防线冲突（偈语/收束检测仍在，各管一层）', () => {
  const rules = read('server/engine/rules.js');
  const prompts = read('server/engine/prompts.js');
  assert.ok(/detectCommentaryClosers/.test(rules), '章末议论收束检测仍在（句级防线不动）');
  assert.ok(/偈语/.test(prompts), '对白偈语配额仍在（台词级防线不动）');
  // 名场面检查是场景级正面工艺：不新增 issue 类型、不新增词表、不新增本地扫描
  assert.ok(!/SIGNATURE_SCENE|signatureScene/.test(rules), '不应新增本地词表扫描（LLM 判定场景级定格，非关键词可判）');
});
