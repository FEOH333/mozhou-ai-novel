// server/engine/quality/rules.js —— 本地零成本规则检查（量化 AI 味指标，借鉴 500+ 章实战方法论）
'use strict';
// V0.95.0：量化红线与词表迁移至 data/redlines.js 单一真源（此前分散 5 处维护，
// V0.93.4/0.93.7/审计三次写审脱节）；本文件只做检测逻辑，数字与词表一律 import。
import { REDLINES, AI_TASTE_FULL, EXTREME_CLICHES, STRICT_MOTIFS, COMMON_MOTIFS, CLOSEOUT_TIC_PATTERNS, OPENER_TIC_PATTERNS, ENDING_TIC_PATTERNS, TITLE_EVENT_LEXICON } from '../../data/redlines.js';
import {
  ABSTRACT_JARGON, GRAND_ABSTRACTION, HEDGING_WORDS, AI_CONNECTORS,
  TRANSLATIONESE_PATTERNS, PSEUDO_SUBLIMATION_PATTERNS, MANNER_ADVERBIAL_PATTERNS,
  RULE_OF_THREE_PATTERNS, EMOTION_LEXICON, SUBJECTIVE_MARKERS, COLLOQUIAL_MARKERS,
  FACT_ANCHOR_PATTERNS,
} from '../../data/ai_flavor.js'; // V0.109.3：通用中文 AI 腔规则（与 redlines 零重叠）
import { isWarfareText } from '../../data/literary_techniques.js'; // V0.98.13：战争章门控（与写作注入同一判定）
import { openerStructureTemplate } from './chapter_diversity.js';
import { detectCraftIssues } from './craft_occupancy.js';

/** 元话语：正文中出现即违规（0 容忍） */
const META_WORDS = ['卷一', '卷终', '第X章', '前文', '后文', '本章', '上一章', '下一章', '作者按', '（未完待续）', '未完待续', '敬请期待'];

