// server/engine/pending.js —— V0.40 待登记实体自动治理
// 章结算后自动整理（零 LLM 成本，纯规则）：
//  ① 已登记去重：名字已存在于任一卡表 → already_registered
//  ② 类型推断建卡：地点/物品/势力/角色特征词 → 自动建对应卡（带 dup_count 强信号优先）
//  ③ 误建迁移：autoConfirmed 角色卡但名字/上下文是地点/物品 → 迁移到正确卡表
//  ④ 超期归档：>8 章未再次出现且无法推断类型 → stale_archived（保留记录不丢失）
//  ⑤ 概念类：无法推断类型且未超期 → 保留 pending 观察（后续再次出现自动处理）
'use strict';
import * as store from '../db/store.js';

/** 类型推断规则：先精确类型（角色/物品特征最强），再宽松类型（地点/势力）；名字或上下文命中即归类 */
const TYPE_RULES = [
  {
    type: 'character',
    nameRe: /(奶娘|师父|师兄|师姐|师妹|师弟|长老|族长|老祖|仆人|丫鬟|管家|护卫|侍卫|娘|爷|爹|叔|伯|婶|嫂|姐|妹|哥|弟|帝|王|后|妃|太子|公主|少爷|小姐|大人|前辈|道友|老怪|存在|人影|身影|怪物|妖兽|生灵|剑客|斗笠人|修士|武者|少年|少女|老者|青年|大汉|女子|男子|姑娘|公子|和尚|道士|棋手|匠人|郎中|商人|掌柜)/,
    ctxRe: /(他说|她说|说道|回应|冷笑|怒喝|沉声|开口|此人|对方|自称|名叫|人称|出手|对峙|跪拜|走上前|转过身|走进|走出|坐下|起身|被杀|被杀身亡|怒斥|喝道)/,
  },
  {
    type: 'item',
    nameRe: /(符|剑|印|卷|书|珠|灵石|玉石|镜|旗|环|护符|残卷|手记|纹|法杖|鼎|炉|图|册|令|牌|甲|簪|佩|玉|笛|琴|伞|灯|瓶|壶|碗|盘|匣|盒|戒|链|坠|诏|文书|阵法书|典籍|古卷|卷轴|钥匙|锁|钱袋|屏障|封印|禁制|结界|阵纹|阵法|古印|法宝|灵器|丹药|药草|秘籍|功法|阵盘)/,
    ctxRe: /(佩戴|腰侧|持有|随身|藏着|攥着|腰间|袖中|背包|空间戒|储物|获得|捡到|得到|祭出|取出|拿出|握住|紧握|铜色|银色|金色)/,
  },
  {
    type: 'faction',
    nameRe: /(家族|宗|门|派|盟|教|会|势力|帮|世家|皇朝|帝国|王朝|商会|佣兵|组织|联盟|部落)/,
    ctxRe: /(渗透|结盟|敌对|掌控|统辖|加入|背叛|效忠|依附|对抗|围剿|联合)/,
  },
  {
    type: 'location',
    nameRe: /(禁地|西院|东院|后院|府|殿|阁|塔|洞|谷|坳|寨|坞|关|塞|城|村|山|门|井|院|楼|宫|密室|地牢|走廊|厅|房|口|遗址|秘境|坟|墓|馆|斋|轩|亭|台|桥|河|湖|海|森林|草原|沙漠|市|镇|坊|街|巷|广场|校场|丹房|药园|藏书|廊柱|墙角|树下|石井)/,
    ctxRe: /(地名|位于|在|前往|到达|进入|地处|坐落|隐藏|通往|设在|所在|建造|重修|东南角|附近|内部|外围)/,
  },
];

/** 推断实体类型：location|item|faction|character|null（null=概念/无法推断）
 *  V0.78 修复：先剥离"（身份描述）"后缀再判断——避免"老幺（书库杂役）"里的"书"被 item 规则误命中。 */
export function inferEntityType(name, context = '') {
  // 剥离"（…）"身份后缀（如"老幺（书库杂役）"→"老幺"），后缀信息并入 context 供语境判断
  let core = String(name || '').trim();
  let suffix = '';
  const m = core.match(/^(.*?)[（(]([^）)]+)[）)]$/);
  if (m) { core = m[1].trim(); suffix = m[2].trim(); }
  const fullContext = [context, suffix].filter(Boolean).join('；');
  for (const rule of TYPE_RULES) {
    if (rule.nameRe.test(core)) return rule.type;
    if (fullContext && rule.ctxRe.test(fullContext)) return rule.type;
  }
  return null;
}

const KIND_MAP = { location: 'locations', item: 'items', faction: 'factions', character: 'characters' };

