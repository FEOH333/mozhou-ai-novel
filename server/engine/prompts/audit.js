// 由 prompts.js 拆分而来（V0.109.5）。只搬不改：声明体与拆分前逐字节一致。
'use strict';

import {
  perspectiveText,
} from './common.js';

/** V0.80 契约承诺核对指令（书契约"前N章承诺"是否兑现） */
export function promiseCheckInstruction({ bookTitle, promiseText, dueChapter, summaries }) {
  return `你是网文编辑。请核对《${bookTitle}》书契约里的一条承诺是否已兑现。
【任务标识】契约承诺核对
【承诺】${promiseText}（要求在第 ${dueChapter} 章前兑现）
【已写章节摘要（最近）】
${(summaries || []).join('\n') || '（无）'}

判断：这一条承诺（如"前3章必有打脸"）在实际已写章节里是否兑现了？
- met=true：确实兑现（如真有打脸/功法/冲突）
- met=false：没兑现（如 3 章了还没打脸）——诚实判断，不要为了过关而谎报

请输出 JSON（不要输出 JSON 以外的任何内容）：
{"met": true, "evidence": "在哪一章如何兑现（一句话）", "gap": "若未兑现，缺什么/差多远（无则空串）"}
请输出 JSON。`;
}

/** V0.80 逐章吸引力质量门指令（留存审计员——防平淡/无钩子/无爽点/主角被动；pre-settle 拦截）
 *  V0.82：历史题材（史实流）——"爽点"语义改历史文（立威/识破/军功/布局，须配代价）
 *  V0.84：正文置于指令最末（固定规则段进命中前缀，提缓存命中率） */

/** V0.80 逐章吸引力质量门指令（留存审计员——防平淡/无钩子/无爽点/主角被动；pre-settle 拦截）
 *  V0.82：历史题材（史实流）——"爽点"语义改历史文（立威/识破/军功/布局，须配代价）
 *  V0.84：正文置于指令最末（固定规则段进命中前缀，提缓存命中率） */
export function attractionGateInstruction({ bookTitle, chapterTitle, chapterIdx, chapterText, localIssues, localSignals = {}, isHistory = false, platformGuidance = '', genreProfile = '', storyPromise = '' }) {
  const satisfyCheck = isHistory
    ? '- 本章是否给出至少一种具体阅读回报（依恋建立/生存进展/能力成长/关系变化/信息揭示/尊严守住/战术得手/战略推进/情绪余韵）？没有 → 报「本章无阅读回报」。铺垫章可以不赢、不打斗，但不能空转；胜利必须有代价'
    : '- 本章是否给出与本书创作宪章匹配的具体回报（人物关系、信息、能力、利益、选择后果、情绪释放或玩法推进）？不得把“没有打脸/碾压词”直接判成无回报';
  return `你是网络小说逐章文本审阅员。审阅《${bookTitle}》第${chapterIdx}章《${chapterTitle}》的吸引力与连续阅读动力，只判断可由正文证据支持的问题，不预测读者行为或平台结果。
（注意：你只审"读者吸引力"，不管设定一致性——那是另一道审校。）
${isHistory ? '\n（历史题材：按多类型阅读回报判定，不强迫肢体冲突或公开打脸；重要悲剧前的依恋建立、关系推进和信息增量都属于有效回报，胜利须配代价）\n' : ''}
${storyPromise ? `【本书创作宪章】\n${storyPromise}\n` : ''}
${platformGuidance || '【官方创作指导】无特定平台事实，仅按文本本身审阅。'}
${genreProfile || '【题材样本观察】无特定样本；不得自行补造平台偏好。'}
以上官方指导、题材样本与编辑启发都不是统一审核阈值；最终以本章真实文本和本书创作宪章为准。

【本地客观异常（有问题才列出）】
${(localIssues || []).map(i => `- [${i.type}/${i.severity}] ${i.issue}`).join('\n') || '（无）'}

【本地计数信号（只能帮助定位，词表未命中不等于没有事件、钩子或阅读回报）】
${JSON.stringify(localSignals || {})}

判定标准：
- 开头是否很快形成可感知的变化、关系动作、人物选择或具体问题？含蓄的反常细节也算，不要求暴力或固定字数内爆点
- 结尾是否留下自然的未完成动作、疑问、关系余波、选择后果、信息差或局势变化？不要求出现固定“钩子词”或机械悬崖句
- 主角是否在其年龄、身份和处境允许的范围内作出反应、选择或判断？不能用“他/我”字数或个别被字句替代语义判断
${satisfyCheck}
- 是否有番茄禁忌（大段背景说明/主角连续窝囊不反击/节奏拖沓）？有 → 报对应项

请输出 JSON（不要输出 JSON 以外的任何内容）：
{"verdict": "pass|fix|replan", "issues": [{"type":"平淡开场|无章末钩子|主角被动|本章无有效回报|节奏拖沓|背景堆砌","severity":"high|medium|low","quote":"原文引用","issue":"问题描述","fix":"具体修改建议"}], "score": "S|A|B|C|D", "reason": "一句话结论"}
- verdict=fix：问题可小幅修订解决（如补章末钩子/把冲突前移）；verdict=replan：问题在细纲层面（整章设计平淡无冲突），需重规划。
- high/medium 问题必须给出正文原句、语义根因和最小改法；只有词表未命中而无正文证据时必须忽略。
- 若这一章有变化、有继续阅读动力、有${isHistory ? '具体阅读回报' : '有效回报'}、主角并非全程被动 → verdict=pass，issues=[]。

【本章正文】
${chapterText}

请输出 JSON。`;
}

/** 吸引力修订只修当前缺口；用本章已有因果写出余力，不强塞远方钩或审讯主动。 */

