// 由 prompts.js 拆分而来（V0.109.5）。只搬不改：声明体与拆分前逐字节一致。
'use strict';

import { AI_TASTE_FULL, EXTREME_CLICHES, STRICT_MOTIFS, REDLINES } from '../../data/redlines.js'; // V0.100.15 返工候选文风注入与本地检测同源
import { RECOVERY_WINDOW_LENGTH_RATIOS } from '.././recovery/recovery_contract.js'; // V0.100.15 窗口篇幅上下限与本地闸同源

// V0.99：推荐失败后的前段质量返工。签约通过只作“疑似基线”假设，不能替任何章节免检。
export function recommendationRecoveryDiagnosisInstruction({
  bookTitle, chapters = [], publicationFeedback = '', suspectedTurnChapter = 7, priorGlobalFailure = '',
  repeatedRebuildLosses = '',
}) {
  const text = chapters.map(chapter => `【第${chapter.idx}章 ${chapter.title || ''}】\n${chapter.text || ''}`).join('\n\n');
  const failureSection = priorGlobalFailure
    ? `\n【上轮返工整段复核未通过的总审结论】\n${priorGlobalFailure}\n针对结论指出的停滞区间：工单动作要给 rebuild（重构），rebuild_objective 必须写成"让局势发生实质变化的具体手段"（主动破局/人物付出代价/压缩循环节点），不得只给措辞级微调。（该结论仅作方向参考，不改变本次诊断范围。）\n`
    : '';
  const rebuildLossSection = repeatedRebuildLosses
    ? `\n【执行史回流：多轮重构未证明更优的章节】\n${repeatedRebuildLosses}\n`
    : '';
  return `你是负责退稿复盘的长篇网文总编辑。执行“推荐失败返工总诊断”，不是润色，也不是替平台猜算法。

作品：《${bookTitle}》
已知假设：第1—${Math.max(1, suspectedTurnChapter - 1)}章可能勉强构成基线；第${suspectedTurnChapter}章以后疑似越来越水。这个假设必须逐章用原文验证，不能按章号直接定罪。

本次诊断范围：仅下方给出的第${chapters[0]?.idx}—${chapters.at(-1)?.idx}章（共 ${chapters.length} 章）。指令其他位置提到的任何章节号（已知假设、总审结论）都只是背景参考，绝不得进入 quality_curve——quality_curve 只能覆盖本次输入的章节，多一章少一章都作废。

${publicationFeedback}
${failureSection}${rebuildLossSection}
逐章回答：
1. 本章真正发生了哪些有效事件（不是谈话轮次或信息复述）；
2. 章末相对章初发生了什么不可逆局势变化；
3. 人物作了什么选择、付出什么代价；
4. 本章兑现了此前什么阅读承诺；
5. 是否存在重复商议、假冲突、延迟回报、同义复述、场景无后果等注水信号；
6. 是否出现动作母题滥用、AI 模板句、编辑腔总结、同构比喻或对白空心化；把它们计入 filler_signals；
7. 章末是否产生具体的继续阅读问题。

【action 升级门槛】诊断证据是重复、循环或注水（同构场景反复、同义复述、无后果流程）时给 tune——整改手段是压缩、合并、让已有行动兑现后果；只有本章因果链断裂、或局面需要实质转向（承诺即将违约、弧线需要转折而旧稿没写）才给 rebuild。rebuild 不是让主角加戏：主角的人设、身份、年龄、权限必须与旧稿一致，重构的是因果与后果，不是人物风格——“记录上报、依制度行事”这类符合人物弧光的写法不是病，不得为“主动性/戏剧性”给人物开越权处方。

必须返回严格 JSON：
{
  "quality_curve": [{
    "chapter": 1,
    "score": 0,
    "action": "keep|tune|rebuild",
    "evidence": ["至少一段能在该章原文逐字定位的短引文"],
    "effective_events": ["有效事件"],
    "irreversible_change": "章末相对章初的不可逆变化；没有则空字符串",
    "character_cost": "人物选择与代价；没有则空字符串",
    "promise_delivery": "承诺兑现；没有则空字符串",
    "filler_signals": ["注水证据；没有则空数组"],
    "ending_pull": "章末追读问题；没有则空字符串",
    "reason": "为何给出该分数和动作",
    "rebuild_objective": "tune/rebuild 的可验收目标：写局势要发生的实质变化与人物要付出的代价，不写‘设置陷阱/施压/博弈’式桥段处方；keep 时可为空"
  }],
  "segment_verdict": {
    "deterioration_found": true,
    "turn_chapter": ${suspectedTurnChapter},
    "reason": "质量曲线结论及证据"
  }
}

约束：score 为 0—100 整数；输入中的每章必须且只能出现一次；evidence 不得杜撰；每个 evidence 元素必须是原文中连续出现的一段（如两段对白中间夹着“他说”，就拆成两个数组元素，不能删掉中间叙述后拼成一句）；禁止用省略号（……/...）把相距较远的两处拼成一条；不能声称改楔子即可解决后续正文；不能预测推荐成功率。

体量纪律：每章 evidence 1—2 条且每条不超过 30 字；effective_events/filler_signals 各不超过 3 条；其余单个字符串不超过 60 字。写具体动作与后果，例如“主角烧掉退路文书，失去撤退选择”，不要写“节奏需要加强”一类空评。

【待诊断正文】
${text}`;
}

