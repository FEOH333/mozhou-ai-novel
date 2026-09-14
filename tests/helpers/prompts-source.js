// tests/helpers/prompts-source.js —— 提示词源码全文。
//
// V0.109.5：prompts.js（2672 行）拆为 prompts/ 目录后，原本 17 个测试里
// `readFileSync('server/engine/prompts.js')` 只会读到薄桶，断言失配。
//
// 这些断言的**语义**是"提示词源码包含 X"，与代码在哪个文件无关，
// 故拼接薄桶 + 全部子模块，语义与拆分前完全等价。
//
// ⚠️ 尤其是**负向断言**（doesNotMatch）：只读薄桶会让它们**恒真、防线静默失效**，
// 比报错更危险。必须用本函数读全文。
import fs from 'node:fs';
import path from 'node:path';

/** 拼接 prompts.js 薄桶 + prompts/ 下全部子模块 */
export function promptsSource() {
  const barrel = path.join(process.cwd(), 'server/engine/prompts.js');
  const dir = path.join(process.cwd(), 'server/engine/prompts');
  const parts = [];
  if (fs.existsSync(barrel)) parts.push(fs.readFileSync(barrel, 'utf8'));
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js')).sort()) {
      parts.push(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  }
  return parts.join('\n');
}

/** 单读某个子模块（需要精确定位时用；顺序/切片类断言必须用这个） */
export function promptsModule(name) {
  return fs.readFileSync(path.join(process.cwd(), 'server/engine/prompts', name), 'utf8');
}
