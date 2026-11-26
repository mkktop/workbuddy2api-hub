/* 圣轮首页（总览）：场景模型、流客户端与结构约束。
 *
 * 首页把每一次模型调用画成一颗星。画面要成立，三件事各管各的：
 *   · 场景模型——纯函数，不碰 DOM：事件怎么变成在途调用、调用序列和指标。
 *   · 流客户端——fetch 流式读取 /usage/events 并手解 SSE。
 *   · 结构——皮肤样式全部限定在 data-skin="sanctum" + 总览页签下，其余页签一条也不生效。
 *
 * 圣轮是这个壳唯一的首页：data-skin 直接写在 <html> 上，没有开关，也没有 ?skin= 参数。
 *
 * 这个套件在 Node 里把整页脚本装进沙箱跑（假 DOM 没有 canvas，舞台不会启动），
 * 然后直接驱动导出的纯函数。钉住的都是实际出过的问题：
 *   - 对数刻度在下限为 0 时算出 NaN，圣球只要有调用在途就整个消失；
 *   - 快照补进来的调用不触发列表重画，页面比模型少几条；
 *   - 按时间顺序送来的调用被一律插到最前，较旧的排到了较新的上面；
 *   - 流客户端的默认取数函数不真正发请求，状态在「连接中 / 重连」间打转。
 *
 * Run with: node tests/_test_sanctum_model.js
 */
'use strict';
const assert = require('assert');
const {dashboardHtml} = require('./_dashboard_source.js');
const {loadDashboard} = require('./_dashboard_sandbox.js');

const html = dashboardHtml();
const page = loadDashboard({
  fetch: () => Promise.resolve({status: 200, ok: true, json: () => Promise.resolve({ok: true})}),
});
const S = page.WB_SANCTUM;
assert.ok(S && typeof S.apply === 'function', '页面要导出 window.WB_SANCTUM');

const T0 = 1790000000000;              // a fixed "now", in ms
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
let passed = 0;
// 页面代码跑在沙箱里，它造出来的数组和对象带着另一个上下文的原型：严格深度
// 比较会判为不等。这里只比内容。
function same(actual, expected, message){
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}
function ok(label, fn){
  fn();
  passed++;
  console.log('  [PASS] ' + label);
}

/* ---- 1. 对数刻度：只返回 0 到 1 之间的有限值 ------------------------ */
ok('刻度函数对任何输入都只返回 0 到 1 之间的有限值', () => {
  const bad = [];
  const cases = [[3, 0, 16], [1, 0, 16], [40, 0, 120], [700, 200, 8000], [5, 1, 600], [-3, 1, 600], [0, 0, 5],
    [1e9, 1, 600], [NaN, 1, 10], [undefined, 0, 10], [5, 0, 0], [5, 10, 1], [Infinity, 1, 10]];
  for (const [x, lo, hi] of cases) {
    const v = S.taper(x, lo, hi);
    if (!Number.isFinite(v) || v < 0 || v > 1) bad.push([x, lo, hi, String(v)]);
  }
  same(bad, [], 'taper 返回了 0 到 1 之外的值: ' + JSON.stringify(bad));
  assert.ok(S.taper(3, 0, 16) > 0, '下限为 0 时中间值不能是 0');
  assert.ok(Math.abs(S.taper(1, 0.5, 16) - 0.2) < 1e-9, '一次在途在 0.5 到 16 的对数刻度上是 0.2');
  assert.strictEqual(S.taper(0.5, 0.5, 16), 0);
  assert.strictEqual(S.taper(16, 0.5, 16), 1);
  assert.strictEqual(S.taper(4, 0.5, 16) > S.taper(1, 0.5, 16), true, '单调递增');
});

