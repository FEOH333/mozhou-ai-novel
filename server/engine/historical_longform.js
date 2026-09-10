// server/engine/historical_longform.js —— 《示例历史长篇》年代阶段与硬校验
'use strict';
import { historicalFiguresFor } from './history.js'; // V0.93.10 历史人物登场窗（DB 优先+内置种子兜底）
import { LONGFORM_STAGES, lifecycleStageIdForPosition } from './longform_lifecycle.js';
import { isPlanningMetaPhase } from './historical_guardrails.js';

const PROTAGONIST_BIRTH_YEAR = 1232;

const RAW_HISTORICAL_SAMPLE_PHASES = [
  { idx: 1, title: '故园成灰', startYear: 1241, endYear: 1243, anchor: '淳祐元年蒙古再入蜀，故乡失守；先让读者爱上家与人，再完成失去', arc: '九岁流民的求生、丧亲与第一次选择', povScale: '一个孩子能看见的家、街巷与逃亡队伍', rewardModes: ['依恋', '生存', '关系'], emotions: ['温暖', '不安', '骤痛'] },
  { idx: 2, title: '山城余火', startYear: 1244, endYear: 1248, anchor: '余玠主持四川防务与山城体系建设', arc: '从被救济的流民成长为能养活自己、保护同伴的少年', povScale: '寨子、工役队与基层军民', rewardModes: ['能力', '归属', '尊严'], emotions: ['困顿', '新奇', '微暖'] },
  { idx: 3, title: '砺刃山城', startYear: 1249, endYear: 1253, anchor: '余玠治蜀后期及1253年去世；死亡方式与党争责任须依可靠史料谨慎处理', arc: '少年入伍、认识军纪与权力的边界，第一次付出选择的代价', povScale: '一队、一营与山城防线', rewardModes: ['能力', '信息', '关系'], emotions: ['昂扬', '敬畏', '压抑'] },
  { idx: 4, title: '风雨欲来', startYear: 1254, endYear: 1258, anchor: '王坚扩建钓鱼城；1258年蒙哥率军大举入蜀', arc: '从普通军卒成长为可靠骨干，在侦察、粮道和撤民中认识全局', povScale: '一城、数寨与四川防区', rewardModes: ['战术', '能力', '责任'], emotions: ['沉着', '紧张', '期待'] },
  { idx: 5, title: '钓鱼城头', startYear: 1259, endYear: 1260, anchor: '1259年钓鱼城之战与蒙哥之死', arc: '守住身后百姓，并第一次看见蒙古并非不可战胜', povScale: '钓鱼城贴身战场；仅在完整分场中短暂扩至蒙古军帐', rewardModes: ['战术', '牺牲', '信念'], emotions: ['窒息', '燃', '震撼'] },
  { idx: 6, title: '帝国裂隙', startYear: 1261, endYear: 1264, anchor: '蒙古汗位之争；南宋错失战略窗口', arc: '由战功获得责任，却发现赢一座城不等于改变一国', povScale: '四川制置体系与有限的临安、蒙古战略镜头', rewardModes: ['信息', '政治', '战略'], emotions: ['振奋', '错愕', '憋闷'] },
  { idx: 7, title: '荆襄云低', startYear: 1265, endYear: 1269, anchor: '四川、荆襄联动；1268年襄阳围城开始', arc: '从带一营兵到协调多支力量，建立真正属于自己的班底', povScale: '四川至荆襄的战区网络', rewardModes: ['统御', '关系', '战略'], emotions: ['开阔', '焦灼', '坚定'] },
  { idx: 8, title: '襄樊孤炬', startYear: 1270, endYear: 1273, anchor: '襄樊危局与1273年历史转折点；架空改变须由前因和代价推出', arc: '在救援、保存实力与违抗错误命令之间作出不可逆选择', povScale: '荆襄主战场与长江防线', rewardModes: ['战略', '牺牲', '抉择'], emotions: ['希望', '惨烈', '余痛'] },
  { idx: 9, title: '江山危局', startYear: 1274, endYear: 1276, anchor: '1274年宋度宗去世；1275年丁家洲之战；1276年临安危机；架空线开始显著分岔', arc: '军事统帅被迫进入国策与朝堂博弈，承担胜利之外的后果', povScale: '两淮、长江与临安决策层', rewardModes: ['政治', '战略', '尊严'], emotions: ['压迫', '愤怒', '决绝'] },
  { idx: 10, title: '长江不沉', startYear: 1277, endYear: 1279, anchor: '历史上的南宋崩解窗口；架空生存必须有此前积累与现实代价', arc: '把残存的军民、财政与信任重新组织成可以活下去的秩序', povScale: '东南与长江全线，主角仍是绝对中心', rewardModes: ['组织', '反转', '信念'], emotions: ['绝望', '坚韧', '爆发'] },
  { idx: 11, title: '北望山河', startYear: 1280, endYear: 1280, anchor: '守势转入有限反攻；每一步扩张须交代粮道、兵员与民生', arc: '从挽救残局转为主动塑造天下格局', povScale: '多战区协同但保持贴身限知', rewardModes: ['战略', '回收', '希望'], emotions: ['克制', '昂扬', '警惕'] },
  { idx: 12, title: '四十年', startYear: 1281, endYear: 1281, anchor: '距1241年整整四十年——四十年节点不是收尾，而是吹响全面反攻号角：主角在此兑现"轮到他们想想还能撑几年了"的金句（呼应简介），随后进入反攻延伸期（13-15卷），禁止12卷强行和解收尾', arc: '四十年守土大业立誓完成，全面反攻的号角吹响；主角从守势转入主动攻势，为延伸期反攻立下战略框架', povScale: '由一个人回到普通百姓，再远望山河；反攻号角与军民意志的汇聚', rewardModes: ['兑现', '传承', '希望'], emotions: ['释然', '悲欣', '辽阔'] },
  { idx: 13, title: '江淮反攻', startYear: 1282, endYear: 1285, anchor: '反攻延伸期：忽必烈晚年远征耗竭（安南/占城失败1284-1288）、财政崩溃、真金太子监国猝死（1285）——蒙古内政危机窗口；两淮-京湖反攻，光复江淮与临安方向', arc: '从守住南国到主动夺回：主角以老帅身份坐镇全局，新一代将领开始独当一面，光复战略要地并承担代价', povScale: '多战区协同反攻，主角仍是绝对中心，新一代将领分线推进', rewardModes: ['战略', '回收', '统御'], emotions: ['昂扬', '焦灼', '痛快'] },
  { idx: 14, title: '中原回望', startYear: 1286, endYear: 1290, anchor: '反攻延伸期：乃颜之乱（1287蒙古内战）、诸子争位酝酿；光复中原的决战——襄阳-汴梁方向，蒙古主力对决', arc: '光复中原的决战与最大代价：老战友凋零、主角旧伤与新一代的交接，把反攻推向战略决胜', povScale: '中原主战场与长江-两淮后方，老帅与新帅的双视角', rewardModes: ['决战', '牺牲', '尊严'], emotions: ['惨烈', '燃', '苍凉'] },
  { idx: 15, title: '北望无惧', startYear: 1291, endYear: 1294, anchor: '反攻延伸期收束：1294年忽必烈崩、蒙古诸子争位、战略收缩；草原收尾——南北新格局成立，"轮到他们想想还能撑几年"的最终兑现', arc: '反攻完成与新秩序落定：主角把胜果交给可持续制度并交出最高权位，新一代接棒，四十年誓言终兑现；全书在此结算', povScale: '由战场回到普通百姓，再远望山河；主角的退场与新秩序的升起', rewardModes: ['兑现', '传承', '余韵'], emotions: ['辽阔', '释然', '悲欣'] },
];

