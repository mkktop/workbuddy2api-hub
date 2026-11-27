/* The rendered heatmap advances across local midnight with the board snapshot. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
const start = html.indexOf('const heatMobile =');
const end = html.indexOf('const dimDefs', start);
assert.ok(start > 0 && end > start);

const els = new Map();
const element = id => {
  if (!els.has(id)) els.set(id, {
    style: {setProperty() {}},
    hidden: true,
    scrollWidth: 100,
    clientWidth: 100,
    scrollLeft: 0,
    contains: () => false,
    querySelectorAll: () => [],
    querySelector(selector) {
      const attr = selector.slice(1, -1);
      const match = this.innerHTML?.match(new RegExp('data-d="([^"]+)" data-r="([^"]+)" data-t="([^"]+)"[^>]*' + attr));
      return match ? {dataset: {d: match[1], r: match[2], t: match[3]}} : null;
    },
  });
  return els.get(id);
};
const RealDate = Date;
let now = new RealDate(2026, 8, 21, 23, 58).getTime();
class FakeDate extends RealDate {
  constructor(value) { super(value === undefined ? now : value); }
}
const fmtDate = epoch => {
  const d = new RealDate(epoch * 1000);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')].join('-');
};
const media = {matches: false};
const factory = new Function('$', 'fmtDate', 'fmtCompact', 'Date', 'window', 'document',
  html.slice(start, end) + '\nreturn buildHeatGrid;');
const build = factory(element, fmtDate, String, FakeDate, {matchMedia: () => media}, {});
const series = [
  {at: new RealDate(2026, 8, 21).getTime() / 1000, requests: 4, total_tokens: 40},
  {at: new RealDate(2026, 8, 22).getTime() / 1000, requests: 7, total_tokens: 70},
];
build({series: series.slice(0, 1)});
assert.match(element('hmGrid').innerHTML, /data-d="2026-09-21" data-r="4"/);
assert.doesNotMatch(element('hmGrid').innerHTML, /data-d="2026-09-22"/);
now = new RealDate(2026, 8, 22, 0, 0, 5).getTime();
build({series});
assert.match(element('hmGrid').innerHTML, /data-d="2026-09-22" data-r="7"/);
assert.match(element('hmStats').innerHTML, /<b>11<\/b><span>总请求/);
assert.match(element('hmGrid').innerHTML, /data-d="2026-09-22"[^>]*aria-current="date"/);

// Data beyond the displayed dates must not skew the legend or peak-day summary.
build({series: series.concat({at: new RealDate(2025, 8, 1).getTime() / 1000, requests: 1000})});
assert.match(element('hmGrid').innerHTML, /class="hm-cell l1" data-d="2026-09-22"/);
assert.match(element('hmStats').innerHTML, /<b>7<\/b><span>峰值单日<\/span> <span>09-22/);

const peak = {at: new RealDate(2026, 8, 15).getTime() / 1000, requests: 1000, total_tokens: 10000};
build({series: [...series, peak]});
assert.match(element('hmGrid').innerHTML, /class="hm-cell l1" data-d="2026-09-22"/);
assert.match(element('hmGrid').innerHTML, /class="hm-cell l4" data-d="2026-09-15"/);
assert.match(element('hmStats').innerHTML, /<b>1000<\/b><span>峰值单日/);

media.matches = true;
build({series: [...series, peak]});
assert.match(element('hmGrid').style.gridTemplateColumns, /^repeat\(13,/);
assert.match(element('hmGrid').innerHTML, /data-d="2026-09-22"[^>]*tabindex="0"/);
assert.strictEqual(element('hmDate').textContent, '2026-09-22');
assert.strictEqual(element('hmRequests').textContent, '7');
assert.strictEqual(element('hmTokens').textContent, '70');
assert.match(element('hmStats').innerHTML, /<b>1011<\/b><span>总请求/);
media.matches = false;

now = new RealDate(2026, 8, 27).getTime(); // Sunday completes the last column.
build({series: [{at: now / 1000, requests: 0}]});
const dayCount = (element('hmGrid').innerHTML.match(/data-d=/g) || []).length;
const startPadding = (element('hmGrid').innerHTML.match(/<span aria-hidden/g) || []).length;
assert.strictEqual((dayCount + startPadding) % 7, 0);
assert.match(element('hmGrid').style.gridTemplateColumns, new RegExp('^repeat\\(' + (dayCount + startPadding) / 7 + ','));
assert.match(element('hmStats').innerHTML, /<b>—<\/b><span>峰值单日<\/span>/);
console.log('dashboard heat snapshot assertions passed');