// V0.100.7：五章批次只负责逐章取证；多批次完成后必须由全范围蓝图统一组织因果链，
// 防止把互相独立、甚至彼此矛盾的局部建议直接拼成一批重写工单。

// V0.100.7：五章批次只负责逐章取证；多批次完成后必须由全范围蓝图统一组织因果链，
// 防止把互相独立、甚至彼此矛盾的局部建议直接拼成一批重写工单。
export function recommendationRecoverySynthesisInstruction({
  bookTitle, qualityCurve = [], segmentVerdicts = [], publicationFeedback = '', priorGlobalFailure = '',
  repeatedRebuildLosses = '',
}) {
  return `你是长篇网文的总返工策划。执行“推荐返工全范围综合规划”。前置编辑已分批逐章读过正文，下面给出的逐章取证均已通过原文定位；你的任务不是重新打分，也不是润色，而是把跨章问题组织成少量可执行的因果弧。

作品：《${bookTitle}》

必须做到：
1. 找出连续章节为何反复发现问题却不升级、人物为何没有付出代价、承诺为何迟迟不兑现；
2. 每条弧写清入口状态、出口状态和逐章因果步骤，出口必须与入口发生可验证变化；
3. 每个 tune/rebuild 章节必须且只能生成一张 chapter_order；原诊断为 rebuild 的章不得降级为 tune；
4. chapter_order.evidence 只能逐字复用该章取证中的 evidence，不得新造引文；
5. depends_on 只能引用本次需要返工的其他章节，禁止自依赖和循环依赖；
6. protected_facts 写明不能被重写破坏的既定事实；must_handoff 写明本章必须交给后章的具体新状态；
7. 不得把新增楔子、堆新章节或猜测平台算法当成修复前20章的手段；
8. tune 只能压缩、重排、深化旧稿已经存在的事件、信息差、选择和后果；禁止用“增加一个意外/险情/潜在威胁/陌生人/密信”机械制造张力。确需改变剧情因果时，必须有本章取证支撑并使用 rebuild；
9. 不得把时间相隔、剧情阶段不同的弱章仅因“都偏慢”塞进一条万能大弧。每条弧必须有直接因果接力；独立的局部节奏问题应拆成各自小弧；
10. protected_facts 只能写该弧最早章节开始前已经成立的事实。后续死亡、身份揭晓、通敌结论、收网结果等未来信息只能放到对应章节的 causal_step/must_handoff，绝不能作为早章改写素材；
11. objective 与 causal_step 只写“局势要发生的可核验变化、主角要付出的代价与交接状态”，禁止写成桥段处方（如“设置验证陷阱”“心理施压”“战术博弈”“反杀”）——具体手段由执行模型从旧稿人设、身份与已有资源中决定，处方式措辞会被本地净化器直接替换。

必须返回严格 JSON：
{
  "arcs": [{
    "id": "arc-stable-id",
    "chapters": [6, 7, 8],
    "problem": "跨章问题",
    "entry_state": "进入该弧时已经成立的状态",
    "exit_state": "完成该弧后必须成立且不同于入口的状态",
    "causal_steps": [{ "chapter": 6, "required_change": "本章必须造成的变化" }],
    "protected_facts": ["不能被改坏的既定事实"]
  }],
  "chapter_orders": [{
    "chapter": 6,
    "action": "tune|rebuild",
    "objective": "可验收的本章任务",
    "evidence": ["只能复制该章逐章取证里的原文引文"],
    "reason": "该章在整条因果弧中的职责",
    "plan_arc_id": "arc-stable-id",
    "depends_on": [],
    "must_handoff": "本章结束时必须交给下一环的具体状态"
  }]
}

约束：arcs.id 唯一；每个返工章恰好属于一条弧；chapters、causal_steps 与 chapter_orders 只能使用输入范围内真实章号；字符串必须具体，禁止“加强节奏、提升张力、优化文笔”这类空话；不得把未来事实倒灌到早章；不要输出 Markdown。

${publicationFeedback}
${priorGlobalFailure ? `\n【上轮整段否决结论】\n${priorGlobalFailure}\n` : ''}${repeatedRebuildLosses ? `\n【执行史回流：多轮重构未证明更优的章节】\n${repeatedRebuildLosses}\n` : ''}
【已验证逐章取证】
${JSON.stringify(qualityCurve)}

【分批趋势结论】
${JSON.stringify(segmentVerdicts)}`;
}

