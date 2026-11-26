/* 账号卡的两个可见性回归：出站身份标签、账户名看得全。
 *
 * 1) 「出站身份：」标签曾被当成冗余删掉（WB / VSC / CLI 三个缩写单独出现时
 *    看不出这组在切什么）。2026-11 工作台重排后这一组不在行内了——行里只留
 *    「测试 / 启停 / ⋯」，出站身份挪进行尾「⋯」菜单（openAcctMenu）——但标签
 *    仍然必须显示。
 * 2) 账户名：旧版列宽 180px + 强制 nowrap + ellipsis，长昵称被同一行里的 chip
 *    挤到只剩 1px。现在昵称独占账号格的第一行（标签都在第二行），所以
 *      - 桌面：长昵称按格宽省略，完整昵称挂在 title 上（悬停可读）；
 *      - 手机：没有悬停，昵称折行完整显示（规则在 #workbenchStyles 的窄屏块里）。
 *
 * 顺带记一笔：这个文件原来的 check(label, ok) 被以 (ok, label) 调用，断言恒真，
 * 旧界面删掉后它照样报「13 checks passed」。2026-11 修正了参数顺序，下面每一条
 * 都是真的会失败的断言。
 *
 * Run with Node: node tests/_test_account_card_visibility.js
 */
'use strict';
const assert = require('assert');
const {dashboardHtml, dashboardScript} = require('./_dashboard_source.js');
const html = dashboardHtml();
const script = dashboardScript();

const wbAt = html.indexOf('<style id="workbenchStyles">');
assert.ok(wbAt >= 0, '找不到 #workbenchStyles（工作台样式块）');
const wbCss = html.slice(wbAt + '<style id="workbenchStyles">'.length,
                         html.indexOf('</style>', wbAt));
const P = 'html[data-ui="next"]:not([data-main-tab="overview"]) ';
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let checks = 0;
function check(label, ok, detail) {
  checks++;
  assert.ok(ok, label + (detail === undefined ? '' : '  -> ' + detail));
}
// 某个选择器在工作台样式里的声明体（选择器前面带作用域前缀）。
function decl(selector){
  const at = wbCss.indexOf(P + selector + '{');
  return at < 0 ? null : wbCss.slice(at + (P + selector).length + 1, wbCss.indexOf('}', at));
}
// 包含指定片段的那个 @media 块。
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

/* ---- 1. 出站身份标签 --------------------------------------------------- */

// 标签由 openAcctMenu() 拼进菜单（行内不再有这一组）。
const menuAt = script.indexOf('function openAcctMenu(uid, btn){');
check('找不到 openAcctMenu，测试需要更新', menuAt > 0);
const menuSrc = script.slice(menuAt, script.indexOf('\n}\n', menuAt));
check('「⋯」菜单的出站身份组缺少「出站身份：」标签',
  menuSrc.includes('<span class="id-btn-label">出站身份：</span>'));
// 没有任何规则把它藏掉（以前是两条 display:none）。
check('还有规则把「出站身份：」标签藏掉',
  !/\.id-btn-label[^{]*\{[^}]*display\s*:\s*none/.test(html));
check('标签的基础样式被改掉了',
  /\.id-btn-label\{color:var\(--dim\);font-size:11px;white-space:nowrap\}/.test(html));
// 菜单里那一行是 flex、标签不折行：三个缩写按钮始终跟在标签右边同一行。
check('菜单里的出站身份行应是一行 flex',
  /\.acct-menu-row\{display:flex;align-items:center;/.test(wbCss), decl('.acct-menu-row'));

/* ---- 2. 账户名完整显示 ------------------------------------------------- */

// 桌面：昵称独占第一行；昵称行允许换行，徽章挤不下时落到下一行，而不是把昵称挤没。
const nameRow = decl('.acct-name-row');
check('昵称行规则不存在', nameRow !== null);
check('昵称行要允许换行，否则长昵称 + 徽章会把昵称挤成 0 宽',
  /display:flex;[^}]*min-width:0;flex-wrap:wrap/.test(nameRow), nameRow);
// 昵称自己：可收缩（min-width:0 才缩得动），宽度不超过格子，超出部分用省略号。
const nameDecl = decl('.acct-name');
check('昵称规则不存在', nameDecl !== null);
check('昵称要能收缩（min-width:0），否则长昵称会撑出格子',
  /flex:0 1 auto;min-width:0;max-width:100%/.test(nameDecl), nameDecl);
check('桌面昵称超出格宽时用省略号，不能顶进旁边的列',
  /overflow:hidden;text-overflow:ellipsis;white-space:nowrap/.test(nameDecl), nameDecl);
// 完整昵称挂在 title 上（title 会被 i18n 翻译，data-tip 不会，所以用 title）。
check('昵称应把完整名称挂在 title 上（省略后靠它读全名）',
  script.includes('\'<span class="acct-name" title="\' + esc(a.nickname) + \'">\' + esc(a.nickname) + \'</span>\''));
// 标签（号池 / 任务 / 备注 / 分组 / 禁用模型）都在第二行，不进昵称行。
const nameRowAt = script.indexOf('class="acct-name-row"');
const subRowAt = script.indexOf('class="acct-sub"', nameRowAt);
check('找不到账号格的昵称行 / 次要信息行', nameRowAt > 0 && subRowAt > nameRowAt);
check('昵称行里不该出现标签（标签放第二行，昵称才有整行宽度）',
  !/note-chip/.test(script.slice(nameRowAt, subRowAt)),
  script.slice(nameRowAt, subRowAt).slice(0, 200));

// 手机：没有悬停，看不全的昵称没处读——必须折行完整显示，且不撑出卡片。
const narrow = mediaBlock('@media (max-width:640px)', 'table.account-cards td.acct-check');
check('找不到工作台样式里的账号卡窄屏块', narrow !== null);
const narrowNameAt = narrow.indexOf(P + '.acct-name{');
const narrowName = narrowNameAt >= 0
  ? narrow.slice(narrowNameAt + (P + '.acct-name{').length, narrow.indexOf('}', narrowNameAt)) : '';
check('手机上昵称也要能折行完整显示',
  /white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere/.test(narrowName), narrowName);
// 卡片模式的基础规则给每个格子兜底：内容再长也不撑出卡片。
check('卡片模式的基础规则应钉住 min-width:0 + overflow-wrap',
  /table\.data-cards td\{[^}]*min-width:0;overflow-wrap:anywhere/.test(html));

/* ---- 3. 桌面布局其余部分 ----------------------------------------------- */

// 行里只剩「测试 / 启停 / ⋯」三个按钮，凭证失效时中间那个换成更宽的「重新登录」
// （实测三个按钮占 141px）。列宽 164px 减去内边距 20px 是 144px，放得下。
const thActions = decl('table.account-cards th.acct-actions');
check('操作列表头宽度规则不存在', thActions !== null);
check('操作列应为 164px：放得下「测试 + 重新登录 + ⋯」，不留空白',
  /width:164px/.test(thActions), thActions);
const actionsCol = decl('.acct-actions-col');
check('桌面操作列的内容宽度规则被改掉了',
  /^display:flex;align-items:center;justify-content:flex-end;gap:4px;flex-wrap:nowrap$/.test(actionsCol), actionsCol);
check('行内按钮不折行、不收缩（「重新登录」不能被压成两行）',
  /\.acct-actions-col > button\{white-space:nowrap;flex-shrink:0\}/.test(wbCss));

process.stdout.write('account card visibility: ' + checks + ' checks passed\n');