/** 对话标签检测：某段内 "X道：" 或 "X：" 过密 */
export function detectDialogueTagDensity(text) {
  const issues = [];
  const paras = text.split(/\n+/).filter(p => p.trim());
  for (let i = 0; i < paras.length; i++) {
    const tags = (paras[i].match(/[说问答喊叫](?:道)?[，：,: "“]/g) || []).length;
    if (tags >= 3) {
      issues.push({
        type: '语句质量', severity: 'low',
        quote: paras[i].slice(0, 60),
        issue: `同一段落出现 ${tags} 处对话标签，建议用动作带出说话人`,
        fix: '拆分段落或用动作/神态替代对话标签',
      });
    }
  }
  return issues;
}

/** V0.98.13 战斗章无血肉痕迹检测：战役章里发生了贴身搏杀（动作词 ≥2）
 *  却全程没有任何血肉感官后果（血/腥/尸/抖/呕/骨/肠）——"智斗冒险化"的本地指纹，
 *  与写作纪律（WARFARE_BLOOD_TEXT）同源：写审同一把尺，注入必可检。
 *  只提示（medium 记债+审校边界），不自动触发修订——侦察/运筹章靠动作词门槛豁免。 */
const COMBAT_ACTION_RE = /击|砍|杀|劈|刺|抡|扑|肉搏|白刃|格斗|招架|盾|刀锋|刀光/g;
const BLOOD_MARK_RE = /血|腥|尸|抖|呕|骨|肠|肉屑|浆/;
export function detectBloodlessCombat(text, { title = '', outline = '' } = {}) {
  const issues = [];
  const joined = `${title || ''} ${outline || ''}`;
  const body = String(text || '');
  if (!isWarfareText(joined, body.slice(0, 120))) return issues;
  const actions = (body.match(COMBAT_ACTION_RE) || []).length;
  if (actions < 2) return issues;
  if (BLOOD_MARK_RE.test(body)) return issues;
  issues.push({
    type: '战争逻辑', severity: 'medium',
    quote: body.slice(0, 60),
    issue: '战斗章发生贴身搏杀（动作 ≥2 处）却全程无血肉痕迹（无血/腥/尸/抖/呕/骨/肠）——像智斗冒险的"干净打斗"，没有残酷就没有成长（V0.98.13 近战残酷纪律）',
    fix: '补刀入肉的手感、血的热气、濒死者的脸与杀后的生理余波（手抖/干呕/夜惊），并把本场的痛落成主角可见的印记',
  });
  return issues;
}

/** AI 高频词检测（同词 ≥2 次报，或命中一次极端套话直接报）
 *  V0.73：极端套话（众所周知/综上所述/无与伦比等）命中 1 次即报 medium（进入修订闭环）；
 *  普通口水词 ≥2 次报 low；≥4 次升级 medium（AI 味确实重，值得修订）。
 *  V0.93.7：阈值对齐写作指令第 11 条量化红线（套话同词每章 ≤2 次）——同词 ≥3 次即 medium
 *  触发修订自愈（此前 ≥4 才 medium，3 次破线却只报 low 不参与 verdict，写审不同源）。
 *  检测词表 = 本地积累 AI_CLICHES ∪ 注入词表 AI_CLICHE_WORDS（写审同源，注入必可检）。 */
// V0.100.15：EXTREME_CLICHES 迁入 redlines.js 单一真源（检测与注入共用），此处只 import。
export function detectClichés(text) {
  const issues = [];
  for (const c of AI_TASTE_FULL) {
    let n = 0, idx = 0;
    while ((idx = text.indexOf(c, idx)) >= 0) { n++; idx += c.length; }
    if (n === 0) continue;
    if (EXTREME_CLICHES.includes(c) && n >= 1) {
      issues.push({
        type: '语句质量', severity: 'medium',
        quote: text.slice(0, 40) + '…',
        issue: `「${c}」出现 ${n} 次，是极端 AI 套话，正文出现即显廉价`,
        fix: `将「${c}」删掉或改为具体描写`,
      });
    } else if (n >= 3) {
      issues.push({
        type: '语句质量', severity: 'medium',
        quote: text.slice(0, 40) + '…',
        issue: `「${c}」出现 ${n} 次，超过每章 ≤2 次红线（V0.93.4 量化红线），AI 味重`,
        fix: `将「${c}」替换为具体动作/细节描写，同词每章不超过 2 次`,
      });
    } else if (n >= 2) {
      issues.push({
        type: '语句质量', severity: 'low',
        quote: text.slice(0, 40) + '…',
        issue: `「${c}」出现 ${n} 次，AI 味较重，建议精简`,
        fix: `将「${c}」替换为具体动作/细节描写，同词一段最多一次`,
      });
    }
  }
  return issues;
}

/** 判断 text 中 position 处是否位于引号对白内（“”/「」/『』/""），对白中的口语否定豁免 */
function insideDialogue(text, position) {
  const PAIRS = { '“': '”', '「': '」', '『': '』', '"': '"' };
  let active = null;
  for (let i = 0; i < position; i++) {
    const ch = text[i];
    if (!active && PAIRS[ch]) { active = ch; continue; }
    if (active && ch === PAIRS[active]) active = null;
  }
  return active !== null;
}

/** "不是X，而是Y"式抽象对比检测（叙事中出现即违规；对话中允许）
 *  V0.93.4：同章命中 ≥2 处升 medium（参与审校 verdict，触发修订自愈），1 处保持 low。
 *  V0.94.0：精读实证补齐变体——"不是X，是Y"（无而/却，X≥4 字防"不是他，是我哥"口语）、
 *  "不是X，更像Y"、"N年前X……如今Y"（成长总结对比句）；对白引号内豁免。 */
export function detectNotButPattern(text) {
  const issues = [];
  const src = String(text || '');
  const patterns = [
    { re: /不是[^，。！？\n]{1,24}，(?:而|却)是[^，。！？\n]{1,24}/g, label: '不是X，而是Y' },
    { re: /不是[^，。！？\n]{4,24}，是[^，。！？\n]{2,24}/g, label: '不是X，是Y（同句）' },
    // V0.98.14 高赞"不是什么笑而是什么笑"跨句拆分形态：「不是X。」标签/短句 +「是Y。」——
    // X≥2 字（防"不是他。是我哥"单字口语短否定），中间 ≤24 字（可容说者标签），感知判别豁免同前
    { re: /不是([^，。！？\n]{2,16})。([^。！？\n]{0,24})是([^，。！？\n]{2,22})/g, label: '不是X。…是Y。（跨句拆分）' },
    { re: /不是[^，。！？\n]{2,24}，更像[^，。！？\n]{2,24}/g, label: '不是X，更像Y' },
    { re: /[一两二三四五六七八九十\d]{1,3}年前[^。！？\n]{4,40}如今[^，。！？\n]{0,40}/g, label: 'N年前X如今Y' },
  ];
  for (const { re, label } of patterns) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      if (insideDialogue(src, m.index)) continue;
      // V0.94.0 感知型豁免："不是（露水）那种（薄湿），是…"是感官判别教学句
      // （看水/辨迹/听声主题的合法修辞），只有议论型对比才计入
      if (m[0].includes('那种') || m[0].includes('这类')) continue;
      // V0.94.0b 感知判别豁免扩围：精读复检实证"不是碾过粗石的响，是刃口顺着石面走的声音"
      // （听声辨质）/"不是他腰间那口佩刀，是一把旧猎刀"（辨物）/"不是巡哨的步点，是被催赶的
      // 跑法"（识步）全是合法感官教学句，被误计 medium。判别法：句子含感官名词/性状词且
      // 不含抽象认知词 → 感知判别，不计；含 怕/想起/判断/明白 等认知词 → 议论对比，计入。
      // V0.98.14：含行为/需求语义的不是辨物，是价值议论（量词"一把/两把"不触发）。
      if (PERCEPT_HINT_RE.test(m[0]) && !ABSTRACT_HINT_RE.test(m[0]) && !/有人|想要|要的|让[^，。！？\n]{0,4}(?:人|他|她)|把消息|接好|传对|传错/.test(m[0])) continue;
      issues.push({
        type: '语句质量', severity: 'low',
        quote: m[0],
        issue: `「${m[0].slice(0, 40)}」是 AI 模板句式（${label}），叙事中应直接写事实`,
        fix: '删掉对比结构，直接描写实际情况（成长由动作自证，不由叙述者总结）',
      });
    }
  }
  if (issues.length >= 2) issues.forEach(i => { i.severity = 'medium'; });
  return issues;
}

/**
 * V0.93.2 点题议论防线：抽象对比句扫描（比 detectNotButPattern 覆盖更全）。
 * 覆盖"不是X，而是Y / 不是X，也不是Y / 不是X，却是Y"变体（X 侧 ≥5 字，
 * 过滤"不是他，是我哥"这类口语短否定）；返回命中的句子片段（空数组=干净）。
 */
export function isAbstractContrastText(text) {
  const hits = [];
  const pair = /不是([^，。！？\n]{5,30})，(?:而是|却是|也不是)[^。！？\n]{1,40}/g;
  let m;
  while ((m = pair.exec(String(text || ''))) !== null) hits.push(m[0]);
  return hits;
}

/** V0.93.2 收尾点题句检测（"这比一句…难写/有用"式议论收束，非动作/物件收束）
 *  V0.93.4：同章命中 ≥2 处升 medium（参与审校 verdict），1 处保持 low。
 *  V0.94.0：补"A，才是B的…（部分/根基/答案）"总结句变体（精读实证 ch10 章末议论未被覆盖）。 */
export function detectCommentaryClosers(text) {
  const issues = [];
  const src = String(text || '');
  const patterns = [
    /这比一句[^。！？\n]{1,30}(?:难写|有用|重要|动人|真实|更难|更贵)/g,
    /[^，。！？\n]{2,30}，才是[^，。！？\n]{2,30}(?:部分|根基|答案|底子|骨架)/g,
  ];
  for (const meta of patterns) {
    let m;
    while ((m = meta.exec(src)) !== null) {
      if (insideDialogue(src, m.index)) continue;
      issues.push({
        type: '语句质量', severity: 'low',
        quote: m[0],
        issue: `「${m[0].slice(0, 40)}」是点题议论式收束，说明味重，应由具体物件/动作自然收束章节`,
 fix: '删掉议论句，用画面收束：如"主角合上工册，指节在封皮上按了按。"',
      });
    }
  }
  if (issues.length >= 2) issues.forEach(i => { i.severity = 'medium'; });
  return issues;
}

/** V0.94.0 动作母题配额（精读实证：主角动作库过窄——"指节"5+/卷、"喉结滚"5+/卷、
 *  "蹲"单章 7 次、"一明一灭"单章 4 次）。
 *  V0.95.0 阈值对齐指令（特征母题 ≤2，≥3 报 medium——此前 ≥4 漏报 3 次破线）+ 两级制：
 *  特征母题（STRICT：指节/喉结等强风格指纹）≥3 报；普通母题（COMMON：转身/站起/点头——
 * 实测实测衰减信号 ch25 转身×11）≥5 报，3-4 次属正常文不误伤。 */
/** V0.94.0b 感知判别豁免词表：句子含"判别对象"名词（声响/印迹/纹/步点/刀弓弦/烟雾）或
 *  形状质料词（尖圆滑糙湿），且不含抽象认知词（怕/想起/判断/明白…）时，"不是X，是Y"
 *  是感官教学句（听声辨质/辨物/识迹），不计入议论对比。注意：只收判别对象词，不收
 *  水/火/点/线等泛名词（防"墙不是先垒的，是先弄清水和路"这类工艺议论被误豁免）。 */
const PERCEPT_HINT_RE = /[声响味印迹纹烟雾灰刀弓弦尖圆滑糙湿形样线色光]|步(?=点|声|伐|履)/;
const ABSTRACT_HINT_RE = /怕|想起|念头|判断|决定|感觉|明白|懂得|道理|心思|悔|恨|怒|滋味|勇气|恐惧|成长/;
export function detectMotifRepetition(text) {
  const issues = [];
  const src = String(text || '');
  // V0.96.2：motif 元素支持数组=同义变体合并组（求和计数，redlines.js 单一真源）
  const check = (motifs, threshold, label) => {
    for (const motif of motifs) {
      const variants = Array.isArray(motif) ? motif : [motif];
      let n = 0;
      for (const v of variants) {
        let idx = 0;
        while ((idx = src.indexOf(v, idx)) >= 0) { n++; idx += v.length; }
      }
      if (n >= threshold) {
        issues.push({
          type: '语句质量', severity: 'medium',
          quote: src.slice(0, 40) + '…',
          issue: `动作母题「${variants.join('/')}」本章出现 ${n} 次（${label}），动作库过窄显套路`,
          fix: `保留最有力的 1-2 处，其余换成新动作（换身体部位/换物件/换节奏）`,
        });
      }
    }
  };
  check(STRICT_MOTIFS, REDLINES.motifDetectMedium, `上限 ${REDLINES.motifSameWordMax} 次`);
  check(COMMON_MOTIFS, REDLINES.commonMotifDetectMedium, `高频动作上限 ${REDLINES.commonMotifDetectMedium - 1} 次`);
  // V0.96.2：收尾套子——场景/章末悬念收束的固化短语（如「指节慢慢收拢，又松开」），
 // 同章 ≥2 即套路（实测 ch27-31 实证 5 章 7 处、4 处落在收束位）
  for (const pat of CLOSEOUT_TIC_PATTERNS) {
    const m = src.match(pat);
    if (m && m.length >= 2) {
      issues.push({
        type: '语句质量', severity: 'medium',
        quote: src.slice(0, 40) + '…',
        issue: `收尾套子「${String(pat).slice(1, 18)}…」本章出现 ${m.length} 次——悬念收束反复落在同一身体动作短语上，母题词表拦不住的短语级复读`,
        fix: `收束动作只留 1 处（挑最有分量那处），其余场景末改用别的方式收（一句对话/一个声音/一个物件变化）`,
      });
    }
  }
  return issues;
}

/**
 * V0.95.0 对话占比防线（修仙书解剖实证：ch43-76 对话空心化是中段最可感劣化——
 * ch61-64 连续 4 章引号数 0、全文无对话的"独白式推进"；此前零防线）。
 * 对话行占比（含引号行/非空行）<15% 或 >85% 报 medium，参与审校 verdict 触发修订自愈。
 */
export function detectDialogueBalance(text) {
  const src = String(text || '');
  const paras = src.split(/\n+/).map(p => p.trim()).filter(Boolean);
  if (paras.length < 5) return []; // 段落太少（片段/场景级）不判章级占比
  const dialogueLines = paras.filter(p => /[“「『"]/.test(p)).length;
  const ratio = dialogueLines / paras.length;
  const [min, max] = REDLINES.dialogueRatioRange;
  if (ratio >= min && ratio <= max) return [];
  return [{
    type: '语句质量', severity: 'medium',
    quote: `对话行占比 ${(ratio * 100).toFixed(0)}%（${dialogueLines}/${paras.length} 行）`,
    issue: ratio < min
      ? `对话占比 ${(ratio * 100).toFixed(0)}% 过低（健康区间 ${(min * 100).toFixed(0)}%-${(max * 100).toFixed(0)}%）——叙述独白式推进，读者没有"人在说话"的临场感（长程衰减实测：连续低对话章是最可感的质量滑坡）`
      : `对话占比 ${(ratio * 100).toFixed(0)}% 过高（健康区间 ${(min * 100).toFixed(0)}%-${(max * 100).toFixed(0)}%）——剧本化裸对话，缺动作/环境锚定，人物悬空说话`,
    fix: ratio < min
      ? '把关键信息与情绪改写为对手戏：至少两组有来有回的对话（含打断/反问/答非所问），用对话推进冲突而非叙述概括'
      : '为对白段落穿插动作与神态锚点（谁在说、说话时手在做什么、环境有什么变化），删掉可合并的寒暄轮次',
  }];
}

/** V0.94.0 章末零钩收束（精读实证：卷2 8 章中 7 章议论/抒情收尾、ch13 静态空镜零指向——
 *  追读断点。末段为静态比喻且无对白/威胁/疑问 → medium。 */
export function detectWeakEnding(text, { volumeFinal = false } = {}) {
  const src = String(text || '').trim();
  if (!src) return [];
  const paras = src.split(/\n+/).filter(p => p.trim());
  if (!paras.length) return [];
  const last = paras.at(-1);
  if (!last) return [];
  const hasDialogue = /[“「『"]/.test(last);
  const hasTension = /[？！]/.test(last) || /(来了|到了|逼近|逼近|急报|军令|号角|警报|蹄声|马蹄|血|刀|杀|追|闯入)/.test(last);
  // V0.94.0b 威胁悬置豁免：末段含"在等/盯着/没有睡"等威胁性拟人（精读复检实证
  // ch18"远处的灰烟…又立直了。像在等他"是有指向的威胁意象，非静态空镜）
  const hasOminousHook = /(在等|等着|盯|没有睡|没有睡着|睁着眼|醒着|跟了上来|朝这边)/.test(last);
  // V0.94.0b 卷末章豁免：卷末收束章允许静场收尾（跨卷节奏点，钩子由新卷开篇承担）
  if (volumeFinal || hasDialogue || hasTension || hasOminousHook) return [];
  const simileEnd = /(?:像|如|似)[^，。！？\n]{2,30}[。！？]?\s*$/.test(last.trim());
  const staticEnd = /(一明一灭|慢慢涨开|没有合上|静静地?[^，。！？\n]{0,8})[。]?\s*$/.test(last.trim());
  if (!simileEnd && !staticEnd) return [];
  return [{
    type: '语句质量', severity: 'medium',
    quote: last.slice(-50),
    issue: `章末以静态比喻/空镜收束（零钩），读者没有"想看下一章"的指向——追读断点`,
    fix: '末段落到具体悬念/威胁/抉择上：一句来报、一个异动、一个未接完的话头（正例："陈七冒雨进棚，斗笠往下滴水：\'雨里踩出来的印子，不止我们的。\'）',
  }];
}

/** V0.94.0 章名兑现度（精读实证：《伍字军旗》全章无旗无伍、《血染征衣》无血无战——
 *  章名与正文脱节。章名核心二字组（连续 CJK bigram）在正文零出现 → low 提示
 *  （意象型章名如《故园成灰》属合法文学命名，故只提示不强制、不入债）。 */
export function detectTitleGap(title, text) {
  const t = String(title || '').replace(/[^\u4e00-\u9fff]/g, '');
  if (t.length < 3 || t.length > 10) return [];
  const src = String(text || '');
  const bigrams = [];
  for (let i = 0; i + 2 <= t.length; i++) bigrams.push(t.slice(i, i + 2));
  if (!bigrams.length || bigrams.some(b => src.includes(b))) return [];
  return [{
    type: '大纲偏离', severity: 'low',
    quote: t,
    issue: `章名《${t}》的核心词（${bigrams.slice(0, 3).join('/')}）在正文零出现——若为具象章名（旗/衣/甲/刀等实物承诺）则读者期待落空；若为意象型章名可忽略`,
    fix: '具象章名须在正文兑现（核心名词出现且承担情节功能），或改名为正文实际承载的意象',
  }];
}

/** V0.107 章名句式族分类（调研：docs/章卷命名工艺调研报告.md 六族分类学的可判定投影——
 *  问句/长句(≥7)/中长(5-6)/四字格/极简(≤3)。长度带+问号是句式单调的可靠代理指标：
 *  「军报/夜哨/斥候/狼烟」全落极简族、「十人一绳/探杆验墙」全落四字族，连排即可判。 */
export function titleShapeOf(title) {
  const raw = String(title || '').trim();
  if (!raw) return null;
  const cjk = raw.replace(/[^\u4e00-\u9fff]/g, '');
  if (!cjk.length) return null;
  if (/[?？]/.test(raw)) return 'question';
  if (cjk.length >= 7) return 'long';
  if (cjk.length >= 5) return 'mid';
  if (cjk.length === 4) return 'four';
  return 'terse';
}

/** V0.107 卷纲期章名句式族连排/占比检测：连排 ≥3 触发纠正重答，连排 ≥4（hard）拦，
 *  单族占比 >70%（≥8 个标题才判）软提示。番茄实证：连续三五章同公式读者疲劳。 */
export function titleShapeStreakIssues(titles = []) {
  const issues = [];
  const shapes = titles.map(titleShapeOf);
  let run = 1;
  for (let i = 1; i <= shapes.length; i++) {
    if (i < shapes.length && shapes[i] && shapes[i] === shapes[i - 1]) { run++; continue; }
    if (run >= 3 && shapes[i - 1]) {
      issues.push({
        kind: 'streak', shape: shapes[i - 1], count: run, at: i - run,
        hard: run >= 4,
        detail: `第${i - run + 1}-${i}章连续 ${run} 章同为「${shapes[i - 1]}」句式族`,
      });
    }
    run = 1;
  }
  const valid = shapes.filter(Boolean);
  if (valid.length >= 8) {
    const byShape = {};
    for (const s of valid) byShape[s] = (byShape[s] || 0) + 1;
    for (const [shape, n] of Object.entries(byShape)) {
      if (n / valid.length > 0.7) {
        issues.push({
          kind: 'ratio', shape, ratio: Number((n / valid.length).toFixed(2)), count: n,
          hard: false,
          detail: `全卷 ${n}/${valid.length} 章为「${shape}」族（>${Math.round(0.7 * 100)}%）`,
        });
      }
    }
  }
  return issues;
}

/** V0.107 卷内章名近词根查重（前 2 字相同即报——「北渡/北望」「灰村/灰烟」式复读）。 */
export function titleRootRepeatIssues(titles = []) {
  const issues = [];
  const seen = new Map();
  titles.forEach((title, i) => {
    const cjk = String(title || '').replace(/[^\u4e00-\u9fff]/g, '');
    if (cjk.length < 2) return;
    const root = cjk.slice(0, 2);
    if (seen.has(root)) issues.push({ kind: 'root', root, at: i + 1, prevAt: seen.get(root) + 1, hard: false, detail: `第${seen.get(root) + 1}章与第${i + 1}章章名同词根「${root}」` });
    else seen.set(root, i + 1);
  });
  return issues;
}

/** V0.107 章名↔正文核对闸（写审同源；audit localIssues 挂载，替代 detectTitleGap 的 low 档）。
 *  三层：事件承诺型（TITLE_EVENT_LEXICON 命中且正文词族零在场）→ high+proseFix，
 *  ch52「帝星陨落」正文理宗驾崩零着墨事故的正面拦截；具象型（3-10 字全部 bigram 零命中）
 *  → medium+proseFix（从 detectTitleGap 的 low 升级入债，意象型章名在正文体现场景词时自然豁免）。
 *  detectTitleGap 保留（v136 测试兼容与 doctor 观察面）。 */
export function chapterTitleDeliveryIssues(title, text) {
  const issues = [];
  const t = String(title || '').replace(/[^\u4e00-\u9fff]/g, '');
  if (!t || t.length < 2) return issues;
  const src = String(text || '');
  let familyMatched = false;
  for (const family of TITLE_EVENT_LEXICON) {
    const hit = family.trigger.find(w => t.includes(w));
    if (!hit) continue;
    familyMatched = true;
    const delivered = [hit, ...family.evidence].some(w => src.includes(w));
    if (!delivered) {
      issues.push({
        type: '大纲偏离', severity: 'high', proseFix: true, quote: t,
        issue: `章名《${t}》以「${hit}」承诺了关键事件，但正文该事件词族（${family.evidence.slice(0, 4).join('/')}）零在场——章名与内容牛头不对马嘴`,
        fix: `在本章正文补写「${hit}」的现场或直接触及（塘报/讣闻/转述式落地也算在场）；若本章实际不写该事件，应改章名为正文实际承载的意象`,
      });
    }
    break; // 一个词族命中即判，不叠报
  }
  // 事件词族已命中时不落 bigram 档：同义词兑现（如「帝星陨落」→正文「驾崩」）已证明名实相符，
  // 逐字 bigram 必然零命中，再报即误伤。
  if (issues.length || familyMatched) return issues;
  if (t.length >= 3 && t.length <= 10) {
    const bigrams = [];
    for (let i = 0; i + 2 <= t.length; i++) bigrams.push(t.slice(i, i + 2));
    if (bigrams.length && !bigrams.some(b => src.includes(b))) {
      issues.push({
        type: '大纲偏离', severity: 'medium', proseFix: true, quote: t,
        issue: `章名《${t}》的核心词（${bigrams.slice(0, 3).join('/')}）在正文零出现——具象章名须兑现，意象型章名若正文确有意象落点可忽略`,
        fix: '具象章名在正文兑现核心名词（出现且承担情节功能），或改名为正文实际承载的意象',
      });
    }
  }
  return issues;
}

/** V0.108 新具名实体密度（番茄作家课"开篇前 20 章别十几个人名砸脸"）——
 *  数据源 pendingEntities 按 source_chapter 计数（写作期【新设定】剥离时即入库，早于审校）；
 *  人名/地名/物名对读者同为新记忆负担，合计作密度代理。写审同源：细纲指令"每章新增
 *  具名角色 ≤2、开篇期尤其克制"（指令 2 → 开篇检测 ≥3 判罚、常规 ≥4 提示）。 */
export function newCharacterDensityIssues({ newEntityCount = 0, chapterIdx = 0, openingChapters = 20 } = {}) {
  const n = Number(newEntityCount) || 0;
  if (n < 3) return [];
  const idx = Number(chapterIdx) || 0;
  const inOpening = idx > 0 && idx <= (Number(openingChapters) || 20);
  if (inOpening) {
    return [{
      type: '角色矛盾', severity: 'medium',
      quote: `第${idx}章新增具名实体 ${n} 个`,
      issue: `开篇期（前${openingChapters}章）一章新增 ${n} 个具名实体——读者还没记住核心人物就被新名字砸脸（番茄作家课：开篇先稳住核心角色）`,
      fix: '把可合并的路人/龙套改为无名指代（守门老兵/高台长老式身份称呼），或拆到后续章节登场；只留对主线必需的新名字',
    }];
  }
  if (n >= 4) {
    return [{
      type: '角色矛盾', severity: 'low',
      quote: `第${idx}章新增具名实体 ${n} 个`,
      issue: `本章新增 ${n} 个具名实体，超出读者单章记忆负荷（软提示）`,
      fix: '同上：能无名则无名，非必需的具名角色拆到后续章',
    }];
  }
  return [];
}

/** V0.94.0 跨章比喻复读（精读实证："像一头睡着的东西"ch1/ch7 逐字复现、"灰钉子"跨 3 章同喻、
 *  "月光很细像刀口"ch6/7 复现——V0.93.11 的整句复读检测只拦 ≥15 字整句，拦不住短比喻）。 */
export function detectCrossChapterMetaphors(chapterText, prevChapters = []) {
  const issues = [];
  if (!chapterText || !Array.isArray(prevChapters) || !prevChapters.length) return [];
  const norm = s => String(s || '').replace(/[\s，。！？；：、“”‘’（）《》—…·]/g, '');
  const extract = text => {
    const hits = [];
    const re = /(?:像|如同)[^，。！？\n]{4,30}/g;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) hits.push(norm(m[0]));
    return hits;
  };
  const current = extract(chapterText);
  const seen = new Set();
  for (const prev of prevChapters) {
    const prevSet = new Set(extract(prev?.text || ''));
    for (const phrase of current) {
      if (phrase.length < 6 || seen.has(phrase)) continue;
      if (!prevSet.has(phrase)) continue;
      seen.add(phrase);
      issues.push({
        type: '语句质量', severity: 'medium',
        quote: phrase.slice(0, 30),
        issue: `比喻「${phrase.slice(0, 22)}…」与第${prev.idx || '?'}章重复使用——同一比喻跨章复现，边际感染力归零`,
        fix: '换一个与本章场景绑定的新比喻（换角度/换感官/换喻体），或改为直接白描',
      });
    }
  }
  return issues;
}

/** V0.94.0 接续时间锚点矛盾（精读实证：ch21 十年春禁足→ch23"十一年·禁足第三日"→ch24"十二年·
 *  禁足第三日"，同一次禁足跨三年。接续标记（禁足/养伤第N日、翌日、次日、当夜）与跨年互斥）。 */
export function detectTimelineAnchorConflict({ headText, year, prevYear } = {}) {
  const y = Number(year), py = Number(prevYear);
  if (!Number.isInteger(y) || !Number.isInteger(py) || y <= py) return [];
  const head = String(headText || '').slice(0, 200);
  const markers = [
    /(?:禁足|养伤|闭门|守制|停职)[^，。！？\n]{0,6}第[一二三四五六七八九十\d]{1,2}日/,
    /^(?:翌日|次日|当夜|当晚会|第二日)/,
  ];
  if (!markers.some(re => re.test(head))) return [];
  return [{
    type: '时间线冲突', severity: 'high',
    quote: head.slice(0, 50),
    issue: `章首接续时间标记（${head.slice(0, 16)}…）表示距上一章仅数日，但年份从 ${py} 跳到 ${y}——接续与跨年自相矛盾`,
    fix: `要么去掉接续标记、按跨年章写"次年/${y}年"开篇，要么年份回填为 ${py} 保持接续`,
    proseFix: true,
  }];
}

/** V0.94.0 场景尾部重演（双版本残留的本地形态：精读实证 ch22 场景2尾部写了场景3/4 的救援回营、
 *  ch24 场景4 同一动作演两遍——场景 i 尾部与后续场景 j 存在 ≥18 归一字连续共享游程 → high）。
 *  用"连续游程"而非整体相似度：整段复述是连续文字链，正常顺承只共享零散词（人名/地名）。 */
export function detectSceneTailDuplication(scenes = []) {
  const usable = (scenes || []).filter(s => String(s.content || '').length >= 300)
    .map(s => ({ ...s, content: String(s.content) }));
  const normalized = text => text.replace(/[\s，。！？；：、“”‘’（）《》—…·]/g, '');
  const gramsOf = text => {
    const value = normalized(text);
    const list = [];
    for (let i = 0; i <= value.length - 4; i++) list.push(value.slice(i, i + 4));
    return list;
  };
  const RUN_CHARS = 18; // 连续共享 ≥18 归一字（15 个 4-gram）判为整段复述
  const issues = [];
  for (let i = 0; i < usable.length; i++) {
    const raw = usable[i].content;
    const tailStart = Math.max(0, raw.length - Math.max(200, Math.floor(raw.length * 0.4)));
    const tailGrams = gramsOf(raw.slice(tailStart));
    if (tailGrams.length < 8) continue;
    for (let j = i + 1; j < usable.length; j++) {
      const jValue = normalized(usable[j].content);
      const jPos = new Map();
      for (let k = 0; k <= jValue.length - 4; k++) {
        const g = jValue.slice(k, k + 4);
        if (!jPos.has(g)) jPos.set(g, []);
        jPos.get(g).push(k);
      }
      // 贪心游程：沿 tail 逐 gram 在 j 中找"位置递增"的匹配，统计最长连续链
      let bestRun = 0, bestEnd = -1, run = 0, lastPos = -1;
      for (let t = 0; t < tailGrams.length; t++) {
        const g = tailGrams[t];
        const positions = jPos.get(g);
        if (!positions) { run = 0; lastPos = -1; continue; }
        const next = positions.find(p => p > lastPos && p <= lastPos + 8);
        if (next !== undefined) { run++; lastPos = next; }
        else {
          const restart = positions[0];
          if (restart !== undefined && run === 0) { run = 1; lastPos = restart; }
          else { run = 0; lastPos = -1; }
        }
        if (run > bestRun) { bestRun = run; bestEnd = t; }
      }
      if (bestRun < RUN_CHARS - 3) continue;
      const tailNorm = normalized(raw.slice(tailStart));
      const sharedText = tailNorm.slice(Math.max(0, bestEnd - bestRun - 2), bestEnd + 2);
      issues.push({
        type: '事实矛盾', severity: 'high',
        quote: `${sharedText.slice(0, 40)}……（场景${usable[j].idx}：${usable[j].content.trim().slice(0, 24)}…）`,
        issue: `场景 ${usable[i].idx} 尾部与场景 ${usable[j].idx} 存在 ${bestRun + 3} 字连续复述（「${sharedText.slice(0, 26)}」）——疑似同一事件被写了两遍（双版本残留/场景越界）`,
        fix: '删除前置场景尾部的越界段落，只保留其目标场景版本；前置场景停在本节拍的悬置点',
        proseFix: true, // V0.95.7：本地形态问题正文修订可解（删复述段），不路由 replan 整章重写（ch27 实证 3 轮耗尽卡死）
      });
    }
  }
  return issues;
}

/**
 * V0.93.2 短章下限（确定性）：低于地板返回 belowFloor=true。供管线在结算后记债，不阻断成书（可降级门）。
 * V0.94.0：地板比例 0.4 → 0.75（minFloor 1200→1500）。精读实证：卷2 全卷 2000-2500 字
 * （profile 3500，旧地板 1400 全放行）——"一章只推一件事"的短章在番茄口径下单章获得感
 * 腰斩，是追读掉率主因之一。0.75×3500=2625 与平台建议线（2800-3200）对齐。
 */
export function checkChapterLength(text, { lengthProfile = 3000, minFloor = 1500 } = {}) {
  const hanChars = [...String(text || '')].filter(ch => /[\u4e00-\u9fff]/.test(ch)).length;
  const profile = Math.max(0, Number(lengthProfile) || 3000);
  const floorChars = Math.max(Number(minFloor) || 1500, Math.floor(profile * 0.75));
  return { hanChars, floorChars, belowFloor: hanChars > 0 && hanChars < floorChars, lengthProfile: profile };
}

/** 元话语检测（0 容忍） */
export function detectMetaWords(text) {
  const issues = [];
  const count = (s, needle) => {
    let n = 0, idx = 0;
    while ((idx = s.indexOf(needle, idx)) >= 0) { n++; idx += needle.length; }
    return n;
  };
  for (const w of META_WORDS) {
    let n = count(text, w);
    // V0.93.2 误报修复："一卷一卷"叠词中的"卷一"不是卷号元话语
    if (w === '卷一') n -= count(text, '一卷一');
    if (n <= 0) continue;
    issues.push({
      type: '语句质量', severity: 'medium',
      quote: text.slice(0, 40) + '…',
      issue: `正文出现元话语「${w}」，违反"正文不含写作术语"铁律`,
      fix: '删除该词；正文中不得出现章节编号、写作术语',
    });
  }
  return issues;
}

/** 破折号密度检测（≤20/章，阈值单一真源 REDLINES.dashPerChapter）
 *  V0.93.7：升 medium——写作指令第 11 条量化红线（破折号≤20）写审同源，
 *  此前恒 low 不参与审校 verdict，超限章（实测 ch21=29/ch22=26）照样结算放行。 */
export function detectDashDensity(text) {
  const n = (text.match(/——/g) || []).length;
  if (n > REDLINES.dashPerChapter) {
    return [{
      type: '语句质量', severity: 'medium',
      quote: text.slice(0, 40) + '…',
      issue: `破折号出现 ${n} 次（上限 ${REDLINES.dashPerChapter}，V0.93.4 量化红线），AI 味重`,
      fix: '批量将部分破折号替换为逗号或拆分句子',
    }];
  }
  return [];
}

/** 段落过长检测（>200 字；听书场景 >100 字）
 *  V0.93.7：升 medium——写作指令第 11 条量化红线（段落≤200字）写审同源，
 *  此前恒 low 不参与 verdict（实测存量章仅 0-1 处/章，升档不会造成修订噪声）。 */
export function detectLongParagraphs(text, { limit = REDLINES.paragraphMaxChars } = {}) {
  const issues = [];
  const paras = text.split(/\n+/).filter(p => p.trim());
  for (const p of paras) {
    if (p.length > limit) {
      issues.push({
        type: '语句质量', severity: 'medium',
        quote: p.slice(0, 40) + '…',
        issue: `段落 ${p.length} 字（上限 ${limit}，V0.93.4 量化红线），听书/移动端体验差`,
        fix: '拆分为 2-3 个短段落',
      });
    }
  }
  return issues;
}

/** 情感标签化检测（"他感到愤怒"式直说情绪） */
export function detectEmotionLabels(text) {
  const issues = [];
  const re = /(?:他|她|我|主角|众人)(?:感到|感觉到了|觉得|心头|心中)(?:一阵|一丝|一股)?(?:愤怒|恐惧|悲伤|喜悦|惊讶|不安|紧张|温暖|酸涩|满足|得意|失落)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    issues.push({
      type: '语句质量', severity: 'low',
      quote: m[0],
      issue: `「${m[0]}」是情感标签化写法，应写身体反应`,
      fix: '用身体反应替代：如"他握紧了拳，指节咯吱作响"（愤怒）',
    });
  }
  return issues;
}

/** 比喻陈词滥调（眼睛像星星等）
 *  V0.93.4：新增"像…的眼睛/像一根…的钉子"类句式重复检测——同章 ≥2 处升 medium
 * （参与审校 verdict），1 处不报（单次属正常修辞，避免噪声）。 */
export function detectClichéMetaphors(text) {
  const issues = [];
  const patterns = [
    /眼睛像星星/g, /眼睛像(?:宝石|珍珠)/g, /笑容像阳光/g, /心情像过山车/g,
    /像(?:星星|宝石)一样(?:闪烁|发亮)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      issues.push({
        type: '语句质量', severity: 'low',
        quote: m[0],
        issue: `比喻「${m[0]}」是陈词滥调，建议换具体新奇的比喻`,
        fix: '换用与场景相关的具体比喻，或直接白描',
      });
    }
  }
  // V0.93.4 重复句式比喻：同章同一比喻结构出现 ≥2 次（AI 高频病，意象复读）
  const repeatPatterns = [
    /像一只?[^。！？\n]{1,14}的眼睛/g,
    /像一根[^。！？\n]{0,12}的(?:灰钉子|钉子)/g,
  ];
  for (const re of repeatPatterns) {
    const hits = String(text || '').match(re) || [];
    if (hits.length < 2) continue;
    issues.push({
      type: '语句质量', severity: 'medium',
      quote: hits[0].slice(0, 40),
      issue: `同章比喻「${hits[0].slice(0, 20)}」重复使用 ${hits.length} 次（如"像…的眼睛""像…的钉子"），意象复读显 AI 味`,
      fix: '保留最有力的一处，其余改为直接白描或换用与场景绑定的新比喻',
    });
  }
  return issues;
}

/** 连续重复字符检测
 *  V0.73 修复：AA 式重叠（微微/缓缓/看看/斜斜 等）是中文正常语法，不报"笔误"；
 *  只检测三连及以上异常重复（如"了了了"），拟声/语气词（哈哈哈/呵呵呵）除外。
 *  真正的高频 AI 味由 detectClichés 的「微微/一股/仿佛」频次规则负责，互不干扰。 */
export function detectRepeatedChars(text) {
  const issues = [];
  const re = /([一-鿿])\1{1,}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const ch = m[1];
    const len = m[0].length;
    // V0.73：双连（AA 重叠）是正常中文语法，一律跳过；只报三连以上异常重复
    if (len >= 3 && !['哈', '呵', '嘿', '笑', '呀', '哦', '呃'].includes(ch)) {
      issues.push({
        type: '语句质量', severity: 'low',
        quote: text.slice(Math.max(0, m.index - 5), m.index + m[0].length + 5),
        issue: '「' + m[0] + '」连续重复 3 字以上，疑似笔误或冗余',
        fix: '保留一个或合理重叠，删除多余重复字',
      });
    }
  }
  return issues;
}

