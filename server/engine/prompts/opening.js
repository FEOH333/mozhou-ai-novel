// 由 prompts.js 拆分而来（V0.109.5）。只搬不改：声明体与拆分前逐字节一致。
'use strict';

import { structureInjection, CONTRAST_BUILDUP_TEXT, COLD_OPEN_CRAFT_TEXT, TITLE_CRAFT_TEXT, VOLUME_TITLE_CRAFT_TEXT } from '../../data/literary_techniques.js'; // V0.83 叙事结构纪律 // V0.85 对比铺垫·先立后破 // V0.98.3 远期楔子·神开局工艺 // V0.107 章卷命名工艺单一真源（书纲/卷纲/细纲/改名四处共用，禁止内嵌第二份）

/**
 * V0.80 前20章开篇蓝图指令（番茄签约导向：钩子阶梯/爽点节奏/金手指上线/目标阶梯/承诺期限）
 * 治本：平凡少年修仙第1章写平凡少年日常无事件、前10章无战斗爽点、金手指迟迟不明确——
 * 顶层必须有"前20章环环相扣"的结构化蓝图，逐章注入细纲与正文。
 */
export function openingBlueprintInstruction({ bookTitle, genre, platform, contract, bookOutline, pleasurePlan, genreText, chapterCount = 20, isHistory = false, historicalPhaseText = '', platformGuidance = '', genreProfile = '', storyPromise = '' }) {
  // V0.82：历史题材（史实流·无金手指）——"金手指"语义改为"立身之本/核心资本"；
  // 历史文的爽是"压抑后的释放、有代价的胜利"，不是打脸碾压式玄幻爽
  const coreAssetTitle = isHistory ? '立身之本' : '金手指';
  // V0.85：明确"事件≠暴力冲突"——事件可以是温情日常中的异响、悬念、选择、暗示（先立后破的"立"本身就是事件）
  const coreAssetLine = isHistory
    ? '- 事件≠暴力冲突：第一场景尽早让主角的处境、可感知变化或选择成立，并通过行动露出其立身资本边界；不要求暴力开场，也不把孩子写成成年统帅'
    : '- 事件≠暴力冲突：第一场景尽早让核心吸引点、眼前困局或人物选择成立；若本书确有金手指，应按创作宪章自然露出，不得为平台标签凭空添加';
  const pacingLine = isHistory
    ? '- 阅读回报可来自依恋、生存、能力、关系、信息、尊严、战术、战略或余韵；按阶段轮换，胜利配代价，失败换来增量'
    : '- 回报节奏服从本书创作宪章与题材；冲突、关系、信息、能力、利益和情绪可轮换，禁止把固定打脸表当万能结构';
  const firstPayoffLine = isHistory
    ? '- 开篇早段提供与核心吸引轴一致的明确回报，例如依恋建立、关键信息、有效选择或有代价的微小进展'
    : '- 开篇早段提供与本书核心吸引轴一致的明确回报，不默认等同于当众打脸、碾压或翻身';
  const payoffLabel = isHistory ? '本章兑现的阅读价值/期待推进' : '本章兑现的爽点/期待';
  const beatLabel = isHistory ? '关键事件（含选择/关系/信息/代价与回报设计）' : '关键事件（含战斗/冲突/爽点设计）';
  // V0.86：开篇"先立后破"指引——悲剧开篇铺垫尺度=千家灯火市井风情 + 重要羁绊人物（玩伴/大叔），
  // 人物越丰满、城越鲜活，破碎时读者越刀；历史/非历史悲剧开篇都适用
  const contrastBuildupLine = (isHistory || /悲剧|灭门|城破|家破|战争|乱世|复仇/.test(`${genre || ''}${bookOutline || ''}`))
    ? '\n【开篇先立后破】（V0.86 硬要求，悲剧/战争类开篇尤其关键）\n- 若开篇涉及家破/城破/死亡等悲剧，**前 1-3 章先用足篇幅铺垫"当下有多好"——注意是一座城、千家灯火、市井风情，不是一家人**：街巷炊烟、集市叫卖、茶楼人声、邻里寒暄、更夫巡夜，让读者先爱上这座城、这个世界\n- **必须铺垫 1-2 个重要羁绊人物**：儿时玩伴（有约定/有笑声）、照拂主角的大叔/婶婶（有叮嘱/有细节）、巷口卖炊饼的老伯（多塞一块饼）等——写清他们的日常、性格与笑脸，让读者记住他们的脸\n- 铺垫要丰满连续：晨起→市集→黄昏→灯起的生活流，让这些人物反复出场；悲剧降临时**兑现他们的命运**（离散/惨死/为救主角而死）——人物越丰满读者越心疼\n- 变故要有"日常被打破"的过程感（先一声异响/炊烟断了/更夫停了梆子→再恶化→后粉碎），不要第一句话就是屠杀\n- 禁：开局即灾难、从头惨到尾无铺垫（读者会麻木而非心疼）\n- 铺垫要**成章/成场景**（不是闪回镜头）：前 1-3 章按"晨起→市集→黄昏→灯起"的生活流整章铺垫，悲剧章排在铺垫章之后；"回忆闪回补足"仅在铺垫章无法安排时作为例外，且须在蓝图里写明"第 X 章为铺垫章、第 Y 章为悲剧章"\n'
    : '';
  return `你是${isHistory ? '历史题材' : '网络小说'}开篇总编辑。为《${bookTitle}》设计前 ${chapterCount} 章"开篇蓝图"，让作品独有承诺尽早可感并能长期供给。
【任务标识】开篇蓝图生成

【题材】${genre || '玄幻'}【平台】${platform || '通用'}
【书契约（前N章承诺必须写进 promise_deadlines）】${contract || '（无）'}
【书级大纲】${bookOutline || '（无）'}
【快感计划】${pleasurePlan || '（无）'}
${storyPromise ? `【本书创作宪章】\n${storyPromise}\n` : ''}
${platformGuidance || '【官方创作指导】无特定平台事实，仅按通用叙事目标设计。'}
${genreProfile || '【题材样本观察】无特定样本；不得自行补造平台偏好。'}
${genreText ? '【题材包开篇模式/奖励节奏】' + genreText + '\n' : ''}
${historicalPhaseText ? historicalPhaseText + '\n【开篇年代锁】前20章只在上述第1阶段内推进；不得提前写1259年围攻钓鱼城或让成年主角登场。\n' : ''}
${isHistory ? '\n【历史文核心纪律】（史实流·V0.82 硬要求）\n- 无金手指、无穿越系统、无超常能力；主角靠时势、才学、军功与人心博弈\n- 大事件按真实史实时间线，主角改"后果"不改"前因"；历史遗憾的弥补是最高级爽点\n- 真实历史人物智商在线、不工具化、信任靠事件挣得；开篇以小人物视角切入大时代\n- 历史文的爽=绝境中的抉择与尊严/大势压迫下的微小真实胜利/制度困境的破解，每次胜利配代价\n- 禁：前3章见皇帝获重用、发明神器、系统面板刷屏\n' : ''}
${contrastBuildupLine}
【开篇创作目标（官方指导、题材样本与编辑启发不是统一阈值）】
${coreAssetLine}
- 第1章让主角出现符合年龄、处境与能力的反应或选择；弱小不等于没有行动方式
${firstPayoffLine}
- 尽早让读者明白接下来最值得追问什么；具体速度服从题材和本书气质
${pacingLine}
- 禁大段世界观说明/背景交代——设定随事件带出（正例：主角第一次进宗门，用门房递来的一盏茶带出灵米/灵石的物价与身份差异，而非一段宗门史）；主角被羞辱后必须近期反击，不连续10章铺垫悲惨身世

请输出 JSON（不要输出 JSON 以外的任何内容）：
{
  "hook_ladder": [
    {"chapter": 1, "title": "章名", "hook": "本章结尾钩子（危机/悬念/反转/关系/抉择/信息差/余韵）", "payoff": "${payoffLabel}", "beat": "${beatLabel}", "reward_mode": "${isHistory ? '依恋|生存|能力|关系|信息|尊严|战术|战略|余韵' : '爽点类型'}", "emotion": "主情绪及强度"}
  ],
  "pleasure_pacing": [
    {"chapter": 3, "type": "small", "beat": "${isHistory ? '早期回报：依恋建立/信息揭示/有代价的微胜' : '小爽点：当众打脸/碾压'}"}
  ],
  "golden_finger": {"power": "${isHistory ? '立身之本/核心资本一句话（史实流：身份/才能/知识差，无超常能力）' : '金手指能力一句话'}", "activate_chapter": 5, "limit": "当前限制与解锁条件（克制，不可开局无敌）", "first_display": "首次显威场景"},
  "protagonist_goal_ladder": [
    {"chapter": 1, "stage": "目标阶段", "goal": "本章主角要达成的小目标"}
  ],
  "promise_deadlines": [
    {"promise": "仅填写书契约已有的一次性期限承诺", "due_chapter": 3}
  ]
}

要求：
- hook_ladder 覆盖前 ${chapterCount} 章，每章必须有一句结尾钩子 + 一句当章${isHistory ? '阅读回报/期待推进' : '爽点/兑现'}；
- pleasure_pacing 标注回报强度、类型与阶段功能；不得把固定章数的打脸或高潮节奏强加给本书；
- ${isHistory ? '立身之本克制：power 写清主角的资本边界（身份起点/知识差范围），不可开局全知全能' : '金手指克制：power 给能力上限与限制，不可开局无敌；'};
- promise_deadlines 只收录书契约里“前N章/第N章前”这类一次性绝对期限；“每N章/每卷末”等周期节奏不得写入此数组。
请输出 JSON。`;
}

