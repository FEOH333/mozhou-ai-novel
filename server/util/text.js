// server/util/text.js —— 跨引擎复用的纯文本工具（不依赖 store/engine，避免循环导入）
// V0.93.1：收编 growth.js 与 world_expansion.js 的重复实现（lastChapterTail/extractVolumeTitle）
'use strict';

/**
 * 取最后一章摘要尾部（补救桥段上下文）。
 * @param {Array} chapters 已过滤（isCompletedChapter）并按 idx 升序的章节行
 * @param {(id:string)=>string} getSummary 摘要文本读取函数
 * @returns {string} `第N章《标题》：摘要前120字`；无完成章时为空串
 */
export function lastChapterTail(chapters, getSummary) {
  const last = chapters[chapters.length - 1];
  if (!last) return '';
  return `第${last.idx}章《${last.title}》：${String(getSummary(last.id) || '').slice(0, 120)}`;
}

/**
 * 按实际下一卷序号读取书纲标题；兼容“第10卷《…》”与旧“卷10《…》”格式。
 * @returns {string} 卷标题；未命中时为空串
 */
export function extractVolumeTitle(outlineText, volumeIdx) {
  if (!outlineText || !Number.isInteger(volumeIdx) || volumeIdx < 1) return '';
  const marker = `(?:第\\s*${volumeIdx}\\s*卷|卷\\s*${volumeIdx})`;
  const bracketed = String(outlineText).match(new RegExp(`${marker}\\s*[《〈]\\s*([^》〉\\n]{1,60})\\s*[》〉]`));
  if (bracketed) return bracketed[1].trim();
  const plain = String(outlineText).match(new RegExp(`${marker}\\s*[：:]?\\s*([^：:\\n]{1,60})`));
  return plain ? plain[1].trim() : '';
}

// ==================== V0.93.2 名称/期待描述模糊匹配单一实现 ====================
// 此前 namesMatch（生命周期台账）与 hookDescriptionsMatch（快感账本）分居两个引擎，
// 算法与边界各自演化。统一收编于此，原模块仅 re-export 保持兼容。

/** 通用名称归一化：去空白/标点/括号，小写化（弧线名/钩子名/伏笔名共用）。 */
export function normalizedName(value) {
  return String(value || '').replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]·—-]/g, '').toLowerCase();
}

/** 台账报告里的名称列表抽取（string | {name|desc|item|label} 混合数组）。 */
export function reportNames(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === 'string') return item.trim();
    return String(item?.name || item?.desc || item?.item || item?.label || '').trim();
  }).filter(Boolean);
}

/**
 * 短标签匹配（弧线/伏笔/钩子名）：归一化后精确相等，或双方 ≥6 字时一方包含另一方。
 * 语义与 V0.92 生命周期台账一致。
 */
export function namesMatch(left, right) {
  const a = normalizedName(left);
  const b = normalizedName(right);
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 6 && (a.includes(b) || b.includes(a)));
}

const HOOK_STOPWORDS = new Set([
  '主角', '本章', '读者', '终于', '开始', '已经', '继续', '出现', '发生', '进行', '一个', '这个',
  '那道', '如何', '为何', '什么', '是否', '计划', '兑现', '推进', '承接', '围观者',
]);

function semanticUnits(value) {
  const source = String(value || '').replace(/[^一-鿿A-Za-z0-9]/g, '');
  const units = new Set();
  for (const token of source.match(/[A-Za-z0-9]{2,}|[一-鿿]{2,6}/g) || []) {
    if (!HOOK_STOPWORDS.has(token)) units.add(token);
  }
  // 中文语序容易变化，用二/三字 n-gram 作为稳定的事件指纹。
  const zh = source.replace(/[^一-鿿]/g, '');
  for (const size of [3, 2]) {
    for (let i = 0; i + size <= zh.length; i++) {
      const gram = zh.slice(i, i + size);
      if (!HOOK_STOPWORDS.has(gram)) units.add(gram);
    }
  }
  return units;
}

/**
 * 期待描述允许换语序/同句改写，但必须共享足够多的具体事件指纹。
 * 语义与 V0.93 快感账本一致。
 */
export function hookDescriptionsMatch(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const ua = semanticUnits(a);
  const ub = semanticUnits(b);
  if (!ua.size || !ub.size) return false;
  let intersection = 0;
  for (const unit of ua) if (ub.has(unit)) intersection++;
  const smaller = Math.min(ua.size, ub.size);
  return intersection >= 4 && intersection / smaller >= 0.28;
}
