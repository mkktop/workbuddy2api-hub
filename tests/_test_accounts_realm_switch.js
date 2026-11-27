/* 账号页自己的版本（国际版 / 国内版）切换。
 *
 * 账号列表、「当前禁用」与签到记录都按 window.VIEW_REALM 过滤，可切换视图的入口
 * 原本只有网关页那两张出口卡片——账号独立成页签之后，换一版得先跳回网关页，再跳
 * 回来。这里钉住补上的那个入口：
 *
 *   1. 控件在 #pageAccounts 里，两个按钮切的就是 switchViewRealm，与网关页两张
 *      卡片同一份状态，所以两边永远一起亮（updateUI 一处改，两边都跟着变）；
 *   2. 控件固定在账号页的页头（#accountsHeader）里：旧的「账号独立成一个页签」
 *      开关连同它那套搬家逻辑一起删除了，脚本不再移动它；
 *   3. 账号与网关共用浏览视图。运行详情使用独立的请求筛选，旧路径的默认上游在设置里保存。
 *
 * 这些错法在页面上都只是「切了没反应」「两边显示的不是同一版」，单看代码看不出来，
 * 所以既查结构也把整段脚本配假 DOM 跑起来。
 *
 * Run with Node: node tests/_test_accounts_realm_switch.js
 */
'use strict';
const assert = require('assert');
const {dashboardHtml, dashboardScript} = require('./_dashboard_source.js');
const dom = require('./_dom_stub.js');

const html = dashboardHtml();
const script = dashboardScript();

/* ---- 1. 结构：控件在账号页里，接的是 switchViewRealm ------------------ */

const pageAccountsAt = html.indexOf('<div id="pageAccounts"');
const pageAnalyticsAt = html.indexOf('<div id="pageAnalytics"');
const switchAt = html.indexOf('id="accountsRealmSwitch"');
assert.ok(pageAccountsAt > 0 && pageAnalyticsAt > pageAccountsAt,
  '页面顺序应为 accounts → analytics');
assert.ok(switchAt > pageAccountsAt && switchAt < pageAnalyticsAt,
  '版本切换控件必须落在 #pageAccounts 里');
assert.equal(html.split('id="accountsRealmSwitch"').length, 1 + 1,
  '控件只能有一份，不能两处各写一个');

// 控件固定在账号页页头里：它靠 id 定位，不靠位置。数一下页头到控件之间 div 的
// 开合深度，确认控件在页头容器**内部**，而不是页头之后的兄弟节点。
assert.ok(/<div id="accountsHeader"[^>]*>/.test(html), '账号页页头缺少 #accountsHeader');
const headerAt = html.indexOf('id="accountsHeader"');
assert.ok(headerAt > pageAccountsAt && headerAt < switchAt,
  '控件应写在账号页页头里');
const insideHeader = html.slice(headerAt, switchAt).replace(/<!--[\s\S]*?-->/g, '');
const headerDepth = (insideHeader.match(/<div\b/g) || []).length - (insideHeader.match(/<\/div>/g) || []).length;
assert.equal(headerDepth, 1, '控件应写在 #accountsHeader 容器内部，而不是页头之外');

// 两个按钮分别切 intl / cn，且是同一份状态（同一个函数）
assert.ok(/id="accountsRealmIntl"[^>]*onclick="switchViewRealm\('intl'\)"/.test(html),
  '「国际版」按钮应接上 switchViewRealm(\'intl\')');
assert.ok(/id="accountsRealmCn"[^>]*onclick="switchViewRealm\('cn'\)"/.test(html),
  '「国内版」按钮应接上 switchViewRealm(\'cn\')');
assert.ok(/id="accountsRealmCodearts"[^>]*onclick="switchViewRealm\('codearts'\)"/.test(html),
  '「CodeArts」按钮应接上 switchViewRealm(\'codearts\')');
for(const realm of ['intl', 'cn', 'minimax']){
  assert.equal(html.split('onclick="switchViewRealm(\'' + realm + '\')"').length - 1, 3,
    '网关、账号和智能体应共用 ' + realm + ' 的切换入口');
  assert.equal(html.split('onclick="switchRuntimeRealm(\'' + realm + '\')"').length - 1, 1,
    '运行详情应能单独按 ' + realm + ' 筛选');
}