// V0.100.15 写审同源文风边界：词表与阈值全部来自 redlines 单一真源（此前 compact 文风规则
// 只给一句抽象话，返工候选不知道本地闸会判废哪些具体形态，稳定撞闸——实测 ch16 实证）。
// 措辞给替代路径不给恐吓：红线只约束语言形态，事件与因果层鼓励大胆改写，防 REWRITE_UNCHANGED。

// V0.100.15 写审同源文风边界：词表与阈值全部来自 redlines 单一真源（此前 compact 文风规则
// 只给一句抽象话，返工候选不知道本地闸会判废哪些具体形态，稳定撞闸——实测 ch16 实证）。
// 措辞给替代路径不给恐吓：红线只约束语言形态，事件与因果层鼓励大胆改写，防 REWRITE_UNCHANGED。
function recoveryTasteGuardText() {
  const motifWords = STRICT_MOTIFS.map(motif => (Array.isArray(motif) ? motif[0] : motif));
  return `【文风硬边界（与本地检测器同一词表；只约束语言形态，不限制你改写事件的胆量）】
- 通用 AI 套话同词出现 ${REDLINES.clicheDetectMedium} 次即判废，写到 ${REDLINES.clicheSameWordMax} 次就换掉：${AI_TASTE_FULL.join('、')}。
- 以下词在叙述里出现 1 次即判废，一个都不要用：${EXTREME_CLICHES.join('、')}。
- 特征动作母题同词出现 ${REDLINES.motifDetectMedium} 次即判废（同义变体合并计数）：${motifWords.join('、')}。
- "不是X，而是/是/更像Y"式抽象对比、"N年前X，如今Y"式成长总结句：出现 2 处即判废；直接写事实本身，成长由动作自证（对白引号内不受限）。
替代写法：用本场景特有的名词、动作、数字与感官细节直接陈述；情绪不交给叙述者总结，让人物此刻的选择和动作去呈现。以上边界之外，事件重排、因果重构、删并场景都放开手做。`;
}

