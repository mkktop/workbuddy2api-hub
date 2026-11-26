/* 账号行「⋯」菜单（openAcctMenu）的接线与行为。
 *
 * 由 2026-11 工作台重排引入：行里只留「测试 / 启停 / ⋯」，低频操作收进一个挂在
 * body 上的小浮层。菜单项调的还是原来那些函数，只是把菜单项自己当 btn 传进去。
 *
 * 这里钉四件事：
 *   1. 行内只有三个按钮，被搬走的操作确实不在行里；
 *   2. 菜单项齐全、顺序固定、外壳（role / aria-label / 昵称头）正确，且各账号
 *      状态下该隐藏的项（API Key 没有同步昵称与任务）确实不出现；
 *   3. 开关行为：同键再点关闭、换账号先关旧的、点外面关、Esc 关并把焦点还给
 *      按钮、重画时锚点没了就关；document / window 上的监听随开随挂、随关随摘；
 *   4. 文案进 EN / 繁體词典（新文案不能只在中文界面里成立）。
 *
 * 浮层的样式（.acct-menu-pop）不在本套件里，见 _test_mobile_account_layout.js。
 *
 * Run with Node: node tests/_test_account_menu.js
 */
'use strict';
const assert = require('assert');
const {dashboardScript} = require('./_dashboard_source.js');
const dom = require('./_dom_stub.js');

const script = dashboardScript();
dom.installDom({
  fetch: () => Promise.resolve({status: 200, ok: true,
    json: () => Promise.resolve({}), text: () => Promise.resolve('{}')}),
});

const realLog = console.log;
console.log = () => {};
let api;
try {
  api = new Function(script + `
    return {
      openAcctMenu: openAcctMenu,
      closeAcctMenu: closeAcctMenu,
      acctMenuOutside: acctMenuOutside,
      acctMenuKey: acctMenuKey,
      menu: () => ACCT_MENU,
      accountRow: accountRow,
      renderAccounts: renderAccounts,
      WB_I18N: window.WB_I18N,
    };`)();
} catch (e) {
  console.log = realLog;
  console.error('脚本求值失败:', e.message);
  process.exit(1);
}
console.log = realLog;

let checks = 0;
function check(label, ok, detail) {
  checks++;
  assert.ok(ok, label + (detail === undefined ? '' : '  -> ' + detail));
}

/* ---- 测试装置：监听记录器 + 可控尺寸的浮层 ----------------------------- */

const docOn = [], docOff = [], winOn = [], winOff = [];
document.addEventListener = (type, fn, capture) => docOn.push({type, fn, capture: !!capture});
document.removeEventListener = (type, fn, capture) => docOff.push({type, fn, capture: !!capture});
window.addEventListener = (type, fn, capture) => winOn.push({type, fn, capture: !!capture});
window.removeEventListener = (type, fn, capture) => winOff.push({type, fn, capture: !!capture});

// openAcctMenu 用 document.createElement('div') 建浮层；桩上换成记录器，并给一个
// 固定的 200×300 尺寸（真浏览器里由内容撑开）。
let pops = [];
const stubCreate = document.createElement.bind(document);
document.createElement = tag => {
  const el = stubCreate(tag);
  const listeners = [];
  el._menuListeners = listeners;   // 先写再读：桩对未建模属性的读会直接抛错
  el.addEventListener = (type, fn, capture) => listeners.push({type, fn, capture: !!capture});
  el.offsetWidth = 200;
  el.offsetHeight = 300;
  pops.push(el);
  return el;
};
function popNow(){ return pops[pops.length - 1]; }

function makeBtn(rect){
  return {
    expanded: null, focused: 0,
    setAttribute(k, v){ if(k === 'aria-expanded') this.expanded = String(v); },
    getBoundingClientRect(){ return rect; },
    focus(){ this.focused += 1; },
  };
}
const RECT = {top: 376, bottom: 400, right: 600, left: 572, width: 28, height: 24};

const ACCT = {
  uid: 'uid-menu-1', nickname: '主号', realm: 'intl', enabled: true, product: 'vscode',
  tasksEnabled: true, note: '自用', group: '生产', disabledModels: ['glm-5.3'],
  poolScope: 'text', expiresIn: '30 days', credits: null, source: 'oauth',
};
function reset(account){
  api.closeAcctMenu();
  pops = [];
  docOn.length = docOff.length = winOn.length = winOff.length = 0;
  window.ACCOUNTS = [Object.assign({}, ACCT, account || {})];
}
function menuHtml(){
  const m = api.menu();
  return m && m.pop ? m.pop.innerHTML : '';
}

