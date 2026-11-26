/* 侧栏脚部两个按钮的行为（#426 / #427）。

   1. 「运行日志窗口」按钮不再请求 /console/toggle，也不再让服务端 spawn 进程：它直接
      在新窗口打开 ?tab=logs，Windows / macOS / 容器同一条路。
   2. 关闭服务不能凭一次 postJSON 的成败宣布成功：容器或守护进程会把进程
      重新拉起，所以必须用 /health 复核；仍在运行时要如实提示。

   Run with: node tests/_test_console_shutdown.js
*/
'use strict';
const assert = require('assert');
const {dashboardHtml, dashboardScript} = require('./_dashboard_source.js');
const {loadDashboard} = require('./_dashboard_sandbox.js');

const html = dashboardHtml();

/* ---- 1. 结构：按钮接的是新窗口，不是服务端进程 ------------------------- */

assert.ok(/id="btnConsoleToggle"[^>]*onclick="toggleConsoleWindow\(\)"/.test(html),
  '侧栏要有日志窗口按钮，并接上 toggleConsoleWindow()');
assert.ok(/id="btnConsoleToggle"[^>]*title="在新窗口打开运行日志"/.test(html),
  '按钮提示要说明它是打开窗口，不是开关一个进程');
assert.ok(/id="btnGatewayShutdown"[^>]*onclick="shutdownGateway\(\)"/.test(html),
  '侧栏要有关闭网关按钮，并接上 shutdownGateway()');
assert.ok(/window\.open\('\/dashboard\?tab=logs'/.test(html),
  '眼睛按钮要直接 window.open 运行日志页');
assert.ok(!/postJSON\('\/console\/toggle'/.test(html),
  '页面不应再请求 /console/toggle');

/* ---- 2. 行为：弹窗成功 / 被拦截 --------------------------------------- */

const toasts = [];
let healthOk = true;
const page = loadDashboard({
  realTimers: true,
  confirm: () => true,
  fetch: (url) => {
    if (String(url).indexOf('/health') !== -1) {
      if (!healthOk) return Promise.reject(new Error('connection refused'));
      return Promise.resolve({status: 200, ok: true, json: () => Promise.resolve({ok: true})});
    }
    return Promise.resolve({status: 200, ok: true, json: () => Promise.resolve({ok: true})});
  },
});
page.toast = (msg, kind) => toasts.push({msg: String(msg), kind: kind});

let opened = null;
page.open = (url, name, features) => {
  opened = {url: String(url), name: String(name), features: String(features)};
  return {focus: () => {}};
};
page.toggleConsoleWindow();
assert.deepStrictEqual(opened.url, '/dashboard?tab=logs');
assert.strictEqual(opened.name, 'wb-logs');
assert.strictEqual(toasts.pop().kind, 'ok', '打开成功要给 ok 提示');

page.open = () => null;
toasts.length = 0;
page.toggleConsoleWindow();
assert.strictEqual(toasts.pop().kind, 'bad', '弹窗被拦截要明确报错');

/* ---- 3. 关闭服务：仍活着就不能说「已关闭」 ----------------------------- */

(async () => {
  const shutdownButton = () => page.document.getElementById('btnGatewayShutdown');

  // 服务还在：/shutdown 成功，但 /health 一直 200（容器自动拉起）。
  healthOk = true;
  toasts.length = 0;
  await page.shutdownGateway({pollMs: 0, tries: 2});
  assert.ok(/仍在运行/.test(toasts.pop().msg),
    'health 还在应答时必须提示服务仍在运行');
  assert.strictEqual(shutdownButton().disabled, false,
    '关闭失败不能把按钮永久禁用');

  // 服务真的退出：/health 连接失败。
  healthOk = false;
  toasts.length = 0;
  await page.shutdownGateway({pollMs: 0, tries: 2});
  assert.ok(/已关闭/.test(toasts.pop().msg),
    'health 不再应答才算关闭成功');
  assert.strictEqual(shutdownButton().disabled, true,
    '确认关闭后按钮应禁用');
  // 侧栏脚上的状态灯转红：旧顶栏的 #statusDot 随旧壳删除，灯现在在这里。
  assert.ok(page.document.getElementById('nextStatusDot').classList.contains('err'),
    '确认关闭后状态灯应转红');
  assert.ok(!html.includes('id="statusDot"') && !/getElementById\('statusDot'\)/.test(dashboardScript()),
    '旧顶栏的状态灯 #statusDot 已删除，脚本不应再引用它');

  console.log('console/shutdown suite ok');
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