/* ---- 2. 一条调用的完整生命周期 -------------------------------------- */
ok('一条调用从开始到结束，顺序和字段都对', () => {
  const m = S.createModel();
  S.apply(m, {type: 'snapshot', seq: 1, t: T0 / 1000, reset: false, live: [], recent: []}, T0);
  assert.strictEqual(S.apply(m, {type: 'start', seq: 2, id: 'a1', route: '/v1/chat/completions', kind: 'chat', key: 'k1', len: 420}, T0), 'start');
  S.apply(m, {type: 'meta', seq: 3, id: 'a1', model: 'gpt-5', stream: true}, T0 + 100);
  S.apply(m, {type: 'bind', seq: 4, id: 'a1', account: 'acc-1'}, T0 + 200);
  assert.strictEqual(m.live.size, 1, '在途表里有一条');
  const live = m.live.get('a1');
  assert.strictEqual(live.model, 'gpt-5');
  assert.strictEqual(live.stream, true);
  assert.strictEqual(live.account, 'acc-1');
  assert.strictEqual(live.boundAt, T0 + 200, '记录首次分配时刻供转轨动画使用');
  assert.strictEqual(live.key, 'k1');
  assert.ok(live.phi >= 0 && live.phi < Math.PI * 2, '出生点落在刻度盘上');

  S.apply(m, {type: 'live', seq: 5, t: (T0 + 600) / 1000, live: [{id: 'a1', chunks: 12}]}, T0 + 600);
  assert.strictEqual(m.live.get('a1').chunks, 12);
  assert.strictEqual(m.live.get('a1').flash, 1, '进度推进时闪一下');
  m.live.get('a1').flash = 0.2;                      // 闪光随时间淡出由渲染循环负责，模型只管重新点亮
  S.apply(m, {type: 'live', seq: 6, t: (T0 + 1100) / 1000, live: [{id: 'a1', chunks: 12}]}, T0 + 1100);
  assert.strictEqual(m.live.get('a1').flash, 0.2, '进度没动就不重新点亮');
  S.apply(m, {type: 'live', seq: 7, t: (T0 + 1600) / 1000, live: [{id: 'a1', chunks: 5}]}, T0 + 1600);
  assert.strictEqual(m.live.get('a1').chunks, 12, '段数只增不减（乱序的旧帧不会把进度拉回去）');
  assert.strictEqual(S.apply(m, {type: 'meta', seq: 8, id: 'ghost', model: 'x'}, T0), 'meta');
  assert.strictEqual(S.apply(m, {type: 'bind', seq: 9, id: 'ghost', account: 'y'}, T0), 'bind');
  assert.strictEqual(m.live.size, 1, '给不存在的调用补字段不会凭空造出一条');

  const row = {at: (T0 + 2000) / 1000, model: 'gpt-5', stream: true, outcome: 'completed', kind: 'chat',
    elapsed_ms: 2000, ttft_ms: 600, prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, credit: 2, account: 'acc-1', key: 'k1'};
  assert.strictEqual(S.apply(m, {type: 'finish', seq: 10, id: 'a1', row: row}, T0 + 2000), 'finish');
  assert.strictEqual(m.live.size, 0, '结束后不再在途');
  assert.strictEqual(m.ledger.length, 1);
  const e = m.ledger[0];
  assert.strictEqual(e.ok, true);
  assert.strictEqual(e.model, 'gpt-5');
  assert.strictEqual(e.account, 'acc-1');
  assert.strictEqual(e.total, 150);
  assert.strictEqual(e.rawAt, T0 + 2000, '保留用量行自己的完成时刻');
  assert.strictEqual(e.uid, 'i:a1', '实时流来的条目以调用编号为键');
  assert.strictEqual(m.seq, 10, '记下最新的事件序号');
  assert.strictEqual(S.dialAt(m, Math.floor((T0 + 2000) / 1000)).n, 1, '结束的那一秒留下一道刻痕');
  // 快照、开始、结束都会动到列表或在途表——页面据此知道该重画了
  const shape = (model) => JSON.stringify([model.ledger.map((x) => x.uid), Array.from(model.live.keys())]);
  const later = [
    {type: 'snapshot', seq: 11, t: T0 / 1000, reset: false, live: [], recent: [{id: 's1', row: {at: T0 / 1000, model: 's1', outcome: 'completed'}}]},
    {type: 'start', seq: 12, id: 'a2'},
    {type: 'finish', seq: 13, id: 'a2', row: {at: T0 / 1000, model: 'x'}},
  ];
  for (const frame of later) {
    const before = shape(m);
    S.apply(m, frame, T0);
    assert.notStrictEqual(shape(m), before, frame.type + ' 帧改变了模型');
  }
  assert.strictEqual(m.seq, 13);
  // 进度帧只更新段数，不动列表：页面不会为它重画
  S.apply(m, {type: 'start', seq: 14, id: 'a3'}, T0);
  const steady = shape(m);
  S.apply(m, {type: 'live', seq: 15, t: T0 / 1000, live: [{id: 'a3', chunks: 4}]}, T0);
  assert.strictEqual(shape(m), steady, '进度帧不改变列表和在途名单');
  assert.strictEqual(m.live.get('a3').chunks, 4);
});

/* ---- 3. 调用序列：新的在前 ------------------------------------------ */
ok('按时间顺序送来的调用，序列里仍是新的在前', () => {
  const m = S.createModel();
  S.apply(m, {type: 'snapshot', seq: 1, t: T0 / 1000, reset: false, live: [], recent: []}, T0);
  // 先到的三条：c 最新，a 最旧
  ['c', 'b', 'a'].forEach((model, i) => {
    S.apply(m, {type: 'finish', seq: 10 + i, row: {at: (T0 - 1000 - i * 100) / 1000, model, outcome: 'completed'}}, T0);
  });
  same(m.ledger.map((x) => x.model), ['c', 'b', 'a']);
  // 快照按时间顺序补来两条更旧的：一律插到最前会把它们排到 c 的上面
  S.apply(m, {type: 'finish', seq: 20, row: {at: (T0 - 5000) / 1000, model: 'old', outcome: 'completed'}}, T0);
  S.apply(m, {type: 'finish', seq: 21, row: {at: (T0 - 3000) / 1000, model: 'mid', outcome: 'completed'}}, T0);
  same(m.ledger.map((x) => x.model), ['c', 'b', 'a', 'mid', 'old'], '旧调用不能排到新调用上面');
  S.apply(m, {type: 'finish', seq: 22, row: {at: (T0 - 50) / 1000, model: 'new', outcome: 'completed'}}, T0);
  same(m.ledger.map((x) => x.model), ['new', 'c', 'b', 'a', 'mid', 'old']);
  // 同一秒里的先后按送达顺序
  S.apply(m, {type: 'finish', seq: 23, row: {at: (T0 - 1000) / 1000, model: 'c-twin', outcome: 'completed'}}, T0);
  same(m.ledger.map((x) => x.model), ['new', 'c', 'c-twin', 'b', 'a', 'mid', 'old']);
  // 再来 70 条：每条相隔半毫秒、全部落在最近 35 毫秒内，比上面任何一条都新。
  // 列表封顶 60，被挤掉的是最旧的。
  for (let i = 0; i < 70; i++) S.apply(m, {type: 'finish', seq: 30 + i, row: {at: T0 / 1000 - i / 2000, model: 'n' + i, outcome: 'completed'}}, T0);
  assert.strictEqual(m.ledger.length, 60, '序列最多留 60 条');
  same(m.ledger.map((x) => x.model), Array.from({length: 60}, (_, i) => 'n' + i), '最新的 60 条，新的在前');
});

/* ---- 4. 一次调用只出现一次 ------------------------------------------ */
ok('实时流和轮询送来同一条调用，序列里只有一条', () => {
  const m = S.createModel();
  S.apply(m, {type: 'snapshot', seq: 1, t: T0 / 1000, reset: false, live: [], recent: []}, T0);
  const row = {at: T0 / 1000, model: 'gpt-5', outcome: 'completed', total_tokens: 10, elapsed_ms: 20};
  S.apply(m, {type: 'finish', seq: 2, id: 'f1', row: row}, T0);
  assert.strictEqual(S.ingestRecent(m, [row], T0 + 100), 0, '轮询又送来同一行：不算新的');
  S.apply(m, {type: 'finish', seq: 3, id: 'f1', row: row}, T0 + 200);
  assert.strictEqual(m.ledger.length, 1, '重放的同一条帧也不重复');
  const other = Object.assign({}, row, {elapsed_ms: 21});
  assert.strictEqual(S.ingestRecent(m, [row, other], T0 + 300), 1, '内容不同的行是另一次调用');
  assert.strictEqual(m.ledger.length, 2);
  same(m.ledger.map((x) => x.uid), ['i:f1', 'r:' + S.rowKey(other)], '实时流来的条目以调用编号为键，轮询来的以行内容为键');
  // 没写用量行的调用没有开始帧，也要出现
  S.apply(m, {type: 'finish', seq: 4, id: 'solo', row: {at: (T0 + 500) / 1000, model: 'veo', kind: 'video', outcome: 'completed'}}, T0);
  same(m.ledger.map((x) => x.model), ['veo', 'gpt-5', 'gpt-5']);
  assert.strictEqual(S.apply(m, {type: 'nonsense'}, T0), 'ignore', '不认识的帧不改变任何东西');
});

