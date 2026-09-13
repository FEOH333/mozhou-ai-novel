// server/engine/prompts.js —— 全部提示词模板
// 缓存纪律：system 与公共材料（前缀）必须恒定；一切动态内容只出现在最后一条 user 指令里。
'use strict';
import { structureInjection, CONTRAST_BUILDUP_TEXT, COLD_OPEN_CRAFT_TEXT, TITLE_CRAFT_TEXT, VOLUME_TITLE_CRAFT_TEXT } from '../data/literary_techniques.js'; // V0.83 叙事结构纪律 // V0.85 对比铺垫·先立后破 // V0.98.3 远期楔子·神开局工艺 // V0.107 章卷命名工艺单一真源（书纲/卷纲/细纲/改名四处共用，禁止内嵌第二份）
import { AI_TASTE_FULL, EXTREME_CLICHES, STRICT_MOTIFS, REDLINES } from '../data/redlines.js'; // V0.100.15 返工候选文风注入与本地检测同源
import { RECOVERY_WINDOW_LENGTH_RATIOS } from './recovery/recovery_contract.js'; // V0.100.15 窗口篇幅上下限与本地闸同源
import { formatPhaseDutyRule } from './longform/historical_guardrails.js'; // V0.102.3 阶段任务核验与指令同源：列出可核验动作，不必抄写规划套话

// ========== 前缀（恒定） ==========

/** 平台创作参考：只提供表达方向，不冒充审核阈值或算法规则。 */
export const PLATFORM_RULES = {
  番茄: `【番茄创作参考（官方指导与编辑启发，不是审核阈值）】
1. 尽早让本书真正依靠的吸引点可辨认：人物、眼前困局或选择至少有一项成立；速度服从题材，不机械要求打斗、系统或公开打脸。
2. 章节要产生状态变化或具体阅读回报；回报可来自关系、信息、能力、尊严、利益、情绪或局势，不把单一爽点节奏套给所有作品。
3. 章末是否留钩服从章节功能；钩子可以是危机、疑问、关系、抉择、信息差、局势转折或余韵，不限于挑衅和倒计时。
4. 设定随人物行动和场景带出，减少不改变状态的背景说明、重复形容和旁白式对白。
5. 移动端可读性重在人物与因果清楚；段落和心理描写按场景需要变化，不以固定比例替代审美判断。`,
  起点: `【平台套路规则：起点中文网（慢热品质）】
1. 信息增量：每章必须让读者"知道了一样新东西"（设定/人物/局势/秘密），拒绝注水。
2. 死亡节奏：每 10-15 章必须有人物死亡或重大损失，且名字要提前让读者熟悉。
3. 主角每 10 章至少 1 次亲手战斗（可以有恐惧，但必须动手）。
4. 钩子五类轮换：危机/悬念/感情/利益/成长，不连续三章同型。
5. 反派必须能说话、有逻辑、有自己的目标，不做工具人。
6. 群像：每 10 章至少 1 个配角独立高光场景。`,
  通用: '',
};

/** 历史长篇不能照搬玄幻式番茄模板：保留追读效率，用多类型阅读回报替代每章打脸。 */
export const HISTORY_PLATFORM_RULES = {
  番茄: `【番茄历史长篇创作参考（题材翻译，不是平台阈值）】
1. 尽早呈现一个可感知变化、关系动作或人物选择；不强迫暴力开场，重要悲剧前允许用完整场景建立依恋。
2. 章节应带来具体阅读回报：依恋 / 生存 / 能力 / 关系 / 信息 / 尊严 / 战术 / 战略 / 余韵；铺垫可以不赢，但不能连续空转。
3. 兑现密度根据本书创作宪章与阶段职责设计；胜利有成本，失败换来信息、关系或选择增量。
4. 章末钩可用危机、疑问、关系、抉择、信息差、局势转折或余韵，不强迫叫板和倒计时。
5. 铺垫、推进、释放与日常要有轮换；主角应作出符合年龄和能力的选择，第三人称贴身限知可随责任范围逐步扩大。`,
};

/**
 * 书级 system prompt（存在 public_materials.kind='system'，用户可编辑但改动会重建缓存）
 */
/**
 * V0.42：叙述视角描述（third=第三人称 / first=第一人称主角）
 * 写入系统提示与各指令，强约束模型按人称写作，杜绝"默认第三人称"问题。
 * V0.93.1：视角纪律单一实现——细纲（variant='outline'）与审校（variant='audit'）
 * 同源调用，不再内联复制三份措辞。
 */
