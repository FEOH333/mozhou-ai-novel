import { createHash } from 'node:crypto';

export const sha256 = text => createHash('sha256').update(String(text || '')).digest('hex');

const rubricKeys = ['first_screen_clarity', 'protagonist_bond', 'causal_motion',
  'promise_alignment', 'chapter_one_independence', 'emotional_variety', 'structural_naturalness'];

export const validDiagnosis = {
  version: 3,
  cold_read: {
 protagonist: { answer: '主角，九岁的蜀中孩子', evidence: ['主角把弟弟往上颠了颠'] },
    immediate_want_or_danger: { answer: '护住家人；北边军情正在逼近', evidence: ['北边来信了'] },
    continue_question: { answer: '这家人能否躲过逼近的兵灾', evidence: ['天边暗红'] },
    attention_drop: [], speaker_confusion: [], artificial_or_ai_feel: [],
    strongest_axis: { kind: 'bond', reason: '家庭依恋具体成立' },
  },
  rubric: Object.fromEntries(rubricKeys.map(key => [key, { score: 3, evidence: ['第一章可核对引文'], cost: '' }])),
  hard_failures: [], issues: [],
  strategies: [{ kind: 'baseline', creative_hypothesis: '原稿亲情轴已成立', expected_gain: '无损基线', risks: [] }],
  recommendation: { kind: 'baseline', reason: '等待候选比较' },
};

export function validContract(targetVolumeId) {
  if (!targetVolumeId) throw new Error('测试契约必须使用真实卷ID');
  return {
    version: 1, promise_key: 'opening:1259-diaoyucheng-question',
 public_question: '主角如何从九岁流民走到钓鱼城头？',
    known_outcome: '读者知道1259年蒙古大汗会死于钓鱼城',
    forbidden_early_explanation: ['1259年前不得让人物预知蒙哥死法'],
    target_event_key: 'historical:1259:diaoyucheng-mongke-death', target_year: 1259,
    target_volume_id: targetVolumeId, status: 'open', fulfilled_chapter: null,
  };
}

export function coldOpenCandidate(targetVolumeId, overrides = {}) {
  return {
    kind: 'chapter1_cold_open', placement: 'prepend_chapter1', title: '',
    source_hash: sha256('第一章原文'), content: '城下忽然传来一声炮响。',
    contract_json: JSON.stringify(validContract(targetVolumeId)), status: 'candidate', ...overrides,
  };
}

export function prologueCandidate(targetVolumeId, overrides = {}) {
  return {
    ...coldOpenCandidate(targetVolumeId), kind: 'standalone_prologue', placement: 'before_chapter1',
    title: '楔子', content: '钓鱼城下，九斿白旗在风里绷紧。', ...overrides,
  };
}

export function createOpeningFixture(store) {
  const book = store.books.create({
    title: '开篇干预测试书', genre: '历史', platform: '番茄',
    blurb: '九岁流民四十年后站上钓鱼城头。',
  });
  const openingVolume = store.volumes.create(book.id, 1, { title: '第一卷', outline: { year: 1241 } });
  const volume = store.volumes.create(book.id, 2, {
    title: '城头卷', outline: { year: 1259, event_keys: ['historical:1259:diaoyucheng-mongke-death'] },
  });
  const chapter = store.chapters.create(book.id, openingVolume.id, 1, { title: '庙会灯影', status: 'done' });
  const firstScene = store.scenes.create(chapter.id, 1, {
 beat: '军情逼近', content: '天边压着一线暗红。主角把弟弟往上颠了颠。', status: 'done',
  });
  return { book, volume, chapter, firstScene };
}

export function createSampleOpeningFixture(store) {
  const book = store.books.create({
 title: '示例历史长篇', genre: '历史', platform: '番茄',
    blurb: '九岁流民十八年后站上钓鱼城头，见证蒙古大汗死于此地。',
  });
  const titles = ['故园成灰', '灰烬生根', '军旗下', '北望', '城头初望'];
  const volumes = titles.map((title, offset) => store.volumes.create(book.id, offset + 1, {
    title,
    outline: offset === 4
      ? { year: 1259, event_keys: ['historical:1259:diaoyucheng-mongke-death'] }
      : offset === 0
        ? { year: 1241, chapters: [{ year: 1241, protagonist_age: 9 }] }
        : { year: 1241 + offset * 4 },
  }));
  const chapter = store.chapters.create(book.id, volumes[0].id, 1, { title: '庙会灯影', status: 'done' });
  const firstScene = store.scenes.create(chapter.id, 1, {
    beat: '军情逼近',
 content: '天边压着一线暗红。主角把弟弟往上颠了颠。糖兔子硌着手心，父亲的短猎刀藏在近旁，母亲绣着“安”字的护身符贴着胸口。后来他曾跪求宋军回头，却没有人回头。',
    status: 'done',
  });
  return { book, volumes, chapter, firstScene, targetVolume: volumes[4] };
}