export function recommendationRecoveryRewriteInstruction({
  bookTitle, chapter, chapterText, workOrder, prevTail = '', nextHead = '', publicationFeedback = '', styleRules = '', targetChars = 0,
  rewriteWindow = null,
}) {
  const sourceText = String(rewriteWindow?.oldText || chapterText || '');
  const beforeChars = sourceText.replace(/\s+/g, '').length;
  const windowMode = Boolean(rewriteWindow);
  const lengthRatios = RECOVERY_WINDOW_LENGTH_RATIOS;
  const lengthFloor = Math.max(
    Math.ceil(beforeChars * (workOrder.action === 'rebuild' ? lengthRatios.rebuildMin : lengthRatios.tuneMin)),
    targetChars >= 500 ? Math.ceil(targetChars * 0.55) : 0,
  );
  const lengthCeiling = Math.ceil(beforeChars * (workOrder.action === 'rebuild' ? lengthRatios.rebuildMax : lengthRatios.tuneMax));
  const arc = workOrder.plan_arc;
  // V0.100.15 执行注入侧中性化：诊断存档的 rebuild objective 可能是戏剧化处方（“设置
 // 验证陷阱/心理施压/布局试探”换马甲无穷，作者模型照做必 OOC 败选——实测 ch27-23
  // 两代实证）。存档保留诊断结论（V0.100.11），注入作者模型时一律替换为中性局势目标，
  // 手段由作者模型从旧稿人设与资源中长出来。causal_step 的“本章因果职责”同样中性化，
  // 防处方从弧职责字段泄漏进指令。
  const rebuildNeutral = '按已验证证据重构本章因果推进：主角用旧稿已有的身份、规则与资源作出有代价的选择，让局势发生可核验的实质变化';
  const injectedObjective = String(workOrder.action || '') === 'rebuild'
    ? rebuildNeutral
    : String(workOrder.objective || '');
  const injectedCausalDuty = String(workOrder.action || '') === 'rebuild'
    ? '让本章已有证据与选择造成可核验的局势变化，并把新状态交给下一章'
    : String(arc?.causal_steps?.find(step => Number(step.chapter) === Number(chapter.idx))?.required_change || workOrder.objective || '');
  const coordinationSection = arc || workOrder.must_handoff || (workOrder.depends_on || []).length
    ? `
【本章局部因果职责】
弧 ID：${workOrder.plan_arc_id || arc?.id || '未标注'}
本章前置依赖：${(workOrder.depends_on || []).length ? (workOrder.depends_on || []).map(idx => `第${idx}章`).join('、') : '无'}
本章必须交接：${workOrder.must_handoff || '未标注'}
本章因果职责：${injectedCausalDuty}
要求：只完成本章职责并留下明确交接，不得提前吞掉后续章职责。弧 ID 与交接语句是编辑任务，不是新增故事事实；凡未在旧稿、上一章尾部或下一章开头出现的人名、身份、死亡、通敌结论、密令与事故，一律不得据此写进本章。
`
    : '';
  const localBoundary = windowMode
    ? `
【本章窗口前文（只作接口，不得重写或在输出中重复）】
${rewriteWindow.beforeContext || '无'}

【本章窗口后文（只作接口，不得重写或在输出中重复）】
${rewriteWindow.afterContext || '无'}
`
    : '';
  const scopeDiscipline = workOrder.action === 'tune'
    ? `- tune 的默认动作是删与并：删除重复商议、同义复述与心理独白，合并同义场景；让窗口结束时旧稿已有的行动、信息差或选择更快兑现后果。
- 压缩不删过渡：环境短景、时间推移与收工/换班的过渡笔墨是节奏的一部分，可以精简但不得整段删除——直接从白天跳到夜晚会被读者感到突兀（实测 ch27 盲审实证：候选删掉灰烟收工过渡，两轮均以小分差败选）。
- 人物处理信息的标志性工作方式与习惯动作（具体的记录、核对、验证手法）是人物的一部分，必须原样保留——压缩注水不得用心理独白或情绪叙述替代具体的工作动作。
- 工单目标若含“推动/升级/带来新证据/更紧凑的危机”等扩写语义，一律翻译成“压缩现有材料使既有行动更快形成后果”执行；绝不新增行动、证据、险情、陌生人、密信或另一条情节线。`
    : '- rebuild 允许重构窗口内的行动因果，但新增变化必须由旧稿证据与本章职责推出；不得改掉窗口外已经成立的接口，也不得让人物的行事风格突变——重构的是因果与后果，不是人物。';
  return `你是长篇历史网文的重构编辑。请修订《${bookTitle}》第${chapter.idx}章《${chapter.title || ''}》中已定位的场景窗口；只返回可直接替换该窗口的完整正文，不要返回整章，不要解释、标题、Markdown 或修改说明。

这不是“把句子写漂亮”的任务。旧稿因推荐评估失败进入返工，目标是让这个场景在整段因果链中真的发生事情，同时保住窗口外已经写好的正文。

【返工工单】
动作：${workOrder.action}
目标：${injectedObjective}
旧稿证据：${(workOrder.evidence || []).join('；')}
诊断理由：${workOrder.reason || ''}
${coordinationSection}

【硬性验收】
- 保留已成立的人物身份、时间、地点、事实、窗口前后文与相邻章接口；不得凭空换主线。
- 工单/蓝图只规定改写职责，不是事实来源；不得把后章信息提前泄露，也不得用随机事故、陌生人、密信或突发袭击替代从旧稿因果中提质。
- 场景窗口篇幅：旧窗口约 ${beforeChars} 字${targetChars >= 500 ? `，参考目标约 ${targetChars} 字` : ''}；替换窗口不得低于 ${lengthFloor} 字，也不得高于 ${lengthCeiling} 字（异常膨胀会被本地校验直接拒收）。禁止概括缩写，也禁止为了凑字另起新事件——宁可聚焦改好已有场面，不要扩写新场面。
${scopeDiscipline}
- 至少有一个可辨认的有效事件，并让窗口结束时的状态与进入窗口时不同。
- 主角或核心人物必须作选择并承担具体代价，不能让旁人替他完成全部行动。
- 压缩重复商议、同义复述、无后果走动、旁白总结和虚假悬念。
- 清除重复“指腹/微微/按了按/蹲下”等动作母题、AI 模板句、编辑腔总结和换词复读；候选还要通过确定性本地文风规则，不是模型自称更好就算合格（完整词表见指令末尾的文风硬边界，动笔前后各核对一遍）。
- 工单目标是问题陈述，不是情节处方：目标里的抽象词（强化/施压/设置/博弈等）不得直译成戏剧化桥段（设陷阱、打脸、反杀、神机妙算式布局）；主角的手段必须从旧稿已有的人设、身份、年龄、军中规则和实物资源里长出来，让局势产生可核验的实质变化。
- 章末钩子来自本章行动造成的新后果，不得用陌生人突现、硬塞密信等万能事故敷衍。
- 不得新增楔子来掩盖本章空转；不得虚构平台偏好或审核阈值。
- 窗口外的正文会原样拼回：窗口结尾必须与窗口后文自然衔接，不得把收尾削弱成戛然而止，也不得重复窗口后文已写的内容。

${publicationFeedback}

${styleRules ? `【既有文风纪律】\n${styleRules}\n` : ''}
${localBoundary}
【上一章尾部（只作衔接）】
${prevTail || '无'}

【下一章开头（不得撞断）】
${nextHead || '无'}

【待替换场景窗口】
${sourceText}

再次确认：只输出“待替换场景窗口”的新版正文。窗口前后文和相邻章节绝不能复制进输出。

${recoveryTasteGuardText()}`;
}