// V0.97.2：编辑意见只能存在于指令层，不能伪装成正文或“事实摘要”回灌。
// 规则刻意只抓带写作/结构术语的句子；“他没有回头”“营里没有地图”等正常否定事实不命中。
const EDITORIAL_VOICE_PATTERNS = Object.freeze([
  /(?:正文(?:中|里|不要|不得|应|需|写|出现)|本章(?:写|没有|仍|要|将|中|应|需|只)|下章|下一章|章节(?:安排|结构|衔接|过渡|节拍)|作者|读者|叙事|写作|细纲|大纲|套路|质量门|AI\s*味|精修|修订|无过渡|下一关)/u,
  /(?:神秘记号|替亡父说话|临终遗言|便利线索|线索便利|恰好[^。！？\n]{0,24}(?:地图|线索)|(?:地图|线索)[^。！？\n]{0,24}恰好)/u,
  /(?:不要|不得|禁止|避免|不写成|不能写成|不再靠|不把)[^。！？\n]{0,50}(?:写|剧情|桥段|线索|角色|内应|反派|伏笔|结局|套路)/u,
  /(?:不得|不能|不要|不|须|必须)[^。！？\n]{0,30}(?:预设|由正文|正文推进|凭空写成)|由(?:后续)?正文(?:推进|建立|选择|决定)|神秘(?:路线)?木片/u,
  /没有(?:路线图|密信|物证)[^。！？\n]{0,40}没有[^。！？\n]{0,40}(?:也没有|没有谁)[^。！？\n]{0,50}/u,
]);