/** V0.98 书级创作宪章：提炼作品独有承诺，不把平台样本当模板。 */

/** V0.98 书级创作宪章：提炼作品独有承诺，不把平台样本当模板。 */
export function storyPromiseInstruction({ book, contract = '', outline = '', pleasure = '', world = '', cast = '', eraContext = '', characters = [], platformGuidance = '', genreProfile = '', authorLocks = {} }) {
  return `你是长篇小说总编辑。请从现有材料提炼“这一本书为什么值得追下去”的创作宪章，供后续自动创作使用，不写正文。
【作品】《${book?.title || '未命名'}》｜题材：${book?.genre || '不限'}｜平台：${book?.platform || '通用'}｜视角：${book?.perspective || 'third'}
【简介】${book?.blurb || '（无）'}
【书契约】${contract || '（无）'}
【书级大纲】${outline || '（无）'}
【快感计划】${pleasure || '（无）'}
【可用世界设定】${world || '（无）'}
【角色弧光设计】${cast || '（无）'}
【历史红线】${eraContext || '（无）'}
【当前人物卡摘要】${JSON.stringify(characters || [])}
${platformGuidance}
${genreProfile}
【作者已锁定字段】${JSON.stringify(authorLocks || {})}

原则：
1. 先忠于作品本身，再考虑平台表达；榜单样本只能帮助把承诺说清楚，不能强加系统、穿越、后宫、轻喜剧或打脸。
2. “爽”要翻译成本题材的具体回报。正例：弱小人物通过观察与纪律让同伴少死一人；反例：不问题材统一写“当众打脸”。
3. 近期回报必须是主角当前能力做得到的行动；孩子可以观察、保护、撒谎或求援，不能像成年统帅。
4. anti_promises 写清本书绝不能被优化成什么；protected_elements 只收录现有材料可证的关系、物件或气质。
5. 只输出 JSON，不要解释：
{
  "premise_in_one_breath": "一句可感的故事承诺",
  "primary_attraction_axis": "最重要的单一吸引轴",
  "secondary_axes": ["次级吸引轴"],
  "protagonist_now": {"lack":"当下缺口","immediate_need":"眼前需要","agency_pattern":"典型行动方式"},
  "payoff_ladder": {"near":["前三章可兑现回报"],"middle":["中期回报"],"long":["长期回报"]},
  "texture": {"route":"创作路线","pace":"节奏气质","humor":"low|medium|high","historical_density":"low|medium|high","pov":"叙事距离"},
  "protected_elements": ["必须保护的既有元素"],
  "anti_promises": ["禁止优化方向"],
  "author_locks": [],
  "confidence": {"primary_attraction_axis":"source_text|inferred","payoff_ladder":"source_text|inferred"}
}`;
}