ok('快照：要求重置就清空重来，不要求就并入', () => {
  const m = S.createModel();
  const shared = {at: (T0 - 400) / 1000, model: 'shared', outcome: 'completed'};
  S.apply(m, {type: 'finish', seq: 1, id: 'shared', row: shared}, T0);
  S.apply(m, {type: 'finish', seq: 2, id: 'old', row: {at: T0 / 1000, model: 'old', outcome: 'completed'}}, T0);
  S.apply(m, {type: 'snapshot', seq: 9, t: T0 / 1000, reset: true, live: [{id: 'L1', t0: (T0 - 300) / 1000, model: 'm', account: 'acc-1'}],
    recent: [{id: 'shared', row: shared}, {id: 'r1', row: {at: (T0 - 200) / 1000, model: 'r1', outcome: 'completed'}}]}, T0);
  same(m.ledger.map((x) => x.model), ['r1', 'shared'], '重置后快照里重叠的调用也要统计');
  assert.strictEqual(S.metrics(m, T0).perMin, 2);
  assert.strictEqual(m.live.size, 1);
  assert.strictEqual(m.live.get('L1').account, 'acc-1');
  assert.strictEqual(m.live.get('L1').t0, T0 - 300, '在途调用的开始时刻换算到浏览器时钟');
  assert.strictEqual(m.seq, 9);
});

/* ---- 5. 结束帧丢了的时候，星不会永远悬着 ----------------------------- */
ok('连续三帧进度里都没有的在途调用会被收掉', () => {
  const m = S.createModel();
  S.apply(m, {type: 'snapshot', seq: 1, t: T0 / 1000, reset: false, live: [], recent: []}, T0);
  S.apply(m, {type: 'start', seq: 2, id: 'lost'}, T0);
  S.apply(m, {type: 'start', seq: 3, id: 'kept'}, T0);
  for (let i = 1; i <= 3; i++) S.apply(m, {type: 'live', seq: 3 + i, t: (T0 + i * 500) / 1000, live: [{id: 'kept', chunks: i}]}, T0 + i * 500);
  assert.strictEqual(m.live.has('lost'), false, '结束帧丢了的那条被收掉');
  assert.strictEqual(m.live.has('kept'), true);
  // 进度帧里冒出的陌生调用（开始帧丢了）也要接住
  const before = m.live.size;
  S.apply(m, {type: 'live', seq: 9, t: (T0 + 2000) / 1000, live: [{id: 'kept', chunks: 9}, {id: 'stranger', chunks: 3}]}, T0 + 2000);
  assert.strictEqual(m.live.get('stranger').chunks, 3);
  assert.strictEqual(m.live.size, before + 1, '多出来的在途调用改变了模型');
});

/* ---- 6. 读数 -------------------------------------------------------- */
ok('圣轮读数区分在途、60 秒结束记录和 15 秒用量，首字时延取中位数', () => {
  const m = S.createModel();
  S.apply(m, {type: 'snapshot', seq: 1, t: T0 / 1000, reset: false, live: [], recent: []}, T0);
  let n = 0;
  const done = (msAgo, extra) => S.apply(m, {type: 'finish', seq: 2 + n++, id: 'x' + n,
    row: Object.assign({at: (T0 - msAgo) / 1000, model: 'm', outcome: 'completed', prompt_tokens: 100, completion_tokens: 50, credit: 1, ttft_ms: 400}, extra)}, T0);
  done(1000); done(2000); done(3000, {outcome: 'failed', ttft_ms: 0}); done(4000, {ttft_ms: 800});
  done(20 * 1000, {ttft_ms: 1200});      // still counts as an outcome, outside the rate window
  done(70 * 1000);                    // too old to count
  S.apply(m, {type: 'start', seq: 99, id: 'live-1'}, T0);
  const stats = S.metrics(m, T0);
  assert.strictEqual(stats.perMin, 5, '只数最近一分钟的');
  assert.strictEqual(stats.live, 1);
  assert.strictEqual(stats.okN, 4);
  assert.strictEqual(stats.okD, 5);
  assert.strictEqual(stats.tokIn, 400 / 15);
  assert.strictEqual(stats.tokOut, 200 / 15, '四次调用各输出 50 token，按十五秒窗口折算成每秒');
  assert.strictEqual(stats.creditPerSec, 4 / 15, '失败的调用同样记了积分');
  assert.strictEqual(stats.ttft, 600, '偶数个样本取中间两项的平均');
  const idle = S.metrics(S.createModel(), T0);
  assert.strictEqual(idle.perMin, 0);
  assert.strictEqual(idle.okRate, 1, '还没有调用时成功率按满算');
});

ok('完成的星点绕行 60 秒，飞入中心期间不再计入最近一分钟', () => {
  const m = S.createModel();
  const row = {at: T0 / 1000, model: 'm', outcome: 'completed', total_tokens: 22};
  S.apply(m, {type: 'start', id: 'orbit-request'}, T0 - 500);
  S.apply(m, {type: 'finish', id: 'orbit-request', row}, T0);
  assert.strictEqual(S.ingestRecent(m, [row], T0 + 100), 0, '轮询不创建重复星点');
  assert.strictEqual(m.live.size, 0, '结束即从在途计数扣除');
  assert.strictEqual(m.ledger.length, 1);
  assert.strictEqual(m.recent.length, 1);
  assert.strictEqual(m.recent[0].arrival.id, 'orbit-request');
  assert.strictEqual(S.orbitReturnProgress(T0, T0 + 59999), 0);
  assert.strictEqual(S.metrics(m, T0 + 59999).perMin, 1);
  assert.strictEqual(S.orbitReturnProgress(T0, T0 + 62000), 0.5);
  assert.strictEqual(S.metrics(m, T0 + 62000).perMin, 0);
  assert.strictEqual(m.recent.length, 1, '飞向中心的动画仍保留星点');
  assert.strictEqual(S.orbitReturnProgress(T0, T0 + 64000), 1);
  S.metrics(m, T0 + 64000);
  assert.strictEqual(m.recent.length, 0);
  assert.strictEqual(m.ledger.length, 1);
});

