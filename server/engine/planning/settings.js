// server/engine/planning/settings.js —— V0.28 设定全自动（AI 本位：书级设定一键生成）
// 书纲生成后自动执行（pilot 骨架阶段）：世界观详设/人物卡/地点/物品/势力/世界书词条
// 全部由 AI 生成并落库，用户无需手动整理；设定页保留手动编辑与"重新生成"。
'use strict';

import { runTask } from '../../llm/router.js';
import { assembleMessages } from '../../llm/cache.js';
import { extractJSON } from '../../util/json.js';
import * as store from '../../db/store.js';
import { genrePackText } from '../../data/creative_packs.js'; // V0.81 题材包注入设定
import { historySettingsRequirements, formatEraContext } from '../narrative/history.js'; // V0.81 历史考据要求 // V0.82 格式化落库

/** 设定生成指令（输入书契约 + 书级大纲 + 快感计划，输出结构化设定包）
 *  V0.81：注入题材包 genreText + 历史考据要求 historyReq（历史题材时） */
export function settingsInstruction({ bookTitle, genre, contract, outlineText, pleasureText, genreText = '', historyReq = '' }) {
  return `你是资深网文世界观架构师。请为《${bookTitle || '未命名'}》生成一份可直接用于正文写作的完整设定包。
【题材】${genre || '不限'}
${genreText ? `【题材包】\n${genreText}\n` : ''}
${historyReq ? `【历史考据要求】\n${historyReq}\n` : ''}
${contract ? `【书契约】\n${contract.slice(0, 1200)}` : ''}
${outlineText ? `【书级大纲】\n${outlineText.slice(0, 1800)}` : ''}
${pleasureText ? `【快感计划】\n${pleasureText.slice(0, 800)}` : ''}

要求：
- 所有设定必须与书契约硬约束、大纲分卷、主角设定严格一致，不得自创冲突设定；
- 世界观聚焦"写作时用得上的规则"（力量体系/势力格局/地理/货币/禁忌），不要空泛套话；
- 人物卡覆盖书纲中的全部主要人物（主角+配角+反派），每张卡含 role/personality/goal/relations/appearance；
- **人物活性三件（V0.108）**：①每张卡写 backstory（关键经历：解释性格/缺陷成因的 1-2 个事件，40-60 字——"因为幼年被忽视，所以格外在意他人评价"式因果）；②motive_root（底层动因：他为什么非要这个不可，30 字内，恐惧/亏欠/执念级）；③每个主要对手/反派角色标 rival: true 并写全三件——agenda（独立目标：他为自己要什么——晋升/保位/复仇/护住某人，禁止"阻止主角"式依附目标）、no_retreat（退不了的理由：一旦停手他会失去什么——权位/亲人/前功尽弃）、stance（局部正确：他认为自己对在哪；让读者"不认同他但理解他"）；配角另写 web（与主角之外的另一角色的关系线一条，如"欠某人一条命/与某人是旧识"，让关系网不止主角中心）；
- 地点/物品/势力各 4-10 个，detail 每条约 60-120 字；
- 世界书词条 5-12 条：word 用最可能在正文出现的名词（人名/地名/功法/物品），content 是触发注入的说明文字（100-200 字）；
- **【社会生态】（V0.49）必须输出**：每个主要地点（城市/镇/宗门/坊市）配"市井生活"细节——集市/商铺/茶楼酒肆/三教九流职业（商贩/屠户/更夫/郎中/乞丐/帮派）/日常人情往来（婚丧嫁娶、节庆、街坊闲话）/物价与生计（几文钱能买什么），让人物活在"有烟火气的世界"里，避免永远荒野独处；主要势力之间的民间关系（敬畏/仇视/联姻/欺压）；
- 所有字段用中文。
请输出 JSON（不要输出 JSON 以外的任何内容）：{
  "worldview": "世界观详设（400-600 字）",
  "social_ecology": [{"place": "地点/城镇/坊市名", "life": "市井生活细节（集市/职业/人情/物价，120-200 字）"}],
  "characters": [{"name": "角色名", "role": "定位", "personality": "性格（含缺陷）", "goal": "目标", "relations": "关键关系", "appearance": "外貌特征", "fear": "恐惧/软肋", "secret": "秘密/隐藏身份", "arc": "成长弧线（分阶段）", "backstory": "关键经历（解释性格成因的1-2个事件，40-60字）", "motive_root": "底层动因（为什么非要这个不可，30字内）", "web": "与主角之外另一角色的关系线一条（20-40字；无则空串）", "rival": "仅对手/反派角色 true", "agenda": "仅rival：独立目标（他为自己要什么）", "no_retreat": "仅rival：退不了的理由（一旦停手会失去什么）", "stance": "仅rival：他认为自己对在哪（局部正确）"}],
  "locations": [{"name": "地名", "type": "城市/宗门/秘境/势力驻地…", "detail": "简介"}],
  "items": [{"name": "物品名", "type": "法宝/丹药/信物…", "detail": "简介"}],
  "factions": [{"name": "势力名", "detail": "简介"}],
  "worldbook": [{"word": "关键词", "content": "词条说明", "category": "地理/势力/人物/物品/规则"}],
  "era_context": "时代背景卡（仅历史题材：本时代真实事件/人物/官职/地理/经济/礼法要点，150-250字）"
}`;
}

