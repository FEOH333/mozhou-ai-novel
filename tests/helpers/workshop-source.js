// tests/helpers/workshop-source.js —— 写作台源码全文。
//
// V0.109.5：workshop.js 拆为 workshop/ 目录后，原本 23 个测试里
// `readFileSync('web/js/views/workshop.js')` 只会读到 5 行薄桶，断言全部失配。
//
// 这些断言的**语义**是"写作台源码包含 X"，与代码在哪个文件无关。
// 所以这里把目录下所有子模块拼成全文，测试语义不变、也不需要逐个判断断言属于哪个文件。
import fs from 'node:fs';
import path from 'node:path';

/** 拼接 workshop/ 下全部子模块与薄桶自身的源码 */
export function workshopSource() {
  const barrelPath = path.join(process.cwd(), 'web/js/views/workshop.js');
  const dir = path.join(process.cwd(), 'web/js/views/workshop');
  const parts = [];
  if (fs.existsSync(barrelPath)) parts.push(fs.readFileSync(barrelPath, 'utf8'));
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js')).sort()) {
      parts.push(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  }
  return parts.join('\n');
}

/** 单读某个子模块（需要精确定位时用） */
export function workshopModule(name) {
  return fs.readFileSync(path.join(process.cwd(), 'web/js/views/workshop', name), 'utf8');
}
