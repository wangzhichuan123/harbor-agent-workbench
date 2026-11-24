#!/usr/bin/env node
'use strict';
/* 番茄钟核心逻辑测试：直接从 artifacts/pomodoro.html 中提取核心脚本执行，
   确保被测代码与交付的 HTML 是同一份实现。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const htmlPath = path.join(__dirname, 'pomodoro.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const match = html.match(/<script id="pomodoro-core">([\s\S]*?)<\/script>/);
if (!match) throw new Error('未在 pomodoro.html 中找到核心脚本');
const source = match[1];

const sandbox = { module: { exports: {} }, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'pomodoro.html#pomodoro-core' });

const core = sandbox.PomodoroCore || sandbox.module.exports;
assert.ok(core && core.Pomodoro, '核心导出缺失');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    console.error('  ✗ ' + name + '\n    ' + err.message);
    process.exitCode = 1;
    throw err;
  }
}

const MIN = 60 * 1000;

console.log('番茄钟核心逻辑测试');

test('默认时长为 25 分钟专注 / 5 分钟休息', () => {
  assert.strictEqual(core.durationMs(core.FOCUS), 25 * MIN);
  assert.strictEqual(core.durationMs(core.BREAK), 5 * MIN);
});

test('formatTime 格式化正确', () => {
  assert.strictEqual(core.formatTime(25 * MIN), '25:00');
  assert.strictEqual(core.formatTime(5 * MIN), '05:00');
  assert.strictEqual(core.formatTime(0), '00:00');
  assert.strictEqual(core.formatTime(65 * 1000), '01:05');
  assert.strictEqual(core.formatTime(-100), '00:00');
});

test('初始状态：未运行、专注模式、剩余 25 分钟', () => {
  const p = new core.Pomodoro();
  assert.strictEqual(p.isRunning(), false);
  assert.strictEqual(p.mode, core.FOCUS);
  assert.strictEqual(p.remainingMs, 25 * MIN);
});

test('自定义时长生效', () => {
  const p = new core.Pomodoro({ focusMinutes: 1, breakMinutes: 0.5 });
  assert.strictEqual(p.totalMs(), MIN);
  assert.strictEqual(core.durationMs(core.BREAK, p.options), 0.5 * MIN);
});

test('开始后按时间推进剩余时间', () => {
  const p = new core.Pomodoro();
  p.start(1000);
  assert.strictEqual(p.isRunning(), true);
  p.update(1000 + 60 * 1000);
  assert.strictEqual(p.remainingMs, 24 * MIN);
  assert.strictEqual(p.mode, core.FOCUS);
});

test('暂停冻结剩余时间，恢复后继续', () => {
  const p = new core.Pomodoro();
  p.start(0);
  p.update(5 * MIN);
  p.pause(5 * MIN);
  assert.strictEqual(p.isRunning(), false);
  assert.strictEqual(p.remainingMs, 20 * MIN);
  p.update(10 * MIN); // 暂停期间不流逝
  assert.strictEqual(p.remainingMs, 20 * MIN);
  p.start(10 * MIN);
  p.update(12 * MIN);
  assert.strictEqual(p.remainingMs, 18 * MIN);
});

test('重置回到当前模式完整时长并停止', () => {
  const p = new core.Pomodoro();
  p.start(0);
  p.update(7 * MIN);
  p.reset();
  assert.strictEqual(p.isRunning(), false);
  assert.strictEqual(p.remainingMs, 25 * MIN);
  assert.strictEqual(p.mode, core.FOCUS);
});

test('专注结束后自动切换到休息并重新计时', () => {
  const p = new core.Pomodoro();
  p.start(0);
  const r = p.update(25 * MIN);
  assert.strictEqual(r.completed, true);
  assert.strictEqual(r.completedMode, core.FOCUS);
  assert.strictEqual(r.nextMode, core.BREAK);
  assert.strictEqual(p.mode, core.BREAK);
  assert.strictEqual(p.remainingMs, 5 * MIN);
  assert.strictEqual(p.completedFocusCount, 1);
});

test('休息结束后切回专注', () => {
  const p = new core.Pomodoro();
  p.switchMode(core.BREAK);
  p.start(0);
  const r = p.update(5 * MIN);
  assert.strictEqual(r.completedMode, core.BREAK);
  assert.strictEqual(p.mode, core.FOCUS);
  assert.strictEqual(p.completedBreakCount, 1);
});

test('手动切换模式会重置该模式计时', () => {
  const p = new core.Pomodoro();
  p.start(0);
  p.update(3 * MIN);
  p.switchMode(core.BREAK);
  assert.strictEqual(p.isRunning(), false);
  assert.strictEqual(p.remainingMs, 5 * MIN);
  p.switchMode(core.FOCUS);
  assert.strictEqual(p.remainingMs, 25 * MIN);
});

test('重复开始不会叠加计时', () => {
  const p = new core.Pomodoro();
  p.start(0);
  p.start(0);
  p.update(2 * MIN);
  assert.strictEqual(p.remainingMs, 23 * MIN);
});

test('未运行时 update 不改变状态', () => {
  const p = new core.Pomodoro();
  const r = p.update(999 * MIN);
  assert.strictEqual(r.completed, false);
  assert.strictEqual(p.remainingMs, 25 * MIN);
});

test('未知模式抛出错误', () => {
  const p = new core.Pomodoro();
  assert.throws(() => p.switchMode('nope'));
});

test('HTML 中无外部资源引用（离线可用）', () => {
  assert.ok(!/src\s*=\s*["']https?:/i.test(html), '存在外部脚本');
  assert.ok(!/href\s*=\s*["']https?:/i.test(html), '存在外部样式/链接');
  assert.ok(!/@import\s+url/i.test(html), '存在 CSS 外部导入');
  assert.ok(html.includes('<script id="pomodoro-core">'), '核心脚本缺失');
});

console.log('\n--- 自定义专注时长 ---');

test('normalizeFocusMinutes 夹取到 1–60 范围', () => {
  assert.strictEqual(core.MIN_FOCUS_MINUTES, 1);
  assert.strictEqual(core.MAX_FOCUS_MINUTES, 60);
  assert.strictEqual(core.normalizeFocusMinutes(25), 25);
  assert.strictEqual(core.normalizeFocusMinutes(0), 1);
  assert.strictEqual(core.normalizeFocusMinutes(-10), 1);
  assert.strictEqual(core.normalizeFocusMinutes(61), 60);
  assert.strictEqual(core.normalizeFocusMinutes(999), 60);
  assert.strictEqual(core.normalizeFocusMinutes(30.4), 30);
  assert.strictEqual(core.normalizeFocusMinutes(30.6), 31);
  assert.strictEqual(core.normalizeFocusMinutes(NaN), 25);
  assert.strictEqual(core.normalizeFocusMinutes('20'), 25, '非数字应回退');
});

test('setFocusMinutes 设置后专注阶段时长随之改变', () => {
  const p = new core.Pomodoro();
  const applied = p.setFocusMinutes(45);
  assert.strictEqual(applied, 45);
  assert.strictEqual(p.getFocusMinutes(), 45);
  assert.strictEqual(p.totalMs(), 45 * MIN);
  assert.strictEqual(p.remainingMs, 45 * MIN);
});

test('setFocusMinutes 越界值被夹取', () => {
  const p = new core.Pomodoro();
  assert.strictEqual(p.setFocusMinutes(0), 1);
  assert.strictEqual(p.setFocusMinutes(61), 60);
  assert.strictEqual(p.getFocusMinutes(), 60);
});

test('构造时非法 focusMinutes 回退为 25', () => {
  const p = new core.Pomodoro({ focusMinutes: 999 });
  assert.strictEqual(p.getFocusMinutes(), 60, '构造时也应夹取上限');
  const q = new core.Pomodoro({ focusMinutes: -3 });
  assert.strictEqual(q.getFocusMinutes(), 1);
  const r = new core.Pomodoro({ focusMinutes: NaN });
  assert.strictEqual(r.getFocusMinutes(), 25, 'NaN 回退默认值');
});

test('应用新时长后专注阶段重新计时并停止运行', () => {
  const p = new core.Pomodoro();
  p.start(0);
  p.update(5 * MIN);
  p.setFocusMinutes(10);
  assert.strictEqual(p.isRunning(), false);
  assert.strictEqual(p.remainingMs, 10 * MIN);
});

test('休息阶段修改专注时长不影响当前休息计时', () => {
  const p = new core.Pomodoro();
  p.switchMode(core.BREAK);
  p.start(0);
  p.update(2 * MIN);
  p.setFocusMinutes(30);
  assert.strictEqual(p.mode, core.BREAK);
  assert.strictEqual(p.remainingMs, 3 * MIN, '休息剩余时间应保持');
  assert.strictEqual(p.isRunning(), true, '休息阶段不应被中断');
});

test('修改时长不影响已完成计数', () => {
  const p = new core.Pomodoro();
  p.start(0);
  p.update(25 * MIN);
  assert.strictEqual(p.completedFocusCount, 1);
  p.setFocusMinutes(10);
  assert.strictEqual(p.completedFocusCount, 1);
});

console.log('\n--- 已完成次数与防重复计数 ---');

test('初始计数为 0', () => {
  const p = new core.Pomodoro();
  assert.strictEqual(p.completedFocusCount, 0);
  assert.strictEqual(p.completedBreakCount, 0);
});

test('完成一次专注计数 +1 并自动进入休息', () => {
  const p = new core.Pomodoro();
  p.start(0);
  const r = p.update(25 * MIN);
  assert.strictEqual(r.completed, true);
  assert.strictEqual(p.completedFocusCount, 1);
  assert.strictEqual(p.completedBreakCount, 0);
  assert.strictEqual(p.mode, core.BREAK);
});

test('重复调用 update 不会重复计数', () => {
  const p = new core.Pomodoro();
  p.start(0);
  p.update(25 * MIN);
  assert.strictEqual(p.completedFocusCount, 1);
  // 同一时刻重复调用，不应再算一次专注
  p.update(25 * MIN);
  assert.strictEqual(p.completedFocusCount, 1);
  assert.strictEqual(p.completedBreakCount, 0);
  assert.strictEqual(p.mode, core.BREAK);
});

test('阶段切换不会重复计数（切回专注再完成）', () => {
  const p = new core.Pomodoro();
  p.start(0);
  p.update(25 * MIN);   // 完成专注 1
  assert.strictEqual(p.completedFocusCount, 1);
  p.update(30 * MIN);   // 完成休息 1
  assert.strictEqual(p.completedBreakCount, 1);
  assert.strictEqual(p.completedFocusCount, 1, '切阶段不应把专注再加一次');
  p.update(55 * MIN);   // 第二次专注完成
  assert.strictEqual(p.completedFocusCount, 2);
  assert.strictEqual(p.completedBreakCount, 1);
});

test('手动切换模式不产生计数', () => {
  const p = new core.Pomodoro();
  p.switchMode(core.BREAK);
  p.switchMode(core.FOCUS);
  p.switchMode(core.BREAK);
  assert.strictEqual(p.completedFocusCount, 0);
  assert.strictEqual(p.completedBreakCount, 0);
});

test('重置不产生计数且保留历史计数', () => {
  const p = new core.Pomodoro();
  p.start(0);
  p.update(25 * MIN);
  assert.strictEqual(p.completedFocusCount, 1);
  p.reset();
  assert.strictEqual(p.completedFocusCount, 1, '重置不应清空历史计数');
  assert.strictEqual(p.completedBreakCount, 0);
  assert.strictEqual(p.remainingMs, 5 * MIN, '重置后回到当前（休息）阶段的完整时长');
  assert.strictEqual(p.isRunning(), false);
});

test('完成一轮后计数累计正确（3 个专注 / 2 个休息）', () => {
  const p = new core.Pomodoro();
  p.start(0);
  let t = 0;
  for (let i = 0; i < 5; i++) {
    t += p.totalMs();
    p.update(t);
  }
  assert.strictEqual(p.completedFocusCount, 3);
  assert.strictEqual(p.completedBreakCount, 2);
});

test('自定义时长下的完成计数正确', () => {
  const p = new core.Pomodoro();
  p.setFocusMinutes(1);
  p.start(0);
  p.update(MIN); // 1 分钟专注完成
  assert.strictEqual(p.completedFocusCount, 1);
  assert.strictEqual(p.mode, core.BREAK);
  p.update(MIN + 5 * MIN); // 5 分钟休息完成
  assert.strictEqual(p.completedBreakCount, 1);
  assert.strictEqual(p.completedFocusCount, 1);
});

console.log('\n--- 界面结构 ---');

test('HTML 含自定义时长输入与计数展示元素', () => {
  ['focusMinutesInput', 'applyBtn', 'plusBtn', 'minusBtn', 'focusCount', 'breakCount'].forEach(id => {
    assert.ok(html.includes('id="' + id + '"'), '缺少元素: ' + id);
  });
  assert.ok(/id="focusMinutesInput"[^>]*min="1"[^>]*max="60"/.test(html), '输入框缺少 1–60 范围');
  assert.ok(html.includes('已完成专注'), '缺少已完成专注文案');
});

test('保留原有功能：开始/暂停/重置/模式切换按钮仍在', () => {
  ['startBtn', 'pauseBtn', 'resetBtn', 'focusTab', 'breakTab', 'display', 'stateText', 'progress'].forEach(id => {
    assert.ok(html.includes('id="' + id + '"'), '缺少元素: ' + id);
  });
});

console.log(`\n全部通过：${passed} 项测试`);
