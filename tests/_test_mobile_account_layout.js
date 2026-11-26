/* 账号页在窄屏（≤640px）下的结构契约。
 *
 * 1) 工具栏：批量操作组两列网格、号池组三列网格，按钮文字不被压成竖排；
 * 1b) 号池下拉的自定义包装层拉满格宽，触发器与按钮同高；
 * 2) 账号卡：每个单元格按自己的类名排进六列网格，不再按 nth-child 序号排——
 *    2026-11 的工作台重排把账号表从 12 列改成 11 列（「版本」列并进账号格，
 *    行尾操作收进「⋯」菜单），按序号排的规则一改列数就错位，所以改成按类名；
 * 3) 窄屏不再给同一份信息渲染两个副本（旧的 .acct-pool-mobile / .acct-task-mobile /
 *    .acct-exp-meta / .acct-state-mobile 各一份，靠断点二选一显示）。现在每一份信息
 *    只渲染一次：只有状态徽章在窄屏另有副本（状态列在窄屏隐藏），昵称、档位、
 *    标签在两种宽度下用的是同一份 DOM；
 * 4) 桌面（≥641px）：11 列的紧凑单行，两端吸附，操作列不折行。
 *
 * 这里的样式断言查的是 #workbenchStyles（工作台样式块，只作用于总览以外的页签）。
 * 基础样式里只留了卡片模式的通用规则（tr 变网格、td 带 ::before 列标签）。
 *
 * Run with Node: node tests/_test_mobile_account_layout.js
 */
'use strict';
const assert = require('assert');
const {dashboardHtml, dashboardScript} = require('./_dashboard_source.js');
const html = dashboardHtml();
const script = dashboardScript();

/* ---- 1. 批量操作组：两列网格，文字不竖排 ---------------------------- */

assert.ok(/class="tb-group tb-bulk"/.test(html),
  '批量操作那一组缺少 .tb-bulk 标记，窄屏网格规则会落到所有 tb-group 上');
// 选择器必须带 .tb-advanced：那条 .tb-group{display:flex} 更具体，少了前缀
// 会把网格压回 flex，每行只剩一个按钮。
assert.ok(/#accountsBody \.toolbar \.tb-advanced \.tb-bulk\{display:grid;\s*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/
    .test(html),
  '窄屏下 .tb-bulk 应改成两列网格（6 个按钮排成 3 行 2 列）');
assert.ok(/#accountsBody \.toolbar \.tb-advanced \.tb-bulk button\.sec\{[^}]*white-space:nowrap/.test(html),
  '网格里的按钮必须 white-space:nowrap，否则名称又被压成竖排');

// 6 个按钮都在这一组里：分配代理 / 切换所有出站身份 / 启用 / 停用 /
// 当前分组启用 / 当前分组停用。
const bulkAt = html.indexOf('class="tb-group tb-bulk"');
assert.ok(bulkAt > 0, '找不到 .tb-bulk 组');
const bulkBlock = html.slice(bulkAt, html.indexOf('</div>', bulkAt));
for (const label of ['分配代理', '切换所有出站身份', '启用', '停用',
                     '当前分组启用', '当前分组停用']) {
  assert.ok(bulkBlock.includes(label), '批量操作组里缺少「' + label + '」');
}

/* ---- 1b. 号池组：三个控件同一行 ------------------------------------ */

// 号池筛选 + 两个「移入」按钮原来排两行（下拉独占一行），账号列表被多推
// 下一行。三个都是窄控件，窄屏改成三列网格放一行；自定义下拉的真正上屏元素
// 是 .cs-trigger（原生 select 被视觉隐藏），它的默认高度比按钮矮 9px，必须
// 显式对齐 36px，否则同一行里三个控件的基线是错开的。
assert.ok(/class="tb-group tb-pool"/.test(html), '号池组缺少 .tb-pool 标记');
assert.ok(/#accountsBody \.toolbar \.tb-pool\{display:grid;\s*grid-template-columns:minmax\(0,1\.1fr\) minmax\(0,1fr\) minmax\(0,1fr\)/
    .test(html),
  '窄屏下号池组应是三列网格（下拉 + 两个按钮同一行）');
assert.ok(/#accountsBody \.toolbar \.tb-pool \.cs-wrap\{display:block;width:100%;min-width:0\}/.test(html),
  '号池下拉的自定义包装层要拉满格宽，否则仍按内容宽排在行首');
assert.ok(/#accountsBody \.toolbar \.tb-pool \.cs-trigger\{height:36px/.test(html),
  '号池下拉触发器要钉 36px，与两个「移入」按钮同高');
assert.ok(/#accountsBody \.toolbar \.tb-pool button\.sec\{[^}]*white-space:nowrap/.test(html),
  '号池按钮必须 white-space:nowrap，窄屏下不能被压成竖排文字');

/* ---- 工作台样式块 ------------------------------------------------------ */

