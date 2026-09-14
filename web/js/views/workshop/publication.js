// 由 workshop.js 拆分而来（V0.109.5）。只搬不改：函数体与拆分前逐字节一致。
'use strict';

import { get, post, patch, put, del, sse, openingApi, publicationApi, narrativeApi, writeApi } from '../api.js';
import { el, toast, confirmDialog, openModal, icon, fmt, fmtTokens, fmtMoney, fmtPct, esc, pageHead, progressCard, CHAPTER_STATUS, CHAPTER_STATUS_TAG, chapterStatusLabel } from '../ui.js';
import { state, refreshBook, refreshGlobal, rerender, registerSSE, unregisterSSE } from '../app.js';

const PUBLICATION_STAGE_META = {
  not_applied: ['尚未申请', 'neutral'],
  preparing: ['准备推荐评估', 'neutral'],
  under_review: ['推荐评估中', 'warn'],
  failed: ['推荐评估未通过', 'danger'],
  validation: ['小流量推荐验证', 'warn'],
  recommended: ['已进入推荐', 'ok'],
  terminated: ['推荐流程终止', 'danger'],
};

const RECOVERY_STATUS_TEXT = {
  diagnosing: '正在诊断质量曲线', planned: '诊断完成，等待确认返工', rewriting: '正在生成隔离候选',
  verifying: '正在双向盲审/整段复核', completed: '返工执行结束（查看完成度）',
  failed: '返工未通过，旧稿已保留', cancelled: '已取消',
};

function selectWithOptions(options, value, attrs = {}) {
  const node = el('select', attrs, ...options.map(([key, label]) => el('option', { value: key, text: label })));
  node.value = value;
  return node;
}

export function metricValue(value, suffix = '') {
  return value === null || value === undefined || value === '' ? '—' : `${fmt(value)}${suffix}`;
}