function storySentenceUnits(text) {
  return String(text || '').match(/[^。！？!?；\n]+[。！？!?；]?/gu) || [];
}

export function detectEditorialVoiceLeak(text) {
  const issues = [];
  for (const unit of storySentenceUnits(text)) {
    const sentence = unit.trim();
    if (!sentence || !EDITORIAL_VOICE_PATTERNS.some(pattern => pattern.test(sentence))) continue;
    issues.push({
      type: '语句质量', severity: 'medium',
      quote: sentence.slice(0, 80),
      issue: '正文出现编辑/自检话语，叙述者在解释“作者没有怎么写”，会直接暴露生成痕迹',
      fix: '删除编辑判断，只写人物当下能看见、听见、做出的具体事实；写作禁令留在约束层',
    });
  }
  return issues;
}

/** 将摘要/滚动记忆中的编辑句剔除；只做保守句级清理，不改写剩余事实。 */
export function sanitizeStoryMemoryText(text) {
  return storySentenceUnits(text)
    .map(unit => unit.trim())
    .filter(Boolean)
    .filter(unit => !EDITORIAL_VOICE_PATTERNS.some(pattern => pattern.test(unit)))
    .join('');
}

/**
 * V0.97.2 同场事件重启：精修补丁把“接报/出发/治伤”的第二版本接在第一版本后，
 * 逐字复读与跨场相似度均抓不到。仅拦两种高置信形态：日内时间倒退后重新接报，
 * 或同一伤口完整执行两遍“剪衣—清洗—包扎”。
 */
export function detectInSceneEventRestarts(text) {
  const src = String(text || '');
  if (!src) return [];
  const issues = [];
  const timeRank = new Map([
    ['凌晨', 2], ['黎明', 5], ['天明', 6], ['卯时', 6], ['辰时', 8], ['巳时', 10],
    ['午时', 12], ['未时', 14], ['申时', 16], ['酉时', 18], ['黄昏', 19],
    ['天色黑尽', 21], ['入夜', 21], ['夜里', 22], ['深夜', 24],
  ]);
  const anchors = [];
  const timeRe = /凌晨|黎明|天明|卯时|辰时|巳时|午时|未时|申时(?:刚过)?|酉时|黄昏|天色黑尽|入夜(?:以后|之后|后)?|夜里|深夜/gu;
  let match;
  while ((match = timeRe.exec(src)) !== null) {
    const base = match[0].startsWith('申时') ? '申时'
      : (match[0].startsWith('入夜') ? '入夜' : match[0]);
    anchors.push({ index: match.index, label: match[0], rank: timeRank.get(base) });
  }
  for (let i = 1; i < anchors.length; i++) {
    const before = anchors[i - 1];
    const after = anchors[i];
    if (!Number.isFinite(before.rank) || !Number.isFinite(after.rank) || after.rank >= before.rank - 2) continue;
    const firstPart = src.slice(0, after.index);
    const secondPart = src.slice(after.index);
    const reportSignal = /(?:北哨|南哨|传骑|军报|来报|报信|斥候)[^。！？\n]{0,48}(?:报|到|动向|骑|敌)/u;
    const briefingSignal = /(?:交代|下令|撤路|撤退|领命|叫到|叫来|重新)/u;
    if (!reportSignal.test(firstPart) || !reportSignal.test(secondPart)
      || !briefingSignal.test(firstPart) || !briefingSignal.test(secondPart)) continue;
    issues.push({
      type: '事实矛盾', severity: 'high',
      quote: `${before.label}……${after.label}`,
      issue: `同一场景从“${before.label}”倒退到“${after.label}”并重新接报/布置，疑似两个事件版本串接造成事件重启`,
      fix: '只保留一版接报与任务布置；其余段落改为时间顺进的执行结果或删除',
      proseFix: true,
    });
    break;
  }

  const cutCount = (src.match(/剪开[^。！？\n]{0,24}(?:衣|袖|袍)/gu) || []).length;
  const washCount = (src.match(/(?:洗净|洗去|清洗|擦净)[^。！？\n]{0,24}(?:伤口|血|血污)/gu) || []).length;
  const bindCount = (src.match(/(?:布条[^。！？\n]{0,18}(?:扎|缠|包)|(?:扎紧|包扎)[^。！？\n]{0,18}(?:伤口|肩|腿|臂)?)/gu) || []).length;
  if (cutCount >= 2 && washCount >= 2 && bindCount >= 2) {
    issues.push({
      type: '事实矛盾', severity: 'high',
      quote: '同一场景重复出现剪衣、清洗与包扎动作',
      issue: '同一伤口处置流程完整发生两遍，疑似治伤场景双版本残留',
      fix: '保留信息与情绪更完整的一版；另一版只保留尚未表达的新反应，不能重新剪衣包扎',
      proseFix: true,
    });
  }
  return issues;
}

// ============================================================================
// V0.109.3 通用中文 AI 腔检测（ai_flavor.js 消费）
//
// 与上方「网文套话」检测（detectClichés 等，产出 type='语句质量'）的分工：
//   语句质量 —— 词计数口径：「嘴角勾起一抹」出现几次。
//   AI 腔    —— 篇章统计口径：句长分布、段落起伏、连接词密度、抽象度、有无情感与实地。
//
// 为什么另立类型而不是塞进「语句质量」：两者的**修法不同**（换词 vs 重排句式/补具体细节），
// 且分别统计才能知道一部书到底是"用词油"还是"结构像机器"。类型语义见 data/issue_types.js。
//
// 统一护栏：统计型指标对短文本噪声极敏感，低于最小句数/段数一律不判；
// 对白内律动本就更口语化，易误报的维度（的-字、假升华）在对白内豁免。
// ============================================================================

/** 构造一条 AI 腔 issue（统一形状，与既有检测器一致）
 *
 * statistical=true 表示这是**篇章级分布指标**（句长占比/段落均质/连接词密度/情感温度/事实锚点），
 * 而非词句级问题。这个标记有实际作用：返工文风闸（recommendation_recovery.blockingProseIssues）
 * 必须排除它——闸的职责是"候选不能新增词句级 AI 腔"，而局部改写并不会改变整章的句长分布，
 * 把它算进闸会造成"旧稿有一项、候选仍有一项 → 同构不过闸"的批量误杀（项目既有教训即
 * "闸必须与改写单元同职责"，见 recommendation_recovery 里发稿占用轴的同类处理）。
 * 词句级问题（黑话/翻译腔/的字地狱/假升华/万能状语/三段排比）不带此标记，正常参与闸与修订。
 */