/** 吸引力修订只修当前缺口；用本章已有因果写出余力，不强塞远方钩或审讯主动。 */
export function attractionRevisionNote({ isHistory = false, rewardMode = '' } = {}) {
  if (isHistory) {
    return `在保持细纲情节走向和史实边界的前提下强化本章吸引力：用本章已有因果写出自然产生的余力（疑问/关系/抉择/信息差/局势/余韵均可），补足一种具体阅读回报${rewardMode ? `（优先：${rewardMode}）` : '（依恋/生存/能力/关系/信息/尊严/战术/战略/余韵）'}。不得硬塞陌生人、密信、烟柱、犬吠或远方异动；不得把观察改成审讯来显得主动。铺垫章不必取胜或打斗；若有胜利须写代价。不要新增与细纲冲突的情节。`;
  }
  return '在保持细纲情节走向和本书核心吸引点的前提下，只修审阅中有原文证据的缺口：让场景产生变化或具体回报，让人物作出符合身份的反应或选择，用本章已有因果写出自然产生的余力。不要强塞打脸、围观震惊、机械悬崖、陌生人、密信或烟柱，不要新增与细纲冲突的情节。';
}

/** 一致性审校指令（严格核查边界 + 多档判定）
 *  V0.82：eraContext 槽位——历史题材注入时代红线/史实骨架/可改史点作审校基准（防史实错误/事件提前/人物写错生死） */

/** 一致性审校指令（严格核查边界 + 多档判定）
 *  V0.82：eraContext 槽位——历史题材注入时代红线/史实骨架/可改史点作审校基准（防史实错误/事件提前/人物写错生死） */