ok('时钟偏差：服务器写的旧调用不会被当成刚刚发生', () => {
  const m = S.createModel();
  // 快照帧永远是现在时：由此得知浏览器比服务器快两秒
  S.apply(m, {type: 'snapshot', seq: 1, t: (T0 - 2000) / 1000, reset: false, live: [],
    recent: [{id: 'h1', row: {at: (T0 - 3600 * 1000 - 2000) / 1000, model: 'hour-ago', outcome: 'completed'}},
      {id: 'n1', row: {at: (T0 - 1000 - 2000) / 1000, model: 'just-now', outcome: 'completed'}}]}, T0);
  assert.strictEqual(m.skew, 2000);
  same(m.ledger.map((x) => x.model), ['just-now', 'hour-ago']);
  assert.strictEqual(S.metrics(m, T0).perMin, 1, '一小时前的那次不进「调用 / 分钟」');
  assert.strictEqual(m.ledger[1].at, T0 - 3600 * 1000, '条目时刻落在浏览器时钟上');
});

ok('七重环：空转时信号为零，有调用时每项都是 0 到 1 的有限值', () => {
  const idle = S.ringSignals(S.metrics(S.createModel(), T0));
  assert.strictEqual(idle.length, 7);
  same(idle.map((s) => s.value), [0, 0, 0, 0, 0, 0, 0]);
  assert.ok(idle.every((s) => Number.isFinite(s.speed) && s.speed !== 0), '没信号时也在慢慢转');
  assert.ok(idle.some((s) => s.speed > 0) && idle.some((s) => s.speed < 0), '奇偶环反向');
  const busy = S.ringSignals({perMin: 120, live: 3, tokIn: 4000, tokOut: 900, okRate: 0.75, okD: 20, ttft: 900, creditPerSec: 0.4});
  assert.strictEqual(busy.length, 7);
  assert.ok(busy.every((s) => Number.isFinite(s.value) && s.value > 0 && s.value <= 1 && Number.isFinite(s.speed)),
    '有流量时每一环都有有限的正信号: ' + JSON.stringify(busy));
  assert.strictEqual(busy[4].value, 0.5, '成功率 75% 落在 50% 到 100% 的中间');
  // 成功率跌到一半以下：这一环停下来，而不是倒着亮
  const failing = S.ringSignals({perMin: 0, live: 0, tokIn: 0, tokOut: 0, okRate: 0.2, okD: 10, ttft: 0, creditPerSec: 0});
  assert.strictEqual(failing[4].value, 0);
  const one = S.ringSignals({perMin: 1, live: 1, tokIn: 0, tokOut: 0, okRate: 1, okD: 1, ttft: 0, creditPerSec: 0});
  assert.ok(one[1].value > 0, '只有一次在途时「在途」环也要有反应');
  const hot = S.ringSignals({perMin: 1e6, live: 1e6, tokIn: 1e9, tokOut: 1e9, okRate: 1, okD: 50, ttft: 50, creditPerSec: 1e9});
  assert.ok(hot.every((s) => s.value === 1), '再高也只顶到 1: ' + JSON.stringify(hot.map((s) => s.value)));
  // 首字越快转得越快；没有首字样本（非流式、或都失败了）就没有信号
  const slow = S.ringSignals({perMin: 0, live: 0, tokIn: 0, tokOut: 0, okRate: 1, okD: 1, ttft: 4000, creditPerSec: 0});
  const brisk = S.ringSignals({perMin: 0, live: 0, tokIn: 0, tokOut: 0, okRate: 1, okD: 1, ttft: 400, creditPerSec: 0});
  assert.ok(brisk[5].value > slow[5].value && slow[5].value > 0, '首字时延环：越快信号越强');
  assert.strictEqual(S.ringSignals({perMin: 0, live: 0, tokIn: 0, tokOut: 0, okRate: 1, okD: 1, ttft: 0, creditPerSec: 0})[5].value, 0);
});

/* ---- 7. 账号恒星 ---------------------------------------------------- */
ok('忙碌账号优先入图，忙闲切换时恒星的轨位保持稳定', () => {
  const m = S.createModel();
  S.apply(m, {type: 'snapshot', seq: 1, t: T0 / 1000, reset: false, live: [], recent: []}, T0);
  S.apply(m, {type: 'start', seq: 2, id: 'c1'}, T0);
  S.apply(m, {type: 'bind', seq: 3, id: 'c1', account: 'busy'}, T0);
  const accounts = [
    {uid: 'off', nickname: '停', enabled: false},
    {uid: 'err', nickname: '断', enabled: true, breakerFor: 'x'},
    {uid: 'idle', nickname: '闲', enabled: true},
    {uid: 'cool', nickname: '冷', enabled: true, inCooldown: true},
    {uid: 'busy', nickname: '忙', enabled: true},
    {uid: 'held', nickname: '留', enabled: true, reserveBlocked: true},
  ];
  const pack = S.accountStarsOf(accounts, m);
  same(pack.stars.map((star) => [star.uid, star.state]),
    [['busy', 'busy'], ['cool', 'cool'], ['err', 'err'], ['held', 'cool'], ['idle', 'ok'], ['off', 'off']]);
  assert.strictEqual(pack.stars[0].busy, 1);
  assert.strictEqual(pack.overflow, 0);
  const many = S.accountStarsOf([{uid: 'busy', nickname: 'zzzz', enabled: true}].concat(
    Array.from({length: 39}, (_, i) => ({uid: 'u' + i, enabled: true}))), m);
  assert.strictEqual(many.stars.length, 24, '最多画 24 颗恒星');
  assert.strictEqual(many.overflow, 16);
  assert.ok(many.stars.some((star) => star.uid === 'busy'), '忙的账号优先入图');
  m.live.clear();
  const idle = S.accountStarsOf(accounts, m);
  same(idle.stars.map((star) => star.uid), pack.stars.map((star) => star.uid));
  assert.strictEqual(idle.stars[0].state, 'ok');
  same(S.accountStarsOf(null, m).stars, []);
});

