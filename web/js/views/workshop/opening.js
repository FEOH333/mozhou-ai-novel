// 由 workshop.js 拆分而来（V0.109.5）。只搬不改：函数体与拆分前逐字节一致。
'use strict';

import { get, post, patch, put, del, sse, openingApi, publicationApi, narrativeApi, writeApi } from '../api.js';
import { el, toast, confirmDialog, openModal, icon, fmt, fmtTokens, fmtMoney, fmtPct, esc, pageHead, progressCard, CHAPTER_STATUS, CHAPTER_STATUS_TAG, chapterStatusLabel } from '../ui.js';
import { state, refreshBook, refreshGlobal, rerender, registerSSE, unregisterSSE } from '../app.js';
import {
  openingDiagnosisSummary,
  openingDiagnosisFailureMessage,
  openingDiagnosisProgressMessage,
  openingComposeProgressMessage,
} from '../opening-status.js';

import {
  metricValue,
} from './publication.js';

const OPENING_KIND_NAME = {
  head_rewrite: '顺叙强化',
  chapter1_cold_open: '第一章内嵌楔子',
  standalone_prologue: '独立楔子',
};

/** V0.98：创作决策台先讲作品与候选的创作理由，哈希/模型/快照折叠到技术详情。 */

/** V0.98：创作决策台先讲作品与候选的创作理由，哈希/模型/快照折叠到技术详情。 */
export async function renderOpeningDecisionCard(book) {
  const [promise, diagnosis, assetPack, publish] = await Promise.all([
    openingApi.storyPromise(book.id).catch(() => ({ exists: false, stale: true, locks: {} })),
    openingApi.diagnosis(book.id).catch(() => ({ exists: false, stale: true })),
    openingApi.assets(book.id).catch(() => ({ assets: [], active: null })),
    openingApi.publishPatch(book.id).catch(() => ({ changed: false })),
  ]);
  const assets = assetPack.assets || [];
  const profile = promise.profile || null;
  const profileStatus = el('div', { class: 'small muted mt', role: 'status', 'aria-live': 'polite' });
  const status = el('div', {
    id: 'opening-action-status', class: 'small muted mt', role: 'status', 'aria-live': 'polite',
    text: '生成会依次构思、写作、审校和匿名比较，通常需数分钟；可切页去读，进度会保留。',
  });
  const body = el('div', { class: 'fold-body' });
  const hasText = (book.chapters || []).some(chapter => Number(chapter.word_count) > 0);
  const refresh = async message => {
    if (message) toast(message, 'success');
    if (state.book?.id === book.id) { await refreshBook(); rerender(); }
  };
  const run = async (button, fn, { onError } = {}) => {
    button.disabled = true;
    try { return await fn(); }
    catch (error) {
      onError?.(error);
      toast(error.message, 'error');
      return null;
    }
    finally { button.disabled = false; }
  };

  body.append(
    el('div', { class: 'card', style: 'margin-top:0' },
      el('div', { class: 'small muted', text: '本书靠什么吸引人' }),
      el('div', { style: 'font-size:15px;font-weight:700;margin:4px 0', text: profile?.primary_attraction_axis || '尚未建立本书创作宪章' }),
      profile ? el('div', { class: 'small', text: `一句承诺：${profile.premise_in_one_breath || '—'}` }) : null,
      profile ? el('div', { class: 'small', text: `禁止优化成：${(profile.anti_promises || []).join('；') || '未设置'}` }) : null,
      el('div', { class: 'small muted mt', text: `作者锁：${Object.keys(promise.locks || {}).join('、') || '尚无'}。锁定后重建画像也会保留。` }),
      el('div', { class: 'row mt', style: 'gap:8px;flex-wrap:wrap' },
        el('button', { class: 'sm primary', text: profile ? '重建创作宪章' : '建立创作宪章', onclick: ev => run(ev.currentTarget, async () => {
          profileStatus.textContent = '正在理解本书的独特承诺…';
          await openingApi.rebuildStoryPromise(book.id);
          await refresh('创作宪章已建立');
        }) }),
        profile ? el('button', { class: 'sm ghost', text: '锁定当前题材路线', onclick: ev => run(ev.currentTarget, async () => {
          await openingApi.lockStoryPromise(book.id, { 'texture.route': profile.texture?.route || 'general' });
          await refresh('当前题材路线已锁定');
        }) }) : null,
      ),
      profileStatus,
    ),
  );

  const diagnosisText = openingDiagnosisSummary(diagnosis);
  body.append(el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('div', { class: 'grow' },
        el('b', { text: '正文证据诊断' }),
        el('div', { class: 'small muted', text: diagnosisText }),
      ),
      el('button', { class: 'sm ghost', text: '精读诊断', onclick: ev => run(ev.currentTarget, async () => {
        const startedAt = Date.now();
        const updateProgress = () => {
          status.textContent = openingDiagnosisProgressMessage(Date.now() - startedAt);
        };
        updateProgress();
        const progressTimer = setInterval(updateProgress, 1_000);
        try {
          await openingApi.runDiagnosis(book.id);
          await refresh('开篇诊断完成');
        } finally {
          clearInterval(progressTimer);
        }
      }, { onError: error => { status.textContent = openingDiagnosisFailureMessage(error); } }) }),
      el('button', { class: 'sm primary', text: hasText ? '生成并比较开篇方案' : '预演第一章方案', onclick: ev => {
        const button = ev.currentTarget;
        return run(button, async () => {
          const originalText = button.textContent;
          button.textContent = '方案生成中…';
          const startedAt = Date.now();
          let latestDetail = '正在构思不同的开篇进入逻辑';
          const updateProgress = () => {
            status.textContent = openingComposeProgressMessage({
              detail: latestDetail, elapsedMs: Date.now() - startedAt,
            });
          };
          updateProgress();
          const progressTimer = setInterval(updateProgress, 1_000);
          const ctrl = registerSSE();
          try {
            const result = await openingApi.compose(book.id, {
              mode: hasText ? 'repair' : 'create', autoPrepare: true, autoCompare: true,
            }, (_event, data) => {
              if (data.detail) latestDetail = data.detail;
              updateProgress();
            }, ctrl.signal);
            const compared = result.comparison?.status;
            const suffix = compared === 'stable_winner' ? '；两轮匿名比较得到稳定胜者'
              : compared === 'single_model_advisory' ? '；同模型判断仅供参考'
                : compared ? '；没有稳定胜者，建议保留原稿' : '；候选已生成';
            toast(`已生成 ${result.candidates || 0} 个方案${suffix}`, 'success');
            await refresh();
          } finally {
            clearInterval(progressTimer);
            unregisterSSE(ctrl);
            button.textContent = originalText;
          }
        }, { onError: error => {
          status.textContent = error?.name === 'AbortError'
            ? '方案生成已停止；未完成的候选不会写入正文。'
            : `方案生成失败：${error?.message || error}`;
        } });
      } }),
    ),
    el('div', { class: 'small muted mt', text: '原稿会匿名参与比较；没有稳定胜者时，工具明确建议“不改”。模型冷读是模拟判断，不冒充真实留存或平台结果。' }),
    status,
  ));

  const comparable = assets.filter(asset => asset.status === 'audited' && asset.freshness?.fresh);
  const candidatesCard = el('div', { class: 'card' },
    el('div', { class: 'row' },
      el('h3', { class: 'grow', style: 'margin:0', text: '可读候选' }),
      comparable.length ? el('button', { class: 'sm ghost', text: '两轮匿名比较', onclick: ev => run(ev.currentTarget, async () => {
        const result = await openingApi.compareOpeningAssets(book.id, comparable.map(asset => asset.id));
        // V0.98.11：优先用服务端可读结论——同模型两轮同胜者提示「可手动采用」，不再误读为失败
        const message = result.message || (result.status === 'stable_winner' ? `稳定胜者：${OPENING_KIND_NAME[result.winner?.kind] || '原稿'}`
          : result.status === 'single_model_advisory' ? '同模型判断仅供参考，不会自动应用'
            : '两轮结论不一致，建议保留原稿');
        toast(message, result.status === 'stable_winner' ? 'success' : 'info', 8000);
        await refresh();
      }) }) : null,
    ),
  );
  if (!assets.length) candidatesCard.append(el('div', { class: 'small muted mt', text: '还没有存量开篇候选。先运行诊断，再生成方案。' }));
  for (const asset of assets) {
    const name = OPENING_KIND_NAME[asset.kind] || asset.kind;
    const audit = asset.audit || {};
    const comparison = asset.rank?.comparison || {};
    const auditBlockers = [
      ...(Array.isArray(audit.hard_failures) ? audit.hard_failures : []),
      ...(Array.isArray(audit.issues) ? audit.issues.filter(issue => issue?.severity === 'high') : []),
    ];
    const freshness = asset.freshness?.fresh ? '当前有效' : `已过期：${asset.freshness?.reason || '输入变化'}`;
    const actions = [];
    if (asset.status === 'audited' && !auditBlockers.length) actions.push(el('button', { class: 'sm primary', text: '采用此方案', onclick: async ev => {
      // V0.98.12：async 处理器必须同步捕获按钮（await confirmDialog 后 currentTarget 已被清空为 null）
      const btn = ev.currentTarget;
      if (!await confirmDialog(`采用“${name}”？`, '工具会先保存快照。顺叙强化只改精确锚点；内嵌楔子只改变读者发布视图，不进入后续人物记忆。')) return;
      await run(btn, async () => {
        await openingApi.selectOpeningAsset(book.id, asset.id);
        await openingApi.applyOpeningAsset(book.id, asset.id);
        await refresh(`${name}已应用；可在下方查看完整发布差异`);
      });
    } }));
    if (asset.status === 'selected') actions.push(el('button', { class: 'sm primary', text: '应用到发布稿', onclick: ev => run(ev.currentTarget, async () => {
      await openingApi.applyOpeningAsset(book.id, asset.id);
      await refresh(`${name}已应用`);
    }) }));
    if (asset.status === 'applied' && asset.placement !== 'scene_patch') actions.push(el('button', { class: 'sm ghost danger', text: '撤下前置层', onclick: ev => run(ev.currentTarget, async () => {
      await openingApi.retireOpeningAsset(book.id, asset.id);
      await refresh('读者前置层已撤下；叙事正文未改动');
    }) }));
    if (asset.status !== 'applied') actions.push(el('button', { class: 'sm ghost', text: '审校此方案', onclick: ev => run(ev.currentTarget, async () => {
      await openingApi.auditOpeningAsset(book.id, asset.id);
      await refresh('已完成开篇方案审校');
    }) }));
    if (asset.status !== 'applied') actions.push(el('button', { class: 'sm ghost danger', text: '删除此方案', onclick: async ev => {
      const btn = ev.currentTarget;
      if (!await confirmDialog(`删除“${name}”？`, '该候选将从列表中永久移除，无法恢复；已应用方案需先撤下前置层。')) return;
      await run(btn, async () => {
        await openingApi.removeOpeningAsset(book.id, asset.id);
        await refresh('该候选已删除');
      });
    } }));
    candidatesCard.append(el('div', { style: 'padding:10px 0;border-top:1px solid var(--border)' },
      el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
        el('b', { class: 'grow', text: name }),
        el('span', { class: `badge ${asset.freshness?.fresh ? 'badge-ok' : 'badge-warn'}`, text: freshness }),
        el('span', { class: 'small muted', text: asset.status }),
        ...actions,
      ),
      el('div', { class: 'small mt', text: `创作假设：${asset.creative_hypothesis || '—'}` }),
      audit.continue_question ? el('div', { class: 'small', text: `冷读者具体想追：${audit.continue_question}` }) : null,
      audit.strongest_axis?.reason ? el('div', { class: 'small', text: `最强吸引轴：${audit.strongest_axis.reason}` }) : null,
      audit.attention_drop?.length ? el('div', { class: 'small warn-text', text: `注意力断点：${audit.attention_drop.join('；')}` }) : null,
      auditBlockers.length ? el('div', { class: 'small warn-text', text: `禁止采用：仍有 ${auditBlockers.length} 项硬伤/high 问题，请重新生成` }) : null,
      comparison.status ? el('div', { class: 'small muted', text: `匿名比较：${comparison.status}${comparison.winner ? '（本候选胜出）' : ''}` }) : null,
      el('details', { class: 'small mt' },
        el('summary', {}, '查看完整候选正文'),
        el('div', { style: 'white-space:pre-wrap;max-height:360px;overflow:auto;padding:8px;background:var(--bg-soft)', text: asset.content || '' }),
      ),
      el('details', { class: 'small mt' },
        el('summary', {}, '技术详情'),
        el('div', { text: `位置：${asset.placement} · 源哈希：${asset.source_hash || '—'} · 生成模型：${asset.rank?.generator_model || '—'} · 资产ID：${asset.id}` }),
      ),
    ));
  }
  body.append(candidatesCard);

  if (publish.changed && publish.patch) {
    body.append(el('div', { class: 'card' },
      el('b', { text: '发布同步差异' }),
      el('div', { class: 'small muted', text: '这是本地完整发布稿差异；不会直接覆盖下载目录或番茄后台。应用前快照可在书务台查看。' }),
      el('div', { class: 'small mt', text: `before ${publish.patch.before_hash} → after ${publish.patch.after_hash}；变化 ${publish.patch.changed_chars} 字符` }),
      el('details', { class: 'small mt' }, el('summary', {}, '查看可直接替换的完整第一章'),
        el('div', { style: 'white-space:pre-wrap;max-height:420px;overflow:auto', text: publish.patch.after_text || '' })),
    ));
  }

  const metricName = el('input', { placeholder: '后台指标名（可选）', style: 'min-width:160px' });
  const metricValue = el('input', { placeholder: '当时可见值（可选）', style: 'min-width:150px' });
  const comment = el('input', { placeholder: '去身份化代表评论（可选）', style: 'min-width:220px;flex:1' });
  body.append(el('div', { class: 'card' },
    el('b', { text: '记录真实反馈' }),
    el('div', { class: 'small muted', text: '记录后台当时可见的数据与评论，只校准这一本书的创作假设；不会把一次数据写成全平台定律。' }),
    el('div', { class: 'row mt', style: 'gap:8px;flex-wrap:wrap' }, metricName, metricValue, comment,
      el('button', { class: 'sm ghost', text: '保存反馈', onclick: ev => run(ev.currentTarget, async () => {
        await openingApi.recordFeedback(book.id, {
          metrics: metricName.value.trim() ? [{ name: metricName.value.trim(), value: metricValue.value.trim() }] : [],
          comments: comment.value.trim() ? [comment.value.trim()] : [],
          observation_window: '作者录入时未指定窗口',
        });
        metricName.value = ''; metricValue.value = ''; comment.value = '';
        toast('反馈已按当前开篇版本哈希保存', 'success');
      }) }),
    ),
  ));
  return el('details', { class: 'fold', open: assets.length > 0 },
    el('summary', {}, '开篇创作决策台：宪章 · 诊断 · 候选 · 一键应用'), body);
}