export function auditInstruction(ctx) {
  const { bookTitle, chapterTitle, chapterText, factsText, foreshadowsText, characterStates, contract, deceasedText = '', perspective = 'third', chapterOutline = '', eraContext = '', warfareCheck = false, courtCheck = false, chapterYear = null, prevChapterYear = null, scaleRegisterText = '', continuityCraft = '', openingContractText = '', cardText = '', diversityText = '', craftOccupancyText = '' } = ctx; // V0.87 战役章战争逻辑核查 // V0.88 朝堂/权谋章权谋逻辑核查 // V0.94 年份坐标（时间线量词核查） // V0.95.8 山河尺度纪律（历史长篇分层配额） // V0.97 细节一致与章法轮换（写审同源） // V0.98 读者前置契约（仅结构） / V0.103 近窗换轴
  // V0.87：战争逻辑为独立类型（非历史书不误标「史实错误」）；类型枚举仅战役章追加，1.6 核查边界也仅战役章注入（P2-4 条件注入）
  // V0.88：权谋逻辑同法——仅朝堂/权谋章追加「权谋逻辑」类型与 1.7 核查边界（条件注入）
  const typeEnum = `角色矛盾|时间线冲突|设定冲突|人称视角|伏笔遗忘|事实编造|事实矛盾|语句质量|AI 腔|大纲偏离|情感连贯性|文学性|史实错误|环境描写缺失|心理描写标签化${warfareCheck ? '|战争逻辑' : ''}${courtCheck ? '|权谋逻辑' : ''}`;
  const warfareBoundary = warfareCheck ? `1.6 战争逻辑核查（V0.87，仅战役章节，草稿含攻城/守城/围城/北伐/决战等战役内容时执行）：
   - 敌方无脑硬冲/降智送死（攻城不写战术手段：云梯/地道/断粮/招降/夜袭/砲石，直接"喊杀冲上城墙"）→ medium「战争逻辑」（战争逻辑崩坏，全员智商在线是硬要求）；
   - 奇袭/偷袭无铺垫无反制（直接得手、守方毫无反应）→ medium「战争逻辑」；
   - 战役无节奏（一场战斗一章打完、无侦察/试探/拉锯/转折过程、"一夜打一年"）→ medium「战争逻辑」；
   - 无战场感官与代价（只有"喊杀震天"、无伤亡/粮草/疲惫/气味/声音细节，胜利无成本）→ medium「战争逻辑」；
   - 短兵白刃无血肉手感与余波（主角近战段落没有刀入肉的手感/血的热气/濒死者的脸，杀完无手抖干呕夜惊，伤亡无具体有名有姓的人，V0.98.13 近战残酷纪律）→ medium「战争逻辑」（血与痛每落一处，角色就变一分——成长印记要承接，不许打完全场无事发生过）；
   - 战役不写后方联动（打完全无朝堂/粮道/增援反应）→ low「战争逻辑」（soft 提示，不参与 verdict）。
` : '';
  const courtBoundary = courtCheck ? `1.7 权谋逻辑核查（V0.88，仅朝堂/权谋章节，草稿含廷议/奏折/弹劾/圣意/党争/权臣等朝堂内容时执行）：
   - 皇帝/权臣降智（全知无理由/决策无信息依据/一言不合乱杀忠臣）→ medium「权谋逻辑」（最高权力博弈全员智商在线是硬要求）；
   - 朝堂对话只有一层意思（无话里有话/试探/留白/借古讽今）→ medium「权谋逻辑」；
   - 暗线无铺垫直接引爆（权谋事件凭空发生、无前文埋点）→ medium「权谋逻辑」；
   - 权谋无代价（主角/权臣步步得手全赢、无信任消耗/树敌/人命/声名损失）→ medium「权谋逻辑」；
   - 权谋不传导主线（只发生在权力中心、与主角的军费/援军/圣旨/资源/利益无关）→ low「权谋逻辑」（soft 提示，不参与 verdict）。
` : '';
  return `你是小说连续性审校员。请审校《${bookTitle}》章节《${chapterTitle}》的草稿，找出与已定事实的冲突。${warfareCheck ? '\n（V0.87：本章为战役章节——除一致性外，还需核查战争逻辑：敌方不降智/战术有铺垫有反制/有节奏有代价/有后方联动，见下方核查边界 1.6）' : ''}${courtCheck ? '\n（V0.88：本章为朝堂/权谋章节——除一致性外，还需核查权谋逻辑：皇帝/权臣不降智/对话双层/暗线有铺垫/权谋有代价/传导主线，见下方核查边界 1.7）' : ''}
${eraContext ? `\n【历史时代基准】（历史题材：史实骨架/时代红线/可改史点。草稿违反以下基准须报 high「史实错误」——史实硬伤是历史文读者绝对不能接受的雷区）\n${eraContext}\n` : ''}

${perspectiveText(perspective, '', 'audit')}
${chapterOutline ? `\n【本章细纲】（正文按此执行。若正文出现了细纲明确要求的人物/地点/设定，即使尚未登记，也**不应报"事实编造"**——那是细纲引入的待登记设定，正文末尾用【新设定】标记即可；只有细纲和事实库都未涉及、纯属正文凭空冒出的才算编造）\n${chapterOutline}\n` : ''}
${openingContractText ? `\n${openingContractText}\n` : ''}
${diversityText ? `\n${diversityText}\n` : ''}
${craftOccupancyText ? `${craftOccupancyText}\n` : ''}

【已定事实】（草稿若明确推进了设定，视为新事实而非冲突）
${factsText || '（无）'}

【书契约】（本书承诺与硬约束）
${contract || '（无）'}

【角色当前状态】
${characterStates || '（无）'}
${cardText ? `\n${cardText}\n硬规则：对白必须符合该角色的说话方式；踩中禁腔须报 medium「语句质量」。` : ''}
${deceasedText ? `\n${deceasedText}\n硬规则：已退场角色若在草稿中重新登场（回忆/闪回/遗物提及除外），必须报 high 严重度「角色矛盾」。` : ''}

【伏笔表】
${foreshadowsText || '（无）'}

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "issues": [
    {
      "type": "${typeEnum}",
      "severity": "high|medium|low",
      "quote": "草稿中的原文片段（20-60字）",
      "issue": "问题描述",
      "fix": "建议的修改方式"
    }
  ],
  "grade": "S|A|B|C|D（本章整体质量等级：S 极佳 / A 良好 / B 合格 / C 有瑕疵 / D 较差，参照网文标准严格打分）",
  "verdict": "accept|fix|defer|replan"
}

【核查边界——严格照此执行】
1. 只核查客观问题：姓名/称呼不一致、时间线倒错、与前情明确矛盾、能力身份与设定冲突、提前引入后续章节安排的事件、一次性事件重复发生、承诺/伏笔未兑现。
   - 同一意象可能对应不同事件或不同来源（如东南烧村火与北山斥候信号火）。若时间、用途或因果可区分，方向不同本身不能判为伏笔矛盾；只有正文明确声称是同一事件却与已定事实冲突时才报告。
1.5 史实核查（仅历史题材，时代基准非空时执行；V0.82 硬要求）：
   - 草稿把【时代基准】中"未到史实节点"的事件提前发生（如钓鱼城之战前就写蒙哥死）→ high「史实错误」（时间线史实冲突）；
   - 草稿改写"已过史实节点"的前因（既成史实被凭空篡改）→ high「史实错误」；只有"可改史点"允许主角改变后果；
   - 真实历史人物生死/身份/名号与基准不符（如余玠 1253 年已死却 1260 年登场）→ high「史实错误」；
   - 草稿触犯【时代红线】（本时代不存在的器物/词汇/异代制度）→ medium「史实错误」（本地规则已扫，此处复核）；
   - 真实历史人物被写成无脑工具人/主角崇拜者/被嘲讽物化 → medium「史实错误」；
   - 胜利无代价（不费吹灰之力/兵不血刃式碾压，无伤亡/粮草/政治代价）→ medium「史实错误」（历史文的爽必须有代价）。
${warfareBoundary}${courtBoundary}1.8 叙事视角核查（V0.90，贴身限知第三人称硬要求，全文通用）：
   - 同一场景内视角从当前 POV 跳到其他角色内心/其无法获知的远方事件（无明确场景分隔）→ medium「人称视角」（全知跳脑，限知视角硬要求）；
   - "他不知道的是/他并不知道/然而他不知道/命运的齿轮"类廉价信息揭示句式使用 ≥2 处 → medium「人称视角」（AI 高频病，用直接切镜头替代——切到和林/临安/敌营另起段落）。
2. 主观问题一律不报：文风、节奏、措辞偏好（系统已有独立规则检查）一律 PASS；拿不准的一律 PASS。
3. 文学性硬问题（V0.43，仅报此两类，宁缺毋滥）：
   - 整章纯平铺直叙（通篇"他做了X，然后Y，接着Z"，无任何感官细节/动作白描/心理或环境描写）→ 报 medium「文学性」；
   - 连续 3 章及以上同一句式模板开头或全文对话无动作穿插 → 报 medium「文学性」；
   - 单章出现 2 处以上无意义插叙/倒叙（未标注、打断阅读）→ 报 medium「文学性」。
3.5 情感连贯性软检（V0.49，只报 low 级提示，不参与 fix/defer 判定，仅供卷体检参考）：
   - 本章若为人物戏章节（细纲 character_beat 非空），草稿完全没体现该人物内心/关系变化 → 报 low「情感连贯性」；
   - 角色情绪与前文状态明显断裂（如上一章还在悲痛，本章无故兴高采烈且无铺垫）→ 报 low「情感连贯性」。
   注意：此类问题一律 severity=low，不得影响 verdict。
3.6 环境/心理描写缺失软检（V0.89，只报 low 级提示，不参与 fix/defer 判定，仅供卷体检参考）：
   - 本章为日常/市井/抒情类场景但草稿通篇无一处环境感官细节（声/嗅/触/味），或环境只堆形容词无具体物 → 报 low「环境描写缺失」；
   - 本章为情感/心理转折类场景但草稿用情绪词标签直述（"他感到愤怒""她很悲伤"）且无身体反应/行为/细节折射 → 报 low「心理描写标签化」。
   注意：此类问题一律 severity=low，不得影响 verdict。
3.7 闪回/插叙一致性核查（V0.93.2，全文通用）：
   - 闪回/插叙补写的事件与前文已呈现的同场景细节冲突（如闪回补入一个前文不存在的互动瞬间、台词或物件，读者回翻找不到落点）→ medium「时间线冲突」；
   - 闪回引入的新信息与前文已定事实无法共存（时间、地点、人物状态矛盾）→ medium「时间线冲突」。
   注意：闪回新信息若与前文相容且不伪造已呈现时刻，不算冲突。
3.9 场景越界/双版本核查（V0.94，全文通用——对照上方【本章细纲】逐场景核对）：
   - 某场景把后续场景节拍的事件写完（如细纲场景3 是"搏斗救回"，场景2 结尾已写完救援与回营）→ high「事实矛盾」（同一事件被写两遍，结构事故）；
   - 同一事件在同一章以两个互斥版本并存（细节矛盾：前说灯亮后说没点灯/一版无伤一版带伤）→ high「事实矛盾」；
   - 同一场景中时间突然倒退并重新接报/重新出发，或同一伤口再次剪衣、清洗、包扎，哪怕措辞不同也属于两个语义版本串接 → high「事实矛盾」；
   - 人物/车辆/物品上一场已被明确送走，下一场无返回过程却仍同行；重伤者在无时间间隔和伤情交代下立即远行；角色把他人转述改口成“亲眼所见” → high「事实矛盾」；
   - 场景正文把前面场景已呈现的信息原样再推一遍（信息零增量复读）→ medium「事实矛盾」。
3.10 时间线量词核查（V0.94，全文通用${chapterYear ? `；本章坐标年份 ${chapterYear}${prevChapterYear ? `，上一章 ${prevChapterYear}` : ''}` : ''}）：
   - 章首接续时间标记（"禁足第三日/翌日/次日/当夜"）与年份跨年同时出现 → high「时间线冲突」（接续表示数日内，跨年自相矛盾）；
   - 正文"N年了/N个月了"与两章坐标年份实际差不符（如差四年写"两年了"）→ medium「时间线冲突」；
   - 前文明确的时间跨度（季节/年份锚点）与本章回溯叙述矛盾 → medium「时间线冲突」。
3.11 章名兑现与台词腔调核查（V0.94，全文通用；V0.107 升级——章名与正文牛头不对马嘴是题眼级事故）：
   - **事件承诺型章名**（章名含决战/驾崩/破城/葬礼/即位/大捷等强事件词）而正文该事件零发生、零触及（连塘报/讣闻/转述式落地都没有）→ high「大纲偏离」（读者被章名骗进来，题眼章名与内容完全脱节）；
   - 具象章名（旗/衣/刀/册/桥等实物名）的核心名词在正文零出现且无对应事件 → medium「大纲偏离」（读者按章名期待落空）；若正文完整而章名确实失配，fix 字段给出贴合正文实际内容的改名建议（意象化 2-6 字，不剧透结局）；
   - 导师型配角台词连用"X不是X，是Y"偈语点题（全章 ≥3 处，或同一角色 ≥2 处）→ medium「文学性」（角色台词千人一面，道理应由事件体现）。
3.13 道具/伤情/状态一致性核查（V0.97，全文通用——精读实证连续性穿帮是读者最敏感的出戏点）：
   - 道具位置/状态无交代跳变（前文"刀收在怀里"后文"按了按腰间的刀"；前文灯已吹后文灯亮着；道具被带走后又在原主手里）→ medium「事实矛盾」；
   - 伤情/人数/物件数量前后不一致（前说"皮外伤"后变贯穿伤；战果账面对不平有人无下落）→ medium「事实矛盾」；
   - 时间承诺断链：前章末"明日/三日后"级承诺，本章跨年/跨季未接住 → medium「时间线冲突」。
3.14 剧情复读与章法核查（V0.97，全文通用——行文结构级 AI 味）：
   - 同一情报/发现/道理在同章或邻近章被原样再讲一遍（第二人得知应只写反应，不复述内容）→ medium「事实矛盾」；
   - 同一课反复上而无递进（前章已立的规矩/已学会的技能，后章又当新课重学且人物无长进）→ medium「文学性」；
   - 章首起手式/章末收束与近三章雷同（"天没亮+雾露"开篇、"灰烟明灭"收章、对亡亲报备式收束）→ low「文学性」；
   - 关键证物一章一得零阻力、敌方手握铁证仍不反制 → low「文学性」（节奏软提示；若物证直接推出唯一结论，按 3.15 升 medium）。
   - 高潮场景（细纲 scene_type=climax）的释放段只有顿悟/议论升华（"他终于明白""这一刻他懂了"式总结）而无有名字的地点、决定性动作或可数之物的具体定格 → medium「文学性」（高潮由画面兑现，不由道理总结兑现——读者记住的是画面不是道理）。
3.15 因果可信与人物真人感核查（V0.97.1，全文通用——二次精读实证）：
   - 物证/自然痕迹直接推出唯一结论，且省略合理替代解释或独立旁证（脚印精确认人、竹纹严丝合缝贴地图、火点直接等于兵数）→ medium「事实矛盾」；
   - 人物能力或权限无来源跃迁（未训练即胜过老兵；伙长擅自调粮、焚毁军资、封账、审俘；升职/带队无任命）→ medium「角色矛盾」；
   - 历史工程、伤情、弓马或侦察机理靠自造原理成立，常识上不能复核且无具名行家/史实基准支撑 → medium「事实编造」；历史题材明显违背时代技术则报 medium「史实错误」；
   - 同段连续抛出 5 个以上带单位数字，或人物用两段以上完整报告句替旁白汇总证据 → medium「文学性」；
   - 叙述/对白的「不是X。…是Y。」跨句拆分对比（"他等的不是那封信。是那个人的背影"式拆句点题，V0.98.14 读者一眼识别的形态；听声辨质感官判别句豁免）→ 叙述层 1 处 low、≥2 处 medium「文学性」；对白层计入偈语配额（≥3 处 medium）；
   - 连续 ≥3 段纯环境/外貌描写无对话无人物动作推进场景过渡（"大段描写+一句对话+大段描写"结构，场景过渡全靠描写段完成）→ medium「文学性」；
   - 两人以上对白没有试探/遮掩/诉求/关系变化，只轮流说完整结论，读起来可直接改成旁白且信息无损 → medium「文学性」。
3.16 人物活性核查（V0.108，全文通用——写审同源【人物活性纪律】）：
   - 对手/反派的行动无法从其立场/利益/目标解释（无脑针对主角："哪里有主角就去对付哪里"；明知代价远超收益仍硬冲；角色卡"他的立场"与实际行为完全脱节）→ medium「角色矛盾」（反派不降智——真正危险的反派无法停手，不是无脑送）；
   - 配角/对手的行为与其自身目标/性格完全无关、纯粹为推动主角剧情而存在（工具人：出现只为递情报/挡刀/送台阶，无自身生活线）→ low「角色矛盾」（主观性强，宁缺毋滥；只有明显"纸片人化"才报）；
   - 情绪只用旁白标签直述（"他悲痛欲绝/她很委屈"）而无任何具体身体反应或生活细节承载 → low「心理描写标签化」。
3.17 AI 腔核查（V0.109.3，全文通用——写审同源【AI 腔纪律】，本地检测同源同阈值）：
   - 叙事层出现商业/管理学黑话与空洞大词（赋能/闭环/底层逻辑/抓手/颗粒度/交织/画卷/时代洪流之类）→ medium「AI 腔」（这类词只在评论与商业语境成立，写进小说即出戏）；
   - 翻译腔框架（"在……的过程中""进行了……的讨论""对于……来说""被……所……""做出了……的决定"）→ medium「AI 腔」；
   - 叙述层用顿悟/道理收束情绪高点（"这一刻他终于明白""终于懂得了……的意义""这一切都有了意义"）→ medium「AI 腔」；注意：**人物在对白里说自己想通了不算违规**，只有叙述层用道理代替画面才报；
   - 万能状语代替表演（"带着一丝嘲讽""带着几分无奈""用……的语气说"）→ medium「AI 腔」；
   - 三句等长且同字起头的短句并列（排比凑势）→ low「AI 腔」；**正常的长短并列不报**（中文排比是正当修辞，只在工整到等长同字起头时才判机器痕迹）；
   - 单句"的"≥3 且属叙述层（层层套叠的"的字地狱"）→ low「AI 腔」；对白内的"的"多属口语自然，不报；
   - 整章短句（20 字以内）占比不足三成、或连续三句同字起头 → low「AI 腔」（句式板结）；
   - 整章连接词（此外/同时/更重要的是/换句话说等）密度显著偏高、靠连接词硬接逻辑 → low「AI 腔」；
   - 整章无任何情绪承载与主观视角、或通篇无具体时间/数目/地名 → low「AI 腔」（叙事没有温度与实地）；
   - 注意：文风偏好一律不报。上面各项都有本地确定性检测同源裁决，此处只复核本地难以判定的语义情形；单项命中即报，不要因为"整体还行"而放过明确的黑话与顿悟收束。
${scaleRegisterText ? `3.12 山河尺度核查（V0.95.8，历史长篇——对照下方【山河尺度纪律】的层级配额执行）：
   - 本章远景/中景/全景配额未达（按章合计核查，quote 引最接近的段落）→ medium「文学性」（书名承诺的山河与时代格局在正文缺位，正文缩成主角五感胶囊），且 verdict 至少 fix；
   - 大战章（围城/决战/陷落）无时代全景开篇或收束、战役不联动后方（朝堂/粮道/增援零反应）→ medium「文学性」；
   - 全局信息只有"局势吃紧"式无地名无数字的空话（对照第2层及以上要求）→ low「文学性」（soft 提示）；
   - 注意：仅核查配额与空话，"写得不够能燃"之类主观偏好一律不报。

【山河尺度纪律】（写作与审校同一把尺）
${scaleRegisterText}
` : ''}
${continuityCraft ? `
【细节一致与章法轮换纪律】（写作与审校同一把尺——3.13/3.14 的判定标准以此为准）
${continuityCraft}
` : ''}4. verdict 判定：
   - accept：无问题或仅 low 级措辞问题
   - fix：存在 high/medium 的客观矛盾，需要修订正文
   - defer：存在 medium/low 问题但修订风险大于收益（如回改会破坏前文衔接），记入债务由后续章节圆场   - replan：本章细纲与事实冲突严重（如大纲要求的事件与前情矛盾），需要重新规划本章
5. 只报告真实存在的问题，宁缺毋滥。没有问题时 verdict=accept，issues=[]。
6. issues 最多 8 条；同一根因的多处证据合并为一条，quote 可用“片段1……片段2”表示。
7. 在内部完成判断，不要输出推理过程、分析文字或 Markdown，只输出最终 JSON。

【本章草稿】（V0.84：草稿置于指令最末——前面 system+公共材料+核查规则构成稳定前缀，前缀缓存命中率提升；草稿本身仍完整提供给审校）
${chapterText}

请输出 JSON。`;
}