export function perspectiveText(perspective, protagonist = '', variant = 'base') {
  const firstBase = `【叙述视角】第一人称（主角视角）：正文用"我"叙述${protagonist ? `（主角 ${protagonist}）` : ''}的所见所闻所感与心理活动；不得出现第三人称客观叙述（"他/她做了…"），对话内容中引用除外。全程只能用"我"看、听、想，读者只能知道主角知道的事。`;
  const thirdBase = `【叙述视角】第三人称：正文用"他/她/角色名"叙述；不得出现第一人称"我"（仅对话与内心独白引用除外）；叙述视角跟随当前 POV 角色，不漂移。`;
  if (variant === 'outline') {
    return perspective === 'first'
      ? `${firstBase}场景 POV 必须全程是主角，不得切到其他角色视角。`
      : `${thirdBase}POV 可跟随场景主要角色，但不得用"我"。`;
  }
  if (variant === 'audit') {
    return `【本书叙述视角】${perspective === 'first'
      ? '第一人称（主角视角）：正文必须全程用"我"叙述。若草稿出现大段第三人称客观叙述（"他/她做了…"），报 high 严重度「人称视角」。对话内容中的引用不算。'
      : '第三人称：正文用"他/她/角色名"叙述。若草稿正文叙述段出现第一人称"我"（对话与内心独白引用除外），报 high 严重度「人称视角」。'}`;
  }
  return perspective === 'first' ? firstBase : thirdBase;
}

export function buildSystemPrompt(book) {
  const isHistory = book?.genre === '历史';
  const platformRules = (isHistory && HISTORY_PLATFORM_RULES[book?.platform])
    || PLATFORM_RULES[book?.platform] || PLATFORM_RULES['通用'] || '';
  return `你是资深中文网络小说作家兼编辑，笔名"墨舟"。你出版过上百部连载作品，精通爽点节奏、伏笔回收、人物弧光与"去AI味"写作。

【本书信息】
书名：${book?.title || '（未命名）'}
题材：${book?.genre || '玄幻'}
一句话梗概：${book?.blurb || '（未设定）'}
${book?.perspective === 'first' ? `叙述视角：第一人称（主角视角）\n` : `叙述视角：第三人称\n`}
${platformRules ? `平台：${book.platform}\n` : ''}
${platformRules}

【写作铁律】
1. 严格服从指令中给出的【本章细纲】与【检查点】，不得跳过、篡改或擅自增加情节主线；细纲是最高优先级。
1.5 **叙事变通优先（V0.85）**：细纲是"要达成什么"（事件/意象/情感/人物关系），不是"必须逐字怎么写"。在**不违背细纲要点、不新增冲突情节**的前提下，你有权选择最能出效果的呈现方式：
   - 节奏可缓可急（重要情感/悲剧前先铺垫，冲突前先蓄力）；
   - 细节自行发挥（对话/动作/环境/内心）——只要不引入细纲禁止的设定。
   - 判断标准：**读者体验优先**。同一个要点，怎么写更动人、更有张力、更符合人物，就怎么写。
   - **插叙倒叙受限**（详见正文指令第 8 条，先立后破铺垫不受限）。
   - **裁决边界（V0.95）**：事件清单（谁做了什么、发生什么后果、剧情走向）是硬约束，不得增删改；呈现方式（怎么铺垫、怎么措辞、用什么细节承载）是软约束，自由发挥。两条规则冲突时以本边界为准。
2. 只使用指令中【相关设定】【相关事实】【活跃伏笔】提供的内容。绝对禁止编造指令中不存在的人物、地名、物品、势力、能力与历史事件；确有需要新增设定时，在正文末尾用 【新设定:xxx】 标记，由系统登记。
3. 保持全书一致性：人物性格、外貌、称呼、实力、关系、地点方位、时间线不得前后矛盾。
4. 伏笔处理：指令要求呼应/推进/回收的伏笔必须落实；回收伏笔时要让读者能回忆起埋设（可简述由来）。
5. 视角与叙事：严格遵守指令指定的 POV 视角与叙述人称；不得视角漂移（如第三人称叙述中突然出现"我"）。
6. 只写指令要求的一个场景，从场景节拍开始到节拍完成结束；不得重复或改写前文内容，不得预告尚未发生的剧情。
7. 字数：达到指令要求的字数范围，不注水、不拖沓。

【文风要求（去AI味）】
1. 少用"然而、不禁、仿佛、似乎、顿时、缓缓、微微、嘴角勾起一抹弧度、瞳孔微缩、眸中闪过一丝、眼底闪过、心中升起、说不出的、这意味着、他的眼神、她的眼眸、深邃、不可置信、不由得、众所周知、值得一提的是、综上所述、无与伦比、美轮美奂、叹为观止、淋漓尽致、需要注意的是、不难看出、显而易见、非常、十分、相当、极其"等 AI 高频套话，一段最多出现一次同类词。
2. 禁止"不是X，而是Y"式抽象对比（如"不是恐惧，而是某种更深层的东西"）；直接写事实本身。对话中的"不是"可保留。
3. 禁止元话语：正文不得出现"卷一""第X章""前文""后文""本章"等写作术语。
4. 破折号每章不超过 20 个；段落不超过 200 字。
5. 用动作、对话、细节推进剧情，克制形容词堆砌；对话要符合人物身份与性格，少用"XX说道"直白标签，多用动作带出说话人。
6. 情绪要写身体反应而非标签："他感到愤怒"是禁句——写"他握紧了拳，指节咯吱作响"。
7. 感官优先于思考：紧张/恐怖场景 70% 笔墨写生理感官（心跳、汗、冷），禁长心理独白。
8. 动作切断语言：冲突中先动作后台词（"心跳擂鼓。他猛地撑桌，起身。"）。
9. 段落短句为主，长句点缀；每段 2-5 句；对话独立成段。
10. 悬念章要留钩子：场景结尾制造张力或未解之谜，但不故弄玄虚。
11. 不要输出任何作者旁白、章节标题、Markdown 格式、解释性文字；只输出小说正文本身。`;
}

