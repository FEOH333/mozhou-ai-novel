import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLocalRules } from '../server/engine/rules.js';

test('规则: AI 高频词', () => {
  const issues = runLocalRules('他微微一笑，不禁感叹。她微微点头，仿佛懂了。他微微皱眉，顿时沉默。');
  const cliche = issues.filter(i => i.issue.includes('微微'));
  assert.ok(cliche.length > 0);
});

test('规则: 对话标签过密', () => {
  const text = '他说：“你好。”她说：“再见。”他问：“真的吗？”她答道：“当然。”';
  const issues = runLocalRules(text);
  assert.ok(issues.some(i => i.type === '语句质量' && i.issue.includes('对话标签')));
});

test('规则: 单条对话标签不误报', () => {
  const text = '他说道：“走吧。”她没有回答，只是看着远处。';
  const issues = runLocalRules(text);
  assert.ok(!issues.some(i => i.issue.includes('对话标签')));
});

test('规则: 重复字', () => {
  const issues = runLocalRules('他他他站在那里。');
  assert.ok(issues.some(i => i.issue.includes('重复')));
});

test('规则: 语气词重复不误报', () => {
  const issues = runLocalRules('哈哈哈，你说得对。');
  assert.ok(!issues.some(i => i.issue.includes('重复')));
});

test('规则: 正常文本尽量少报', () => {
  const clean = '雨停的时候，她推开了窗。远处有船靠岸，缆绳落在青石板上，发出沉闷的响声。\n她转头看了他一眼："走吧。"\n他沉默地跟了上去。';
  const issues = runLocalRules(clean);
  assert.equal(issues.length, 0, JSON.stringify(issues));
});
