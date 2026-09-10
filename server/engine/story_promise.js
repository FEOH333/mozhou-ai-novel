// server/engine/story_promise.js —— V0.98 每本书的创作宪章与读者承诺画像
'use strict';

import { createHash } from 'node:crypto';
import * as store from '../db/store.js';
import { runTask } from '../llm/router.js';
import { assembleMessages } from '../llm/cache.js';
import { extractJSON } from '../util/json.js';
import { storyPromiseInstruction } from './prompts.js';
import { platformGuidanceText } from '../data/platform_guidance.js';
import { fanqieGenreProfileText } from '../data/fanqie_genre_profiles.js';
import { getGlobal } from '../config.js';
import { isCompletedChapter } from './chapter_status.js';

const PROFILE_KEYS = Object.freeze([
  'premise_in_one_breath', 'primary_attraction_axis', 'secondary_axes', 'protagonist_now',
  'payoff_ladder', 'texture', 'protected_elements', 'anti_promises', 'author_locks', 'confidence',
]);
const LOCKABLE_PATHS = new Set([
  'premise_in_one_breath', 'primary_attraction_axis', 'secondary_axes', 'protagonist_now',
  'payoff_ladder', 'texture', 'texture.route', 'texture.pace', 'texture.humor',
  'texture.historical_density', 'texture.pov', 'protected_elements', 'anti_promises', 'author_locks',
]);

function safeSettings(book) {
  try { return book?.settings_json ? JSON.parse(book.settings_json) || {} : {}; } catch { return {}; }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function sourceInput(bookId, settingsOverride = null) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const settings = settingsOverride || safeSettings(book);
  return {
    book: { title: book.title || '', genre: book.genre || '', blurb: book.blurb || '', platform: book.platform || '', perspective: book.perspective || 'third', era: book.era || '{}' },
    contract: store.materials.get(bookId, 'contract')?.content || '',
    outline: store.materials.get(bookId, 'outline')?.content || '',
    pleasure: store.materials.get(bookId, 'pleasure')?.content || '',
    world: store.materials.get(bookId, 'world')?.content || '',
    cast: store.materials.get(bookId, 'cast')?.content || '',
    eraContext: store.materials.get(bookId, 'era_context')?.content || '',
    characters: store.characters.list(bookId).map(row => ({
      name: row.name || '', personality: row.personality || '', goal: row.goal || '',
      relation: row.relation || '', fear: row.fear || '', arc: row.arc || '',
    })),
    authorLocks: settings.storyPromiseLocks || {},
  };
}

export function storyPromiseFingerprint(bookId, settingsOverride = null) {
  return sha256(sourceInput(bookId, settingsOverride));
}

function clone(value) { return value == null ? value : structuredClone(value); }

function completedMaxIdx(bookId) {
  return store.chapters.list(bookId)
    .filter(isCompletedChapter)
    .reduce((max, chapter) => Math.max(max, Number(chapter.idx) || 0), 0);
}

function getPath(obj, path) {
  return String(path).split('.').reduce((value, key) => value?.[key], obj);
}

function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys.at(-1)] = clone(value);
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))] : [];
}

function validateProfile(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('创作画像不是对象');
  const profile = Object.fromEntries(PROFILE_KEYS.map(key => [key, clone(input[key])]));
  for (const key of ['premise_in_one_breath', 'primary_attraction_axis']) {
    profile[key] = String(profile[key] || '').trim();
    if (!profile[key]) throw new Error(`创作画像缺少 ${key}`);
  }
  profile.secondary_axes = normalizeStringArray(profile.secondary_axes);
  profile.protected_elements = normalizeStringArray(profile.protected_elements);
  profile.anti_promises = normalizeStringArray(profile.anti_promises);
  profile.author_locks = normalizeStringArray(profile.author_locks);
  profile.protagonist_now = profile.protagonist_now && typeof profile.protagonist_now === 'object' ? profile.protagonist_now : {};
  profile.payoff_ladder = profile.payoff_ladder && typeof profile.payoff_ladder === 'object' ? profile.payoff_ladder : {};
  for (const key of ['near', 'middle', 'long']) profile.payoff_ladder[key] = normalizeStringArray(profile.payoff_ladder[key]);
  profile.texture = profile.texture && typeof profile.texture === 'object' ? profile.texture : {};
  profile.texture.route = String(profile.texture.route || 'general').trim();
  profile.confidence = profile.confidence && typeof profile.confidence === 'object' && !Array.isArray(profile.confidence) ? profile.confidence : {};
  return profile;
}

function applyLocks(profile, locks) {
  const next = clone(profile);
  next.confidence ||= {};
  for (const [path, value] of Object.entries(locks || {})) {
    if (!LOCKABLE_PATHS.has(path)) continue;
    setPath(next, path, value);
    next.confidence[path] = 'author_confirmed';
  }
  next.author_locks = [...new Set([...(next.author_locks || []), ...Object.keys(locks || {}).filter(path => LOCKABLE_PATHS.has(path))])];
  return next;
}

export function storyPromiseStatus(bookId) {
  const book = store.books.get(bookId);
  if (!book) return { exists: false, stale: true, reason: '作品不存在', locks: {} };
  const settings = safeSettings(book);
  const profile = settings.storyPromiseProfile || null;
  const current = storyPromiseFingerprint(bookId, settings);
  return {
    exists: Boolean(profile),
    stale: !profile || profile.source_fingerprint !== current,
    source_fingerprint: profile?.source_fingerprint || '',
    current_fingerprint: current,
    locks: clone(settings.storyPromiseLocks || {}),
    profile: clone(profile),
  };
}

