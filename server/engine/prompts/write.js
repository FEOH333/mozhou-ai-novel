// 由 prompts.js 拆分而来（V0.109.5）。只搬不改：声明体与拆分前逐字节一致。
'use strict';

/**
 * 场景正文指令（固定注入区 + 动态检索 + 字数硬约束）
 * @param {object} ctx
 */
export function writeSceneInstruction(ctx) {
  const { bookTitle, chapterIdx, chapterTitle, scene, scenesBefore, sceneAfter, prevTail,
    worldbookText, factsText, foreshadowsText, prevSceneSummary, rules,
    rollingSummary, recentSummaries, timelineEvents, futureChapters, constraints, pleasureContext, styleRules,
    rollCallText = '', perspective = 'third', techniqueText = '', dynamicStyle = '', cardText = '', characterBeat = null, ecologyText = '', locationText = '', powerStatus = '', endingHook = '', plotDeAI = '', poetryText = '', historyDeAI = '', eraContext = '', eraBoundary = '', sceneType = '', warfareText = '', courtText = '', environmentText = '', psychologyText = '', historicalChapterFrame = '', isHistory = false, dashBudget = 0,
    memoryText = '', itemText = '', sceneEchoText = '', volumePosition = '', pacingText = '', crossYearOpeningRule = '', scaleRegisterText = '', continuityCraft = '', openingContractText = '', narrativeLessons = '', craftQuotaText = '', valleyText = '', diversityText = '', craftOccupancyText = '', ledgerBriefText = '', chapterBudgetText = '', sceneMaxWords = 0, rivalNames = [] } = ctx; // V0.37 点名册 / V0.42 视角 / V0.43 文学技法+动态文风 / V0.49 角色卡+人物戏 / V0.50 按需烟火气 / V0.71 地点卡 / V0.73 主角修炼状态 / V0.80 章末钩子+剧情去AI味 / V0.81 诗词+历史去AI味+时代红线 / V0.82 史实边界 / V0.83 场景类型（硬要求） / V0.87 战役纪律 / V0.88 朝堂权谋纪律 / V0.89 环境+心理纪律 / V0.91 年代坐标 / V0.94 场景预算（破折号） / V0.95 叙事记忆+物品卡+前文回响+卷内坐标+节奏标注 / V0.95.7 跨年开篇硬要求（仅跨年章场景1） / V0.95.8 山河尺度纪律（分层配额） / V0.97 细节一致与章法轮换纪律 / V0.98 读者前置契约（仅结构） / V0.103 近窗换轴 / V0.105.2 章字数预算 / V0.108 人物活性（对手在场注入反派纪律）

  const sceneList = scenesBefore.map(s => `- ${s.id}（${s.pov} @ ${s.location}）：${s.beat}`).join('\n');
  const afterText = sceneAfter ? `- ${sceneAfter.id}（${sceneAfter.pov} @ ${sceneAfter.location}）：${sceneAfter.beat}` : '（无，本章最后一场景）';
  // V0.73：结尾钩子只约束最后一场景（此前逐场景注入"必须落钩子"与"停在节拍完成处"矛盾）
  const isLastScene = !sceneAfter;
  // V0.83：关键场景类型硬性写作要求（战斗/情感/高潮——此前只有软性"按需选用"技法，关键节点缺硬约束）
  const SCENE_HARD_REQ = {
    fight: '【战斗戏硬要求（V0.83）】必须至少写清 2 项真实变量：地形（城垣/山地/江河）、兵力对比与阵型、后勤补给、天气（雨雪/瘴热）、伤亡代价；禁止"双方喊杀就分胜负"的空战。',
    emotion: '【情感戏硬要求】让两种真实欲望在人物身上冲突，并通过本场景特有的选择、话语或行为变化呈现；禁止直述情绪标签，也禁止套用提示词里的万能身体反应。',
    climax: '【高潮戏硬要求】兑现本章已经建立的期待，使人物、关系或局势发生可见变化；释放可以来自行动、关系、信息、尊严或战术，结尾保留由结果自然产生的代价或余波，不强迫围观、打脸或事故悬崖。释放要定格成读者一句话能转述的画面：有名字的地点、一个决定性动作或一句有分量的话、可数的规模或代价（斩获三百级/只差半日/折了七人式，不是"大获全胜"式），三者至少其二——用动作与物件定格高潮，不用顿悟议论升华收束；读者记住的是画面，不是道理。',
  };
  const hardReq = SCENE_HARD_REQ[scene.scene_type || sceneType] || ''; // V0.83：场景类型（细纲标注优先，缺省用写入猜测值）
  // V0.85：对比铺垫纪律——本章/本场景涉及重大悲剧、死亡、灭门、城破等"失去"时注入先立后破
  const isLossScene = /城破|灭门|屠|死|殒|殉|覆灭|诀别|家破|惨死|殁|遭难|陷落/.test(scene.beat || '') || /城破|灭门|屠|死|殒|殉|覆灭|诀别|家破|惨死|殁|遭难|陷落/.test(`${ctx.goal || ''} ${ctx.conflict || ''}`);
  const contrastReq = isLossScene ? CREATIVE_LOSS_BRIEF : '';
  const recent = recentSummaries?.length
    ? recentSummaries.map(s => `第${s.idx}章：${s.summary || ''}`).join('\n')
    : '（新书）';
  const events = timelineEvents?.length
    ? timelineEvents.slice(-5).map(e => `· ${e}`).join('\n')
    : '（无）';
  const future = futureChapters?.length
    ? futureChapters.map(f => `第${f.idx}章：${f.beat || ''}`).join('\n')
    : '（无）';
  // V0.100：场景达到目标 85% 才算完成；章级结算前再核对整章下限。
  // V0.105.2：sceneMaxWords（章级预算动态上限）更紧时收紧指令上限——写与自愈同源。
  const minWords = Math.max(700, Math.round((scene.target_words || 1000) * 0.85));
  const staticMax = Math.round((scene.target_words || 1000) * 1.7);
  const maxWords = sceneMaxWords > 0
    ? Math.max(minWords + 50, Math.min(staticMax, Math.round(sceneMaxWords)))
    : staticMax;
  const youthAge = Number((String(historicalChapterFrame || '').match(/主角\s*(\d{1,2})\s*岁/) || [])[1]);
  const youthAuthorityRule = isHistory && Number.isFinite(youthAge) && youthAge < 16
    ? `【少年权限硬规则】主角${youthAge}岁：暗门准确位置、军情原图与销毁权限由具名成人保管和复核；成年工役/军卒只能由成人批准并正式下令。少年只可提出观察并承担记号、复诵、报时、传讯、守绳等有限责任。\n`
    : '';
  const techniqueBrief = compactTechniqueGuidance(techniqueText);
  const plotBrief = plotDeAI ? CREATIVE_PLOT_BRIEF : '';
  const environmentBrief = environmentText ? CREATIVE_ENVIRONMENT_BRIEF : '';
  const psychologyBrief = psychologyText ? CREATIVE_PSYCHOLOGY_BRIEF : '';
  const continuityBrief = continuityCraft ? CREATIVE_CONTINUITY_BRIEF : '';
  const warfareBrief = compactDomainGuidance(warfareText, 'warfare');
  const courtBrief = compactDomainGuidance(courtText, 'court');
  const scaleBrief = compactScaleGuidance(scaleRegisterText);
  const historyBrief = historyDeAI
    ? `${guidanceHeadings(historyDeAI) || '【历史叙事纪律】'}\n- 只写当前人物能接触到的本时代制度、器物和观念；不确定的知识宁缺毋滥，史实变化必须服从既定边界。`
    : '';
  const poetryBrief = poetryText
    ? `${guidanceHeadings(poetryText) || '【诗词运用】'}仅在人物身份、时机和语境都成立时化用，不背诵、不炫典、不替人物说教。`
    : '';
  const dialogueBrief = ['dialogue', 'emotion', 'climax', 'daily'].includes(scene.scene_type || sceneType)
    ? CREATIVE_DIALOGUE_BRIEF
    : '';
  const valleyBrief = (valleyText && /低谷|代价/.test(String(constraints || '')))
    ? `${CREATIVE_VALLEY_BRIEF}\n${valleyText}`
    : '';
  // V0.108 人物活性：生活体感恒注入一句（短）；对手型角色在场时追加反派纪律（行动逻辑材料见角色卡"他的立场"行）
  const vitalityBrief = [
    '【生活体感】一场景至多 1 处生活细节（伤情疲惫的延续/吃穿窘迫/压力小毛病），用具体身体反应替代情绪词直述，不水日常。',
    ...(Array.isArray(rivalNames) && rivalNames.length
      ? [`【对手在场】${rivalNames.join('、')}的行动必须能从自己的立场/利益/目标解释（见角色卡"他的立场"）——他不是针对主角，是主角挡了他的路；配角也按自身目标行动，不为主角送剧情。`]
      : []),
  ].join('\n');

  return `【本章细纲】《${chapterTitle}》（第${chapterIdx}章）
章名承诺：章名里的核心意象或事件（若章名含决战/驾崩/破城等强事件词）必须在本章正文落地——意象要在某个场景真实出现，事件要实际发生或直接触及（塘报/转述式落地算触及）；章名与内容牛头不对马嘴是题眼级事故。
本章目标：${ctx.goal || '（无）'}
核心冲突：${ctx.conflict || '（无）'}
承接上一章：${ctx.continuityFrom || '（无）'}
场景顺序：
${sceneList}
- ${scene.id}（${scene.pov} @ ${scene.location}）：${scene.beat} ← 你现在写这个场景
下一场景：${afterText}

【全书进度】${rollingSummary || '（新书）'}

【最近剧情】${recent}

【前文已发生事件】（不得重复这些事件；只能在其基础上推进）
${events}

【未来剧情预告】（不得提前兑现/剧透）
${future}

【当前状态】
${prevTail ? `上一场景结尾：${prevTail}\n` : '（本章开头）'}
${prevSceneSummary ? `上一场景摘要：${prevSceneSummary}` : ''}
${rollCallText ? `\n${rollCallText}` : ''}
${cardText ? `\n${cardText}` : ''}
${powerStatus ? `\n${powerStatus}` : ''}
${memoryText ? `\n${memoryText}` : ''}
${itemText ? `\n${itemText}` : ''}
${volumePosition ? `\n【卷内坐标】${volumePosition}` : ''}
${pacingText ? `\n${pacingText}` : ''}
${openingContractText ? `\n${openingContractText}` : ''}
${narrativeLessons ? `\n${narrativeLessons}` : ''}

${characterBeat ? `【人物戏要点】（V0.49：本章正文必须体现人物内心/关系变化，禁止纯事件流水账）
- 人物：${characterBeat.character || ''}｜内心变化：${characterBeat.inner_change || ''}｜关系变化：${characterBeat.relation_delta || '无'}
- 必须在正文中写出这个人物戏（情绪、内心挣扎、关系互动），不得只推进事件。` : ''}

【相关设定】
${worldbookText || '（无特殊设定注入）'}
${ecologyText ? `\n【场景市井氛围】2-3 个有信息量的感官细节（声音/气味/物件）织进剧情，人物与环境互动一两笔，禁段落式整块写景。\n${ecologyText}` : ''}
${locationText ? `\n${locationText}` : ''}

【相关事实】（不得与之矛盾，只能引用这些事实）
${factsText || '（无）'}
${sceneEchoText ? `\n【前文回响】（归档/早期章节中与本场景相关的片段——设定与细节必须保持一致，但严禁复述原句或重演同一场面）\n${sceneEchoText}` : ''}

【活跃伏笔】（按要求落实）
${foreshadowsText || '（无）'}

【全局约束】（必须遵守，来自全书健康诊断/用户设定）
${constraints || '（无）'}

${crossYearOpeningRule ? `【跨年开篇硬要求（本地校验逐字核查，不满足将被驳回重写）】\n${crossYearOpeningRule}\n` : ''}${scaleBrief ? scaleBrief + '\n' : ''}${historicalChapterFrame ? `【历史章节坐标（硬约束）】${historicalChapterFrame}\n不得改变公元年、年号、主角年龄与阶段；本场景服务于指定阅读回报和情绪功能。\n` : ''}
${youthAuthorityRule}

【本场景创作简报】
${pleasureContext || '（无）'}
${diversityText ? `${diversityText}\n` : ''}${craftOccupancyText ? `${craftOccupancyText}\n` : ''}${ledgerBriefText ? `${ledgerBriefText}\n` : ''}${vitalityBrief}\n- 因果：人物的决定、关系或局势至少一项变化，并影响下一步。
- 人物：按自身欲望与权限行动；主角必须作出判断、选择或承担后果。
- 回报：完成一次具体推进；失败也要换来信息、关系或能力增量。
- 质感：只用当前人物、地点与动作链本场景特有的细节，不复用提示词示范。
${isLastScene ? '- 收尾：完整落下本章行动与代价，再保留由该结果自然产生的疑问、关系余波、信息差或局势变化；不另塞无因事故。' : '- 收尾：当前节拍形成结果即停，下一场景的动作尚未开始；不制造章末式悬崖。'}
${endingHook ? '- 【细纲给出的章末余力（只兑现其因果功能，不必逐字复刻或写成机械悬崖）】' + endingHook + '\n' : ''}
${plotBrief ? plotBrief + '\n\n' : ''}${historyBrief ? historyBrief + '\n\n' : ''}${eraContext ? '【时代红线/可改史点（本章不得触犯红线）】' + eraContext + '\n\n' : ''}${eraBoundary ? eraBoundary + '\n\n' : ''}${poetryBrief ? poetryBrief + '\n\n' : ''}${techniqueBrief ? techniqueBrief + '\n\n' : ''}${contrastReq ? contrastReq + '\n\n' : ''}${hardReq ? hardReq + '\n\n' : ''}${dynamicStyle ? dynamicStyle + '\n\n' : ''}${warfareBrief ? warfareBrief + '\n\n' : ''}${courtBrief ? courtBrief + '\n\n' : ''}${environmentBrief ? environmentBrief + '\n\n' : ''}${psychologyBrief ? psychologyBrief + '\n\n' : ''}${continuityBrief ? continuityBrief + '\n\n' : ''}${CREATIVE_AI_FLAVOR_BRIEF}\n\n${valleyBrief ? valleyBrief + '\n\n' : ''}${CREATIVE_BOUNDARY_BRIEF}\n\n${dialogueBrief ? dialogueBrief + '\n\n' : ''}【写作要求】
1. 只写场景「${scene.id}」：${scene.beat}
1.5 【场景边界硬约束】下一场景节拍是「${(sceneAfter?.beat || '（无）').slice(0, 60)}」；不得提前写出其过程或结果。
2. POV：${scene.pov || '跟随主要在场角色'}；${perspective === 'first' ? '全程用"我"叙述。' : '用"他/她/角色名"叙述，不得出现第一人称"我"作旁白。'}
2.5 ${CREATIVE_POV_BRIEF}
${chapterBudgetText ? chapterBudgetText + '\n' : ''}3. 【字数硬约束】输出 ${minWords}-${maxWords} 字（目标 ${scene.target_words || 1000} 字）；用事件、对手戏和有功能的细节写足，不重复、不议论凑数。
4. 承接【当前状态】并落实上方因果变化；不重述前文，不擅自新增会改变设定或后续大纲的事实。
5. ${rules || '遵守作品设定、事实与用户锁定规则。'}
6. 只有确需新增且无法用现有设定表达的名词，才在正文末尾单独标记：【新设定:名词——简述】。

【机械防线】这些项目由写后本地审校计数，不要围着数字组织文句：整章破折号不超过 20 个${dashBudget ? `（本场景预算约 ${dashBudget} 个）` : ''}；单段不超过 200 字；高频套话词同词每章不超过 2 次；抽象对举式偈语（含跨句拆分）不超过 2 处；段首第三人称代词比例目标不超过 35%；动作母题、比喻、起手式与收束须轮换，跨章也不得复用同一比喻或近章专属意象；同一句话不得章内或近章逐字重复；单句"的"不超过 3 个，短句（20 字以内）不少于三成，抽象黑话合计不超过 2 处。
${craftQuotaText ? `${craftQuotaText}\n` : ''}${styleRules ? styleRules + '\n\n' : ''}【铁律】只输出正文本身，不要解释、标题、检查清单或前后缀。`;
}