function aiFlavorIssue(severity, quote, issue, fix, { statistical = false } = {}) {
  const item = { type: 'AI 腔', severity, quote: String(quote || '').slice(0, 60), issue, fix };
  if (statistical) item.statistical = true;
  return item;
}

/** 按 storySentenceUnits 分句并去掉空白项 */
function aiFlavorSentences(text) {
  return storySentenceUnits(text).map(s => s.trim()).filter(Boolean);
}

/** 句子在原文中的偏移区间（供把正则命中归位到句子，进而按句去重） */
function aiFlavorSentenceSpans(text) {
  const src = String(text || '');
  const re = /[^。！？!?；\n]+[。！？!?；]?/gu;
  const spans = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[0].trim()) spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

function spanIndexAt(spans, pos) {
  for (let i = 0; i < spans.length; i++) {
    if (pos >= spans[i].start && pos < spans[i].end) return i;
  }
  return -1;
}

/**
 * 收集正则型 AI 腔命中，**同一句只报一次**。
 *
 * 为什么必须按句去重：一句话常被多个模式同时命中（如"这一刻他终于明白了这一切的意义"
 * 同时命中 moment-realize / realize-meaning / all-meaning 三条），逐条输出会把一个
 * 根因拆成三条噪声，既抬高 issue 数又让修订工单重复。项目原则是"同一根因的多处证据
 * 合并为一条"（审校指令第 6 条），故此处按句归并。
 */
function collectPatternHits(src, patterns, { skipDialogue = false } = {}) {
  const spans = aiFlavorSentenceSpans(src);
  const seen = new Set();
  const hits = [];
  for (const { re, label } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (skipDialogue && insideDialogue(src, m.index)) continue;
      const si = spanIndexAt(spans, m.index);
      if (si < 0 || seen.has(si)) continue;
      seen.add(si);
      hits.push({ quote: m[0], label });
    }
  }
  // 按出现顺序输出，便于人工核对
  return hits.sort((a, b) => src.indexOf(a.quote) - src.indexOf(b.quote));
}

/** 按空行/换行分段，去掉空白段 */
function aiFlavorParagraphs(text) {
  return String(text || '').split(/\n+/).map(p => p.trim()).filter(Boolean);
}

/** 抽象黑话与抽象大词：叙事里出现商业/管理学词汇即出戏 */
export function detectAbstractJargon(text) {
  const src = String(text || '');
  const hits = [];
  for (const w of [...ABSTRACT_JARGON, ...GRAND_ABSTRACTION, ...HEDGING_WORDS]) {
    let n = 0, idx = 0;
    while ((idx = src.indexOf(w, idx)) >= 0) { n++; idx += w.length; }
    if (n > 0) hits.push({ word: w, n });
  }
  const total = hits.reduce((s, h) => s + h.n, 0);
  if (total < REDLINES.abstractJargonMax) return [];
  const list = hits.map(h => `「${h.word}」×${h.n}`).join('、');
  return [aiFlavorIssue('medium',
    hits[0].word,
    `叙事中出现 ${total} 处抽象黑话/空泛大词（${list}）——这类词只在商业或评论语境成立，写进小说即出戏`,
    '换成本场景的具体动作、器物或数字；抽象评价交给事件自己体现，不由叙述者贴标签')];
}

/** 翻译腔句式：从英文句法直译的框架，中文原生写作不会这么组织 */
export function detectTranslationese(text) {
  const src = String(text || '');
  // 翻译腔框架在谁嘴里都odd，不做对白豁免
  const issues = collectPatternHits(src, TRANSLATIONESE_PATTERNS).map(({ quote, label }) =>
    aiFlavorIssue('low', quote,
      `「${quote.slice(0, 30)}」是翻译腔句式（${label}），中文原生叙述不这样组织`,
      '拆成短句直接说事：删掉框架词，把动作和对象直连'));
  if (issues.length >= 2) issues.forEach(i => { i.severity = 'medium'; });
  return issues;
}

/** "的"字地狱：单句多个"的"层层套叠，是翻译腔与机器生成的共同特征 */
export function detectDeChain(text) {
  const src = String(text || '');
  const issues = [];
  for (const sentence of aiFlavorSentences(src)) {
    const positions = [];
    const re = /的/g;
    let m;
    while ((m = re.exec(sentence)) !== null) positions.push(m.index);
    if (positions.length < REDLINES.deChainMax) continue;
    const at = src.indexOf(sentence);
    // 是否在对白内，要用**跨过阈值的那一个"的"**的位置来判：
    // 引号常开在句中（"他说：'……'），拿句首位置判会漏掉整个对白豁免。
    const probe = at >= 0 ? at + positions[REDLINES.deChainMax - 1] : -1;
    if (probe >= 0 && insideDialogue(src, probe)) continue;
    issues.push(aiFlavorIssue('low', sentence,
      `单句出现 ${positions.length} 个"的"，层层套叠（"的"字地狱）`,
      '拆句或改动词：把修饰关系改成动作句，删掉可有可无的修饰'));
  }
  if (issues.length >= 2) issues.forEach(i => { i.severity = 'medium'; });
  return issues;
}

/** 假升华：在情绪高点用道理/顿悟收束，而不是用画面收束 */
export function detectPseudoSublimation(text) {
  const src = String(text || '');
  // 人物在对话里说"这一刻我明白了"是合法的——只有叙述层用顿悟收束才是 AI 腔
  const issues = collectPatternHits(src, PSEUDO_SUBLIMATION_PATTERNS, { skipDialogue: true })
    .map(({ quote, label }) => aiFlavorIssue('low', quote,
      `「${quote.slice(0, 30)}」是顿悟式升华收束（${label}），道理代替了画面`,
      '删掉顿悟句，改用动作、物件或场景收束——读者记住的是画面不是道理'));
  if (issues.length >= 2) issues.forEach(i => { i.severity = 'medium'; });
  return issues;
}

/** 万能状语：给动作贴抽象情绪标签，用状语代替具体表演 */
export function detectMannerAdverbial(text) {
  const src = String(text || '');
  const issues = collectPatternHits(src, MANNER_ADVERBIAL_PATTERNS).map(({ quote, label }) =>
    aiFlavorIssue('low', quote,
      `「${quote.slice(0, 30)}」是万能状语（${label}）——情绪被状语直接说出，人物没有真的演出来`,
      '删掉状语，用具体的表情、动作或说话内容让情绪自己显形'));
  if (issues.length >= 2) issues.forEach(i => { i.severity = 'medium'; });
  return issues;
}

/**
 * 三段式排比：三连同构短句并列，是机器追求"节奏感"的典型痕迹。
 *
 * 误报风险最高的一条（排比是中文正当修辞），故要求三重机器签名同时成立才报：
 * 三句长度极差 ≤1（人手极少写得完全等长）且同字起头。详见 ai_flavor.js 的规则注释。
 */
export function detectRuleOfThree(text) {
  const src = String(text || '');
  const spans = aiFlavorSentenceSpans(src);
  const seen = new Set();
  const issues = [];
  for (const { re, label } of RULE_OF_THREE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const parts = [m[1], m[2], m[3]].map(p => p.trim());
      const lens = parts.map(p => p.length);
      // 签名②：三句长度极差 ≤1（完全等长的工整并列）
      if (Math.max(...lens) - Math.min(...lens) > 1) continue;
      // 签名③：三句同字起头（机器并行生成的痕迹）
      if (!(parts[0][0] === parts[1][0] && parts[1][0] === parts[2][0])) continue;
      const si = spanIndexAt(spans, m.index);
      if (si < 0 || seen.has(si)) continue;
      seen.add(si);
      issues.push(aiFlavorIssue('low', m[0],
        `「${m[0].slice(0, 34)}」是三段等长同字起头的短句并列（${label}）——工整得不像人写的`,
        '拆掉排比：保留信息最实的一句，其余改成具体动作或直接删'));
    }
  }
  if (issues.length > REDLINES.ruleOfThreeMax) {
    issues.forEach(i => { i.severity = 'medium'; });
  }
  return issues;
}

/**
 * 句式同质化（篇章统计口径）：短句占比过低 / 连续同字起句。
 * 与 detectLongParagraphs（单段字数）互补——这里管的是**句子的节奏分布**。
 */
export function detectSentenceMonotony(text) {
  const src = String(text || '');
  const sentences = aiFlavorSentences(src);
  if (sentences.length < REDLINES.aiFlavorMinSentences) return [];
  const issues = [];

  // 1) 短句占比：全是长句说明节奏板结，没有呼吸
  const lens = sentences.map(s => s.replace(/[\s，。！？；：、“”‘’（）《》—…·]/g, '').length);
  const shortCount = lens.filter(n => n <= REDLINES.shortSentenceMax).length;
  const ratio = shortCount / sentences.length;
  if (ratio < REDLINES.shortSentenceRatioMin) {
    issues.push(aiFlavorIssue('medium',
      sentences[0],
      `短句占比仅 ${Math.round(ratio * 100)}%（${shortCount}/${sentences.length} 句 ≤${REDLINES.shortSentenceMax} 字），通篇长句使节奏板结、无呼吸`,
      '把关键动作与转折拆成短句独立成句；该断的地方断开，长句只留给蓄势与铺陈',
      { statistical: true }));
  }

  // 2) 连续同字起句：连续 ≥3 句以同一字开头，是机器行文的同构痕迹
  let streak = 1;
  for (let i = 1; i < sentences.length; i++) {
    const prev = sentences[i - 1][0];
    const cur = sentences[i][0];
    streak = (prev && cur && prev === cur) ? streak + 1 : 1;
      if (streak >= 3) {
        issues.push(aiFlavorIssue('low',
          sentences.slice(i - 2, i + 1).join(''),
          `连续 ${streak} 句以「${cur}」字开头，句式同构`,
          '调整起句方式：把其中几句改为环境、动作或对话起笔，打散同一领起',
          { statistical: true }));
        break; // 同一根因只报一次
      }
  }
  return issues;
}

/** 段落均质度：各段长度过于接近，是机器排版的整齐感（人手写作段落长短错落） */
export function detectParagraphEvenness(text) {
  const paragraphs = aiFlavorParagraphs(text);
  if (paragraphs.length < REDLINES.aiFlavorMinParagraphs) return [];
  const lens = paragraphs.map(p => p.length).sort((a, b) => a - b);
  const min = lens[0];
  const max = lens[lens.length - 1];
  if (min <= 0) return [];
  const ratio = max / min;
  if (ratio >= REDLINES.paragraphEvennessMin) return [];
  return [aiFlavorIssue('low',
    paragraphs[0],
    `段落长度过于均质（最长 ${max} 字 / 最短 ${min} 字 = ${ratio.toFixed(2)}，低于 ${REDLINES.paragraphEvennessMin}）——` +
    '每段都差不多长，读起来像机器排的版',
    '有意拉长或压缩部分段落：一个动作单独成段，一段环境描写展开写透，让长短形成错落',
    { statistical: true })];
}

/** 连接词密度：整章靠连接词硬接逻辑的程度（次/千字） */
export function detectConnectorDensity(text) {
  const src = String(text || '');
  const chars = src.replace(/\s/g, '').length;
  if (!chars) return [];
  // 密度口径需足够体量才有意义（沿用句数护栏的等效字数尺度）
  if (chars < REDLINES.aiFlavorMinSentences * 10) return [];
  let total = 0;
  const hits = [];
  for (const w of AI_CONNECTORS) {
    let n = 0, idx = 0;
    while ((idx = src.indexOf(w, idx)) >= 0) { n++; idx += w.length; }
    if (n > 0) { total += n; hits.push(`${w}×${n}`); }
  }
  const perK = (total / chars) * 1000;
  if (perK <= REDLINES.connectorPerKCharsMax) return [];
  return [aiFlavorIssue('medium',
    hits[0] || '',
    `连接词密度 ${perK.toFixed(1)} 次/千字，超过 ${REDLINES.connectorPerKCharsMax}（${hits.join('、')}）——靠连接词硬接逻辑`,
    '删掉连接词，让事件顺序与人物动作自己承担因果；段落之间靠场景切换而非"此外/同时"过渡',
    { statistical: true })];
}

/**
 * 情感温度（软信号，恒为 low）：整章叙事完全没有任何情绪承载、主观视角或口语，
 * 说明写的是说明书而不是小说。三支全无才报，避免误伤克制的白描。
 */