function recoveryEventText(event, data = {}) {
  if (event === 'recovery_job_started') return data.replayed
    ? '已重新连接服务端返工任务，正在回放断线期间进度'
    : '服务端后台任务已建立；断开页面只停止观察，不会取消服务端任务';
  if (event === 'recovery_job_cancelling') return '已收到明确停止指令，正在安全中止当前模型调用并保留检查点';
  if (event === 'recovery_job_cancelled') return '服务端返工已按明确指令停止；旧稿与已落检查点保留';
  if (event === 'recovery_job_completed') return data.completion === 'partial'
    ? '服务端任务结束：部分落盘，仍有章节待解决'
    : '服务端任务已正常结束';
  if (event === 'recovery_job_failed') return `服务端任务失败：${data.message || data.error || data.code || '未知错误'}；可从检查点重连或重试`;
  if (event === 'recovery_cancelled') return '返工引擎已安全记录取消状态，旧稿和当前检查点均保留';
  if (event === 'recovery_started') return `返工诊断已启动：第 ${data.startChapter || 1}—${data.endChapter || 20} 章`;
  if (event === 'recovery_diagnosing') return `诊断第 ${data.from}—${data.to} 章（${data.current}/${data.total}）`;
  if (event === 'recovery_resumed') return data.nextStage === 'synthesizing'
    ? `逐章取证已完成，正文与反馈未变化；从全范围综合规划继续（${data.completedBatches}/${data.totalBatches} 批证据已保存）`
    : `正文与反馈未变化，已从第 ${data.nextChapter} 章续跑（前 ${data.completedBatches}/${data.totalBatches} 批证据已保存）`;
  if (event === 'recovery_checkpoint_saved') return data.message
    || `已保存到第 ${data.completedThrough} 章的验证检查点（${data.completedBatches}/${data.totalBatches}）`;
  if (event === 'recovery_synthesizing') return `逐章取证完成，正在综合第 ${data.from || 1}—${data.to || data.endChapter || 20} 章全范围因果蓝图与返工依赖`;
  if (event === 'recovery_plan_compiled_locally') return data.reason || '综合计划已由本地编译器补齐，不再重跑模型蓝图';
  if (event === 'recovery_plan_normalized_locally') return data.message || '已保存计划已本地净化，未调用综合规划模型';
  if (event === 'recovery_retry') {
    const scope = data.chapter
      ? `第 ${data.chapter} 章`
      : (data.from ? `第 ${data.from}—${data.to} 章` : '当前步骤');
    const wait = data.timeoutExtended && data.nextConnectTimeoutMs
      ? `；下一轮首字节等待上限已自动放宽至 ${Math.round(data.nextConnectTimeoutMs / 1000)} 秒`
      : '';
    const waitHint = Number(data.waitMs) >= 10000 ? `，约 ${Math.round(data.waitMs / 1000)} 秒后重试` : '';
    return `${scope}模型连接不稳定，正在自动重试（第 ${data.attempt} 次，${data.reason || 'NETWORK_ERROR'}${waitHint}）${wait}`;
  }
  if (event === 'recovery_validation_retry') {
    if (data.stage === 'comparing') return `第 ${data.chapter} 章${data.round >= 3 ? '决胜轮' : `第 ${data.round}/2 轮`}盲审未通过本地校验，已退回模型重答一次：${data.reason || '结构无效'}`;
    if (data.stage === 'rewriting') return `第 ${data.chapter} 章候选未通过本地校验，已带具体命中退回模型重答（第 ${data.attempt || 1}/2 次）：${data.reason || '结构无效'}`;
    if (data.stage === 'global_review') return `整段复核未通过本地校验，已退回模型重答一次：${data.reason || '结构无效'}`;
    const scope = data.from ? `第 ${data.from}—${data.to} 章` : '当前批次';
    return `${scope}诊断报告未通过本地真实性校验，已把全部问题一次性退回模型纠正（第 ${data.attempt || 1}/2 次）：${data.reason || '结构无效'}`;
  }
  if (event === 'recovery_plan_ready') return `质量曲线完成：${data.workOrders?.length || 0} 章需要返工`;
  if (event === 'recovery_diagnosis_reused') return `诊断结论仍然有效（${data.chapters} 章已全部诊断过且正文未变），直接沿用 ${data.workOrders} 章工单，不重复烧费`;
  if (event === 'recovery_snapshot_created') return `已创建恢复快照：${data.snapshotId}`;
  if (event === 'recovery_snapshot_reused') return `正文基准未变，复用本运行恢复快照：${data.snapshotId}（不会重复堆积快照）`;
  if (event === 'recovery_rewriting') return `生成第 ${data.chapter} 章证据场景窗口候选（${data.current}/${data.total}；本章只生成一次）`;
  if (event === 'recovery_comparing') return `第 ${data.chapter} 章匿名盲审，第 ${data.round}/2 轮`;
  if (event === 'recovery_candidate_reused') return data.priorRunId
    ? `复用第 ${data.chapter} 章整段已通过候选（同一诊断、完整工单及相邻章指纹均一致；${data.current}/${data.total}，不再消耗模型调用）`
    : `复用第 ${data.chapter} 章本运行局部通过候选检查点（${data.current}/${data.total}，不再消耗模型调用；仍需整段复核）`;
  if (event === 'recovery_chapter_frozen') return `第 ${data.chapter} 章连续 ${data.attempts || 2} 轮返工都未证明优于旧稿，已自动冻结止损（零模型调用，旧稿保留）；下次有章节成功落盘会自动解冻再试，或用"全部重新诊断"立即重来`;
  if (event === 'recovery_candidate_accepted') return `第 ${data.chapter} 章候选局部通过双向盲审，等待整段复核；此时尚未落盘`;
  if (event === 'recovery_candidate_rejected') return `第 ${data.chapter} 章候选被拒：${data.reason || data.error || data.code}`;
  if (event === 'recovery_global_review') return `整段复核第 ${data.from || 1}—${data.to || 20} 章持续推进曲线`;
  if (event === 'recovery_completed') {
    const applied = (data.applied || []).join('、') || '无';
    const unresolved = (data.unresolvedChapters || []).join('、');
    return data.completion === 'partial'
      ? `部分落盘：采用第 ${applied} 章；第 ${unresolved || '其余'} 章仍未解决，旧稿保留并进入下一轮重规划`
      : `全部返工完成：采用第 ${applied} 章`;
  }
  if (event === 'recovery_failed') return `返工停止：${data.error}`;
  return data.message || event;
}

/**
 * 返工进度选择弹窗（Promise<运行 id | 'fresh' | false>）：点一键按钮后列出可沿用的
 * 历史进度——工单在手直接执行 / 诊断中道断点续跑——或全部重来。默认选最近一条可沿用进度。
 */

/**
 * 返工进度选择弹窗（Promise<运行 id | 'fresh' | false>）：点一键按钮后列出可沿用的
 * 历史进度——工单在手直接执行 / 诊断中道断点续跑——或全部重来。默认选最近一条可沿用进度。
 */
