// server/engine/narrative/history.js —— V0.81/V0.82 历史题材考据引擎
// 职责：①era_context 时代背景卡生成（幂等，落 materials('era_context')，不进公共前缀；V0.82 朝代可配置）
//      ②eraContextText 按 scope 裁剪注入（防字典式堆砌）③poetryForScene 零LLM选词（诗词融入）
//      ④eraRedLineCheck 零LLM时代红线扫描 ⑤detectHistoryMarkers 历史去AI味 ⑥historySettingsRequirements
//      V0.82 新增：⑦seedForBook 朝代种子选择 ⑧seedEraEvents 史实锚点落库 ⑨historyNamingRules 取名/避讳
//      ⑩eraWorldbookEntries 时代元素词条化（持久注入）⑪eraBoundaryText 史实边界注入
'use strict';
import * as store from '../../db/store.js';
import { runTask } from '../../llm/router.js';
import { assembleMessages } from '../../llm/cache.js';
import { eraContextInstruction } from '../prompts.js';
import { extractJSON } from '../../util/json.js';
import { genrePack } from '../../data/creative_packs.js';
import {
  HISTORY_METHODOLOGY, SONG_MO_SEED, CUSTOM_ERA_TEMPLATE, DYNASTY_DICTIONARY, RED_LINES,
  POETRY_LIB, POETRY_DISCIPLINE, HISTORY_DEAI_TEXT, HISTORICAL_FIGURES, historicalFiguresInWindow,
} from '../../data/history.js';

export function isHistory(genre) {
  return genre === '历史';
}

/** V0.82：解析 books.era 朝代配置（JSON 或宽松文本），返回 {dynasty,name,years,eraLine,seed} */
export function parseEraConfig(book) {
  if (!book || !book.era) return {};
  if (typeof book.era === 'object') return book.era;
  try {
    const p = JSON.parse(book.era);
    return p && typeof p === 'object' ? p : {};
  } catch { /* 非 JSON：宽松文本 → 按 key:value 行解析 */ }
  const out = {};
  for (const line of String(book.era).split('\n')) {
    const m = line.match(/^(dynasty|朝代|name|年代|years|年份|eraLine|年号|seed|考据|要点)[：:]\s*(.+)$/);
    if (m) {
      const k = { dynasty: 'dynasty', 朝代: 'dynasty', name: 'name', 年代: 'name', years: 'years', 年份: 'years', eraLine: 'eraLine', 年号: 'eraLine', seed: 'seed', 考据: 'seed', 要点: 'seed' }[m[1]];
      out[k] = m[2].trim();
    }
  }
  return out;
}

/** V0.82：选朝代考据种子——有内置宋末包则用之；自定义朝代用模板+用户要点 */
export function seedForBook(book) {
  const cfg = parseEraConfig(book);
 const isHistoricalEra = !cfg || (!cfg.dynasty && !cfg.name) || /宋|宋末|南宋/.test(`${cfg.dynasty || ''}${cfg.name || ''}`);
 if (isHistoricalEra && !cfg.seed) {
    return {
      era: SONG_MO_SEED.era,
      seed: JSON.stringify(SONG_MO_SEED, null, 1).slice(0, 2500),
      label: '宋末（内置考据包）',
    };
  }
  // 自定义朝代：模板 + 用户考据要点
  const tmpl = {
    ...CUSTOM_ERA_TEMPLATE,
    era: (CUSTOM_ERA_TEMPLATE.era || '').replace('{{name}}', cfg.name || cfg.dynasty || '自定义').replace('{{years}}', cfg.years || cfg.eraLine || '年份未指定'),
    note: CUSTOM_ERA_TEMPLATE.note,
    user_seed: cfg.seed || '',
  };
  const userBlock = cfg.seed ? `\n【用户指定考据要点（最高优先级，不得冲突）】\n${String(cfg.seed).slice(0, 1200)}` : '';
  return {
    era: tmpl.era,
    seed: JSON.stringify(tmpl, null, 1).slice(0, 1500) + userBlock,
    label: `${cfg.name || cfg.dynasty || '自定义朝代'}（用户配置）`,
  };
}