/** V0.98 开篇诊断：先模拟真实冷读，再按原文证据整理问题。 */

/** V0.98 开篇诊断：先模拟真实冷读，再按原文证据整理问题。 */
export function openingDiagnosisInstruction({ book, storyPromise = '', fullChapters = [], laterChapters = [], localSignals = {}, platformGuidance = '', genreProfile = '' }) {
  const fullText = (fullChapters || []).map(chapter =>
    `【第${chapter.idx}章《${chapter.title || ''}》全文】\n${chapter.text || '（空）'}`
  ).join('\n\n');
  const laterText = (laterChapters || []).map(chapter => [
    `【第${chapter.idx}章《${chapter.title || ''}》】`,
    `摘要：${chapter.summary || '（无）'}`,
    `开头300字：${chapter.head300 || ''}`,
    `结尾200字：${chapter.tail200 || ''}`,
  ].join('\n')).join('\n\n');
  return `你是第一次在手机上打开《${book?.title || '未命名'}》的挑剔读者兼小说编辑。先以第一次阅读者的口吻冷读，不预设它一定要快、爽、打斗或加楔子；随后才整理可复核证据。
【简介原文】${book?.blurb || '（无）'}
【本书创作宪章】${storyPromise || '（无）'}
${platformGuidance || '【官方创作指导】无特定平台事实。'}
${genreProfile || '【题材样本观察】无特定样本；不得自行补造偏好。'}
以上平台指导、样本观察和编辑启发不是统一阈值。

【本地客观信号（只能帮助定位，不能直接判平淡或流失）】
${JSON.stringify(localSignals || {})}

${fullText || '【第1—3章全文】（无）'}

${laterText || '【第4—10章实际片段】（无）'}

请严格按两步完成：
第一步——冷读回答（先写具体文字理由，再看量表）：
1. 我以为主角是谁？他眼前究竟想保住、得到或逃开什么？分别引用原文。
2. 哪一个具体问题让我愿意继续读；若没有，缺的是什么？
3. 从哪一章、哪个字符范围开始注意力下降，为什么？写入 attention_drop。
4. 哪段对话分不清说话人，或哪句话更像旁白而不是人在说话？写入 speaker_confusion。
5. 哪处明显像模板、作者操控或 AI拼接？写入 artificial_or_ai_feel；没有证据就留空。
6. 本稿最强的单一吸引轴是什么，它是否与创作宪章一致？写入 strongest_axis。一个轴真正突出即可，不要求七项全优。

第二步——把上述感受整理成0—4分证据：0=直接证据表明严重妨碍阅读，1=明显不足，2=混合或证据不足，3=基本成立，4=直接证据表明突出。证据不足必须给2。量表只整理证据，禁止用平均分自动判定，允许最终推荐 baseline（原稿保留）。没有打斗、系统或打脸本身不是问题。

每条 issue 必须同时包含 chapter、start、end、quote、cause、smallest_fix；start/end 是对应章节原文的字符范围，quote 必须能在原文精确找到。无法从原文逐字复制就宁可不报，严禁把概括、改写或记忆中的近似句冒充 quote。无引文的问题不得触发修改。
smallest_fix 只能删减、压缩、改写、重排或澄清当前引文；不得新增人物、事件、冲突、物件或设定，不得举正文中不存在的名字或剧情作为例子。若只能靠新增剧情解决，它就不是“最小改法”。
如果一段文字正在履行创作宪章保护的功能，代价只是另一类读者的偏好（例如更快、更爽或更早进战斗），不得写入 issues；改写入 tradeoffs，它只记录取舍，不能触发修改。
【输出体量纪律（硬要求——在线端点对长生成不稳定，超量输出会被掐断导致整份作废）】
- 全部 JSON 控制在 1800 字以内：answer/reason/cause/smallest_fix 各 ≤40 字；每处 evidence 只留 1 条最关键引文（≤30 字）。
- attention_drop / speaker_confusion / artificial_or_ai_feel 各至多 2 条，没有证据就空数组；issues 至多 3 条（只报最重要的问题）；tradeoffs 至多 2 条；strategies 至多 2 条；hard_failures 通常为空数组。
- 正例：{"answer":"九岁主角想保住弟弟","evidence":["把弟弟往上颠了颠"]}；反例：quote 抄整段原文、answer 写成三句分析。精简不是含糊，是砍掉复述。
只输出 JSON：
{
  "cold_read": {
    "protagonist": {"answer":"我以为主角是谁","evidence":["原文"]},
    "immediate_want_or_danger": {"answer":"眼前欲望或危险","evidence":["原文"]},
    "continue_question": {"answer":"愿意追问的具体问题","evidence":["原文"]},
    "attention_drop": [{"chapter":1,"start":0,"end":20,"quote":"原文","reason":"走神原因"}],
    "speaker_confusion": [{"chapter":1,"start":0,"end":20,"quote":"原文","reason":"说话人不清"}],
    "artificial_or_ai_feel": [{"chapter":1,"start":0,"end":20,"quote":"原文","reason":"模板或拼接感"}],
    "strongest_axis": {"kind":"bond|choice|dilemma|mystery|novelty|voice|none","reason":"文字理由"}
  },
  "rubric": {
    "first_screen_clarity":{"score":2,"evidence":[],"cost":"读者成本"},
    "protagonist_bond":{"score":2,"evidence":[],"cost":""},
    "causal_motion":{"score":2,"evidence":[],"cost":""},
    "promise_alignment":{"score":2,"evidence":[],"cost":""},
    "chapter_one_independence":{"score":2,"evidence":[],"cost":""},
    "emotional_variety":{"score":2,"evidence":[],"cost":""},
    "structural_naturalness":{"score":2,"evidence":[],"cost":""}
  },
  "hard_failures":[{"code":"事实/时间/转场等硬伤代码","quote":"原文","reason":"原因"}],
  "issues":[{"severity":"high|medium|low","chapter":1,"start":0,"end":20,"quote":"原文","cause":"根因","smallest_fix":"最小改法"}],
  "tradeoffs":[{"chapter":1,"start":0,"end":20,"quote":"原文","reason":"这是哪类读者偏好与本书保护功能的取舍"}],
  "strategies":[{"kind":"baseline|head_rewrite|chapter1_cold_open|standalone_prologue","creative_hypothesis":"创作假设","expected_gain":"相对原稿新增价值","risks":[]}],
  "recommendation":{"kind":"baseline|head_rewrite|chapter1_cold_open|standalone_prologue","reason":"不能只引用平均分"}
}`;
}

