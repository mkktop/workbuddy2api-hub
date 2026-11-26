/* 面板壳与筛选的契约：导航结构、筛选语义与既有行为的边界。
 *
 * 面板只剩一套壳（侧栏 + 顶栏 + 手机底栏）：旧的「顶部页签」「控制台布局」
 * 两套连同样式表一起删除了，所以这里钉住三件事：
 *
 *   1. 骨架：侧栏入口的顺序与页面清单一致，书签与首屏选页用的是同一份清单；
 *      每个入口都走 nextGo()（切页 + 同步壳的高亮）。旧壳的节点不许回来。
 *   2. 筛选：账号、模型、最近请求三处筛选只改显示，不改批量操作的原始范围；
 *      模型被筛掉时勾选状态不能丢——全选/反选必须仍按整份目录算。
 *   3. 概览：健康度与 Token 分布只用已经加载过的数据，不发新请求，也不把
 *      当前页的分布说成历史趋势。
 *
 * Run with Node: node tests/_test_console_shell.js
 */
'use strict';
const assert = require('assert');
const {dashboardHtml, dashboardScript} = require('./_dashboard_source.js');
const dom = require('./_dom_stub.js');

const html = dashboardHtml();
const script = dashboardScript();

let checks = 0;
function check(ok, label, extra) {
  assert.ok(ok, label + (extra === undefined ? '' : '  -> ' + extra));
  checks += 1;
}

/* ---- 1. 结构：一套壳，侧栏入口与页面清单同序 ------------------------------ */

// 旧壳（控制台侧栏、上下文条、遮罩、顶部页签按钮）连同样式表一起删除。
// 它们靠 html 上的 data-console-layout 属性开关，残留一条就可能把内容区藏起来。
check(!/(console-shell|console-sidebar|console-contextbar|console-scrim|main-nav-btn)/.test(html),
  '旧壳的节点与按钮不应残留');
check(!/data-console-layout|wb-console-layout|wb-alibaba-console|wb-console-v2/.test(html),
  '旧布局的开关、样式表 id 不应残留');

// 侧栏入口：每个页面一个，走 nextGo()（切页 + 同步壳的高亮）；
// 顺序在下面与页面清单比对。
const navAt = html.indexOf('<nav class="next-nav"');
const navBlock = html.slice(navAt, html.indexOf('</nav>', navAt));
const navEntries = [...navBlock.matchAll(/<button type="button" class="next-nav-item" data-next-tab="([^"]+)" onclick="nextGo\('\1'\)">/g)]
  .map(m => m[1]);
check(/if\(typeof switchMainTab === 'function'\) switchMainTab\(tab\);\s*nextSyncChrome\(nextCurrentTab\(\) \|\| tab\);/.test(script),
  'nextGo 应切页并同步壳的高亮');

// 模型目录与请求记录各是独立页面，各有稳定锚点。
check(html.includes('id="gatewayModelsSection"') && html.includes('id="recentRequestsSection"'),
  '模型目录与请求记录需要稳定锚点');
check(!/applyConsoleView|console-view-hidden|setConsoleNavActive|syncConsoleContext/.test(script + html),
  '页内视图切换随控制台导航一并删除');

