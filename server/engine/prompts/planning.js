// 由 prompts.js 拆分而来（V0.109.5）。只搬不改：声明体与拆分前逐字节一致。
'use strict';

import { structureInjection, CONTRAST_BUILDUP_TEXT, COLD_OPEN_CRAFT_TEXT, TITLE_CRAFT_TEXT, VOLUME_TITLE_CRAFT_TEXT } from '../../data/literary_techniques.js'; // V0.83 叙事结构纪律 // V0.85 对比铺垫·先立后破 // V0.98.3 远期楔子·神开局工艺 // V0.107 章卷命名工艺单一真源（书纲/卷纲/细纲/改名四处共用，禁止内嵌第二份）
import { formatPhaseDutyRule } from '.././longform/historical_guardrails.js'; // V0.102.3 阶段任务核验与指令同源：列出可核验动作，不必抄写规划套话

import {
  ENDING_BACKCAST_TEXT,
  ESCALATION_TEXT,
  lengthRequirementText,
  perspectiveText,
} from './common.js';

export function bookOutlineInstruction({ genre, blurb, hook, volumes, genreText, worldScaleText = '', historyAnchors = '', historicalLongformText = '' }) { // V0.76 世界版图阶梯 // V0.81 史实锚定 // V0.91 四十年阶段
  const pack = genreText || '';

  return `请为这部${genre || '玄幻'}小说生成书级大纲。这是设定阶段，请发挥创意但保持结构清晰。

参考方向：${blurb || hook || '（自由发挥）'}${blurb ? '\n注意：参考方向中作者明确给出的核心设定（如：穿越/重生/特定身份/金手指）为硬约束，书名、logline、世界观与分卷必须与之相容，不得丢弃或替换。' : ''}

请输出 JSON（不要输出 JSON 以外的任何内容），格式如下：
{
  "title": "书名",
  "logline": "一句话梗概（30字内，含核心爽点/悬念）",
  "theme": "主题（如：逆袭、守护、复仇）",
  "tone": "整体风格基调（如：热血、轻松、黑暗）",
  "worldview": "世界观要点（力量体系/社会结构/关键矛盾，200字内）",
  "protagonist": {"name": "主角名", "role": "主角身份与初始处境", "goal": "核心目标", "flaw": "性格缺陷", "arc": "成长弧线（能力+心境双线，分阶段）"},
  "main_characters": [{"name": "配角名", "role": "与主角关系/定位", "traits": "性格特点", "secret": "秘密/隐藏身份", "fate": "命运线（如：最终背叛/牺牲/悲剧/圆满，1句）"}],
  "volumes": [
    {"idx": 1, "title": "第一卷名（按下方【卷名工艺】命名，意象化 2-6 字）", "goal": "本卷目标", "summary": "本卷剧情走向（150字内）", "lifecycle_stage": "opening|early_middle|middle|late_middle|ending|finale", "stage_turn": "本卷不可逆阶段转折", "arcs_advanced": [], "arcs_closed": [], "hooks_paid": [], "new_major_arcs": [], "ending_delivery": {}}
  ],
  "golden_first_chapters": "前三章必须达到的效果（黄金三章：第一章立人设+钩子，第二章冲突升级，第三章小高潮+大悬念）"
}
${pack ? '【题材包】' + pack + '\n\n' : ''}${historyAnchors ? '【史实锚定】' + historyAnchors + '\n\n' : ''}${historicalLongformText ? historicalLongformText + '\n\n' : ''}${ENDING_BACKCAST_TEXT}

${VOLUME_TITLE_CRAFT_TEXT}

【长篇连载定位】（V0.44：网文动辄百万字，禁止规划短篇；V0.83：volumeCount 参数真实生效——前 N 卷写完整，后续概要；V0.107 每卷章数科学化——卷是完整叙事弧不是事件碎片）
- 这是长篇连载网文，规划 10-30 卷、每卷 10-16 章，全书规模 80-300 万字（每章约 3000-5000 字）；每卷必须完整走过「铺垫→升级→转折→高潮→余波+下卷钩」的卷级节拍，禁止把一个事件切成两卷、也禁止一卷塞两个互不咬合的大事件；
- volumes 数组**前 ${volumes || 4} 卷写完整**（title/goal/summary 详细，这是近期要写的内容），**后续卷写概要**（title + goal 一句话即可，细节留到卷大纲阶段实时生成）；
- 故事线要有长期纵深：新手村/宗门/中世界/大世界/最终舞台逐级展开，避免两三卷就讲完主线；
- V0.76 世界版图随卷逐级展开${worldScaleText ? `（阶梯：${worldScaleText}）` : ''}：每个阶段对应 1-2 卷，禁止前几卷困在同一小地域，主角成长的每阶段都要踏足更大/更远的舞台；
- 卷与卷之间留钩子（上卷末章问题在下卷解答），主线伏笔跨卷铺设。

【全书生命周期设计】（V0.92：不能只精修前期）
- opening：建立人/地方/核心问题，主角从被动承受转为第一次主动选择；
- early_middle：扩大责任半径，旧目标被抬高或改写，完成一次开篇长期待的阶段兑现；
- middle：发生不可逆中点变轨，旧解法失效，关闭至少一条成熟重要弧线；
- late_middle：多线汇流到最终问题，禁止新增重大主线，开放债务逐卷净减少；
- ending：按既有因果逐项清账，只允许终局推进钩，不得临结局另开新地图/新核心设定；
- finale：最终选择+不可逆代价+核心承诺+主角/关系/世界结果+闭幕意象；末章留余波，不设下一章悬念。
- 每个 volume 都必须填写 lifecycle_stage/stage_turn/arcs_advanced/arcs_closed/hooks_paid/new_major_arcs/ending_delivery；后四项无内容也填 [] 或 {}。

【角色弧光设计】（V0.49：人物是长篇的灵魂，禁止工具人化）
- **主角弧光必须分阶段设计**：arc 字段写清「起点缺陷（附一句成因经历——如'幼年丧母被过继，习惯看人脸色'）→ 每卷的成长节点（能力线+心境线双线并进）→ 终点状态」。示例：起点=自弃逃避的平凡少年 → 卷1-2 求生与责任初醒 → 卷3-4 担当与信任建立 → 卷5-8 抉择与代价 → 后期 释然与自我和解。心境线（恐惧/渴望/自我认知变化）与能力线（战力/身份）同等重要；
- **配角库 5-8 人**（不是 1-2 个工具人）：每个配角写清 secret（秘密/隐藏身份/苦衷）与 fate（命运线——谁中途背叛、谁为谁牺牲、谁求而不得、谁笑到最后），命运线要埋到分卷里逐步兑现；配角各有**独立目标**（为自己的处境/利益/执念而行动，禁止"帮主角查案/阻主角查案"式依附目标）；
- **主要对手/反派必须写清三件**：①独立目标（他为自己要什么——晋升/保位/复仇/护住某人，不是"针对主角"，而是主角刚好挡了他的路）；②退不了的理由（一旦停手会失去什么——权位/亲人/前功尽弃，这让他无法收手）；③局部正确（他与主角各执一词的那一点——主角求真相他维秩序，错的是各自愿意牺牲什么；让读者"不认同他，但理解他"）；
- 主角必须有**内在弱点**（flaw 不只是"穷/弱"，而是性格层面的：逃避、自卑、多疑、傲慢等），弱点要在后续章节中被反复挑战并缓慢克服；
- 主角与现实世界（如：穿越前身份/原生家庭/未了心愿）的**情感羁绊**是重要资产，设计 1-2 条贯穿全书的感情线/亲情线/师友线。
请输出 JSON。`;
}

/** V0.81 历史时代背景卡指令（era_context：真实事件/人物/官职/地理/经济/礼法/时代红线/可改史点） */

/** V0.81 历史时代背景卡指令（era_context：真实事件/人物/官职/地理/经济/礼法/时代红线/可改史点） */
export function eraContextInstruction({ bookTitle, genre, era, seed }) {
  return `你是历史考据专家。为历史题材小说《${bookTitle}》（${genre}）生成"时代背景卡"——写作时用得上、能防时代错误的历史质感要点。
【参考考据种子】
${seed || '（无）'}
【任务标识】历史时代背景卡生成

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "era": "时代定位（朝代+年份范围+主要年号）",
  "real_events": ["按时间顺序的真实历史事件（年份+事件，供"史实骨架"锚定）"],
  "real_people": [{"name": "真实人物名", "role": "身份", "fate": "历史结局/立场"}],
  "figures": [{"name": "人物名", "aliases": ["别称/封号"], "firstYear": 首次登场/上任的公元年, "deathYear": 史实卒年或null, "office": "主要官职", "stance": "立场/关键行为", "constraint": "与主线交集约束（如'1254年后知合州'）", "alterable": "架空可塑性（高=可由因果改变结局/低=硬史实）"}],
  "offices": "本时代官职体系（宰执/枢密/三衙/制置使/都统制等，可含品阶）",
  "military": "本时代军制与战争特点（兵种/指挥链/攻城/后勤/火器）",
  "geography": "关键地理（山河险要/行军路线/城防要点）",
  "economy": "经济赋税（货币/粮价/专卖/苛税）",
  "ritual": "礼法习俗（避讳/尊称/冠服/科举/婚丧）",
  "red_lines": ["本时代绝无的器物/词汇（防时代错误）"],
  "alterable_history": "可改史点（真实历史可被主角改变的"后果"，不可改"前因"）"
}
要求：真实事件人物按史实；figures 覆盖本时代登场的关键历史人物（帝王/权臣/将帅/忠义名臣，8-15 人），每人给出首次登场年份与卒年（不确定标注 null）——供"人物登场窗"逐卷注入与时间错位校验；这是"写作参考"，不是正文；每项精炼（一句话级别），不要长篇考据论文。
请输出 JSON。`;
}

/**
 * V0.80 前20章开篇蓝图指令（番茄签约导向：钩子阶梯/爽点节奏/金手指上线/目标阶梯/承诺期限）
 * 治本：平凡少年修仙第1章写平凡少年日常无事件、前10章无战斗爽点、金手指迟迟不明确——
 * 顶层必须有"前20章环环相扣"的结构化蓝图，逐章注入细纲与正文。
 */