/** 要点覆盖校验指令（V0.84：正文置于指令最末，前缀命中段扩展到固定规则）
 *  V0.85：覆盖判定放宽"原句复刻"类要点——同义改写/意象等价/标点差异算覆盖（否则补写永不收敛卡章） */

/** 要点覆盖校验指令（V0.84：正文置于指令最末，前缀命中段扩展到固定规则）
 *  V0.85：覆盖判定放宽"原句复刻"类要点——同义改写/意象等价/标点差异算覆盖（否则补写永不收敛卡章） */
export function coverageInstruction({ bookTitle, chapterTitle, checkpoints, chapterText }) {
  return `请校验《${bookTitle}》章节《${chapterTitle}》是否覆盖了细纲要求的所有要点。

【细纲要点】
${checkpoints.map((c, i) => `${i + 1}. ${c}`).join('\n')}

判定规则：每项要点逐条核对；coverage.covered=true 当且仅当正文体现该要点（V0.85 放宽）：
- 要点要求"出现某原句/某画面/某意象"时，**同义改写、意象等价、标点/用词差异均视为已覆盖**——作者可以用自己的语言呈现，不必逐字复刻细纲；
- 要点要求"必须出现某事件/某人物"时，正文确实发生该事件/该人物登场即视为覆盖，不要求指定章节位置；
- 只有正文**完全没有**体现该要点（无等价画面/事件/人物）才判未覆盖；
- 若某要点与正文主旨冲突或明显是细纲笔误，可在 evidence 注明"该要点与本章主线冲突/疑似笔误"并将该点从 missing 排除。
missing 列出全部未覆盖要点；verdict=pass 当且仅当所有要点都 covered（按上述放宽标准）。

【本章正文】
${chapterText}

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "coverage": [
    {"point": "要点原文", "covered": true, "evidence": "正文中体现该要点的片段（可为空）"}
  ],
  "missing": ["未覆盖的要点原文"],
  "verdict": "pass|fix"
}
请输出 JSON。`;
}

