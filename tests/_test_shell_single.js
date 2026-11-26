/* 面板只有一个壳：圣轮总览 + 一套侧栏 / 顶栏 / 手机底栏。
 *
 * 以前有三套界面叠在一起（传统布局、控制台布局、新导航），靠 URL 参数和
 * localStorage 里的几个键选，圣轮皮肤又是新导航上的一个开关。它们互相靠
 * html 属性与 !important 压着，删一套就可能把别处带塌——例如：
 *   - 旧布局靠一条按 data-console-layout 的规则藏内容区的筛选条（issue #850）；
 *   - 控制台布局的样式表默认不加载，却带走了一批「以为一直生效」的规则；
 *   - 旧顶栏的 #statusDot 没了，刷新失败那条路径会直接抛错。
 *
 * 所以这里钉住「只剩一套」这件事，并用沙箱跑一遍搬了家的那几段逻辑。
 *
 * Run with Node: node tests/_test_shell_single.js
 */
'use strict';
const assert = require('assert');
const {dashboardHtml, dashboardScript} = require('./_dashboard_source.js');
const {loadDashboard} = require('./_dashboard_sandbox.js');

const html = dashboardHtml();
const script = dashboardScript();
let checks = 0;
function check(ok, label, detail) {
  assert.ok(ok, label + (detail === undefined ? '' : '  -> ' + detail));
  checks += 1;
}

/* ---- 1. 静态：壳是唯一的，旧界面的开关与节点都不在了 --------------------- */

const root = /<html\s+([^>]*)>/.exec(html);
check(!!root, '找不到 <html> 标签');
check(/\bdata-ui="next"/.test(root[1]) && /\bdata-skin="sanctum"/.test(root[1]),
  '<html> 要静态带上唯一的壳与圣轮皮肤', root[1]);

// 旧界面靠这些键与属性选布局、选皮肤、存预设。留一个就可能有人写回一条依赖它的规则。
for (const gone of ['__NEXT_UI__', 'wb-ui-mode', 'wb-skin', '__SANCTUM_SKIN__', 'wb-console-layout',
                    'data-console-layout', 'wb-theme-style', 'data-theme-style', 'wb-theme-tuner',
                    '?ui=classic', 'defaultConsoleLayout']) {
  check(!html.includes(gone), '旧界面的开关不应残留：' + gone);
}

// 控制台壳的节点、样式表 id，以及旧顶栏。
check(!/console-shell|console-sidebar|console-contextbar|console-scrim|main-nav-btn/.test(html),
  '控制台壳的节点不应残留');
check(!/wb-alibaba-console|wb-console-v2|hdr-icon-btn|gh-link/.test(html),
  '控制台布局的样式表与旧顶栏按钮不应残留');
check(!/<header[\s>]/.test(html), '旧顶栏 <header> 不应残留');

// 主题菜单只有明暗三档；风格预设与调色台只服务于旧界面。
check(!/selectStyle|THEME_STYLES|themeOptClaude|themeOptAlibaba|themeOptMaterial|themeOptMiuix/.test(html),
  '主题风格预设不应残留');
check(!/tunerBox|toggleThemeTuner|tunerStyle|themeOptTuner/.test(html), '色彩调色台不应残留');
const menuAt = html.indexOf('<div class="theme-dropdown" id="themeDropdown"');
const menu = html.slice(menuAt, html.indexOf('</div>\n          </div>', menuAt));
const options = [...menu.matchAll(/<button type="button" class="theme-option" id="(themeOpt\w+)"/g)].map(m => m[1]);
check(JSON.stringify(options) === JSON.stringify(['themeOptLight', 'themeOptDark', 'themeOptSystem']),
  '主题菜单应恰好是浅色 / 深色 / 跟随系统', options.join(','));

/* ---- 2. 静态：语言 / 状态 / 主题控件就长在顶栏里，不再靠脚本搬运 ----------- */

// 以前这几个控件写在旧顶栏里，脚本启动时把它们搬进新顶栏；旧顶栏删除后它们直接
// 写在新顶栏的容器 #nextTopbarActions 里，id 与内联事件都保持原样。
const actionsAt = html.indexOf('<div class="next-topbar-actions" id="nextTopbarActions">');
const actionsEnd = html.indexOf('<div id="nextContent">', actionsAt);
check(actionsAt > 0 && actionsEnd > actionsAt, '找不到顶栏右侧容器 #nextTopbarActions');
const actions = html.slice(actionsAt, actionsEnd);
for (const [id, handler] of [['langToggleBtn', 'toggleLang(event)'], ['themeToggleBtn', 'toggleThemeMenu(event)'],
                             ['themeOptLight', "selectTheme('light', event)"],
                             ['themeOptDark', "selectTheme('dark', event)"],
                             ['themeOptSystem', "selectTheme('system', event)"]]) {
  check(new RegExp('id="' + id + '"[^>]*onclick="' + handler.replace(/[()]/g, '\\$&') + '"').test(actions),
    '顶栏右侧缺少 #' + id + ' 或没接上 ' + handler);
}
check(/class="meta" id="meta"/.test(actions), '顶栏右侧缺少状态信息 #meta');
check(!/querySelector\('header \.header-right'\)/.test(script), '脚本不应再靠搬运旧顶栏来摆放这些控件');

// 侧栏脚部：日志窗口、关闭网关、状态灯。
check(/id="btnConsoleToggle"[^>]*onclick="toggleConsoleWindow\(\)"/.test(html), '侧栏缺少日志窗口按钮');
check(/id="btnGatewayShutdown"[^>]*onclick="shutdownGateway\(\)"/.test(html), '侧栏缺少关闭网关按钮');
check(/id="nextStatusDot"/.test(html) && /id="nextStatusText"/.test(html), '侧栏缺少状态灯');

/* ---- 3. 行为：搬了家的两段逻辑 ---------------------------------------- */

const page = loadDashboard({
  fetch: () => Promise.reject(new Error('connection refused')),
});
const byId = id => page.document.getElementById(id);
const statusDot = byId('nextStatusDot');
const statusText = byId('nextStatusText');

// 3a. 网关状态灯：旧顶栏的 #statusDot 没了，刷新失败那条路径不能再裸取它。
statusText.textContent = '网关运行中';
page.setGatewayStatus(true);
check(statusDot.classList.contains('err') && statusText.textContent === '无法连接反代',
  '连不上反代时状态灯转红、文字改成「无法连接反代」');
page.setGatewayStatus(false);
check(!statusDot.classList.contains('err') && statusText.textContent === '网关运行中',
  '恢复后状态灯转绿、文字改回「网关运行中」');

// 真实路径：一轮刷新三个请求里有任何一个失败，就走上面那条。
return page.refresh(true).then(() => {
  check(statusDot.classList.contains('err'), '刷新失败后状态灯转红');
  check(String(byId('meta').innerHTML).includes('无法连接反代'), '刷新失败后顶栏状态提示「无法连接反代」');

  // 3b. 页内锚点跳转要让开的是吸顶的壳顶栏（68px；窄屏 60px 时不再留缝），不是旧顶栏。
  byId('nextTopbar').offsetHeight = 68;
  check(page.pageNavHeaderOffset(null) === 82, '宽屏下锚点让开的高度 = 顶栏 68 + 14');
  page.matchMedia = () => ({matches: true});
  check(page.syncPageNavOffset() === undefined
    && page.document.documentElement.style.getPropertyValue('--page-nav-top') === '68px',
    '窄屏下锚点让开的高度 = 顶栏 68（不留缝）');

  console.log('single shell assertions passed (' + checks + ' checks)');
}).catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