/** 卷大纲生成指令（V0.74 成长题材感知 + V0.76 世界观阶梯展开题材感知） */
export function volumeOutlineInstruction({ bookTitle, volumeIdx, volumeTitle, bookOutline, chapterCount, protagonistPower = '', growthDimension = '', growthExample = '', remedyText = '', worldExpansion = '', worldRemedyText = '', pleasurePlanText = '', eraContext = '', historyGrowthNote = '', styleRules = '', warfareText = '', courtText = '', volumeBuildupText = '', historicalPhaseText = '', lifecycleText = '', endingBlueprintText = '', seamText = '' }) { // V0.87 战争卷战役纪律 // V0.88 权谋卷朝堂纪律 // V0.90 开篇卷先立后破结构 // V0.91 四十年阶段 // V0.92 生命周期 // V0.102 卷缝
  const lifecycleStage = lifecycleText.match(/阶段ID[：:]\s*(opening|early_middle|middle|late_middle|ending|finale)/)?.[1] || '';
  const endingRunway = lifecycleStage === 'ending' || lifecycleStage === 'finale';
  const convergenceRunway = lifecycleStage === 'late_middle' || endingRunway;
  const endRhythmRule = lifecycleStage === 'finale'
    ? '终章不得设置下一章悬念；完成余波、人物与世界结算后，以闭幕意象结束'
    : lifecycleStage === 'ending'
      ? '卷末只允许推动既定终局的钩子，禁止另开新主线、新敌人或新地图悬念'
      : lifecycleStage === 'late_middle'
        ? '卷末钩子必须服务既有主线汇流，禁止用无关新谜团拖延进入收尾'
        : '卷末是否留钩服从本阶段职责；有钩时必须能在后续规划中明确承接';
  const growthPlanning = endingRunway
    ? `【成长弧结算】（收尾阶段不再机械升级，而是用最终选择与代价证明成长）
- 把${growthDimension || '主角成长'}落实为决策、承担、取舍与传承；禁止为了制造“还有下一阶”而临时增加能力等级；
- 至少在具体章节 beat 中安排一次“成长验证”或“成长结算”：主角以已经获得的能力处理终局，并承担不可逆代价；
- 终卷须交代主角最终成为怎样的人，以及这种成长如何改变关系与世界。`
    : `【成长规划】（V0.74：网文成长线硬要求——${growthDimension || '主角成长'}必须逐卷推进，禁止整卷原地打转）
- 基于【主角成长状态】安排本卷的${growthDimension || '成长'}阶梯：在卷内适当的章节写清主角成长进展（沿成长阶梯推进，如：${growthExample || '入门→进阶→高阶'}），每卷至少推进 1-2 个小阶段；
- 成长节点要落到具体章节的 beat 中（标注"成长突破"），且与剧情冲突结合（在实战/危机/事件中突破，让突破有代价、有爽点）；
- 主角当前状态若显示停滞（长期无进展），本卷**开篇几章就必须先解决成长瓶颈**，不得继续只推进解谜/调查/日常线。`;
  const worldPlanning = worldExpansion
    ? convergenceRunway
      ? `
【世界线汇流规划】（中后期起优先合并既有战场，停止为扩张而扩张）
${worldExpansion}
- 本卷应让既有区域、既有战场与既有势力发生因果汇流；不强制开启新区域。
- 只有终局因果不可替代时才可短暂引入新地点，且不得由此新增独立主线、长期敌人或续作式悬念。
`
      : `
【世界展开规划】（V0.76 硬约束：世界版图必须随剧情逐级展开，禁止整卷困在同一小地域）
${worldExpansion}
- 本卷必须把故事舞台推进到下一区域层级，新区域/新势力要落到具体章节的 beat 中（标注"新区域"），写明主角如何抵达、该层级带来的新冲突与新资源；
- 禁止本卷全部章节仍在既有小地域内打转；若本卷确需铺垫过渡，卷末必须出现下一层级的新区域或新势力引入。
`
    : '';
  return `请为《${bookTitle}》第${volumeIdx}卷「${volumeTitle}」生成卷大纲。
${volumeIdx > 1 && !endingRunway ? '\n' + ESCALATION_TEXT + '\n' : ''}
${protagonistPower ? '\n' + protagonistPower + '\n' : ''}
${remedyText ? '【成长补救桥段（本卷必须落实）】' + remedyText.slice(0, 800) + '\n' : ''}
${worldRemedyText ? '【世界展开补救桥段（本卷必须落实）】' + worldRemedyText.slice(0, 800) + '\n' : ''}
${pleasurePlanText ? '【全书快感节奏（卷内章节 beat 须对齐）】' + pleasurePlanText + '\n' : ''}
${eraContext ? '【时代背景（史实锚点/官职/地理/红线——本卷卷内章节须贴合）】' + eraContext.slice(0, 700) + '\n' : ''}
${historyGrowthNote ? historyGrowthNote + '\n' : ''}
${styleRules ? styleRules + '\n' : ''}
${warfareText ? warfareText + '\n' : ''}
${courtText ? courtText + '\n' : ''}
${volumeBuildupText ? volumeBuildupText + '\n' : ''}
${historicalPhaseText ? historicalPhaseText + '\n' : ''}
${lifecycleText ? lifecycleText + '\n' : ''}
${endingBlueprintText ? endingBlueprintText + '\n' : ''}
${seamText ? seamText + '\n' : ''}
${TITLE_CRAFT_TEXT}
${VOLUME_TITLE_CRAFT_TEXT}

书级大纲相关部分：
${JSON.stringify(bookOutline, null, 2)}

本卷计划 ${chapterCount || 12} 章（章数服务于卷级节拍：铺垫段收紧（约四分之一）、发展与升级展开（约二分之一）、转折/高潮给足（不少于四分之一）、余波+下卷钩短促收束（1-2 章）；章数不是事件的均匀切片）。请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "title": "卷名（按上方【卷名工艺】命名：意象化 2-6 字，从本卷核心转折/主导意象取材；历史卷可用书纲卷名/阶段主题词作材料重新提炼，不必照抄）",
  "goal": "本卷要达成的叙事目标",
  "arc": "本卷剧情起承转合说明（200字内）",
  "lifecycle_stage": "opening|early_middle|middle|late_middle|ending|finale（必须与全书生命周期合同一致）",
  "stage_turn": "本卷必须发生且产生不可逆后果的阶段转折",
  "arcs_advanced": ["本卷推进的既有弧线原名"],
  "arcs_closed": ["本卷计划闭合并由正文证明的弧线原名"],
  "hooks_paid": ["本卷计划兑现的既有伏笔/长期待原名"],
  "new_major_arcs": ["本卷新增重大主线；无则[]，不得超过阶段额度"],
  "ending_delivery": {"final_opposition": "收尾/终卷填写", "final_choice": "收尾/终卷填写", "irreversible_cost": "收尾/终卷填写", "core_promise_payoff": "终卷填写", "protagonist_settlement": "终卷填写", "relationship_settlements": ["终卷填写"], "world_settlement": "终卷填写", "historical_settlement": "终卷填写或不适用", "closing_image": "终卷填写", "last_chapter_mode": "终卷填写"},
  "chapters": [
    {"idx": 1, "title": "第1章标题（按上方【章名工艺】命名：4-8 字为主、3-10 字为界；全卷句式族轮换——连续 3 章不得同为极简名词/四字格/动宾等同一族）", "beat": "本章核心事件与冲突（80字内）", "pov": "视角角色"${historicalPhaseText ? ', "year": 1241, "era_year": "淳祐元年", "protagonist_age": 9, "phase": "本章阶段任务", "reward_mode": "本章给读者的回报类型", "emotion": "主情绪及强度"' : ''}}
  ]
}
每章 beat 要具体到"谁在哪里做了什么、冲突是什么、留下什么钩子"。
历史卷的 phase 必须是本章可在 scene.beat 落地的人物行动（如「百姓进寨」「北崖请领」），禁止写「接住上卷出口」「成长补救」「卷级转折」等规划套话。

【叙事结构要求】（转折与节奏设计）
- 卷级转折**按需设计、由你判断**：评估本卷情节的自然走向，仅当剧情确实需要身份/立场/世界规则/关系网的重大变化时才设置转折，并写明引爆章、铺垫章、连锁反应；铺垫卷/过渡卷/收束卷**可以不设卷级转折**，但每章必须有"推进感"（事件让局面/关系/认知发生可感知的变化），不得原地打转
- 卷内节奏：铺垫章与释放章交替，连续紧张不超过 3 章；${endRhythmRule}
- 每 10-15 章安排"小高潮结算"（兑现旧账/伏笔）；本卷不足 10 章时至少 1 次"阶段小结算"
- 每次高潮结算落成 1 个可转述的名场面：谁、在哪个有名字的地方、做什么决定性动作、规模或代价可数（"斩获三百级"而非"大获全胜"）；名场面的地点与器物要在铺垫章先出现——名场面是既有意象的收束，不是临时空降的新舞台
- 插叙/倒叙仅用于揭示身份或解释动机，单次不超过 1 场景，全书不超过 3 次；使用处须在 beat 中标注"（倒叙）"

【情感弧设计】（V0.49：人物情感与事件推进并行，禁止纯事件流水账）
- 本卷**至少安排 1 个情感事件**（从：离别/重逢/失去/背叛/牺牲/和解/误会与澄清/情感转折 中选择），把它写进对应章节的 beat（标注"情感事件"），并写明它如何改变主角或配角的心境/关系；
- 主角在情感事件中必须暴露内心（挣扎/愧疚/恐惧/温暖），不只是"事情发生了"；
- 卷内章与章之间要体现人物关系的渐变（如：信任建立→裂痕→修复），禁止每章人物关系原地不动；
- 若本卷是铺垫卷/过渡卷，情感事件可选小型的（如：一次和解、一次坦白），但不得整卷无任何情感变化。

${growthPlanning}
${worldPlanning}
请输出 JSON。`;
}

/**
 * 章细纲生成指令（章节任务单合同化：承接/铺垫/兑现/禁忌）
 * @param {object} ctx { bookTitle, chapterIdx, volumeGoal, recentSummaries, rollingSummary, activeForeshadows, forgottenForeshadows, approachingForeshadows, retrieved, prevChapterTail, futureChapters }
 */

/**
 * 章细纲生成指令（章节任务单合同化：承接/铺垫/兑现/禁忌）
 * @param {object} ctx { bookTitle, chapterIdx, volumeGoal, recentSummaries, rollingSummary, activeForeshadows, forgottenForeshadows, approachingForeshadows, retrieved, prevChapterTail, futureChapters }
 */