// 控件不再被脚本搬动：旧的页签合并模式（把账号区块连控件搬到网关页）已删除，
// 脚本里不该再有任何地方按 id 抓住它再 insertBefore / appendChild。
assert.ok(!/getElementById\('accountsRealmSwitch'\)/.test(script),
  '控件应固定在账号页页头里，脚本不应再搬动它');

// 英文词条：aria-label 也在被翻译的属性里，缺了就会漏出中文
for(const [zh, en] of [['按上游出口查看', 'View by upstream route'],
                       ['WorkBuddy 国际版', 'WorkBuddy Global'],
                       ['WorkBuddy 国内版', 'WorkBuddy China']]){
  assert.ok(html.includes("'" + zh + "': '" + en + "'"),
    'DICT 里缺少「' + zh + '」的英文词条');
}

/* ---- 2. 行为：切换、同步、控件留在账号页 ------------------------------ */

let POSTS = [];
const realmState = {current: 'intl'};
dom.installDom({
  confirm: () => true,
  fetch: (url, opts) => {
    if(opts && opts.method === 'POST'){
      POSTS.push({url: String(url), body: String(opts.body || '')});
      const body = JSON.parse(String(opts.body || '{}'));
      if(body.realm) realmState.current = body.realm;
    }
    const payload = {current: realmState.current, accounts: [], slots: [], data: [],
                     results: [], byAccount: [], models: [], rows: [], total: 0};
    // 服务端字段还留着：老部署里存着「合并」（false），面板不应再照它搬家。
    if(String(url) === '/settings') payload.accounts_separate_tab = false;
    return Promise.resolve({
      status: 200, ok: true,
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(JSON.stringify(payload)),
    });
  },
});

// 账号页页头（控件的固定位置）与账号页里的区块。
const byId = id => document.getElementById(id);
const pageAccounts = byId('pageAccounts');
const header = byId('accountsHeader');
const realmSwitch = byId('accountsRealmSwitch');
const sectionA = dom.makeElement('section');
const sectionB = dom.makeElement('section');

pageAccounts.appendChild(header);
header.appendChild(realmSwitch);
pageAccounts.appendChild(sectionA);
pageAccounts.appendChild(sectionB);

const realLog = console.log;
console.log = () => {};
let api;
try {
  api = new Function(script + `
    window.updateUI = updateUI;
    window.toast = toast;
    return {
      updateUI: updateUI,
      switchViewRealm: switchViewRealm,
      switchRuntimeRealm,
      saveLegacyRealm,
      recentUrl,
      loadSettings: loadSettings,
      view: () => window.VIEW_REALM,
      active: () => window.ACTIVE_GATEWAY_REALM,
    };`)();
} catch(e) {
  console.log = realLog;
  console.error('脚本求值失败:', e.message);
  process.exit(1);
}
console.log = realLog;

const activeOf = el => el.classList.contains('active');