function pickRecoveryProgress(runs) {
  return new Promise(resolve => {
    const options = [
      ...runs.map(run => ({
        key: String(run.id),
        title: run.resumeKind === 'execute'
          ? `第 ${run.start_chapter}—${run.end_chapter} 章 · 直接执行工单`
          : `第 ${run.start_chapter}—${run.end_chapter} 章 · 续跑诊断`,
        desc: `${run.resumeDetail || ''} · ${RECOVERY_STATUS_TEXT[run.status] || run.status} · ${new Date(run.updated_at || run.created_at || Date.now()).toLocaleString()}`,
      })),
      { key: 'fresh', title: '全部重新诊断', desc: '不沿用旧运行，也不复用本运行局部通过候选检查点；从当前全书重新生成质量曲线与因果工单' },
    ];
    let picked = options[0].key;
    const { close } = openModal({
      title: '选择要沿用的返工进度',
      body: el('div', { class: 'recovery-pick-list' }, ...options.map(option => el('label', {
        class: 'recovery-pick',
        style: 'display:flex;gap:8px;align-items:flex-start;padding:8px 4px;border-bottom:1px solid var(--border);cursor:pointer',
      },
        el('input', {
          type: 'radio', name: 'recovery-progress-pick', value: option.key,
          ...(option.key === picked ? { checked: true } : {}),
          onchange: () => { picked = option.key; },
        }),
        el('div', { class: 'grow' },
          el('b', { text: option.title }),
          el('div', { class: 'small muted', text: option.desc }),
        ),
      ))),
      actions: [
        el('button', { text: '取消', onclick: () => { close(false); resolve(false); } }),
        el('button', { class: 'primary', text: '继续', onclick: () => { close(true); resolve(picked); } }),
      ],
      onClose: result => { if (!result) resolve(false); },
    });
  });
}

/** V0.99：平台事实与正文返工之间的可审计驾驶舱。 */