/* ---- 8. 调用序列的一行 ---------------------------------------------- */
ok('序列的一行：结果符号、状态码和各项明细', () => {
  const line = S.ledgerLine('zh', {outcome: 'completed', model: 'gpt-5', account: 'acc-1', key: 'k-dev', kind: 'chat', stream: true,
    elapsedMs: 4100, ttftMs: 620, total: 2352, prompt: 1840, completion: 512}, () => '紫电');
  assert.strictEqual(line.glyph, '✓');
  assert.strictEqual(line.ok, true);
  assert.strictEqual(line.fail, false);
  assert.strictEqual(line.meta, '2352 tok');
  assert.ok(line.detail.includes('紫电') && line.detail.includes('k-dev') && line.detail.includes('流式') && line.detail.includes('首字 620ms'),
    line.detail.join(' | '));
  const failed = S.ledgerLine('en', {outcome: 'failed', model: 'glm', status: 503, elapsedMs: 700, kind: 'web'}, null);
  assert.strictEqual(failed.glyph, '✕');
  assert.strictEqual(failed.fail, true);
  assert.strictEqual(failed.meta, 'Failed', '没有 token 可写时，结果写在数值位');
  same(failed.detail, ['tool', 'HTTP 503', '700ms'], '调用类型、状态码、耗时；失败的不写首字时延');
  assert.strictEqual(S.ledgerLine('en', {outcome: 'client_aborted', model: 'm'}, null).glyph, '◌');
  assert.strictEqual(S.ledgerLine('en', {outcome: 'upstream_aborted', model: 'm'}, null).glyph, '⇡');
  // 不认识的调用类型原样显示，不露出词典键名；拿不到显示名的账号退回编号前八位
  const odd = S.ledgerLine('en', {outcome: 'rejected', model: 'm', kind: 'hologram', account: 'abcdefgh1234'}, null);
  assert.strictEqual(odd.title, 'Rejected');
  same(odd.detail, ['abcdefgh', 'hologram']);
  assert.ok(/^\d\d:\d\d:\d\d$/.test(S.ledgerLine('en', {outcome: 'completed', model: 'm', at: Date.UTC(2026, 10, 24, 13, 14, 15)}, null).time), '时刻写成时分秒');
  assert.strictEqual(S.ledgerLine('en', {outcome: 'completed', model: 'm'}, null).time, '—', '没有可用时刻就写破折号，而不是 NaN');
  same(S.ledgerLine('en', {outcome: 'completed', model: 'm', elapsedMs: NaN}, null).detail, ['—'], '耗时不是数字时写破折号，而不是 NaN');
  // 只有 error / status、没有 outcome 的旧行：按失败处理
  const legacy = S.ledgerLine('en', {error: true, status: 429, model: 'old', elapsedMs: 12}, null);
  assert.strictEqual(legacy.glyph, '✕');
  assert.strictEqual(legacy.ok, false);
  same(legacy.detail, ['HTTP 429', '12ms']);
});

/* ---- 9. 小词典 ------------------------------------------------------ */
ok('圣轮的小词典三种语言都齐，占位符一致', () => {
  const keys = Object.keys(S.STRINGS);
  assert.ok(keys.length > 40, '词典条目数量: ' + keys.length);
  const problems = [];
  const slots = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
  for (const key of keys) {
    const row = S.STRINGS[key];
    for (const lang of ['zh', 'zh-Hant', 'en']) {
      if (typeof row[lang] !== 'string' || !row[lang].trim()) problems.push(key + ' 缺 ' + lang);
    }
    if (slots(row.zh) !== slots(row.en) || slots(row.zh) !== slots(row['zh-Hant'])) problems.push(key + ' 占位符不一致');
    if (/[\u4e00-\u9fff]/.test(row.en)) problems.push(key + ' 的英文里混进了中文');
  }
  same(problems, []);
  assert.strictEqual(S.fill('en', 'star_busy_n', {n: 3}), 'Busy · 3 in flight');
  assert.strictEqual(S.fill('zh-Hant', 'star_overflow', {n: 4}), '另有 4 個帳號未畫出');
  assert.strictEqual(S.fill('en', 'ttft', {}), 'First token ', '没有值的位置留空而不是写出花括号');
  assert.strictEqual(S.text('en', '__nope__'), '__nope__', '缺词条时回落成键名，方便发现');
  assert.strictEqual(S.compact(0), '0');
  assert.strictEqual(S.compact(2352), '2352', '四位数原样写，上千才折算');
  assert.strictEqual(S.compact(23520), '23.5k');
  assert.strictEqual(S.compact(1200000), '1.2M');
});

/* ---- 10. SSE 帧 ----------------------------------------------------- */
ok('手解 SSE：序号、事件名和数据；心跳注释不算帧', () => {
  const f = S.parseFrame('id: 7\nevent: finish\r\ndata: {"type":"finish","id":"a1","row":{"model":"gpt-5"}}\r\n');
  assert.strictEqual(f.seq, 7);
  assert.strictEqual(f.type, 'finish');
  assert.strictEqual(f.row.model, 'gpt-5');
  assert.strictEqual(f.id, 'a1');
  assert.strictEqual(S.parseFrame(': keepalive'), null);
  assert.strictEqual(S.parseFrame(''), null);
  assert.strictEqual(S.parseFrame('event: start\ndata: {not json'), null);
  const typed = S.parseFrame('data: {"id":"a2","route":"/v1/responses"}\nevent: start\n');
  assert.strictEqual(typed.type, 'start', '数据里没写类型时取事件名');
  assert.ok(!('seq' in typed), '没有 id 行就不带序号：这样的帧不会被当成续传的位置');
  const joined = S.parseFrame('data: {"type":"live",\ndata: "live":[]}');
  same(joined.live, [], '跨多行的数据按行拼回');
});

