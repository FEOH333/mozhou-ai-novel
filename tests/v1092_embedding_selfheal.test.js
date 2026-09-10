// V0.109.2：embedding 本地缓存损坏自愈。
//
// 存在的理由：transformers.js 在「本地缓存文件损坏」与「网络下载失败」两种
// 情况下抛出的是同一句话（Load model from <本地路径> failed: ...）。
// 若不区分，缓存一旦写坏（下载中断、磁盘满、强杀进程），用户会永久停留在
// 「已降级为关键词检索」——换几个模型源都没用，因为所有源读的都是同一个
// 坏文件。实测：损坏缓存让三个源在 164ms 内依次报同一条 Protobuf 错误。
//
// 本测试锁住两件事：
//   1. 损坏缓存被删除，且删除范围严格限定在 transformers 缓存目录内；
//   2. 非缓存路径 / 非模型后缀 / 无路径的错误，一律不动任何文件（防误删）。
'use strict';

import './helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { embeddingSelfHeal } = await import('../server/memory/embedding.js');

/** 在真实缓存目录下开一个临时子目录，用完即删——护栏要求路径确实在缓存内。 */
function withCacheFixture(name, fn) {
  const root = embeddingSelfHeal.cacheDir();
  assert.ok(root, '应能定位到 transformers 缓存目录');
  const dir = path.join(root, 'Xenova', name);
  fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true });
  try {
    return fn({ root, dir, model: path.join(dir, 'onnx', 'model.onnx') });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('损坏的模型缓存文件会被删除（自愈只做删除，不做下载）', () => {
  withCacheFixture('v1092-heal', ({ root, model }) => {
    fs.writeFileSync(model, Buffer.from('not a real onnx file'));
    const err = new Error(`Load model from ${model} failed:Protobuf parsing failed.`);

    const removed = embeddingSelfHeal.tryRemoveCorruptCacheFile(err.message, root);

    assert.equal(removed, path.resolve(model), '应返回被删除文件的绝对路径');
    assert.equal(fs.existsSync(model), false, '损坏文件必须已被删除');
  });
});

test('Protobuf parsing failed 被识别为缓存损坏', () => {
  assert.equal(
    embeddingSelfHeal.isCorruptCacheError('Load model from /x/model.onnx failed:Protobuf parsing failed.'),
    true,
  );
});

test('文件名不存在（上次下载中断）也算缓存损坏', () => {
  assert.equal(
    embeddingSelfHeal.isCorruptCacheError('Load model from /x/model.onnx failed:file does not exist.'),
    true,
  );
});

test('纯网络错误不被误判为缓存损坏', () => {
  assert.equal(embeddingSelfHeal.isCorruptCacheError('fetch failed'), false);
  assert.equal(embeddingSelfHeal.isCorruptCacheError('ENOTFOUND huggingface.co'), false);
  assert.equal(embeddingSelfHeal.isCorruptCacheError('The operation was aborted'), false);
});

test('缓存目录之外的文件绝不被删除（防误删护栏）', () => {
  withCacheFixture('v1092-outside', ({ root, dir, model }) => {
    fs.writeFileSync(model, 'cache file');
    const outside = path.join(os.tmpdir(), `v1092-outside-${Date.now()}.onnx`);
    fs.writeFileSync(outside, 'user data');
    try {
      const err = new Error(`Load model from ${outside} failed:Protobuf parsing failed.`);
      const removed = embeddingSelfHeal.tryRemoveCorruptCacheFile(err.message, root);
      assert.equal(removed, null, '目录外文件必须拒删');
      assert.equal(fs.existsSync(outside), true, '目录外文件必须原封不动');
    } finally {
      fs.rmSync(outside, { force: true });
    }
    assert.equal(fs.existsSync(model), true, '不应波及缓存内的其他文件');
    assert.equal(fs.existsSync(dir), true, '缓存子目录本身必须保留');
  });
});

test('缓存目录的兄弟目录（同前缀路径）不被误判为在缓存内', () => {
  withCacheFixture('v1092-sibling', ({ root }) => {
    // 构造 `${root}-evil/` 这种同前缀兄弟目录，验证用的是分隔符比较而非裸 startsWith
    const sibling = `${root}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    const victim = path.join(sibling, 'model.onnx');
    fs.writeFileSync(victim, 'must survive');
    try {
      const err = new Error(`Load model from ${victim} failed:Protobuf parsing failed.`);
      assert.equal(embeddingSelfHeal.tryRemoveCorruptCacheFile(err.message, root), null,
        '同前缀兄弟目录必须拒删');
      assert.equal(fs.existsSync(victim), true, '文件必须存活');
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });
});

test('非模型后缀不删（即使路径在缓存目录内）', () => {
  withCacheFixture('v1092-stray', ({ root, dir }) => {
    const stray = path.join(dir, 'notes.txt');
    fs.writeFileSync(stray, 'irreplaceable');
    const err = new Error(`Load model from ${stray} failed:Protobuf parsing failed.`);
    assert.equal(embeddingSelfHeal.tryRemoveCorruptCacheFile(err.message, root), null);
    assert.equal(fs.existsSync(stray), true, '非模型后缀不得被删除');
  });
});

test('错误信息里没有路径时不做任何事', () => {
  assert.equal(
    embeddingSelfHeal.tryRemoveCorruptCacheFile('Protobuf parsing failed', os.tmpdir()),
    null,
  );
  assert.equal(embeddingSelfHeal.tryRemoveCorruptCacheFile('', os.tmpdir()), null);
  assert.equal(embeddingSelfHeal.tryRemoveCorruptCacheFile(null, os.tmpdir()), null);
});

test('缓存目录不存在时静默返回 null，不抛异常', () => {
  const missing = path.join(os.tmpdir(), 'v1092-definitely-missing-' + Date.now());
  const err = new Error(`Load model from ${path.join(missing, 'model.onnx')} failed:Protobuf parsing failed.`);
  assert.doesNotThrow(() => {
    assert.equal(embeddingSelfHeal.tryRemoveCorruptCacheFile(err.message, missing), null);
  });
});

test('源码断言：initEmbedding 的失败分支确实接线了自愈（防止实现被删而测试仍绿）', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'memory', 'embedding.js'),
    'utf8',
  );
  // 自愈必须发生在每个 host 的 catch 分支里，且只允许触发一次
  assert.match(src, /if \(!healedCorruptCache && CORRUPT_CACHE_PATTERN\.test/,
    'catch 分支必须调用 CORRUPT_CACHE_PATTERN 判定');
  assert.match(src, /healedCorruptCache = true/, '自愈后必须置位，避免反复删除');
  assert.match(src, /已删除并重新下载/, '必须留下可诊断的日志');
});

test('模块加载时不再因为缺少 fs/path/url 的 import 而失败', async () => {
  // 若上面三个 import 缺失，本文件顶部的 await import 就已经炸了；
  // 这里再显式确认导出形状，防止被误删。
  const mod = await import('../server/memory/embedding.js');
  assert.equal(typeof mod.initEmbedding, 'function');
  assert.equal(typeof mod.embed, 'function');
  assert.equal(typeof mod.embeddingSelfHeal.tryRemoveCorruptCacheFile, 'function');
  assert.equal(typeof mod.embeddingSelfHeal.cacheDir, 'function');
});