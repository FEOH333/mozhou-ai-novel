// V0.109.5：prompts.js 已按用途拆至 prompts/ 目录，本文件保留为薄桶以兼容既有导入路径
// （server 各引擎与 75 个测试直接引用本路径）。约 70 个导出名保持不变。
//
// ⚠️ 缓存前缀在 ./prompts/prefix.js —— 动它会让所有用户的 prompt cache 失效，改前先读该文件抬头注释。
'use strict';
export * from './prompts/prefix.js';
export * from './prompts/common.js';
export * from './prompts/planning.js';
export * from './prompts/opening.js';
export * from './prompts/audit.js';
export * from './prompts/write.js';
export * from './prompts/recovery.js';
