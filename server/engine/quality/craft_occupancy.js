// V0.105 发稿/中期占用轴：只点名近窗已占用项，形态可逆则本地愈合，禁止每章文学考卷。
'use strict';

import * as store from '../../db/store.js';
import { REDLINES } from '../../data/redlines.js';
import { isCompletedChapter } from '../pipeline/chapter_status.js';

export const CRAFT_AXES = [
  'name_bomb', 'identity_dump', 'dual_interior', 'connector_run',
  'long_sentence_streak', 'staircase', 'two_speaker_para', 'travel_ending',
];

export const CRAFT_BRIEF_MAX_CHARS = 900;
export const LEDGER_PEOPLE_CAP = 4;
export const LEDGER_PAYOFF_CAP = 4;
export const LEDGER_TIMELINE_CAP = 6;

const LAST_ONLY = new Set(['travel_ending', 'staircase', 'two_speaker_para']);

const HINTS = {
  name_bomb: '近章开篇已人名过密，本章前二百字只特写核心角色',
  identity_dump: '近章新人物未带身份，新出场用关系或职分一带而过',
  dual_interior: '近章已双人心想乱切，本章保持单一视角内心',
  connector_run: '近章连接词过密，少用因此、于是、所以硬接因果',
  long_sentence_streak: '近章连续长句，穿插短句换气',
  staircase: '近章碎段假排版，一句话能说清就不要拆成空段',
  two_speaker_para: '近章对白挤在同一段，换人说话就换段',
  travel_ending: '近章赶路空镜收束，本章收在变化、发现或下一步',
};

function connectorWords() {
  return REDLINES.connectorWords || ['因此', '于是', '所以'];
}

function countWord(src, word) {
  let n = 0;
  let idx = 0;
  while ((idx = src.indexOf(word, idx)) >= 0) {
    n += 1;
    idx += word.length;
  }
  return n;
}

function paragraphs(text) {
  return String(text || '').split(/\n+/).map(p => p.trim()).filter(Boolean);
}