/** V0.80 签约文本预审指令（文本证据 + AI味检查；不预测平台结果）
 *  V0.82：历史题材（史实流）——金手指要求豁免，改评审史实严谨/时代质感/历史人物尊重/胜利有代价 */

// V0.100：正文模型需要“当前场景的创作简报”，而不是把审校手册全文背一遍。
// 详细规则仍由 audit/rules 执行；这里仅保留会改变创作决策的少量约束，并主动删除
// 负面示例里的万能动作，避免模型因提示词暴露而高频模仿。
const CREATIVE_BOUNDARY_BRIEF = `【场景边界纪律】
- 只完成当前节拍；下一节拍的过程和结果不得提前发生。
- 非末场景停在当前行动形成结果、下一步尚未执行的位置；末场景只保留本章因果自然产生的余力。`;

const CREATIVE_POV_BRIEF = `【叙事视角纪律】
- 读者只知道当前 POV 能感知、记得或合理推断的内容；不得跳进他人内心，也不得用全知旁白替代场景。
- 如确需换视角，必须有明确场景分隔；本场景内保持同一观察者。`;

const CREATIVE_DIALOGUE_BRIEF = `【角色语言区分纪律】
- 每句话都服务于说话人此刻的目的、身份与关系；允许回避、打断和答非所问，不用完整报告句替旁白总结。
- 道理由行动后果体现。导师格言腔和可互换台词由本地审校检查，正文不要主动套句式。`;

