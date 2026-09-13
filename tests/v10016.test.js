// V0.100.16：返工落盘丢分段事故修复——绕过引擎的落盘把整章候选剥掉换行按场景写入，
// 每场景成一整段（实测 12 章实证：场景 800-1350 字零换行，候选存档本身 \n\n 分段完好）。
// 三道防线：①restoreSceneParagraphBreaks 从候选存档逐字找回分段（维护脚本主路径）；
// ②normalizeChapterParagraphs 对零换行长候选做对话感知确定性重分段（引擎闸愈合）；
// ③doctor 分段健康检测（>300 字零换行场景 = 形态损坏，观察面防线）。
'use strict';

import './helper.js';
import test from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../server/db/store.js');
const {
  restoreSceneParagraphBreaks,
  normalizeChapterParagraphs,
  applyValidatedChapterRewrite,
} = await import('../server/engine/quality/polish.js');
const { checkProseStructure, DEFAULTS } = await import('../server/maintenance/doctor.js');

const stripNl = (s) => String(s || '').replace(/[\r\n]+/g, '');

const TEMPLATE = [
 '主角把木尺压进泥里，叫何平记下土色和水痕。',
  '梁茂沿旧沟走了一遍，发现昨夜新添的木桩向北偏了半掌。',
  '“山道还没通，谁也不许催车。”梁茂按住铜锣，运料的人只得停在湿土外。',
  '晚饭前，短桥终于钉好，第一辆分载石车平稳越过旧沟。',
].join('\n\n');

test('V0.100.16 restoreSceneParagraphBreaks 从候选存档逐字找回被剥离的换行', () => {
 const flattened = ['主角把木尺压进泥里，叫何平记下土色和水痕。梁茂沿旧沟走了一遍，发现昨夜新添的木桩向北偏了半掌。', '“山道还没通，谁也不许催车。”梁茂按住铜锣，运料的人只得停在湿土外。晚饭前，短桥终于钉好，第一辆分载石车平稳越过旧沟。'];
  const restored = restoreSceneParagraphBreaks(TEMPLATE, flattened);
  assert.ok(restored, '合法子串场景必须恢复成功');
  assert.equal(restored.length, 2);
  // 恢复后：剥换行逐字一致 + 找回原始分段
  assert.equal(stripNl(restored[0]), stripNl(flattened[0]));
  assert.equal(stripNl(restored[1]), stripNl(flattened[1]));
  assert.ok(restored[0].includes('\n'), '场景内必须找回换行');
 assert.equal(restored[0], '主角把木尺压进泥里，叫何平记下土色和水痕。\n\n梁茂沿旧沟走了一遍，发现昨夜新添的木桩向北偏了半掌。');
});

test('V0.100.16 restoreSceneParagraphBreaks 幂等：已恢复文本再跑结果不变', () => {
  const once = restoreSceneParagraphBreaks(TEMPLATE, [
 '主角把木尺压进泥里，叫何平记下土色和水痕。梁茂沿旧沟走了一遍，发现昨夜新添的木桩向北偏了半掌。',
    '“山道还没通，谁也不许催车。”梁茂按住铜锣，运料的人只得停在湿土外。晚饭前，短桥终于钉好，第一辆分载石车平稳越过旧沟。',
  ]);
  const twice = restoreSceneParagraphBreaks(TEMPLATE, once);
  assert.deepEqual(twice, once);
});

test('V0.100.16 restoreSceneParagraphBreaks 场景非模板子串时失败关闭，绝不猜分段', () => {
  const bad = restoreSceneParagraphBreaks(TEMPLATE, ['这句话不在候选存档里，凭空出现的文字。']);
  assert.equal(bad, null);
  const disorder = restoreSceneParagraphBreaks(TEMPLATE, [
    '晚饭前，短桥终于钉好，第一辆分载石车平稳越过旧沟。',
 '主角把木尺压进泥里，叫何平记下土色和水痕。梁茂沿旧沟走了一遍，发现昨夜新添的木桩向北偏了半掌。',
  ]);
  assert.equal(disorder, null, '乱序场景（前段出现在模板后方）必须失败关闭');
});

test('V0.100.16 normalizeChapterParagraphs 对零换行长文做对话感知确定性重分段', () => {
  const flat = [
 '主角把木尺压进泥里，叫何平记下土色和水痕。',
    '梁茂沿旧沟走了一遍，发现昨夜新添的木桩向北偏了半掌。',
    '他把两份数字摆在同一张纸上，谁也不说话，各自去核自己的那段。',
    '“山道还没通，谁也不许催车。”',
    '梁茂按住铜锣，运料的人只得停在湿土外。',
    '晚饭前，短桥终于钉好，第一辆分载石车平稳越过旧沟，没有再压坏车板。',
    '何平在账上添了一笔，又在旁边画了个小小的勾，表示这条路今天走通了。',
    '他数了三息，火把走过坡脊的转角，把每个名字都记在同一张纸上。',
    '夜里落了点雨，土色深了一层，木尺压出的印子还在。',
    '梁茂回来时靴子上全是泥，他说北段的桩位也要照这个法子再量一遍。',
 '主角点头，把纸折好塞进怀里，说明天一早先走北段。',
    '火把灭了一支，又点起一支，坡上的影子换了一轮。',
  ].join('');
  const normalized = normalizeChapterParagraphs(flat);
  assert.equal(stripNl(normalized), stripNl(flat), '重分段只能加换行，不得改动任何字符');
  const paras = normalized.split(/\n+/).filter(Boolean);
  assert.ok(paras.length >= 3, `长文必须重分段（实际 ${paras.length} 段）`);
  assert.ok(paras.some((p) => p.startsWith('“')), '对话句必须独立成段');
});