export function chapterOutlineInstruction(ctx) {
  const { bookTitle, chapterIdx, volumeGoal, recentSummaries, rollingSummary, activeForeshadows, forgottenForeshadows, approachingForeshadows, retrieved, prevChapterTail, futureChapters, pleasureContext, narrativeLessons = '', rollCallText = '', perspective = 'third', chapterLength = 3200, powerStatus = '', growthDimension = '成长维度', growthExample = '', worldExpansion = '', openingBlueprint = '', eraContext = '', historyDeAI = '', poetryText = '', eraBoundary = '', styleRules = '', prevContinuityTo = '', reconcileSeed = null, lockedChapterFrame = null, contrastBuildup = '', warfareText = '', courtText = '', historicalChapterFrame = '', lifecycleText = '', endingBlueprintText = '', finalChapterMode = false, prevHookType = '', scaleBeatRule = '', openingContractText = '', horizonText = '', diversityText = '', stageOccupancyText = '' } = ctx; // V0.100：返工同版规划种子/作者锁；V0.102 长线简报；V0.103 近窗换轴
  const recent = recentSummaries?.length
    ? recentSummaries.map(s => `第${s.idx}章《${s.title}》：${s.summary || s.beat || '（无摘要）'}`).join('\n')
    : '（无）';
  const hooks = activeForeshadows?.length
    ? activeForeshadows.map(f => {
      // V0.20 修复：events 存于 events_json 列（DB 行无 events 字段）
      let evLen = 0;
      try { evLen = JSON.parse(f.events_json || '[]').length; } catch { /* ignore */ }
      return `- [${f.id}] ${f.desc}（状态：${f.status}${f.payoff_chapter ? `，计划回收于第${f.payoff_chapter}章` : ''}${evLen ? `，已推进：${evLen} 次` : ''}）`;
    }).join('\n')
    : '（无）';
  const forgotten = forgottenForeshadows?.length
    ? `\n注意：以下伏笔已超期未回收，本章或近期必须处理：\n${forgottenForeshadows.map(f => `- [${f.id}] ${f.desc}（计划回收于第${f.payoff_chapter}章）`).join('\n')}`
    : '';
  const approaching = approachingForeshadows?.length
    ? `\n提示：以下伏笔临近回收章（≤2 章），本章可开始收束铺垫：\n${approachingForeshadows.map(f => `- [${f.id}] ${f.desc}（计划第${f.payoff_chapter}章回收）`).join('\n')}`
    : '';
  const rel = retrieved?.length ? retrieved.join('\n') : '（无）';
  const prevTail = prevChapterTail ? `第${chapterIdx - 1}章结尾：${prevChapterTail.slice(0, 300)}` : '（第一章，无需承接）';
  const future = futureChapters?.length ? futureChapters.map(f => `第${f.idx}章《${f.title}》：${f.beat || ''}`).join('\n') : '（无）';
  const pleasure = pleasureContext ? `\n${pleasureContext}\n` : '';
  const youthAge = Number((String(historicalChapterFrame || '').match(/主角\s*(\d{1,2})\s*岁/) || [])[1]);
  const youthAuthorityRule = Number.isFinite(youthAge) && youthAge < 16
    ? `【少年权限硬规则】主角${youthAge}岁，暗门准确位置、军情原图与销毁权限必须由具名成人保管和复核；少年只能接触任务必需的公开工序或局部信息。对成年工役/军卒的分组、调度与号令必须由成人批准并正式下令，少年只能提出观察、记号、复诵、报时、传讯或守绳。\n`
    : '';
  // V0.93.3 阶段任务落实硬要求：本地硬防线（historicalOutlineIssues）会逐字核查"阶段任务核心词
  // 是否连续出现在 scene.beat 与 checkpoints 中"，模型此前不知道这条校验存在，重规划候选连败。
  // 这里把校验口径原样写进指令（写审同源），让模型按可被验证的方式落实。
  const framePhase = String(historicalChapterFrame || '').match(/阶段：([^｜|]+)/)?.[1]?.trim() || '';
  const phaseDutyRule = formatPhaseDutyRule(framePhase);

  return `请为《${bookTitle}》第${chapterIdx}章生成细纲（章节任务单）。

${perspectiveText(perspective, '', 'outline')}

【最近剧情】
${recent}

【全书进度】${rollingSummary || '（新书）'}

【上一章结尾（必须自然承接）】
${prevTail}

${horizonText ? horizonText + '\n' : ''}
${stageOccupancyText ? stageOccupancyText + '\n' : ''}
【上一章细纲的"为后续铺垫"承诺】（本章应承接兑现）
${prevContinuityTo || '（无）'}

${reconcileSeed ? `【同版规划种子（返工后重新取证，优先于任何旧计划）】
承接当前事实：${reconcileSeed.bridge_from_actual || ''}
本章目标：${reconcileSeed.goal || ''}
核心冲突：${reconcileSeed.conflict || ''}
应给读者的具体回报：${reconcileSeed.reader_gain || ''}
自然延续力：${reconcileSeed.reader_pull || ''}
请把这五项转化为有人物选择和因果转折的正式细纲，不要机械复述字段。` : ''}
${lockedChapterFrame && Object.keys(lockedChapterFrame).length ? `【作者锁与固定坐标（不得改写）】
${JSON.stringify(lockedChapterFrame)}` : ''}

【未来剧情预告】（本章不得提前兑现/剧透这些内容，但可为它们埋伏笔）
${future}

【活跃伏笔】（有界子集，本章应呼应/推进/回收其中相关者；禁止另开新坑代替队列里的旧账）
${hooks}${forgotten}${approaching}

【检索到的相关前文事实】
${rel}

【当前卷目标】${volumeGoal || '（无）'}
${powerStatus ? powerStatus + '\n' : ''}${rollCallText ? rollCallText + '\n' : ''}${pleasure ? pleasure + '\n' : ''}
${narrativeLessons ? narrativeLessons + '\n' : ''}
${powerStatus ? '【成长进展硬要求】本章细纲必须在 goal/conflict 或某个 scene.beat 中安排主角在成长维度（' + growthDimension + '）上的实质进展（沿成长阶梯推进：' + (growthExample || '逐步升级') + '），不得整章只推进事件而无任何成长。主角长期无成长 = 读者流失。' : ''}
${worldExpansion ? worldExpansion + '\n' : ''}
${openingBlueprint ? '【前20章开篇蓝图·本章槽位（硬约束：细纲必须落实）】' + openingBlueprint + '\n' : ''}
${openingContractText ? openingContractText + '\n' : ''}
${historicalChapterFrame ? '【历史章节坐标（硬约束，所有场景必须服从）】' + historicalChapterFrame + '\n不得更改公元年、年号、主角年龄、阶段任务、阅读回报类型和情绪功能。\n' : ''}
${phaseDutyRule}
${scaleBeatRule ? scaleBeatRule + '\n' : ''}
${youthAuthorityRule}
${historicalChapterFrame ? '【历史连续性硬规则】未防腐遗体不得跨季、跨年仍保持可辨面容或肢体；须及时安葬/火化，跨时段只能携骨殖、骨灰或纪念物。真实人物的官职、到任年与统辖权不得提前；不确定时改用已登记的虚构基层负责人，不得猜任职。\n' : ''}
${lifecycleText ? lifecycleText + '\n' : ''}
${endingBlueprintText ? endingBlueprintText + '\n' : ''}
${finalChapterMode ? '【最后一章模式（最高优先级）】本章必须完成“终局余波→关键人物安顿→世界/时代落点→主题回声→闭幕意象”；不得开启新主线、不得再要求下一章承接。ending_hook 必须为 null；continuity_to 写“全书已收束，无下一章铺垫”。\n' : ''}
${eraContext ? '【时代红线/可改史点（本章不得触犯红线，可借可改史点推进）】' + eraContext + '\n' : ''}
${eraBoundary ? eraBoundary + '\n' : ''}
${historyDeAI ? historyDeAI + '\n' : ''}
${poetryText ? poetryText + '\n' : ''}
${contrastBuildup ? contrastBuildup + '\n' : ''}
${warfareText ? warfareText + '\n' : ''}
${courtText ? courtText + '\n' : ''}
${styleRules ? styleRules + '\n' : ''}
${prevContinuityTo ? '【上一章铺垫（本章须承接兑现，不得悬空）】' + prevContinuityTo + '\n' : ''}
${TITLE_CRAFT_TEXT}
${structureInjection()}
请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "title": "章节标题（按上方【章名工艺】：4-8 字为主、3-10 字为界；半遮不剧透；意象必须本章有落点；与同卷近 3 章不同句式族；禁止动作直述（夜探/夜袭/突破/逃离等）、禁止事件流水账、禁止与同卷其他章重名或雷同）",
  "pace": "advance|setup|payoff|daily（章节节奏定位：advance=主线推进/事件为主；setup=铺垫/人物与伏笔为主；payoff=收束/情感结算；daily=日常/烟火气）",
  "goal": "本章叙事目标（一句话；主角在${growthDimension}有实质进展时必须写明具体进展）",
  "conflict": "核心冲突",
  "dramatic_question": "本章要用行动推进的核心追问；不能只写主题",
  "counterforce": "有目标、有动作、会反推局势的反作用力；可以是人物、制度、时限、环境或内心两难",
  "turn": "使人物原计划失效或意义改变的具体转折",
  "irreversible_change": "章末相对章初无法无成本复原的变化",
  "choice_cost": "人物主动选择了什么，并实际失去/承担什么",
  "reader_gain": "读者本章明确得到的结果、信息、情绪或关系变化；不是‘埋伏笔’三个字",
  "reader_pull": "由本章因果自然产生的下一步动力，可为未完动作、疑问、关系余波、选择后果、信息差、局势变化或阶段性余韵",
  "continuity_from": "承接上一章结尾的状态/悬念（一句话）",
  "continuity_to": "本章为后续章节埋下的铺垫/伏笔（一句话）",
  "obligations": ["本章必须兑现：如回收某伏笔、呼应某约定、实现某目标"],
  "forbidden": ["禁忌硬约束：如某角色不得登场、不得新增某类设定、不得提前揭示某真相"],
  "scenes": [
    {"id": "s1", "pov": "视角角色名", "location": "地点", "scene_type": "fight|emotion|suspense|dialogue|climax|daily|reveal", "pacing": "铺垫|推进|爆发|余韵（场景节奏定位：爆发=短句急促冲突引爆；推进=中速信息与对抗交替；铺垫=慢速蓄力埋细节；余韵=长句慢镜头沉淀。同章各场景 pacing 应有分布，不得全部『推进』）", "beat": "场景节拍：谁在哪做了什么、发生什么、有何张力", "target_words": 1000}
  ],
  "foreshadows_used": ["引用的伏笔id，没有则[]"],
  "new_hooks": ["本章计划埋设的新伏笔描述，没有则[]"],
  "ending_hook": ${finalChapterMode ? 'null' : 'null 或 {"desc": "正文确实新产生的具体未决事件；若 reader_pull 已由选择后果/关系余波/阶段性收束承担，则填 null，不得硬塞陌生人、密信、烟火或脚步声", "type": "疑问|关系|抉择|信息差|局势|危机", "intensity": 1-5}'},
  "character_beat": {"character": "本章人物戏主角（人物名，pace=advance 时可省略）", "inner_change": "内心/心境变化点（或关系进展/配角高光，30字内）", "relation_delta": "与其他角色的关系变化（无则'无'）"},
  "checkpoints": ["本章必须覆盖的 3-5 个细纲要点，供事后校验"]
}
要求：${lengthRequirementText(chapterLength)}每个场景必须标注 scene_type（战斗/情感/悬念/对话/高潮/日常/揭示）与 pacing（铺垫/推进/爆发/余韵），场景类型需有变化（勿全部同型）；场景之间必须有因果递进或意义转折，禁止"主角刚获胜/刚解密，下一场景即若无其事"的平转；${finalChapterMode ? '结尾场景完成主题回声与闭幕意象，不留下一章动力；' : '结尾必须兑现 reader_pull，但不要求每章制造危机或悬崖；不推进与卷目标无关的支线。'}**细纲要具体详实**（V0.58：每场景 beat 100-150 字，写清人物动机、冲突与转折，为正文提供充分依据；整体控制在 4000 tokens 内即可）。
【checkpoints 写作纪律】（V0.85：防覆盖校验永不收敛卡章）
- checkpoints 写"事件/意象/人物/情感"类要点（如"陈烈记住蒙军旗号"），**禁止写"必须出现某原句/逐字复刻"类要点**（正文可以用自己的语言呈现等价表达）；
- 历史章节坐标给出“阶段任务”时，至少一个 checkpoint 和一个 scene.beat 必须安排该任务在正文中实际发生，不得用别的高光事件替换；
- 每项要点一句话、可独立判断，3-5 项为宜；不写与本章主线冲突的要点。
【人物行动逻辑（V0.108）】配角与对手在场景 beat 中的行动须源于其自身目标/处境/利益（角色卡可见者按卡行动），不是为主角送剧情——对手在场的场景写清"他要什么、为什么此时出手"；配角带着自己的事出场（哪怕只推一小步），不做纯递情报/挡刀的工具人。
【新角色登记硬约束】（V0.78：防"细纲引入未登记角色→正文写它→审校报编造→无限循环"）
- 细纲中若需要引入【当前出场角色】点名册里没有的新人物（如某个监视者/杂役/新对手），**必须在对应场景 beat 中用【新设定:人物名——身份简述】标记**，并让该角色身份具体（有名字/来历），而不是含糊的"某人/那人"；
- 已登记角色（点名册里有的）直接写名字，不要重复标记；
- 新人物名必须与点名册保持明显区分：不得只差一个字，不得再造同姓数字名，也不得用同音近形名（如已有“马坤”，禁“马武”；已有“吕三”，禁“刘三”）。本地细纲质量门会硬拦近名；
- 禁止用"灰衣人/某人/那道身影"这类无名指代来替代细纲指定的有名角色——细纲点了名就要用那个名字；
- 出场节制（V0.108）：每章新增具名角色/实体 ≤2（人/地/物合计），开篇期（前 20 章）尤其克制——能用身份指代（守门老兵/高台长老）就不用新名字，读者还没记住核心人物时别用新名字砸脸。

【场景功能去重】（V0.94 硬要求——精读实证：同一能力演示两遍/同一信息进场两次的章节读者获得感腰斩）
- 每个场景必须带来**至少一个新信息、新事件或新关系变化**（三选一），写进 beat；
- 任何两个场景不得推同一件事：不得两场景演示同一能力/立同一规矩/传递同一信息/犯同一错误（若场景 B 与场景 A 功能重叠，删 B 或让 B 推进下一层）；
- 章内叙事模板不得复读：如连续多个场景都是"险情→长辈处置→主角自省→落册立规"同款循环，需换结构。

【章末余力纪律】（V0.100：追读力来自本章因果，不再强迫每章套危机模板）
- reader_pull 必须具体回答“读者为什么自然想继续”，来源可以是未完成动作、选择后果、关系余波、已获信息改变下一步、局势变化或有意义的阶段性收束；
- ending_hook 只在正文确实产生一个新未决事件时填写。不得为了字段好看硬塞陌生人、密信、烟柱、犬吠、脚步声或远方异动；允许 null；
- 与近期章节相比，至少改变“主动者、阻力来源、转折机制、不可逆后果、结尾余力”中的两项。${prevHookType ? `上一章显式钩型为「${prevHookType}」，本章若仍需 ending_hook 不得机械复用同型。` : ''}
${diversityText ? `\n${diversityText}\n` : ''}
【章名兑现】（V0.94 硬要求——精读实证：《伍字军旗》全章无旗无伍；V0.107 升级：事件承诺零着墨是题眼级事故——ch52「帝星陨落」实证）
- 章名核心意象（具象章名：旗/衣/刀/册/桥等实物）必须能在本章正文兑现——对应实物/事件要真实出现在某个场景 beat 中；起名前先确认本章有这个意象的落点，没有就不许用这个名。
- 章名若承诺关键事件（决战/驾崩/破城/葬礼/即位/大捷等强事件词），该事件必须在本章 beat 中实际发生或直接触及（塘报/讣闻/转述式落地算触及）；只许用事件的现场一角起名，不许拿本章不写的场面起名。

【章节节奏与人物戏】（V0.50：按节奏按需注入——人物戏/烟火气是画龙点睛，不是每章都要）
- 先定 pace（章节节奏定位，一句话即可），再按 pace 安排内容配比：
  - **advance 推进章**（本卷多数章节）：主线事件为主，人物戏轻量（人物内心随事件自然流露即可，不强制 character_beat）；烟火气/市井细节不强制；
  - **setup 铺垫章**（每卷 2-4 章）：人物与伏笔为主，**强制** character_beat（内心变化点/关系进展/配角高光三选一）；场景可安排在市井地点，烟火气作氛围底色；
  - **payoff 收束章**（每卷 1-3 章）：兑现情感事件/关键伏笔，**强制** character_beat（情感转折/和解/牺牲/背叛等），人物内心是本章核心；
  - **daily 日常章**（每卷至多 1-2 章）：烟火气/市井人情为主，允许低冲突，用于喘息与群像刻画；
- 卷内 pace 分布要求：advance 为主（≥50%），setup/payoff 点缀，避免连续 3 章 advance 无人物戏；daily 不连续。
请输出 JSON。`;
}