export function detectEmotionTemperature(text) {
  const src = String(text || '');
  const sentences = aiFlavorSentences(src);
  if (sentences.length < REDLINES.aiFlavorMinSentences) return [];
  const has = (list) => list.some(w => src.includes(w));
  if (has(EMOTION_LEXICON) || has(SUBJECTIVE_MARKERS) || has(COLLOQUIAL_MARKERS)) return [];
  return [aiFlavorIssue('low',
    sentences[0],
    '整章没有任何情绪承载、主观视角或口语表达——叙事温度为零，读起来像事件说明书',
    '至少给人物一处真实的情绪落点：让情绪从身体反应、说话方式或选择里透出来',
    { statistical: true })];
}

/**
 * 事实锚点（软信号，恒为 low）：整章没有任何具体时间、数量或专名，
 * 全是可以放进任何一本书的抽象概括——读者抓不到"实地"。
 */
export function detectFactAnchor(text) {
  const src = String(text || '');
  const sentences = aiFlavorSentences(src);
  if (sentences.length < REDLINES.aiFlavorMinSentences) return [];
  const hit = FACT_ANCHOR_PATTERNS.some(({ re }) => {
    re.lastIndex = 0;
    return re.test(src);
  });
  if (hit) return [];
  return [aiFlavorIssue('low',
    sentences[0],
    '整章没有出现任何具体时间、数量或地名——全是抽象概括，读者没有可感的实地',
    '给关键的场景与动作一个可数的落点：具体时刻、具体数目、具体地点',
    { statistical: true })];
}

/** 全文规则检查（合并所有规则；可指定重点规则集）。
 *  scope='window' 表示被检文本只是章节内的连续场景窗口：章级构成规则
 *  （对话占比、章末零钩）在窗口粒度上无法满足，强行套用会把低对话场景
 * 的局部改写判成死局（V0.100.14 实测：窗口 0% 对话占比闸死全部返工）。
 *  对话占比因此只在整章粒度判；章末零钩仅当窗口覆盖到章末场景时判。 */
export function runLocalRules(text, { focus, scope = 'chapter', endsAtChapterEnd = true, evidenceThreshold } = {}) {
  if (!text) return [];
  const all = [
    ...detectClichés(text),
    ...detectNotButPattern(text),
    ...detectCommentaryClosers(text),
    ...detectMetaWords(text),
    ...detectDashDensity(text),
    ...detectLongParagraphs(text),
    ...detectEmotionLabels(text),
    ...detectClichéMetaphors(text),
    ...detectDialogueTagDensity(text),
    ...detectRepeatedChars(text),
    ...detectEditorialVoiceLeak(text),
    // V0.94.0：动作母题配额 + 章末零钩（审章级入口调用；场景级片段由 write/audit 自行控制）
    ...detectMotifRepetition(text),
    // V0.95.0：对话占比防线（修仙 ch43-76 式对话空心化零防线补齐）——仅整章粒度
    ...(scope === 'chapter' ? detectDialogueBalance(text) : []),
 // V0.97：推流前精读实证四章级新防线（实测 34 章台账）——章内逐字复读 / 对白偈语配额 /
    // 裸对话连发 / 他她段首密度（章节级检测，内部均有最小规模护栏，场景片段不触发）
    ...detectInChapterRepeats(text),
    ...detectAphorismQuota(text),
    ...detectBareDialogueRuns(text),
    ...detectPronounParaDensity(text),
    // V0.97.1：二次精读实证——“物证自己对答案”与同段数字报表化。
    ...detectEvidenceCertaintyStack(text, { threshold: evidenceThreshold }),
    ...detectNumericDataDump(text),
    ...detectCraftIssues(text),
    // V0.109.3：通用中文 AI 腔（抽象黑话/翻译腔/的字地狱/假升华/万能状语/三段排比/
    // 句式同质化/段落均质/连接词密度/情感温度/事实锚点）。与上方网文套话检测互补不重叠。
    ...detectAbstractJargon(text),
    ...detectTranslationese(text),
    ...detectDeChain(text),
    ...detectPseudoSublimation(text),
    ...detectMannerAdverbial(text),
    ...detectRuleOfThree(text),
    ...detectSentenceMonotony(text),
    ...detectParagraphEvenness(text),
    ...detectConnectorDensity(text),
    ...detectEmotionTemperature(text),
    ...detectFactAnchor(text),
  ];
  if (scope === 'chapter' || endsAtChapterEnd) all.push(...detectWeakEnding(text));
  if (focus && focus.length) return all.filter(i => focus.includes(i.type));
  return all;
}

/**
 * V0.93.11 跨章句子复读检测（纯函数）：本章句子（≥阈值字）逐字出现在前文任一章 →
 * medium（句式/意象复读，AI 味确凿）。doctor 实证：修仙书 ch28/ch33 出现完全相同的句子
 * （"从地底方向传来的，隔着岩层和泥土的过滤，闷得像一声压抑的咳嗽"）。
 * V0.97：阈值 15→12（REDLINES.crossRepeatMinChars 单一真源）——实测精读实证 15 字窗
 * 漏掉 12-14 字级（ch18/19「油灯捻得极低，光只照亮膝前一圈」、ch33/34「收网的计时，从这根旗杆算起」）。
 * 只拦"整句逐字重复"（标点归一后），不拦正常承接、对话呼应或人物口头禅。
 * @param {string} chapterText 本章正文
 * @param {Array<{idx:number,text:string}>} prevChapters 前文各章（调用方给窗口，如前 12 章）
 */
export function detectCrossChapterRepeats(chapterText, prevChapters = []) {
  const issues = [];
  if (!chapterText || !Array.isArray(prevChapters) || !prevChapters.length) return [];
  const minChars = REDLINES.crossRepeatMinChars;
  const sentences = String(chapterText).split(/[。！？\n]/).map(s => s.trim()).filter(s => s.length >= minChars);
  if (!sentences.length) return [];
  const norm = s => String(s).replace(/[\s，。！？；：、“”‘’（）《》—…·]/g, '');
  const seen = new Set(); // 同句在多个前文章命中只报一次
  for (const prev of prevChapters) {
    const prevNorm = norm(prev?.text || '');
    if (!prevNorm) continue;
    for (const s of sentences) {
      const sn = norm(s);
      if (sn.length < minChars || seen.has(sn)) continue;
      if (!prevNorm.includes(sn)) continue;
      seen.add(sn);
      issues.push({
        type: '语句质量', severity: 'medium',
        quote: s.slice(0, 50),
        issue: `本章句子与第${prev.idx || '?'}章逐字重复（${sn.length} 字）：${s.slice(0, 24)}…——句式/意象复读显 AI 味`,
        fix: '改写为新的具体描写（换角度/换细节/换动作/换节奏），同一意象跨章不得原句复现',
      });
    }
  }
  return issues;
}

/**
 * V0.105.8 金句跨章短语复读检测（纯函数）：本章归一化后 ≥goldenPhraseMinChars 的
 * "名台词"短语，逐字出现在近窗前文章 → medium proseFix。
 * 实测三方审读实证：整句级检测（crossRepeatMinChars=12 按句切）抓不到短语级金句
 * 复读——「墙修得再高，也挡不住人心的裂缝」作为完整句出现于 ch49/51/52 ×4 次、
 * 「只要墙不倒，死人就是数字」×4、「你的心是石头做的吗」×3；它们常嵌在变体长句里
 * （前缀"你修的墙，挡得住鞑子，挡不住自己人"），按句切分后归一化文本包含该短语，
 * 但句子本身与原文不同 → 长度闸放过。本检测对章文本做 10 字滑窗子串匹配。
 * 防误报：只匹配归一化后 ≥10 字的连续短语（排除"大人""哨长"类通用词组），窗口内
 * 同一短语多章命中合并为一条 issue 列出全部章号；仅当命中章数 ≥2 才报（单章偶发放行）。
 * @param {string} chapterText 本章正文
 * @param {Array<{idx:number,text:string}>} prevChapters 前文各章（调用方给窗口）
 */
export function detectGoldenPhraseRepeats(chapterText, prevChapters = []) {
  const issues = [];
  const minChars = REDLINES.goldenPhraseMinChars || 10;
  const text = String(chapterText || '');
  if (!text || !Array.isArray(prevChapters) || prevChapters.length < 2) return [];
  const norm = s => String(s).replace(/[\s，。！？；：、“”‘’（）《》—…·！!？?]/g, '');
  const tn = norm(text);
  if (tn.length < minChars) return [];
  const prevNorms = prevChapters
    .map(c => ({ idx: c.idx, norm: norm(c?.text || '') }))
    .filter(c => c.norm.length >= minChars);
  if (prevNorms.length < 2) return [];
  // 10 字滑窗：找出在 ≥2 个前文章都出现的窗口，再扩展到最大公共短语（避免同短语
  // 被重叠窗口拆成多条 issue）
  const reported = new Set();
  for (let i = 0; i + minChars <= tn.length; i++) {
    const win = tn.slice(i, i + minChars);
    const hitChapters = prevNorms.filter(c => c.norm.includes(win));
    if (hitChapters.length < 2 || reported.has(win)) continue;
    // 向两侧扩展成最大公共短语（在前文中的公共出现）
    let best = win;
    for (const c of hitChapters) {
      const at = c.norm.indexOf(win);
      let s2 = at, e2 = at + win.length;
      while (s2 > 0 && e2 <= c.norm.length && tn.includes(c.norm.slice(s2 - 1, e2))) s2--;
      while (e2 < c.norm.length && tn.includes(c.norm.slice(s2, e2 + 1))) e2++;
      if (c.norm.slice(s2, e2).length > best.length) best = c.norm.slice(s2, e2);
    }
    if (best.length < minChars || reported.has(best)) continue;
    reported.add(best);
    const chs = hitChapters.map(c => c.idx).join('/');
    issues.push({
      type: '语句质量', severity: 'medium', proseFix: true,
      quote: best.slice(0, 50),
      issue: `金句跨章复读：本章与前文第${chs}章逐字共用「${best.slice(0, 24)}」短语——名台词/意象被当默认贴片复用，读者可直接感知`,
      fix: '删除或改写为本章独有的表达；同一金句全书至多出现一次，人物口头禅须在角色卡 speech 声明并由检测豁免',
    });
  }
  return issues;
}

/**
 * 场景级确定性检查：用中文字符 4-gram 捕获“同一事件换词重写两遍”。
 * 双阈值 + 最小共享片段可避开仅人物/地点相同的正常承接。
 */
export function runSceneContinuityRules(scenes = []) {
  const boundaryIssues = detectSceneBoundaryFragments(scenes);
  const usable = (scenes || []).filter(scene => String(scene.content || '').length >= 300);
  const normalized = text => String(text || '').replace(/[\s，。！？；：、“”‘’（）《》—…]/g, '');
  const grams = text => {
    const value = normalized(text);
    const set = new Set();
    for (let i = 0; i <= value.length - 4; i++) set.add(value.slice(i, i + 4));
    return set;
  };
  const issues = [
    ...boundaryIssues,
    ...(scenes || []).flatMap(scene => detectInSceneEventRestarts(scene?.content || '')
      .map(issue => ({ ...issue, sceneIdx: scene?.idx ?? null }))),
  ];
  for (let i = 0; i < usable.length; i++) {
    const left = grams(usable[i].content);
    for (let j = i + 1; j < usable.length; j++) {
      const right = grams(usable[j].content);
      let shared = 0;
      for (const value of left) if (right.has(value)) shared++;
      const union = left.size + right.size - shared;
      const jaccard = union ? shared / union : 0;
      const containment = Math.min(left.size, right.size) ? shared / Math.min(left.size, right.size) : 0;
      if (shared < 120 || jaccard < 0.12 || containment < 0.22) continue;
      const leftQuote = String(usable[i].content).trim().slice(0, 60);
      const rightQuote = String(usable[j].content).trim().slice(0, 60);
      issues.push({
        type: '事实矛盾', severity: 'high',
        quote: `${leftQuote}……${rightQuote}`,
        issue: `场景 ${usable[i].idx} 与场景 ${usable[j].idx} 高度重复，疑似同一事件被写了两遍（相似度 ${jaccard.toFixed(2)}）`,
        fix: '分别按各自场景细纲做最小重写；前置场景只完成铺垫，核心事件只在其目标场景发生一次',
      });
    }
  }
  return issues;
}

// ---------- V0.97 推流前精读实证新防线 ----------

