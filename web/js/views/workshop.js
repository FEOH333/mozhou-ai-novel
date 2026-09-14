// V0.109.5：workshop.js 已拆分为 workshop/ 目录，本文件保留为薄桶以兼容既有导入路径
// （app.js 与 23 个测试直接引用本路径；改路径会把同步面放大到失控）。
// 实现见 ./workshop/ 下的 index(骨架) / pilot / chapter / publication / opening / shared。
'use strict';
export { renderWorkshop } from './workshop/index.js';