/**
 * V0.43：按作品长度配置生成细纲的字数与场景要求文本
 * （紧凑 2500/标准 3200/丰满 5000/自定义；场景数随长度浮动）
 * V0.94.0：加单章硬下限（精读实证：卷2 全卷 2000-2500 字"一章只推一件事"——
 * 平台单章获得感腰斩）。场景 target 总和不得低于目标的 90%，每场景 ≥700。
 */

/** 书契约生成指令（AI 本位：目标读者/卖点/前 N 章承诺/硬约束） */
export function bookContractInstruction({ genre, blurb, idea, platform, regenDirection, genreText, historyNaming = '' }) {
  const pack = genreText || '';
  return `请为一本${genre || '玄幻'}小说生成「书契约」。${idea ? `作者灵感：${idea}\n注意：灵感中作者明确给出的核心设定（如：穿越/重生/特定身份/金手指/特定人物关系）是全书硬约束，必须在 selling_points 或 hard_constraints 中体现，不得丢弃或替换。\n` : ''}${blurb ? `简介：${blurb}\n` : ''}${platform && platform !== '通用' ? `目标平台：${platform}\n` : ''}${regenDirection ? `注意：上一版概念评分未通过，请按此方向强化重构（不要重复上一版思路）：${regenDirection}\n` : ''}${historyNaming ? `${historyNaming}\n` : ''}

书契约是整本书的顶层合同，将注入每一章的写作上下文。${pack ? '【题材包】' + pack + '\n\n' : ''}请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "target_readers": "目标读者画像（年龄/偏好/阅读习惯）",
  "selling_points": ["本书核心卖点（3-5 个，如：极致爽感/烧脑布局/情感拉扯）"],
  "promises": ["前 N 章承诺：如'前3章必有打脸'、'前10章必有大事件'（3-5 条，具体可执行）"],
  "hard_constraints": ["全书硬约束：如'主角永不言败'、'不得出现现代科技'、'配角不死'（2-4 条）"],
  "tone": "整体基调（热血/轻松/黑暗/烧脑…）"
}
请输出 JSON。`;
}

/** 章节脉络反向约束指令（未来章节防剧透）——由 outline.js 组装，无单独 prompt */

// ========== 全书打磨（polish） ==========

/** 全书诊断指令：定位 P0/P1/P2 问题 */

/** 写前五问自检指令（AI 本位：细纲生成后强制套路自检，不过则重生成）——V0.49 升级为六问（加 q6 人物情感变化） */
export function fiveQuestionsInstruction(ctx) {
  const { bookTitle, chapterIdx, chapterTitle, outline, isHistory = false } = ctx;
  const historySchema = isHistory
    ? `  "reader_value": {"type": "依恋|生存|能力|关系|信息|尊严|战术|战略|余韵|无", "gain": "本章给读者的具体获得，不能只写抽象形容词", "cost": "胜利代价/失败换来的增量；无则写'无'"},\n`
    : '';
  const historyRule = isHistory
    ? `历史题材按章节功能判断：
- setup/daily 铺垫章允许 q1、q2 可为“无”，但必须有依恋建立、关系变化、信息增量、选择或不安升级中的至少一种，并有自然的章末余力；
- advance/payoff 章必须有具体 reader_value，不能只有“敌军又来”的重复危机；战术/战略胜利还须交代代价；
- q5 的“事件”包括反常细节、人物动作、消息到达与选择，不限于物理破坏；不得因没有打斗、没有对手损失就判失败。`
    : '判定标准：q1/q2 是诊断维度，不强迫每章受伤或打斗；本章必须有一种具体阅读回报（结果/信息/关系/情绪/选择代价）并有自然章末余力。番茄、起点和通用都不得靠机械危机句冒充追读力。';
  return `你是网文套路质检员。请对《${bookTitle}》第${chapterIdx}章《${chapterTitle}》的细纲做"写前六问"自检：

【本章细纲】${JSON.stringify(outline, null, 2)}

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "q1_visible_harm": "阻力在本章造成了什么可见后果？（${isHistory ? "铺垫章可写'无'，也可写关系/生活秩序被扰动" : "具体到谁受伤或什么被破坏；无则写'无'"}）",
  "q2_physical_conflict": "本章的物理对抗是什么？（${isHistory ? "铺垫/日常/信息章可写'无'，不得虚构打斗凑项" : "手碰金属/火焰/拳头/追逐等；纯对话不算；无则写'无'"}）",
  "q3_satisfaction": "${isHistory ? "本章具体阅读回报是什么（依恋/生存/能力/关系/信息/尊严/战术/战略/余韵；无则写'无'）" : "本章爽点能否用'主语+动词+宾语+对方损失'描述？（能则写出该句；不能则写'无'）"}",
  "q4_ending_hook": "本章章末余力来自什么（未完成动作|疑问|关系余波|选择后果|信息差|局势变化|阶段性余韵|无），并说明它如何由本章因果产生",
  "q5_open_300": "本章前 300 字是否有物理事件发生？（炸了/断了/打了/冲了/倒了/烧了等；有则简述，无则写'无'）",
  "q6_emotional_change": "本章是否有角色情感或关系变化？（如：心境转折/关系升温或破裂/配角高光/情感事件；注意：'角色做了某事'不算，必须是'角色内心或人与人关系发生了变化'；无则写'无'）",
${historySchema}  "pass": true,
  "fail_reason": "未通过项的具体原因（pass=true 时为空字符串）"
}
${historyRule}
不通过的项要在 fail_reason 说明如何修改细纲。请输出 JSON。`;
}

/** 书契约生成指令（AI 本位：目标读者/卖点/前 N 章承诺/硬约束） */

/** 书级概念评分门：契约/大纲生成后校验概念是否成立（低于阈值自动换方向重生成） */
export function contractScoreInstruction({ bookTitle, genre, contract }) {
  return `你是网文平台主编。请评估《${bookTitle}》的书级概念是否值得写下去。

【题材】${genre}
【书契约】${contract}

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "scores": {"novelty": 1-10, "conflict": 1-10, "market": 1-10, "executable": 1-10},
  "total": "总分1-10",
  "verdict": "pass|regen",
  "regen_direction": "若 regen，给出一个不同的强化方向（一句话，避免与当前重复）"
}
判定：total ≥ 6 为 pass；< 6 为 regen。要严格，但不要为凑分放水。请输出 JSON。`;
}

