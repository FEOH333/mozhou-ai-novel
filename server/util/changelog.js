// server/util/changelog.js —— CHANGELOG.md 解析（纯函数）
//
// 单独成模块的原因：放在 index.js 里就无法单测——index.js 是入口，
// import 它有启动 HTTP 服务的副作用。纯函数移到 util 才能被测试直接调用。
'use strict';

/**
 * 解析 Keep a Changelog 风格的 markdown 为版本数组。
 *
 * 只认两类标题：
 *   `## [x.y.z] - YYYY-MM-DD` 或 `## [未发布]`  → 版本
 *   `### 类别`（新增/变更/修复/移除/安全）      → 类别
 * 其余内容（维护说明、引用块、链接定义）一律忽略——这是刻意的：
 * 日志顶部要写"怎么维护"，那些文字不该被当成条目渲染。
 *
 * @returns {Array<{version: string, date: string, sections: Array<{title: string, items: string[]}>}>}
 */
export function parseChangelog(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const versions = [];
  let cur = null;
  let category = null;

  const flush = () => { if (cur) versions.push(cur); };

  for (const line of lines) {
    const h2 = line.match(/^##\s+\[([^\]]+)\](?:\s*-\s*(.+))?\s*$/);
    if (h2) {
      flush();
      cur = { version: h2[1].trim(), date: (h2[2] || '').trim(), sections: [] };
      category = null;
      continue;
    }
    if (!cur) continue; // 第一个版本标题之前的内容（维护说明等）全部丢弃

    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      category = { title: h3[1].trim(), items: [] };
      cur.sections.push(category);
      continue;
    }

    const item = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (item && category) {
      category.items.push(item[1].replace(/\s+/g, ' ').trim());
      continue;
    }

    // 续行：非空、非标题、非新条目 → 归到上一条目。
    // 支持多行条目是为了"易维护"——写日志的人不该因为换行就丢内容。
    const text = line.trim();
    if (text && category && category.items.length
      && !/^#{1,6}\s/.test(text) && !/^\[[^\]]+\]:/.test(text)) {
      const last = category.items.length - 1;
      category.items[last] = `${category.items[last]} ${text}`.replace(/\s+/g, ' ').trim();
    }
  }

  flush();
  return versions;
}
