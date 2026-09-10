// V0.98.4 设置页真源适配：显示即运行时真相（换服务商后不再满屏旧模型名）
import './helper.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('V0.98.4 resolvedRouteModels：免费档下全部任务解析为 ox-alpha-free，旧覆盖不锁死服务商', async () => {
  const { resolvedRouteModels } = await import('../server/config.js');
  const free = resolvedRouteModels({ provider: 'opencode_go_free', writingModel: 'flash', routes: {} });
  assert.equal(free.write, 'ox-alpha-free');
  assert.equal(free.audit, 'ox-alpha-free');
  assert.ok(Object.values(free).every(model => model === 'ox-alpha-free'), '所有任务的显示名都是实际运行模型');
  const legacy = resolvedRouteModels({
    provider: 'opencode_go_free', writingModel: 'flash',
    routes: { audit: { model: 'deepseek-v4-flash' } },
  });
  assert.equal(legacy.audit, 'ox-alpha-free', '路由覆盖里的默认名同样经预设映射，不显示旧服务商名');
  const ds = resolvedRouteModels({ provider: 'deepseek_official', writingModel: 'flash', routes: {} });
  assert.equal(ds.write, 'deepseek-v4-flash');
});

test('V0.98.4 writingModelPresetsFor：免费档折叠单卡并显示真实模型名', async () => {
  const { writingModelPresetsFor } = await import('../server/config.js');
  const free = writingModelPresetsFor({ provider: 'opencode_go_free', writingModel: 'flash' });
  assert.deepEqual(Object.keys(free), ['flash'], 'flash/pro 同模型时只留单档');
  assert.ok(free.flash.label.includes('ox-alpha-free'));
  const ds = writingModelPresetsFor({ provider: 'deepseek_official', writingModel: 'flash' });
  assert.ok(ds.flash.label.includes('deepseek-v4-flash'));
  assert.ok(ds.pro.label.includes('deepseek-v4-pro'));
});

test('V0.98.4 峰谷提示免费模型感知；全部服务商预设都有 keyHint', async () => {
  const { peakHint } = await import('../server/llm/cost.js');
  assert.ok(peakHint('ox-alpha-free').includes('免费'));
  assert.ok(/高峰时段|非高峰时段/.test(peakHint('deepseek-v4-flash')));
  const { PROVIDER_PRESETS } = await import('../server/config.js');
  for (const id of Object.keys(PROVIDER_PRESETS)) {
    assert.ok(PROVIDER_PRESETS[id].keyHint, `${id} 预置必须带 keyHint（设置页 Key 获取提示）`);
  }
});

test('V0.98.4 设置页脚本：模型列用 resolvedModels，未改动不保存模型字段', async () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'web/js/views/settings.js'), 'utf8');
  assert.ok(src.includes('resolvedModels'), '模型列显示解析后的实际模型名');
  assert.ok(src.includes('value !== effectiveModel'), '未改动不保存模型字段（保留服务商切换跟随性）');
  assert.ok(!src.includes("'DeepSeek API'"), '卡片标题不再恒写 DeepSeek');
  const appSrc = fs.readFileSync(path.join(process.cwd(), 'web/js/app.js'), 'utf8');
  assert.ok(appSrc.includes('免费模型'), '顶栏峰谷徽章适配免费档');
});
