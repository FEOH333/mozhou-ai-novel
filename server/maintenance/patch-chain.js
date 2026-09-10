'use strict';

function normalize(value) {
  return String(value || '').replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

export function applyAnchoredTextPatch(text, patch = {}) {
  const current = normalize(text);
  const old = normalize(patch.old);
  const next = normalize(patch.new);

  if (patch.replaceAll) {
    const expected = Number(patch.expectedCount);
    if (!old || !next || !Number.isInteger(expected) || expected < 1) {
      return { kind: 'failure', text: current, message: 'replaceAll 补丁缺少合法 expectedCount/old/new' };
    }
    const oldCount = current.split(old).length - 1;
    const newCount = current.split(next).length - 1;
    if (oldCount === 0 && newCount >= expected) return { kind: 'already', text: current };
    if (oldCount !== expected) {
      return { kind: 'failure', text: current, message: `全量锚点命中 ${oldCount} 次，预期 ${expected} 次` };
    }
    return { kind: 'apply', text: current.split(old).join(next) };
  }

  const oldCount = old ? current.split(old).length - 1 : 0;
  const insertLike = Boolean(old && next.includes(old));
  if (insertLike && current.includes(next)) return { kind: 'already', text: current };
  if (oldCount === 0 && current.includes(next)) return { kind: 'already', text: current };
  if (oldCount !== 1) return { kind: 'failure', text: current, message: `锚点命中 ${oldCount} 次` };
  return { kind: 'apply', text: current.replace(old, next) };
}

/**
 * Resolve an earlier patch that has been completely consumed by a satisfied
 * downstream patch. This makes chained maintenance patches idempotent without
 * treating an unrelated missing anchor as success.
 */
export function resolveSupersededPatchFailures(entries = [], { currentText = '', projectedText = '' } = {}) {
  const satisfied = new Set();
  const superseded = new Set();
  const candidates = [...new Set([normalize(currentText), normalize(projectedText)].filter(Boolean))];

  for (let index = 0; index < entries.length; index++) {
    if (entries[index]?.kind !== 'failure') satisfied.add(index);
  }

  for (let index = entries.length - 1; index >= 0; index--) {
    if (satisfied.has(index)) continue;
    const produced = normalize(entries[index]?.patch?.new);
    if (!produced) continue;

    // Project this patch's output through every later edit whose complete old
    // anchor occurs inside it. This proves that a large replacement survived
    // even when a later polish patch changed one sentence within that output.
    let projected = produced;
    let evolved = false;
    for (let later = index + 1; later < entries.length; later++) {
      const old = normalize(entries[later]?.patch?.old);
      const next = normalize(entries[later]?.patch?.new);
      const occurrenceCount = old ? projected.split(old).length - 1 : 0;
      if (!occurrenceCount) continue;
      if (entries[later]?.patch?.replaceAll) {
        // expectedCount belongs to the whole scene. An earlier replacement may
        // produce only one of those occurrences, so project every occurrence
        // inside this fragment after the scene-wide rename itself was proven.
        projected = projected.split(old).join(next);
      } else {
        if (occurrenceCount !== 1) continue;
        projected = projected.replace(old, next);
      }
      evolved = true;
    }
    // currentText proves an idempotent second run; projectedText proves the
    // same lineage while a later pending patch (for example a global rename)
    // is also being simulated in this run.
    if (evolved && projected.length >= 12 && candidates.some(text => text.includes(projected))) {
      satisfied.add(index);
      superseded.add(index);
      continue;
    }

    for (let later = index + 1; later < entries.length; later++) {
      if (!satisfied.has(later)) continue;
      const consumed = normalize(entries[later]?.patch?.old);
      if (!consumed || !consumed.includes(produced)) continue;
      satisfied.add(index);
      superseded.add(index);
      break;
    }
  }

  return {
    supersededIndices: [...superseded].sort((a, b) => a - b),
    unresolvedIndices: entries
      .map((_, index) => index)
      .filter(index => !satisfied.has(index)),
  };
}
