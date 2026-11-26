/* 本轮 UI 修正的结构契约：账号告警/积分、用量明细列配置与单一滚动上下文。 */
'use strict';
const assert = require('assert');
const {dashboardHtml, dashboardScript} = require('./_dashboard_source.js');
const html = dashboardHtml();
const script = dashboardScript();

// 2026-11 工作台重排：告警胶囊不再挤在账号格里，而是紧跟账号行的独立整行（cool-row），
// 多个胶囊横排、放不下就换行（文案完整性见 _test_model_limit_tip.js）。
assert.ok(/\.cool-list\{display:flex;flex-direction:row;flex-wrap:wrap/.test(html), '账号告警应横向排列、放不下时换行');
assert.ok(!/td\[data-label="账号"\] \.cool-pill\{/.test(html), '告警胶囊不该再写回账号列（那一列放不下，会被省略号切掉）');
// 行尾操作收进「⋯」菜单，行里只有一行按钮（.acct-actions-col）；旧的两行容器没了。
assert.ok(!/\.acct-actions-row\{/.test(html), '旧的两行操作容器应已删除');
// 表格宽度跟随容器（width:100%），只有窄到放不下才横向滚动；列宽在 ≥641px 的
// 样式块里逐列写死（table-layout:fixed），账号列吃掉余量。
assert.ok(/table\.account-cards\{table-layout:fixed;width:100%;min-width:1080px\}/.test(html),
  '桌面账号表应跟随容器宽度，min-width 只作横向滚动的兜底');
// 勾选列始终渲染，与操作列一起常驻吸附在左右两端（横向滚动时也看得见）。
// 吸附的底色、悬停跟随、窄屏取消吸附，由 _test_mobile_account_layout.js 逐条钉住。
assert.ok(/table\.account-cards :is\(td,th\)\.acct-check\{[^}]*position:sticky;left:0/.test(html),
  '勾选列应固定在左侧');
assert.ok(/table\.account-cards :is\(td,th\)\.acct-actions\{[^}]*position:sticky;right:0/.test(html),
  '操作列应固定在可视区域右侧');
// 勾选：最左侧独立复选框列 + 表头全选框（全选只在表头，没有独立按钮）。
// 表头与行都由 renderAccounts() 用字符串拼出，所以查 script 而不是 html。
assert.ok(/class="acct-check"/.test(script)
      && /id="acctSelAll"[^>]*onchange="toggleAcctSelAll\(this\)"/.test(script),
  '账号表头缺少全选勾选框');
assert.ok(/<td class="acct-check"[^>]*>/.test(script), '账号行缺少勾选列单元格');
assert.ok(!/id="btnSelectFiltered"/.test(html),
  '「全选筛选结果」独立按钮应已移除（全选只在表头复选框）');
assert.ok(/\.acct-name-row\{[^}]*flex-wrap:wrap/.test(html), '账号名行应允许徽章换行，不能把昵称挤成 0 宽');
// 备注 / 分组 / 号池 / 任务标签都在账号格的第二行，昵称行里没有会抢宽度的东西；
// 昵称自己可收缩、不超出格子，超出格宽的部分用省略号（全名在 title 上）。
assert.ok(/\.acct-name\{flex:0 1 auto;min-width:0;max-width:100%;[^}]*overflow:hidden;text-overflow:ellipsis/.test(html),
  '昵称应可收缩且不超出格子，长昵称用省略号');
{
  const nameRowAt = script.indexOf('class="acct-name-row"');
  const subRowAt = script.indexOf('class="acct-sub"', nameRowAt);
  assert.ok(nameRowAt > 0 && subRowAt > nameRowAt && !/note-chip/.test(script.slice(nameRowAt, subRowAt)),
    '备注 / 分组标签应在账号格第二行，不能挤在昵称行里');
}

assert.ok(html.includes('class="credit-stack"'), '积分应使用分层容器');
assert.ok(html.includes('class="credit-main"'), '积分主值应单独一行');
assert.ok(html.includes('class="credit-meta"'), '到期/明细应位于积分下一层');
assert.ok(script.indexOf('credit-main') < script.indexOf('credit-meta'), '积分主值应先于明细层渲染');
assert.ok(script.includes('7天内到期'), '保留七天到期徽章');
assert.ok(script.includes('openCreditsDetail(&quot;'), '保留积分明细入口');

assert.ok(script.includes("const DIM_LAYOUT_KEY = 'wb-analytics-dim-layout-v1'"), '列配置应使用版本化本地存储 key');
assert.ok(script.includes("localStorage.getItem(DIM_LAYOUT_KEY + ':' + dim)"), '列配置应按维度读取');
assert.ok(script.includes('function visibleDimColumns(dim)'), '应按稳定字段生成可见列');
assert.ok(script.includes('data-dim-col'), '表头/列配置应使用稳定字段 id');
assert.ok(script.includes('dimColumnsMenu'), '应存在列设置菜单');
assert.ok(script.includes('hidden.delete(\'who\')'), '账号/首列不可隐藏');
assert.ok(!/section\.panel \.pbody\{overflow-y:auto;max-height:calc/.test(html), '不应再有 pbody 纵向嵌套滚动');
assert.ok(/#pageAnalytics \.recent-list\{display:flex;flex-direction:column;max-height:260px;overflow-y:auto[^}]*\}/.test(html), '最近请求应带 max-height + 内部纵向滚动');
assert.ok(/#pageAnalytics \.maingrid\{[^}]*align-items:stretch\}/.test(html), '主区两栏底部对齐');
assert.ok(/#modelsTable\{table-layout:fixed\}/.test(html), '网关模型清单应固定布局占满宽度');
assert.ok(/#modelsTable th,#modelsTable td\{white-space:nowrap;overflow:hidden;text-overflow:ellipsis\}/.test(html), '模型清单单元格不应换行');

console.log('_test_ui_layout_refinements.js: all assertions passed');