/* ---- 1. 行内只剩三个按钮 ---------------------------------------------- */

// 裸账号：没有备注 / 分组 / 禁用模型 / 任务 / 媒体号池标签——行里就不该出现任何
// 被搬进菜单的操作（有标签时标签自己仍是可点的快捷入口，见第 3 节的转义用例）。
const row = api.accountRow(Object.assign({}, ACCT,
  {note: '', group: '', tasksEnabled: false, disabledModels: []}));
check('行内应只有「测试 / 启停 / ⋯」三个按钮',
  (row.match(/<button /g) || []).length === 3, row);
check('行内缺少「测试」按钮', row.includes('class="sec mini" onclick="testAccount(&quot;uid-menu-1&quot;, this)">测试</button>'));
check('行内缺少启停按钮', /onclick="toggleAccount\(&quot;uid-menu-1&quot;,(true|false),this\)">(启用|停用)<\/button>/.test(row), row);
check('行内缺少「⋯」按钮',
  row.includes('<button class="sec mini acct-more" aria-haspopup="menu" aria-expanded="false" title="更多操作"'
    + ' onclick="openAcctMenu(&quot;uid-menu-1&quot;, this)">⋯</button>'), row);
for (const moved of ['syncProfile(', 'exportOne(', 'setAccountProduct(', 'refreshOne(',
                     'deleteAccount(', 'editAccountNote(', 'editAccountGroup(',
                     'editAccountDisabledModels(', 'toggleAccountTasks(', 'toggleAccountPoolScope(']) {
  check('低频操作不该再出现在行内：' + moved, !row.includes(moved), row);
}

/* ---- 2. 菜单项：齐全、顺序固定、外壳正确 ------------------------------- */

reset();
const btn = makeBtn(RECT);
api.openAcctMenu('uid-menu-1', btn);
const m = api.menu();
check('菜单应已打开', !!m && !!m.pop);
const pop = popNow();
check('浮层挂在 body 上', pop.parentNode === document.body);
check('浮层 id', pop.id === 'acctMenuPop', pop.id);
check('浮层 role=menu', pop.getAttribute('role') === 'menu', pop.getAttribute('role'));
check('浮层 aria-label=账号操作', pop.getAttribute('aria-label') === '账号操作', pop.getAttribute('aria-label'));
check('锚点按钮 aria-expanded 应为 true', btn.expanded === 'true', btn.expanded);

const item = (label, act, val, danger) => '<button type="button" role="menuitem"'
  + (danger ? ' class="danger"' : '') + ' onclick="' + act + '">' + label
  + (val ? '<span class="menu-val">' + val + '</span>' : '') + '</button>';
const q = v => '&quot;' + v + '&quot;';
const html = menuHtml();
const expected = [
  ['昵称头', '<div class="acct-menu-head">主号</div>'],
  ['刷新凭证', item('刷新凭证', 'refreshOne(' + q('uid-menu-1') + ',this)')],
  ['同步昵称', item('同步昵称', 'syncProfile(' + q('uid-menu-1') + ',this)')],
  ['导出', item('导出', 'exportOne(' + q('uid-menu-1') + ')')],
  ['任务开', item('任务开', 'toggleAccountTasks(' + q('uid-menu-1') + ',false)')],
  ['移入媒体号池', item('移入媒体号池', 'toggleAccountPoolScope(' + q('uid-menu-1') + ',true)')],
  ['备注', item('备注', 'editAccountNote(' + q('uid-menu-1') + ')', '自用')],
  ['分组', item('分组', 'editAccountGroup(' + q('uid-menu-1') + ')', '生产')],
  ['禁用模型', item('禁用模型', 'editAccountDisabledModels(' + q('uid-menu-1') + ')', 'glm-5.3')],
  ['停用', item('停用', 'toggleAccount(' + q('uid-menu-1') + ',false,this)')],
  ['删除', item('删除', 'deleteAccount(' + q('uid-menu-1') + ',' + q('主号') + ',this)', '', true)],
];
for (const [label, frag] of expected) {
  check('菜单缺少「' + label + '」项', html.includes(frag), frag + '  |  ' + html);
}
// 出站身份：三枚分段按钮，当前项高亮（这个账号是 vscode）。
check('菜单缺少「出站身份：」标签', html.includes('<span class="id-btn-label">出站身份：</span>'), html);
for (const [prod, label] of [['workbuddy', 'WB'], ['vscode', 'VSC'], ['cli', 'CLI']]) {
  const frag = '<button type="button" class="id-btn' + (prod === 'vscode' ? ' active' : '')
    + '" onclick="setAccountProduct(' + q('uid-menu-1') + ',' + q(prod) + ', this)">' + label + '</button>';
  check('出站身份缺少 ' + label, html.includes(frag), frag);
}
check('出站身份只该高亮当前产品', (html.match(/class="id-btn active"/g) || []).length === 1, html);
// 顺序：导出 → 出站身份 → 任务 → 号池 → 备注 → 分组 → 禁用模型 → 停用 → 删除。
{
  const order = ['acct-menu-head', '刷新凭证', '同步昵称', '导出', '出站身份：', '任务开', '移入媒体号池',
                 '备注', '分组', '禁用模型', '停用', '删除'];
  const at = order.map(s => html.indexOf(s));
  check('菜单项顺序固定（' + order.join(' → ') + '）',
    at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1])), at);
}
check('三个分组分隔线', (html.match(/role="separator"/g) || []).length === 3,
  (html.match(/role="separator"/g) || []).length);