/**
 * 公共材料（固定 user 消息；kind=world/characters/outline 拼接）。
 * 全部来自作品数据，用户编辑前恒定不变。
 */
export function buildPublicMaterials({ world, outline, contract, cast }) {
  const parts = [];
  if (world) parts.push(`【世界观设定】\n${world}`);
  // V0.59 整合：不再注入【人物卡】材料（V0.28 静态文本与 cast 设计蓝图重复、且不与角色库表同步会漂移）
  // 角色信息单一事实源 = characters 表（运行时档案，按场景动态注入）+ cast（长期设计蓝图）
  if (cast) parts.push(`【角色弧光与配角库（人物设计是硬约束：成长、秘密、命运线须逐步兑现）】\n${cast}`);
  if (outline) {
    // V0.66：outline 材料可能含"世界观：…"初稿段（书纲生成时写入，作为设定生成基础）——
    // 设定(world)生成后该段重复且可能冲突，注入时剥离（保留书名/梗概/主题 + 【分卷规划】），
    // 世界观以 world 材料为唯一事实源，消除两处大纲冲突
    const oi = outline.indexOf('【分卷规划】');
    let o = outline;
    if (oi >= 0) {
      const wi = outline.indexOf('世界观');
      o = (wi >= 0 && wi < oi) ? outline.slice(0, wi).trimEnd() + '\n\n' + outline.slice(oi) : outline;
    }
    parts.push(`【书级大纲与已定剧情框架】\n${o}`);
  }
  // V0.29：书契约进公共材料前缀（顶层合同恒定，之前每次重复传入指令造成缓存 miss）
  if (contract) parts.push(`【书契约（硬约束，不得违反）】\n${contract}`);
  if (!parts.length) parts.push('【世界观设定】\n（尚无设定，请按指令要求发挥，并在正文末尾用【新设定:xxx】标记任何新设定。）');
  return `以下是你必须始终遵守的本书固定设定与大纲。它们是你的事实依据，任何与它们冲突的内容都视为错误。\n\n${parts.join('\n\n')}`;
}

// ========== 尾部指令（动态，最后一条 user 消息） ==========

/** 书级大纲生成指令 */
/**
 * V0.93.9 结局倒推纪律（书纲生成/对齐共用）：
 * 用户实测分卷规划"卷11才反攻、卷12和解"，撑不起简介金句
 * （"该轮到他们想想还能撑几年了"）——根因是书纲指令只要求分卷列表，没有
 * "从结局承诺倒推推进阶梯"的硬要求。禁-正例-量化，写审同源。
 */