/** V0.98 开篇候选第一阶段：只设计进入逻辑，不先写五份同义正文。 */

/** V0.98 开篇候选第一阶段：只设计进入逻辑，不先写五份同义正文。 */
export function openingStrategyInstruction({ book, mode = 'repair', storyPromise = '', diagnosis = null, currentOpening = '', platformGuidance = '', genreProfile = '', contractEvent = null }) {
  return `你是长篇小说开篇结构设计师。先为《${book?.title || ''}》设计真正不同的进入逻辑，本阶段禁止写正文。
${mode === 'repair'
    ? `这是存量正文修复。系统的既定策略：${contractEvent
      ? `远期高能楔子（chapter1_cold_open）是核心——必须锚定下述真实远期事件，把目标年份的高能一瞬放到第一章之前。`
      : '未解析到可达的远期契约目标，不得建议 chapter1_cold_open。'}顺叙强化（head_rewrite）只在诊断证明开篇承诺不清（promise_alignment≤2）时作为救济设计，健康开篇不需要章内重写。`
    : '这是新书创作：至少设计三种不同结构，并都作为正常第一章候选。'}

硬边界：
- 每个方案必须改变 entry_time、first_actor、immediate_problem、first_choice 或 first_state_change 中至少一项，不能用“更文学/更紧凑/更有电影感”冒充新结构。
- 只突出一个最强吸引轴也可以；不要按平均分设计八面俱到的模板。
- 服从作者锁、anti_promises 与题材气质，不强加系统、穿越、打脸、轻喜剧或现代嘴替。
- 独立楔子不是默认策略；只有输入明确证明平台前置章节兼容且第一章无法承担特殊功能时才可建议。
- 不照抄简介金句，不用“命运的齿轮、他不知道的是、多年以后”转场。
- 诊断里的 smallest_fix 只是编辑方向；其中任何未在输入证据出现的人名、事件、物件或设定都必须丢弃，不得进入结构蓝图。
${contractEvent ? `- 远期楔子的 entry_time 必须是 ${contractEvent.target_year} 年目标事件现场；把第一章既有内容搬到开头不算新结构。` : ''}

输出 JSON：
{“strategies”:[{“kind”:”${mode === 'repair' ? 'head_rewrite|chapter1_cold_open|standalone_prologue' : 'chapter1_draft'}”,”strategy_family”:”结构族”,”entry_signature”:”进入时间|首个行动者|眼前问题|首次状态变化”,”creative_hypothesis”:”这一结构为何可能增强本书自己的吸引轴”,”entry_time”:””,”first_actor”:””,”immediate_problem”:””,”first_choice”:””,”first_state_change”:””,”strongest_axis”:””,”transition_plan”:”如何让第一章仍独立成立”}]}

【作品与证据；以下是动态输入】
作品：${JSON.stringify({ title: book?.title || '', genre: book?.genre || '', platform: book?.platform || '', blurb: book?.blurb || '' })}
【本书创作宪章】
${storyPromise}
【当前有效开篇诊断】
${diagnosis ? JSON.stringify(diagnosis) : '（无；不得猜问题）'}
${platformGuidance}
${genreProfile}
${contractEvent ? `【远期事件契约（楔子必须锚定的真实未来）】\n${JSON.stringify(contractEvent)}` : ''}
【当前第一章，仅用于识别原稿进入逻辑】
${String(currentOpening || '').slice(0, 2500)}

只输出 JSON。`;
}