const SAMPLE_VOLUME_DUTIES = Object.freeze([
 { stageTurn: '主角在故园覆灭中第一次主动选择护住比自己更弱的人，而不是只顾逃命', requiredClosures: ['让故乡灯火、父母与幼弟形成真实依恋后完成失去', '确立“再不跪求别人救家”的创伤原点'], newMajorArcBudget: 3 },
 { stageTurn: '主角从受救济的流民变成能靠劳动、纪律和判断保护同伴的少年', requiredClosures: ['完成流民求生第一阶段', '建立山城军民共同体归属'], newMajorArcBudget: 2 },
 { stageTurn: '主角选择正式入伍并接受军纪约束，第一次因自己的判断付出不可逆代价', requiredClosures: ['关闭纯粹少年求生线', '兑现基层能力和责任的阶段成长'], newMajorArcBudget: 2 },
 { stageTurn: '主角从执行命令的军卒转为能对一城百姓后果负责的骨干', requiredClosures: ['完成从小队到防区的视野跃迁', '让1259大战的关键因果全部就位'], newMajorArcBudget: 1 },
 { stageTurn: '钓鱼城惨胜与蒙哥之死改变主角对蒙古与国运的判断：敌非天灾，国亦可救', requiredClosures: ['兑现十八年成长与钓鱼城承诺', '结束“蒙古不可战胜”的旧认知'], newMajorArcBudget: 1 },
 { stageTurn: '主角发现赢下一城不等于改变一国，旧有军事解法因朝局和制度掣肘而失效', requiredClosures: ['回收蒙哥之死的战略后果', '明确最终问题不仅是战场胜负'], newMajorArcBudget: 1 },
 { stageTurn: '主角建立真正班底，并决定为跨战区协同承担政治风险', requiredClosures: ['兑现统御能力阶段成长', '让四川、荆襄与朝堂线开始产生同一因果'], newMajorArcBudget: 1 },
 { stageTurn: '主角在救援、保存实力与违抗错误命令间作出不可撤销选择，三条战线开始汇流', requiredClosures: ['关闭至少一条早期关系/军中支线', '确定最终对手是外敌与失能秩序的叠加'], newMajorArcBudget: 0 },
 { stageTurn: '主角被迫从统兵者变成国策承担者，架空分岔正式显性化且必须支付现实代价', requiredClosures: ['让临安、长江、两淮线汇入终局', '逐项安置早中期关键人物命运'], newMajorArcBudget: 0 },
 { stageTurn: '在历史崩解窗口中，主角选择先重建可活下去的军民秩序，并承担失去权位/战友/安全的代价', requiredClosures: ['关闭南宋是否能存续的第一重悬念', '结算残军、财政、粮道与百姓信任'], newMajorArcBudget: 0 },
 { stageTurn: '主角从被动保全转入有限反攻，把最后战争条件、政治安排与退场代价全部推到台前', requiredClosures: ['关闭主要战争支线与朝堂支线', '完成关键关系线结算并为终卷预留余波空间'], newMajorArcBudget: 0 },
  // V0.93.9：12 卷为四十年节点（反攻号角），13-15 卷为反攻延伸期——用户定调"12 卷强行和解是恶心读者"，
  // 反攻完成（光复中原/草原收尾）在 1282-1294 忽必烈晚年窗口展开（远征耗竭/乃颜之乱/诸子争位）
  { stageTurn: '四十年守土大业立誓完成：全面反攻号角吹响（呼应简介金句"该轮到他们想想还能撑几年了"），主角从守势转入主动攻势，为延伸期反攻立下战略框架', requiredClosures: ['结算四十年守土阶段的遗留债务', '确立反攻的战略框架与新一代接棒轨道'], newMajorArcBudget: 0 },
  { stageTurn: '全面反攻展开：光复江淮与临安方向，主角以老帅坐镇、新一代分线推进，反攻付出代价但势不可挡', requiredClosures: ['关闭四十年守土阶段的遗留债务', '让新一代将领进入可独当一面的轨道'], newMajorArcBudget: 0 },
  { stageTurn: '光复中原的决战：最大代价（老战友凋零/旧伤/取舍）与战略决胜，把反攻推向不可逆', requiredClosures: ['关闭主要战争支线', '完成主角与新一代的正式交接'], newMajorArcBudget: 0 },
  {
    stageTurn: '反攻完成与新秩序落定：主角把胜果交给可持续制度并交出最高权位，新一代接棒，四十年誓言终兑现',
    requiredClosures: ['兑现"轮到他们想想还能撑几年"的最终承诺', '完成主角创伤、关键关系、战争、政治制度与普通百姓生活的五重结算'],
    newMajorArcBudget: 0,
    endingBlueprint: {
      core_promise: '让这片山河再也不需要一个九岁的孩子跪在路边，求人救他的家——并让北方第一次真正忌惮南方',
      final_opposition: '蒙古最后的军事压力与旧有失能秩序的残余共同构成最后阻力，二者都必须由前十四卷因果推出',
 final_choice: '主角在个人掌权与建立不依赖某个英雄的新秩序之间，选择后者并交出可独占的胜果',
      irreversible_cost: '永久放弃最高权位，承受战友牺牲、身体旧伤与无法让所有故人看见胜利的遗憾，禁止无代价完胜',
      protagonist_settlement: '他从死人堆里只想活下来的孩子，成长为能让普通人不必向英雄下跪求救的守护者，并最终学会放下以复仇定义自己',
      relationship_settlements: ['为父母与幼弟完成告别', '与四十年同袍完成最后一次并肩或送别', '让被他保护和培养的下一代能独立接过责任'],
      world_settlement: '交代军权、财政、粮道、地方治理和百姓生活如何进入可持续秩序，不以一句"天下太平"带过',
      historical_settlement: '说明宋蒙新格局、北方政权、四川/荆襄/两淮/临安及普通军民在架空分岔后的现实去向与代价',
 closing_image: '六十二岁的主角看见一个九岁孩子在路边跌倒；孩子自己爬起，身后有人回头扶他，却不必跪下求人救家。镜头由孩子与灯火拉向山河——北方第一次沉默',
      last_chapter_mode: '终战余波→幸存者与逝者安顿→制度和百姓生活落点→回到九岁创伤的主题回声→普通孩子与万家灯火的闭幕意象；不设新主线悬念',
    },
  },
]);

