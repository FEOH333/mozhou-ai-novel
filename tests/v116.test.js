// V0.93 自动创作界面：卡章暂停语义、生命周期检查点与当前发布能力可见
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const workshop = fs.readFileSync(path.join(ROOT, 'web/js/views/workshop.js'), 'utf8');
const library = fs.readFileSync(path.join(ROOT, 'web/js/views/library.js'), 'utf8');

describe('V0.93 自动创作状态可见且不误导', () => {
  test('卡章事件明确显示暂停后续创作，不再声称跳过继续写', () => {
    const start = workshop.indexOf("case 'chapter_blocked':");
    const end = workshop.indexOf("case 'blocked_fixed':", start);
    assert.ok(start >= 0 && end > start, '缺 chapter_blocked 事件处理');
    const block = workshop.slice(start, end);
    assert.match(block, /已暂停后续创作/);
    assert.doesNotMatch(block, /已跳过继续写后续章节/);
  });

  test('卷末生命周期检查点进入事件流，能看到当前阶段和待处理数', () => {
    assert.ok(workshop.includes("case 'lifecycle_checkpoint':"), '前端缺 lifecycle_checkpoint 事件处理');
    assert.match(workshop, /生命周期检查点|阶段检查点/);
    assert.match(workshop, /blockingCount|blocking_count/);
  });

  test('作品库说明当前是观察驾驶舱，不再钉死过时版本号', () => {
    assert.doesNotMatch(library, /墨舟 V0\.93/);
    assert.match(library, /观察自动创作|进度在顶栏/);
  });
});