/** 前置层（chapter1_cold_open / standalone_prologue）的远期事件契约注入块。 */

/** 前置层（chapter1_cold_open / standalone_prologue）的远期事件契约注入块。 */
function openingContractEventBlock(contractEvent) {
  if (!contractEvent) return '';
  const signals = [...(contractEvent.event_signals || []), String(contractEvent.target_year)].filter(Boolean);
  const delta = Number.isInteger(contractEvent.year_delta) && contractEvent.year_delta > 0 ? contractEvent.year_delta : null;
  const years = (contractEvent.volume_years || []).length ? `（${contractEvent.volume_years.join('—')}）` : '';
  const protagonist = (contractEvent.protagonist_names || []).join('、');
  return `${COLD_OPEN_CRAFT_TEXT}
【远期事件契约——前置层必须锚定的真实未来（不是第一章章内优化）】
目标事件键：${contractEvent.target_event_key}；目标年份：${contractEvent.target_year}
兑现卷：《${contractEvent.volume_title}》${years}${contractEvent.historical_anchor ? `；史实锚点：${contractEvent.historical_anchor}` : ''}
${contractEvent.volume_summary ? `卷纲摘要：${contractEvent.volume_summary}` : ''}
${protagonist ? `主角：${protagonist}（必须第一屏 120 字内点名出场并立即行动，缺席本地判废）` : ''}
事件信号词（正文须自然出现至少其一，且必须出现在第一屏 120 字内，否则本地判废）：${signals.join('、')}

落地要求：
1. 场面必须发生在目标年份的目标事件现场，用事件真实的地名/人名/年号定位，主角以事件时刻的身份在场。
2. 写高能一瞬：危险正在逼近、代价已经可见、结果只露一角——读者要立刻产生“他是怎么走到这里的”之问，而不是得到完整解释。
3. 结尾必须在收束处用真实年差回切${delta ? `（第一章为${contractEvent.opening_year}年，距目标事件${delta}年，如“${delta}年前”）` : '（用第一章真实年份或年号）'}，回切后由系统接回原第一章正文，不要自己续写第一章。
4. 禁止复用第一章既有场景的情节、意象与句子——把第一章末尾的暗火、磨刀等内容搬到前面不算楔子，是章内优化，本地重合率≥30%直接判废。
5. 不得发明契约与卷纲之外的史实（人物死因、军职、神器以卷纲与史实锚点为准）；结果只到 known_outcome 的边界，不提前解释未解因果。
6. 每个节拍都由主角触发或承受：先写主角的动作、决定或代价，再带出局势；禁止纪录片式全景陈述（连续讲述事件本身而无人物的俯瞰笔法）。
7. 楔子内至少一个具体的人在开口争取、下令或求救，对话带眼下目的，不许以一个旁白句替人物总结。
`;
}

/** V0.98 开篇候选第二阶段：按已批准的结构蓝图写可直接阅读的候选。 */