export const ENDING_BACKCAST_TEXT = `【结局倒推硬要求】（V0.93.9：先定终局，再倒推每卷推进，禁止虎头蛇尾）
- 终局必须兑现简介/灵感里的结局承诺（核心金句/画面/誓言），并把"兑现过程"写进末卷与倒二卷的 summary——禁止末卷只有和解情绪、没有兑现动作；
- 反攻/逆转/清算类主线动作必须提前展开：**倒数第二卷及更早就处于行动进行中**（收复失地/决战/清算权臣/破局），末卷做决战与结算——禁止"前面全守、倒二卷才动手、末卷草草收尾"的断档结构（反例：卷11"开始反攻"、卷12"和解收尾"；正例：卷10 埋反攻势能，卷11 反攻展开并收复战略要地，卷12 决战+格局重塑+誓言结算）；
- 每卷 summary 必须有实质推进（夺地/破局/收权/成长/决裂/清算任选其一），禁止连续两卷以上只写"坚守/蛰伏/积蓄/待变"而无推进；
- 权谋/朝堂暗线（题材含权斗时）：按"铺垫→发酵→引爆→落定"四阶段明确映射到具体卷次（如"卷X铺垫被掣肘→卷Y发酵结盟布局→卷Z引爆清算→末卷落定制度"），禁止全书写到中后段才"提一嘴"权斗。`;

/**
 * V0.95 卷际张力升级纪律（审计 F1：全书无一条"本卷必须比上卷更强"——「越写越平」的结构性根源）。
 * 三轴升维检查单（对手量级/舞台层级/代价面至少一轴上移）；禁-正例-量化，写审同源（卷审复核）。
 * 只进 L4 卷纲/卷审指令，不进 L1 system（缓存纪律铁律 4）。
 */
export const ESCALATION_TEXT = `【卷际张力升级硬要求】（V0.95：每卷必须比上一卷"更重"——长篇中段疲软的头号原因是卷与卷等重）
- 三轴升维检查单（本卷 vs 上一卷，至少一轴明显上移，写进卷 goal/summary）：
  ① 对手量级：对手的层级/能力/智识/背后势力更高（正例：卷3 对手从"克扣粮饷的仓吏"升级为"能调动一路兵马的都统"——不是同名对手换个地方再打一次）；
  ② 舞台层级：冲突影响面更大（从一寨→一城→一路→天下；从个人恩怨→阵营博弈→国运）；
  ③ 代价面：失败的损失更重（从丢脸→丢职→丢城→丢掉至亲），胜利的代价也更贵（赢下这一卷要付出什么必须写明）；
- 禁止：出现比上一卷更弱的对手、更轻的筹码、更小的影响面（等重卷=读者感到"重复刷副本"，弃书点）；
- 历史题材同理：对手从偏师→主力→名将→汗廷；战场从山寨→县城→州府→京湖/两淮；朝堂从胥吏→州官→台谏→宰执。`;

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
export function lengthRequirementText(chapterLength) {
  const len = Math.max(1500, Number(chapterLength) || 3200);
  let sceneRange, perScene;
  if (len <= 2500) { sceneRange = '2-3 个'; perScene = '800-1200'; }
  else if (len <= 3500) { sceneRange = '3-4 个'; perScene = '900-1300'; }
  else if (len <= 5000) { sceneRange = '4-5 个'; perScene = '1000-1400'; }
  else { sceneRange = '5-6 个'; perScene = '1100-1500'; }
  return `本章目标 ${len} 字左右（作品设定）。要求：场景 ${sceneRange}，每个 target_words ${perScene}；**各场景 target_words 之和必须在 ${Math.round(len * 0.9)}-${Math.round(len * 1.1)} 字之间（下限防短章=单次购买所得腰斩，上限防各场景目标叠加导致全章超长——V0.105.2 实测 ch43-48 连续 4 章破 135% 红线的源头之一），每个场景 ≥700 字**；总字数尽量贴近目标，宁可用具体动作与对话填充，也不注水。`;
}

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
export function attractionRevisionNote({ isHistory = false, rewardMode = '' } = {}) {
  if (isHistory) {
    return `在保持细纲情节走向和史实边界的前提下强化本章吸引力：用本章已有因果写出自然产生的余力（疑问/关系/抉择/信息差/局势/余韵均可），补足一种具体阅读回报${rewardMode ? `（优先：${rewardMode}）` : '（依恋/生存/能力/关系/信息/尊严/战术/战略/余韵）'}。不得硬塞陌生人、密信、烟柱、犬吠或远方异动；不得把观察改成审讯来显得主动。铺垫章不必取胜或打斗；若有胜利须写代价。不要新增与细纲冲突的情节。`;
  }
  return '在保持细纲情节走向和本书核心吸引点的前提下，只修审阅中有原文证据的缺口：让场景产生变化或具体回报，让人物作出符合身份的反应或选择，用本章已有因果写出自然产生的余力。不要强塞打脸、围观震惊、机械悬崖、陌生人、密信或烟柱，不要新增与细纲冲突的情节。';
}

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