export function recommendationRecoveryCompareInstruction({ chapter, candidateA, candidateB, round = 1, decisive = false }) {
  return `你是与改稿者隔离的匿名审稿人。执行“推荐返工匿名对照审稿”第${round}轮。A/B 的新旧身份被隐藏；不要猜身份，只比较读者实际会看到的文本。

【位置与打分纪律】A、B 的呈现顺序由轮次随机决定，与文本新旧、质量毫无关系——禁止因出现顺序、篇幅长短、风格熟悉感或"保守选原稿更稳"的心态偏向任何一方。先给 A、B 各自独立打分，再依据分数差给 winner；综合分差不足 5 分时必须判 tie，不得勉强选边；只在证据真正支撑时拉开分差。
${decisive ? '\n前两轮评审分差接近、未形成稳定结论。本轮是决胜轮：你必须给出明确判断——哪一版对读者整体更强，并把分差拉开到能反映真实差距的程度；只有在两版确实等同时才允许 tie。\n' : ''}

评审维度（每项 0—100）：
- progression：有效事件密度与局势推进；
- consequence：选择、代价和不可逆后果；
- character：人物主动性、关系与情绪是否通过行动成立；
- pull：章末继续阅读理由是否由本章因果产生。

必须返回严格 JSON：
{
  "winner": "A|B|tie",
  "margin": 0,
  "scores": {
    "A": {"progression": 0, "consequence": 0, "character": 0, "pull": 0},
    "B": {"progression": 0, "consequence": 0, "character": 0, "pull": 0}
  },
  "evidence": {
    "A": ["一句能在A正文逐字定位的连续短引文（8—30字）"],
    "B": ["一句能在B正文逐字定位的连续短引文（8—30字）"]
  },
  "reason": "只谈文本证据，不谈平台概率"
}

【引文纪律】（违反即作废重答）每条引文必须是正文里逐字连续的一段——半句也行，越短越稳；禁止用“……”或省略号把两处拼成一条；对白只引连续一段，不得拼接说话人标签两侧；引文里不得夹带章节号、分析或评语（分析全部写进 reason）。
margin 表示胜者领先的综合分差；没有清晰胜者就选 tie。A、B 各至少引用一处原文，禁止礼貌性判新稿更好。

【评审章节】第${chapter.idx}章《${chapter.title || ''}》

【候选 A】
${candidateA}

【候选 B】
${candidateB}`;
}