/** 修订指令
 *  V0.73 质量修复：补上原文 + 长度硬约束——此前只有 scene.beat 与一句"约 N 字"，
 *  模型常把修订理解为"输出精简修正片段"，导致 revised 场景缩水到 200-500 字
 *  （实测 3 章字数跌至目标 25% 以下）。现在明确"完整重写、保持篇幅"并给 min/max 硬区间。 */

/** 修订指令
 *  V0.73 质量修复：补上原文 + 长度硬约束——此前只有 scene.beat 与一句"约 N 字"，
 *  模型常把修订理解为"输出精简修正片段"，导致 revised 场景缩水到 200-500 字
 *  （实测 3 章字数跌至目标 25% 以下）。现在明确"完整重写、保持篇幅"并给 min/max 硬区间。 */
export function reviseInstruction({ bookTitle, chapterTitle, scene, issues, extraNote, styleRules = '', continuityCraft = '', aiFlavorCraft = '', diversityText = '', craftOccupancyText = '' }) {
  const target = scene.target_words || 1000;
  const minWords = Math.round(target * 0.65);
  const maxWords = Math.round(target * 1.7);
  const original = (scene.content || '').slice(0, 2500);
  const issueList = Array.isArray(issues) ? issues : [];
  const openerFix = issueList.some(i => /开篇结构|起手|开篇族/.test(`${i?.issue || ''}${i?.fix || ''}${i?.type || ''}`));
  const freezeLine = openerFix
    ? '（只修复列出的问题；因开篇结构/起手饱和，允许改首句结构以换起手，其余情节与节拍保持，不得引入新情节）'
    : '（只修复列出的问题，其余情节、开篇结构、收束与节拍逐字不变，不得引入新情节）';
  const minChange = openerFix
    ? '【最小改动】只修复列出的问题。命中开篇饱和时允许改开篇换起手，其余逐字不变。不得补远方钩、陌生人、密信或烟柱，不得把观察改成审讯来显得主动。'
    : '【最小改动】只修复列出的问题，其余逐字不变。不得改开篇结构，不得补远方钩、陌生人、密信或烟柱，不得把观察改成审讯来显得主动。';
  return `请完整重写《${bookTitle}》章节《${chapterTitle}》中的以下场景。这是"全文重写"，不是精简、不是摘录、不是只改问题句——必须输出与原文篇幅相当的完整场景正文。

【场景要求】${scene.beat || ''}
POV：${scene.pov || ''}；地点：${scene.location || ''}；字数：必须输出 ${minWords}-${maxWords} 字（目标 ${target} 字）。宁可用具体动作与对话填满，也不得缩水。

【原文】（供你保持情节走向、节奏与篇幅）
${original || '（无原文，按场景要求新写）'}

【需要修正的问题】${freezeLine}
${issueList.map(i => `- [${i.severity}] ${i.type}：${i.issue}\n  原文：${i.quote}\n  建议：${i.fix || '见问题描述'}`).join('\n')}

${minChange}
【附加要求】${extraNote || '保持原场景的情节走向与节拍，只修正问题；不要引入新情节。'}
${diversityText ? `${diversityText}\n` : ''}${craftOccupancyText ? `${craftOccupancyText}\n` : ''}${styleRules ? styleRules + '\n' : ''}${continuityCraft ? continuityCraft + '\n' : ''}${aiFlavorCraft ? aiFlavorCraft + '\n' : ''}
【新设定登记】若剧情确实需要引入指令之外的新人物/新地点/新物品（例如细纲或前文出现但未登记的配角），可在正文末尾用【新设定:名词——简述】标记登记（系统会自动收录），而不是删掉该角色或情节；只有纯属多余的编造才删除。
请只输出重写后的完整正文，不要任何解释、标题或标记。`;
}