/** AI 起名指令：根据灵感/题材生成网文风格书名 */

/** AI 起名指令：根据灵感/题材生成网文风格书名 */
export function bookTitleInstruction({ idea, genre }) {
  return `请为一部${genre || '网文'}小说起一个吸引人的书名。

【作者灵感】${idea || '（无，请自由发挥一个高概念）'}

要求：
- 3-10 个字，网文风格（可直接作为平台书名使用）
- 必须体现核心钩子（身份反差/金手指/冲突），避免《XXX传》《XXX记》式的平淡命名
- 可参考风格：《我在精神病院学斩神》《全球高武》《夜的命名术》《道诡异仙》

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "title": "书名（3-10字）",
  "subtitle": "一句话简介（可选，用于作品简介）"
}
请输出 JSON。`;
}

/**
 * 完本评估指令（V0.44：网文百万字才完本——本地硬规则通过后调用）
 * 输入：契约承诺 + 未回收伏笔 + 卷审阅摘要 + 全书规模 + 最近剧情
 * 输出：finished/reason/remaining（宁判未完，不提前完本）
 */

/**
 * 完本评估指令（V0.44：网文百万字才完本——本地硬规则通过后调用）
 * 输入：契约承诺 + 未回收伏笔 + 卷审阅摘要 + 全书规模 + 最近剧情
 * 输出：finished/reason/remaining（宁判未完，不提前完本）
 */
export function endingCheckInstruction(ctx) {
  const { bookTitle, contract, openForeshadows, reviews, totalChars, chCount, volCount, recent, lifecycleText = '', endingBlueprintText = '', readinessSummary = '' } = ctx;
  return `你是网文主编，对《${bookTitle}》做完本评估：判断故事是否已真正完本。

【核心卖点与承诺】${contract || '（无）'}
${lifecycleText ? lifecycleText + '\n' : ''}
${endingBlueprintText ? endingBlueprintText + '\n' : ''}
【本地完本准备度】${readinessSummary || '（旧书未启用结构化完本门）'}
【全书规模】${volCount} 卷 / ${chCount} 章 / 约 ${Math.round((totalChars || 0) / 10000)} 万字
【未回收伏笔】${Array.isArray(openForeshadows) && openForeshadows.length ? openForeshadows.map(f => (f.desc || '').slice(0, 50)).join('；') : '（无）'}
【卷级体检】${reviews || '（无）'}
【最近剧情】${recent || '（无）'}

判断标准（全部满足才算完本）：
1. 核心卖点与承诺已兑现（主角核心目标达成、核心卖点已兑现）；
2. 主线级伏笔/疑问已回收解答（支线小伏笔可留白但主线必须收束）；
3. 当前剧情处于收尾状态（不是在铺垫、不是刚展开新舞台）；
4. 完本点有明确的故事终点感（不是停在某个进行中的冲突）。

注意：主角刚完成新手期/初入宗门/刚展开新地图等都属于"未完本"；本卷为过渡卷/铺垫卷必为未完本。

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "finished": false,
  "reason": "未完本原因（一句话，指出缺什么：如'主线目标尚未达成，还在前期发育'）",
  "remaining": ["仍待解答的疑问或待兑现的承诺（1-3 条）"]
}
请只输出 JSON。`;
}

/**
 * 续卷大纲指令（V0.44：长篇连载——写完规划卷后自动生成下一卷）
 * 输入：契约 + 未回收伏笔 + 世界观 + 上一卷结尾钩子 + 卷数 → 输出新卷规划
 */

/**
 * 续卷大纲指令（V0.44：长篇连载——写完规划卷后自动生成下一卷）
 * 输入：契约 + 未回收伏笔 + 世界观 + 上一卷结尾钩子 + 卷数 → 输出新卷规划
 */
export function nextVolumeInstruction(ctx) {
  const { bookTitle, contract, openForeshadows, worldview, lastVolume, lastTail, volumeCount, chapterCount, targetHint, bookVolumePlan, castText = '', socialEcology = '', prevReviewText = '', midReviewText = '', closurePlanText = '', remedyText = '', worldExpansion = '', worldRemedyText = '', eraContext = '', historyGrowthNote = '', lifecycleStage = 'opening', lifecycleText = '', endingBlueprintText = '' } = ctx; // V0.76 世界展开 // V0.81 历史 // V0.92 生命周期
  const inEndingRunway = lifecycleStage === 'ending' || lifecycleStage === 'finale';
  return `你是网文主编，为《${bookTitle}》生成第${volumeCount + 1}卷的续卷大纲（${inEndingRunway ? (lifecycleStage === 'finale' ? '终卷：完成全书结算与余波' : '后期收尾：按结局蓝图清账并进入终局') : '长篇连载：继续扩大/转向/汇流，尚未进入收尾'}）。
${remedyText ? '【成长补救桥段（本卷必须落实）】' + remedyText.slice(0, 800) + '\n' : ''}
${worldRemedyText ? '【世界展开补救桥段（本卷必须落实）】' + worldRemedyText.slice(0, 800) + '\n' : ''}
${worldExpansion ? '【世界展开状态】' + worldExpansion + '\n' : ''}
${eraContext ? '【时代背景（史实锚点/官职/地理/红线——本卷剧情须贴合）】' + eraContext.slice(0, 600) + '\n' : ''}
${historyGrowthNote ? historyGrowthNote + '\n' : ''}
${lifecycleText ? lifecycleText + '\n' : ''}
${endingBlueprintText ? endingBlueprintText + '\n' : ''}
【核心卖点】${contract || '（无）'}
【世界观要点】${worldview || '（无）'}
${socialEcology ? '【社会生态】（市井民情，本卷场景可取材于此）\n' + socialEcology.slice(0, 500) : ''}
【未回收伏笔（${inEndingRunway ? '收尾期按结局蓝图优先回收主线项，开放债务须净减少' : '本卷须推进 1-3 条，其余留后续；不得一卷全清'}）】${Array.isArray(openForeshadows) && openForeshadows.length ? openForeshadows.map(f => (f.desc || '').slice(0, 40)).join('；') : '（无）'}
${castText ? '【角色弧光与配角库】（人物设计硬约束：本卷必须推进主角心境/能力成长，兑现 1-2 条配角命运线，安排 1 个情感事件）\n' + castText.slice(0, 700) : ''}
${prevReviewText ? '【上一卷体检反馈（本卷须针对性改进）】' + prevReviewText + '\n' : ''}
${midReviewText ? '【创作中期审阅反馈（本卷规划须落实以下调整项）】' + midReviewText.slice(0, 600) + '\n' : ''}
${closurePlanText ? '【伏笔收束计划（本卷必须落实以下超龄伏笔的回收分配）】' + closurePlanText.slice(0, 600) + '\n' : ''}
【上一卷《${lastVolume || '?'}》结尾】${lastTail || '（无）'}
${bookVolumePlan ? '【书纲已规划的本书】' + bookVolumePlan + '（须按此规划细化展开；卷名以规划卷名/阶段主题词为材料按【卷名工艺】提炼，不必照抄）' : ''}
${targetHint ? '【目标提示】' + targetHint : ''}
${VOLUME_TITLE_CRAFT_TEXT}

要求：
1. 严格承接上一卷结尾钩子，剧情持续推进（不得重启、不得平行展开）；
2. 本卷规划 ${chapterCount} 章（10-16 章，章数服务于卷级节拍而非事件均匀切片），有起承转合，${inEndingRunway ? (lifecycleStage === 'finale' ? '末章必须留足余波并以闭幕意象结束，不留下一章悬念' : '只允许终局推进钩，禁止另开新主线') : '末章留新钩子'}；
3. 格局/战力/地图逐卷升级，避免重复套路——升维检查单：对手能力面、舞台层级、主角可用资源三轴至少一轴较上卷明显变化（同名对手换个地方再打一次=重复套路）；
4. 快感节奏延续：卷内要有阶段性爽点结算，高潮结算落成可转述的名场面（谁、在有名字的地方、决定性动作、规模或代价可数——既有意象的收束，不临时空降新舞台）；
5. ${prevReviewText || midReviewText || closurePlanText ? '针对【上一卷体检反馈】【中期审阅反馈】【伏笔收束计划】中的问题在规划中明确改进（节奏拖沓则减少铺垫章；调整项与超龄伏笔回收须在本卷落实）。' : '节奏张弛有度：连续紧张不超过 3 章、连续铺垫不超过 2 章，高潮后余韵最多 2 章必须有新冲突进场。'}

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "title": "卷名（按上方【卷名工艺】：意象化 2-6 字，从本卷核心转折/主导意象取材，以书纲规划卷名/阶段主题词为材料；禁止'第X卷·XXX'式前缀、禁止与既有卷名重复）",
  "goal": "本卷要达成的叙事目标",
  "arc": "本卷剧情走向（150字内）",
  "lifecycle_stage": "${lifecycleStage}",
  "stage_turn": "本卷阶段转折及不可逆后果",
  "arcs_advanced": ["推进的既有弧线原名"],
  "arcs_closed": ["闭合的既有弧线原名"],
  "hooks_paid": ["兑现的既有伏笔/长期待原名"],
  "new_major_arcs": ["新增重大主线；无则[]"],
  "ending_delivery": {},
  "chapterCount": 12
}
请只输出 JSON。`;
}

/** V0.77 成长补救：有因果、有代价地兑现积累，禁止为追进度突兀连跳。 */

/** V0.77 成长补救：有因果、有代价地兑现积累，禁止为追进度突兀连跳。 */
export function growthRemedyInstruction({ bookTitle, genre, growthText, deviation, currentState, contract, lastTail, nextVolumeTitle }) {
  return `你是网文主编，为《${bookTitle}》设计"成长补救桥段"，修复主角成长线严重滞后（这是只做规划、不重写前文）。

【题材】${genre || '（未知）'}
【成长状态诊断】${growthText || '（无）'}
【偏离情况】${deviation || '（无）'}
【主角当前状态（关键字段）】${currentState || '（无）'}
【书契约成长承诺】${contract || '（无）'}
【上一卷结尾】${lastTail || '（无）'}
【下一卷规划方向】${nextVolumeTitle || '（待定）'}

主角已写一百余章仍在最低成长阶段，与书契约成长承诺严重不符。请设计一套“前文积累兑现 + 阶段性突破”的补救桥段：
1. 从已写内容中选 2-4 个真实意象/事件作为成长积累，不得改写既有事实；
2. 用 2-4 章完成“发现瓶颈→主动争取条件→受挫并付代价→突破”的因果链；下一卷最多跨 1-2 个相邻小阶段，禁止一场顿悟补完百章欠账；
3. 突破必须改变解决问题的方式，但不能让既有对手与宗门生态瞬间失效；写明限制、代价和下一瓶颈；
4. 突破后恢复书契约承诺的节奏，不再长期停滞，也不以境界数字暴涨代替剧情；
5. 列出 state_json 应保留的成长状态与应丢弃的过时叙事字段。

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "reinterpretation": [{"意象": "钥匙共鸣", "重新定义": "灵气亲和"}],
  "breakthrough": {"startChapter": 118, "fromStage": "丹田微流", "toStage": "相邻的下一小阶段", "steps": [{"chapter": 118, "stage": "触及瓶颈", "trigger": "前文积累显现", "beat": "主动争取突破条件"}]},
  "volume_plan": "下一卷如何承接突破并维持成长节奏（100字内）",
  "state_cleanup": {"keep": ["位置","境界","实力","丹田微流","心境","持有物"], "drop_examples": ["发现骨片内黑丝","判断脚印主人"]}
}
请只输出 JSON。`;
}