export function recommendationRecoveryGlobalReviewInstruction({
  bookTitle, chapters = [], qualityCurve = [],
  segmentIndex = 1, segmentCount = 1, priorConclusions = [], precedingTail = '',
}) {
  const inSegment = new Set(chapters.map(chapter => Number(chapter.idx)));
  // 旧诊断索引始终给全量：分段只为控制输入体量，不能让评审失去整段图景——
 // 实测的整段否决原因正是"23-30 章连续八章调查停滞"这类跨章累积，
  // 只看本段索引会把跨段重复模式误判成局部瑕疵而放行。
  const index = qualityCurve
    .map(item => `第${item.chapter}章[${inSegment.has(Number(item.chapter)) ? '本段' : '段外'}]：`
      + `旧诊断 ${item.score ?? '—'} 分 / ${item.action || '—'} / ${item.reason || ''}`)
    .join('\n');
  const text = chapters.map(chapter => `【第${chapter.idx}章 ${chapter.title || ''}】\n${chapter.text || ''}`).join('\n\n');
  const segmentNote = segmentCount > 1
    ? `\n本次只审第 ${segmentIndex}/${segmentCount} 段（第${chapters[0]?.idx || '?'}—${chapters.at(-1)?.idx || '?'}章）。`
      + `整段由多段复核组成，任一段 fail 则整批不落盘；请只就本段正文作出判断，不要替段外章下结论，`
      + `但要把段外章的旧诊断当作整段走向的参照——若本段问题与相邻段同源，那是跨章累积而非局部瑕疵，必须 fail。\n`
    : '';
  const priorNote = priorConclusions.length
    ? `\n【前段结论（本段必须在此基础上继续累积，不能把已解决或已否决的方向重复一遍）】\n${priorConclusions.map((item, i) => `${i + 1}. ${item}`).join('\n')}\n`
    : '';
  const handoffNote = precedingTail
    ? `\n【上一段结尾（只作衔接检查，不要重复评审）】\n${precedingTail}\n`
    : '';
  return `你是最后一道失败关闭的总审。执行“推荐返工整段复核”：检查候选后的第${chapters[0]?.idx || 1}—${chapters.at(-1)?.idx || 20}章是否形成持续推进，而不是每章孤立可读、连起来仍然水。

作品：《${bookTitle}》
重点检查：相邻章因果接力、有效事件密度、局势变化是否累积、承诺是否按期回报、人物是否持续承担代价、重复冲突是否换皮，以及章末钩子是否在下一章真正承接。${segmentNote}${priorNote}${handoffNote}
必须返回严格 JSON：
{
  "verdict": "pass|fail",
  "sustained_progression": true,
  "evidence": ["至少一段可在候选正文逐字定位的短引文"],
  "reason": "整段质量曲线结论",
  "residual_risks": ["仍存风险；没有则空数组"]
}

evidence 每条只能是本段候选正文里的逐字连续短引文——不要把章节号、分析或评语写进 evidence（分析全部写进 reason）；也不要用省略号拼接相距很远的两段。只有本段明显形成因果累积且不再靠注水拖延时才能 pass。不要预测平台是否通过，不要因已经花费模型调用而降低标准。

【旧诊断索引】
${index}

【候选${segmentCount > 1 ? `（第 ${segmentIndex}/${segmentCount} 段）` : '整段'}】
${text}`;
}

