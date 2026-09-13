// V0.71 测试：成本页 state 修复 + 地点库（净化/补全/注入/API）+ 过程打磨 + 伏笔收束
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v071-'));
process.env.NOVEL_NO_OPEN = '1';

const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const { purgeMisplacedLocationCards, syncWorldLocations, locationCardText, tidyLocations } =
  await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/locations.js')));

describe('V0.71 成本页与地点库', () => {
  test('①成本页修复：costs.js 导入 state（此前漏导入 → "state is not defined"）', () => {
    const src = fs.readFileSync(path.join(ROOT, 'web/js/views/costs.js'), 'utf8');
    assert.ok(/import \{[\s\S]*\bstate\b[\s\S]*\} from '\.\.\/app\.js'/.test(src), 'costs.js 应导入 state');
    assert.ok(src.includes("state.route?.name !== 'costs'"), '竞态防护保留');
    // 全站无其他漏导入
    const views = fs.readdirSync(path.join(ROOT, 'web/js/views'));
    for (const f of views) {
      const s = fs.readFileSync(path.join(ROOT, 'web/js/views', f), 'utf8');
      const usesState = /\bstate\./.test(s);
      const importsState = /import[^;]*\bstate\b/.test(s);
      if (usesState && !importsState) assert.fail(`${f} 漏导入 state`);
    }
  });

  test('②地点库净化：人物误入地点表 → 删除（角色卡已存在或人物词尾）', () => {
    const b = store.books.create({ title: '地点书', genre: '玄幻' });
    store.characters.create(b.id, { name: '石蜥', tier: 'minor' });
    store.locations.create(b.id, { name: '青阳镇' });
    store.locations.create(b.id, { name: '石蜥' });       // 人物已有卡 → 删
    store.locations.create(b.id, { name: '追捕者（乙）' }); // 人物词尾 → 删
    store.locations.create(b.id, { name: '疤脸乞食者' });  // 人物身份 → 删
    store.locations.create(b.id, { name: '破庙' });        // 真地点 → 保留
    const removed = purgeMisplacedLocationCards(b.id);
    assert.ok(removed.includes('石蜥'), '已有角色卡的地点应删');
    assert.ok(removed.includes('追捕者（乙）'), '人物词尾应删');
    assert.ok(removed.includes('疤脸乞食者'), '乞食者不应留在地点表');
    const names = store.locations.list(b.id).map(l => l.name);
    assert.ok(names.includes('青阳镇') && names.includes('破庙'), '真地点保留');
  });

  test('③地点卡注入：稳定地点简短、变化地点强调', () => {
    const b = store.books.create({ title: '注入书', genre: '玄幻' });
    const l1 = store.locations.create(b.id, { name: '青阳镇' });
    store.locations.update(l1.id, { kind: '城镇', desc: '烟火小镇', status: 'normal' });
    const t1 = locationCardText(b.id, '青阳镇');
    assert.ok(t1.includes('城镇') && t1.includes('烟火小镇'), '稳定地点注入类型+描述');
    assert.ok(!t1.includes('发生变化'), '稳定地点不强调变化');
    const l2 = store.locations.create(b.id, { name: '禁地' });
    store.locations.update(l2.id, { kind: '封印区域', desc: '地底深处', status: 'changed', note: '黑水渗出' });
    const t2 = locationCardText(b.id, '禁地');
    assert.ok(t2.includes('发生变化') && t2.includes('黑水渗出'), '变化地点强调状态');
  });

  test('④tidyLocations mock 补全（kind/desc 只填空）', async () => {
    const b = store.books.create({ title: '整理书', genre: '玄幻' });
    store.materials.set(b.id, 'contract', 'x');
    const l = store.locations.create(b.id, { name: '青阳镇' });
    const r = await tidyLocations(b.id, {});
    const after = store.locations.get(l.id);
    assert.ok(after.kind || after.desc, 'AI 应补全 kind/desc');
    assert.ok(r.ok);
  });

  test('⑤world 材料【主要地点】段同步建卡', () => {
    const b = store.books.create({ title: '同步书', genre: '玄幻' });
    store.materials.set(b.id, 'world', '【主要地点】\n青阳镇｜镇子\n青云山：灵山');
    const created = syncWorldLocations(b.id);
    const names = store.locations.list(b.id).map(l => l.name);
    assert.ok(names.includes('青阳镇') && names.includes('青云山'), 'world 设定应同步到地点库');
    assert.ok(created.length >= 2);
  });

  test('⑥pilot 每 5 章调 tidyLocations + 后端 locations API 路由', () => {
    const pilot = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/pilot.js'), 'utf8');
    assert.ok(pilot.includes("tidyLocations(bookId"), 'pilot 应调用地点库整理');
    const idx = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    assert.ok(idx.includes("'/api/books/:id/locations'"), 'locations GET 路由');
    assert.ok(idx.includes("'/api/books/:id/locations/tidy'"), 'locations tidy 路由');
    const w = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/write.js'), 'utf8');
    assert.ok(w.includes('locationCardText'), '写作应注入地点卡');
  });
});

