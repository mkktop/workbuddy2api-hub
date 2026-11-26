/* 侧栏导航的「当前页」必须同时体现在视觉与语义上。
 *
 * active 类只决定颜色，屏幕阅读器不读它；aria-current="page" 才是「你在哪」
 * 的语义标记（WCAG 2.4.8 Location）。两者一旦分叉，视力用户看到的高亮页和
 * 读屏用户听到的当前页就不是同一个地方，而这种分叉不会报错、也不会崩，只能
 * 靠断言抓。
 *
 * 面板只剩一套壳（侧栏导航 #nextNav）。旧壳在 switchMainTab() 与
 * setConsoleNavActive() 两处各改一次高亮，分叉就是这么来的；现在入口的高亮与
 * 语义只由 nextSyncChrome() 一处写。这里钉住三件事：
 *
 * 1. nextSyncChrome() 给每个入口设 active 时，必须在同一处设/摘 aria-current
 *    —— 两个属性同生同死，不能一条路径管颜色、另一条路径管语义。
 * 2. 静态标记里带 active 的入口不超过一个，且它同时带 aria-current="page"。
 * 3. 真跑一遍：切到哪一页，就只有那个入口同时带 active 与 aria-current。
 *
 * Run with Node: node tests/_test_nav_aria_current.js
 */
'use strict';
const assert = require('assert');
const {dashboardHtml, dashboardScript} = require('./_dashboard_source.js');
const dom = require('./_dom_stub.js');
const {loadDashboard} = require('./_dashboard_sandbox.js');

const html = dashboardHtml();
const script = dashboardScript();

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  [PASS] ' + label); }
  else { fail++; console.log('  [FAIL] ' + label + (detail === undefined ? '' : '  -> ' + detail)); }
}

/* ---- 1. 结构：active 与 aria-current 在 nextSyncChrome 里同生同死 ----------- */

const navAt = html.indexOf('<nav class="next-nav"');
check('侧栏导航 #nextNav 存在', navAt > 0);
const navBlock = navAt > 0 ? html.slice(navAt, html.indexOf('</nav>', navAt)) : '';

// 首帧：脚本跑起来之前，静态 HTML 里那个带 active 的入口也得带 aria-current。
const staticActiveTags = navBlock.match(/<button[^>]*class="[^"]*next-nav-item[^"]*\bactive\b[^"]*"[^>]*>/g) || [];
check('静态 HTML 里带 active 的导航入口不超过一个',
  staticActiveTags.length <= 1,
  '一次只应有一个初始选中项，实际 ' + staticActiveTags.length);
staticActiveTags.forEach(tag => {
  check('静态 HTML 里的 active 入口同时带 aria-current="page"',
    /aria-current="page"/.test(tag),
    '首帧只高亮不标语义：脚本首跑前读屏软件读不到当前页');
});

// 旧壳的两处高亮写点随控制台导航一并删除；入口的 active / aria-current 只剩一处写。
check('旧壳的高亮写点已删除',
  !/setConsoleNavActive|syncConsoleContext|console-sidebar|main-nav-btn/.test(script + html));
const sync = /function nextSyncChrome\(tab\)\{([\s\S]*?)\n  \}\n/.exec(script);
check('能定位到 nextSyncChrome', !!sync);

if (sync) {
  const loop = /querySelectorAll\('#nextNav \[data-next-tab\]'\), function\(item\)\{([\s\S]*?)\n    \}\);/.exec(sync[1]);
  check('能定位到侧栏入口的循环', !!loop);

  if (loop) {
    const body = loop[1];
    check('循环体里设置 active 类', /classList\.toggle\('active', on\)/.test(body));
    check('循环体里同时设置 aria-current',
      /setAttribute\('aria-current',\s*'page'\)/.test(body),
      '只设 active 不设 aria-current：读屏软件读不到当前页');
    check('循环体里同时摘除 aria-current',
      /removeAttribute\('aria-current'\)/.test(body),
      '切走时没摘：会同时存在多个 aria-current="page"');
    // 两个动作由同一个判定（on）驱动：点亮与标注说的是同一个入口。
    check('active 与 aria-current 由同一个判定驱动',
      /if\(on\) item\.setAttribute\('aria-current', 'page'\);\s*else item\.removeAttribute\('aria-current'\);/.test(body),
      'aria-current 必须跟 active 用同一个 on，否则两者会指到不同入口');
  }
}

/* ---- 2. 行为：切到哪一页，就只有那个入口带 active 与 aria-current ----------- */

const KEYS = ['overview', 'runtime', 'gateway', 'accounts', 'settings', 'logs'];
const ENTRIES = KEYS.map(key => {
  const item = dom.makeElement('button');
  item.setAttribute('data-next-tab', key);
  return item;
});

// 壳脚本只认这几条选择器；页面区块里的 h2 给个空清单（nextHideLegacyHeaders 要数它）。
const page = loadDashboard({
  querySelectorAll: {
    '#nextNav [data-next-tab]': ENTRIES,
    'h2': [],
  },
});
const lit = () => ENTRIES.filter(item => item.classList.contains('active')).map(item => item.getAttribute('data-next-tab'));
const marked = () => ENTRIES.filter(item => item.getAttribute('aria-current') === 'page').map(item => item.getAttribute('data-next-tab'));

page.nextSyncChrome('gateway');
check('切到网关：只有网关入口点亮', JSON.stringify(lit()) === JSON.stringify(['gateway']), JSON.stringify(lit()));
check('切到网关：只有网关入口带 aria-current', JSON.stringify(marked()) === JSON.stringify(['gateway']), JSON.stringify(marked()));

page.nextSyncChrome('accounts');
check('切到账号：高亮跟着走', JSON.stringify(lit()) === JSON.stringify(['accounts']), JSON.stringify(lit()));
check('切到账号：上一个入口的 aria-current 被摘掉', JSON.stringify(marked()) === JSON.stringify(['accounts']), JSON.stringify(marked()));

page.nextSyncChrome('no-such-page');
check('切到不存在的页：没有任何入口点亮或标注',
  lit().length === 0 && marked().length === 0, JSON.stringify([lit(), marked()]));

// 壳脚本的其余查询在假 DOM 里走不到，顶栏标题仍按页签更新。
page.nextSyncChrome('gateway');
check('顶栏标题跟着当前页', page.document.getElementById('nextPageTitle').textContent === '网关',
  page.document.getElementById('nextPageTitle').textContent);

console.log('');
console.log('SUMMARY: PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
