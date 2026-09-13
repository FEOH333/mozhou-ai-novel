// web/js/views/changelog.js —— 更新日志（只读观察面）
// 单一真源在仓库根 CHANGELOG.md，本视图只做渲染，不在前端维护第二份日志。
'use strict';
import { get } from '../api.js';
import { el, pageHead, emptyState } from '../ui.js';

/** 类别 → 标签色，未识别的类别用中性色 */
const CATEGORY_KIND = {
  '新增': 'ok',
  '变更': 'info',
  '修复': 'warn',
  '移除': 'muted',
  '安全': 'danger',
};

export async function renderChangelog(view) {
  const data = await get('/api/changelog').catch(() => null);
  const versions = data?.versions || [];

  view.append(pageHead(
    'icon:list:更新日志',
    '记录所有值得用户注意的变更。单一真源在仓库根 CHANGELOG.md，此处只读渲染。',
  ));

  if (!versions.length) {
    view.append(emptyState('fileText', '暂无更新日志', data?.error || 'CHANGELOG.md 为空或不可读。'));
    return;
  }

  for (const v of versions) {
    const pending = v.version === '未发布';
    const head = el('div', { class: 'row', style: 'align-items:baseline;gap:8px' },
      el('h3', { style: 'margin:0', text: pending ? '未发布' : `v${v.version}` }),
      v.date ? el('span', { class: 'small muted', text: v.date }) : null,
      pending ? el('span', { class: 'tag', text: '开发中' }) : null,
    );

    const body = el('div', { class: 'mt' });
    for (const sec of v.sections || []) {
      const kind = CATEGORY_KIND[sec.title] || '';
      body.append(el('div', { class: 'mt' },
        el('div', {}, el('span', { class: `tag ${kind}`.trim(), text: sec.title })),
        el('ul', { style: 'margin:8px 0 0;padding-left:20px' },
          ...(sec.items || []).map(t => el('li', { class: 'small', style: 'margin:4px 0', text: t })),
        ),
      ));
    }

    view.append(el('div', { class: 'card' }, head, body));
  }
}