/** V0.77 世界展开补救：沿相邻层级自然扩展，禁止突然传送到最高舞台。 */

/** V0.77 世界展开补救：沿相邻层级自然扩展，禁止突然传送到最高舞台。 */
export function worldExpansionRemedyInstruction({ bookTitle, genre, worldScaleText, deviation, currentLevel, nextLevel, lastTail, nextVolumeTitle, contract, worldview }) {
  return `你是网文主编，为《${bookTitle}》设计"世界展开补救桥段"，修复世界观严重未展开（这是只做规划、不重写前文）。

【题材】${genre || '（未知）'}
【世界版图阶梯】${worldScaleText || '（无）'}
【停滞诊断】${deviation || '（无）'}
【当前层级】${currentLevel || '未展开'}｜【应推进到的下一层级】${nextLevel || '（未知）'}
【书契约】${contract || '（无）'}
【世界观】${(worldview || '').slice(0, 400)}
【上一卷结尾】${lastTail || '（无）'}
【下一卷规划方向】${nextVolumeTitle || '（待定）'}

主角已写一百余章仍困在同一小地域（当前层级长期不推进），世界观严重未展开。请设计一套“相邻层级自然展开”的补救桥段：
1. 从最近剧情的真实事件/道具/传闻中选 2-3 个，作为走出当前活动区的因果契机，不得改写既有事实；
2. 只展开阶梯中的相邻下一层：先补全当前宗门/城市的完整生态和周边网络，再进入大陆级舞台；禁止从小院、山门直接跳到帝都、皇朝或终局势力；
3. 用 3-6 章完成“收到线索→做出选择→启程/进入→付出适应成本→建立新冲突”，不能靠百科说明或无因传送；
4. 下一卷聚焦 1 个核心新区域和 1-2 个相关势力，承接旧角色与旧矛盾；之后再按每 1-2 卷一个相邻层级稳定展开；
5. 列出 state_json 应保留的关键字段与应丢弃的过时叙事字段。

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "reinterpretation": [{"意象": "宗门大比邀请函", "重新定义": "前往大陆宗门的契机"}],
  "expansion": {
    "startChapter": 118, "fromLevel": "宗门一隅", "toLevel": "宗门完整生态/周边修真圈",
    "region": "青云宗外门—任务堂—山下坊市",
    "steps": [{"chapter": 118, "event": "接下外门任务", "trigger": "旧线索指向任务堂", "beat": "主角主动走出原活动区"}]
  },
  "volume_plan": "下一卷如何承接跃迁并维持格局展开节奏（100字内）",
  "state_cleanup": {"keep": ["位置","境界","实力","心境","持有物"], "drop_examples": ["药园杂役排班"]}
}
请只输出 JSON。`;
}

// ========== V0.45 大纲对齐系统（章节改名/卷改名/卷大纲重写/书纲对齐） ==========

/** 章节改名指令：章名与内容脱节时修正（只输出新标题）
 *  V0.73 升级：除贴合内容外，要求文学性（意象/情感/悬念承载），并注入同卷现有章名
 *  防重名/雷同。同时允许传入"原文摘句"供取意象。 */

/** 章节改名指令：章名与内容脱节时修正（只输出新标题）
 *  V0.73 升级：除贴合内容外，要求文学性（意象/情感/悬念承载），并注入同卷现有章名
 *  防重名/雷同。同时允许传入"原文摘句"供取意象。 */
export function chapterRenameInstruction({ bookTitle, chapterIdx, oldTitle, summary, tail, siblingTitles = [], sample = '', isHistory = false }) {
  const siblings = siblingTitles.length
    ? `【同卷已有章名】（新标题不得与之重复或高度雷同）\n${siblingTitles.map(t => `- 《${t}》`).join('\n')}`
    : '【同卷已有章名】无';
  const sampleLine = sample ? `【本章原文意象摘句】（可从中提炼标题意象）\n${sample.slice(0, 200)}\n` : '';
  return `你是网文编辑。请为《${bookTitle}》第${chapterIdx}章执行章节改名：原标题《${oldTitle}》与实际内容脱节（写作过程中情节推进偏离了原规划），请根据实际内容给本章起一个新标题。

【本章实际内容摘要】${summary || '（无）'}
${sampleLine}
【本章结尾】${tail || ''}
${siblings}${isHistory ? '\n【历史题材风格】（V0.82）：标题可用文言/典故/时代意象（用典门槛控制在中小学课本级别），避免现代网络语感。' : ''}

${TITLE_CRAFT_TEXT}

要求：
- 贴合本章实际发生的事件与情感走向；不要输出解释

请输出 JSON：{ "title": "新章名" }
请只输出 JSON。`;
}

/** 卷改名指令：卷名与卷内内容脱节时修正
 *  V0.73 升级：要求意象化/情感化卷名，禁止'第X卷·'前缀，禁止与既有卷名重复。 */

/** 卷改名指令：卷名与卷内内容脱节时修正
 *  V0.73 升级：要求意象化/情感化卷名，禁止'第X卷·'前缀，禁止与既有卷名重复。 */
export function volumeRenameInstruction({ bookTitle, volumeIdx, oldTitle, chapters, siblingTitles = [] }) {
  const siblings = siblingTitles.length
    ? `【已有卷名】（新卷名不得与之重复或高度雷同）\n${siblingTitles.map(t => `- 《${t}》`).join('\n')}`
    : '【已有卷名】无';
  return `你是网文编辑。请为《${bookTitle}》第${volumeIdx}卷执行卷改名：原标题《${oldTitle}》与实际内容脱节（本卷实际写的内容与卷名不符），请根据本卷实际剧情起一个新卷名。

【本卷各章实际内容】${chapters || '（无）'}
${siblings}

${VOLUME_TITLE_CRAFT_TEXT}

要求：
- 不要输出解释

请输出 JSON：{ "title": "新卷名" }
请只输出 JSON。`;
}

/** 卷大纲重写指令：已写章回填实际 + 未写章重新规划 */

/** 卷大纲重写指令：已写章回填实际 + 未写章重新规划 */
export function volumeOutlineRewriteInstruction({ bookTitle, volumeIdx, volumeTitle, oldGoal, oldArc, doneChapters, openForeshadows, nextVolumeTitle }) {
  return `你是网文主编。请对《${bookTitle}》第${volumeIdx}卷《${volumeTitle}》执行卷大纲重写：实际写作与原卷大纲产生了偏差，请基于实际内容修订本卷大纲。

【原卷目标】${oldGoal || '（无）'}
【原卷走向】${oldArc || ''}
【各章实际状态与实际摘要】${doneChapters.map(c => `第${c.idx}章《${c.title}》[${c.status}] 实际：${c.actual}（原规划：${c.plannedBeat || '无'}）`).join('\n')}
【未回收伏笔（后续章节需推进）】${openForeshadows.length ? openForeshadows.map(f => (f.desc || '').slice(0, 40)).join('；') : '（无）'}
${nextVolumeTitle ? `【下一卷标题】《${nextVolumeTitle}》（本卷结尾需衔接）` : ''}

${TITLE_CRAFT_TEXT}
${VOLUME_TITLE_CRAFT_TEXT}

要求：
1. 已写章节：只以输入中“已写章节实际摘要/actual_beat”为准，title/beat 改为实际发生的内容（不保留旧规划注释）；
2. 未写章节：指没有实际摘要/actual_beat 的章节；基于当前剧情走向重新规划，承接已写部分，逐步推进未回收伏笔。不得仅凭 revised 字样把空章误判为已写；
3. goal 改为本卷实际达成的目标，arc 重写为实际走向；
4. 章数保持与已写章节数一致（不删已写章），未写章数量可调整。

请输出 JSON：
{
  "title": "卷名（若原卷名已贴合内容可不变；否则按【卷名工艺】提炼：意象化 2-6 字，从本卷核心转折/主导意象取材；禁止'第X卷·XXX'前缀）",
  "goal": "本卷实际达成的叙事目标",
  "arc": "本卷实际剧情走向（150字内）",
  "chapters": [{"idx": 1, "title": "章名（按【章名工艺】：4-8 字为主、3-10 字为界；半遮不剧透；意象须本章有落点；与近 3 章不同句式族；禁止动作直述与流水账）", "beat": "本章实际/规划事件（60字内）", "pov": "视角角色"}]
}
请只输出 JSON。`;
}

/** 书纲对齐指令：书纲 volumes 回填已写卷实际 + 未写卷对齐最新状态
 *  V0.93.9：历史书注入十五卷年代总表（12卷为四十年节点/反攻号角，13-15卷反攻延伸期），
 *  对齐时按新锚点重排，不再锁死 12 卷强行和解。 */

/** 书纲对齐指令：书纲 volumes 回填已写卷实际 + 未写卷对齐最新状态
 *  V0.93.9：历史书注入十五卷年代总表（12卷为四十年节点/反攻号角，13-15卷反攻延伸期），
 *  对齐时按新锚点重排，不再锁死 12 卷强行和解。 */
export function bookOutlineRewriteInstruction({ bookTitle, contract, writtenVolumes, pendingVolumes, openForeshadows, totalVolumes, historicalLongformText = '' }) {
  return `你是网文主编。请对《${bookTitle}》执行书纲对齐：基于实际剧情修订书级大纲的分卷规划（已写卷回填实际，未写卷对齐最新状态）。

【核心卖点】${contract || '（无）'}
【已写卷实际内容】${writtenVolumes || '（无）'}
【未写卷当前规划】${pendingVolumes || '（无）'}
【未回收伏笔（后续分卷需承接）】${openForeshadows.length ? openForeshadows.map(f => (f.desc || '').slice(0, 40)).join('；') : '（无）'}
【当前总卷数】${totalVolumes}
${historicalLongformText ? historicalLongformText + '\n' : ''}
${ENDING_BACKCAST_TEXT}

${VOLUME_TITLE_CRAFT_TEXT}

要求：
1. 已写卷：title/summary 改为实际内容（与实际一致，不再描述旧规划）；
2. 未写卷：基于最新剧情走向重新给出 title/goal/summary，承接已写部分与未回收伏笔；
3. 可新增卷（续写更大格局），总数 10-30 卷（长篇连载）；
4. 卷数不足时可补足到 10 卷以上，每卷一句话 summary。

请输出 JSON：
{
  "volumes": [{"idx": 1, "title": "卷名（按【卷名工艺】：意象化 2-6 字，从本卷核心转折/主导意象取材，不写事件流水账；禁止'第X卷·XXX'前缀）", "goal": "卷目标", "summary": "剧情走向（40字内）"}]
}
请只输出 JSON。`;
}