/** V0.97 章内逐字复读（S6：生成残留双版本/同信息复讲的本地形态）
 *  三级判定：①整句级（。！？\n 切分）归一化 ≥12 字重复 → medium；②分句级（，；：、再切）归一化
 *  ≥12 字重复 → medium（实证：ch6「没有再把一次猜中当成本事」嵌在不同长句里两刷）；③段内子串级：
 *  同一段落内 ≥6 归一字子串重复 → low（实证：ch16「沿着墙线的走向」句内两刷，删一即可）。 */
export function detectInChapterRepeats(text) {
  const issues = [];
  const src = String(text || '');
  if (!src) return issues;
  const norm = s => s.replace(/[\s，。！？；：、“”‘’（）《》—…·]/g, '');
  const minSentence = REDLINES.inChapterRepeatMinChars;
  const minClause = REDLINES.inChapterClauseMinChars;
  const mediumNorms = []; // 已报 medium 的归一化串（子串级命中若被其覆盖则跳过，同根因不重复报）
  const pushMedium = (display, sn) => {
    mediumNorms.push(sn);
    issues.push({
      type: '语句质量', severity: 'medium',
      quote: display.slice(0, 50),
      issue: `同一句话本章内逐字出现两次以上（${sn.length} 字）：「${display.slice(0, 24)}…」——生成残留双版本/信息复讲`,
      fix: '只留一处；若为第二个人物得知同一信息，只写他的反应，不再复述内容',
    });
  };
  // ① 整句级
  const seenSentences = new Set();
  const reportedSentence = new Set();
  const sentences = src.split(/[。！？\n]/).map(s => s.trim()).filter(Boolean);
  for (const s of sentences) {
    const sn = norm(s);
    if (sn.length < minSentence) continue;
    if (seenSentences.has(sn) && !reportedSentence.has(sn)) {
      reportedSentence.add(sn);
      pushMedium(s, sn);
    }
    seenSentences.add(sn);
  }
  // ② 分句级（不同长句里嵌同一长分句——① 漏网的生成残留形态）
  const seenClauses = new Set();
  const reportedClause = new Set();
  for (const c of src.split(/[，；：、。！？\n]/).map(s => s.trim()).filter(Boolean)) {
    const cn = norm(c);
    if (cn.length < minSentence) continue;
    if (seenClauses.has(cn) && !reportedClause.has(cn)
      && !reportedSentence.has(cn) && ![...reportedSentence].some(s => s.includes(cn))) {
      reportedClause.add(cn);
      pushMedium(c, cn);
    }
    seenClauses.add(cn);
  }
  // ③ 段内子串级（≥6 归一字在同一段内重复出现，取每处最长代表；排比分句天然不同不受影响）
  for (const para of src.split(/\n+/)) {
    const p = norm(para);
    if (p.length < minClause * 2) continue;
    const candidates = [];
    for (let i = 0; i + minClause <= p.length; i++) {
      const maxL = Math.min(24, p.length - i);
      for (let L = maxL; L >= minClause; L--) {
        const sub = p.substr(i, L);
        if (p.indexOf(sub, i + L) >= 0) { candidates.push(sub); break; }
      }
    }
    const kept = [];
    for (const sub of candidates.sort((a, b) => b.length - a.length)) {
      if (kept.some(k => k.includes(sub))) continue;
      if (mediumNorms.some(m => m.includes(sub))) continue;
      kept.push(sub);
    }
    for (const sub of kept.slice(0, 3)) {
      issues.push({
        type: '语句质量', severity: 'low',
        quote: sub.slice(0, 40),
        issue: `短语「${sub.slice(0, 20)}」在同一段落内重复出现——句内复读`,
        fix: '删去重复的一刷，保留信息增量大的那处',
      });
    }
  }
  return issues;
}

/**
 * V0.97.1 场景边界断句：场景是独立生成/修订/回滚单元，正文句子不得横跨两个场景。
 * 实证：实测 ch19-23 多处在“—— / 小小的 / 没有睡”处切场，前端拼接时勉强可读，
 * 但单场修订、历史堆回放或失败重试会留下半句话，是结构性数据事故。
 */
export function detectSceneBoundaryFragments(scenes = []) {
  const rows = (scenes || []).filter(scene => String(scene?.content || '').trim());
  const issues = [];
  // 句号/问叹/省略号，或完整引号结尾，才可作为独立场景的正文终点。
  const terminal = /(?:[。！？!?…]|[”」』’"])[）】》”」』’"]*$/u;
  const nextPunctuation = /^[，、；：。！？!?…—）】》”」』’"]/u;
  for (let i = 0; i < rows.length - 1; i++) {
    const left = String(rows[i].content || '').trim();
    const right = String(rows[i + 1].content || '').trim();
    if (!left || !right || terminal.test(left)) continue;
    const leftTail = left.slice(-32);
    const rightHead = right.slice(0, 32);
    const obviousContinuation = /(?:——|—|[，；：、])$/u.test(left)
      || nextPunctuation.test(right)
      || /^[着了过地得]/u.test(right);
    issues.push({
      type: '事实矛盾', severity: 'high',
      quote: `场景${rows[i].idx ?? i + 1}末「${leftTail}」→场景${rows[i + 1].idx ?? i + 2}首「${rightHead}」`,
      issue: `一句正文断在场景边界${obviousContinuation ? '（前后明显为同一句）' : ''}；场景独立重试或修订会留下半句话`,
      fix: '把完整句子放回同一场景；前场景以完整动作/悬置句收尾，后场景从新的时间、地点或动作起笔',
    });
  }
  return issues;
}

/**
 * V0.101 角色禁腔：只统计带说话人归属的对白。禁腔词出现在别人嘴里不报。
 */
export function detectSpeechForbidHits(text, characters = []) {
  const src = String(text || '');
  const issues = [];
  if (!src || !Array.isArray(characters) || !characters.length) return issues;
  const quoteRe = /([一-龥]{2,4})[^。！？\n]{0,8}(?:说|道|问|喝|骂)[道着了]{0,2}\s*[：:]*\s*[“「]([^”」]+)[”」]/g;
  const attributed = [];
  let match;
  while ((match = quoteRe.exec(src))) {
    attributed.push({ speaker: match[1], quote: match[2] });
  }
  if (!attributed.length) return issues;
  for (const character of characters) {
    const name = String(character?.name || '').trim();
    const raw = character?.speech_forbid || character?.speechForbid || '';
    const terms = String(raw).split(/[|｜、，,;；]/).map(item => item.trim()).filter(item => item.length >= 2);
    if (!name || !terms.length) continue;
    for (const line of attributed) {
      if (line.speaker !== name) continue;
      for (const term of terms) {
        if (!line.quote.includes(term)) continue;
        issues.push({
          type: '语句质量',
          severity: 'medium',
          quote: line.quote.slice(0, 40),
          issue: `角色「${name}」对白踩中禁腔「${term}」——语音卡禁止的腔调会让人物可互换`,
          fix: '按该角色既有说话方式改写这句，不要用其禁腔词或导师格言腔',
        });
      }
    }
  }
  return issues;
}

/**
 * V0.97.1 物证过顺/推理过拟合：只在“痕迹类对象”与“唯一性断言”同句共现时计数。
 * V0.101：阈值随题材偏好 evidenceBound 收紧或关闭。
 */
export function detectEvidenceCertaintyStack(text, { threshold } = {}) {
  const src = String(text || '');
  if (!src) return [];
  const limit = Number.isFinite(Number(threshold)) ? Number(threshold) : REDLINES.evidenceCertaintyDetectMedium;
  if (limit >= 99) return [];
  const evidence = /脚印|蹄印|靴印|压痕|勒痕|刻痕|断口|泥印|木茬|绳纹|竹屑|竹管|地图|图上|路线|烟点|苔|锁眼|铁片|标记/u;
  const certainty = /一模一样|严丝合缝|分毫不差|(?:恰|正)好(?:落|压|指|对|卡|重|合)|只有[^。！？\n]{0,24}才(?:会|能)|不可能|必然|足以证明|由此证明|断定/u;
  const hits = src
    .split(/(?<=[。！？!?])/u)
    .map(sentence => sentence.trim())
    .filter(sentence => evidence.test(sentence) && certainty.test(sentence));
  if (!hits.length) return [];
  const severity = hits.length >= limit ? 'medium' : 'low';
  return [{
    type: '事实矛盾', severity,
    quote: hits.slice(0, 3).map(s => s.slice(0, 48)).join('……'),
    issue: `本章有 ${hits.length} 处自然痕迹直接推出唯一结论，物证过顺、替代解释被省略${severity === 'medium' ? '，因果可信度不足并触发质量门' : ''}`,
    fix: '把痕迹降为方向性线索：至少保留一个替代解释，再由独立旁证、跟踪结果或对手反应完成确认',
  }];
}

/** V0.97.1 数字报表化：只统计“数值+单位”，避免普通序数/口语数字误报。 */
export function detectNumericDataDump(text) {
  const issues = [];
  // “一道光/一声响/一个人/一步步”是中文常规量词，不是数据；只数二以上或阿拉伯数字，
  // 且单位限定为真正承载规模/距离/时刻的信息单位。
  const unitNumber = /(?:\d+|[二两三四五六七八九十百千万]+)(?:人|骑|匹|辆|顶|排|处|路|里|丈|尺|步|指|息|刻|盏|日|月|年|回|枚|层|石|筐|页|根|户|队)/gu;
  for (const para of String(text || '').split(/\n+/).map(p => p.trim()).filter(Boolean)) {
    const tokens = para.match(unitNumber) || [];
    if (tokens.length <= REDLINES.numericTokensPerParagraphMax) continue;
    issues.push({
      type: '语句质量', severity: 'medium',
      quote: para.slice(0, 100),
      issue: `同一段连续抛出 ${tokens.length} 个带单位数字（上限 ${REDLINES.numericTokensPerParagraphMax}），信息呈报表化倾倒，读者难以形成画面`,
      fix: '只保留影响人物选择的 1-3 个数字；其余改成量级、对比或拆进后续动作，侦察记录与正文叙事分开',
    });
  }
  return issues;
}

/** V0.97 章首起手式跨章同质（S1：C4 行文结构同质化的本地形态——14+ 章「天没亮+雾露」开篇）
 *  @param {string} headText 本章正文（取首 80 字判定）
 *  @param {Array<{idx:number,text:string}>} prevHeads 前文各章（各取首 80 字判定，调用方给窗口） */
/** V0.98.14 章首句跨章逐字重合（12 字整句窗对短首句的盲区）：ch32「天还没亮透，营门…」
 *  与 ch28「天还没亮透，露水…」逐字重合仅 5 字前缀，detectCrossChapterRepeats 无法命中——
 *  首句是读者翻页第一眼，句首前缀重合比句中复读更刺眼。判定：本章首句与前章任一首句
 *  句首 ≥5 字逐字重合（前缀语义，防 5 字公共子串误报）。 */
function openerFirstSentence(text) {
  const para = String(text || '').split(/\n+/).map(p => p.trim()).find(Boolean) || '';
  return para.split(/[。！？]/)[0].trim();
}
function openerPlain(text) {
  return String(text || '').replace(/[，。！？、；：…“”‘’（）\s]/g, '');
}
export function detectOpenerRepeat(headText, prevHeads = [], { minChars = 5 } = {}) {
  const first = openerFirstSentence(String(headText || '')).slice(0, 80);
  const plain = openerPlain(first);
  if (plain.length < minChars) return [];
  for (const prev of prevHeads || []) {
    const pPlain = openerPlain(openerFirstSentence(String(prev?.text || '')));
    if (pPlain.length < minChars) continue;
    if (plain.slice(0, minChars) === pPlain.slice(0, minChars)) {
      return [{
        type: '语句质量', severity: 'medium',
        quote: first.slice(0, 40),
        issue: `章首句与前章（第${prev.idx}章）首句句首 ${minChars} 字逐字重合——读者一翻开就是熟悉的开头（短首句 12 字复读窗盲区，V0.98.14 实证）`,
        fix: '首句换动作/声音/物件起手，不复用前章开头句式（如把"天还没亮透"换成事件或声音起手）',
      }];
    }
  }
  return [];
}

/**
 * V0.97 章首起手式族（S1 实证：34 章中 14+ 章「天没亮+雾/露/潮」开篇——行文结构级 AI 味，
 * 读者翻三章就能感觉到。V0.98.14：词表裂口补全后"天还没亮/天未全亮"可命中）。
 * @param {Array<{idx:number,text:string}>} prevHeads 前文各章（各取首 80 字判定，调用方给窗口） */
export function detectChapterOpenerTic(headText, prevHeads = []) {
  const head = String(headText || '').slice(0, 80);
  if (!head || !Array.isArray(prevHeads) || !prevHeads.length) return [];
  for (const fam of OPENER_TIC_PATTERNS) {
    if (!fam.re.test(head)) continue;
    const hits = prevHeads.filter(h => fam.re.test(String(h?.text || '').slice(0, 80)));
    if (hits.length >= REDLINES.openerTicPrevMin) {
      return [{
        type: '语句质量', severity: 'medium',
        quote: head.slice(0, 40),
        issue: `章首起手式「${fam.id}」族在前文已用 ${hits.length} 次（第${hits.map(h => h.idx).join('/')}章）——开篇套路化是行文结构级 AI 味，读者翻三章就能感觉到`,
        fix: '换一种开篇结构：以动作、声音、对话或物件起手，不得复用近章已占用的开篇族',
      }];
    }
  }
  return [];
}

/** V0.103：开篇结构模板饱和——不靠词表禁一族，而拦「与上章同一结构」（如连续 {处所}的风+刀子）。 */
export function detectOpenerStructureSaturation(headText, prevHeads = []) {
  const current = openerStructureTemplate(headText);
  if (!current || current === 'unknown' || current === 'other' || current === 'action') return [];
  const last = [...(prevHeads || [])].sort((a, b) => Number(b?.idx || 0) - Number(a?.idx || 0))[0];
  if (!last) return [];
  const lastTemplate = openerStructureTemplate(last.text);
  if (lastTemplate !== current) return [];
  const first = String(headText || '').split(/\n+/).map(p => p.trim()).find(Boolean) || '';
  return [{
    type: '语句质量', severity: 'medium',
    quote: first.slice(0, 40),
    issue: `章首结构「${current}」与上一章（第${last.idx}章）相同——禁旧开篇族后安全写法会迁到下一模板，近窗必须换起手结构`,
    fix: '换起手结构，不得复用近章已占用的开篇族',
  }];
}

/** V0.97 章末收束意象/句式跨章查重（S2 灰烟明灭 10 章 / S3 亡亲报备 4 章 / S4 记账收束 5 章）
 *  @param {string} text 本章正文（取末段判定）
 *  @param {Array<{idx:number,text:string}>} prevTails 前文各章末段 */
export function detectChapterEndingTic(text, prevTails = []) {
  const paras = String(text || '').split(/\n+/).filter(p => p.trim());
  if (!paras.length || !Array.isArray(prevTails) || !prevTails.length) return [];
  const last = paras.at(-1).trim();
  const issues = [];
  for (const fam of ENDING_TIC_PATTERNS) {
    if (!fam.re.test(last)) continue;
    const hits = prevTails.filter(t => fam.re.test(String(t?.text || '')));
    if (hits.length >= REDLINES.endingTicPrevMin) {
      issues.push({
        type: '语句质量', severity: 'medium',
        quote: last.slice(-40),
        issue: `章末收束「${fam.id}」族与前文章末重复（第${hits.map(h => h.idx).join('/')}章已用）——收束套路化，追读节奏被同一收法令磨平`,
        fix: '收束落到本章专属的具体动作/声音/未接完的话头，不复制前章收束意象与句式',
      });
    }
  }
  return issues;
}

/** V0.97 对白偈语配额 + 叙述偈语变体（S7：导师格言腔全员同嗓——导师型配角共用「不是X是Y」
 *  「X有X的Y」句式。写作侧此前对白内完全豁免（写审脱节），现为对白内设配额：全章合计 ≥3 报
 *  medium（与审校 3.11/3.14 同源）；叙述中「有的要X，有的要Y」总结句 → low（ch4 实证变体补全）。 */
export function detectAphorismQuota(text) {
  const issues = [];
  const src = String(text || '');
  if (!src) return issues;
  const quotes = [];
  let dialogueCount = 0;
  const patterns = [
    { re: /不是[^，。！？\n]{1,24}，(?:而|却)?是[^，。！？\n]{2,24}/g, perceptExempt: false }, // 对白偈语按 X≥1 计（「刀不是刀，是手臂」正是靶形）；辨物式导师格言同样是配额靶子，不豁免
    { re: /([一-鿿]{1,3})有\1的[^，。！？\n]{1,12}/g, perceptExempt: false },
    // V0.98.14 跨句拆分形态（高赞"不是什么笑而是什么笑"）：「不是X。」说者标签「是Y。」
    // 仅跨句形态带感知豁免（听声辨质教学句常拆句）与行为动词门（把消息/有人=价值议论不是辨物）
    { re: /不是([^，。！？\n]{2,16})。([^。！？\n]{0,24})是([^，。！？\n]{2,22})/g, perceptExempt: true },
  ];
  const GENERIC_SUBJ = new Set(['各', '他', '她', '我', '你', '咱', '人']); // 「各有各的」「他有他的」属正常口语
  const spans = []; // 同句/短语 pattern 已占区间——跨句 pattern 不得对同一处重复计数（",而是"同句连接会被跨句中间段吞到）
  for (const { re, perceptExempt } of patterns) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      if (spans.some(s => m.index <= s.end && s.start <= m.index + m[0].length)) continue;
      if (m[1] && GENERIC_SUBJ.has(m[1])) continue;
      // V0.98.14：跨句形态的感知判别豁免（"不是牛叫的声。是风灌进溶洞的呜咽"=听声辨质，合法教学句）；
      // 含行为/需求语义的不是辨物，是价值议论（"不是一把追到沟口的刀。是有人把消息接好"）——
      // 注意不能用裸"把"（量词"一把/两把"误伤辨物豁免）
      if (perceptExempt && PERCEPT_HINT_RE.test(m[0]) && !ABSTRACT_HINT_RE.test(m[0])
        && !/有人|想要|要的|让[^，。！？\n]{0,4}(?:人|他|她)|把消息|接好|传对|传错/.test(m[0])) continue;
      if (!insideDialogue(src, m.index)) continue;
      spans.push({ start: m.index, end: m.index + m[0].length });
      dialogueCount++;
      if (quotes.length < 3) quotes.push(m[0]);
    }
  }
  if (dialogueCount >= REDLINES.dialogueAphorismDetectMedium) {
    issues.push({
      type: '语句质量', severity: 'medium',
      quote: quotes.join('；'),
      issue: `对白内偈语（不是X是Y / X有X的Y）全章 ${dialogueCount} 处（上限 ${REDLINES.dialogueAphorismDetectMedium - 1}）——人物说话像导师点题，道理由事件体现`,
      fix: '偈语只留最有分量的一处，其余改成带口语壳的人话（半截话/反问/答非所问/骂骂咧咧）',
    });
  }
  // 叙述偈语变体：「有的要X，有的要Y」议论腔总结（ch4「有的要躲，有的要守」实证）
  const re = /有的要[^，。！？\n]{1,12}，有的要[^，。！？\n]{0,12}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (insideDialogue(src, m.index)) continue;
    issues.push({
      type: '语句质量', severity: 'low',
      quote: m[0],
      issue: `「${m[0].slice(0, 30)}」是叙述者偈语式总结，应直接写具体的人在做具体的事`,
      fix: '删掉总结句，拆成两个具体画面（谁在躲、谁在守）',
    });
  }
  return issues;
}

