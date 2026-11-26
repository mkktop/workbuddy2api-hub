/* 面板主题里的文字必须读得清：写死的色值两两对比度不许低于 4.5:1。
 *
 * 回归背景（这个套件的前身）：色彩调色台只在对比度不足时给个警告，照样应用并
 * 保存；于是有人把警告色调到 1.38:1 也被收下了，下次打开页面再没有任何提示
 * （调色台默认是收起的）。调色台随旧界面一起删除，颜色只剩样式表里写死的取值，
 * 所以这条约束改成直接钉取值。它不是理论检查：调色台删除后用量页一度回落到基础
 * 样式表里那套暖色配色，绿 / 琥珀 / 红在白底上都不足 4.5:1。
 *
 *   1. 壳的两套主题（浅 / 深）：正文与次要文字落在页面底、卡片底、内嵌块底上，
 *      主按钮的字落在按钮底色上；
 *   2. 用量页的信号色：这一页把它们当文字用，浅色下比壳里的同名信号色压深一档。
 *
 * Run with Node: node tests/_test_dashboard_theme_contrast.js
 */
'use strict';
const assert = require('assert');
const {dashboardHtml} = require('./_dashboard_source.js');

const html = dashboardHtml();
const TEXT = 4.5;                 // WCAG 2.1 AA for normal-size text
let checks = 0;

/* ---- 颜色：WCAG 相对亮度与对比度 --------------------------------------- */
function parse(color) {
  let m;
  if ((m = /^#([0-9a-f]{3})$/i.exec(color))) return m[1].split('').map(h => parseInt(h + h, 16));
  if ((m = /^#([0-9a-f]{6})$/i.exec(color))) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
  if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color))) {
    return [m[1], m[2], m[3]].map(Number).concat(m[4] === undefined ? 1 : Number(m[4]));
  }
  return null;
}
// 半透明的前景叠在不透明底色上之后再比。
function blend(top, under) {
  if (top[3] === undefined || top[3] >= 1) return top.slice(0, 3);
  return top.slice(0, 3).map((c, i) => c * top[3] + under[i] * (1 - top[3]));
}
const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const luminance = rgb => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
function contrast(fg, bg) {
  const back = parse(bg);
  assert.ok(back, '背景色不是能解析的颜色: ' + bg);
  const front = parse(fg);
  assert.ok(front, '前景色不是能解析的颜色: ' + fg);
  const a = luminance(blend(front, back)), b = luminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* ---- 样式表：取出一条规则里的自定义属性 --------------------------------- */
// 对照值：纯黑落在纯白上是 21:1。算错了这里会先红。
assert.ok(Math.abs(contrast('#000000', '#ffffff') - 21) < 0.01, '对比度公式不对');
assert.ok(Math.abs(contrast('rgba(0,0,0,.5)', '#ffffff') - contrast('rgb(127.5,127.5,127.5)', '#ffffff')) < 1e-9,
  '半透明前景要先叠到底色上再比');

function sheet(id) {
  const m = new RegExp('<style id="' + id + '">([\\s\\S]*?)</style>').exec(html);
  assert.ok(m, 'dashboard.html 缺少样式表 #' + id);
  return m[1].replace(/\/\*[\s\S]*?\*\//g, '');
}
// 顶层规则（@media 等分组规则整体跳过，这里只看无条件的取值）。
function* topRules(css) {
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) return;
    let depth = 1, j = open + 1;
    while (j < css.length && depth) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    const prelude = css.slice(i, open).trim();
    if (prelude && !prelude.startsWith('@')) yield {prelude, body: css.slice(open + 1, j - 1)};
    i = j;
  }
}
function tokens(css, prelude) {
  for (const rule of topRules(css)) {
    if (rule.prelude !== prelude) continue;
    const out = {};
    for (const m of rule.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
  }
  throw new Error('样式表里找不到规则: ' + prelude);
}
// 取值可以是 var(--x)，按给出的作用域顺序往下找。
function value(name, ...scopes) {
  for (const scope of scopes) {
    if (!scope || !(name in scope)) continue;
    const ref = /^var\((--[\w-]+)\)$/.exec(scope[name]);
    return ref ? value(ref[1], ...scopes) : scope[name];
  }
  throw new Error('没有 ' + name + ' 的取值');
}
function readable(label, fg, bg) {
  const ratio = contrast(fg, bg);
  assert.ok(ratio >= TEXT, `${label}：${fg} 落在 ${bg} 上只有 ${ratio.toFixed(2)}:1，不足 ${TEXT}:1`);
  checks += 1;
  return ratio;
}

/* ---- 1. 壳的两套主题 ---------------------------------------------------- */
// 壳没有重定义的变量沿用基础样式表 :root 上的取值（例如浅色的 --on-accent）。
const baseSheet = /<style>\s*:root\{[\s\S]*?<\/style>/.exec(html);
assert.ok(baseSheet, '找不到基础样式表（以 :root{ 开头的那一份）');
const base = baseSheet[0].replace(/^<style>\s*/, '').replace(/\/\*[\s\S]*?\*\//g, '');
const rootLight = tokens(base, ':root');
const rootDark = Object.assign({}, rootLight, tokens(base, '[data-theme="dark"]'));

const next = sheet('nextStyles');
const light = tokens(next, 'html[data-ui="next"]');
const dark = Object.assign({}, light, tokens(next, 'html[data-ui="next"][data-theme="dark"]'));
for (const [mode, scope, root] of [['浅色', light, rootLight], ['深色', dark, rootDark]]) {
  const pick = name => value(name, scope, root);
  for (const surface of ['--bg', '--panel', '--panel2']) {
    for (const ink of ['--fg', '--dim']) {
      readable(`${mode} ${ink} / ${surface}`, pick(ink), pick(surface));
    }
  }
  readable(`${mode} 主按钮的字 / 按钮底色`, pick('--on-accent'), pick('--accent'));
}

/* ---- 2. 工作台（总览以外的页签）：纸墨面上文字与信号色 ------------------ */
// 2026-11 工作台重做：用量页原来在自己的选择器上另立一套配色（浅色 #4f46e5 靛蓝、
// 深色更亮），与其余页面的纸墨色面分裂；那套已经在重做时删除，颜色统一来自
// #workbenchStyles 的 body 令牌。这里直接钉浅 / 深两套令牌：正文与次要文字落在
// 页面底 / 卡片底 / 内嵌块底上，信号色（绿 / 琥珀 / 红 / 蓝 / 紫）也常当文字用。
const wb = sheet('workbenchStyles');
const wbDark = tokens(wb, 'html[data-ui="next"]:not([data-main-tab="overview"]) body');
const wbLight = Object.assign({}, wbDark,
  tokens(wb, 'html[data-ui="next"]:not([data-main-tab="overview"])[data-theme="light"] body'));
for (const [mode, scope] of [['浅色', wbLight], ['深色', wbDark]]) {
  const pick = name => value(name, scope);
  for (const surface of ['--bg', '--panel', '--panel2']) {
    for (const ink of ['--fg', '--dim']) {
      readable(`${mode} 工作台 ${ink} / ${surface}`, pick(ink), pick(surface));
    }
  }
  for (const signal of ['--ok', '--warn', '--bad', '--info', '--think']) {
    for (const surface of ['--bg', '--panel']) {
      readable(`${mode} 工作台信号色 ${signal} / ${surface}`, pick(signal), pick(surface));
    }
  }
  readable(`${mode} 工作台主按钮的字 / 按钮底色`, pick('--on-accent'), pick('--accent'));
}

console.log('dashboard theme contrast assertions passed (' + checks + ' pairs)');
