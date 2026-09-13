// V0.19 灵感提级（创意引擎）
// 定位：AI 本位——作者水平不足/想象力一般也没关系，AI 负责把平庸灵感升级成高概念。
// 能力：① 本地高概念种子库（零成本随机组合，不调 API）② LLM 灵感诊断与 3 个提级方案
//       ③ 书级概念评分门（契约生成后自动评分，低于阈值换方向重生成）
import * as store from '../../db/store.js';
import { runTask } from '../../llm/router.js';
import { assembleMessages } from '../../llm/cache.js';
import { ideaAmplifyInstruction, contractScoreInstruction, bookTitleInstruction } from '../prompts.js';
import { extractJSON } from '../../util/json.js';

// ---------- 本地高概念种子库（不调 API，零成本） ----------
const SEEDS = {
  // 身份 × 处境（读者代入锚点）
  identities: [
    '被废的剑宗弟子', '破产后送外卖的前总裁', '穿成炮灰的社畜', '被家族除名的炼丹师',
    '山村来的守墓人', '高考失利的高中生', '失业的中年程序员', '退役拳手转行当保安',
    '被退婚的赘婿', '图书馆管理员', '高考状元重生回高一', '外卖骑手捡到古董',
  ],
  // 金手指 / 奇遇（幻想满足）
  artifacts: [
    '会说话的玉佩', '签到就能变强的系统', '能看见未来的直播间', '残缺的藏宝图',
    '失忆者的记忆碎片', '好感度面板', '每天刷新一枚的复活币', '通往副本世界的钥匙',
    '能听懂万物声音的耳朵', '深夜十二点的神秘商城', '一盏可以许愿的油灯', '时间暂停的怀表',
  ],
  // 冲突 / 危机（连续驱动力）
  conflicts: [
    '宗门大比只剩三天', '家族夺权之夜', '仇家杀上门的清晨', '妖兽潮兵临城下',
    '未婚妻家族悔婚宴', '城市地底裂开深渊', '全世界只剩自己记得昨天', '一场席卷全国的灵气复苏',
    '藏在身边的叛徒', '师门灭门惨案的真凶', '期末考与灭世危机的二选一', '被通缉的替罪羊',
  ],
  // 悬念钩子（结尾钩子素材）
  hooks: [
    '而这一切，都指向一个被抹去的名字', '直到他发现，这场「意外」已经发生过十七次',
    '可没人知道，他捡到的那枚玉佩，曾属于千年前的剑神', '系统却说：你不是主角，你是系统本身',
    '而她站在城墙上，手里握着本该属于他的剑', '他笑了笑，把那张藏宝图撕成了两半',
  ],
};

const GENRE_TAGS = {
  玄幻: ['剑宗', '宗门', '炼丹', '妖兽', '灵气'],
  都市: ['总裁', '外卖', '高考', '程序员', '骑手', '保安'],
  科幻: ['系统', '直播间', '怀表', '外星', '深渊'],
  悬疑: ['藏宝图', '真凶', '替罪羊', '守墓人'],
  言情: ['退婚', '未婚妻', '赘婿', '婚宴'],
  历史: ['权臣', '朝堂', '将帅', '军功', '北伐', '边关', '科举', '宫变', '藩镇', '山河'],
  末世: ['妖兽潮', '灵气复苏', '深渊'],
  无限流: ['副本', '钥匙', '复活币', '直播间'],
};