/**
 * V0.78 角色倾向判定：名字像是人物称谓/昵称（TYPE_RULES 未覆盖）→ 默认按角色登记。
 * 覆盖"老幺/小二/阿三/老王/老张/掌柜的/那人/男子甲"等普通名词昵称——正文【新设定】登记
 * 的名词绝大多数是人物，即使词表不匹配也应倾向角色而非归档丢失。
 */
// 前缀：老/小/阿/大/二/三... + 姓氏；排行字：幺/幺/末/大/二/三/四/五/六/七/八/九/十
const PERSON_NICK_RE = /^(老|小|阿|大|王|李|张|赵|刘|陈|杨|黄|周|吴|徐|孙|马|朱|胡|郭|何|高|林|罗|郑|梁|谢|宋|唐|许|韩|冯|邓|曹|彭|曾|肖|田|董|潘|袁|蔡|蒋|余|于|杜|叶|程|苏|魏|吕|丁|任|沈|姚|卢|姜|崔|钟|谭|陆|汪|范|金|石|廖|贾|夏|韦|傅|方|白|邹|孟|熊|秦|邱|江|尹|薛|闫|段|雷|侯|龙|史|陶|黎|贺|顾|毛|郝|龚|邵|万|钱|严|覃|武|戴|莫|孔|向|汤)[一二三四五六七八九十甲乙丙丁幺末幺大\d]{1,3}$/;
/** 非人物结尾（地点/势力/物品常见后缀）——人物名几乎不以这些结尾 */
const NON_PERSON_SUFFIX = /(城|镇|村|山|峰|谷|坳|寨|坞|关|塞|岭|崖|洞|窟|宫|殿|楼|阁|台|坊|街|巷|桥|河|湖|江|林|原|庙|寺|观|井|泉|塔|田|坡|沟|渠|坝|堤|院|园|廊|亭|房|屋|窑|市|集|铺|栈|驿|家族|宗门|门派|帮派|世家|皇朝|商会|联盟|部落|剑|刀|珠|镜|玉|骨|石|符|印|图|令|牌|环|戒|坠|幡|伞|钟|鼓|琴|笛|册|匣|盒|钥|锁|轮|片|穗|绳|链|棒|杖|筒|碗|盏|灯|烛|香|签|光|丝|纹|痕|疤|块|粒|袋|囊|瓶|罐|盆|铲|锄|犁|网|钩|针|线|布|帛|纸|墨|砚|笔|灰)$/;
/** 常见姓氏（用于"老X""赵X"人名判定） */
const SURNAME_RE = /^(王|李|张|赵|刘|陈|杨|黄|周|吴|徐|孙|马|朱|胡|郭|何|高|林|罗|郑|梁|谢|宋|唐|许|韩|冯|邓|曹|彭|曾|肖|田|董|潘|袁|蔡|蒋|余|于|杜|叶|程|苏|魏|吕|丁|任|沈|姚|卢|姜|崔|钟|谭|陆|汪|范|金|石|廖|贾|夏|韦|傅|方|白|邹|孟|熊|秦|邱|江|尹|薛|闫|段|雷|侯|龙|史|陶|黎|贺|顾|毛|郝|龚|邵|万|钱|严|覃|武|戴|莫|孔|向|汤)$/;
/** 是否像人物称谓（老幺/小二/阿福/老王/赵铁柱 等） */
export function looksLikePerson(name) {
  const core = String(name || '').replace(/[（(][^）)]+[）)]$/, '').trim();
  if (!core) return false;
  if (NON_PERSON_SUFFIX.test(core)) return false;
  // 明确人物后缀（身份/称谓）→ 是角色
  if (/(杂役|弟子|长老|师傅|师父|师叔|师兄|师姐|掌柜|伙计|郎中|道人|和尚|护卫|管家|仆人|丫鬟|乞丐|农户|猎户|捕快|书吏|役丁|执事|管事|头目|帮主|寨主|庄主|夫人|小姐|公子|少侠|姑娘|老者|青年|少年|大汉|胖子|瘦子|瞎子|哑巴|瘸子|商贩|货郎|先生|大夫|药童)$/.test(core)) return true;
  // 排行昵称（老幺/小二/阿福/阿三/老张/阿贵）——"阿X"几乎总是人名；"老/小+姓氏或排行"是人名
  if (PERSON_NICK_RE.test(core)) return true;
  if (core.length === 2 && core[0] === '阿') return true;
  if (core.length === 2 && (core[0] === '老' || core[0] === '小') && SURNAME_RE.test(core[1])) return true;
  // 姓氏 + 名（赵铁柱/孙伯/李尘/王瘸子）——姓氏开头且整体 2-4 字
  return SURNAME_RE.test(core.slice(0, 1)) && core.length >= 2 && core.length <= 4;
}

