// V0.105.5 末句完整性收口：超长输出被 maxTokens 掐断时字数常已达标，长度自愈只看
// 字数不看末句 →「…回荡在合州」式半句话落库（实测 ch45-50 实证，doctor
// proseStructure 报 boundaryFragments）。三道闸：autoHealSceneLength 开头（write/revise
// 共用入口）+ applyValidatedChapterRewrite / applyValidatedSceneRewrite 落库兜底。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v1055-trailing-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const polish = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/polish.js')));
const write = await import(pathToFileURL(path.join(ROOT, 'server/engine/pipeline/write.js')));

// 构造任意字数的正文段（以句号分句，可控制末句是否截断）
function prose(chars, { brokenTail = false } = {}) {
  const unit = '夜里的江风贴着水面吹过来，他把袖口收紧了些。';
  const n = Math.ceil(chars / unit.length);
  let text = unit.repeat(n);
  if (brokenTail) text += '远处传来晨钟的声音，沉闷，悠远，穿透了厚重的云层，回荡在合州';
  return text.slice(0, Math.max(chars, unit.length));
}

describe('V0.105.5 末句完整性收口', () => {
  test('①closeTrailingSentence：半句裁到完整句边界；合法收尾不动', () => {
    const broken = '他抬起头。屋内陷入了长久的沉默。远处传来晨钟的声音，回荡在合州';
    const closed = polish.closeTrailingSentence(broken);
    assert.ok(closed.endsWith('沉默。'), `应裁到最后一个完整句（实际结尾「${closed.slice(-12)}」）`);
    assert.equal(closed, broken.slice(0, broken.lastIndexOf('。') + 1), '只裁尾部残余，不动其余字符');
    // 合法收尾不动
    for (const ok of ['他说完便走了。', '“走了。”', '“走了”', '他停住了——', '夜还长……']) {
      assert.equal(polish.closeTrailingSentence(ok), ok.trimEnd(), `合法收尾不应被裁：${ok}`);
    }
    // 全文无句末标点：异常文本原样返回（不删光）
    const noPunct = '只有一段没有标点的文字';
    assert.equal(polish.closeTrailingSentence(noPunct), noPunct, '无句末标点时不得裁剪');
  });

  test('②autoHealSceneLength：字数达标区间内的截断半句被本地裁剪，不烧续写', async () => {
    const b = store.books.create({ title: '末句收口书', genre: '玄幻', blurb: 'x' });
    const ch = store.chapters.create(b.id, null, 1, { title: 'C1', status: 'planned' });
    const target = 1000; // min=850, max=1700
    const content = prose(target + 50, { brokenTail: true }); // 字数达标但末句截断
    const scene = { id: 'sc-fake', target_words: target, beat: 'b' };
    const heal = await write.autoHealSceneLength({ bookId: b.id, chapterId: ch.id, scene, content, autoHeal: true });
    assert.ok(heal.healed, '末句收口应标记 healed');
    assert.ok(heal.content.trimEnd().match(/[。！？…；”’」』]|——$/), `自愈后应以完整句收尾（实际「${heal.content.slice(-16)}」）`);
    assert.ok(!heal.content.includes('回荡在合州'), '截断半句必须被裁掉');
  });

  test('③applyValidatedSceneRewrite 落库闸：修订候选尾句被掐时确定性收口', () => {
    const b = store.books.create({ title: '末句收口书二', genre: '玄幻', blurb: 'x' });
    const ch = store.chapters.create(b.id, null, 1, { title: 'C1', status: 'planned' });
    store.scenes.create(ch.id, 1, { pov: '', location: '', beat: 'b', targetWords: 300, status: 'done', content: prose(400) });
    const [sc] = store.scenes.list(ch.id);
    const half = prose(400, { brokenTail: true });
    const applied = polish.applyValidatedSceneRewrite(b.id, sc.id, half, {});
    assert.ok(applied.ok, `落库闸应放行收口后的候选：${JSON.stringify(applied).slice(0, 200)}`);
    const stored = store.scenes.get(sc.id).content;
    assert.ok(!stored.includes('回荡在合州'), '落库正文不得残留截断半句');
    assert.ok(stored.trimEnd().match(/[。！？…；”’」』]|——$/), '落库正文应以完整句收尾');
  });

  test('④源码断言：三道闸全部接线', () => {
    const w = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/write.js'), 'utf8');
    const p = fs.readFileSync(path.join(ROOT, 'server/engine/quality/polish.js'), 'utf8');
    assert.ok(w.includes('closeTrailingSentence(content)'), 'autoHealSceneLength 开头应收口');
    assert.ok((p.match(/closeTrailingSentence\(normalizeChapterParagraphs/g) || []).length >= 2, '两个落库闸应收口');
  });
});