/** 过滤：按题材偏好保留元素（题材未知则全保留） */
function pickByGenre(list, genre, n) {
  const tags = GENRE_TAGS[genre] || [];
  const scored = list.map((item, i) => {
    let score = 0;
    for (const t of tags) if (item.includes(t)) score += 2;
    score += Math.random(); // 轻微随机
    return { item, score, i };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, n).map(s => s.item);
}

/** 本地高概念种子生成（零成本）：随机组合身份×金手指×冲突×钩子 */
export function generateIdeaSeeds(genre = '', count = 5) {
  const identities = pickByGenre(SEEDS.identities, genre, 6);
  const artifacts = pickByGenre(SEEDS.artifacts, genre, 6);
  const conflicts = pickByGenre(SEEDS.conflicts, genre, 6);
  const hooks = [...SEEDS.hooks].sort(() => Math.random() - 0.5);
  const used = new Set();
  const seeds = [];
  let guard = 0;
  while (seeds.length < count && guard++ < 100) {
    const iden = identities[Math.floor(Math.random() * identities.length)];
    const art = artifacts[Math.floor(Math.random() * artifacts.length)];
    const conf = conflicts[Math.floor(Math.random() * conflicts.length)];
    const hook = hooks[seeds.length % hooks.length];
    const concept = `${iden}，在${art}的指引下卷入${conf}。${hook}。`;
    if (used.has(concept)) continue;
    used.add(concept);
    seeds.push({
      concept,
      identity: iden, artifact: art, conflict: conf, hook,
      why: `${conf}提供开篇即有的连续冲突；${art}是差异化的幻想支点；主角从${iden}出发，天然带代入与成长空间。`,
    });
  }
  return seeds;
}

/** LLM 灵感诊断与提级：产出评分 + 问题 + 3 个差异化提级方案（bookId 可选，新建作品前也可用） */
export async function amplifyIdea(bookId, { idea, genre, platform } = {}) {
  const book = bookId ? store.books.get(bookId) : null;
  const g = genre || book?.genre || '';
  const p = platform || book?.platform || '通用';
  const text = idea || book?.blurb || '';
  // V0.29：作品内调用走 assembleMessages 复用前缀；bookId 为空时保持裸调用
  const msgs = bookId
    ? assembleMessages(bookId, [{ role: 'user', content: ideaAmplifyInstruction({ idea: text, genre: g, platform: p }) }])
    : [{ role: 'user', content: ideaAmplifyInstruction({ idea: text, genre: g, platform: p }) }];
  const res = await runTask({ bookId, task: 'idea_amplify', jsonMode: true, messages: msgs });
  const out = extractJSON(res.content);
  if (!out || !Array.isArray(out.options)) return { ok: false, error: '提级解析失败，请重试' };
  // V0.25：kept_elements——从原灵感提取的作者锚点（核心元素守恒的可观测证据）
  return { ok: true, scores: out.scores || {}, total: out.total, verdict: out.verdict, issues: out.issues || [], options: out.options, goldenOpen: out.golden_open, inferred: out.inferred || null, keptElements: Array.isArray(out.kept_elements) ? out.kept_elements : [] };
}

/** 应用提级方案：写回 blurb（灵感），供契约/大纲生成使用 */
export function applyIdeaOption(bookId, { concept, hook, why } = {}) {
  const book = store.books.get(bookId);
  if (!book) return { ok: false, error: '作品不存在' };
  if (!concept) return { ok: false, error: '缺少 concept' };
  const ideaText = [concept, hook ? `钩子：${hook}` : '', why ? `设计思路：${why}` : ''].filter(Boolean).join('\n');
  store.books.update(book.id, { blurb: ideaText.slice(0, 500) });
  return { ok: true, blurb: ideaText };
}

/** 书级概念评分门：契约文本评分；低于阈值换方向重生成（最多 regenRounds 轮） */
export async function scoreContract(bookId, { onRound } = {}) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const contract = store.materials.get(bookId, 'contract')?.content || '';
  if (!contract) return { ok: false, error: '尚未生成书契约' };
  const res = await runTask({ bookId, task: 'contract_score', jsonMode: true, messages: assembleMessages(bookId, [
    { role: 'user', content: contractScoreInstruction({ bookTitle: book.title, genre: book.genre, contract }) },
  ]) });
  const out = extractJSON(res.content);
  if (!out || !out.total) return { ok: false, error: '评分解析失败' };
  onRound?.({ total: out.total, verdict: out.verdict });
  return { ok: true, scores: out.scores, total: Number(out.total), verdict: out.verdict, regenDirection: out.regen_direction };
}

/** AI 起名：根据灵感/题材生成书名（失败降级为'未命名'，不阻断流程） */
export async function generateBookTitle(bookId, { idea } = {}) {
  try {
    const book = store.books.get(bookId);
    const text = idea || book?.blurb || '';
    const res = await runTask({ bookId, task: 'book_title', jsonMode: true, messages: assembleMessages(bookId, [
      { role: 'user', content: bookTitleInstruction({ idea: text, genre: book?.genre || '' }) },
    ]) });
    const out = extractJSON(res.content);
    if (out?.title && out.title.trim()) return { ok: true, title: out.title.trim().slice(0, 30), subtitle: out.subtitle || '' };
    return { ok: false, error: '起名解析失败' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