/* ---- 11. 流客户端 --------------------------------------------------- */
// 每次读取交出一帧；responses 用完后 fetch 永不应答（流一直挂着）。
function harness(responses){
  const calls = [], timers = [], states = [];
  const counts = {cancelled: 0, aborted: 0};
  const win = {AbortController: globalThis.AbortController, TextDecoder: globalThis.TextDecoder};
  const fetch = (url, init) => {
    calls.push({url, init});
    const next = responses.shift();
    if (!next) return new Promise(() => {});
    return Promise.resolve(typeof next === 'function' ? next() : next);
  };
  const stream = (chunks, onEnd) => {
    let i = 0;
    return {ok: true, status: 200, body: {getReader: () => ({
      read: async () => {
        if (i < chunks.length) return {done: false, value: chunks[i++]};
        if (onEnd) onEnd();
        return {done: true};
      },
      cancel: async () => { counts.cancelled++; },
    })}};
  };
  const make = (onFrame) => S.createFeed({
    url: '/usage/events', headers: () => ({'X-Panel-Token': 't'}), onFrame,
    onState: (name) => states.push(name), fetch, window: win,
    now: () => h.clock,                              // the suite moves the clock itself
    setTimeout: (fn, ms) => { timers.push({fn, ms}); return timers.length; },
    clearTimeout: () => {},
  });
  const h = {calls, timers, states, counts, win, stream, make, clock: 1000000};
  return h;
}
const frame = (seq, type, data) => 'id: ' + seq + '\nevent: ' + type + '\ndata: ' + JSON.stringify(Object.assign({type: type, seq: seq}, data)) + '\n\n';