const CREATIVE_CONTINUITY_BRIEF = `【细节一致与章法轮换纪律】
- 延续正文中已经成立的时间、伤情、权限、能力、道具位置与状态；任何改变都先写出原因和动作。
- 观察不等于结论：物证只支持它实际证明的范围；越权行动须交代权限来源，技术结果须写清最低限度的技术机理。
- 对白目的必须来自说话人的当下利益与关系，不让所有角色轮流替作者汇报证据。
- 同一信息只讲一次，人物再次得知时写新的反应或选择；开场方式、收束方式和因果骨架不得照搬近章。`;

const CREATIVE_PLOT_BRIEF = `【剧情发展去AI味】
- 因果别太顺：转机要由既有行动或条件挣来，并留下成本或不确定性。
- 冲突别一次清空：结果必须改变局势，但对手、关系或代价仍按自身逻辑继续作用。
- 配角别都懂事：每个关键配角保留自己的目标、误判和拒绝权。
- 巧合要限流；情绪节奏和解决方式不得复制近章。`;

/** V0.109.3 通用中文 AI 腔简报（与 AI_FLAVOR_TEXT 同源压缩，写审同一把尺）
 *  恒注入：AI 腔是全题材共性问题，不按题材开关；压缩到 6 行控注入预算（v128 有 25k 护栏）。
 *  导出供 polish 执行指令复用（打磨工单同源同一把尺）。 */