/** 章结算（抽取）指令：事实/角色/时间线/伏笔（含事件流水）/摘要/滚动摘要增量
 *  V0.73：注入"超期/临近回收伏笔"清单并强制 payoff 判定——此前模型结算时对伏笔
 *  永远输出 advance（从不 payoff），导致伏笔埋 100 章仍 0 回收、快感账本积压 300+ 条超期。 */

/** 章结算（抽取）指令：事实/角色/时间线/伏笔（含事件流水）/摘要/滚动摘要增量
 *  V0.73：注入"超期/临近回收伏笔"清单并强制 payoff 判定——此前模型结算时对伏笔
 *  永远输出 advance（从不 payoff），导致伏笔埋 100 章仍 0 回收、快感账本积压 300+ 条超期。 */
export function settleInstruction(ctx) {
  const {
    bookTitle, chapterTitle, chapterIdx, chapterText, outline = {}, knownFacts,
    knownCharacters, knownForeshadows, rollingSummary, dueForeshadows, eraNote = '',
  } = ctx;
  const knownFactLines = knownFacts?.length
    ? knownFacts.map(f => `- ${f.subject}${f.predicate ? ` ${f.predicate}` : ''}${f.object ? ` ${f.object}` : ''}`).join('\n')
    : '（无）';
  const dueText = dueForeshadows?.length
    ? dueForeshadows.map(f => `- [${f.id}]${f.desc}（埋于第${f.planted_chapter || '?'}章${f.payoff_chapter ? `，计划第${f.payoff_chapter}章回收` : ''}，当前：${f.status}）`).join('\n')
    : '（无）';
  return `你是小说数据取证员。只依据《${bookTitle}》第${chapterIdx}章《${chapterTitle}》当前正文生成可回放投影。

每一条事实性记录必须带 evidence；evidence 必须是当前正文连续出现的 4—40 个字原句。正文没有明确写出的内容不要推断，数组可留空。旧细纲只是原计划，不是已发生事实。

【旧细纲（只作计划对照）】
${JSON.stringify(outline).slice(0, 5000)}

【已登记事实（只用于识别变化）】
${knownFactLines}
【已登记角色】${knownCharacters?.length ? knownCharacters.join('、') : '（无）'}
【已登记伏笔】${knownForeshadows?.length ? knownForeshadows.map(f => `[${f.id}]${f.desc}（${f.status}）`).join('；') : '（无）'}
【临近/超期伏笔（正文已经给答案才 payoff，否则 advance 或不写）】
${dueText}
【此前滚动状态（不能凌驾于当前正文）】
${String(rollingSummary || '').slice(-1800) || '（无）'}
${eraNote ? `【权威年代坐标】${eraNote}\n` : ''}

只输出 JSON：
{
  "summary":"仅概括正文明确发生的事情，150字内",
  "rolling_update":"本章对全书局面的真实增量，200字内",
  "outline_actual":{
    "goal":"人物实际追求","conflict":"实际不可兼得的冲突",
    "dramatic_question":"实际提出并推进的核心追问","counterforce":"实际反作用力",
    "turn":"实际转折","irreversible_change":"章末不可逆变化",
    "choice_cost":"人物实际选择与代价","reader_gain":"读者得到的结果/信息/情绪",
    "reader_pull":"由本章因果自然产生的后续动力","evidence":"正文原句",
    "scenes":[{"id":"s1","beat":"这一段实际发生什么","evidence":"正文原句"}]
  },
  "facts":[{"subject":"主语","predicate":"关系/动作/属性","object":"宾语","evidence":"正文原句"}],
  "character_updates":[{"name":"角色名","changes":["位置=地点","状态=状态"],"evidence":"正文原句"}],
  "character_notes":[{"name":"角色名","note":"可证的性格表现/关键行为，30字内","evidence":"正文原句"}],
  "character_emotional":[{"name":"角色名","mood":"章末心境","relation_delta":"关系变化或无","evidence":"正文原句"}],
  "timeline":[{"event":"按发生顺序写关键事件","evidence":"正文原句"}],
  "foreshadow_actions":[{"id":"已有id可空","desc":"稳定伏笔描述","action":"plant|advance|payoff|abandon","note":"本章变化","evidence":"正文原句"}],
  "memory_entries":[{"category":"voice|promise|detail|scene|relation","name":"关联名可空","content":"值得长期保留的具体细节","evidence":"正文原句"}],
  "new_entities":[{"type":"character|location|item|faction","name":"实体名","context":"正文可证的简述","evidence":"正文原句"}]
}

summary、rolling_update、facts 和 memory_entries 只写正向可证事实，严禁写编辑指令、自检话语、旧版已删内容或“没有发生什么”。memory_entries 最多 6 条；没有就空数组。
角色死亡只有在当前正文明确确认死亡时才写“状态=死亡”，并附死亡原句 evidence；重伤、失踪、昏迷或他人猜测均不得推断为死亡。

【当前版本正文｜第${chapterIdx}章《${chapterTitle}》】
${chapterText}`;
}