(async () => {
  {
    const h = harness([() => h.stream([
      frame(1, 'snapshot', {t: 1, reset: false, live: [], recent: []}),
      ': keepalive\n\n',
      frame(2, 'start', {id: 'a1'}),
      frame(3, 'finish', {id: 'a1', row: {model: 'm'}}),
    ])]);
    const frames = [];
    const feed = h.make((f) => frames.push(f.type));
    feed.start();
    await settle();
    same(frames, ['snapshot', 'start', 'finish'], '心跳注释不交给页面');
    assert.strictEqual(feed.lastSeq(), 3);
    same(h.states, ['connecting', 'live', 'retry'], '帧读完了流就到头了：算一次断线');
    assert.strictEqual(h.timers.length, 1, '断线后排一次重连');
    assert.strictEqual(h.calls.length, 1, '排着的重连不触发就不会再发请求');
    assert.strictEqual(h.calls[0].url, '/usage/events');
    assert.strictEqual(h.calls[0].init.headers['X-Panel-Token'], 't', '面板令牌走请求头');
    assert.strictEqual(h.calls[0].init.headers['Last-Event-ID'], undefined);
    assert.strictEqual(h.calls[0].init.cache, 'no-store');
    assert.ok(h.calls[0].init.signal, '请求带中止信号，离开页面时要能掐断');
    ok('流客户端：按顺序送到每一帧，并记住最新序号', () => {});
  }
  {
    // 断线重连：带着最新序号回来，服务端据此续传。每次都是连上就被掐。
    let ends = 0;
    const h = harness([
      () => h.stream([frame(7, 'start', {id: 'a1'})], () => { ends++; }),
      () => h.stream([]),
      () => h.stream([]),
    ]);
    h.make(() => {}).start();
    await settle();
    assert.strictEqual(ends, 1);
    same(h.states, ['connecting', 'live', 'retry']);
    assert.strictEqual(h.timers.length, 1, '断了之后排一次重连');
    assert.strictEqual(h.timers[0].ms, 500, '第一次重连等半秒');
    h.timers.shift().fn();
    await settle();
    assert.strictEqual(h.calls[1].init.headers['Last-Event-ID'], '7', '重连时带上最后看到的序号');
    assert.strictEqual(h.timers[0].ms, 1000, '连上又被掐：退避继续加倍，不能每半秒空转一次');
    h.timers.shift().fn();
    await settle();
    assert.strictEqual(h.calls[2].init.headers['Last-Event-ID'], '7');
    assert.strictEqual(h.timers[0].ms, 2000, '一路加倍下去');
    assert.strictEqual(S.backoffMs(0), 500);
    assert.strictEqual(S.backoffMs(6), 15000, '退避封顶 15 秒');
    ok('断线重连：带着最新序号回来，按退避重试', () => {});
  }
  {
    // 稳稳连过一阵的流断了：这算恢复过，退避从头来
    const minute = 60 * 1000;
    const h = harness([
      () => h.stream([frame(7, 'start', {id: 'a1'})], () => { h.clock += 5 * minute; }),
      () => h.stream([], () => { h.clock += 5 * minute; }),
      () => h.stream([]),
    ]);
    h.make(() => {}).start();
    await settle();
    assert.strictEqual(h.timers[0].ms, 500);
    h.timers.shift().fn();
    await settle();
    assert.strictEqual(h.timers[0].ms, 500, '连了五分钟的流断了：很快重连，不退避');
    h.timers.shift().fn();
    await settle();
    assert.strictEqual(h.timers[0].ms, 1000, '紧接着又断：这才开始退避');
    ok('稳定连过的流断开后很快重连', () => {});
  }
  {
    // 落后太多：服务端让重置，丢掉旧序号重连
    const h = harness([() => h.stream([
      frame(9, 'finish', {id: 'a1', row: {}}),
      'event: reset\ndata: {"type":"reset","reason":"lagged"}\n\n',
    ])]);
    const frames = [];
    const feed = h.make((f) => frames.push(f.type));
    feed.start();
    await settle();
    same(frames, ['finish'], '重置之前收到的帧照常交给页面');
    assert.strictEqual(feed.lastSeq(), null, '旧序号作废');
    assert.strictEqual(h.counts.cancelled, 1, '掐掉落后的那条流');
    assert.strictEqual(h.timers.length, 1);
    assert.strictEqual(h.timers[0].ms, 400, '重置后很快重连');
    // 重置本身不当作一帧交给页面，而是报成一次状态变化：页面据此显示「重连中」
    same(h.states, ['connecting', 'live', 'reset']);
    ok('落后太多时按服务端要求重置后重连', () => {});
  }
  {
    const h = harness([{ok: false, status: 401}]);
    const feed = h.make(() => {});
    feed.start();
    await settle();
    same(h.states, ['connecting', 'unauthorized']);
    assert.strictEqual(h.timers.length, 0, '会话失效不再重连');
    assert.strictEqual(feed.isClosed(), true);
    ok('会话失效：报给页面后收摊，不再重连', () => {});
  }
  {
    // 流不可用（旧代理把响应收成了一整块、或订阅已满）：退回去重试，页面转轮询
    for (const response of [{ok: false, status: 503}, {ok: true, status: 200, body: null}, {ok: true, status: 200, json: () => {}}]) {
      const h = harness([response, response, response, response, response]);
      h.make(() => {}).start();
      await settle();
      assert.strictEqual(h.timers.length, 1, '排一次重连');
      same(h.states, ['connecting', 'retry']);
    }
    ok('流不可用时退回去重试（页面同时转轮询）', () => {});
  }
  {
    // 离开页面：请求还挂着的时候停掉，之后不再有任何请求
    const h = harness([]);
    const RealAbort = globalThis.AbortController;
    h.win.AbortController = class extends RealAbort { abort(){ h.counts.aborted++; super.abort(); } };
    const feed = h.make(() => {});
    feed.start();
    await settle();
    assert.strictEqual(h.calls.length, 1);
    feed.stop();
    assert.strictEqual(h.counts.aborted, 1, '停掉时掐断在飞的请求');
    feed.start();
    h.timers.splice(0).forEach((t) => t.fn());
    await settle();
    assert.strictEqual(h.calls.length, 1, '停掉之后再 start、再触发定时器，也不会发请求');
    assert.strictEqual(feed.isClosed(), true);
    ok('离开页面：停掉之后不再有任何请求', () => {});
  }

  /* ---- 12. 结构：皮肤样式只在开了皮肤时生效 ------------------------- */
  const styleAt = html.indexOf('<style id="sanctumStyles">');
  assert.ok(styleAt > 0, '要有 <style id="sanctumStyles">');
  const css = html.slice(styleAt + '<style id="sanctumStyles">'.length, html.indexOf('</style>', styleAt))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  // 按花括号深度取出顶层规则（注释已剥掉，引号里的内容原样跳过）。
  function topRules(text){
    const out = [], stack = [];
    let start = 0, quote = null;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '{') stack.push({prelude: text.slice(start, i).trim(), from: i + 1});
      else if (c === '}') {
        const frame = stack.pop();
        if (!stack.length) out.push({prelude: frame.prelude, body: text.slice(frame.from, i)});
      } else continue;
      start = i + 1;
    }
    assert.strictEqual(stack.length, 0, '样式表的花括号要配对');
    return out;
  }
  function selectorLists(text){
    const lists = [];
    for (const rule of topRules(text)) {
      if (rule.prelude.startsWith('@keyframes')) continue;       // 里面是 from / to，不是选择器
      if (rule.prelude.startsWith('@media')) lists.push(...selectorLists(rule.body));
      else lists.push(rule.prelude);
    }
    return lists;
  }
  // 选择器列表按逗号拆开——但只拆括号和引号之外的：属性值里也可能有逗号
  // （.badge[style*="124,58,237"]）。
  function splitSelectors(list){
    const out = [];
    let depth = 0, quote = null, start = 0;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '[' || c === '(') depth++;
      else if (c === ']' || c === ')') depth--;
      else if (c === ',' && !depth) { out.push(list.slice(start, i).trim()); start = i + 1; }
    }
    out.push(list.slice(start).trim());
    return out;
  }

  const skin = 'html[data-ui="next"][data-skin="sanctum"][data-main-tab="overview"]';
  const hiddenStage = 'html:not(' + skin.slice(4) + ') #sanctumStage';
  ok('圣轮样式随总览页签生效', () => {
    assert.strictEqual(html.indexOf('<style id="sanctumStyles">', styleAt + 1), -1, '只有一份');
    const selectors = selectorLists(css).flatMap(splitSelectors);
    same(selectors.filter(selector => !selector.startsWith(skin) && selector !== hiddenStage), [],
      '所有圣轮规则都要求当前页是总览');
    assert.ok(selectors.includes(skin + ' .next-brand-mark'), '首页导航与舞台同色');
    assert.ok(selectors.includes(skin + ' #sanctumStage #sanctumCanvas'), '舞台加载局部画布样式');
    assert.ok(!css.includes('#consoleInsights'), '运行详情里的仪表使用普通主题');
    const media = topRules(css).filter(rule => rule.prelude.startsWith('@media'));
    assert.ok(media.length >= 3, '保留大屏的响应式布局');
    assert.ok(topRules(css).some(rule => rule.prelude === '@keyframes sctRowIn'));
    assert.strictEqual(html.split('@keyframes sctRowIn').length - 1, 1, '关键帧名全页唯一');
    assert.ok(!/https?:\/\//.test(css), '大屏样式不引用任何外部资源');
    assert.ok(!/@import\b/.test(css), '大屏样式不导入外部样式表');
  });

  ok('整个首页共用明暗配色', () => {
    const rules = topRules(css);
    const dark = rules.find(rule => rule.prelude === skin + ' body');
    const light = rules.find(rule => rule.prelude === skin + '[data-theme="light"] body');
    assert.ok(dark && light, '墨、纸各一份取值');
    const value = (block, name) => (block.match(new RegExp(name + ':(#[0-9a-fA-F]{6})')) || [])[1];
    const luma = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).reduce((a, b) => a + b, 0);
    for (const name of ['--fg', '--dim', '--panel', '--sct-paper']) {
      assert.ok(value(dark.body, name) && value(light.body, name), '两种配色都要定义 ' + name);
    }
    assert.ok(luma(value(light.body, '--fg')) < luma(value(light.body, '--sct-paper')), '纸：黑字白底');
    assert.ok(luma(value(dark.body, '--fg')) > luma(value(dark.body, '--sct-paper')), '墨：白字黑底');
    for (const hex of (dark.body + light.body).match(/#[0-9a-fA-F]{6}\b/g)) {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
      assert.strictEqual(Math.max(r, g, b), Math.min(r, g, b), hex + ' 不是中性灰');
    }
    assert.ok(dark.body.includes('--sct-mono:') && !light.body.includes('--sct-mono:'));
  });

  ok('总览只包含圣轮舞台，原有内容保留在运行详情', () => {
    const stage = html.indexOf('<section id="sanctumStage" data-no-i18n');
    assert.ok(stage > 0);
    const overview = html.lastIndexOf('<div id="pageOverview"', stage);
    const end = html.indexOf('<!-- /pageOverview -->', stage);
    assert.ok(overview > 0 && end > stage, '舞台要在总览页里');
    const stageEnd = html.indexOf('</section>', stage) + '</section>'.length;
    const block = html.slice(stage, stageEnd);
    const overviewContent = html.slice(html.indexOf('>', overview) + 1, html.lastIndexOf('</div>', end));
    assert.strictEqual(overviewContent.replace(/<!--[\s\S]*?-->/g, '').trim(), block);
    const runtime = html.slice(html.indexOf('<div id="pageRuntime"'), html.indexOf('<!-- /pageRuntime -->'));
    for(const marker of ['realm-cards-grid', 'consoleInsights', 'recentRequestsSection']){
      assert.ok(runtime.includes(marker), marker + ' 应保留在运行详情');
    }
    assert.ok(!/<t(able|head|body)[\s>]/.test(block), '不能用表格：有套件靠文件里第一个 <thead> 定位');
    for (const id of ['sanctumStage', 'sanctumScene', 'sanctumCanvas', 'sanctumLedger', 'sanctumFeed', 'sanctumLegend',
      'sanctumTooltip', 'sanctumPauseBtn', 'sanctumResetBtn', 'sanctumFullscreenBtn', 'sanctumActiveFlow',
      'sanctumFallback', 'sanctumViewport']) {
      assert.strictEqual(html.split('id="' + id + '"').length - 1, 1, id + ' 应当恰好出现一次');
    }
    assert.ok(/<canvas id="sanctumCanvas" role="img" aria-label=/.test(block), '画布要能被读屏软件认出来');
    assert.ok(/id="sanctumScene">\s*<div class="sct-viewport"/.test(block), '画布从左侧舞台顶部开始');
    assert.ok(!/id="sanctum(?:Title|Motto)"/.test(block), '标题栏的空间留给画布');
    assert.ok(/id="sanctumResetBtn"[^<]*<\/button>\s*<button[^>]+id="sanctumFullscreenBtn"/.test(block),
      '全屏按钮紧挨复位视角');
    assert.ok(/<button type="button" class="sct-btn" id="sanctum(Pause|Reset)Btn"/.test(block.split('id="sanctumPauseBtn"').length > 1 ? block : ''),
      '操作按钮是真正的按钮，键盘也能用');
    assert.ok(css.includes(hiddenStage + '{display:none!important}'),
      '不开皮肤时舞台必须隐藏');
    assert.ok(/id="sanctumFullscreenBtn" aria-controls="pageOverview" aria-pressed="false"/.test(block),
      '全屏按钮作用于整个总览，并暴露开关状态');
  });

  ok('皮肤是静态的：写在 <html> 上，没有开关也没有 URL 参数', () => {
    // 以前皮肤由 <head> 里一段首帧脚本按 ?skin= / wb-skin 决定，主题菜单里还有开关。
    // 面板只剩这一套壳之后，皮肤是静态属性：首帧就是圣轮，不存在「闪一下旧皮肤」。
    const root = html.match(/<html\s+([^>]*)>/);
    assert.ok(root, '找不到 <html> 标签');
    assert.match(root[1], /\bdata-ui="next"/, '<html> 要静态带上唯一的壳');
    assert.match(root[1], /\bdata-skin="sanctum"/, '<html> 要静态带上圣轮皮肤');
    // （词典里「圣轮大屏 / 关闭圣轮大屏」两个词条留在原地：这次只删界面，不清理旧词条。）
    for (const gone of ['wb-skin', 'wb-ui-mode', '?skin=', 'toggleSanctumSkin', '__SANCTUM_SKIN__',
                        '__NEXT_UI__', 'sanctumSkinOption']) {
      assert.ok(!html.includes(gone), '旧的皮肤开关不应残留：' + gone);
    }
    // 舞台脚本仍按这个属性判断，别写成常量 true：样式那边同样挂在 data-skin 上。
    assert.ok(/getAttribute\('data-skin'\) === SKIN/.test(html), '舞台脚本要按 data-skin 属性判断');
  });

  ok('舞台脚本：经典脚本、不引外部资源、不用 EventSource', () => {
    const start = html.lastIndexOf('/* ---- 圣轮（Sanctum）：圣轮皮肤下的首页舞台 ----');
    assert.ok(start > 0);
    const src = html.slice(start, html.indexOf('</script>', start));
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/^\s*(import|export)\s/m.test(code), '页面脚本要能按经典脚本解析');
    assert.ok(!/https?:\/\//.test(src), '不引用任何外部资源（本页不走 CDN）');
    assert.ok(!/\bEventSource\b/.test(code), '面板令牌只认请求头，原生 EventSource 发不了自定义头');
    assert.ok(src.indexOf('wb-proxy-panel-token') === -1, '令牌的存储键全页只定义一处，这里复用 authHeaders()');
    assert.ok(code.indexOf('authHeaders()') > 0);
    assert.ok(code.indexOf("'/usage/events'") > 0, '读的是面板的实时流端点');
    assert.ok(code.indexOf('win.fetch(url, init)') > 0, '默认取数函数要真的去请求');
  });

  ok('舞台没启动时什么都不做', () => {
    assert.strictEqual(S.model(), null, '没启动就没有模型');
    assert.strictEqual(S.feedState(), 'paused', '没启动时不是「连接中」');
    assert.ok(!page.document.documentElement.getAttribute('data-skin'), '沙箱里没有皮肤属性，舞台不会启动');
  });

  console.log('sanctum model suite ok (' + passed + ' checks)');
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