/** V0.109.3 通用中文 AI 腔简报（与 AI_FLAVOR_TEXT 同源压缩，写审同一把尺）
 *  恒注入：AI 腔是全题材共性问题，不按题材开关；压缩到 6 行控注入预算（v128 有 25k 护栏）。
 *  导出供 polish 执行指令复用（打磨工单同源同一把尺）。 */
export const CREATIVE_AI_FLAVOR_BRIEF = `【语言去机器腔】
- 抽象落地：不写商业黑话与空洞大词；判断由本场景可点算的物件、动作或数目做出来。
- 不做翻译腔框架（"在……的过程中""进行了……的讨论""对于……来说"），动作与对象直接相接。
- 单句"的"不超过 3 个；不用"带着一丝X"式万能状语代替表演。
- 叙述层不用顿悟收束（"这一刻他终于明白"），情绪高点落在本场景特有的画面。
- 句式有呼吸：短句不少于三成，连续三句不同字起头；段落长短错落。
- 少用"此外/同时/更重要的是"接逻辑；一章内至少有一处真实情绪落点与一处具体时间、数目或地名。`;

const CREATIVE_ENVIRONMENT_BRIEF = `【环境描写纪律】
- 只选一至三个能影响行动、暴露关系或标记时代的场景特有细节，织入人物正在做的事；删掉也不影响场景的写景不写。
- 细节必须来自当前地点和时刻，不从提示词示例借用通用意象。`;