(async () => {
  // 2a. 控件固定在账号页页头里。旧的合并模式靠 loadSettings 里的开关把账号区块
  //     搬去网关页；现在服务端哪怕仍存着 accounts_separate_tab=false，也不搬。
  await api.loadSettings(false);
  assert.equal(realmSwitch.parentNode, header, '控件应留在账号页页头里');
  assert.equal(sectionA.parentNode, pageAccounts, '账号区块应留在账号页里');
  assert.equal(sectionB.parentNode, pageAccounts, '账号区块应留在账号页里');
  assert.ok(header.children.indexOf(realmSwitch) >= 0, '控件应挂在页头下');

  // 2c. 账号页使用共享视图，运行详情的筛选独立。
  await api.switchViewRealm('cn');
  assert.equal(api.view(), 'cn', '切换后视图应为国内版');
  assert.ok(activeOf(byId('accountsRealmCn')), '账号页「国内版」应高亮');
  assert.ok(!activeOf(byId('accountsRealmIntl')), '账号页「国际版」应熄灭');
  assert.equal(byId('accountsRealmCn').getAttribute('aria-pressed'), 'true',
    'aria-pressed 应跟着走');
  assert.equal(byId('accountsRealmIntl').getAttribute('aria-pressed'), 'false',
    'aria-pressed 应跟着走');
  assert.ok(activeOf(byId('runtimeAll')));
  assert.match(api.recentUrl(), /realm=all/);

  // 2d. 切回国际版：对称
  await api.switchViewRealm('intl');
  assert.equal(api.view(), 'intl', '切换后视图应为国际版');
  assert.ok(activeOf(byId('accountsRealmIntl')), '账号页「国际版」应高亮');
  assert.ok(!activeOf(byId('accountsRealmCn')), '账号页「国内版」应熄灭');

  // 2e. 同一个入口幂等：已经是这一版时再点一次不炸、也不换版
  await api.switchViewRealm('intl');
  assert.equal(api.view(), 'intl', '重复点当前版本应保持不动');

  // 2f. 设置旧路径默认出口只写兼容设置。
  realmState.current = 'intl';
  window.ACTIVE_GATEWAY_REALM = 'intl';
  window.VIEW_REALM = 'intl';
  api.updateUI();
  POSTS = [];
  byId('legacyRealmSelect').value = 'cn';
  await api.saveLegacyRealm(byId('saveLegacyRealmBtn'));
  assert.equal(api.active(), 'cn', '默认出口应切到国内版');
  assert.equal(POSTS.length, 1, '应只提交一次 /realm');
  assert.ok(/^\/realm/.test(POSTS[0].url), '切换默认出口应打 /realm');
  assert.equal(api.view(), 'intl', '旧路径设置应独立于账号视图');
  assert.ok(activeOf(byId('runtimeAll')));

  // 2g. 控件只切视图，不该偷偷改默认出口
  realmState.current = 'intl';
  window.ACTIVE_GATEWAY_REALM = 'intl';
  POSTS = [];
  await api.switchViewRealm('cn');
  assert.equal(api.active(), 'intl', '在账号页切视图不得改网关默认出口');
  assert.equal(POSTS.length, 0, '切视图不该发任何写请求');

  window.REALM_OPTIONS = ['intl', 'cn', 'minimax'];
  await api.switchViewRealm('minimax');
  assert.equal(api.view(), 'minimax');
  assert.equal(api.active(), 'intl');
  assert.equal(POSTS.length, 0);
  assert.equal(byId('accountsRealmMiniMax').getAttribute('aria-pressed'), 'true');
  assert.equal(byId('minimaxAccountsSection').hidden, false);
  assert.equal(byId('workbuddyAccountsSection').style.display, 'none');
  assert.match(byId('recentRealmTag').textContent, /全部请求/);
  await api.switchRuntimeRealm('minimax');
  assert.equal(POSTS.length, 0);
  assert.match(api.recentUrl(), /realm=minimax/);
  assert.match(byId('recentRealmTag').textContent, /MiniMax/);
  assert.equal(byId('tabMiniMax').getAttribute('aria-pressed'), 'true');
  assert.equal(byId('runtimeScheduler').hidden, true);
  await api.switchViewRealm('intl');
  assert.equal(byId('minimaxAccountsSection').hidden, true);
  assert.equal(byId('workbuddyAccountsSection').style.display, '');
  assert.match(api.recentUrl(), /realm=minimax/);
  await api.switchRuntimeRealm('all');
  assert.match(api.recentUrl(), /realm=all/);
  assert.equal(byId('runtimeScheduler').hidden, false);

  window.CHANNEL_STATES = {intl: false, cn: true, minimax: false, codearts: false};
  api.updateUI();
  assert.equal(api.view(), 'cn', '停用当前渠道后自动选择已开启渠道');
  assert.equal(byId('accountsRealmIntl').hidden, true);
  assert.equal(byId('accountsRealmMiniMax').hidden, true);
  assert.equal(byId('accountsRealmCodearts').hidden, true);
  assert.equal(byId('accountsRealmCn').hidden, false);
  await api.switchViewRealm('codearts');
  assert.equal(api.view(), 'cn', '不能切至停用渠道');
  window.CHANNEL_STATES.cn = false;
  api.updateUI();
  assert.equal(byId('accountsHeader').hidden, true);
  assert.equal(byId('accountsNoChannels').hidden, false);
  assert.equal(byId('workbuddyAccountsSection').style.display, 'none');

  console.log('accounts realm switch assertions passed');
})().catch(error => { console.log = realLog; console.error(error); process.exit(1); });