test('V0.100.16 normalizeChapterParagraphs 已有分段的文本与短文本原样返回', () => {
  assert.equal(normalizeChapterParagraphs(TEMPLATE), TEMPLATE);
  const short = '他数了三息，火把走过坡脊的转角。';
  assert.equal(normalizeChapterParagraphs(short), short);
});

test('V0.100.16 applyValidatedChapterRewrite 引擎闸：零换行候选落库前自动重分段', () => {
  const book = store.books.create({ title: '分段闸测试', genre: '历史' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const chapter = store.chapters.create(book.id, volume.id, 1, { title: '闸', status: 'done', wordCount: 1000 });
  store.scenes.create(chapter.id, 1, { content: '旧稿第一场景。梁茂沿旧沟走了一遍。', status: 'done', targetWords: 600 });
  store.scenes.create(chapter.id, 2, { content: '旧稿第二场景。短桥终于钉好。', status: 'done', targetWords: 600 });

  const flatCandidate = [
 '主角把木尺压进泥里，叫何平记下土色和水痕。',
    '梁茂沿旧沟走了一遍，发现昨夜新添的木桩向北偏了半掌。',
    '“山道还没通，谁也不许催车。”',
    '梁茂按住铜锣，运料的人只得停在湿土外。',
    '晚饭前，短桥终于钉好，第一辆分载石车平稳越过旧沟，没有再压坏车板。',
  ].join('');
  const applied = applyValidatedChapterRewrite(book.id, chapter, flatCandidate);
  assert.equal(applied.ok, true, `零换行候选应被本地愈合后落库：${applied.message || ''}`);
  const scenes = store.scenes.list(chapter.id);
  for (const scene of scenes) {
    assert.ok(
      !(scene.content.length > DEFAULTS.paragraphBreakLostMinChars && !/[\r\n]/.test(scene.content)),
      `落库场景不得是超长无换行一坨（${scene.content.length} 字）`,
    );
  }
});

test('V0.100.16 doctor 分段健康检测：超长零换行场景报损坏，正常分段不误报', async () => {
  const book = store.books.create({ title: '分段体检测试', genre: '历史' });
  const volume = store.volumes.create(book.id, 1, { title: '第一卷' });
  const broken = store.chapters.create(book.id, volume.id, 1, { title: '坏章', status: 'done', wordCount: 1000 });
  store.scenes.create(broken.id, 1, {
 content: '主角把木尺压进泥里，叫何平记下土色和水痕。梁茂沿旧沟走了一遍，发现昨夜新添的木桩向北偏了半掌。他把两份数字摆在同一张纸上，谁也不说话，各自去核自己的那段。晚饭前，短桥终于钉好，第一辆分载石车平稳越过旧沟，没有再压坏车板。他数了三息，火把走过坡脊的转角，把每个名字都记在同一张纸上。夜里落了点雨，土色深了一层，木尺压出的印子还在。梁茂按住铜锣，运料的人只得停在湿土外。何平在账上添了一笔，又在旁边画了个小小的勾。雨脚越过东坡时，主角先把木尺压进泥里，再叫人把水痕描清楚。主角点头，把纸折好塞进怀里，说明天一早先走北段。火把灭了一支，又点起一支，坡上的影子换了一轮。他说北段的桩位也要照这个法子再量一遍，谁都别想蒙混过去。',
    status: 'done', targetWords: 600,
  });
  const healthy = store.chapters.create(book.id, volume.id, 2, { title: '好章', status: 'done', wordCount: 1000 });
  store.scenes.create(healthy.id, 1, { content: TEMPLATE, status: 'done', targetWords: 600 });

  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(process.env.NOVEL_DATA_DIR + '/novel.db', { readOnly: true });
  try {
    const chapters = [broken, healthy];
    const texts = new Map(chapters.map((c) => [c.id, store.chapters.fullText(c.id)]));
    const result = checkProseStructure(db, book.id, chapters, texts);
    assert.equal(result.paragraphBreaks.length, 1, '超长零换行场景必须报损坏');
    assert.equal(result.paragraphBreaks[0].chapterIdx, 1);
    assert.equal(result.ok, false);
  } finally {
    db.close();
  }
});