/** 写前五问自检指令（AI 本位：细纲生成后强制套路自检，不过则重生成）——V0.49 升级为六问（加 q6 人物情感变化） */

/** 过渡衔接检查：上一章结尾 vs 本章开头 */
export function smoothTransitionInstruction({ bookTitle, chapterIdx, prevTail, nextHead }) {
  return `请检查《${bookTitle}》第${chapterIdx}章开头与上一章结尾的衔接是否生硬。

【上一章结尾】${prevTail}

【本章开头】${nextHead}

请输出 JSON（不要输出 JSON 以外的任何内容）：
{"smooth": true, "reason": "原因", "rewrite_head": "若衔接生硬，给出重写后的本章开头（200字内，承接上一章情绪/悬念）；若流畅则留空"}
请输出 JSON。`;
}

// ========== V0.16：上下文归档 + 漂移检测 ==========

/**
 * 归档摘要融合指令（防降智核心：结构化字段枚举+引用，而非自由散文概述）
 * 输入：旧滚动摘要 + 本批精炼卡 + 必保清单（未回收伏笔/active事实/契约承诺）
 * 输出：新的滚动摘要（JSON，字段式），同时输出遗漏检查
 */

/**
 * 归档摘要融合指令（防降智核心：结构化字段枚举+引用，而非自由散文概述）
 * 输入：旧滚动摘要 + 本批精炼卡 + 必保清单（未回收伏笔/active事实/契约承诺）
 * 输出：新的滚动摘要（JSON，字段式），同时输出遗漏检查
 */
export function archiveMergeInstruction({ bookTitle, oldRolling, cardsText, mustKeep }) {
  return `你是本书的记忆管理员。请将《${bookTitle}》的滚动摘要与新增归档批次的精炼卡融合为新的滚动摘要。

【旧滚动摘要】
${oldRolling || '（无）'}

【本批精炼卡（结构化，来自已定稿章节）】
${cardsText}

【必保清单】（融合后这些信息必须仍然可追溯，否则视为丢失）
${mustKeep || '（无）'}

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "new_rolling": {
    "story_state": "当前主线进展（250字内，按时间顺序）",
    "characters": [{"name": "角色名", "state": "当前状态/关键变化"}],
    "unresolved_hooks": ["未回收伏笔/悬念（逐条，必须覆盖必保清单中的未回收伏笔）"],
    "key_facts": [{"fact": "关键事实", "ref": "来源章节号"}],
    "upcoming": "当前剧情走向/待办（100字内）"
  },
  "missing": ["必保清单中未能覆盖的条目（空数组=全部保留）"]
}
规则：必须保细节——unresolved_hooks 逐条枚举，key_facts 逐条带章节号；禁止用"等等""以及其他"概括。请输出 JSON。`;
}