describe('V0.71 过程打磨与伏笔收束', () => {
  test('⑦midStoryReview 生成规划调整（mock）+ 落 polish_feedback 材料', async () => {
    const b = store.books.create({ title: '打磨书', genre: '玄幻' });
    store.materials.set(b.id, 'contract', 'x');
    const v = store.volumes.create(b.id, 1, { title: 'V1' });
    for (let i = 1; i <= 10; i++) {
      const c = store.chapters.create(b.id, v.id, i, { title: 'C' + i, status: 'done' });
      store.summaries.set(c.id, b.id, '内容' + i);
    }
    const { midStoryReview } = await import(pathToFileURL(path.join(ROOT, 'server/engine/quality/polish.js')));
    const r = await midStoryReview(b.id, {});
    assert.ok(r.issues >= 1, '应发现问题');
    assert.ok(r.adjustments >= 1, '应生成规划调整');
    const fb = store.materials.get(b.id, 'polish_feedback');
    assert.ok(fb?.content?.includes('中期审阅反馈'), '应落 polish_feedback 材料');
  });

  test('⑧foreshadowClosurePlan 超龄伏笔分配回收（mock）+ 更新 payoff_chapter', async () => {
    const b = store.books.create({ title: '收束书', genre: '玄幻' });
    store.materials.set(b.id, 'contract', 'x');
    const v = store.volumes.create(b.id, 1, { title: 'V1' });
    for (let i = 1; i <= 20; i++) {
      const c = store.chapters.create(b.id, v.id, i, { title: 'C' + i, status: 'done' });
      store.summaries.set(c.id, b.id, 'x');
    }
    const f = store.foreshadows.create(b.id, { desc: '转生白光之谜', type: '剧情', importance: 'high', plantedChapter: 1 });
    const { foreshadowClosurePlan } = await import(pathToFileURL(path.join(ROOT, 'server/engine/narrative/foreshadow.js')));
    const r = await foreshadowClosurePlan(b.id, {});
    assert.ok(r.overdue >= 1, '应识别超龄伏笔');
    assert.ok(r.assigned >= 1, '应分配回收');
    const plan = store.materials.get(b.id, 'foreshadow_plan');
    assert.ok(plan?.content?.includes('伏笔收束计划'), '应落 foreshadow_plan 材料');
    const updated = store.foreshadows.get(f.id);
    assert.ok(updated.payoff_chapter > 0, '应更新计划回收章');
  });

  test('⑨pilot 每 10 章中期审阅 + 卷写完收束计划 + nextVolume 注入两段反馈', () => {
    const pilot = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/pilot.js'), 'utf8');
    assert.ok(pilot.includes('midStoryReview'), 'pilot 应每 10 章中期审阅');
    assert.ok(pilot.includes('foreshadowClosurePlan'), 'pilot 应卷写完生成收束计划');
    const cont = fs.readFileSync(path.join(ROOT, 'server/engine/pipeline/continuation.js'), 'utf8');
    assert.ok(cont.includes('midReviewText') && cont.includes('closurePlanText'), '续卷应注入两段反馈');
    const ws = fs.readFileSync(path.join(ROOT, 'web/js/views/workshop.js'), 'utf8');
    assert.ok(ws.includes("case 'mid_review':") && ws.includes("case 'foreshadow_plan':"), '前端应处理新事件');
  });
});
