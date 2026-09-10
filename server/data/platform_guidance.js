// server/data/platform_guidance.js —— V0.98 平台事实与创作启发分层
'use strict';

export const PLATFORM_GUIDANCE = Object.freeze({
  番茄: Object.freeze({
    verifiedAt: '2026-09-02',
    officialFacts: Object.freeze([
      { key: 'recommendation-flow', text: '官方公开材料使用“推荐评估”和“推荐验证”描述推荐流程', sources: ['R1', 'R2'] },
      { key: 'chapter-order', text: '作者端存在章节调序能力，但未公开确认第0章或小数编号', sources: ['R4'] },
    ]),
    officialCreativeGuidance: Object.freeze([
      { text: '开头主要事件应呈现本书真正依靠的吸引点；一个吸引维度足够出色即可', sources: ['R20', 'R21'] },
      { text: '优质长篇同时重视成长弧、配角情感、世界纵深、张弛节奏和伏笔闭环', sources: ['R24'] },
      { text: '发稿前自查人物细节、语言排版、呆板句式，并把章节边界卡在情节节点上（不是审核阈值）', sources: ['R31'] },
      { text: '长篇中后期用 5–10 章阶段目标、四表写前查写后更、每 10–20 万字复盘，副本须换核心冲突（不是审核阈值）', sources: ['R32'] },
    ]),
    unsupportedAssumptions: Object.freeze([
      '约第20章必然触发首次推荐',
      '作者端原生支持第0章或0.5/1.5等小数章节',
      '存在可写死到代码里的统一首章留存率阈值',
    ]),
    editorialHeuristics: Object.freeze([
      '第一屏尽快让人物、当下困局或选择可辨认；正例：用角色正在护住某人、拒签某物或躲避追兵带出背景',
      '第一章不能依靠高刺激序章遮盖弱正文；正例：回到顺叙后仍有新的行动与问题',
      '减少不改变状态的重复描写；正例：环境细节同时改变人物判断或迫使人物行动',
    ]),
  }),
});

export function platformGuidance(platform) {
  return PLATFORM_GUIDANCE[String(platform || '').trim()] || null;
}

export function platformGuidanceText(platform) {
  const row = platformGuidance(platform);
  if (!row) return '【平台指导】无已核验的特定平台事实；仅按作品创作宪章和通用叙事目标审阅。';
  return [
    `【平台事实（核验于${row.verifiedAt}）】`,
    ...row.officialFacts.map(item => `- ${item.text}（${item.sources.join('、')}）`),
    '【官方创作指导（不是审核阈值）】',
    ...row.officialCreativeGuidance.map(item => `- ${item.text}（${item.sources.join('、')}）`),
    '【未证实，禁止当作规则】',
    ...row.unsupportedAssumptions.map(item => `- ${item}`),
    '【编辑启发，不是平台阈值】',
    ...row.editorialHeuristics.map(item => `- ${item}`),
  ].join('\n');
}