/** V0.98 开篇候选第二阶段：按已批准的结构蓝图写可直接阅读的候选。 */
export function openingCandidateInstruction({ book, storyPromise = '', diagnosis = null, currentOpening = '', firstScene = null, strategy = {}, budget = {}, platformGuidance = '', genreProfile = '', contractEvent = null }) {
  const isFrontLayer = strategy?.kind === 'chapter1_cold_open' || strategy?.kind === 'standalone_prologue';
  return `你是小说正文作者。严格按给定结构蓝图写一个开篇候选，不得把它改回熟悉的万能模板。

共同规则：
- 只使用简介、创作宪章、现有正文和已给事实；不得发明成年军职、伤疤、神器、历史人物死因或人物不可能知道的信息。
- 输出 JSON 时，content 正文里的对白一律用全角引号（“”）；JSON 字符串内不得出现未转义的半角引号——裸换行本地解析器已容错，未转义半角引号无法修复，会导致整份候选解析失败。
- 每段描写必须承担处境、人物、关系、行动准备或情绪反差之一；只换形容词不算推进。
- 对话必须是人物当下在争取、躲避、试探或决定，不能把背景资料加引号。
- 不照抄简介金句；禁用“命运的齿轮、他不知道的是、多年以后”作转场。
- 诊断中的改法若提到输入证据不存在的人名、事件、物件或设定，一律忽略；不得把评论幻觉写成正文。
- 若为 chapter1_cold_open，正文须自带自然回到第一章的转接，回去后第一章仍有自己的事件和问题。
- 建议区间 ${budget?.preferred?.[0] ?? 0}—${budget?.preferred?.[1] ?? 0} 字是软预算；硬上限 ${budget?.hardMax ?? 8000} 字不是软预算，任何理由都不得超过。需要腾出篇幅时，保留“动作→反应→状态变化”，把三轮同义气氛收成一个可见动作，例如把“风更冷、夜更沉、心更紧”收成“风灌进领口，他扣住身边人的肩”。

输出 JSON，完整保留蓝图字段并增加 content；head_rewrite 的 content 只写替换片段，其他类型写完整前置候选：
{“kind”:””,”strategy_family”:””,”entry_signature”:””,”creative_hypothesis”:””,”entry_time”:””,”first_actor”:””,”immediate_problem”:””,”first_choice”:””,”first_state_change”:””,”strongest_axis”:””,”transition_plan”:””,”content”:”候选正文”,”contract”:{“version”:1,”promise_key”:””,”public_question”:””,”known_outcome”:””,”forbidden_early_explanation”:[],”target_event_key”:””,”target_year”:null,”target_volume_id”:””,”status”:”open”,”fulfilled_chapter”:null}}

【动态证据】
作品：${JSON.stringify({ title: book?.title || '', genre: book?.genre || '', blurb: book?.blurb || '' })}
【结构蓝图】${JSON.stringify(strategy)}
【创作宪章】${storyPromise}
【当前有效诊断】${diagnosis ? JSON.stringify(diagnosis) : '（无）'}
${platformGuidance}
${genreProfile}
${isFrontLayer && contractEvent ? openingContractEventBlock(contractEvent) : ''}
【第一场景元数据】${JSON.stringify(firstScene ? { id: firstScene.id, beat: firstScene.beat } : null)}
${strategy?.kind === 'head_rewrite' && firstScene ? `【head_rewrite 唯一替换范围（${String(firstScene.content || '').replace(/\s+/g, '').length}字）】
${String(firstScene.content || '')}
只重写以上范围，不得把第二场景或整章一起重写；新片段须能直接接回原第二场景。` : ''}
【当前第一章${isFrontLayer ? '（仅供回切定位与禁止复用对照，不得抄写其情节句子）' : ''}】
${String(currentOpening || '').slice(0, 8000)}

只输出 JSON。`;
}

/** 候选越过硬上限后的定向收敛：只改正文，不允许模型借压缩改掉结构蓝图。 */

/** 候选越过硬上限后的定向收敛：只改正文，不允许模型借压缩改掉结构蓝图。 */
export function openingCandidateLengthRepairInstruction({ strategy = {}, content = '', sourceExcerpt = '', budget = {}, currentChars = 0, attempt = 1, contractEvent = null }) {
  const preferredMin = Number(budget?.preferred?.[0]) || 0;
  const preferredMax = Number(budget?.preferred?.[1]) || Number(budget?.hardMax) || 8000;
  const hardMax = Number(budget?.hardMax) || 8000;
  const targetMax = Math.max(preferredMin, Math.min(hardMax, Math.round(preferredMax * (attempt > 1 ? 0.9 : 1))));
  return `你是小说正文压缩编辑。当前开篇候选有 ${currentChars} 字，超过 ${hardMax} 字硬上限。只压缩 content，不得改结构蓝图、人物事实、时间、视角或事件顺序。

压缩纪律：
1. 成稿目标 ${preferredMin}—${targetMax} 字，绝对不得超过 ${hardMax} 字；输出前自行按去除空白后的中文字符数复核。
2. 保留“眼前问题→人物选择→结果或转接”的完整因果链和原结尾功能；删同义复述、重复气氛、解释性总结。正例：把“风更冷、夜更沉、他心里越发不安”收成“风灌进领口，他按住门闩”。
3. head_rewrite 只承担原锚点范围，写完必须能接回下一场景；chapter1_cold_open 必须保留目标事件的信号词（年份/地名/人名）与回切第一章的时间定位，二者删任一处即判废。
4. 不截断句子，不写摘要或提纲，不新增原稿没有的人名、物件、军职、史实或结果。

输出严格 JSON：{"content":"压缩后的完整候选正文"}

【结构蓝图】${JSON.stringify(strategy)}
${contractEvent ? openingContractEventBlock(contractEvent) : ''}
${sourceExcerpt ? `【原锚点正文；用于核对事实与接续】\n${sourceExcerpt}` : ''}
【当前超限候选】
${String(content || '')}

只输出 JSON。`;
}

