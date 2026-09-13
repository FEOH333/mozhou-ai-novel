// server/engine/planning/sequel.js —— V0.109.4 续作（衍新书）
//
// 场景：一部书写完了，想在同一个世界里再写一部（下一代 / 新主角 / 后续事件）。
// 手工从头建书意味着世界观、设定、事实全部要重打一遍——那正是最容易走样、最贵的一步。
//
// 本模块把上一部当作**母本**派生新书：继承世界观与设定事实，可选继承角色，
// 但**契约与主线重新立**——续作是新书，不是把旧书的账接着记。
//
// 关键设计：
//  - 只复制**可复用的设定类资产**（world / 事实 / 角色卡），不复制叙事状态
//    （主轴进度、伏笔台账、快照、章节投影都属旧书，带过去只会打架）
//  - 事实的 source_chapter 归零：旧章 id 在新书里不存在，留着会指向空
//  - 记录 `derived_from` 材料，让新书可溯源（谁派生的、继承了哪些）
'use strict';
import * as store from '../../db/store.js';
import { logFlow } from '../../util/oplog.js';

export const DERIVED_FROM_KIND = 'derived_from';

/** 列出母本可继承的资产与规模，供前端让用户勾选 */
export function sequelCandidates(sourceBookId) {
  const book = store.books.get(sourceBookId);
  if (!book) return null;
  const world = store.materials.get(sourceBookId, 'world')?.content || '';
  const facts = store.facts.active(sourceBookId);
  const characters = store.characters.list(sourceBookId);
  return {
    bookId: sourceBookId,
    title: book.title,
    genre: book.genre,
    platform: book.platform,
    perspective: book.perspective,
    world: { available: Boolean(world.trim()), chars: world.length },
    facts: { available: facts.length > 0, count: facts.length },
    characters: {
      available: characters.length > 0,
      count: characters.length,
      names: characters.map(c => c.name),
    },
  };
}

/**
 * 以已完结作品为母本派生新书。
 *
 * @param {string} sourceBookId 母本
 * @param {object} opts
 * @param {string} [opts.title] 新书标题（缺省 `${母本标题}·续`）
 * @param {object} [opts.inherit] 继承开关
 *   world(默认 true) / facts(默认 true) / characters(true=全部，或角色名数组) / cast(默认 false)
 * @returns {{bookId:string, title:string, inherited:object}}
 */
export function deriveSequel(sourceBookId, { title, inherit = {} } = {}) {
  const src = store.books.get(sourceBookId);
  if (!src) throw new Error('母本作品不存在');

  const wantWorld = inherit.world !== false;
  const wantFacts = inherit.facts !== false;
  // characters: 不传=全部；false=不带；true=全部；数组=只带这些名字
  const wantChars = inherit.characters === undefined ? true : inherit.characters;

  // 母本必须有正文——从空书派生没有意义
  const srcChapters = store.chapters.list(sourceBookId);
  if (!srcChapters.length) throw new Error('母本还没有任何章节，无法派生续作');

  const newTitle = String(title || '').trim() || `${src.title}·续`;
  const newBook = store.books.create({
    title: newTitle,
    genre: src.genre,
    platform: src.platform,
    perspective: src.perspective,
    blurb: '',
    settings: store.books.settings(sourceBookId), // 继承题材/风格等配置（不含叙事状态）
    era: src.era,
  });

  const inherited = { world: false, facts: 0, characters: 0, cast: false };

  // ① 世界观：换主角不换世界，这是续作最值钱的继承
  if (wantWorld) {
    const world = store.materials.get(sourceBookId, 'world')?.content || '';
    if (world.trim()) {
      store.materials.set(newBook.id, 'world', world);
      inherited.world = true;
    }
  }

  // ② 角色：默认全带；也可只带指定几个（新主角通常要新建，不该被旧主角压住）
  if (wantChars) {
    const all = store.characters.list(sourceBookId);
    const picked = Array.isArray(wantChars)
      ? all.filter(c => wantChars.includes(c.name))
      : all;
    for (const c of picked) {
      store.characters.create(newBook.id, {
        name: c.name,
        card: safeJSON(c.card_json),
        // 状态清零：旧书的"当前状态"（在哪、伤多重）在新书开篇不成立
        state: {},
        // 首登场章重新计——续作有自己的章节序号空间
        firstChapter: null,
        personality: c.personality || '',
        goal: c.goal || '',
        fear: c.fear || '',
        secret: c.secret || '',
        arc: c.arc || '',
        relation: c.relation || '',
        speech: c.speech || '',
        speechForbid: c.speech_forbid || '',
        tier: c.tier || 'minor',
        abilities: safeJSON(c.abilities_json, []),
      });
      inherited.characters++;
    }
  }

  // ③ 事实：只带 active 的设定类事实；source_chapter 归零（旧章 id 在新书不存在）
  if (wantFacts) {
    for (const f of store.facts.active(sourceBookId)) {
      store.facts.create(newBook.id, {
        subject: f.subject,
        predicate: f.predicate,
        object: f.object,
        sourceChapter: null,
        note: `继承自《${src.title}》`,
      });
      inherited.facts++;
    }
  }

  // ④ 角色弧光材料（cast）：默认不带——它描述的是旧主角的成长线，带过去会与新主线打架
  if (inherit.cast === true) {
    const cast = store.materials.get(sourceBookId, 'cast')?.content || '';
    if (cast.trim()) {
      store.materials.set(newBook.id, 'cast', cast);
      inherited.cast = true;
    }
  }

  // ⑤ 溯源：新书知道自己从哪来、继承了什么
  store.materials.set(newBook.id, DERIVED_FROM_KIND, JSON.stringify({
    sourceBookId,
    sourceTitle: src.title,
    inherited,
    derivedAt: Date.now(),
  }));

  logFlow({
    op: '续作·派生新书',
    detail: `《${src.title}》→《${newTitle}》：世界=${inherited.world} 事实=${inherited.facts} 角色=${inherited.characters}`,
    bookId: newBook.id,
  });

  return { bookId: newBook.id, title: newTitle, inherited };
}

/** 读取续作溯源信息（非续作返回 null） */
export function derivedFrom(bookId) {
  try {
    const raw = store.materials.get(bookId, DERIVED_FROM_KIND)?.content;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function safeJSON(text, fallback = {}) {
  try {
    const v = JSON.parse(text || '');
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}