/**
 * 书级设定自动生成（幂等：已有 world 材料则跳过，除非 force）。
 * @returns {Promise<{ok:boolean, skipped?:boolean, counts:object, error?:string}>}
 */
export async function generateBookSettings(bookId, opts = {}) {
  const { onEvent, force = false, signal } = opts;
  const emit = (stage, message) => onEvent?.({ type: 'stage', stage, message });
  try {
    const book = store.books.get(bookId);
    if (!book) return { ok: false, error: '作品不存在' };

    if (!force && store.materials.get(bookId, 'world')?.content) {
      return { ok: true, skipped: true, counts: {} };
    }

    emit('setup', '读取契约/大纲，规划设定结构…');
    const contract = store.materials.get(bookId, 'contract')?.content || '';
    const outlineText = store.materials.get(bookId, 'outline')?.content || '';
    const pleasureText = store.materials.get(bookId, 'pleasure')?.content || '';

    const messages = assembleMessages(bookId, [{
      role: 'user',
      content: settingsInstruction({
        bookTitle: book.title, genre: book.genre, contract, outlineText, pleasureText,
        // V0.81：题材包 + 历史考据要求（历史题材时注入官制/军制/红线/礼法等）
        genreText: genrePackText(book.genre),
        historyReq: book.genre === '历史' ? historySettingsRequirements() : '',
      }),
    }]);
    emit('setup', 'AI 正在撰写世界观与全部设定卡…');
    // V0.90 修复：设定生成自动重试 ≤2 次（对齐 V0.85 卷大纲容错）——模型偶发输出 JSON 结构不合法
    // （缺 worldview 等字段）时此前一次性"设定解析失败"，需用户手动重试；现在注入上次失败提示自动重生成。
    let out = null;
    let lastFailReason = '';
    for (let attempt = 0; attempt < 3 && !out; attempt++) {
      let content = settingsInstruction({
        bookTitle: book.title, genre: book.genre, contract, outlineText, pleasureText,
        // V0.81：题材包 + 历史考据要求（历史题材时注入官制/军制/红线/礼法等）
        genreText: genrePackText(book.genre),
        historyReq: book.genre === '历史' ? historySettingsRequirements() : '',
      });
      if (lastFailReason) content += `\n\n【上次生成失败（V0.90 自动重试）】${lastFailReason}\n请输出完整的设定 JSON：必须包含 worldview（世界观）字段，其余字段（social_ecology/characters/locations/items/factions/worldbook/era_context）按需给出。不要只输出部分结构。`;
      const res = await runTask({ task: 'book_settings', bookId, messages: assembleMessages(bookId, [{ role: 'user', content }]), jsonMode: true, signal });
      const parsed = extractJSON(res.content);
      if (parsed?.worldview) { out = parsed; break; }
      lastFailReason = `上次输出缺少 worldview 字段（模型返回结构异常，可能 JSON 不完整或字段缺失）`;
    }
    if (!out) return { ok: false, error: '设定解析失败，请重试（已自动重试 3 次，模型返回结构异常）' };

    // 1) 公共材料：世界观 + 人物卡
    store.materials.set(bookId, 'world', out.worldview.trim());
    // V0.72 修复：设定生成后重建历史堆前缀（此前 world 材料从不进历史堆 seq2 →
    // 正文写作实际读不到世界观设定；rebuildHistory 原地替换 seq1/seq2，正文历史不变）
    try {
      const { rebuildHistory } = await import('./outline.js');
      rebuildHistory(bookId, '设定生成（世界观进历史堆）');
    } catch { /* 历史堆重建失败不阻断（后续 ensureHistory 兜底） */ }
    // V0.50：社会生态独立材料（不进公共前缀——按场景地点动态注入，避免每章都烟火气喧宾夺主）
    const ecology = (out.social_ecology || []).filter(e => e?.place && e?.life);
    if (ecology.length) {
      const ecoText = ecology.map(e =>
        `【${e.place}】${e.life}`
      ).join('\n');
      store.materials.set(bookId, 'ecology', ecoText);
    }
    const charCards = (out.characters || []).filter(c => c?.name);
    if (charCards.length) {
      // V0.59 整合：不再写 materials('characters') 文本材料（与 cast 设计蓝图重复、不进前缀）
      // 角色信息唯一写入 characters 表（运行时档案）
      for (const c of charCards) {
        const existing = store.characters.list(bookId).find(e => e.name === c.name);
        const patch = {
          card: {
            role: c.role || '', traits: c.personality || '', description: c.personality || '',
            appearance: c.appearance || '',
            // V0.108 人物活性键（card_json 单一位置；existing 展开在后=已有值受保护，只填空不覆盖）
            backstory: c.backstory || '', motive_root: c.motive_root || '', web: c.web || '',
            rival: c.rival === true, agenda: c.agenda || '', no_retreat: c.no_retreat || '', stance: c.stance || '',
            ...(existing ? (JSON.parse(existing.card_json || '{}') || {}) : {}),
          },
          personality: c.personality || '', goal: c.goal || '', relation: c.relations || '',
          fear: c.fear || '', secret: c.secret || '', arc: c.arc || '',
        };
        if (existing) store.characters.update(existing.id, patch);
        else store.characters.create(bookId, { name: c.name, ...patch });
      }
    }

    // 2) 实体卡：地点/物品/势力（name 已存在则补 card，不存在则创建）
    const counts = { locations: 0, items: 0, factions: 0, worldbook: 0 };
    const upsertEntities = (kind, list) => {
      for (const it of list || []) {
        const name = (it.name || '').trim();
        if (!name) continue;
        const existing = store[kind].list(bookId).find(e => e.name === name);
        const card = { type: it.type || '', detail: it.detail || '' };
        if (existing) store[kind].update(existing.id, { card });
        else store[kind].create(bookId, { name, card });
        counts[kind]++;
      }
    };
    upsertEntities('locations', out.locations);
    upsertEntities('items', out.items);
    upsertEntities('factions', out.factions);

    // 3) 世界书词条（关键词触发注入；去重）
    for (const wb of out.worldbook || []) {
      const word = (wb.word || '').trim();
      if (!word || !wb.content) continue;
      const existing = store.worldbook.list(bookId).find(w => (JSON.parse(w.keywords || '[]') || []).includes(word));
      if (!existing) {
        store.worldbook.create(bookId, {
          keywords: [word], content: wb.content.trim(), priority: 1, category: wb.category || '通用',
        });
        counts.worldbook++;
      }
    }

    // V0.81：历史题材 era_context（设定阶段若模型已输出时代背景卡则落库；否则由 pilot 兜底 ensureEraContext）
    // V0.82 修复：必须按 formatEraContext 结构化格式化落库——此前自由文本直接落库，
    // eraContextText 章节级裁剪靠【时代红线】/【可改史点】正则匹配 → 无标签文本匹配不到 → 全书历史约束静默失效
    if (out.era_context) {
      let parsed = null;
      if (typeof out.era_context === 'object') parsed = out.era_context;
      else {
        try { parsed = extractJSON(out.era_context); } catch { /* ignore */ }
      }
      // 结构化字段可格式化 → 落库；否则丢弃（pilot 的 ensureEraContext 会用种子规范生成，避免脏数据进红线正则盲区）
      if (parsed && typeof parsed === 'object' && parsed.era) {
        store.materials.set(bookId, 'era_context', formatEraContext(parsed));
        counts.era_context = 1;
      }
    }

    emit('setup', `设定生成完成：世界观/人物卡 + 地点${counts.locations}·物品${counts.items}·势力${counts.factions}·世界书词条${counts.worldbook}${counts.era_context ? '+时代背景卡' : ''}`);
    return { ok: true, counts };
  } catch (e) {
    if (e?.code === 'ABORTED' || e?.name === 'AbortError') throw e;
    return { ok: false, error: e.message };
  }
}