/** V0.98 候选硬伤审校：文本证据优先于数值。 */

/** V0.98 候选硬伤审校：文本证据优先于数值。 */
export function openingCandidateAuditInstruction({ book, storyPromise = '', candidate = {}, currentOpening = '', platformGuidance = '', genreProfile = '', contractEvent = null }) {
  const isFrontLayer = candidate?.kind === 'chapter1_cold_open' || candidate?.kind === 'standalone_prologue';
  return `你是开篇候选硬伤审校员。先找事实、人物、时间、视角、转场、重复、剧透、AI章法和第一章独立性硬伤，再描述最强吸引轴；不预测留存、签约或推流。
${isFrontLayer && contractEvent ? `前置层专项核查（与写作纪律同源）：\n${COLD_OPEN_CRAFT_TEXT}\n- 第一屏 120 字内是否出现目标事件真实信号（${[...(contractEvent.event_signals || []), String(contractEvent.target_year)].join('、')}至少其一）；\n- 是否锚定 ${contractEvent.target_year} 年目标事件，而不是把第一章既有场景搬到开头冒充未来场面（复用即硬伤）；\n- 主角是否在第一屏 120 字内点名出场并参与动作（缺席即念稿式开场，与本地判废同源）；\n- 结尾是否在正文中定位回第一章年份。` : ''}

输出 JSON：
{"hard_failures":[{"code":"","quote":"候选原文短引","reason":""}],"issues":[{"severity":"high|medium|low","quote":"候选原文短引","cause":"","smallest_fix":""}],"strongest_axis":{"kind":"bond|question|character|situation|voice|other","strength":0,"reason":""},"continue_question":"具体想追什么","attention_drop":[],"speaker_confusion":[],"artificial_or_ai_feel":[],"chapter_one_independence":{"ok":true,"reason":""}}
- strength 0—4；证据不足给2。一个轴明显突出即可，不按平均分裁决。
- high/medium 必须有候选原文引文；没有引文只能作为 note，不能触发修改。

【动态证据】
作品：${JSON.stringify({ title: book?.title || '', genre: book?.genre || '', blurb: book?.blurb || '' })}
【创作宪章】${storyPromise}
${platformGuidance}
${genreProfile}
${isFrontLayer && contractEvent ? openingContractEventBlock(contractEvent) : ''}
【原稿第一章】${String(currentOpening || '').slice(0, 5000)}
【待审候选】${JSON.stringify(candidate)}

只输出 JSON。`;
}

/** V0.98 匿名两轮比较；三个镜头是模型模拟，不伪装真实读者。 */