export function lockStoryPromiseFields(bookId, patch) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const settings = safeSettings(book);
  const locks = { ...(settings.storyPromiseLocks || {}) };
  for (const [path, value] of Object.entries(patch || {})) {
    if (!LOCKABLE_PATHS.has(path)) throw new Error(`不可锁定的创作画像字段：${path}`);
    locks[path] = clone(value);
  }
  settings.storyPromiseLocks = locks;
  if (settings.storyPromiseProfile) {
    const profile = applyLocks(settings.storyPromiseProfile, locks);
    settings.storyPromiseProfile = { ...profile, version: 1,
      source_fingerprint: storyPromiseFingerprint(bookId, settings), updated_at: Date.now() };
  }
  store.books.update(bookId, { settings });
  return clone(settings.storyPromiseProfile || null);
}

export function unlockStoryPromiseFields(bookId, paths = []) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const settings = safeSettings(book);
  const locks = { ...(settings.storyPromiseLocks || {}) };
  for (const path of paths) delete locks[String(path)];
  settings.storyPromiseLocks = locks;
  if (settings.storyPromiseProfile) settings.storyPromiseProfile.source_fingerprint = '';
  store.books.update(bookId, { settings });
  return clone(locks);
}

export async function buildStoryPromiseProfile(bookId, { force = false, signal, onEvent, data } = {}) {
  const book = store.books.get(bookId);
  if (!book) throw new Error('作品不存在');
  const settings = safeSettings(book);
  const status = storyPromiseStatus(bookId);
  if (!force && status.exists && !status.stale) return status.profile;
  const input = sourceInput(bookId, settings);
  onEvent?.({ type: 'opening_stage', step: 'profiling', detail: '提炼本书创作宪章' });
  let parsed = data;
  if (!parsed) {
    const route = settings.storyPromiseProfile?.texture?.route || (book.genre === '历史' ? 'serious_immersive_history' : 'general');
    const res = await runTask({
      bookId, task: 'story_promise', jsonMode: true, signal,
      messages: assembleMessages(bookId, [{ role: 'user', content: storyPromiseInstruction({
        book, contract: input.contract, outline: input.outline, pleasure: input.pleasure,
        world: input.world, cast: input.cast, eraContext: input.eraContext, characters: input.characters,
        platformGuidance: platformGuidanceText(book.platform),
        genreProfile: fanqieGenreProfileText(book.genre, route),
        authorLocks: settings.storyPromiseLocks || {},
      }) }]),
    });
    parsed = extractJSON(res.content);
  }
  let profile = applyLocks(validateProfile(parsed), settings.storyPromiseLocks || {});
  const fingerprint = storyPromiseFingerprint(bookId, settings);
  profile = { ...profile, version: 1, source_fingerprint: fingerprint, updated_at: Date.now() };
  settings.storyPromiseProfile = profile;
  store.books.update(bookId, { settings });
  onEvent?.({ type: 'opening_stage', step: 'profiled', detail: profile.primary_attraction_axis });
  return clone(profile);
}

export async function ensureStoryPromiseProfile(bookId, options = {}) {
  const status = storyPromiseStatus(bookId);
  if (status.exists && !status.stale && !options.force) return { ok: true, skipped: true, profile: status.profile };
  const openingN = Number(getGlobal()?.openingBlueprintChapters) || 20;
  // V0.102.1：开篇已过后角色库/书纲对齐造成的指纹漂移不再重写宪章——宪章是开书锁。
  if (!options.force && status.exists && completedMaxIdx(bookId) > openingN) {
    const book = store.books.get(bookId);
    const settings = safeSettings(book);
    if (status.stale && settings.storyPromiseProfile) {
      settings.storyPromiseProfile = {
        ...settings.storyPromiseProfile,
        source_fingerprint: storyPromiseFingerprint(bookId, settings),
        updated_at: Date.now(),
      };
      store.books.update(bookId, { settings });
    }
    return {
      ok: true,
      skipped: true,
      frozen: true,
      profile: clone(settings.storyPromiseProfile || status.profile),
    };
  }
  try {
    const profile = await buildStoryPromiseProfile(bookId, options);
    return { ok: true, profile };
  } catch (error) {
    if (error?.code === 'ABORTED' || error?.name === 'AbortError') throw error;
    return { ok: false, error: error?.message || String(error) };
  }
}

export function storyPromiseText(bookId) {
  const profile = storyPromiseStatus(bookId).profile;
  if (!profile) return '';
  return [
    '【本书创作宪章】',
    `一句承诺：${profile.premise_in_one_breath}`,
    `核心吸引轴：${profile.primary_attraction_axis}`,
    `主角行动方式：${profile.protagonist_now?.agency_pattern || ''}`,
    `近期回报：${(profile.payoff_ladder?.near || []).join('；')}`,
    `长期回报：${(profile.payoff_ladder?.long || []).join('；')}`,
    `禁止优化成：${(profile.anti_promises || []).join('；')}`,
  ].join('\n');
}

/** 供开篇/审校动态注入的精简文本；不进入公共历史前缀。 */
export function storyPromiseProfileText(profile) {
  if (!profile) return '';
  return [
    `一句承诺：${profile.premise_in_one_breath || ''}`,
    `核心吸引轴：${profile.primary_attraction_axis || ''}`,
    `主角当下：缺口=${profile.protagonist_now?.lack || ''}；需要=${profile.protagonist_now?.immediate_need || ''}；行动方式=${profile.protagonist_now?.agency_pattern || ''}`,
    `近期回报：${(profile.payoff_ladder?.near || []).join('；')}`,
    `中期回报：${(profile.payoff_ladder?.middle || []).join('；')}`,
    `长期回报：${(profile.payoff_ladder?.long || []).join('；')}`,
    `保护元素：${(profile.protected_elements || []).join('；')}`,
    `禁止优化方向：${(profile.anti_promises || []).join('；')}`,
  ].join('\n');
}
