// V0.101 题材创作偏好槽——isHistory 二元开关的上层配置。
// 历史/玄幻等题材只提供预设；具体书名永不进本模块。动态内容进 settings.craftProfile，不进 L1。
'use strict';

import { REDLINES } from '../../data/redlines.js';

const ENUMS = {
  costStrictness: ['strict', 'moderate', 'loose'],
  rewardIntensity: ['high', 'medium', 'low'],
  styleDensity: ['dense', 'balanced', 'sparse'],
  evidenceBound: ['strict', 'moderate', 'off'],
  permissionBound: ['strict', 'moderate', 'loose', 'off'],
};

export const CRAFT_PRESETS = {
  历史: {
    costStrictness: 'strict',
    rewardIntensity: 'medium',
    styleDensity: 'dense',
    evidenceBound: 'strict',
    permissionBound: 'strict',
    valleyCadence: 4,
  },
  玄幻: {
    costStrictness: 'moderate',
    rewardIntensity: 'high',
    styleDensity: 'balanced',
    evidenceBound: 'off',
    permissionBound: 'loose',
    valleyCadence: 5,
  },
  都市: {
    costStrictness: 'moderate',
    rewardIntensity: 'medium',
    styleDensity: 'balanced',
    evidenceBound: 'moderate',
    permissionBound: 'moderate',
    valleyCadence: 4,
  },
};

const FALLBACK = {
  costStrictness: 'moderate',
  rewardIntensity: 'medium',
  styleDensity: 'balanced',
  evidenceBound: 'moderate',
  permissionBound: 'moderate',
  valleyCadence: 4,
};

function clampCadence(value, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 2 || n > 8) return fallback;
  return n;
}

/**
 * @param {{genre?:string}|null} book
 * @param {{craftProfile?:object}|null} settings
 */
export function resolveCraftProfile(book = {}, settings = {}) {
  const genre = String(book?.genre || '');
  const base = { ...(CRAFT_PRESETS[genre] || FALLBACK) };
  const raw = settings && typeof settings.craftProfile === 'object' && settings.craftProfile
    ? settings.craftProfile
    : {};
  const out = { ...base };
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (allowed.includes(raw[key])) out[key] = raw[key];
  }
  out.valleyCadence = clampCadence(raw.valleyCadence, base.valleyCadence);
  out.genre = genre;
  out.isHistory = genre === '历史';
  return out;
}

/** 物证过顺检测阈值：strict 提前到 2；off 关闭；其余用红线默认。 */
export function evidenceCertaintyThreshold(profile = {}) {
  if (profile.evidenceBound === 'off') return 99;
  if (profile.evidenceBound === 'strict') return Math.min(2, REDLINES.evidenceCertaintyDetectMedium);
  return REDLINES.evidenceCertaintyDetectMedium;
}

export function formatCraftProfileLine(profile = {}) {
  const p = profile.evidenceBound ? profile : resolveCraftProfile();
  return `题材偏好 ${p.genre || '通用'}｜物证 ${p.evidenceBound}｜权限 ${p.permissionBound}｜回报 ${p.rewardIntensity}｜低谷每 ${p.valleyCadence} 章`;
}
