// server/engine/names.js —— V0.83 角色名字质量校验（共享纯函数）
// 治本：结算抽取（settle.js）此前对 character_updates / new_entities 任意 name 直接建卡——
// "灰衣人/神秘人/老者/那道身影"等占位名与"掌柜的/大师兄"等称谓名稳定进入角色库（旧书取名失败路径）。
// 职责：①isPlaceholderName 占位名黑名单 ②isSaneName 常规名合法性 ③历史题材避讳/时代感校验
// ④entityNamePlausible 实体类型名合理性（V0.93.11：location/faction/item 建卡前本地类型门，
//   与 maintenance/doctor.js 的 suspiciousEntity 检测共用同一词表——写审同源）。
'use strict';

// 占位名/无名指代（结算抽取与待登记整理都应拒收，改走 pending 或归档）
const PLACEHOLDER_PAT = /(灰衣人|黑衣人|白衣人|神秘人|神秘客|神秘男子|神秘女子|神秘老者|蒙面人|蒙面客|某(?:人|男子|女子|老者)|那道身影|那道影子|一个(?:人|男子|女子|老者|少年|青年)|陌生人|路人|过客|来客|异人|怪人|那人|此人|众人|旁人|周围人|旁观者|围观者|信使|传令兵|无名|无名氏|神秘存在|守门人|看门人|车夫|船夫|轿夫|更夫|厨子|下人|伙计|丫鬟|侍女|仆人|管家|掌柜的|老板|老板娘|小二|大师兄|二师兄|小师妹|长老|掌门|宗主|教主|帮主|寨主|庄主|大夫|郎中|先生|小姐|公子|少爷|夫人|太太|老者|老翁|老妪|老妇|青年|少年|少女|孩童|小孩|汉子|壮汉|大汉|胖子|瘦子|瞎子|聋子|哑巴|瘸子|乞丐|捕快|衙役|士兵|兵卒|将军|元帅|大人|官人|老爷)/;
// 现代感/玛丽苏/中二名特征（历史题材尤其敏感；一般题材也适用）
const MODERN_NAME_PAT = /(南宫|轩辕|慕容|上官|东方|西门|欧阳|独孤|令狐|花泽|冷|夜|帝|修罗|死神|天使|恶魔|龙傲天|赵日天|叶良辰|苏菲|安妮|杰克|玛丽|艾米|凯特|约翰|麦克|史密斯|约翰逊)/;
// 身份后缀（"掌柜的/大师兄/灰衣人"等结尾 = 称谓而非真名）
const IDENTITY_SUFFIX = /(的|兄|姐|弟|妹|师|老|爷|娘|婆|人|者|生|汉|子|女|童|工|卒|兵|丁)$/;

// ---------- V0.93.11 实体类型名合理性词表（写审同源：settle 建卡门 = doctor 检测门） ----------
// 词表语义：某类型的实体名若命中"像另一种东西"的模式，判定为模型自报错类。
// locations 名不应像物品/语句；factions 名不应像地点/物品；items 名不应像人物/抽象事实。
const ENTITY_TYPE_PATTERNS = Object.freeze({
  // 应报为"像物品或语句"的地点名（"另一把活钥/守碑人手札/烛火不熄，源头在石下"等）
  locationsAsItem: /(手札|笔记|兽皮纸|薄片|钥匙|瓶|玉片|碎块|图谱|口令|另一把|第[一二三四五六七八九十\d]+代传)/,
  // 应报为"像地点或物品"的势力名（"旧阵基石门"等）
  factionsAsObject: /(石门|铁门|铜门|门槛|碎块|横线|钥匙|腰牌|骨片|石碑|镜面|粉末)/,
  // 应报为"像人物/群体或抽象事实"的物品名
  itemsAsPerson: /(守印人|人影|追兵|追捕者|鞋印|脚印|足迹|指印|方向|关系|势力|线索)/,
  // 短语化名称（含标点、超长）——任何类型都不该是完整句子/短语
  phraseLike: /[，。；：！？]/u,
});

/** 实体名长度上限（超长多半是描述短语而非名称） */
export const ENTITY_NAME_MAX_LEN = 24;

/**
 * V0.93.11 实体类型名合理性（纯函数）：模型在结算中自报 type=location/faction/item 的实体，
 * 建卡前先过本地类型门——名字明显是另一种东西（物品/地点/人物/短语）时不建卡。
 * @param {'locations'|'factions'|'items'} kind
 * @param {string} name
 * @returns {string[]} 违规原因列表（空数组 = 通过）
 */
export function entityNamePlausible(kind, name) {
  const value = String(name || '').trim();
  const reasons = [];
  if (!value) reasons.push('empty_name');
  if (ENTITY_TYPE_PATTERNS.phraseLike.test(value) || value.length > ENTITY_NAME_MAX_LEN) reasons.push('phrase_like_name');
  if (kind === 'locations' && ENTITY_TYPE_PATTERNS.locationsAsItem.test(value)) reasons.push('looks_like_item_or_statement');
  if (kind === 'factions' && ENTITY_TYPE_PATTERNS.factionsAsObject.test(value)) reasons.push('looks_like_object_or_location');
  if (kind === 'items' && ENTITY_TYPE_PATTERNS.itemsAsPerson.test(value)) reasons.push('looks_like_person_group_or_abstract_fact');
  return reasons;
}