export function craftHits(text, { rosterNames = [], firstAppearNames = [] } = {}) {
  const src = String(text || '');
  const hits = Object.fromEntries(CRAFT_AXES.map(axis => [axis, false]));
  if (!src.trim()) return hits;

  const names = (rosterNames || []).filter(n => String(n || '').length >= 2);
  if (names.length) {
    const windowChars = REDLINES.nameBombWindowChars || 200;
    const head = src.replace(/\s/g, '').slice(0, windowChars);
    const found = names.filter(name => head.includes(name));
    hits.name_bomb = found.length > (REDLINES.nameBombUniqueMax ?? 4);
  }

  for (const name of firstAppearNames || []) {
    const idx = src.indexOf(name);
    if (idx < 0) continue;
    const win = src.slice(Math.max(0, idx - 24), idx + String(name).length + 24);
    if (!/【新设定/.test(win) && !/(?:是|乃|身为)/.test(win)) {
      hits.identity_dump = true;
      break;
    }
  }

  const interiors = [...src.matchAll(/([\u4e00-\u9fff]{1,4})(?:心想|心道|暗想)/g)];
  const subjects = new Set(interiors.map(m => m[1]));
  hits.dual_interior = subjects.size >= 2;

  const threshold = REDLINES.connectorDetectMedium ?? 3;
  hits.connector_run = connectorWords().some(word => countWord(src, word) >= threshold);

  const longChars = REDLINES.longSentenceChars || 40;
  const needStreak = REDLINES.longSentenceStreak || 3;
  let streak = 0;
  for (const sentence of src.split(/[。！？]/).map(s => s.replace(/\s/g, '')).filter(Boolean)) {
    streak = sentence.length >= longChars ? streak + 1 : 0;
    if (streak >= needStreak) {
      hits.long_sentence_streak = true;
      break;
    }
  }

  const paras = paragraphs(src);
  const stairMax = REDLINES.staircaseMaxChars || 8;
  const stairRun = REDLINES.staircaseRun || 4;
  let run = 0;
  for (const para of paras) {
    if (!/[“「『"]/.test(para) && para.length <= stairMax) run += 1;
    else run = 0;
    if (run >= stairRun) {
      hits.staircase = true;
      break;
    }
  }

  for (const para of paras) {
    const quotes = para.match(/[“「『"][^”」』"]*[”」』"]/g) || [];
    const attrs = (para.match(/[说道问]/g) || []).length;
    if (quotes.length >= 2 && attrs >= 2) {
      hits.two_speaker_para = true;
      break;
    }
  }

  const last = paras.at(-1) || '';
  hits.travel_ending = /赶路|上路|天色|柳树|披风|路旁/.test(last)
    && !/[？！]/.test(last)
    && !/[“「『"]/.test(last);

  return hits;
}

export function detectCraftIssues(text, opts = {}) {
  const src = String(text || '');
  const hits = craftHits(src, opts);
  const issues = [];
  const push = (axis, issue, quote) => {
    if (!hits[axis]) return;
    issues.push({
      type: '语句质量',
      severity: 'medium',
      proseFix: true,
      axis,
      quote: String(quote || src.slice(0, 40)),
      issue,
      fix: HINTS[axis],
    });
  };
  push('name_bomb', '开篇人名过密，读者认不出谁是核心角色', src.slice(0, 40));
  push('identity_dump', '新人物出场未带身份标签', src.slice(0, 40));
  push('dual_interior', '相邻句切到不同人物心想，视角乱切', (src.match(/[\u4e00-\u9fff]{1,4}(?:心想|心道|暗想)[^。]{0,12}/) || [''])[0]);
  push('connector_run', '因此/于是/所以堆砌，因果像套模板', '因此');
  push('long_sentence_streak', '连续三句以上长句，阅读负担过重', src.slice(0, 40));
  push('staircase', '连续碎段假排版，没有新信息', src.slice(0, 40));
  push('two_speaker_para', '同一段里两个人说话，台词容易串', src.slice(0, 60));
  push('travel_ending', '章末落在赶路风景，没有变化、发现或下一步', paragraphs(src).at(-1) || '');
  return issues;
}

function splitTwoSpeakerParagraph(para) {
  const quotes = para.match(/[“「『"][^”」』"]*[”」』"]/g) || [];
  if (quotes.length < 2) return para;
  const first = quotes[0];
  const firstClose = para.indexOf(first) + first.length;
  const rest = para.slice(firstClose);
  if (!/^[\s]*[\u4e00-\u9fff]{1,8}[问]?[说道]/.test(rest)) return para;
  return `${para.slice(0, firstClose)}\n\n${rest.trimStart()}`;
}

function healConnectors(src) {
  let out = src;
  const keep = (REDLINES.connectorDetectMedium ?? 3) - 1;
  for (const word of connectorWords()) {
    const idxs = [];
    let idx = 0;
    while ((idx = out.indexOf(word, idx)) >= 0) {
      idxs.push(idx);
      idx += word.length;
    }
    if (idxs.length <= keep) continue;
    for (const pos of idxs.slice(keep).reverse()) {
      out = `${out.slice(0, pos)}${out.slice(pos + word.length)}`;
    }
  }
  return out;
}

function healStaircase(src) {
  const paras = paragraphs(src);
  const stairMax = REDLINES.staircaseMaxChars || 8;
  const stairRun = REDLINES.staircaseRun || 4;
  const out = [];
  let buf = [];
  const flush = () => {
    if (!buf.length) return;
    if (buf.length >= stairRun) out.push(buf.join(''));
    else out.push(...buf);
    buf = [];
  };
  for (const para of paras) {
    if (!/[“「『"]/.test(para) && para.length <= stairMax) buf.push(para);
    else {
      flush();
      out.push(para);
    }
  }
  flush();
  return out.join('\n\n');
}

export function healCraftMorphology(text) {
  const original = String(text || '');
  if (!original.trim()) return { content: original, healed: false };
  let content = healStaircase(original);
  content = paragraphs(content).map(splitTwoSpeakerParagraph).join('\n\n');
  content = healConnectors(content);
  return { content, healed: content !== original };
}

export function compileCraftOccupancy(recentHits = []) {
  const recent = (Array.isArray(recentHits) ? recentHits : []).filter(Boolean);
  if (!recent.length) return { text: '', occupied: {}, last: null, recent: [] };
  const occupied = {};
  for (const axis of CRAFT_AXES) {
    const hit = LAST_ONLY.has(axis)
      ? Boolean(recent[0]?.[axis])
      : recent.some(row => row[axis]);
    if (hit) occupied[axis] = true;
  }
  const lines = CRAFT_AXES.filter(axis => occupied[axis]).map(axis => `- ${HINTS[axis]}`);
  if (!lines.length) return { text: '', occupied, last: recent[0], recent };
  let text = `【近窗发稿占用】（只列已占用项）\n${lines.join('\n')}`;
  if (text.length > CRAFT_BRIEF_MAX_CHARS) text = text.slice(0, CRAFT_BRIEF_MAX_CHARS);
  return { text, occupied, last: recent[0], recent };
}

export function compileBookCraftOccupancy(bookId, chapterIdx) {
  const chapters = store.chapters.list(bookId)
    .filter(ch => Number(ch.idx) < Number(chapterIdx) && isCompletedChapter(ch))
    .sort((a, b) => b.idx - a.idx)
    .slice(0, 5);
  if (!chapters.length) return compileCraftOccupancy([]);
  const rosterNames = store.characters.list(bookId).map(row => row.name).filter(Boolean);
  const recent = chapters.map(ch => craftHits(store.chapters.fullText(ch.id) || '', { rosterNames }));
  return compileCraftOccupancy(recent);
}

export function craftRegression(beforeText = '', afterText = '', occupancy = {}) {
  const occupied = occupancy?.occupied || occupancy || {};
  if (!occupied.travel_ending) return { reject: false };
  const before = craftHits(beforeText).travel_ending;
  const after = craftHits(afterText).travel_ending;
  if (after && !before) {
    return { reject: true, reason: '修订把收束改成近章占用的赶路空镜' };
  }
  return { reject: false };
}

export function buildLedgerCheckBrief({
  chapterIdx,
  mentionedNames = [],
  timeline = [],
  characters = [],
  foreshadows = [],
} = {}) {
  const names = new Set((mentionedNames || []).filter(Boolean));
  const people = (characters || []).filter(row => names.has(row.name)).slice(0, LEDGER_PEOPLE_CAP);
  const events = (timeline || []).slice(-LEDGER_TIMELINE_CAP);
  const hooks = (foreshadows || []).slice(0, LEDGER_PAYOFF_CAP);
  const lines = [];
  if (people.length) {
    lines.push('【人物状态】');
    for (const person of people) {
      const loc = person.location ? ` @${person.location}` : '';
      const last = person.lastChapter ? `（第${person.lastChapter}章）` : '';
      lines.push(`- ${person.name}${loc}${last}`);
    }
  }
  if (events.length) {
    lines.push('【时间线】');
    for (const event of events) {
      const year = event.year ? `${event.year} ` : '';
      lines.push(`- ${year}${event.event || event}`);
    }
  }
  if (hooks.length) {
    lines.push('【伏笔】');
    for (const hook of hooks) lines.push(`- ${String(hook.desc || '').slice(0, 40)}`);
  }
  void chapterIdx;
  return lines.join('\n');
}

export function buildBookLedgerBrief(bookId, chapterIdx, { beat = '', pov = '' } = {}) {
  const roster = store.characters.list(bookId);
  const mentioned = roster
    .map(row => row.name)
    .filter(name => name && (`${pov} ${beat}`.includes(name)));
  if (pov && !mentioned.includes(pov)) mentioned.unshift(pov);
  return buildLedgerCheckBrief({
    chapterIdx,
    mentionedNames: mentioned,
    timeline: store.timeline.list(bookId),
    characters: roster.map(row => ({
      name: row.name,
      lastChapter: row.last_chapter,
      location: '',
    })),
    foreshadows: store.foreshadows.active(bookId),
  });
}
