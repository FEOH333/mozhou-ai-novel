// V0.100 叙事结构签名：识别因果骨架复读，不把固定“标准答案”塞回写作提示。
'use strict';

const textOf = value => typeof value === 'string'
  ? value
  : value && typeof value === 'object' ? String(value.desc || value.text || '') : '';

function classifyOpening(text) {
  const head = String(text || '').trim().slice(0, 180);
  if (!head) return 'unknown_open';
  if (/^[“「『]/.test(head)) return 'dialogue_open';
  if (/^(次年|翌日|当夜|清晨|天未亮|天没亮|黄昏|夜里|雨|雪|雾)/.test(head)) return 'time_weather_open';
  if (/[冲扑砸撞抓拔推奔跑烧杀劈斩]/.test(head.slice(0, 30))) return 'action_open';
  if (/[发现看见听见闻到察觉]/.test(head.slice(0, 60))) return 'perception_open';
  return 'situation_open';
}

function classifyInitiative(outline, text) {
  const source = `${outline?.goal || ''} ${outline?.dramatic_question || ''} ${outline?.choice_cost || ''} ${text || ''}`;
  if (/请示|报告|禀报|等待|听命|复诵/.test(source)) return 'report_or_obey';
  if (/选择|决定|拒绝|烧掉|承担|主动|改道|留下|出手/.test(source)) return 'choose_and_pay';
  if (/发现|看见|察觉|听见|认出/.test(source)) return 'observe';
  return 'react';
}

function classifyCounterforce(outline, text = '') {
  const beats = (Array.isArray(outline?.scenes) ? outline.scenes : []).map(s => s.beat || '').join(' ');
  const source = `${outline?.counterforce || ''} ${outline?.conflict || ''} ${beats} ${String(text || '').slice(0, 1200)}`;
  if (/长辈|师父|父亲|母亲|将军|主帅|大人|成人|主簿|使臣|朝使|权臣|台谏|官差|吏员|查账|弹劾/.test(source)) return 'authority';
  if (/敌|对手|斥候|奸细|政敌|追兵|同伴反对|对质|对峙|盘问|内鬼/.test(source)) return 'human_opponent';
  if (/时间|倒计时|天亮前|期限|时限|粮尽/.test(source)) return 'clock';
  if (/天气|暴雨|洪水|山火|坍塌|疫病/.test(source)) return 'environment';
  if (/两难|不可兼得|内心|恐惧|愧疚/.test(source)) return 'inner_dilemma';
  return 'weak_counterforce';
}

function classifyResolution(outline, text) {
  const source = `${outline?.irreversible_change || ''} ${outline?.turn || ''} ${text || ''}`;
  if (/记入|写入|落册|工册|账册|地图|标记/.test(source)) return 'record';
  if (/长辈|师父|父亲|母亲|将军|大人/.test(source) && /处置|决定|下令|批准|纠正|验证/.test(source)) return 'adult_verify';
  if (/烧毁|断绝|死亡|决裂|失去|改道|撤离|攻下|夺得|公开/.test(source)) return 'irreversible_action';
  if (/得知|揭示|真相|身份|证据/.test(source)) return 'revelation';
  if (/和解|信任|背叛|承诺/.test(source)) return 'relationship_change';
  return 'soft_resolution';
}

function dominantArtifact(outline, text) {
  const source = `${JSON.stringify(outline || {})} ${text || ''}`;
  const groups = [
    ['ledger', /册|账|簿|文书/g], ['map', /图|地图|路线|标记/g],
    ['fire_smoke', /火|烟|灰烬/g], ['weapon', /刀|剑|弓|枪|甲/g],
    ['letter_order', /信|军报|命令|诏|令/g],
  ];
  let best = ['none', 0];
  for (const [name, regex] of groups) {
    const count = (source.match(regex) || []).length;
    if (count > best[1]) best = [name, count];
  }
  return best[1] ? best[0] : 'none';
}

function classifyEnding(text, pull) {
  const tail = `${String(text || '').slice(-220)} ${textOf(pull)}`;
  if (/远处|天边|山外|烟|火光|犬吠|脚印/.test(tail)) return 'distant_signal';
  if (/必须|明日|天亮前|只剩|来不及/.test(tail)) return 'task_or_clock';
  if (/原来|竟是|身份|真相|名字/.test(tail)) return 'revelation';
  if (/答应|承诺|留下|一起|离开/.test(tail)) return 'relationship_pull';
  if (/选择|决定|要不要|只能/.test(tail)) return 'choice_pull';
  return 'aftermath_pull';
}

export function narrativePatternFeatures({ outline = {}, text = '' } = {}) {
  return {
    opening: classifyOpening(text), initiative: classifyInitiative(outline, text),
    counterforce: classifyCounterforce(outline, text), resolution: classifyResolution(outline, text),
    artifact: dominantArtifact(outline, text), ending: classifyEnding(text, outline.reader_pull || outline.ending_hook),
  };
}

export function narrativePatternSignature(input = {}) {
  const f = narrativePatternFeatures(input);
  return [f.opening, f.initiative, f.counterforce, f.resolution, f.artifact, f.ending].join('>');
}

export function repeatedPatternIssue(signature, recentPatterns = [], { threshold = 2 } = {}) {
  const current = String(signature || '').trim();
  if (!current) return null;
  const exact = recentPatterns.filter(item => String(item?.signature || '') === current).length;
  if (exact < threshold) return null;
  return {
    code: 'OUTLINE_STRUCTURE_REPEATED', hard: true,
    issue: `本章因果骨架已在近期出现 ${exact} 次（${current}）。必须改变谁主动、阻力来源、转折机制、不可逆后果或结尾余力中的至少两项；只换地点、物件和形容词不算新结构`,
  };
}