/** V0.99：平台事实与正文返工之间的可审计驾驶舱。 */
export async function renderPublicationDashboard(book) {
  const [dashboard, narrativeState] = await Promise.all([
    publicationApi.status(book.id),
    narrativeApi.status(book.id),
  ]);
  const profile = dashboard.profile || {};
  const [stageLabel, stageTone] = PUBLICATION_STAGE_META[profile.recommendation_stage || 'not_applied'] || ['状态未知', 'neutral'];
  const latestMetric = dashboard.metrics?.[0] || null;
  const latestRun = dashboard.recoveryRuns?.[0] || null;
  const activeRecoveryJob = dashboard.activeRecoveryJob || null;
  const recoveryCompletion = latestRun?.result?.completion || null;
  const unresolvedRecovery = latestRun?.result?.unresolvedChapters || [];
  const candidateStats = latestRun?.candidateStats || {};
  const recoveryRunLabel = recoveryCompletion === 'partial' ? '部分落盘'
    : recoveryCompletion === 'complete' ? '全部完成'
      : recoveryCompletion === 'global_rejected' ? '局部通过但整段否决'
        : RECOVERY_STATUS_TEXT[latestRun?.status] || latestRun?.status;
  const pending = profile.pending_sync_chapters || [];
  const shell = el('section', { class: `publication-cockpit stage-${stageTone}` });

  shell.append(el('div', { class: 'publication-head' },
    el('div', { class: 'publication-kicker', text: '推流观察' }),
    el('div', { class: 'row', style: 'align-items:flex-start;gap:12px' },
      el('div', { class: 'grow' },
        el('h2', { text: '推流质量驾驶舱' }),
        el('div', { class: 'small muted', text: '平台反馈 → 质量曲线 → 隔离返工 → 双向盲审 → 线上同步；所有自动创作与审校读取同一份动态事实。' }),
      ),
      el('span', { class: `publication-stage ${stageTone}`, text: stageLabel }),
    ),
  ));

  if (profile.recommendation_stage === 'failed') {
    shell.append(el('div', { class: 'publication-alert danger' },
      el('div', { class: 'publication-alert-mark', text: 'P0' }),
      el('div', { class: 'grow' },
        el('b', { text: `P0 内容质量事故 · 剩余 ${profile.remaining_attempts ?? '未知'} 次申请机会` }),
        el('div', { class: 'small', text: '这不是“平台还没给量”，而是现有正文没有获得进入推荐验证的资格。楔子不能替后续正文还债，继续堆新章节也不算整改。' }),
      ),
    ));
  }

  shell.append(el('div', { class: 'publication-stats' },
    el('div', { class: 'publication-stat' }, el('span', { text: '公开边界' }), el('b', { text: profile.published_chapter_count == null ? '未同步' : `第 ${profile.published_chapter_count} 章` }), el('small', { text: profile.latest_chapter_title || '填写链接后自动检测' })),
    el('div', { class: 'publication-stat' }, el('span', { text: '公开字数' }), el('b', { text: metricValue(profile.published_word_count) }), el('small', { text: `本地 ${dashboard.localChapterCount || 0} 章 · 未发布 ${dashboard.unpublishedChapterCount ?? '—'} 章` })),
    el('div', { class: 'publication-stat' }, el('span', { text: '页面公开读者' }), el('b', { text: metricValue(profile.public_reader_count) }), el('small', { text: '仅记录页面字段，不冒充后台完整数据' })),
    el('div', { class: 'publication-stat' }, el('span', { text: '最近数据阶段' }), el('b', { text: latestMetric ? ({ not_exposed: '未获曝光', validation: '验证期', limited_test: '小流量', recommended: '推荐中', organic: '自然流量' }[latestMetric.exposure_status] || latestMetric.exposure_status) : '未录入' }), el('small', { text: latestMetric?.observed_at ? new Date(latestMetric.observed_at).toLocaleString() : '等待真实观察窗口' })),
  ));

  const narrativeProgress = el('div', { class: 'recovery-progress' });
  const narrativeNeedsRebuild = narrativeState.requiresRebuild === true;
  const narrativeLabel = ({
    ready: '正文与派生状态同版', stale: '正文已改，派生状态待重建',
    mismatch: '检测到绕过门禁的正文变化',
    legacy: narrativeNeedsRebuild ? '旧作品需建立同版账本' : '空白新书尚无叙事版本',
  })[narrativeState.status] || '状态未知';
  shell.append(el('div', { class: 'publication-section narrative-state-section' },
    el('div', { class: 'section-label', text: '00 · 叙事版本安全门' }),
    el('div', { class: `publication-alert ${narrativeNeedsRebuild ? 'danger' : narrativeState.status === 'ready' ? 'info' : 'warn'}` },
      el('div', { class: 'publication-alert-mark', text: narrativeNeedsRebuild ? '停' : '版' }),
      el('div', { class: 'grow' },
        el('b', { text: narrativeLabel }),
        el('div', { class: 'small', text: narrativeNeedsRebuild
          ? '自动创作已暂停，避免旧摘要、旧人物状态、旧伏笔或旧大纲继续污染正文。重建会先在影子环境逐章取证，全部通过后才原子切换。'
          : narrativeState.current
            ? `有效版本 ${narrativeState.current.id}，已对齐至第 ${narrativeState.current.throughChapter} 章。`
            : '空白新书将在首章结算时自动建立同版账本。' }),
        el('div', { class: 'small muted', text: `已验证创作经验 ${narrativeState.lessons?.active || 0} 条，累计用于后续章节 ${narrativeState.lessons?.uses || 0} 次；未通过整体复核的临时结论不会进入创作提示。` }),
      ),
    ),
    narrativeNeedsRebuild ? el('div', { class: 'row mt', style: 'flex-wrap:wrap' },
      el('button', { class: 'danger', text: '重建摘要、角色、伏笔与各层大纲', onclick: async ev => {
        const button = ev.currentTarget;
        if (!await confirmDialog('开始同版重建？', '模型会逐章从当前正文重新取证，并校准书纲、卷纲和未来章。构建失败不会再次覆盖正文；完成前自动创作保持暂停。')) return;
        button.disabled = true; narrativeProgress.innerHTML = '';
        const ctrl = registerSSE();
        try {
          await narrativeApi.rebuild(book.id, (event, data) => {
            const textByEvent = {
              narrative_projection_started: `开始逐章取证，共 ${data.total || 0} 章`,
              narrative_projection_progress: data.resumed
                ? `复用第 ${data.chapter} 章已验证投影（${data.current}/${data.total}，断点续跑不消耗模型调用）`
                : `取证第 ${data.chapter} 章（${data.current}/${data.total}）`,
              narrative_projection_retry: `第 ${data.chapter} 章投影未通过本地校验，已退回模型重答一次`,
              narrative_plan_started: '校准书级、卷级与未来章规划',
              narrative_plan_retry: `规划校准未通过本地校验，已退回模型重答一次（${String(data.reason || '').slice(0, 80)}）`,
              narrative_plan_validated: '规划证据校验通过，准备原子切换',
              narrative_commit_started: '正在原子切换正文派生状态',
              narrative_revision_committed: '同版重建完成',
              narrative_revision_failed: `重建停止：${data.error || data.code}`,
            };
            narrativeProgress.append(el('div', { class: `recovery-line event-${event}`, text: textByEvent[event] || data.message || event }));
            narrativeProgress.scrollTop = narrativeProgress.scrollHeight;
          }, ctrl.signal);
          toast('叙事状态与各层规划已同版重建，自动创作可以继续', 'success'); rerender();
        } catch (error) { if (error.name !== 'AbortError') toast(error.message, 'error'); button.disabled = false; }
        finally { unregisterSSE(ctrl); }
      } }),
      el('span', { class: 'small muted', text: narrativeState.blocking?.reason
        || (narrativeState.status === 'legacy'
          ? `已有 ${narrativeState.completedChapters || 0} 个完成章，但尚未从当前正文重建同版投影`
          : '当前正文与派生状态版本不一致') }),
    ) : null,
    narrativeProgress,
  ));

  const workUrl = el('input', {
    type: 'url', value: profile.work_url || '', placeholder: 'https://fanqienovel.com/page/作品ID',
    class: 'grow', title: '只接受番茄公开作品页；系统从页面自动识别已发布章节，不需要手填章数',
  });
  const syncNote = el('div', { class: `small ${profile.sync_status === 'error' ? 'error-text' : 'muted'}`, text:
    profile.sync_status === 'error' ? `上次同步失败：${profile.sync_error}`
      : profile.last_synced_at ? `上次同步：${new Date(profile.last_synced_at).toLocaleString()}；自动创作在快照过期后也会刷新` : '尚未同步；保存链接后点击“检测已发布章节”' });
  const syncButton = el('button', { class: 'primary', text: '检测已发布章节', onclick: async ev => {
    const button = ev.currentTarget;
    button.disabled = true; button.textContent = '正在读取番茄…';
    try {
      await publicationApi.saveProfile(book.id, { workUrl: workUrl.value.trim() });
      const result = await publicationApi.sync(book.id);
      toast(`已检测到发布 ${result.profile.published_chapter_count} 章，本地 ${result.localChapterCount} 章`, 'success');
    } catch (error) { toast(error.message, 'error'); }
    rerender();
  } });
  shell.append(el('div', { class: 'publication-section' },
    el('div', { class: 'section-label', text: '01 · 发布边界（自动检测）' }),
    el('div', { class: 'row publication-link-row' }, workUrl, syncButton),
    syncNote,
  ));

  const stageSelect = selectWithOptions(Object.entries(PUBLICATION_STAGE_META).map(([key, value]) => [key, value[0]]), profile.recommendation_stage || 'not_applied');
  const attemptsInput = el('input', { type: 'number', min: '0', max: '3', value: profile.remaining_attempts ?? '', placeholder: '0—3' });
  const turnInput = el('input', { type: 'number', min: '1', max: '200', value: profile.suspected_turn_chapter || 7 });
  const editorFeedback = el('textarea', { text: profile.editor_feedback || '', placeholder: '粘贴平台/编辑原话；不要自行补写编辑没说过的理由' });
  const authorDiagnosis = el('textarea', { text: profile.author_diagnosis || '', placeholder: '作者自己的判断（会明确标成“不是平台原话”）' });
  const saveReviewProfile = async ({ appendReview = false } = {}) => {
    const body = {
      workUrl: workUrl.value.trim(), recommendationStage: stageSelect.value,
      remainingAttempts: attemptsInput.value === '' ? null : Number(attemptsInput.value),
      editorFeedback: editorFeedback.value.trim(), authorDiagnosis: authorDiagnosis.value.trim(),
      suspectedTurnChapter: Number(turnInput.value) || 7,
    };
    await publicationApi.saveProfile(book.id, body);
    if (appendReview) await publicationApi.addReview(book.id, {
      stage: body.recommendationStage, remainingAttempts: body.remainingAttempts,
      feedback: body.editorFeedback, source: 'manual',
    });
  };
  shell.append(el('details', { class: 'publication-section publication-form', open: !dashboard.profile },
    el('summary', {}, '02 · 记录推荐评估与编辑反馈'),
    el('div', { class: 'form-grid mt' },
      el('label', {}, el('span', { text: '当前阶段' }), stageSelect),
      el('label', {}, el('span', { text: '剩余申请次数' }), attemptsInput),
      el('label', {}, el('span', { text: '疑似质量拐点章' }), turnInput),
    ),
    el('label', { class: 'mt block' }, el('span', { text: '平台/编辑原话' }), editorFeedback),
    el('label', { class: 'mt block' }, el('span', { text: '作者诊断（不是平台原话）' }), authorDiagnosis),
    el('div', { class: 'row mt', style: 'flex-wrap:wrap' },
      el('button', { class: 'ghost', text: '保存当前状态', onclick: async ev => {
        const button = ev.currentTarget; button.disabled = true;
        try { await saveReviewProfile(); toast('推流状态已保存并会注入后续自动创作', 'success'); rerender(); }
        catch (error) { toast(error.message, 'error'); button.disabled = false; }
      } }),
      el('button', { class: 'primary', text: '追加一条审核历史', onclick: async ev => {
        const button = ev.currentTarget; button.disabled = true;
        try { await saveReviewProfile({ appendReview: true }); toast('本次审核已追加保存，不会覆盖旧记录', 'success'); rerender(); }
        catch (error) { toast(error.message, 'error'); button.disabled = false; }
      } }),
      el('span', { class: 'small muted', text: `历史记录 ${dashboard.reviews?.length || 0} 次` }),
    ),
  ));

  const exposure = selectWithOptions([
    ['not_exposed', '未获曝光（推流前）'], ['validation', '推荐验证期'],
    ['limited_test', '小流量测试'], ['recommended', '正式推荐中'], ['organic', '自然流量'],
  ], latestMetric?.exposure_status || 'not_exposed');
  const metricInputs = {
    impressions: el('input', { type: 'number', min: '0', placeholder: '曝光数' }),
    readers: el('input', { type: 'number', min: '0', placeholder: '读者数' }),
    bookshelfAdds: el('input', { type: 'number', min: '0', placeholder: '加书架数' }),
    readThroughRate: el('input', { type: 'number', min: '0', max: '100', step: '0.01', placeholder: '读完率 %' }),
    followRate: el('input', { type: 'number', min: '0', max: '100', step: '0.01', placeholder: '追读率 %' }),
    note: el('input', { placeholder: '观察窗口/备注', class: 'grow' }),
  };
  const optionalNumber = input => input.value === '' ? null : Number(input.value);
  shell.append(el('details', { class: 'publication-section publication-form' },
    el('summary', {}, '03 · 记录作品数据（按观察窗口追加）'),
    el('div', { class: 'publication-alert info mt', text: '未获曝光时，0 读者是正常的中性数据；只有作品获得真实曝光后，读完、追读和转化才可用来诊断方向。系统不会把推流前的 0 当成“写得差”的证据。' }),
    el('div', { class: 'metric-grid mt' }, exposure, metricInputs.impressions, metricInputs.readers, metricInputs.bookshelfAdds, metricInputs.readThroughRate, metricInputs.followRate),
    el('div', { class: 'row mt' }, metricInputs.note,
      el('button', { class: 'primary', text: '保存数据快照', onclick: async ev => {
        const button = ev.currentTarget; button.disabled = true;
        try {
          await publicationApi.addMetric(book.id, {
            exposureStatus: exposure.value,
            impressions: optionalNumber(metricInputs.impressions), readers: optionalNumber(metricInputs.readers),
            bookshelfAdds: optionalNumber(metricInputs.bookshelfAdds),
            readThroughRate: optionalNumber(metricInputs.readThroughRate), followRate: optionalNumber(metricInputs.followRate),
            note: metricInputs.note.value.trim(), observedAt: Date.now(),
          });
          toast('作品数据已按当前观察窗口追加', 'success'); rerender();
        } catch (error) { toast(error.message, 'error'); button.disabled = false; }
      } }),
    ),
    dashboard.metrics?.length ? el('div', { class: 'metric-history mt' }, ...dashboard.metrics.slice(0, 4).map(item =>
      el('div', { class: 'small', text: `${new Date(item.observed_at).toLocaleDateString()} · ${item.exposure_status} · 曝光 ${item.impressions ?? '—'} · 读者 ${item.readers ?? '—'} · 读完 ${item.read_through_rate ?? '—'}% · 追读 ${item.follow_rate ?? '—'}%${item.note ? ` · ${item.note}` : ''}` }))) : null,
  ));

  const recoveryProgress = el('div', { class: 'recovery-progress' });
  const appendRecoveryProgress = (event, data) => {
    recoveryProgress.append(el('div', { class: `recovery-line event-${event}`, text: recoveryEventText(event, data) }));
    recoveryProgress.scrollTop = recoveryProgress.scrollHeight;
  };
  const curve = latestRun?.quality_curve || [];
  const curveNode = el('div', { class: 'quality-curve' }, ...curve.map(item => el('div', {
    class: `quality-cell action-${item.action || 'keep'} prior-${item.prior || 'unknown'}`,
    title: item.reason || '',
  },
  el('b', { text: `ch${item.chapter}` }),
  el('span', { text: `${item.score ?? '—'}分` }),
  el('small', { text: ({ keep: '保留', tune: '微调', rebuild: '重构' }[item.action] || item.action || '待诊断') }),
  )));

  const recoveryInFlight = !!activeRecoveryJob || ['diagnosing', 'rewriting', 'verifying'].includes(latestRun?.status);
  // 可沿用的既往进度（后端已标注可续性）：直接执行工单 / 诊断断点续跑。
  const recoveryOptions = (dashboard.recoveryRuns || [])
    .filter(run => run.resumeKind === 'execute' || run.resumeKind === 'diagnose');
  // 一键流程：有旧进度先弹窗选择沿用哪条（或全部重来）→ 诊断（可跳）→ 确认工单 → 执行。
  const showRecoveryOutcome = done => {
    if (done?.cancelled || done?.job?.status === 'cancelled') {
      toast('服务端返工已明确停止；旧稿与检查点已保留', 'warn');
      return;
    }
    const applied = done?.result?.applied?.length || 0;
    const unresolved = done?.result?.unresolvedChapters || [];
    if (done?.result?.completion === 'partial') {
      toast(`部分落盘：采用 ${applied} 章；第 ${unresolved.join('、') || '其余'} 章仍未解决，旧稿保留，请先重规划再继续`, 'warn');
    } else {
      toast(applied ? `返工全部通过并采用 ${applied} 章；请按线上同步清单更新番茄` : '没有候选形成明确提升，旧稿已保留', applied ? 'success' : 'warn');
    }
  };
  const oneClickButton = el('button', {
    class: 'primary', disabled: dashboard.localChapterCount < 1 || (recoveryInFlight && !activeRecoveryJob),
    text: activeRecoveryJob
      ? '重新连接返工进度'
      : recoveryInFlight
        ? `返工${{ diagnosing: '诊断', rewriting: '执行', verifying: '复核' }[latestRun.status] || '任务'}进行中…`
        : '一键诊断并返工',
    onclick: async ev => {
      const button = ev.currentTarget;
      button.disabled = true; recoveryProgress.innerHTML = '';
      const ctrl = registerSSE();
      try {
        if (activeRecoveryJob) {
          appendRecoveryProgress('recovery_job_started', { replayed: true, jobId: activeRecoveryJob.id });
          const done = await publicationApi.observeRecoveryJob(book.id, activeRecoveryJob.id, appendRecoveryProgress, ctrl.signal);
          showRecoveryOutcome(done);
          rerender();
          return;
        }
        let choice = 'fresh';
        if (recoveryOptions.length) {
          choice = await pickRecoveryProgress(recoveryOptions);
          if (!choice) { button.disabled = false; return; }
        }
        const end = Math.max(1, dashboard.localChapterCount || 20);
        let run = null;
        if (choice === 'fresh') {
          const diagnosis = await publicationApi.diagnoseRecovery(book.id, {
            startChapter: 1, endChapter: end, forceFresh: recoveryOptions.length > 0,
          }, appendRecoveryProgress, ctrl.signal);
          run = diagnosis?.run;
        } else {
          const picked = recoveryOptions.find(item => String(item.id) === String(choice));
          if (!picked) throw new Error('所选进度已失效，请刷新后重试');
          if (picked.resumeKind === 'execute') {
            run = picked; // 工单在手，跳过诊断
          } else {
            const diagnosis = await publicationApi.diagnoseRecovery(book.id, {
              startChapter: Number(picked.start_chapter), endChapter: Number(picked.end_chapter),
              resumeRunId: picked.id,
            }, appendRecoveryProgress, ctrl.signal);
            run = diagnosis?.run;
          }
        }
        const orders = run?.work_orders || [];
        if (!orders.length) {
          toast('诊断完成：范围内章节全部达标，无需返工', 'success'); rerender(); return;
        }
        const publishedInScope = Math.min(profile.published_chapter_count || 0, run.end_chapter) >= run.start_chapter;
        const accepted = await confirmDialog(
          publishedInScope ? '明确确认返工已发布正文？' : '确认执行返工？',
          `共 ${orders.length} 章工单（微调 ${orders.filter(order => order.action === 'tune').length} / 重构 ${orders.filter(order => order.action === 'rebuild').length}）。${publishedInScope ? `第 ${run.start_chapter}—${Math.min(run.end_chapter, profile.published_chapter_count)} 章已发布。` : ''}系统会先创建完整快照，再生成隔离候选；每章只有双向盲审都胜出且第 ${run.start_chapter}—${run.end_chapter} 章整段推进复核通过后才落盘。通过的已发布章节会加入“待线上同步”清单，工具不会登录或替你修改番茄后台。`,
        );
        if (!accepted) { rerender(); return; }
        button.disabled = true; // confirmDialog 期间状态可能已刷新
        const done = await publicationApi.executeRecovery(book.id, run.id, {
          confirmedPublishedRewrite: true,
          reusePriorCandidates: choice !== 'fresh',
        }, appendRecoveryProgress, ctrl.signal);
        showRecoveryOutcome(done);
        rerender();
      } catch (error) {
        if (error.name !== 'AbortError') toast(error.message, 'error');
        button.disabled = false;
      } finally { unregisterSSE(ctrl); }
    },
  });
  const recoveryActions = [oneClickButton];
  if (activeRecoveryJob) recoveryActions.push(el('button', {
    class: 'danger',
    text: '明确停止服务端返工',
    onclick: async ev => {
      if (!await confirmDialog(
        '明确停止服务端返工？',
        '关闭页面、刷新或网络闪断都不会停止任务；只有这个操作会中止服务端模型调用。已完成检查点和旧稿会保留，可稍后重新发起。',
      )) return;
      const button = ev.currentTarget;
      button.disabled = true;
      try {
        await publicationApi.cancelRecoveryJob(book.id, activeRecoveryJob.id);
        toast('已发送停止指令，服务端正在安全收尾', 'warn');
        rerender();
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    },
  }));

  const recoveryScopeEnd = Math.max(1, dashboard.localChapterCount || 20);
  const suspectedTurn = Math.min(recoveryScopeEnd, Math.max(1, Number(profile.suspected_turn_chapter) || 7));
  const recoveryPriorNodes = [];
  if (suspectedTurn > 1) recoveryPriorNodes.push(el('div', {},
    el('b', { text: `第 1—${suspectedTurn - 1} 章 · 疑似基线` }),
    el('span', { text: '签约曾通过只算弱先验，仍需证据验证；不一刀切重写。' }),
  ));
  recoveryPriorNodes.push(el('div', {},
    el('b', { text: `第 ${suspectedTurn}—${recoveryScopeEnd} 章 · 高风险严审` }),
    el('span', { text: '重点查有效事件、不可逆变化、人物代价、承诺兑现、重复注水和章末追读力。' }),
  ));
  shell.append(el('div', { class: 'publication-section recovery-section' },
    el('div', { class: 'section-label', text: `04 · 质量曲线返工（第 1—${recoveryScopeEnd} 章）` }),
    el('div', { class: 'recovery-prior' }, ...recoveryPriorNodes),
    latestRun ? el('div', { class: 'row mt', style: 'flex-wrap:wrap' },
      el('span', { class: `badge ${recoveryCompletion === 'complete' ? 'badge-ok' : latestRun.status === 'failed' || recoveryCompletion === 'global_rejected' ? 'badge-del' : 'badge-warn'}`, text: recoveryRunLabel }),
      el('span', { class: 'small muted', text: `运行 ${latestRun.id} · 第${latestRun.start_chapter}—${latestRun.end_chapter}章 · 工单 ${latestRun.work_orders?.length || 0}` }),
    ) : el('div', { class: 'small muted mt', text: '尚未诊断。诊断阶段只读正文，不创建候选、不修改已发布稿。' }),
    activeRecoveryJob ? el('div', { class: 'publication-alert info mt', text: `服务端任务 ${activeRecoveryJob.id} 正在运行。断网、刷新或离开页面只会断开观察；点击“重新连接返工进度”可回放事件，只有“明确停止服务端返工”才会取消。` }) : null,
    latestRun && candidateStats.total ? el('div', { class: 'row mt small muted', style: 'flex-wrap:wrap' },
      el('span', { text: `本运行局部通过检查点 ${candidateStats.localPassed || 0}` }),
      el('span', { text: `整段验证通过 ${candidateStats.globalPassed || 0}` }),
      el('span', { text: `整段否决 ${candidateStats.globalRejected || 0}` }),
      ...(candidateStats.legacyUntrusted
        ? [el('span', { class: 'error-text', text: `旧版无来源候选 ${candidateStats.legacyUntrusted}（已隔离，需重生）` })]
        : []),
      el('span', { text: `已落盘 ${candidateStats.applied || 0}` }),
    ) : null,
    unresolvedRecovery.length ? el('div', { class: 'publication-alert warn mt', text: `本轮仍未解决：${unresolvedRecovery.map(index => `第${index}章`).join('、')}。这些章节保留旧稿，不会被“部分落盘”伪装成全部完成。` }) : null,
    curve.length ? curveNode : null,
    latestRun?.error ? el('div', { class: 'publication-alert danger mt', text: latestRun.error }) : null,
    el('div', { class: 'row mt', style: 'flex-wrap:wrap' }, ...recoveryActions),
    recoveryProgress,
  ));

  if (pending.length) {
    shell.append(el('div', { class: 'publication-section sync-chapter-list' },
      el('div', { class: 'section-label', text: '05 · 待线上同步' }),
      el('div', { class: 'publication-alert warn', text: `本地已改、番茄后台可能仍是旧稿：${pending.map(index => `第${index}章`).join('、')}` }),
      el('button', { class: 'ghost mt', text: '我已在番茄后台同步这些章节', onclick: async ev => {
        const button = ev.currentTarget;
        if (!await confirmDialog('确认线上已经更新？', '这只会清除本地提醒，不会检查或修改番茄后台。请确认列出的章节已经逐章同步。')) return;
        button.disabled = true;
        try { await publicationApi.confirmPendingSync(book.id, pending); toast('线上同步提醒已清除', 'success'); rerender(); }
        catch (error) { toast(error.message, 'error'); button.disabled = false; }
      } }),
    ));
  }

  return shell;
}