// 菜单项自己就是传给函数的 btn：改 disabled / 文案都落在菜单项上。
check('菜单项应是 type=button（不触发表单提交）', (html.match(/<button type="button"/g) || []).length >= 12);

/* ---- 2b. 账号状态决定菜单内容 ----------------------------------------- */

// 凭证失效：刷新凭证换成重新登录（扫码授权按账号自己的区域开）。
reset({tokenExpired: true});
api.openAcctMenu('uid-menu-1', makeBtn(RECT));
check('凭证失效时应给「重新登录」', menuHtml().includes(
  item('重新登录', 'openLoginModal(' + q('intl') + ')')), menuHtml());
check('凭证失效时不应再给「刷新凭证」', !menuHtml().includes('refreshOne('), menuHtml());

// 静态 API Key：没有同步昵称、没有任务开关，其余照旧。
reset({apiKey: true, credentialMask: 'ck_****abcd'});
api.openAcctMenu('uid-menu-1', makeBtn(RECT));
check('API Key 账号不应出现「同步昵称」', !menuHtml().includes('syncProfile('), menuHtml());
check('API Key 账号不应出现「任务开 / 任务关」', !menuHtml().includes('toggleAccountTasks('), menuHtml());
check('API Key 账号仍应有导出与删除', menuHtml().includes('exportOne(') && menuHtml().includes('deleteAccount('));

// 任务关着：菜单项标「任务关」，点击是打开。
reset({tasksEnabled: false});
api.openAcctMenu('uid-menu-1', makeBtn(RECT));
check('任务关着时菜单应标「任务关」并按「打开」接线',
  menuHtml().includes(item('任务关', 'toggleAccountTasks(' + q('uid-menu-1') + ',true)')), menuHtml());

// 已在媒体号池：菜单项反过来是「移入文本号池」。
reset({poolScope: 'media'});
api.openAcctMenu('uid-menu-1', makeBtn(RECT));
check('媒体号池里的账号应给「移入文本号池」', menuHtml().includes(
  item('移入文本号池', 'toggleAccountPoolScope(' + q('uid-menu-1') + ',false)')), menuHtml());

// 已停用的账号：菜单项是「启用」。
reset({enabled: false});
api.openAcctMenu('uid-menu-1', makeBtn(RECT));
check('停用账号应给「启用」', menuHtml().includes(
  item('启用', 'toggleAccount(' + q('uid-menu-1') + ',true,this)')), menuHtml());

/* ---- 3. 开关行为 ------------------------------------------------------- */

// 打开时挂四个监听：document 的 pointerdown（捕获）/ keydown、window 的 resize /
// scroll（捕获）。关闭时原样摘掉（同一个函数引用、同样的捕获标志）。
reset();
const btnOpen = makeBtn(RECT);
api.openAcctMenu('uid-menu-1', btnOpen);
check('document 应挂 pointerdown（捕获阶段）',
  docOn.some(l => l.type === 'pointerdown' && l.capture && l.fn === api.acctMenuOutside), docOn.map(l => l.type));
check('document 应挂 keydown', docOn.some(l => l.type === 'keydown' && l.fn === api.acctMenuKey), docOn.map(l => l.type));
check('window 应挂 resize 与 scroll（捕获）',
  winOn.some(l => l.type === 'resize' && l.fn === api.closeAcctMenu)
  && winOn.some(l => l.type === 'scroll' && l.capture && l.fn === api.closeAcctMenu),
  winOn.map(l => l.type + (l.capture ? '+' : '')));