const CREATIVE_PSYCHOLOGY_BRIEF = `【心理描写纪律】
- 心理只写会推动决定的矛盾；每段内心必须落到选择、话语、动作或可见后果。
- 用人物此刻独有的行为、注意对象和言外之意呈现，不复用提示词里的身体反应示范。`;

const CREATIVE_VALLEY_BRIEF = `【低谷与独立碎片】
- 本章是代价章：局面必须变差或变贵，用一件本场特有的物象写损失或受阻，禁止直写情绪标签。
- 独立故事碎片只刻画人物（物件与空缺），写完立刻回到正在进行的动作，不推进主线机关。
- 本章不得全额讨回，余波带到下一场。`;

const CREATIVE_LOSS_BRIEF = `【对比铺垫·先立后破】
- 重大失去只能伤到前文已经具体建立的人、关系与生活；若尚未建立，就先让可珍惜之物在完整互动中成立。
- 闪回补足只是细纲背书下的例外，不是默认路径；只有细纲已明确安排用回忆闪回补足先立后破铺垫时才可使用。
- 若前文已经充分铺垫，本场景直接承接那些既有细节的变化，不另造一套通用温情意象。`;

function guidanceHeadings(text) {
  const matches = String(text || '').match(/【[^】\n]{2,40}】/g) || [];
  return [...new Set(matches)].slice(0, 5).join('\n');
}