/** 占位名/称谓名（结算抽取时不应建卡，进 pending 等待人工或后续具名） */
export function isPlaceholderName(name) {
  const n = String(name || '').trim();
  if (!n) return true;
  return PLACEHOLDER_PAT.test(n);
}

/** 常规名合法性：2-5 字、非纯身份后缀、非占位、非现代/玛丽苏风格 */
export function isSaneName(name) {
  const n = String(name || '').trim();
  if (!n || isPlaceholderName(n)) return false;
  if (n.length < 2 || n.length > 5) return false;
  // 纯身份后缀结尾（"掌柜的""大师兄""灰衣人"）→ 非真名
  if (IDENTITY_SUFFIX.test(n) && !/^(?:赵|钱|孙|李|周|吴|郑|王|冯|陈|褚|卫|蒋|沈|韩|杨|朱|秦|尤|许|何|吕|施|张|孔|曹|严|华|金|魏|陶|姜|戚|谢|邹|喻|柏|水|窦|章|云|苏|潘|葛|奚|范|彭|郎|鲁|韦|昌|马|苗|凤|花|方|俞|任|袁|柳|鲍|史|唐|费|廉|岑|薛|雷|贺|倪|汤|滕|殷|罗|毕|郝|邬|安|常|乐|于|时|傅|皮|卞|齐|康|伍|余|元|卜|顾|孟|平|黄|和|穆|萧|尹|姚|邵|湛|汪|祁|毛|禹|狄|米|贝|明|臧|计|伏|成|戴|谈|宋|茅|庞|熊|纪|舒|屈|项|祝|董|梁|杜|阮|蓝|闵|席|季|麻|强|贾|路|娄|危|江|童|颜|郭|梅|盛|林|刁|钟|徐|邱|骆|高|夏|蔡|田|樊|胡|凌|霍|虞|万|支|柯|昝|管|卢|莫|经|房|裘|缪|干|解|应|宗|丁|宣|贲|邓|郁|单|杭|洪|包|诸|左|石|崔|吉|钮|龚|程|嵇|邢|滑|裴|陆|荣|翁|荀|羊|於|惠|甄|曲|家|封|芮|羿|储|靳|汲|邴|糜|松|井|段|富|巫|乌|焦|巴|弓|牧|隗|山|谷|车|侯|宓|蓬|全|郗|班|仰|秋|仲|伊|宫|宁|仇|栾|暴|甘|钭|厉|戎|祖|武|符|刘|景|詹|束|龙|叶|幸|司|韶|郜|黎|蓟|薄|印|宿|白|怀|蒲|邰|从|鄂|索|咸|籍|赖|卓|蔺|屠|蒙|池|乔|阴|郁|胥|能|苍|双|闻|莘|党|翟|谭|贡|劳|逄|姬|申|扶|堵|冉|宰|郦|雍|却|璩|桑|桂|濮|牛|寿|通|边|扈|燕|冀|郏|浦|尚|农|温|别|庄|晏|柴|瞿|阎|充|慕|连|茹|习|宦|艾|鱼|容|向|古|易|慎|戈|廖|庾|终|暨|居|衡|步|都|耿|满|弘|匡|国|文|寇|广|禄|阙|东|欧|殳|沃|利|蔚|越|夔|隆|师|巩|厍|聂|晁|勾|敖|融|冷|訾|辛|阚|那|简|饶|空|曾|毋|沙|乜|养|鞠|须|丰|巢|关|蒯|相|查|后|荆|红|游|竺|权|逯|盖|益|桓|公|万俟|司马|上官|欧阳|夏侯|诸葛|闻人|东方|赫连|皇甫|尉迟|公羊|澹台|公冶|宗政|濮阳|淳于|单于|太叔|申屠|公孙|仲孙|轩辕|令狐|钟离|宇文|长孙|慕容|鲜于|闾丘|司徒|司空|亓官|司寇|仉督|子车|颛孙|端木|巫马|公西|漆雕|乐正|壤驷|公良|拓跋|夹谷|宰父|谷梁|晋楚|闫法|汝鄢|涂钦|段干|百里|东郭|南门|呼延|归海|羊舌|微生|岳帅|缑亢|况后|有琴|梁丘|左丘|东门|西门|商牟|佘佴|伯赏|南宫|墨哈|谯笪|年爱|阳佟|第五|言福)/.test(n.slice(0, 1))) {
    return false;
  }
  if (MODERN_NAME_PAT.test(n)) return false;
  return true;
}

/** 历史题材：名字含在位官家名讳 / 明显现代感 → 不合格（配合 historyNamingRules 使用） */
export function isHistorySaneName(name, { eraName = '' } = {}) {
  const n = String(name || '').trim();
  if (!isSaneName(n)) return false;
  // 避讳：与朝代名/年号/在位皇帝名直接重复（如"赵昀"直呼）——具体避讳字由 eraName 提供（可空）
  if (eraName && n.includes(eraName)) return false;
  // 现代网络语/西方名特征已由 MODERN_NAME_PAT 拦截
  return true;
}