/** V0.98 匿名两轮比较；三个镜头是模型模拟，不伪装真实读者。 */
export function openingCandidateCompareInstruction({ book, storyPromise = '', diagnosis = null, candidates = [], round = 1, platformGuidance = '', genreProfile = '' }) {
  return `你在做第 ${round} 轮匿名开篇比较。候选标签已随机化；你不知道哪个是原稿。以下三种镜头都只是模型模拟，不是真实读者或平台结论：
1. 题材读者镜头：现在具体在追什么问题，长期承诺是否清楚；
2. 普通移动端冷读镜头：哪里走神、需要回读、分不清说话人，继续读的具体理由；
3. 严肃编辑镜头：人物是否被套路改坏，题材质感、视角、情感债与长期潜力是否仍在。

先列 hard_failures，再回答每版最强吸引轴和相对其他版本真正新增了什么。不得求平均分后机械选最高；无硬伤且至少一个强轴明确即可胜出。没有稳定优势可选原稿样貌的版本，但不能因“改过”而偏爱新稿。

输出 JSON：
{"winner_label":"版本A","reason":"具体且可复核的胜出理由","judgments":{"版本A":{"strongest_axis":{"kind":"","strength":0,"reason":""},"hard_failures":[],"issues":[],"continue_question":"","attention_drop":[],"speaker_confusion":[],"artificial_or_ai_feel":[],"relative_gain":""}}}

【动态证据】
作品：${JSON.stringify({ title: book?.title || '', genre: book?.genre || '', blurb: book?.blurb || '' })}
【创作宪章】${storyPromise}
【当前诊断】${diagnosis ? JSON.stringify(diagnosis) : '（无）'}
${platformGuidance}
${genreProfile}
【匿名候选】
${candidates.map(item => `\n### ${item.label}\n${item.text}`).join('\n')}

只输出 JSON。`;
}

/** 卷大纲生成指令（V0.74 成长题材感知 + V0.76 世界观阶梯展开题材感知） */

/** V0.80 签约文本预审指令（文本证据 + AI味检查；不预测平台结果）
 *  V0.82：历史题材（史实流）——金手指要求豁免，改评审史实严谨/时代质感/历史人物尊重/胜利有代价 */
export function signingReviewInstruction({ bookTitle, genre, description = '', contract, blueprint, opening, openingDiagnosis = '', platformGuidance = '', genreProfile = '', storyPromise = '' }) {
  const isHistory = genre === '历史';
  const goldFingerLine = isHistory
    ? '4. 立身之本：主角当前的身份、观察或行动资本是否通过情节可辨？是否符合年龄与历史边界？'
    : '4. 核心玩法：简介承诺的能力、关系或困局是否在开篇自然可辨？若原设定没有金手指，不得因此判低。';
  const historyCheck = isHistory ? `
9. 史实严谨（历史文必审项）：是否有时代硬伤（时间线提前/人物写错生死/异代制度/现代词汇）？大事件是否符合史实骨架、架空改写是否有代价？
10. 历史质感：称谓/礼制/器物/食俗是否有时代感（如宋人称"官家/相公"、点茶、羊肉贵）？
11. 历史人物尊重：真实历史人物是否智商在线、不工具化、不被嘲讽物化？
12. 胜利有代价：主角的每次成功是否有代价（伤亡/粮草/政治妥协），拒绝无成本碾压？` : '';
  const openingCheck = isHistory
    ? `1. 开篇供给：人物、可珍惜的人或地方、眼前变化和可追问问题是否逐步成立？是否有依恋建立、信息、选择或有代价微胜等阅读回报？
2. 继续阅读理由：章节是否留下危机、疑问、关系、抉择、信息差、局势转折或余韵？并非每章都必须用悬念句收尾。
3. 先立后破：重要失去前是否让家庭、街巷和羁绊人物活成完整场景，而非开局就堆惨？`
    : `1. 开篇供给：本书真正依靠的人物、困局、关系、玩法或反差是否可辨？
2. 继续阅读理由：场景变化与章末余力是否自然指向下一步，而非机械套危机句？
3. 冲突前置：是否禁大段世界观/背景说明？`;
  const rhythmCheck = isHistory
    ? '5. 阅读回报节奏：每章是否有一种具体回报（依恋/生存/能力/关系/信息/尊严/战术/战略/余韵），类型是否轮换？每3—5章是否有可感知兑现？胜利是否有代价、失败是否有增量？'
    : '5. 回报节奏：冲突、关系、信息、能力、利益与情绪是否有变化，且没有长期空转或机械重复？';
  return `你是网络小说开篇文本预审编辑。审阅《${bookTitle}》（${genre}）的开篇，只判断文本风险与修改必要性，不预测平台流量、推荐或签约结果。

【书契约】${contract || '（无）'}
【作品简介】${description || '（无）'}
【前20章开篇蓝图】${blueprint || '（无）'}
【已写开篇正文证据（第1—3章全文；第4—10章摘要+首尾切片）】${opening || '（无）'}
${openingDiagnosis ? `【当前有效开篇诊断（只作索引，仍须回到正文核对）】\n${openingDiagnosis}\n` : ''}
${storyPromise ? `【本书创作宪章】\n${storyPromise}\n` : ''}
${platformGuidance || '【官方创作指导】无特定平台事实，仅按文本本身审阅。'}
${genreProfile || '【题材样本观察】无特定样本；不得自行补造平台偏好。'}

审阅维度（官方指导、题材样本和编辑启发不是统一阈值）：
${openingCheck}
${goldFingerLine}
${rhythmCheck}
6. 连续阅读：重要问题能否被后文承接，钩子是否自然且不重复同型？
7. 人设立住：主角有反应/选择/底牌，不窝囊？
8. AI味：剧情是否"太顺/太干净/太懂规矩/太线性/巧合过多/情绪模式化"？
${historyCheck}
请输出 JSON（不要输出 JSON 以外的任何内容）：
{"verdict":"pass|revise|reject","score":"0-100","reason":"总评","issues":[{"type":"开篇供给|连续阅读|冲突前置|${isHistory ? '立身之本|史实严谨|历史质感|历史人物尊重' : '核心玩法'}|回报节奏|人设立住|AI味|节奏拖沓","severity":"high|medium|low","chapter":1,"quote":"原文短引","issue":"问题","fix":"最小修改建议"}],"evidence_limits":"本评审是文本审阅，不预测平台流量或签约概率","observation_plan":["发布后观察的真实指标或评论信号"]}
- pass：文本未发现需要阻断发布的明显问题；revise：有带引文的可修问题；reject：存在结构或事实硬伤，需重新设计候选。
- 没有原文引文的问题不得触发自动修改。模型不得输出完读率、追读率或签约概率。
请输出 JSON。`;
}

/** V0.80 契约承诺核对指令（书契约"前N章承诺"是否兑现） */