function compactTechniqueGuidance(text) {
  if (!String(text || '').trim()) return '';
  const lines = String(text).split('\n').map(line => line.trim()).filter(Boolean);
  const header = lines[0]?.match(/【[^】]+】/)?.[0] || '【文学技法】';
  const names = lines.slice(1)
    .map(line => line.match(/^[-·]\s*([^（：:。]{2,18})/)?.[1])
    .filter(Boolean)
    .slice(0, 2);
  return `${header}只从与本场景真正相关的技法中选一种，服务因果和人物，不为完成清单而炫技${names.length ? `；可考虑：${names.join('、')}` : ''}。`;
}

function compactDomainGuidance(text, kind) {
  if (!String(text || '').trim()) return '';
  const headings = guidanceHeadings(text);
  const body = kind === 'warfare'
    ? '写清地形、兵力/阵形、补给/通信、天气与伤亡中真正影响本次胜负的变量；敌我双方都按信息和利益行动，胜负必须产生可见代价。'
    : '让公开话语、私下筹码、信息差和执行后果互相咬合；各方都有可辩护目标，胜负来自筹码与误判，不来自对手突然降智。';
  return `${headings || (kind === 'warfare' ? '【战役写作纪律】' : '【朝堂权谋纪律】')}\n- ${body}`;
}

function compactScaleGuidance(text) {
  if (!String(text || '').trim()) return '';
  const heading = String(text).match(/【山河尺度纪律[^】]*】/)?.[0] || '【山河尺度纪律】';
  const scale = String(text).match(/本卷视野尺度[^\n。]*/)?.[0] || '';
  return `${heading}${scale ? `\n- ${scale}` : ''}\n- 镜头尺度服从本卷位置，但仍由当前 POV 可见的具体载体进入；不得用抽象形容词假装宏大。`;
}

// V0.99：推荐失败后的前段质量返工。签约通过只作“疑似基线”假设，不能替任何章节免检。