/**
 * 自动整理待登记实体（章结算后调用或手动触发）。
 * V0.78 修复：①"（身份）"后缀优先按角色（不再因"书"等单字误判物品）；
 * ②重复出现（dup_count≥2）是活角色强信号 → 建角色卡；③无法推断且名字像人物 → 默认角色；
 * ④不再仅凭"无法推断"就归档——先默认角色，只有确属地点/物品/势力的才按类型。
 * @returns {{confirmed:number, migrated:number, archived:number, kept:number, registered:number}}
 */
export function tidyPendingEntities(bookId, { currentChapter = 999999, staleAfter = 8 } = {}) {
  const stats = { confirmed: 0, migrated: 0, archived: 0, kept: 0, registered: 0 };
  const pending = store.pendingEntities.list(bookId);
  if (!pending.length) return stats;

  // 各卡表已存在名字集合
  const cardNames = new Set();
  for (const kind of ['characters', 'locations', 'items', 'factions']) {
    for (const e of store[kind].list(bookId)) cardNames.add(e.name);
  }

  for (const p of pending) {
    const name = (p.name || '').trim();
    if (!name) { store.pendingEntities.resolve(p.id, 'invalid'); continue; }

    // ① 已登记去重（名字已存在于任一卡表）——不计入建卡统计
    if (cardNames.has(name)) {
      store.pendingEntities.markResolved(p.id, 'already_registered', '已存在于卡表');
      stats.registered++;
      continue;
    }

    // V0.93.8：settle 占位标记名（"X（提及）/X（待具名）"）不转正——占位名顶替真名曾污染角色库
    // （实测"贾似道（提及）"转正建卡后 roster 合并吞掉真"贾似道"卡）。保留 pending 等待具名，
    // 若后续章模型以真名上报则正常转正；久未具名的由超期归档机制回收。
    if (/[（(](?:提及|待具名|占位|未具名)[）)]/.test(name)) {
      stats.kept++;
      continue;
    }

    // ② 类型推断 → 建对应卡（V0.78：剥后缀后判断）
    let type = inferEntityType(name, p.context);
    // V0.78：名字像人物称谓（老幺/小二）且词表未命中 → 默认角色；重复出现≥2 → 活角色强信号
    if (!type && (looksLikePerson(name) || (p.dup_count || 0) >= 2)) {
      type = 'character';
    }
    const kind = type ? KIND_MAP[type] : null;
    if (kind) {
      // V0.93.5：建卡时写入章节锚点（此前 first/last_chapter 为 null，新角色与剧情脱节）
      store[kind].create(bookId, {
        name,
        firstChapter: p.source_chapter || undefined,
        card: { note: (p.context || '').slice(0, 300), sourceChapter: p.source_chapter, autoConfirmed: true },
      });
      const nc = store[kind].list(bookId).find(e => e.name === name);
      if (nc && p.source_chapter) store[kind].update(nc.id, { lastChapter: p.source_chapter });
      cardNames.add(name);
      store.pendingEntities.markResolved(p.id, `${type}_auto`, `自动登记为${type}${(p.dup_count || 1) > 1 ? `（出现${p.dup_count}次）` : ''}`);
      stats.confirmed++;
      continue;
    }

    // ③ 超期归档：距首次出现超过 staleAfter 章且无法推断类型 → 弱信号归档（保留记录）
    // V0.78：仅当"手动整理误传大章号"时保护——正常结算 currentChapter 是真实进度，
    // 但名字像人物/重复出现的已在 ② 处理；此处仅归档确属概念/一次性且长期未再出现的。
    if (currentChapter - (p.source_chapter || 0) > staleAfter) {
      store.pendingEntities.markResolved(p.id, 'stale_archived', '多章未再出现且无法归类，已自动归档');
      stats.archived++;
      continue;
    }

    // ④ 保留观察（概念类或信号不足）
    stats.kept++;
  }
  return stats;
}

/**
 * V0.40：修复历史误建——autoConfirmed 角色卡但名字/上下文明显是地点/物品/势力的，迁移到正确卡表。
 * （V0.30 曾把二次出现的任意实体无条件建成角色卡）
 * @returns {number} 迁移数量
 */
export function migrateMisplacedCharacters(bookId) {
  let migrated = 0;
  const chars = store.characters.list(bookId);
  for (const c of chars) {
    let card = {};
    try { card = JSON.parse(c.card_json || '{}'); } catch { card = {}; }
    if (!card.autoConfirmed) continue; // 只处理自动确认的卡
    const type = inferEntityType(c.name, card.note || '');
    if (!type || type === 'character') continue;
    // 迁移：建正确卡 + 删角色卡
    const kind = KIND_MAP[type];
    if (!store[kind].list(bookId).some(e => e.name === c.name)) {
      store[kind].create(bookId, { name: c.name, card: { note: card.note || '', sourceChapter: card.sourceChapter, migratedFrom: 'character' } });
    }
    store.characters.remove(c.id);
    migrated++;
  }
  return migrated;
}
