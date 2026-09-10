// V0.109.1 密钥环境变量：磁盘不再需要明文 API Key，且环境变量注入的密钥绝不回写磁盘。
// 背景：开源版发布审计发现 data/config.json 长期以明文保存两把真实 Key——
// 一旦该目录被同步/备份/截图就会泄漏。改为环境变量优先，并封住"保存设置时把
// 内存中的环境变量密钥序列化回 config.json"这条隐蔽回写路径。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 每个用例独立数据目录 + 独立模块实例（getGlobal 有内存缓存，必须换 URL 重新加载）
async function freshConfig({ disk = null, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1091-secret-'));
  if (disk) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(disk, null, 2));
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  process.env.NOVEL_DATA_DIR = dir;
  const url = pathToFileURL(path.join(process.cwd(), 'server/config.js')).href + `?t=${Math.random()}`;
  const mod = await import(url);
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 文件锁 */ }
  };
  return { mod, dir, restore };
}

describe('V0.109.1 密钥环境变量', () => {
  test('未设环境变量时零影响：沿用 config.json 的 apiKey（老用户不被打断）', async () => {
    const { mod, restore } = await freshConfig({ disk: { apiKey: 'sk-from-disk', baseUrl: 'https://a.example' } });
    try {
      const g = mod.getGlobal();
      assert.equal(g.apiKey, 'sk-from-disk');
      assert.equal(g.baseUrl, 'https://a.example');
    } finally { restore(); }
  });

  test('NOVEL_API_KEY 覆盖磁盘密钥；未涉及的字段不动', async () => {
    const { mod, restore } = await freshConfig({
      disk: { apiKey: 'sk-from-disk', baseUrl: 'https://a.example' },
      env: { NOVEL_API_KEY: 'sk-from-env' },
    });
    try {
      const g = mod.getGlobal();
      assert.equal(g.apiKey, 'sk-from-env', '环境变量优先');
      assert.equal(g.baseUrl, 'https://a.example', '其余字段不受影响');
    } finally { restore(); }
  });

  test('空字符串/空白环境变量不算覆盖（避免误清空成空 Key）', async () => {
    const { mod, restore } = await freshConfig({
      disk: { apiKey: 'sk-from-disk' },
      env: { NOVEL_API_KEY: '   ' },
    });
    try {
      assert.equal(mod.getGlobal().apiKey, 'sk-from-disk');
    } finally { restore(); }
  });

  test('NOVEL_BACKUP_API_KEY 覆盖备用端点密钥，主端点不受影响', async () => {
    const { mod, restore } = await freshConfig({
      disk: { apiKey: 'sk-main-disk', backup: { enabled: true, apiKey: 'sk-backup-disk' } },
      env: { NOVEL_BACKUP_API_KEY: 'sk-backup-env' },
    });
    try {
      const g = mod.getGlobal();
      assert.equal(g.apiKey, 'sk-main-disk');
      assert.equal(g.backup.apiKey, 'sk-backup-env');
      assert.equal(g.backup.enabled, true, '备用端点其余配置保留');
    } finally { restore(); }
  });

  test('saveGlobal 绝不把环境变量密钥回写磁盘（防"点一下保存就落盘"）', async () => {
    const { mod, dir, restore } = await freshConfig({
      disk: { apiKey: '', baseUrl: 'https://a.example' },
      env: { NOVEL_API_KEY: 'sk-secret-from-env' },
    });
    try {
      assert.equal(mod.getGlobal().apiKey, 'sk-secret-from-env', '内存中生效');
      mod.saveGlobal({ contextBudgetTokens: 123456 }); // 改一个无关字段
      const written = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
      assert.ok(!written.includes('sk-secret-from-env'),
        `磁盘不得出现环境变量密钥，实得：${written.slice(0, 300)}`);
      assert.equal(JSON.parse(written).contextBudgetTokens, 123456, '无关字段正常落盘');
    } finally { restore(); }
  });

  test('saveGlobal 落盘后内存仍以环境变量为准（不被磁盘空值回冲）', async () => {
    const { mod, restore } = await freshConfig({
      disk: { apiKey: 'sk-old-disk' },
      env: { NOVEL_API_KEY: 'sk-secret-from-env' },
    });
    try {
      mod.saveGlobal({ contextBudgetTokens: 999 });
      assert.equal(mod.getGlobal().apiKey, 'sk-secret-from-env', '保存后仍用环境变量');
    } finally { restore(); }
  });

  test('未设环境变量时 saveGlobal 按原样落盘（回归：不误伤原有行为）', async () => {
    const { mod, dir, restore } = await freshConfig({
      disk: { apiKey: 'sk-user-typed' },
      env: { NOVEL_API_KEY: undefined },
    });
    try {
      mod.saveGlobal({ contextBudgetTokens: 555 });
      const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
      assert.equal(written.apiKey, 'sk-user-typed', '用户手填的 Key 应正常持久化');
      assert.equal(written.contextBudgetTokens, 555);
    } finally { restore(); }
  });

  test('备用端点密钥同样不回写磁盘', async () => {
    const { mod, dir, restore } = await freshConfig({
      disk: { apiKey: 'sk-main', backup: { enabled: true, apiKey: '' } },
      env: { NOVEL_BACKUP_API_KEY: 'sk-backup-secret' },
    });
    try {
      mod.saveGlobal({ maxReviseRounds: 5 });
      const written = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
      assert.ok(!written.includes('sk-backup-secret'), '备用密钥不得落盘');
      assert.equal(JSON.parse(written).maxReviseRounds, 5);
    } finally { restore(); }
  });
});