const HISTORICAL_SAMPLE_PHASES = Object.freeze(RAW_HISTORICAL_SAMPLE_PHASES.map((phase, index) => {
  // V0.97.2：题材阶段只提供“本卷发生什么”，阶段 ID 与标签由全书生命周期单一真源决定。
  // 旧表沿用十二卷时期的分段（第3卷提前 early_middle、第12卷附近提前 ending），
  // 会与 longform_lifecycle 同时注入两套冲突合同，进而诱发提前收尾和阶段任务乱跳。
 const lifecycleStage = lifecycleStageIdForPosition(index + 1, RAW_HISTORICAL_SAMPLE_PHASES.length);
  return Object.freeze({
    ...phase,
 ...SAMPLE_VOLUME_DUTIES[index],
    lifecycleStage,
    stageLabel: LONGFORM_STAGES[lifecycleStage].label,
    startAge: phase.startYear - PROTAGONIST_BIRTH_YEAR,
    endAge: phase.endYear - PROTAGONIST_BIRTH_YEAR,
  });
}));

export function protagonistAgeInYear(year, birthYear = PROTAGONIST_BIRTH_YEAR) {
  const numericYear = Number(year);
  return Number.isFinite(numericYear) ? numericYear - Number(birthYear) : null;
}

const CHINESE_ERA_NUMERALS = Object.freeze(['元', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']);

function eraLabel(name, ordinal) {
  return `${name}${CHINESE_ERA_NUMERALS[ordinal - 1] || ordinal}年`;
}

/**
 * 公元年对应的南宋年号。1276、1278 年发生改元，按月份可能有两个合法写法；
 * 1280 年后本书已经进入架空存续线，不能用真实历史强行指定年号。
 */
export function southernSongEraYearCandidates(year) {
  const numericYear = Number(year);
  if (numericYear >= 1241 && numericYear <= 1252) return [eraLabel('淳祐', numericYear - 1240)];
  if (numericYear >= 1253 && numericYear <= 1258) return [eraLabel('宝祐', numericYear - 1252)];
  if (numericYear === 1259) return ['开庆元年'];
  if (numericYear >= 1260 && numericYear <= 1264) return [eraLabel('景定', numericYear - 1259)];
  if (numericYear >= 1265 && numericYear <= 1274) return [eraLabel('咸淳', numericYear - 1264)];
  if (numericYear === 1275) return ['德祐元年'];
  if (numericYear === 1276) return ['德祐二年', '景炎元年'];
  if (numericYear === 1277) return ['景炎二年'];
  if (numericYear === 1278) return ['景炎三年', '祥兴元年'];
  if (numericYear === 1279) return ['祥兴二年'];
  return [];
}

export function expectedSouthernSongEraYear(year) {
  return southernSongEraYearCandidates(year)[0] || '';
}

/**
 * 是否启用内置「南宋末年架空史实流」年代阶段表。
 *
 * V0.109.1（开源版）：改为**显式配置开关**，不再用书名/简介正则当开关。
 * 旧实现靠具体作品名的正则匹配，等于把作品名当框架开关——
 * 既违反「题材特性必须收敛为配置开关」的铁律，脱敏后又会因占位名（示例历史长篇）
 * 命中而给任何历史书强塞 15 卷年代锁（模型不产 year 字段时必然重试耗尽卡死）。
 *
 * 开关优先级：
 *   1. 书级设置 `settings.historicalEraTemplate === true`（用户在书设置里显式开启）
 *   2. 环境变量 `NOVEL_HISTORICAL_ERA_TEMPLATE=1`（作者自用整库开启）
 *   3. 推荐内置示例却未配置时，回退识别「起点年 + 地理锚点」双证据（向后兼容既有存档）
 *
 * 明确认否（false）时一律不启用，便于用户在设置里关掉误判。
 */
export function isHistoricalSampleBook(book = {}) {
  const settings = book?.settings_json ? safeParse(book.settings_json) : (book?.settings || null);
  const flag = settings?.historicalEraTemplate;
  if (flag === false) return false;
  if (flag === true) return true;
  if (process.env.NOVEL_HISTORICAL_ERA_TEMPLATE === '1') return true;
  // 向后兼容：存量的历史书没有开关字段，但简介里写明起点年与地理锚点——
  // 两个独立证据同时成立才启用，避免任何「历史」题材新书被无条件套表。
  const text = `${book.title || ''} ${book.blurb || ''}`;
  return /1241|淳祐元年/.test(text) && /钓鱼城/.test(text);
}

function safeParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export function historicalLongformPhases(book = {}) {
 return isHistoricalSampleBook(book) ? HISTORICAL_SAMPLE_PHASES.map(phase => ({ ...phase })) : [];
}

export function historicalPhaseForVolume(book, volumeIdx) {
  const phases = historicalLongformPhases(book);
  return phases[Math.max(0, Number(volumeIdx || 1) - 1)] || null;
}

/** 卷纲年份窗：下限取上一卷实际出口年（若更早于规划起点），上限取规划终点。
 * 规划表把下一卷写成 1261 起、上一卷实际停在 1259 时，1260 是承接年不是越界。 */
export function historicalVolumeYearWindow(phase, previousExitYear) {
  const start = Number(phase?.startYear);
  const end = Number(phase?.endYear);
  const prev = Number(previousExitYear);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (!Number.isInteger(prev)) return { minYear: start, maxYear: end, bridged: false };
  return {
    minYear: prev,
    maxYear: Math.max(end, prev),
    bridged: prev < start,
  };
}

export function historicalPhaseText(book, volumeIdx, { previousExitYear } = {}) {
  const phase = historicalPhaseForVolume(book, volumeIdx);
  if (!phase) return '';
  // V0.93.10：本卷历史人物登场窗——写作/细纲知道该卷年份范围内谁已登场/在位（含官职/立场/约束）。
  // DB 优先（era_context 自动产出的人物档案，开新历史书自动可用），无则用内置宋末种子兜底。
  let figureLine = '';
  try {
    const figures = historicalFiguresFor(book?.id, { startYear: phase.startYear, endYear: phase.endYear, limit: 10 });
    if (figures.length) {
      figureLine = `\n本卷历史人物登场窗（真实人物须按史实登场/在位，不可提前或跳过；出场须有立场与盘算，不工具化）：\n${figures.map(f => `- ${f.name}（${f.office || '官职未定'}·${f.stance || ''}${f.constraint ? `；${f.constraint}` : ''}${f.deathYear ? `；卒于${f.deathYear}年` : ''}${f.alterable === '高' ? '；结局可因架空因果改变' : ''}）`).join('\n')}`;
    }
  } catch { /* 人物窗注入失败不阻断历史帧 */ }
  const yearWindow = historicalVolumeYearWindow(phase, previousExitYear);
  const yearSpan = yearWindow?.bridged
    ? `${yearWindow.minYear}—${yearWindow.maxYear}（上一卷实际出口 ${Number(previousExitYear)} 年；规划阶段表为 ${phase.startYear}—${phase.endYear}。出口年到规划起点之间必须用承接章写过，禁止跳年）`
    : `${phase.startYear}${phase.endYear === phase.startYear ? '' : `—${phase.endYear}`}`;
 return `【《示例历史长篇》结构化年代阶段（硬约束）】
本卷为第${phase.idx}阶段「${phase.title}」，公元${yearSpan}年；主角${phase.startAge}${phase.endAge === phase.startAge ? '' : `—${phase.endAge}`}岁（九岁起于1241年，出生年固定为1232）。
史实/架空锚点：${phase.anchor}
本卷人物弧：${phase.arc}
全书生命周期：${phase.stageLabel}（${phase.lifecycleStage}）。必须发生的阶段转折：${phase.stageTurn}
必须关闭或结算：${phase.requiredClosures.join('；')}。新重大主线额度：${phase.newMajorArcBudget}；超过额度的“新线”必须改为既有因果的推进、合并或回收。
视野尺度：${phase.povScale}。默认第三人称贴身限知；战略视角只能用完整场景或明确分隔切换，禁止同场景跳脑。
读者回报类型：${phase.rewardModes.join('、')}；情绪轮换：${phase.emotions.join('→')}。${figureLine}
每章必须输出 year、era_year、protagonist_age、phase、reward_mode、emotion 六个字段。year 必须落在上述公元年份窗内且不倒退，年龄只能由 year-1232 推导。
不得把十八年成长压成一句跳时或把1241到1259误写成“十年后”；跨年必须用若干完整场景、阶段性选择和关系/能力变化搭桥。`;
}

/**
 * V0.95.8 山河尺度分层（调研驱动：docs/历史磅礴感与山河尺度调研报告.md，用户定调
 * "前期可以收一点，中后期随主角身份/眼界/大局展开要写大气——不能一直像求生冒险文"）。
 * 实测 26 章实证：微观白描功力过硬（防 AI 味纪律的正确产物），但 26 章只有一个焦距——
 * 掌心/绳索/工册/蹄印；povScale 只作为上限注入卷纲，从未作为递增要求进入写作/审校，
 * 章名承诺的山河在正文缺位（ch26《北望长河》全章在灵帐对账页，"长河"零出现）。
 * 调研结论：大气 = 镜头拉远后的具体（数字的重量/地理俯瞰/结构性矛盾/无名者群像/
 * 史笔定调/大战全景开合/公文语体载体），不是"气势磅礴"式形容词（那恰是 AI 味）。
 */
export function historicalScaleTier(volumeIdx = 1) {
  const idx = Number(volumeIdx) || 1;
  if (idx <= 2) return 1; // 卷1-2 微观期：9-16 岁，家与工役队
  if (idx <= 4) return 2; // 卷3-4 中景期：入伍到骨干，"在侦察、粮道和撤民中认识全局"
  if (idx <= 8) return 3; // 卷5-8 全景期：大战、统帅、战区网络
  return 4;               // 卷9-15 史诗期：国策、反攻、终局
}

const SCALE_TIER_TEXT = {
  1: `第1层·微观期（本卷基调配额）：贴身微观白描为主基调——这是本书的功力所在，不许丢；但每章至少 1 处「远景一瞥」：借主角的眼望向大世界一角，一笔即收。
- 禁：整章只有掌心、屋檐与五感，世界缩成一个人的胶囊（书名承诺的山河在正文零痕迹）。
- 正例："队伍尽头有人在骂官军拉走了驴。再往北，天边一线黄尘，看不见头。"
- 量化：每章合计 ≥1 处、每处 1-2 句；不展开、不切换视角。`,
  2: `第2层·中景期（本卷基调配额）：每章至少 1 处「中景」：防线/工程/军情的全局信息，必须经具体载体带出——军报、图纸、粮册、长官之口（公文语体自带时代的重量），且落在地名与数字上。
- 禁：全局永远只有"局势吃紧""北边不太平"这类无地名无数字的空话。
- 正例："粮册上写着：渠州起运粮三千二百石，沿途折损四百。王坚的指头压在那个数上，没挪。"
- 量化：每章合计 ≥1 处、每处 2-4 句，含 ≥2 个具体地名或数字。`,
  3: `第3层·全景期（本卷基调配额）：每章至少 2 处「全景段」（各 80-200 字）：战局调度/朝局/民生俯瞰；至少 1 处「数字的重量」（兵员/粮草/疆域/岁入的具体数目+折损或对比）；至少 1 处山河地理俯瞰（江河关隘的坐标与战略意义）；大战章（围城/决战/陷落）必须以时代全景开篇或收束，且战役联动后方（朝堂/粮道/增援反应）。
- 禁：十万人的会战只写主角身边三十步；读完一卷拼不出战区地图。
- 正例："蒙古军沿江下寨二十里，炊烟起来时像一场落在地上的雾。对岸山城存粮还有四个月——这个数，城里只有三个人知道。"
- 量化：全景段每章 ≥2 处；数字重量 ≥1 处；地理俯瞰 ≥1 处。`,
  4: `第4层·史诗期（本卷基调配额）：第3层全部配额之外，再加：无名者群像每章 ≥1 处（刑徒、窑工、被裁的厢兵——名字不存，命运可见）；「史笔一瞥」每 2-3 章 1 处、全卷 ≤3 处（以史官视角一句定调，把个人命运钉进历史坐标，禁止滥用成套路）。
- 禁：终局卷仍只写帐内争执；改写历史的章节数字与疆域口径含糊。
- 正例（群像）："名字没人记得。垒进墙基的石头，倒一块块数得清。"
- 正例（史笔）："后来史书记这一年，只有七个字：冬，大雨水，汉水溢。"
- 量化：群像每章 ≥1 处；史笔全卷 ≤3 处。`,
};

/** 写作/审校共用的山河尺度纪律文本（写审同源一把尺）；非结构化长篇返回空（零影响）。 */
export function historicalScaleRegisterText(volumeIdx = 1, phase = null) {
  if (!phase) return '';
  const tier = historicalScaleTier(volumeIdx);
  return `【山河尺度纪律（第${tier}层·硬配额，写作与审校同一把尺）】本卷视野尺度：${phase.povScale || ''}。
${SCALE_TIER_TEXT[tier]}
总纲：大气 = 镜头拉远后的具体，不是"气势磅礴"式形容词（那恰是 AI 味）；全景/俯瞰必须服务主角当下的判断或情绪，保持贴身限知——镜头拉远，仍是他的眼睛在看。`;
}

/** 章细纲用的尺度节拍指定（细纲层就把配额落到具体场景与载体，写作才有得执行）。 */
export function historicalScaleBeatRule(volumeIdx = 1, phase = null) {
  const text = historicalScaleRegisterText(volumeIdx, phase);
  if (!text) return '';
  return `${text}
细纲执行要求：在 scenes 中明确指定哪一场承担远景/中景/全景节拍，把载体（军报/图纸/粮册/俯瞰/群像/史笔）写进该场景的 beat 描述；配额按章合计，单场景至多计 1 处。`;
}

/** 书纲级十五阶段总表；一阶段一卷，防模型把四十年压缩进前十章。
 *  V0.93.9：12 卷是"四十年"主题节点（吹响全面反攻号角，呼应简介金句"该轮到他们想想还能撑几年了"），
 *  不是完结——13-15 卷为反攻延伸期（1282-1294 忽必烈晚年窗口：远征耗竭/乃颜之乱/诸子争位），
 *  完成光复中原与南北新格局，禁止 12 卷强行和解收尾。 */
export function historicalLongformPlanText(book = {}) {
  const phases = historicalLongformPhases(book);
  if (!phases.length) return '';
  const lines = phases.map(phase =>
    `- 第${phase.idx}卷《${phase.title}》：${phase.startYear}${phase.endYear === phase.startYear ? '' : `—${phase.endYear}`}年，主角${phase.startAge}${phase.endAge === phase.startAge ? '' : `—${phase.endAge}`}岁；${phase.anchor}；人物弧：${phase.arc}`);
 return `【《示例历史长篇》十五卷年代总表（硬约束）】
${lines.join('\n')}
必须严格按一阶段一卷生成：卷序、年份与年龄不得合并、倒置或提前。1241年的九岁童年与1259年的钓鱼城相隔十八年，须用完整阶段承接；第1卷严格写1241—1243阶段，前20章按所属卷的阶段年份推进，绝不得提前写1259年蒙哥围攻钓鱼城。
第12卷落在1281年四十年节点：呼应简介金句"从今日起，该轮到他们想想还能撑几年了"——本卷吹响全面反攻号角，**不是完结**。第13-15卷为反攻延伸期（1282-1294），完成光复中原与南北新格局后在第15卷结算全书。禁止在12卷强行和解收尾。`;
}

/** 模型卷数/年份失约时用确定性阶段表归一化，保留同序卷的创作目标与摘要。
 *  V0.97.2：卷数口径 = max(完整历史阶段数, 模型卷数)。十五阶段既然是硬锚，
 *  模型只返回旧式 12 卷时也必须本地补齐 13-15 卷，不能只在提示词里声称十五卷。 */
export function normalizeHistoricalBookOutline(outline, book = {}) {
  const phases = historicalLongformPhases(book);
  if (!phases.length || !outline) return outline;
  const generated = Array.isArray(outline.volumes) ? outline.volumes : Object.values(outline.volumes || {});
  const targetCount = Math.max(phases.length, generated.length);
  const normalized = [];
  for (let i = 0; i < targetCount; i++) {
    const source = generated[i] || {};
    if (i < phases.length) {
      const phase = phases[i];
      normalized.push({
        idx: phase.idx,
        title: phase.title,
        goal: source.goal || phase.arc,
        summary: source.summary || `${phase.anchor}。${phase.arc}`,
        start_year: phase.startYear,
        end_year: phase.endYear,
        start_age: phase.startAge,
        end_age: phase.endAge,
        historical_anchor: phase.anchor,
        lifecycle_stage: phase.lifecycleStage,
        stage_turn: phase.stageTurn,
        required_closures: phase.requiredClosures,
        new_major_arc_budget: phase.newMajorArcBudget,
        ...(phase.endingBlueprint ? { ending_blueprint: phase.endingBlueprint } : {}),
      });
    } else {
      // 超出锚点的延伸卷：保留模型输出，补齐 idx 与生命周期兜底（后期收尾）
      normalized.push({
        ...source,
        idx: Number(source.idx) || i + 1,
        lifecycle_stage: source.lifecycle_stage || 'ending',
        stage_turn: source.stage_turn || '反攻延伸期推进',
        arcs_advanced: Array.isArray(source.arcs_advanced) ? source.arcs_advanced : [],
        arcs_closed: Array.isArray(source.arcs_closed) ? source.arcs_closed : [],
        hooks_paid: Array.isArray(source.hooks_paid) ? source.hooks_paid : [],
        new_major_arcs: Array.isArray(source.new_major_arcs) ? source.new_major_arcs : [],
        ending_delivery: source.ending_delivery || {},
      });
    }
  }
  return { ...outline, volumes: normalized };
}

/** 将卷纲已定的年代字段带入章细纲；模型只能补场景，不能悄悄丢掉年份坐标。 */
export function mergeHistoricalChapterFrame(outline, planned = {}, phase = {}) {
  if (!outline) return outline;
  const year = Number(planned.year ?? outline.year ?? phase.startYear);
  const plannedPhase = String(planned.phase || '').trim();
  const lockPhase = plannedPhase && !isPlanningMetaPhase(plannedPhase);
  return {
    ...outline,
    year: Number.isFinite(year) ? year : undefined,
    era_year: planned.era_year || outline.era_year || '',
    protagonist_age: Number(planned.protagonist_age ?? outline.protagonist_age ?? protagonistAgeInYear(year)),
    phase: lockPhase ? plannedPhase : String(outline.phase || ''),
    reward_mode: planned.reward_mode || outline.reward_mode || phase.rewardModes?.[0] || '',
    emotion: planned.emotion || outline.emotion || phase.emotions?.[0] || '',
  };
}

function outlineText(chapter) {
  return `${chapter?.title || ''} ${chapter?.beat || ''} ${chapter?.phase || ''}`;
}

/** 在卷纲落库前拦截确定性的年代、年龄和真实人物生卒越界。 */
export function validateHistoricalVolumeOutline(outline, phase, { previousExitYear } = {}) {
  const issues = [];
  const chapters = Array.isArray(outline?.chapters) ? outline.chapters : [];
  let previousYear = null;
  const titleFirstSeenAt = new Map();
  const yearWindow = historicalVolumeYearWindow(phase, previousExitYear);
  for (const chapter of chapters) {
    const idx = Number(chapter?.idx) || issues.length + 1;
    const year = Number(chapter?.year);
    const age = Number(chapter?.protagonist_age);
    const text = outlineText(chapter);
    const title = String(chapter?.title || '').trim();

    if (title) {
      if (titleFirstSeenAt.has(title)) {
        issues.push({ code: 'DUPLICATE_CHAPTER_TITLE', chapter: idx, message: `章名“${title}”与第${titleFirstSeenAt.get(title)}章重复` });
      } else {
        titleFirstSeenAt.set(title, idx);
      }
    }

    if (!Number.isInteger(year)) {
      issues.push({ code: 'HISTORICAL_YEAR_MISSING', chapter: idx, message: '缺少有效的公元年份 year' });
    } else {
      if (yearWindow && (year < yearWindow.minYear || year > yearWindow.maxYear)) {
        issues.push({
          code: 'YEAR_OUTSIDE_PHASE', chapter: idx,
          message: `${year}年越出本卷${yearWindow.minYear}—${yearWindow.maxYear}年边界`,
        });
      }
      if (previousYear != null && year < previousYear) {
        issues.push({ code: 'YEAR_REVERSED', chapter: idx, message: `${year}年早于上一章${previousYear}年` });
      }
      previousYear = year;
      const expectedAge = protagonistAgeInYear(year);
      if (!Number.isInteger(age) || age !== expectedAge) {
        issues.push({ code: 'PROTAGONIST_AGE_MISMATCH', chapter: idx, message: `${year}年主角应为${expectedAge}岁，不是${chapter?.protagonist_age ?? '未填'}岁` });
      }
      const eraCandidates = southernSongEraYearCandidates(year);
      const eraYear = String(chapter?.era_year || '').replace(/\s+/g, '');
      if (eraCandidates.length && !eraCandidates.some(candidate => eraYear === candidate)) {
        issues.push({
          code: 'ERA_YEAR_MISMATCH', chapter: idx,
          message: `${year}年的年号应为${eraCandidates.join('或')}，不是${chapter?.era_year || '未填'}`,
        });
      }
    }

    if (/余玠/.test(text) && Number.isInteger(year) && year > 1253
      && /(召见|召来|下令|命(?:令|他|其)|会见|接见|亲自|率军|领军)/.test(text)
      && !/(遗策|故居|遗书|旧令|生前|追忆|回忆|墓|死讯)/.test(text)) {
      issues.push({ code: 'REAL_PERSON_AFTER_DEATH', chapter: idx, message: '余玠已于1253年去世，不能在此年后亲自行动' });
    }
    if (Number.isInteger(year) && year < 1259
      && /蒙哥/.test(text) && /(围|攻|亲征).{0,16}钓鱼城|钓鱼城.{0,16}(围|攻)/.test(text)) {
      issues.push({ code: 'EVENT_TOO_EARLY', chapter: idx, message: '蒙哥围攻钓鱼城不得早于1259年' });
    }
    if (Number.isInteger(year) && year < 1243
      && /钓鱼山/.test(text) && /(?:筑城|营造|开挖?基槽|砌筑?城墙|城墙.{0,8}(?:开工|动工)|料石队.{0,8}(?:进场|开工))/.test(text)) {
      issues.push({ code: 'EVENT_TOO_EARLY', chapter: idx, message: '钓鱼山正式筑城不得早于1243年' });
    }
    if (Number.isInteger(year) && year < 1275
      && /丁家洲/.test(text) && /(?:战|迎战|决战|兵败|溃败|大败)/.test(text)) {
      issues.push({ code: 'EVENT_TOO_EARLY', chapter: idx, message: '丁家洲之战发生在1275年，不得提前到1274年' });
    }
    if (/十年后/.test(text)) {
      issues.push({ code: 'TIMESKIP_MISMATCH', chapter: idx, message: '1241年至1259年是十八年，不是十年' });
    }
  }
  return { ok: issues.length === 0, issues };
}