check('浮层自己的 click 监听要在捕获阶段关菜单（先于菜单项的 onclick）',
  (popNow()._menuListeners || []).some(l => l.type === 'click' && l.capture), popNow()._menuListeners);
api.closeAcctMenu();
check('关闭后 document 的监听要摘掉',
  docOff.length === docOn.length && docOff.every((l, i) => l.fn === docOn[i].fn && l.capture === docOn[i].capture),
  docOff.map(l => l.type));
check('关闭后 window 的监听要摘掉',
  winOff.length === winOn.length && winOff.every((l, i) => l.fn === winOn[i].fn && l.capture === winOn[i].capture),
  winOff.map(l => l.type));
check('关闭后浮层从 body 上摘掉', popNow().parentNode === null);
check('关闭后锚点 aria-expanded 回到 false', btnOpen.expanded === 'false', btnOpen.expanded);

// 同一个按钮再点一次 = 关闭（按钮才点得第二下）。
reset();
const btnA = makeBtn(RECT);
api.openAcctMenu('uid-menu-1', btnA);
api.openAcctMenu('uid-menu-1', btnA);
check('同一个「⋯」按钮再点一次应关闭菜单', api.menu() === null && btnA.expanded === 'false', btnA.expanded);

// 换一个锚点：旧浮层先摘掉，只留一个。
reset();
const btnB = makeBtn(RECT), btnC = makeBtn(RECT);
api.openAcctMenu('uid-menu-1', btnB);
const firstPop = popNow();
api.openAcctMenu('uid-menu-1', btnC);
check('换锚点时应先关掉旧菜单', api.menu() && api.menu().btn === btnC && btnB.expanded === 'false', btnB.expanded);
check('旧浮层应从 body 上摘掉', firstPop.parentNode === null);
check('body 上同时只该有一个菜单',
  document.body.children.filter(el => el.id === 'acctMenuPop').length === 1);

// 点外面关；点浮层里、点锚点按钮本身都不关（后者的关闭交给 click 的 toggle）。
reset();
const btnOut = makeBtn(RECT);
api.openAcctMenu('uid-menu-1', btnOut);
api.acctMenuOutside({target: {}});
check('点菜单外面要关', api.menu() === null);
reset();
const btnInside = makeBtn(RECT);
api.openAcctMenu('uid-menu-1', btnInside);
// 桩的 contains() 拿 target 身份比较，代理元素传进去对不上；这里直接给它一个
// 会落在菜单里的节点（真浏览器里就是菜单项本身）。
{
  const inside = {tagName: 'BUTTON'};
  popNow().contains = node => node === inside;
  api.acctMenuOutside({target: inside});
}
check('点菜单里面不该关', api.menu() !== null);
api.acctMenuOutside({target: btnInside});
check('点锚点按钮本身时不在这里关（交给 click 的 toggle）', api.menu() !== null);

// Esc 关并把焦点还给按钮；别的键不关。
api.acctMenuKey({key: 'Enter'});
check('Esc 以外的键不该关菜单', api.menu() !== null);
api.acctMenuKey({key: 'Escape'});
check('Esc 应关闭菜单', api.menu() === null);
check('Esc 关闭后焦点应回到「⋯」按钮', btnInside.focused === 1, btnInside.focused);

// 未知 uid：什么都不做（不建浮层、不改锚点状态）。
reset();
const ghost = makeBtn(RECT);
const popsBefore = pops.length;
api.openAcctMenu('no-such-uid', ghost);
check('未知账号不该打开菜单', api.menu() === null && ghost.expanded === null);
check('未知账号不该建浮层', pops.length === popsBefore);

// 重画后锚点已经不在文档里：renderAccounts 要顺手关掉菜单。
check('renderAccounts 应关掉锚点已失效的菜单',
  /function renderAccounts\(\)\{[\s\S]{0,600}?document\.contains\(ACCT_MENU\.btn\)\) closeAcctMenu\(\);/.test(script));

/* ---- 3b. 浮层位置：贴按钮右缘、不出窗口、下面放不下就翻上去 -------- */