/**
 * V0.49：存量书籍角色弧光与配角命运线补设计（基于已写内容，不动正文）
 * 输出：cast_text（主角弧光+配角库）+ social_ecology（市井民情）
 */

/**
 * V0.49：存量书籍角色弧光与配角命运线补设计（基于已写内容，不动正文）
 * 输出：cast_text（主角弧光+配角库）+ social_ecology（市井民情）
 */
export function castDesignInstruction({ bookTitle, outlineText, contract, openForeshadows, chars, writtenChapters }) {
  return `你是资深网文角色设计师。《${bookTitle}》已写 ${writtenChapters} 章，但人物设计薄弱（主角成长线缺失、配角工具人化、缺市井烟火气）。请基于现有内容补全人物设计——只做设计，不写正文。

【书级大纲】${outlineText.slice(0, 1500)}
【书契约】${contract || '（无）'}
【未回收伏笔（须与角色命运线呼应）】${openForeshadows.length ? openForeshadows.map(f => (f.desc || '').slice(0, 40)).join('；') : '（无）'}
【已出现角色】${chars}

输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "cast_text": "【主角弧光】主角姓名：起点缺陷（性格层面，如自卑/逃避/多疑；附一句成因经历——如'幼年丧母被过继，习惯看人脸色'）→ 分卷成长节点（能力线+心境线双线，写清第几卷发生什么转变）→ 终点状态。\\n【对手设计】每个主要对手/反派一段：姓名｜自洽逻辑（他想要什么、为什么认为自己是对的）｜独立目标（他为自己要什么——晋升/保位/复仇/护住某人，禁止'阻止主角'式依附目标）｜退不了的理由（一旦停手会失去什么——权位/亲人/前功尽弃）｜局部正确（他与主角各执一词的那一点）。让读者'不认同他，但理解他'。\\n【配角库】每角色一行：姓名｜身份｜性格｜独立目标（为自己的，非助主角/阻主角）｜秘密/苦衷｜命运线（谁背叛/谁牺牲/谁悲剧/谁圆满，写清大致在第几卷兑现）｜与主角关系｜多边关系（与主角之外另一角色的关系线一条——如'欠某人一条命''与某人是旧识'，让关系网不止主角中心）。配角 5-8 人，至少包含：1 个亦敌亦友、1 个最终背叛、1 个为守护而牺牲/付出代价、1 个市井小人物（有烟火气）；至少 2 条多边关系线互相咬合（如配角欠对手一条命——这条线不需要主角参与就能产生张力）。",
  "social_ecology": "青阳镇/青云宗/周边坊市的市井生活细节（120-200 字）：集市/商铺/三教九流职业/人情往来/物价/节庆，让人物活在有烟火气的世界里。"
}
请只输出 JSON。`;
}

/**
 * V0.50：角色库 AI 批量补全指令（只补空字段，不覆盖用户已有内容）
 * 输入：人物设计（cast）+ 待补全角色清单（含已有字段）
 * 输出：完整档案数组
 */
/**
 * V0.71 地点库整理指令：为地点卡补全类型与描述（只填空不覆盖；地点高度稳定，除非重大事件否则不变）
 * V0.82：历史题材要求按"行政层级+战略价值+时代地理"整理（路/州/县/寨/堡 + 三江汇流/山城锁江等战略属性）
 */

/**
 * V0.50：角色库 AI 批量补全指令（只补空字段，不覆盖用户已有内容）
 * 输入：人物设计（cast）+ 待补全角色清单（含已有字段）
 * 输出：完整档案数组
 */
/**
 * V0.71 地点库整理指令：为地点卡补全类型与描述（只填空不覆盖；地点高度稳定，除非重大事件否则不变）
 * V0.82：历史题材要求按"行政层级+战略价值+时代地理"整理（路/州/县/寨/堡 + 三江汇流/山城锁江等战略属性）
 */
export function locationTidyInstruction({ bookTitle, listText, isHistory = false }) {
  const adminLine = isHistory
    ? '- admin_level：本朝行政/军事层级（路/州/府/县/寨/堡/山城/关隘/行在），10 字内；\n- strategic：战略属性（三江汇流/锁江天堑/粮道要冲/大军屯驻地/庙堂中枢），20 字内；'
    : '';
  return `你是网文编辑，为《${bookTitle}》的地点库补全地点卡片（只填空，不覆盖已有内容）。

以下地点缺类型或描述：
${listText}

请为每个地点补全：
- kind：地点类型（城镇/山/宗门/建筑/秘境/自然景观/室内空间/其他），10 字内；
- desc：一句话描述（地理位置/氛围/作用，40 字内）；地点若无重大事件其属性一般不变，描述应反映当前稳定状态。
${adminLine}
请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "locations": [
    { "name": "地点名", "kind": "类型", "desc": "描述"${isHistory ? ', "admin_level": "行政/军事层级", "strategic": "战略属性"' : ''} }
  ]
}
请只输出 JSON。`;
}

/**
 * V0.71 创作中期审阅指令（过程打磨——每 10 章一次，前瞻调整后续规划，不改已写内容）
 */

/**
 * V0.71 创作中期审阅指令（过程打磨——每 10 章一次，前瞻调整后续规划，不改已写内容）
 */
export function midStoryReviewInstruction({ bookTitle, contract, outline, recent, openText, arcText, pleasure, chapterCount, lifecycleText = '', payoffDebt = '' }) {
  return `你是网文主编，对《${bookTitle}》做创作中期阶段性审阅（已写 ${chapterCount} 章）。目标：发现走向问题并给出后续规划调整建议（不要修改已写章节，只调整未来规划）。

【契约承诺】${contract || '（无）'}
${lifecycleText ? lifecycleText + '\n' : ''}
【当前全书兑付债务】${payoffDebt || '（无）'}
【书纲】${outline || '（无）'}
【主角弧光】${arcText}
【快感节奏】${pleasure || '（无）'}
【未回收伏笔】${openText || '（无）'}
【最近 5 章】
${recent}

请检查六个维度：
1. 阶段职责是否完成：当前应扩张、转向、汇流还是清账？本阶段必须发生的转折是否真的发生？
2. 主线方向：是否偏离书纲核心承诺？下一阶段该往哪走？
3. 人物弧光：主角/关键配角的成长是否在推进？有无停滞？
4. 伏笔节奏：未回收伏笔是否堆积超龄？后续应在哪回收？
5. 快感分布：爽点/情感事件是否过于稀疏或密集？后续怎么调？
6. 债务趋势与拖沓：开放债务是否净减少？有无重复套路/注水倾向？后续怎么避免？
7. 四表体检（世界观/人物卡/时间线/伏笔）：世界观有没有崩、人物状态有没有漂、时间线有没有乱、哪些伏笔该收还没收？发现问题只调整后续规划，不要修改已写章节。

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "issues": [
    { "priority": "high|medium|low", "type": "方向|弧光|伏笔|快感|节奏", "issue": "问题", "suggestion": "建议" }
  ],
  "adjustments": [
    { "type": "主线|弧光|伏笔|快感|节奏", "target": "下一卷/第N章/主角", "action": "具体调整动作（30字内）" }
  ]
}
请只输出 JSON。`;
}

/**
 * V0.71 伏笔收束指令：为超龄未回收伏笔生成回收分配（挖坑必填——阶段/完本前必须收束）
 */

/**
 * V0.71 伏笔收束指令：为超龄未回收伏笔生成回收分配（挖坑必填——阶段/完本前必须收束）
 */
export function foreshadowClosureInstruction({ bookTitle, currentChapter, listText, totalOpen }) {
  return `你是网文主编，为《${bookTitle}》（当前第 ${currentChapter} 章，共 ${totalOpen} 条未回收伏笔）安排超龄伏笔的收束计划。

以下伏笔已超龄（种下超过 15 章或计划回收章已过），必须安排回收，不能挖坑不填：
${listText}

请为每条超龄伏笔分配：
- action：resolve（本卷/近期回收）/ advance（本卷推进但不完全回收，给回收留钩）/ abandon（有意放弃——须说明如何圆场，如"线人已死线索中断"）
- target_chapter：目标回收章（相对当前章节的合理章号，如当前 30 章则 34-38 章之间）
- plan：回收方式（30 字内：谁、在什么冲突中、揭示什么）

注意：①高级伏笔（与主线强相关）优先 resolve；②同一章最多安排 2 条回收，避免章内信息过载；③不得全部 abandon。

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "assignments": [
    { "id": "伏笔ID", "desc": "伏笔简述", "action": "resolve|advance|abandon", "target_chapter": 36, "plan": "回收方式" }
  ]
}
请只输出 JSON。`;
}

export function rosterTidyInstruction({ bookTitle, castText, listText }) {
  return `你是网文角色档案师。请为《${bookTitle}》补全以下角色的档案（只补缺失项，已有内容保持不变）。

【人物设计（cast）——分级与能力取材于此】
${castText || '（无）'}

【待补全角色（标注已有字段，空的才需要补）】
${listText}

要求：
1. 每个角色输出：tier（protagonist 主角|major 主要配角|minor 次要配角|extra 龙套）、personality（性格含缺陷）、speech（说话方式：句长/用词层/答法，写机制不写每章可抄的例句）、speech_forbid（此人禁腔，用|分隔）、goal（目标）、fear（软肋）、secret（秘密）、arc（成长弧线）、relation（关键关系）、abilities（能力/物品数组：{name,type,desc}，按书类型：技能/法宝/道具/功法/背包等）；
2. 已有字段照抄保留（不得改动），空字段根据人物设计与一般网文逻辑补全；
3. 主角必须有完整弧线；主要配角必须有秘密与目标；能力 1-5 项即可；配角说话方式必须彼此可区分；
4. 与人物设计冲突的不得自创（人物设计是硬约束）。

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "characters": [
    {"name": "角色名", "tier": "major", "personality": "", "speech": "", "speech_forbid": "", "goal": "", "fear": "", "secret": "", "arc": "", "relation": "", "abilities": [{"name": "", "type": "", "desc": ""}]}
  ]
}
请只输出 JSON。`;
}

/**
 * 灵感诊断与提级指令：给作者一句平庸/模糊的灵感，产出评分、问题与 3 个提级方案
 */
