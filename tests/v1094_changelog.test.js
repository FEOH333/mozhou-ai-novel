// V0.109.4 更新日志：CHANGELOG.md 纯函数解析 + 接口接线 + 前端页面注册。
//
// 守三件事：
//   ① 解析器对真实 CHANGELOG.md 与边界输入都正确（含"维护说明不该被当成条目"）
//   ② 接口与前端已接线（源码断言，防实现被删而测试仍绿）
//   ③ 新增版本后解析器仍能识别（防止格式漂移导致页面空白）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const { parseChangelog } = await import(pathToFileURL(path.join(ROOT, 'server/util/changelog.js')));

describe('V0.109.4 更新日志', () => {

  // ---------- ① 解析器 ----------

  test('解析真实 CHANGELOG.md：识别版本、日期与类别条目', () => {
    const versions = parseChangelog(read('CHANGELOG.md'));
    assert.ok(versions.length >= 5, `应解析出多个版本（实际 ${versions.length}）`);

    const pending = versions[0];
    assert.equal(pending.version, '未发布', '第一条应为未发布');
    assert.equal(pending.date, '', '未发布不带日期');

    const v1093 = versions.find(v => v.version === '0.109.3');
    assert.ok(v1093, '应含 0.109.3');
    assert.match(v1093.date, /^\d{4}-\d{2}-\d{2}$/, '日期应为 YYYY-MM-DD');
    assert.ok(v1093.sections.some(s => s.title === '新增'), '应含「新增」类别');
    assert.ok(v1093.sections.every(s => Array.isArray(s.items)), '每个类别都有 items 数组');
    assert.ok(v1093.sections.flatMap(s => s.items).length > 0, '条目不应为空');
  });

  test('维护说明与链接定义不被当成条目（顶部说明区必须被忽略）', () => {
    const versions = parseChangelog(read('CHANGELOG.md'));
    const allItems = versions.flatMap(v => v.sections.flatMap(s => s.items));
    assert.ok(!allItems.some(t => t.includes('怎么维护')), '顶部维护说明不得成为条目');
    assert.ok(!allItems.some(t => t.includes('keepachangelog.com')), '链接定义不得成为条目');
  });

  test('边界输入不抛异常', () => {
    for (const input of ['', null, undefined, '没有标题的纯文本', '## 格式不对', '# 一级标题']) {
      assert.doesNotThrow(() => parseChangelog(input), `${JSON.stringify(input)} 不应抛`);
      assert.ok(Array.isArray(parseChangelog(input)), '恒返回数组');
    }
    assert.deepEqual(parseChangelog('# 标题\n正文\n- 游离条目'), [], '第一个版本标题之前的内容全部丢弃');
  });

  test('解析合成样本：多版本 / 多类别 / 无日期版本', () => {
    const md = [
      '# 日志',
      '',
      '## [未发布]',
      '### 新增',
      '- 甲',
      '- 乙',
      '',
      '## [1.2.3] - 2026-01-02',
      '### 修复',
      '- 丙',
      '### 安全',
      '- 丁',
      '',
      '## [1.0.0]',
      '### 变更',
      '- 戊',
    ].join('\n');
    const v = parseChangelog(md);
    assert.equal(v.length, 3);
    assert.deepEqual(v.map(x => x.version), ['未发布', '1.2.3', '1.0.0']);
    assert.equal(v[1].date, '2026-01-02');
    assert.equal(v[2].date, '', '无日期版本 date 为空串');
    assert.deepEqual(v[0].sections[0].items, ['甲', '乙']);
    assert.deepEqual(v[1].sections.map(s => s.title), ['修复', '安全']);
    assert.deepEqual(v[2].sections[0].items, ['戊']);
  });

  test('条目内的换行被压平，便于前端单行渲染', () => {
    const v = parseChangelog('## [1.0.0]\n### 新增\n- 第一行\n  续行内容\n');
    assert.equal(v[0].sections[0].items.length, 1, '续行属于同一条目');
    assert.match(v[0].sections[0].items[0], /第一行 续行内容/);
  });

  // ---------- ② 接线（源码断言） ----------

  test('接口已接线且解析器在 util（放 index.js 会因启动副作用无法单测）', () => {
    const idx = read('server/index.js');
    assert.match(idx, /route\('GET', '\/api\/changelog'/, '应注册 /api/changelog');
    assert.match(idx, /from '\.\/util\/changelog\.js'/, '应从 util 导入解析器');
    assert.match(idx, /readFileSync\(new URL\('\.\.\/CHANGELOG\.md', import\.meta\.url\)/, '应读仓库根 CHANGELOG.md');
    assert.doesNotMatch(idx, /export function parseChangelog/, '解析器不应再定义在 index.js');
  });

  test('前端页面已注册：导入、标题表、派发、导航四项齐全', () => {
    const app = read('web/js/app.js');
    assert.match(app, /import \{ renderChangelog \} from '\.\/views\/changelog\.js'/, '应导入视图');
    assert.match(app, /changelog: '更新日志'/, '应有页面标题');
    assert.match(app, /r\.name === 'changelog'\) await renderChangelog\(view\)/, '应派发到视图');
    assert.match(app, /navItem\('#\/changelog'/, '应有导航入口');
    assert.ok(fs.existsSync(path.join(ROOT, 'web/js/views/changelog.js')), '视图文件应存在');
  });

  test('视图只读渲染，不在前端维护第二份日志（单一真源）', () => {
    const view = read('web/js/views/changelog.js');
    assert.match(view, /get\('\/api\/changelog'\)/, '应走接口取数');
    assert.doesNotMatch(view, /##\s*\[0\./, '视图内不得硬编码版本条目');
  });

  // ---------- ③ 文件本身 ----------

  test('CHANGELOG.md 存在且含维护说明（否则后来者不知道怎么加条目）', () => {
    const md = read('CHANGELOG.md');
    assert.match(md, /##\s*\[未发布\]/, '必须有未发布段落供新增条目');
    assert.match(md, /怎么维护/, '必须写维护办法');
    assert.match(md, /Keep a Changelog/, '应声明遵循的格式');
  });
});