const wbAt = html.indexOf('<style id="workbenchStyles">');
assert.ok(wbAt >= 0, '找不到 #workbenchStyles（工作台样式块）');
const wbCss = html.slice(wbAt + '<style id="workbenchStyles">'.length,
                         html.indexOf('</style>', wbAt));
// 工作台里的规则都带同一段作用域前缀；断言只写选择器的尾巴。
const P = 'html[data-ui="next"]:not([data-main-tab="overview"]) ';
// 取「包含指定片段」的那个 @media 块（同一个断点在文件里有好几块）。
function mediaBlock(query, mustContain){
  let from = 0;
  for(;;){
    const at = wbCss.indexOf(query, from);
    if(at < 0) return null;
    const open = wbCss.indexOf('{', at);
    let depth = 1, i = open + 1;
    while(i < wbCss.length && depth > 0){
      if(wbCss[i] === '{') depth++;
      else if(wbCss[i] === '}') depth--;
      i++;
    }
    const block = wbCss.slice(open + 1, i - 1);
    if(block.includes(mustContain)) return block;
    from = i;
  }
}
// 某个选择器在给定范围里的全部声明体（同一个选择器可以写好几条）。
function decls(scope, selector){
  const out = [];
  const re = new RegExp(P.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                        selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s*[{,])', 'g');
  let m;
  while((m = re.exec(scope))){
    const open = scope.indexOf('{', m.index);
    out.push(scope.slice(open + 1, scope.indexOf('}', open)));
  }
  return out;
}
function has(scope, selector, pattern, why){
  const found = decls(scope, selector);
  assert.ok(found.some(d => pattern.test(d)), why + '  -> ' + (found.join(' | ') || '（没有这条规则）'));
}
const narrow = mediaBlock('@media (max-width:640px)', 'table.account-cards td.acct-check');
assert.ok(narrow, '工作台样式里找不到账号卡的窄屏块（≤640px）');
const wide = mediaBlock('@media (min-width:641px)', 'table.account-cards{table-layout:fixed');
assert.ok(wide, '工作台样式里找不到账号表的桌面块（≥641px）');

/* ---- 2. 窄屏账号卡：按类名排进六列网格 ------------------------------- */

// 勾选框贴左上角，昵称行占满第一行其余宽度（两者同一行）。
has(narrow, 'table.account-cards td.acct-check', /grid-column:1;grid-row:1/, '窄屏勾选格应在第 1 行最左');
has(narrow, 'table.account-cards td.acct-main', /grid-column:2\/-1;grid-row:1/, '窄屏账号格应占满第 1 行其余宽度');
has(narrow, 'table.account-cards td.acct-main::before', /content:none/, '窄屏卡片里不该再出现「账号」这个列标签');

// 状态列在窄屏隐藏，状态徽章的另一份副本（.acct-mobile-badges）顶上。
has(narrow, 'table.account-cards td.acct-state', /display:none/, '窄屏应隐藏状态列');
has(narrow, '.acct-mobile-badges', /display:inline-flex/, '窄屏要显示昵称旁的状态徽章副本');
// 桌面反之：副本隐藏，状态有自己的列。
// （工作台样式块里还有别的 @media 块排在账号表之前，按「第一个 @media 之前」切片的
//  写法会切错位置——直接找那条声明本身。）
has(wbCss, '.acct-mobile-badges', /^display:none$/, '桌面必须隐藏状态徽章副本，否则状态显示两遍');
assert.ok(script.includes('\'<span class="acct-mobile-badges">\' + state + \'</span>\''),
  '账号行里缺少窄屏状态徽章的挂载点');
assert.ok(script.includes('\'<td class="acct-state" data-label="状态">\' + state'),
  '账号行里缺少状态列');

// 昵称：手机上没有悬停，看不全的昵称没处读——允许折行、完整显示。
has(narrow, '.acct-name', /white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere/,
  '手机上昵称要能折行完整显示，不能省略号裁掉');
// 标签（媒体号池 / 任务 / 备注 / 分组 / 禁用模型）同理。
has(narrow, '.note-chip', /max-width:100%;white-space:normal/, '手机上标签不得超出卡片，长备注要能折行');

// 数据格：活动 / 出口 / 权重 / 积分各占半行，三个用量数字并排一行，操作独占整行。
for (const col of ['acct-activity', 'acct-slot', 'acct-weight', 'acct-credit']) {
  has(narrow, 'table.account-cards td.' + col, /grid-column:span 3/, '窄屏「' + col + '」格应占半行');
}
has(narrow, 'table.account-cards td.num', /grid-column:span 2/, '窄屏请求 / Token / 缓存应并排三列');
has(narrow, 'table.account-cards td.acct-actions', /grid-column:span 6/, '窄屏操作格应独占整行');
has(narrow, '.acct-actions-col', /flex-wrap:wrap/, '窄屏操作按钮要允许折行');
has(narrow, 'table.account-cards .acct-actions button.mini', /min-height:32px/, '窄屏操作按钮要有 32px 的触控高度');
// 下拉在卡片里拉满格宽，不按内容宽排在行首。
has(narrow, 'table.account-cards td.acct-slot .cs-wrap', /display:block;flex:1 1 0;min-width:0;max-width:100%/,
  '窄屏出口下拉要拉满格宽');

// 冷却 / 达限续行跟在卡片下面，左对齐（桌面那条左内边距是给勾选列让位的）。
has(narrow, 'table.account-cards tr.cool-row td', /justify-content:flex-start;text-align:left!important/,
  '窄屏续行应左对齐');

/* ---- 3. 每份信息只渲染一次 ------------------------------------------- */

// 旧结构给号池 / 任务 / 到期 / 状态各渲染两份，靠断点二选一显示；两份文案会漂移，
// 忘了其中一份就只在某个宽度下丢信息。现在这些类名不该再出现（词典里的旧词条
// 不算，这里只查样式与脚本）。
for (const cls of ['acct-pool-mobile', 'acct-pool-inline', 'acct-task-mobile', 'acct-task-inline',
                   'acct-exp-meta', 'acct-exp-inline', 'acct-state-mobile', 'acct-chip-row',
                   'acct-actions-row']) {
  assert.ok(!wbCss.includes(cls) && !script.includes(cls), '旧的双副本结构不该回来：.' + cls);
}
const rowFrom = script.indexOf('function accountRow(a){');
const rowTo = script.indexOf('let ACCT_MENU = null');
assert.ok(rowFrom > 0 && rowTo > rowFrom, '找不到 accountRow');
const rowSrc = script.slice(rowFrom, rowTo);
assert.ok(/function poolChip\(a, uidAttr\)\{/.test(script), '号池标签应由 poolChip() 统一生成');
assert.strictEqual((rowSrc.match(/poolChip\(a, uidAttr\)/g) || []).length, 1,
  '号池标签只渲染一份（在账号格的次要信息行）');
// 任务开着的账号画一枚「任务开」标签；开关本身在「⋯」菜单里（见 _test_account_menu.js）。
assert.ok(/const chips = \[\s*poolChip\(a, uidAttr\),\s*\(!a\.apiKey && a\.tasksEnabled\s*\? '<span class="note-chip has"[^\n]*>任务开<\/span>/.test(rowSrc),
  '账号格次要信息行应依次挂号池标签与「任务开」标签');

// 顺序契约：昵称行先渲染，次要信息行在它之后。
const nameRowAt = rowSrc.indexOf('class="acct-name-row"');
const subRowAt = rowSrc.indexOf('class="acct-sub"');
assert.ok(nameRowAt > 0 && subRowAt > nameRowAt,
  '次要信息行必须排在账号名那一行之后');

/* ---- 4. 桌面布局（≥641px） -------------------------------------------- */

// 11 列的紧凑单行：表宽跟随容器，min-width 只作横向滚动的兜底。
has(wide, 'table.account-cards', /table-layout:fixed;width:100%;min-width:1080px/,
  '桌面账号表应固定布局、跟随容器宽度，min-width 只作兜底');
// 勾选列固定在最左、操作列固定在最右（横向滚动时两端始终可见）。
has(wide, 'table.account-cards :is(td,th).acct-check', /position:sticky;left:0/, '勾选列应固定在左侧');
has(wide, 'table.account-cards :is(td,th).acct-actions', /position:sticky;right:0/, '操作列应固定在右侧');
// 固定列要有底色，滚动时才不会透出下面的内容；悬停时跟随行背景，不然露出一块。
has(wide, 'table.account-cards :is(td,th).acct-check', /position:sticky;left:0;z-index:\d+;background:var\(--panel\)/,
  '勾选列吸附时要有底色');
has(wide, 'table.account-cards :is(td,th).acct-actions', /position:sticky;right:0;z-index:\d+;background:var\(--panel\)/,
  '操作列吸附时要有底色');
has(wide, 'table.account-cards tbody tr:not(.cool-row):hover :is(td.acct-check,td.acct-actions)',
  /background:var\(--row-hover\)/, '固定列悬停时应跟随行背景，不能露出色块');
// 窄屏没有吸附：吸附规则只写在 ≥641px 的块里，窄屏块里不该出现 sticky。
assert.ok(!/position:sticky/.test(narrow), '窄屏卡片布局里不该有吸附列（吸附只在 ≥641px）');
// 操作区一行放得下，不折行（按钮自己也不折行）。
has(wbCss, '.acct-actions-col', /^display:flex;align-items:center;justify-content:flex-end;gap:4px;flex-wrap:nowrap$/,
  '桌面操作区应是一行不折行的 flex');
has(wbCss, '.acct-actions-col > button', /white-space:nowrap;flex-shrink:0/,
  '行内按钮不折行、不收缩（「重新登录」不能被压成两行）');

console.log('_test_mobile_account_layout.js: all assertions passed');
