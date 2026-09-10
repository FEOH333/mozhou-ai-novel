// tests/pipeline-helper.js —— 端到端测试环境：mock LLM + 临时数据目录
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-e2e-'));
process.env.NOVEL_MOCK_LLM = '1';