/**
 * 多段正文各自通过后的小上下文总复核：不再重复塞全书正文，而是同时查看每段经证据
 * 校验的结论、所有分段边界和全范围 repair_plan，专门裁决跨段因果/角色状态/保护事实。
 */

/**
 * 多段正文各自通过后的小上下文总复核：不再重复塞全书正文，而是同时查看每段经证据
 * 校验的结论、所有分段边界和全范围 repair_plan，专门裁决跨段因果/角色状态/保护事实。
 */
export function recommendationRecoveryCrossSegmentReviewInstruction({
  bookTitle, segments = [], repairPlan = null,
}) {
  const segmentText = segments.map((segment, index) => `【第${index + 1}段：第${segment.from}—${segment.to}章】
局部裁决：${segment.verdict} / 持续推进：${segment.sustained_progression}
理由：${segment.reason || ''}
已定位证据：${(segment.evidence || []).join('；')}
残余风险：${(segment.residual_risks || []).join('；') || '无'}
段首边界：${segment.entry_excerpt || ''}
段尾边界：${segment.exit_excerpt || ''}`).join('\n\n');
  return `你是推荐返工的最后一道“跨段总复核”。各分段已经分别通过局部正文审查；现在禁止把这些局部绿灯直接相加成整体通过。

作品：《${bookTitle}》

只检查跨段层面的整体成立性：
1. 前段出口是否成为后段入口的真实原因，是否出现事件、时间、地点或持物状态无交接跳变；
2. 人物身份、关系、伤亡、资源、世界观规则和 protected_facts 是否跨段自洽；
3. 全范围因果修复计划的 entry_state → causal_steps → exit_state 是否真正闭合，而非每段各自热闹；
4. 同一停滞/冲突是否换皮后跨段重复，承诺与代价是否在后段兑现。

必须返回严格 JSON：
{
  "verdict": "pass|fail",
  "sustained_progression": true,
  "segment_consistency": true,
  "evidence": ["逐字复制下方已定位证据中的至少一条短引文"],
  "reason": "跨段因果与状态一致性的总裁决",
  "residual_risks": ["仍存风险；没有则空数组"]
}

只有所有分段之间的因果、状态和保护事实都一致，且整体推进闭合时，verdict 才能为 pass，segment_consistency 才能为 true。证据只能逐字复制下方“已定位证据”的短引文，不得编造；不要因各段已通过而礼貌放行。

【全范围因果修复计划】
${JSON.stringify(repairPlan || {}, null, 2)}

【分段审计结论与边界】
${segmentText}`;
}