/** V0.88：是否宋末书（内置考据包适用）——V0.87/0.88 硬编码锚点（宋蒙战争/南宋朝堂）仅注入宋末书；
 *  自定义朝代书只注通用纪律，不注宋制史实段与硬编码锚点（防"本时代"标签误导模型当朝事实） */
export function isHistoricalEraBook(book) {
  if (!book) return false;
  const cfg = parseEraConfig(book);
  return !cfg || (!cfg.dynasty && !cfg.name) || /宋|宋末|南宋/.test(`${cfg.dynasty || ''}${cfg.name || ''}`);
}

/** 幂等生成 era_context 时代背景卡（已存在跳过；失败软降级不抛错；V0.82 朝代可配置） */
export async function ensureEraContext(bookId, { onEvent, signal, force = false } = {}) {
  const book = store.books.get(bookId);
  if (!book || !isHistory(book.genre)) return { ok: false, skipped: true };
  if (!force && store.materials.get(bookId, 'era_context')?.content) return { ok: true, skipped: true };
  try {
    const sel = seedForBook(book);
    const res = await runTask({
      bookId, task: 'era_context', jsonMode: true, signal,
      messages: assembleMessages(bookId, [{
        role: 'user',
        content: eraContextInstruction({ bookTitle: book.title, genre: book.genre, era: sel.era, seed: sel.seed }),
      }]),
    });
    const parsed = extractJSON(res.content);
    if (!parsed || !parsed.era) return { ok: false, error: '时代背景卡解析失败' };
    const text = formatEraContext(parsed);
    store.materials.set(bookId, 'era_context', text);
    // V0.82：史实事件锚点结构化落库（供"已过/未到史实节点"边界注入）
    try { seedEraEvents(bookId, parsed); } catch { /* 锚点落库失败不阻断 */ }
    // V0.93.10：历史人物档案结构化落库（供"人物登场窗"逐卷注入与人物级时间校验）
    try { seedHistoricalFigures(bookId, parsed); } catch { /* 人物档案落库失败不阻断 */ }
    // V0.82：时代元素词条化进世界书（官职/军制/地理/经济/礼法按关键词触发持久注入）
    try { seedEraWorldbook(bookId, parsed); } catch { /* 词条化失败不阻断 */ }
    onEvent?.({ type: 'stage', stage: 'setup', message: `历史时代背景卡完成（${sel.label}：史实锚点/官职/地理/时代红线）` });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** V0.82：real_events → era_events 表（幂等：先清后写） */
export function seedEraEvents(bookId, parsed) {
  const events = Array.isArray(parsed.real_events) ? parsed.real_events : [];
  if (!events.length) return;
  const yearRe = /(1[0-9]{3})年/;
  store.eraEvents.clear(bookId);
  for (const raw of events) {
    const s = String(raw || '').trim();
    if (!s) continue;
    // 尝试抽取"1242年"年份；无则留空（边界注入按年排序时靠后）
    const ym = s.match(yearRe);
    store.eraEvents.add(bookId, { year: ym ? Number(ym[1]) : null, eraYear: '', event: s });
  }
}

/** V0.93.10：era_context.figures → historical_figures 表（幂等：先清后写）——
 *  开新历史书时模型按 eraContextInstruction 自动产出人物档案（登场窗/官职/立场/结局），
 *  写作/细纲/校验全程从表读，任何题材自动可用，不依赖内置种子。 */
export function seedHistoricalFigures(bookId, parsed) {
  const figures = Array.isArray(parsed.figures) ? parsed.figures : [];
  if (!figures.length) return;
  store.historicalFigures.clear(bookId);
  for (const f of figures) {
    store.historicalFigures.add(bookId, {
      name: f.name || '', aliases: Array.isArray(f.aliases) ? f.aliases : [],
      firstYear: f.firstYear != null ? Number(f.firstYear) : null,
      deathYear: f.deathYear != null ? Number(f.deathYear) : null,
      office: f.office || '', stance: f.stance || '', constraint: f.constraint || '', alterable: f.alterable || '',
    });
  }
}

/** V0.93.10：读取人物档案（DB 优先——era_context 自动产出；无则内置种子兜底）。
 *  @returns {Array<{name,aliases,first_year,death_year,office,stance,constraint,alterable}>} */
export function historicalFiguresFor(bookId, { startYear, endYear, limit = 10 } = {}) {
  const fromDb = store.historicalFigures.list(bookId || '');
  const figures = fromDb.length ? fromDb.map(f => ({ ...f, firstYear: f.first_year, deathYear: f.death_year })) : HISTORICAL_FIGURES;
  if (startYear == null && endYear == null) return figures;
  return historicalFiguresInWindow(figures, { startYear, endYear, limit });
}

/** V0.82：era_context 各段拆成世界书词条（关键词触发，随场景持续注入——解决"50章后历史细节淡出"）
 *  关键词从官职/地理/礼法/经济段中提取代表性专名；已存在同名词条跳过 */
export function seedEraWorldbook(bookId, parsed) {
  const entries = [
    { cat: '官职', kw: ['宰执', '枢密使', '三衙', '制置使', '宣抚使', '都统制', '安抚使', '知州', '通判', '县尉', '提刑', '转运使', '殿前司', '总领'], text: parsed.offices },
    { cat: '军制', kw: ['御前诸军', '禁军', '厢军', '乡兵', '义军', '招刺', '山城', '堡寨', '都统制', '怯薛', '探马赤', '万户', '百户', '震天雷', '突火枪', '步人甲'], text: parsed.military },
    { cat: '地理', kw: ['钓鱼城', '夔门', '大散关', '剑门', '襄阳', '鄂州', '两淮', '临安', '重庆', '合州', '泸州', '三江', '行在', '制置司', '京湖'], text: parsed.geography },
    { cat: '经济', kw: ['会子', '铜钱', '折帛', '身丁钱', '盐酒专卖', '米价', '漕运', '榷场'], text: parsed.economy },
    { cat: '礼法', kw: ['避讳', '官家', '相公', '官人', '兄台', '科举', '同年', '座主', '门生', '守制', '丁忧', '点茶', '冬至'], text: parsed.ritual },
  ];
  for (const e of entries) {
    if (!e.text) continue;
    const existing = store.worldbook.list(bookId) || [];
    if (existing.some(w => (JSON.parse(w.keywords || '[]') || []).some(k => e.kw.includes(k)))) continue;
    store.worldbook.create(bookId, {
      keywords: e.kw, content: `【${e.cat}·时代考据】${String(e.text).slice(0, 300)}`, priority: 5, category: e.cat,
    });
  }
}

/** era_context → 注入文本（按 scope 裁剪，防字典式堆砌） */
export function formatEraContext(p) {
  const lines = [`【时代】${p.era || ''}`];
  if (Array.isArray(p.real_events) && p.real_events.length) lines.push(`【史实骨架】${p.real_events.join('；')}`);
  if (p.offices) lines.push(`【官职】${p.offices}`);
  if (p.military) lines.push(`【军制】${p.military}`);
  if (p.geography) lines.push(`【地理】${p.geography}`);
  if (p.economy) lines.push(`【经济】${p.economy}`);
  if (p.ritual) lines.push(`【礼法】${p.ritual}`);
  if (Array.isArray(p.red_lines) && p.red_lines.length) lines.push(`【时代红线】${p.red_lines.join('；')}`);
  if (p.alterable_history) lines.push(`【可改史点】${p.alterable_history}`);
  return lines.join('\n');
}

/** 读 era_context 材料，按 scope 裁剪（volume≤800字 / chapter≤300字红线节选） */
export function eraContextText(bookId, { scope = 'general', maxChars = 800 } = {}) {
  const content = store.materials.get(bookId, 'era_context')?.content || '';
  if (!content) return '';
  if (scope === 'chapter') {
    // 章节级只取时代红线 + 可改史点（防每章重复塞考据）
    const parts = [];
    const red = content.match(/【时代红线】[^\n]*/);
    const alt = content.match(/【可改史点】[^\n]*/);
    if (red) parts.push(red[0]);
    if (alt) parts.push(alt[0]);
    return parts.join('\n').slice(0, maxChars);
  }
  return content.slice(0, maxChars);
}

/** 场景→诗词候选（零 LLM；按 scene_type + beat 关键词匹配 tags） */
const SCENE_TAG = {
  fight: ['沙场', '北伐', '壮词', '忠义'],
  emotion: ['送别', '凭吊', '忠义', '夜'],
  climax: ['北伐', '壮词', '亡国', '沙场'],
  daily: ['江南', '西湖', '闲愁'],
  reveal: ['凭吊', '故国', '遗民', '亡国'],
  suspense: ['登高', '夜', '壮志未酬'],
  dialogue: ['忠义', '北伐'],
  kill: ['沙场', '北伐'],
  siege: ['亡国', '沙场', '忠义'],
};
const BEAT_TAG = [
  [/城破|陷落|失守|灭国|崖山/, '亡国'],
  [/出征|誓师|北伐|渡江|提兵/, '出征'],
  [/送别|离别|辞行|饯行/, '送别'],
  [/暮年|白发|老将|垂暮/, '暮年'],
  [/忠义|殉国|就义|捐躯/, '忠义'],
  [/凭吊|祭|坟|灵前/, '凭吊'],
  [/夜|灯|秋|月|漏/, '夜'],
  [/登高|城头|北固|楼/, '登高'],
  [/遗民|遗老|中原/, '遗民'],
  [/临安|西湖|江南|行在/, '临安'],
];
export function poetryForScene(beat = '', sceneType = '', max = 2) {
  const tags = new Set(SCENE_TAG[sceneType] || []);
  const b = beat || '';
  for (const [re, tag] of BEAT_TAG) { if (re.test(b)) tags.add(tag); }
  if (!tags.size) return { poems: [], discipline: '' };
  const scored = POETRY_LIB
    .map(p => ({ p, hit: p.tags.filter(t => tags.has(t)).length }))
    .filter(x => x.hit > 0)
    .sort((a, b) => b.hit - a.hit);
  const poems = scored.slice(0, max).map(x => x.p);
  return {
    poems,
    discipline: POETRY_DISCIPLINE,
    text: poems.length ? `【可化用诗词（关键节点情感点睛，契合人物心境再化用）】
${poems.map(p => `- ${p.author}《${p.source.replace(/《|》/g, '')}》：${p.line}（${p.meaning}）`).join('\n')}
${POETRY_DISCIPLINE}` : '',
  };
}

/** 时代红线扫描（零 LLM）：返回命中时代错误的问题列表
 *  V0.97：支持 allow 白名单（逐次命中判定）——如「大人」的成人名词义（一个大人/骑在大人脖子上）
 *  放行，称呼官员仍拦。某次命中前后窗口匹配 allow 则该次不计；所有命中均被豁免才不上报。 */
export function eraRedLineCheck(text) {
  if (!text) return [];
  const hits = [];
  for (const r of RED_LINES) {
    if (!text.includes(r.term)) continue;
    if (!r.allow) { hits.push(r); continue; }
    let idx = 0, real = 0;
    while ((idx = text.indexOf(r.term, idx)) >= 0) {
      const win = text.slice(Math.max(0, idx - 8), idx + r.term.length + 8);
      if (!r.allow.test(win)) real++;
      idx += r.term.length;
    }
    if (real > 0) hits.push(r);
  }
  return hits;
}

/** 历史去AI味本地检测（现代词密度 / 圣母化 / 历史人物降智） */
export function detectHistoryMarkers(text) {
  const issues = [];
  if (!text) return issues;
  // 现代词（穿越感）
  const modernWords = ['格局打开', '提升效率', '做好复盘', '内卷', '躺平', '职场', '复盘', '闭环', '赋能', '底层逻辑', '情绪价值'];
  const modernHits = modernWords.filter(w => text.includes(w));
  if (modernHits.length >= 1) {
    issues.push({ type: '剧情AI味', severity: 'low', quote: text.slice(0, 40) + '…', issue: `出现现代词（${modernHits.join('、')}）——历史人物视角不应有现代思维`, fix: '改为当时人的说法' });
  }
  // 圣母化（主角无代价的仁）
  if (/他不忍心|他不愿伤|放过他们吧|以德报怨/g.test(text)) {
    issues.push({ type: '剧情AI味', severity: 'low', quote: text.slice(0, 40) + '…', issue: '主角圣母化倾向（无代价的仁）——历史乱世需做取舍', fix: '让主角的仁有代价、有纠结' });
  }
  // V0.82：历史人物降智软信号（"纳头便拜/痛哭流涕/跪地求饶"式臣服与"高瞻远瞩/佩服得五体投地"式吹捧）
  if (/纳头便拜|佩服得五体投地|高瞻远瞩.*(主角|公子|将军|大人)|一见面就.*拜服|痛哭流涕.*(主公|恩公)/g.test(text)) {
    issues.push({ type: '历史人物降智', severity: 'low', quote: text.slice(0, 40) + '…', issue: '历史人物工具化（见面即拜服/主角崇拜者）——历史文信任要挣不能白送', fix: '让真实历史人物保留立场与盘算，信任靠事件逐步挣得' });
  }
  // V0.82：无代价胜利软信号（"不费吹灰之力/兵不血刃/轻而易举"式胜利）
  if (/不费吹灰之力|兵不血刃|轻而易举.{0,10}(拿下|击退|取胜)|毫无损伤/g.test(text)) {
    issues.push({ type: '无代价胜利', severity: 'low', quote: text.slice(0, 40) + '…', issue: '胜利无代价——历史文的爽是"有代价的胜利"，读者最恨又爽又空', fix: '给胜利补代价（伤亡/粮草/政治妥协/时间成本）' });
  }
  return issues;
}

/** V0.82：史实边界注入（写正文/细纲时提示"已过节点不可改前因/未到节点不得提前"） */
export function eraBoundaryText(bookId, currentYear) {
  const boundary = store.eraEvents.boundaryText(bookId, currentYear);
  if (!boundary) return '';
  return `【史实边界】（硬约束）
${boundary}
- 已过史实节点的"后果"可被主角改变（架空改写），但既已发生的"前因"不得改写；未到节点不得提前发生。`;
}

/** V0.82：当前故事年份估算——timeline 最近一条带 year 的事件；无则用 era_events 最早年份（主角起点） */
export function currentStoryYear(bookId) {
  try {
    const tl = store.timeline.list(bookId) || [];
    for (let i = tl.length - 1; i >= 0; i--) {
      if (tl[i]?.year) return Number(tl[i].year);
    }
    const evs = store.eraEvents.list(bookId) || [];
    const years = evs.map(e => e.year).filter(Boolean).sort((a, b) => a - b);
    if (years.length) return years[0];
  } catch { /* ignore */ }
  return null;
}

/** V0.82：本地纪年抽取（零 LLM）——从事件文本提取 公元年/年号纪年/季节，供 timeline 落库 */
export function extractEraMarkers(text) {
  const out = { year: null, eraYear: '', season: '' };
  if (!text) return out;
  const ym = String(text).match(/(1[0-9]{3})年/);
  if (ym) out.year = Number(ym[1]);
  const em = String(text).match(/([元一二三四五六七八九十百零\d]+)年/);
  if (em && /[元一二三四五六七八九十百零\d]/.test(em[1])) out.eraYear = `${em[0]}`;
  const sm = String(text).match(/(春|夏|秋|冬)(?:天|日|季)?/);
  if (sm) out.season = `${sm[1]}季`;
  return out;
}

/** V0.82：历史题材取名/避讳规则（注入书契约与设定人物卡生成；防现代感/异代感名字） */
export function historyNamingRules() {
  return `【历史人物取名/避讳规则】（硬要求，决定历史质感）
1. 取名符合本时代习惯：宋人以单名/双名为主，重字辈与宗族谱系（兄弟同辈分字），身份用字贴合（武将名带"坚/复/贵/德"、文臣带"文/正/修/泽"等），禁现代感/西方感/言情玛丽苏式名字。
2. 避讳在位官家名讳：主角与宋人不得以"赵昀"等本朝皇帝全名直呼（写作时可用"官家/今上/御讳"），真实历史人物按史实名号使用。
3. 真实历史人物一律用其本名/官职/封号（如"余玠、王坚、蒙哥、贾似道"），不得虚构改名；主角若与历史人物重名须规避。
4. 成年男子可有表字（字与名义相关，如"字子厚"），称呼上平辈互称表字、尊长称名，体现礼法关系网。
5. 蒙古人物名用蒙古语汉译风格（合撒儿/术赤/拔都式，非汉族名字）。`;
}

/** V0.82：AI 角色取名（历史题材注入命名/避讳规则；复用 book_title 路由，temperature 0.9 高发散适合起名）
 *  @returns {Promise<{ok:boolean, names:string[], error?:string}>} */
export async function generateCharacterNames(bookId, { hint = '', count = 5, gender = '', isHistory } = {}) {
  try {
    const book = store.books.get(bookId);
    const hist = isHistory ?? isHistoryGenre(book);
    const seed = hist ? historyNamingRules() : '';
    const genderLine = gender ? `（${gender}）` : '';
    const hintLine = hint ? `参考：${hint}` : '';
    const res = await runTask({
      bookId, task: 'book_title', jsonMode: true,
      messages: assembleMessages(bookId, [{
        role: 'user',
        content: `你是小说角色起名专家。请为《${book?.title || '未命名'}》${hist ? '（历史题材）' : ''}生成 ${count} 个${genderLine}角色名，彼此不重复、不与真实历史人物重名。
${hintLine}
${seed || '要求：符合题材语境、有辨识度、不玛丽苏不中二。'}
请输出 JSON：{ "names": ["候选名1", "候选名2", "候选名3"] }
只输出 JSON。`,
      }]),
    });
    const out = extractJSON(res.content);
    const names = Array.isArray(out?.names) ? out.names.map(n => String(n).trim()).filter(Boolean).slice(0, count) : [];
    if (!names.length) return { ok: false, error: '起名解析失败' };
    return { ok: true, names };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function isHistoryGenre(book) {
  return book?.genre === '历史';
}

/** 历史设定生成要求（settingsInstruction 注入段；V0.82 含命名/避讳规则） */
export function historySettingsRequirements() {
  return `${HISTORY_METHODOLOGY}

${historyNamingRules()}

【本时代参考】
官职：${DYNASTY_DICTIONARY.offices}
军制：${DYNASTY_DICTIONARY.military}
地理雅称：${DYNASTY_DICTIONARY.placeAliases}
生活器物：${DYNASTY_DICTIONARY.artifacts}；${DYNASTY_DICTIONARY.life}
称谓礼法（宋）：官家/相公/官人/兄台/某·仆·在下；禁以"大人"称呼官员（那是父辈称呼）
时代红线（绝无）：${RED_LINES.slice(0, 14).map(r => r.term).join('、')}等`;
}

/** 史实骨架文本（书纲注入：大框架符合史实+主角改史） */
export function historyAnchorsText() {
  return `【史实锚定】（V0.81 硬要求）
- 大框架按真实史实时间线：重要事件/真实人物（如南宋末余玠、王坚、蒙哥、贾似道等）按史实出现，不凭空消失、不因果倒置。
- 主角可改"后果"不可改"前因"：主角的行动可以改变历史走向（如蒙哥之死后的局势），但既已发生的史实（如端平入洛、蜀中残破）不得改写。
- 真实人物智商在线、有立场有盘算，不做工具人。
- 这是"史实骨架 + 主角改史"：主线在真实历史骨架上展开，主角靠权谋/军功/人心改写后果。`;
}

/** 历史成长注（卷大纲注入：允许蛰伏卷/跃升卷交替，不强制每卷升官） */
export function historyGrowthNote() {
  return `【历史成长节奏】（V0.81 允许波动）
- 主角成长维度是${genrePack('历史')?.growthSystem?.dimension || '官位/军功/统兵'}：白身→小校/都头→守将/寨主→路级统帅/都统制→一方统帅/制置使→执掌天下兵。
- 不强制每卷升官：允许"蛰伏卷"（蓄力/布局/攒军功/收人脉，可 10-20 章不擢升，期间每 3-5 章有暗线推进）与"跃升卷"（战功或权谋翻盘）交替。
- 每卷至少 1 个实质变化：官位跃迁 OR 军功积累 OR 挫折转折（贬黜/败仗）OR 暗线布局，四者其一即可。
- 南宋官场水深：主角可被贬/被构陷/短暂蛰伏（扮猪吃老虎是爽点），但每卷末尾要给出路或转机。`;
}