/** 全局漂移诊断指令（根因分类 + 证据链；借鉴 show-me-the-story WritingConflictAnalysis） */

/** 全局漂移诊断指令（根因分类 + 证据链；借鉴 show-me-the-story WritingConflictAnalysis） */
export function driftDiagnoseInstruction({ bookTitle, contract, bookOutline, rollingSummary, recentHealth, recentSummaries, activeFacts, characterStates, unresolvedHooks, constraints, volumeGoal = '' }) {
  return `你是长篇连载的全局总编辑。检测到《${bookTitle}》近期连续出现写作质量/一致性问题，请诊断是否存在系统性跑偏，并给出修复方案。

【书契约】（本书承诺，不可违背）
${contract || '（无）'}

【书级大纲】${bookOutline || '（无）'}

${volumeGoal ? `【当前卷目标】（诊断最近章节是否偏离本卷目标的重要基准）\n${volumeGoal}\n` : ''}
【当前主线状态（滚动摘要）】
${rollingSummary || '（无）'}

【近期章节健康记录】
${recentHealth || '（无）'}

【近期章节摘要】
${recentSummaries || '（无）'}

【已定事实（active）】${activeFacts || '（无）'}

【角色状态】${characterStates || '（无）'}

【未回收伏笔】${unresolvedHooks || '（无）'}

【已有约束】${constraints || '（无）'}

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "drifted": true,
  "causes": [
    {
      "type": "contract|outline|fact|foreshadow|style",
      "severity": "high|medium|low",
      "evidence": "证据（引用具体事实/摘要/章节内容，写明来源）",
      "description": "问题描述"
    }
  ],
  "actions": [
    {
      "type": "supersede_facts|adjust_foreshadow|replan_next|constraints",
      "detail": "具体操作：要作废哪个事实/调整哪条伏笔/从哪里开始重规划/注入什么约束"
    }
  ],
  "recovery_note": "给后续写作的一句话总纲（如何回到正轨）"
}
判定标准：
- contract：近期剧情违背书契约的承诺或硬约束
- outline：近期剧情偏离书级大纲/卷大纲主线
- fact：正文与已登记 active 事实矛盾（列出具体事实）
- foreshadow：未回收伏笔长期无推进或被错误回收
- style：文风/节奏严重偏离（如连续多章无爽点）
证据必须具体（引用事实原文或章节号）；拿不准的不要列。请输出 JSON。`;
}

// ========== V0.17 快感引擎 ==========

/**
 * 书级快感计划指令（每卷奖励节奏/情绪轮换/压抑释放/情感线节奏/弧线规划）
 */

/** 快感审计指令（每章结算后：情绪标签/钩子强度/期待兑现/代入感/节奏问题） */
export function pleasureAuditInstruction({ bookTitle, chapterTitle, chapterIdx, chapterText, activeHooks, openArcs, recentEmotions, protagonist, isHistory = false, plannedRewardMode = '' }) {
  const payoffSchema = isHistory
    ? '  "payoffs": [{"desc": "本章给读者的具体获得", "kind": "依恋|生存|能力|关系|信息|尊严|战术|战略|余韵|其他", "was_surprising": true, "note": "是否兑现计划回报、胜利代价或失败增量"}],'
    : '  "payoffs": [{"desc": "本章兑现的期待/爽点", "kind": "打脸|升级|收集|探索|情感|其他", "was_surprising": true, "note": "是否超额兑现"}],';
  const issueTypes = isHistory
    ? '无阅读回报|节奏疲劳|代入感弱|主角被动|钩子缺失|同类型重复|情感缺席|胜利无代价'
    : '无爽点|节奏疲劳|代入感弱|主角被动|钩子缺失|同类型重复|情感缺席|金手指失衡';
  return `你是网文读者心理学审计员。请对《${bookTitle}》第${chapterIdx}章《${chapterTitle}》做"${isHistory ? '阅读回报审计' : '快感审计'}"，找出让读者流失或失去兴趣的问题。
${isHistory ? `【计划回报类型】${plannedRewardMode || '依恋/生存/能力/关系/信息/尊严/战术/战略/余韵之一'}\n历史铺垫章可以没有打斗和胜利；只要依恋建立、关系变化、信息增量、尊严守住或情绪余韵具体成立，就不是“无阅读回报”。胜利须有代价，失败须有增量。\n` : ''}

【本章正文】
${chapterText}

【当前未兑现期待（钩子）】${activeHooks || '（无）'}

【当前并行弧线】${openArcs || '（无）'}

【近期情绪标签（最近5章）】${recentEmotions || '（无）'}

【主角设定】${protagonist || '（无）'}

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "emotion": {"type": "紧张|放松|甜蜜|虐|燃|余韵|新奇|幽默|惊悚|平淡", "intensity": 1-10},
  "hook": {"present": true, "type": "危机钩|悬念钩|反转钩|挑衅钩|倒计时钩|无", "intensity": 1-5, "desc": "本章结尾钩子描述"},
${payoffSchema}
  "issues": [
    {"type": "${issueTypes}", "severity": "high|medium|low", "detail": "具体问题", "fix": "建议"}
  ],
  "agency_ratio": "主角主动决策场景占比（高|中|低）"
}
规则：情绪强度 1-10；钩子强度 1-5（<3 视为无钩——与细纲/正文写作指令的"章末钩 ≥3 级"同一把尺）；issues 只报真实问题，宁缺毋滥。请输出 JSON。`;
}

// ========== V0.41 卷级整体审阅（主动卷体检） ==========
/**
 * 卷级审阅指令：一卷写完后，对照卷大纲体检——承诺兑现/节奏/衔接/整体读感。
 * 输入全部来自摘要与结构化数据（不用全文），控制上下文成本。
 */
