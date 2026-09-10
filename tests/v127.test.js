// V0.93.5 台账-正文联动修复：新角色建卡锚点、已登记角色 last_chapter 本地兜底、
// 细纲地点自动登记、钩子 due 文本提取与同章去重
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NOVEL_MOCK_LLM = '1';
process.env.NOVEL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'v127-ledger-'));
const ROOT = process.cwd();
const store = await import(pathToFileURL(path.join(ROOT, 'server/db/store.js')));
const pending = await import(pathToFileURL(path.join(ROOT, 'server/engine/pending.js')));
const pleasure = await import(pathToFileURL(path.join(ROOT, 'server/engine/pleasure.js')));

function freshBook(title = '联动测试') {
  return store.books.create({ title, genre: '历史', settings: { lengthProfile: 5000 } });
}

describe('V0.93.5 台账-正文联动修复', () => {
  test('待登记实体转正建卡时写入章节锚点（first/last_chapter）', () => {
    const book = freshBook();
    store.pendingEntities.add(book.id, { name: '孙成', context: 'ch17 候补兵', sourceChapter: 17 });
    const stats = pending.tidyPendingEntities(book.id, { currentChapter: 17 });
    assert.equal(stats.confirmed, 1, '应自动建卡');
    const c = store.characters.list(book.id).find(x => x.name === '孙成');
    assert.ok(c, '角色卡存在');
    assert.equal(c.first_chapter, 17, 'first_chapter 应等于来源章');
    assert.equal(c.last_chapter, 17, 'last_chapter 应等于来源章');
  });

  test('已登记角色本地兜底：正文出现即更新 last_chapter（不依赖模型自报）', () => {
    const book = freshBook();
    store.characters.create(book.id, { name: '张老实', tier: 'extra', firstChapter: 5 });
    store.characters.update(store.characters.list(book.id).find(x => x.name === '张老实').id, { lastChapter: 5 });
    // 纯函数：正文出现即 touch
    const touched = pleasure.touchCharacters(book.id, '张老实蹲回灶膛前，拿火钳拨了拨柴。', 20);
    assert.deepEqual(touched, ['张老实']);
    assert.equal(store.characters.list(book.id).find(x => x.name === '张老实').last_chapter, 20, 'last_chapter 应更新到 20');
    // 称谓/常见词不误触（"母亲"类称谓、短名不匹配）
    store.characters.create(book.id, { name: '母亲', tier: 'minor' });
    const t2 = pleasure.touchCharacters(book.id, '母亲翻饼的手停了一下。', 3);
    assert.deepEqual(t2, [], '称谓名不应误触');
  });

  test('细纲地点自动登记：location 字段清洗后补登记缺失地点', () => {
    const book = freshBook();
    const name = pleasure.extractOutlineLocationName('北坡外围村庄废墟——老槐树下、民居院中、村后柴垛');
    assert.equal(name, '北坡外围村庄废墟', '取分隔符前主干');
    assert.equal(pleasure.extractOutlineLocationName('钓鱼山北坡营地——营门至废弃采石道入口'), '钓鱼山北坡营地');
    assert.equal(pleasure.extractOutlineLocationName('这是一段超过十四个字的超长描述没有分隔符'), '', '超长无分隔不登记');
    assert.equal(pleasure.extractOutlineLocationName(''), '', '空串不登记');
    const registered = pleasure.registerOutlineLocations(book.id, [
      '北坡外围村庄废墟——老槐树下、民居院中、村后柴垛',
      '北坡外围村庄废墟——另一处细节', // 已登记的不重复建
      '西校场——点兵台',
    ], 19);
    assert.deepEqual(registered.sort(), ['北坡外围村庄废墟', '西校场']);
    const locs = store.locations.list(book.id);
    assert.equal(locs.length, 2);
    const village = locs.find(l => l.name === '北坡外围村庄废墟');
    assert.equal(village.first_chapter, 19);
    assert.equal(village.last_chapter, 19);
  });

  test('钩子 due 从"（第N章兑现）"提取；同章同意象 ending_hook 与 new_hooks 去重', () => {
    const book = freshBook();
    const outline = {
      new_hooks: ['灰烟偏东二里，敌方侦察范围扩大，巡逻队扩编迫在眉睫（第21章兑现）'],
 ending_hook: { desc: '灰烟比昨日偏东二里，像一根钉在暮色里的木刺，无声地逼向营垒；而明日北帐点卯，主角将接过一队人的性命。', type: '悬念钩', intensity: 3 },
    };
    const registered = pleasure.registerHooksFromOutline(book.id, outline, 20);
    assert.equal(registered.length, 1, '同意象钩子应合并为一条');
    const hooks = store.pleasureHooks.list(book.id);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].due_chapter, 21, 'due 应从"（第21章兑现）"提取');
    // 无兑现标注的按 kind 估算
    const o2 = { new_hooks: ['普通中期待，无兑现标注'], ending_hook: null };
    const r2 = pleasure.registerHooksFromOutline(book.id, o2, 20);
    assert.equal(r2.length, 1);
    assert.equal(store.pleasureHooks.list(book.id).find(h => h.desc.includes('普通中期待')).due_chapter, 25, 'medium 估算 20+5');
  });

  test('同意象判定不误并：仅共享共同后续事件引用（如"北帐点卯"）的钩子应各自保留', () => {
    const book = freshBook();
    const outline = {
      new_hooks: [
        '灰烟偏东二里，敌方侦察范围扩大，巡逻队扩编迫在眉睫（第21章兑现）',
        '候补兵将提伙长的名册传开，陈七预告次日北帐点卯（第21章兑现）',
      ],
 ending_hook: { desc: '灰烟比昨日偏东二里，像一根钉在暮色里的木刺，无声地逼向营垒；而明日北帐点卯，主角将接过一队人的性命。', type: '悬念钩', intensity: 3 },
    };
    const registered = pleasure.registerHooksFromOutline(book.id, outline, 20);
    assert.equal(registered.length, 2, '灰烟钩与名册钩是两个事件，应各自保留；复合 ending_hook 与灰烟钩同意象才被去重');
    assert.ok(registered.some(d => d.includes('名册')), '名册钩应保留（与复合钩仅共享"北帐点卯"引用，不得误并）');
    assert.ok(!registered.some(d => d.includes('木刺')), '复合 ending_hook 与灰烟钩同意象，应被去重');

    // 更尖锐场景：new_hooks 只有名册钩时，复合钩不得因"北帐点卯"被误并
    const book2 = freshBook();
    const o2 = {
      new_hooks: ['候补兵将提伙长的名册传开，陈七预告次日北帐点卯（第21章兑现）'],
 ending_hook: { desc: '灰烟比昨日偏东二里，像一根钉在暮色里的木刺，无声地逼向营垒；而明日北帐点卯，主角将接过一队人的性命。', type: '悬念钩', intensity: 3 },
    };
    const r2 = pleasure.registerHooksFromOutline(book2.id, o2, 20);
    assert.equal(r2.length, 2, '仅共享"北帐点卯"引用不是同意象，复合钩与名册钩都应保留');
  });
});
