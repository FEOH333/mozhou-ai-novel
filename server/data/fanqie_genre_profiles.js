// server/data/fanqie_genre_profiles.js —— V0.98 番茄题材表达画像（样本观察，不是硬规则）
'use strict';

const HISTORY = Object.freeze({
  verifiedAt: '2026-08-22',
  commonObservations: Object.freeze([
    '题材承诺尽早可辨',
    '冲突已经在发生',
    '弱小主角也有可见选择',
    '历史锚点用于压缩信息而非展开百科',
  ]),
  routes: Object.freeze({
    high_concept_fast: Object.freeze({
      entryPatterns: Object.freeze(['反差身份', '著名历史节点中的紧迫选择', '即时困局']),
      payoffTranslations: Object.freeze(['身份反转', '预知差改变局面', '快速行动结果']),
      antiPatterns: Object.freeze(['用标签代替人物', '只靠现代口吻制造反差']),
      toneRisk: '可能损坏严肃历史质感',
    }),
    serious_immersive_history: Object.freeze({
      entryPatterns: Object.freeze(['具体困局中的人物选择', '身体处境与制度压力', '关系责任迫使人物行动']),
      payoffTranslations: Object.freeze(['能力使身边人少付代价', '真实难题被观察与纪律解决', '历史必然性出现裂缝']),
      antiPatterns: Object.freeze(['为追榜强加系统', '现代嘴替', '先讲百科再开故事', '把苦难当静态展览']),
      toneRisk: '沉浸不等于迟迟没有人物行动',
    }),
  }),
  observations: Object.freeze([
    { text: '历史新书榜常把身份、节点和眼前困局前置', sourceTier: 'rank_sample', sources: ['R25', 'R26'] },
    { text: '严肃历史样本可用具体压迫、生存选择和人物骨气建立期待', sourceTier: 'rank_sample', sources: ['R27', 'R28', 'R29', 'R30'] },
  ]),
});

export const FANQIE_GENRE_PROFILES = Object.freeze({ 历史: HISTORY });

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function fanqieGenreProfile(genre, route = '') {
  const row = FANQIE_GENRE_PROFILES[String(genre || '').trim()];
  if (!row) return { verifiedAt: null, route: route || 'general', entryPatterns: [], payoffTranslations: [], antiPatterns: [], commonObservations: [], observations: [] };
  const selected = row.routes[route] || row.routes.serious_immersive_history;
  return clone({
    verifiedAt: row.verifiedAt,
    route: row.routes[route] ? route : 'serious_immersive_history',
    commonObservations: row.commonObservations,
    observations: row.observations,
    ...selected,
  });
}

export function fanqieGenreProfileText(genre, route = '') {
  const profile = fanqieGenreProfile(genre, route);
  if (!profile.verifiedAt) return '【题材样本】无对应样本画像；服从本书创作宪章。';
  return [
    `【题材样本观察（${profile.verifiedAt}，非平台硬规则）】`,
    `路线：${profile.route}`,
    `可考虑的进入方式：${profile.entryPatterns.join('；')}`,
    `回报翻译：${profile.payoffTranslations.join('；')}`,
    `避免：${profile.antiPatterns.join('；')}`,
    '样本只能帮助把本书承诺说清楚，不能覆盖作者锁或强加系统、穿越、轻喜剧。',
  ].join('\n');
}
