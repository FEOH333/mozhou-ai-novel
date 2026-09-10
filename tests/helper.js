// tests/helper.js —— 测试环境：临时数据目录（必须在 import store 之前加载）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-test-'));
process.env.NOVEL_DATA_DIR = TEST_DATA;
export const tmp = (name) => path.join(TEST_DATA, name);