function openedAt(rect, innerW, innerH){
  reset();
  window.innerWidth = innerW;
  window.innerHeight = innerH;
  api.openAcctMenu('uid-menu-1', makeBtn(rect));
  const p = popNow();
  const out = {left: p.style.left, top: p.style.top};
  api.closeAcctMenu();
  return out;
}
let pos = openedAt(RECT, 1280, 800);
check('浮层右缘对齐按钮右缘', pos.left === '400px', pos.left);
check('浮层挂在按钮下方 4px', pos.top === '404px', pos.top);
pos = openedAt({top: 376, bottom: 400, right: 100, left: 72}, 1280, 800);
check('贴左边缘时至少留 8px', pos.left === '8px', pos.left);
pos = openedAt({top: 376, bottom: 400, right: 1279, left: 1251}, 1280, 800);
check('贴右边缘时不许出窗口', pos.left === '1072px', pos.left);
pos = openedAt({top: 676, bottom: 700, right: 600, left: 572}, 1280, 800);
check('下面放不下时翻到按钮上方', pos.top === '372px', pos.top);
pos = openedAt({top: 10, bottom: 34, right: 600, left: 572}, 1280, 200);
check('上下都放不下时仍不许出窗口', pos.top === '8px', pos.top);
window.innerWidth = 1280;
window.innerHeight = 900;

/* ---- 3c. 值里的尖括号与引号要转义 ------------------------------------- */

reset({nickname: '<img onerror=x>', note: 'a"b<c>&d', group: '<b>g</b>', disabledModels: ['m<1>']});
api.openAcctMenu('uid-menu-1', makeBtn(RECT));
const nasty = menuHtml();
check('昵称头要转义', nasty.includes('<div class="acct-menu-head">&lt;img onerror=x&gt;</div>'), nasty.slice(0, 160));
check('备注值要转义', nasty.includes('<span class="menu-val">a&quot;b&lt;c&gt;&amp;d</span>'), nasty);
check('分组值要转义', nasty.includes('<span class="menu-val">&lt;b&gt;g&lt;/b&gt;</span>'), nasty);
check('禁用名单要转义', nasty.includes('<span class="menu-val">m&lt;1&gt;</span>'), nasty);
// uid 会进 onclick 属性：只留安全字符，其余一律丢掉（上游 JWT 不受信）。
reset();
window.ACCOUNTS = [Object.assign({}, ACCT, {uid: 'uid")<x>@a.b'})];
api.openAcctMenu('uid")<x>@a.b', makeBtn(RECT));
check('uid 进 onclick 前要过滤掉危险字符', menuHtml().includes('refreshOne(&quot;uidx@a.b&quot;,this)'), menuHtml().slice(0, 300));

/* ---- 4. 三语：新文案不能只在中文界面里成立 -------------------------- */

const HAN = /[\u4e00-\u9fff]/;
// 这些字在繁體里写法不同；转换后还出现，说明漏了词条或走了逐字硬拼。
const SIMPLIFIED = ['账', '设', '码', '凭', '证', '删', '导', '测', '试', '启', '关', '开',
                    '称', '员', '类', '权', '记', '录', '页', '项', '间', '闭', '随', '额', '总'];
reset();
api.openAcctMenu('uid-menu-1', makeBtn(RECT));
const labels = ['更多操作', '账号操作', '出站身份：', '刷新凭证', '同步昵称', '导出',
                '任务开', '任务关', '移入媒体号池', '移入文本号池', '备注', '分组', '禁用模型',
                '停用', '启用', '删除'];
for (const label of labels) {
  const en = api.WB_I18N.translate(label);
  check('英文词典缺少「' + label + '」', !HAN.test(en) && en !== '', label + ' -> ' + en);
  const hant = api.WB_I18N.translateHant(label);
  const left = SIMPLIFIED.filter(ch => hant.includes(ch));
  check('繁體转换漏字「' + label + '」', left.length === 0, label + ' -> ' + hant + '  leftover=' + left.join(''));
}
// 整个菜单渲染出来的可见文本（去标签）也要能整段翻译，不留中文。账号自己的名称 /
// 备注 / 分组是用户数据，本来就不该被词典改写——这一条用 ASCII 值，只验固定文案。
reset({nickname: 'main', note: 'home', group: 'prod', disabledModels: ['glm-5.3']});
api.openAcctMenu('uid-menu-1', makeBtn(RECT));
const visible = menuHtml().replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const enAll = api.WB_I18N.translate(visible);
check('整段菜单的英文不应漏出中文', !HAN.test(enAll), enAll);
const hantAll = api.WB_I18N.translateHant(visible);
check('整段菜单的繁體不应漏出简体字',
  SIMPLIFIED.every(ch => !hantAll.includes(ch)), hantAll);

process.stdout.write('account menu: ' + checks + ' checks passed\n');