/** V0.97 裸对话连发（C5 对白无情绪/无锚点实证：ch5 八句裸问答——读者分不清谁在说话）
 *  纯引号行（整行都在引号内、无动作/神态锚点）连续 ≥4 行 → low，≥6 行 → medium。 */
export function detectBareDialogueRuns(text) {
  const src = String(text || '');
  const lines = src.split(/\n+/).map(l => l.trim()).filter(Boolean);
  if (lines.length < REDLINES.bareDialogueRunLow) return [];
  const isBare = l => /^[“「『"][^”」』"]*[”」』"]?\s*$/.test(l);
  let maxRun = 0, run = 0, runStart = 0, maxStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (isBare(lines[i])) {
      if (run === 0) runStart = i;
      run++;
      if (run > maxRun) { maxRun = run; maxStart = runStart; }
    } else run = 0;
  }
  if (maxRun < REDLINES.bareDialogueRunLow) return [];
  const severity = maxRun >= REDLINES.bareDialogueRunMedium ? 'medium' : 'low';
  return [{
    type: '语句质量', severity,
    quote: lines[maxStart].slice(0, 40),
    issue: `连续 ${maxRun} 行纯引号对白零动作锚点——裸对话连发，读者分不清谁在说话（对白没有情绪锚点是最易被识别的 AI 味）`,
    fix: '为对白穿插动作与神态锚点（谁在说、手在做什么、环境有什么变化），可合并的寒暄轮次删掉',
  }];
}

/** V0.97 他/她/它段首密度软信号（S14/C1 实证：ch4 段首 37%，全书均 8-27%——主语复读
 *  让段落面目雷同。软信号 low，不单独触发修订，供卷体检与审校参考）。 */
export function detectPronounParaDensity(text) {
  const paras = String(text || '').split(/\n+/).map(p => p.trim()).filter(Boolean);
  if (paras.length < REDLINES.pronounParaMinCount) return [];
  const n = paras.filter(p => /^[他她它]/.test(p)).length;
  const ratio = n / paras.length;
  if (ratio < REDLINES.pronounParaStartRatio) return [];
  // V0.98.14：段首主语过半 → medium（参与审校修订）——高赞"他她作主语，一目十行分不清谁在说话"
  const severity = ratio >= REDLINES.pronounParaStartHigh ? 'medium' : 'low';
  return [{
    type: '语句质量', severity,
    quote: `他/她/它段首 ${(ratio * 100).toFixed(0)}%（${n}/${paras.length} 段）`,
    issue: `「他/她/它」段首占比 ${(ratio * 100).toFixed(0)}%${severity === 'medium' ? '，段首主语过半、面目雷同（红线 ' + (REDLINES.pronounParaStartHigh * 100).toFixed(0) + '%）' : '（软信号阈值 ' + (REDLINES.pronounParaStartRatio * 100).toFixed(0) + '%）'}——段首主语复读让段落面目雷同`,
    fix: '段首换人名/物件/动作/环境声起手，同一主语不连续领跑段首',
  }];
}

/** V0.97 章名全书查重（实证：ch34《北望》与 ch8 完全重名——读者目录页无法区分） */
export function detectTitleDuplication(title, otherTitles = []) {
  const t = String(title || '').trim();
  if (!t) return [];
  const dup = (otherTitles || []).map(s => String(s || '').trim()).filter(x => x && x === t);
  if (!dup.length) return [];
  return [{
    type: '大纲偏离', severity: 'medium',
    quote: t,
    issue: `章名《${t}》与全书已有章节完全同名——目录页两章无法区分，须改名`,
    fix: '改为本章实际承载的意象/事件名（与既有章名不重、不近）',
  }];
}

/** V0.97 时间承诺断链（S8 实证：ch16 末台词「明日卯时西校场」→ ch17 开篇跨年，十一个月蒸发；
 *  ch31 末「明日探/三日出发」→ ch32 跨年）。接续锚点检测（detectTimelineAnchorConflict）只认
 *  本章首的「禁足第N日/翌日」，不认前章末的「明日/三日后」承诺——本检测器补上镜像方向。
 *  历史/非历史通用：年份坐标缺失（非历史题材 outline 无 year）时不判。 */
export function detectTimePromiseBreak({ prevTailText = '', year = null, prevYear = null } = {}) {
  const y = Number(year), py = Number(prevYear);
  if (!Number.isInteger(y) || !Number.isInteger(py) || y <= py) return [];
  const tail = String(prevTailText || '').slice(-400);
  if (!tail) return [];
  const m = tail.match(/明日|明早|明天|后天|翌日|次日|两日后|三日后|三天后|两日[内以]|三日[内以]/);
  if (!m) return [];
  return [{
    type: '时间线冲突', severity: 'medium',
    quote: tail.slice(-60),
    issue: `上一章末尾留下「${m[0]}」级时间承诺，本章年份却从 ${py} 跳到 ${y}——承诺被跨年吞掉（读者记得"明日"，翻开是明年）`,
    fix: `要么本章年份回填 ${py} 让承诺兑现，要么前章末承诺改为跨年口径（如"开春/来年"），二选一`,
  }];
}