export function ideaAmplifyInstruction({ idea, genre, platform }) {
  return `你是网文资深主编+创意总监。作者给了一段灵感素材（可能是一句话、一个片段、一段随笔、或一份草稿），质量可能一般——你的任务是把普通灵感变成「高概念」（high concept）：一句话就能让读者点进来的故事内核。

【作者灵感素材】${idea || '（空）'}
【题材】${genre || '不限'}
【目标平台】${platform || '通用'}

高概念的标准：① 三秒内可传达的强钩子；② 主角有清晰的欲望与致命障碍；③ 设定有新意（旧元素的新组合也算）；④ 天然带连续冲突（不是单点事件）。

【片段反推规则】若输入素材是片段/随笔/草稿（明显超过一句话），先做"反推"再评估：
- 从素材中提炼：主角雏形（身份/欲望/缺陷）、世界观暗示、核心矛盾与最可能的卖点；
- 反推结果写入 "inferred" 字段；评分与 3 个升级方案必须以反推出的故事核心为基础，而不是字面照抄片段；
- 升级方案应把片段中的亮点放大成全书级钩子；若素材是完整草稿，可指出其中可直接保留的桥段。

【核心元素守恒 · 硬规则】（V0.25 新增，最高优先级）
- 先从灵感素材中提取 1-3 个「作者锚点」：作者明确给出的核心设定元素（如：穿越/重生/特定身份/特定金手指/特定人物关系/特定世界观）；
- 提取结果写入 "kept_elements" 数组；**所有 options 的 concept 必须完整保留全部作者锚点**，只允许在锚点之上做加法（强化冲突/补全世界观/设计钩子），严禁丢弃、替换或弱化锚点；
- 例如作者写"穿越成杂役弟子"，则每个方案都必须同时包含"穿越"与"杂役弟子"，不得变成"本土杂役弟子"；
- 仅当素材确实没有任何明确锚点时，才可完全自由发挥。

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "inferred": {"protagonist": "反推的主角雏形（身份/欲望/缺陷）", "world": "反推的世界观暗示", "core_conflict": "反推的核心矛盾", "selling_point": "最可能的卖点"},
  "kept_elements": ["作者锚点1", "作者锚点2"],
  "scores": {"novelty": "新颖度1-10", "conflict": "冲突强度1-10", "market": "市场性1-10", "executable": "可执行性1-10"},
  "total": "总分1-10",
  "verdict": "good|weak|poor",
  "issues": ["原灵感的问题（如：没有强冲突/人设俗套/设定单薄/卖点不明），最多4条"],
  "options": [
    {
      "title": "提级方案名",
      "concept": "一句话高概念（可直接作为新灵感）",
      "hook": "第一章第一幕的钩子（什么让读者留下）",
      "why": "为什么这个方案强",
      "risk": "风险与规避"
    }
  ],
  "golden_open": "若采用方案一，前300字怎么开场（一句话建议）"
}
规则：options 给 3 个差异化方向（如：强化冲突/更换金手指/反转人设）——差异化体现在强化路径上，作者锚点（kept_elements）在所有方案中必须一致保留；每个 concept 不超过 60 字。请输出 JSON。`;
}

/** 书级概念评分门：契约/大纲生成后校验概念是否成立（低于阈值自动换方向重生成） */

// ========== V0.41 卷级整体审阅（主动卷体检） ==========
/**
 * 卷级审阅指令：一卷写完后，对照卷大纲体检——承诺兑现/节奏/衔接/整体读感。
 * 输入全部来自摘要与结构化数据（不用全文），控制上下文成本。
 */
export function volumeReviewInstruction(ctx) {
  const {
    bookTitle, volumeIdx, volumeTitle, volumeGoal, volumeSummary,
    chapterLines, // "第N章《标题》—— 摘要 | 结尾钩子"
    foreshadowLines, // 本卷登记伏笔（id/描述/状态）
    prevVolumeTail, // 上一卷末章摘要+钩子（卷间衔接）
    contractLogline, // 书契约卖点
    lifecycleText = '', payoffDebt = '',
  } = ctx;
  return `你是网文主编，负责卷级审阅：《${bookTitle}》第${volumeIdx}卷《${volumeTitle}》的完卷体检。请以资深编辑视角评估这一卷的质量、节奏与整书连贯性。

【本卷大纲目标】${volumeGoal || '（无明确目标）'}
【本卷大纲提要】${volumeSummary || ''}
【核心卖点】${contractLogline || ''}
${lifecycleText ? lifecycleText + '\n' : ''}
【全书当前兑付债务】${payoffDebt || '（无）'}
【上一卷结尾（衔接检查用）】${prevVolumeTail || '（首卷）'}

【本卷各章摘要与结尾钩子】
${chapterLines}

【本卷登记的伏笔】
${foreshadowLines || '（无）'}

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "goal_met": true,
  "goal_note": "卷目标是否达成及原因（一句话）",
  "promises": [
    {"item": "卷大纲承诺的具体内容", "met": true, "note": "兑现情况"}
  ],
  "pacing": {"grade": "A|B|C", "issue": "节奏问题（高潮分布/爽点密度/拖沓段），无则写'节奏均衡'"},
  "technique": {"grade": "A|B|C", "issue": "写作技巧问题（V0.83：铺垫密度过疏/插叙倒叙失控/视角漂移/连续同型场景/感官描写缺失），无则写'技法得当'"},
  "hooks": {"volume_ending": "本卷结尾留下的钩子（供下卷承接）", "carried_from_prev": true, "hook_note": "上一卷钩子是否被承接"},
  "reading": {"grade": "A|B|C", "issue": "整体读感评估（当前完成部分读者情绪曲线/弃书风险点），无则写'阅读体验良好'"},
  "stage_progress": {"stage": "opening|early_middle|middle|late_middle|ending|finale", "duty_met": true, "required_turn_met": true, "note": "本卷是否完成当前全书阶段职责及证据"},
  "arc_movement": {"advanced": ["本卷有正文证据推进的弧线名"], "closed": ["本卷有正文证据闭合的弧线名"], "opened": ["本卷新开的弧线名"]},
  "payoff_movement": {"paid": ["本卷有正文证据兑现的伏笔/长期待原名"], "remaining": ["仍待兑现项"]},
  "new_debt": ["本卷新增的跨卷债务；无则[]"],
  "ending_readiness": {"ready": false, "missing": ["距离完本仍缺的主线/人物/关系/世界结算"]},
  "issues": [
    {"severity": "P0|P1|P2", "type": "plot|pacing|character|hook|continuity|tone|technique|lifecycle", "chapter": 3, "desc": "具体问题（引用章节与现象）", "suggest": "最小化修订建议"}
  ]
}

规则：
1. issues 只列**确定的问题**（宁缺毋滥，避免误伤）；P0=硬伤（矛盾/断线），P1=明显影响阅读（拖沓/钩子断裂），P2=可优化项。
2. issues 的 chapter 必须在本卷范围内；无法定位到具体章的问题填 0（表示全卷层面）。
3. pacing/reading 的 grade 必须给出，A=优秀 B=合格 C=需要改进。
4. 除局部质量外，必须检查本卷是否完成【全书生命周期合同】的阶段职责；局部顺畅但整书原地踏步时，stage_progress.duty_met=false，并给 P1 lifecycle 工单。
5. arc_movement/payoff_movement 只能填本卷摘要或结尾原文能证明的事项，不得根据卷纲计划提前销账。收尾期必须检查开放债务是否净减少；终卷只有核心承诺、主角弧、关键关系、世界结果和闭幕意象全部落地才可 ending_readiness.ready=true。
6. 人设漂移核对（V0.108，番茄作家课"每隔一段剧情回头核对角色卡"的卷粒度落点）：对照【本卷各章摘要】与角色设定，配角/对手的行为是否还能从其性格/目标/立场解释——角色为了服务剧情做出完全不符人设的事（突然降智/突然转性/立场无故翻转）时给 P1 character 工单；仅行为自然演进不算漂移。
请只输出 JSON。`;
}

// ========== V0.19 灵感提级（创意引擎：平庸灵感 → 高概念） ==========

/**
 * 灵感诊断与提级指令：给作者一句平庸/模糊的灵感，产出评分、问题与 3 个提级方案
 */

/**
 * 书级快感计划指令（每卷奖励节奏/情绪轮换/压抑释放/情感线节奏/弧线规划）
 */
export function bookPleasurePlanInstruction({ bookTitle, genre, platform, protagonist, contract, volumeCount, genreText }) {
  const pack = genreText || '';
  // V0.82：历史题材（史实流）——"金手指"字段语义改为"立身之本"，爽点类型改历史文语义
  const isHistory = genre === '历史';
  const gfField = isHistory
    ? '"golden_finger": {"power": "立身之本/核心资本（身份/才学/军功/知识差——史实流无超常金手指）", "limit": "资本边界（当前限制与解锁条件，克制原则）"}'
    : '"golden_finger": {"power": "金手指能力", "limit": "当前限制与解锁条件（克制原则）"}';
  const smallType = isHistory
    ? '每章阅读回报轮换（依恋/生存/能力/关系/信息/尊严/战术/战略/余韵——不要求每章获胜，胜利必须有代价）'
    : '小爽点类型轮换（打脸/升级/收集/探索/情感）';

  return `你是网文读者心理学专家。请为《${bookTitle}》设计全书"快感计划"，确保读者越看越上瘾。

【题材】${genre || '玄幻'}【平台】${platform || '通用'}
【主角】${protagonist || '（待定）'}
【书契约】${contract || '（无）'}

${pack ? '【题材包奖励节奏】' + pack + '\n\n' : ''}${isHistory ? '【历史文阅读回报纪律】\n- 最高级回报：读者先爱上具体的人与山河，再看人物在大势压迫下作选择、有尊严地活；历史遗憾的弥补是远期高潮，不是每章任务\n- 回报调色盘必须轮换：依恋、生存、能力、关系、信息、尊严、战术、战略、余韵；失败也必须换来信息/关系/选择上的增量\n- 每次胜利必须配代价（伤亡/粮草/政治妥协/时间成本），拒绝无成本碾压；允许铺垫章没有打斗和胜利，但不能空转\n- 每3—5章一次可感知兑现，每8—12章一次阶段结算；高低情绪振荡，不连续三章同型\n\n' : ''}请输出 JSON（不要输出 JSON 以外的任何内容）：
{
${isHistory ? '  "reward_palette": ["依恋", "生存", "能力", "关系", "信息", "尊严", "战术", "战略", "余韵"],\n' : ''}  "reward_rhythm": {
    "small": "小爽点节奏（建议：每 1-3 章一次，间隔伪随机）与类型轮换（${smallType}）",
    "medium": "中爽点节奏（建议：每 5-10 章一次卷内小高潮）",
    "large": "大爽点节奏（建议：每 15-30 章一次卷末高潮）"
  },
  "emotion_rotation": ["10章情绪轮换表（如：紧张7→紧张8→小燃9→放松3→甜4→虐6→虐7→大燃10→余韵3→新钩6）"],
  "suppress_release": {"ratio": "压抑:释放比例（建议2:1~3:1）", "authority_symbols": ["每卷权威象征物（师尊/宗门/旧规则/天道），主角经历服从→质疑→超越"]},
  "arc_plan": [{"name": "弧线名", "type": "主线|支线|感情线|暗线", "span": "贯穿章节范围", "note": "作用"}],
  "emotion_lines": [{"name": "关系名", "phase_plan": "五阶段节奏：出场(1-3章)→暧昧(40-50%)→确认→危机→升华"}],
  "protagonist_recipe": {"ordinary_anchors": ["普通人锚点3项"], "potential": "非比寻常潜质1项", "flaws": ["初始缺陷1-2个"], ${gfField}}
}
请输出 JSON。`;
}

/** 细纲快感规划段（注入 chapterOutlineInstruction 的上下文）——由 pleasure.js 组装，无独立 prompt */

/** 快感审计指令（每章结算后：情绪标签/钩子强度/期待兑现/代入感/节奏问题） */