/** 过渡衔接检查：上一章结尾 vs 本章开头 */

/** 全书诊断指令：定位 P0/P1/P2 问题 */
export function polishDiagnoseInstruction({ bookTitle, settings, outlines, summaries, fullText }) {
  return `你是全书终审编辑。请通读《${bookTitle}》全书材料，输出结构化诊断报告。

【设定】${settings}

【大纲与摘要索引】
${outlines}

【全书正文（可能截断/分卷提供）】
${fullText}

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "overall": "总评（150字内）",
  "structure": "结构节奏问题（如：高潮位置、铺垫过长、章间衔接生硬）",
  "character": "人设/台词问题（如：角色语气同质化、行为与性格矛盾）",
  "logic": "设定逻辑硬伤（如：力量体系失衡、规则前后矛盾）",
  "style": "文风 AI 味问题（句式套路、高频词，以及 V0.109.3 新增的机器腔维度：抽象黑话/空洞大词、翻译腔框架、单句多重'的'、叙述层顿悟升华收束、'带着一丝X'式万能状语、三句等长同字起头的排比凑势、整章句式板结（短句不足三成）、连接词硬接逻辑、通篇无情绪落点或无具体时间数目地名）",
  "priorities": [
    {"priority": "P0|P1|P2", "chapter": 章节号, "type": "logic|transition|style|rhythm|dialogue|polish", "issue": "问题描述", "feedback": "50-150字的修改意见"}
  ]
}
规则：priorities 每条必须定位到具体章节号；P0 只用于必须修改的硬伤；宁缺毋滥。请输出 JSON。`;
}

/** 五维一致性核查指令 */

/** 五维一致性核查指令 */
export function polishConsistencyInstruction({ bookTitle, outlines, summaries, fullText }) {
  return `请对《${bookTitle}》做全书一致性核查，输出 Markdown 表格风格的结构化 JSON。

【大纲/摘要索引】${outlines}

【全书正文】${fullText}

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "checks": [
    {"dimension": "时间线|人设|地理道具|伏笔|章间衔接", "severity": "high|medium|low", "chapter": 章节号, "quote": "原文摘录（30字内）", "issue": "矛盾说明", "fix": "最小改法"}
  ]
}
规则：只报客观矛盾，拿不准不报。请输出 JSON。`;
}

/** 工单执行：最小化修订指定章节
 *  V0.109.3：注入 AI 腔简报——打磨工单里若涉及机器腔（抽象黑话/翻译腔/顿悟收束等），
 *  执行模型须按与写作、审校同一把尺去改（写审同源），否则改完仍是同一股机器味。 */

/** 工单执行：最小化修订指定章节
 *  V0.109.3：注入 AI 腔简报——打磨工单里若涉及机器腔（抽象黑话/翻译腔/顿悟收束等），
 *  执行模型须按与写作、审校同一把尺去改（写审同源），否则改完仍是同一股机器味。 */
export function polishExecuteInstruction({ bookTitle, chapterIdx, chapterTitle, chapterText, feedback, prevChapterTail, styleRules = '', aiFlavorBrief = '' }) {
  return `请对《${bookTitle}》第${chapterIdx}章《${chapterTitle}》按以下工单做最小化修订（只改涉及部分，不改其他内容，保持情节走向不变）。

【修改要求】${feedback}
${styleRules ? styleRules + '\n' : ''}${aiFlavorBrief ? aiFlavorBrief + '\n' : ''}
${prevChapterTail ? `【上一章结尾】（确保衔接自然）\n${prevChapterTail}\n` : ''}

【本章原文】
${chapterText}

请只输出修订后的完整章节正文，不要任何解释或标记。若无需修改，原样输出原文。`;
}

// V0.100：正文模型需要“当前场景的创作简报”，而不是把审校手册全文背一遍。
// 详细规则仍由 audit/rules 执行；这里仅保留会改变创作决策的少量约束，并主动删除
// 负面示例里的万能动作，避免模型因提示词暴露而高频模仿。