// 书签、首屏选页与侧栏入口共用同一份页面顺序。
const headTabs = html.match(/var TABS = \[([^\]]*)\];/);
const mainTabs = html.match(/const MAIN_TABS = \[([^\]]*)\];/);
const names = s => s.split(',').map(x => x.trim().replace(/['"]/g, '')).filter(Boolean);
check(headTabs && mainTabs && JSON.stringify(names(headTabs[1])) === JSON.stringify(names(mainTabs[1])),
  'head 的 TABS 与主脚本的 MAIN_TABS 必须一致');
check(JSON.stringify(navEntries) === JSON.stringify(names(mainTabs[1])),
  '侧栏入口应与页面清单同序、各一个，实得 ' + navEntries.join(','));
check(names(mainTabs[1]).length === 11 && names(mainTabs[1]).includes('runtime') &&
      names(mainTabs[1]).includes('media') && names(mainTabs[1]).includes('api') &&
      !names(mainTabs[1]).includes('models'),
  '主页面清单包含运行详情、媒体页、API 接入且不含内容入口');
check(JSON.stringify(names(mainTabs[1])) === JSON.stringify([
  'overview', 'runtime', 'gateway', 'accounts', 'api', 'analytics', 'tasks', 'agents', 'media', 'settings', 'logs'
]), '主页面清单顺序应与工作台菜单一致');

// 手机端的抽屉与「更多」面板：开关函数与入口都在。
check(/function nextOpenMore\(open\)/.test(script) && /function nextOpenSidebar\(open\)/.test(script),
  '缺少手机端抽屉 / 「更多」面板的开关');
check(/id="nextMenuBtn"[^>]*onclick="nextOpenSidebar\(\)"/.test(html), '手机端缺少导航按钮');
check(/id="nextMoreBtn"/.test(html), '手机端缺少「更多」按钮');

// ---- 2. 筛选：只改显示，不改批量操作的原始范围 -----------------------

check(/const ACCOUNT_FILTERS = \{query: '', status: '', group: '', errorCode: ''\}/.test(script),
  '账号筛选状态应当是独立的一份');
check(/function accountMatchesFilters\(a\)/.test(script), '缺少账号筛选判定');
check(/function clearAccountFilters\(\)/.test(script), '缺少账号筛选清除');
check(/function accountErrorCode\(a\)/.test(script), '缺少账号错误码提取');
check(/function filteredAccountsForBulk\(\)/.test(script), '缺少筛选结果批量操作范围');
check(/function setAccountErrorFilter\(code\)/.test(script),
  '选择错误码后应自动勾选命中账号');
check(/function deleteAccounts\(btn\)/.test(script), '缺少批量删除入口');
// 启用 / 停用 / 删除 / 导出 共用一套作用域（有勾选按勾选，没勾选按筛选结果），
// 不再有「xx 已选」这种独立按钮。
for(const [id, fn, label] of [
  ['btnBulkEnable', 'setAll', '启用'],
  ['btnBulkDisable', 'setAll', '停用'],
  ['btnBulkDelete', 'deleteAccounts', '删除'],
  ['btnExport', 'exportAccounts', '导出'],
]){
  check(new RegExp('id="' + id + '"[^>]*onclick="' + fn + '\\(').test(html),
    '账号工具栏缺少「' + label + '」按钮或接线错误');
}
for(const gone of ['btnExportSelected', 'btnEnableSelected',
                   'btnDisableSelected', 'btnDeleteSelected',
                   'btnSelectFiltered']){
  check(!html.includes('id="' + gone + '"'),
    '旧的「已选」独立按钮应已移除：' + gone);
}
check(/function acctScopeUids\(\)[\s\S]{0,400}filteredAccountsForBulk/.test(script),
  '批量作用域必须回落到当前筛选结果');
check(/postJSON\('\/accounts\/set-all', \{enabled: enable, uids: scope\.uids\}\)/.test(script),
  '启用/停用必须提交显式 uids，不能退化成全量启停');
check(html.includes('11140 · 账号封禁') && !html.includes('11140 · 风控限制'),
  '11140 必须显示为账号封禁，而不是风控限流');

// 账号筛选作用在渲染的那一份列表上，而 accountsInView()（账号池、禁用汇总、
// 批量操作的输入）不能被筛选改掉。
const renderAccounts = script.slice(script.indexOf('function renderAccounts()'),
                                  script.indexOf('async function loadAccounts()'));
check(/let list = accountsInView\(\)/.test(renderAccounts),
  'renderAccounts 仍要从 accountsInView() 取全量');
check(/list = list\.filter\(accountMatchesFilters\)/.test(renderAccounts),
  '账号筛选应当在渲染前作用于这份列表');
check(!/function accountsInView\(\)[\s\S]{0,400}?ACCOUNT_FILTERS/.test(script),
  'accountsInView 不该被展示筛选污染：批量操作仍按原账号范围执行');

// 空结果与「没有账号」要分得开。
check(/没有符合当前条件的账号/.test(script), '筛选无结果时应有专门提示');
check(/当前.*还没有账号/.test(script), '真正的空账号池应保留原有引导');
check(script.includes('const bodyCode = text.match(/"code"\\s*:\\s*"?(\\d+)"?/i)'),
  '错误码筛选必须优先读上游正文里的 "code" 字段');
check(/ACCOUNT_FILTERS\.errorCode && accountErrorCode\(a\)/.test(script),
  '错误码筛选必须参与账号匹配');
// 批量删除与启停 / 导出共用作用域：有勾选按勾选，没有勾选按当前筛选结果。
check(/ACCOUNT_SELECTED\.clear\(\)/.test(script) &&
      /function deleteAccounts\(btn\)/.test(script) &&
      /const scope = acctScopeUids\(\);/.test(script),
  '批量删除必须走 acctScopeUids() 的作用域（勾选优先，回落筛选结果）');

// 模型筛选：只改渲染，批量勾选按整份目录。
check(/let MODEL_CATALOG_FILTER = ''/.test(script), '缺少模型筛选状态');
const allPick = script.slice(script.indexOf('function allModelPickIds()'),
                            script.indexOf('function updateAvailModelCount()'));
check(/MODELS_DATA/.test(allPick) && !/querySelectorAll\('#modelsTable input\.model-pick'\)/.test(allPick),
  '全选/反选必须按整份目录取 id，不能按当前可见行取（筛选会把行藏掉）');

// 请求列表筛选：关键词 + 结果 / 账号 / 模型 / Key 四个服务端过滤。
check(/const RECENT_FILTERS = \{query: '', outcome: '', account: '', model: '', key: ''\}/.test(script),
  '缺少请求列表筛选状态');
check(/function renderRecentView\(\)/.test(script), '缺少请求列表筛选渲染');
check(/function clearRecentFilters\(\)/.test(script), '缺少请求列表筛选清除');

// 筛选条在三个区块里各有一个。
 ['accountSearchFilter', 'accountStatusFilter', 'accountErrorFilter',
 'acctSelAll',
 'recentSearchFilter', 'recentOutcomeFilter', 'recentAccountFilter',
 'recentModelSelect', 'recentKeySelect',
 'modelCatalogFilter'].forEach(id => {
  check(html.includes('id="' + id + '"'), '缺少筛选控件 #' + id);
});
// 筛选栏必须保持可见：控件不可见但 ACCOUNT_FILTERS 等状态仍会把列表筛空
// （issue #850 的根因是旧布局那条按 data-console-layout 藏筛选条的规则）。
// 旧布局删除后，不许再有任何规则把筛选栏藏起来。
check(!/\.console-filterbar[^{]*\{display:none/.test(html),
  '筛选栏不得被任何规则隐藏');
check(/:is\(\.acct-filterbar,\s*\.recent-filterbar\)\{display:flex/.test(html),
  '筛选栏要有不依赖其它样式表的布局');

// 批量作用范围不再跟号池隔离开关走：勾选本身就是明确的选择，没有勾选时按
// 当前筛选结果，两者都与「隔离是否开启」无关。
check(/function acctScopeUids\(\)/.test(script),
  '缺少统一的批量作用范围函数');
check(/function acctSelUids\(\)\{\s*return selectedAccountsForBulk\(\)/.test(script),
  '勾选集合应读 ACCOUNT_SELECTED，不能读 DOM 的 :checked');
check(/acctScopeUids\(\)[\s\S]{0,200}filteredAccountsForBulk\(\)/.test(script),
  '没有勾选时作用范围应是当前筛选结果');
check(!/if\(!POOL_SEPARATION_EFFECTIVE\) return \[\];/.test(script),
  'acctSelUids 不应再受号池隔离开关限制');

// 关闭隔离时隐藏号池工具并清除号池筛选，避免隐藏的筛选条件继续生效。
check(/id="poolToolsGroup"[^>]*\bhidden\b/.test(html),
  '号池工具组应默认隐藏');
check(/group\.hidden = !enabled/.test(script) && /!enabled && POOL_FILTER !== 'all'\) poolFilter\('all'\)/.test(script),
  '号池工具组应跟随隔离状态，关闭时恢复全部号池');
check(!/POOL_SEPARATION_EFFECTIVE/.test(script),
  '号池筛选与批量作用范围不应再依赖隔离开关');
check(/<select id="poolFilterSelect"[^>]*onchange="poolFilter\(this\.value\)"/.test(html),
  '号池筛选应是下拉框，选择后立即生效');
check(/<option value="all">全部号池<\/option>\s*<option value="text">文本号池<\/option>\s*<option value="media">媒体号池<\/option>/.test(html),
  '号池下拉应提供全部 / 文本 / 媒体三项，且默认第一项是全部号池');
check(!/id="pfAll"/.test(html) && !/id="pfText"/.test(html) && !/id="pfMedia"/.test(html),
  '旧的三个号池按钮应已移除');
check(/>移入媒体池</.test(html) && />移入文本池</.test(html),
  '批量按钮应叫「移入媒体池」「移入文本池」');
check(!/勾选移入媒体池/.test(html) && !/勾选移回文本池/.test(html),
  '旧按钮文案应已移除');
check(!/id="batchPoolCount"/.test(html), '「未勾选」计数标签应已移除');

// 勾选列：上游 v2.1.0 用 ACCOUNT_SELECTED 作真源，行内复选框 + 「全选筛选结果」。
check(/class="acct-sel" data-uid="' \+ uidAttr/.test(script),
  '账号行缺少勾选列复选框');
check(/const ACCOUNT_SELECTED = new Set\(\)/.test(script),
  '勾选状态应有独立集合，整表重画后不丢');
check(/function toggleAccountSelection\(box\)/.test(script)
      && /function clearAccountSelection\(\)/.test(script),
  '缺少勾选 / 清空勾选的状态回写函数');
// 全选只在表头有一个复选框，不再有独立的「全选筛选结果」按钮。
check(/id="acctSelAll"[^>]*onchange="toggleAcctSelAll\(this\)"/.test(html),
  '表头缺少全选勾选框');
check(!/id="btnSelectFiltered"/.test(html),
  '「全选筛选结果」独立按钮应已移除（全选只在表头复选框）');

// ---- 3. 概览：用已有数据，不发新请求，也不冒充时间序列 ---------------

check(/function renderConsoleInsights\(rows, accts\)/.test(script), '缺少概览附加图渲染');
check(/function renderConsoleAccountHealth\(accts\)/.test(script), '缺少账号健康度渲染');
check(/function renderConsoleUsageChart\(rows\)/.test(script), '缺少 Token 分布图渲染');

// 健康卡展示两个 WorkBuddy 出口，同时沿用账号列表的健康判断。
const health = script.slice(script.indexOf('function renderConsoleAccountHealth('),
                            script.indexOf('function renderConsoleUsageChart('));
check(/realmAccounts\.filter\(accountIsHealthy\)/.test(health), '健康度应复用 accountIsHealthy()');
check(/console-health-unconfigured[^\n]*未接入/.test(health), '未接入账号的出口要与账号不可用区分');

// 基础样式表：从 :root 起到它自己的 </style> 为止（控制台样式表已删除）。
const sharedStyles = html.slice(html.indexOf('<style>\n:root'), html.indexOf('</style>', html.indexOf('<style>\n:root')));
check(/\.console-insights\{display:grid/.test(sharedStyles) && /\.console-insight\{[^}]*background:var\(--panel\)/.test(sharedStyles),
  '运行详情卡片的布局与边框必须在常规导航下生效');
check(/#consoleUsageChart\[hidden\]\{display:none\}/.test(sharedStyles), '无用量时隐藏坐标图');

// 全页只允许存在一处区域过滤表达式（账号卡片与禁用汇总共用）。
const realmFilters = script.match(/\.filter\(a => !a\.realm \|\| a\.realm ===/g) || [];
check(realmFilters.length === 1,
  '区域过滤表达式应当只有一处，实得 ' + realmFilters.length + ' 处');

// 概览图不新增请求，也不把当前页说成趋势。
check(/当前页.*非时间序列|非时间序列/.test(script), '概览图应标明它不是时间序列');
const insight = script.slice(script.indexOf('function renderConsoleInsights('),
                            script.indexOf('/* ------------------------------- dashboard'));
check(!/getJSON\(|api\(|fetch\(/.test(insight),
  '概览图只能读已加载的数据，不该自己发请求');

console.log('console shell assertions passed (' + checks + ' checks)');
