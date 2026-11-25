/* API Key 的出口徽章与模型准入清单（#801 / #802）。
 * 覆盖公开模型 ID、出口绑定和新增适配器的目录项。
 *
 * Run with Node: node tests/_test_key_codearts.js
 */
'use strict';
const assert = require('assert');
const {dashboardScript} = require('./_dashboard_source.js');
const dom = require('./_dom_stub.js');

const script = dashboardScript();

/* ---- 结构：徽章与清单都覆盖 codearts ---------------------------------- */

assert.ok(/function keyRealmBadge\(realm, px\)/.test(script),
  '出口徽章应统一走 keyRealmBadge()，避免两处写法再次不一致');
assert.ok(/realm === 'codearts'\) return '<span class="realm-badge-codearts"/.test(script),
  'keyRealmBadge 必须有 codearts 分支（并复用已有的 .realm-badge-codearts 样式）');
assert.ok(/const realmBadge = keyRealmBadge\(row\.realm\);/.test(script),
  'Key 列表卡片应使用 keyRealmBadge，而不是自己写三目');

assert.ok(/async function loadKeyModelCatalog\(row\)/.test(script),
  'loadKeyModelCatalog 应收 Key（按绑定出口取目录）');
/* ---- 行为：徽章文案 ---------------------------------------------------- */

dom.installDom();
const calls = [];
let codeartsOn = true;
global.fetch = function(url, options){
  calls.push(String(url));
  let payload = {object: 'list', data: []};
  if(String(url) === '/v1/models'){
    payload.data = [
      {id: 'wb-intl/deepseek-v4.1-flash', route_realm: 'intl'},
      {id: 'wb-cn/deepseek-v4.1-flash', route_realm: 'cn'},
      {id: 'fixture/model', route_realm: null},
    ];
    if(codeartsOn) payload.data.push({id: 'codearts/GLM-5.2', route_realm: 'codearts'});
  }
  return Promise.resolve({
    status: 200, ok: true,
    json: function(){ return Promise.resolve(payload); },
    text: function(){ return Promise.resolve(JSON.stringify(payload)); },
  });
};

const realLog = console.log;
console.log = function(){};
let api;
try {
  api = new Function(script + `
    return {
      keyRealmBadge: keyRealmBadge,
      loadKeyModelCatalog: loadKeyModelCatalog,
      editKeyModelPatterns: editKeyModelPatterns,
      setKeyModelsAll: setKeyModelsAll,
      setModelRow: row => { API_KEY_ROWS = [row]; },
    };`)();
} catch(e){
  console.log = realLog;
  console.error('脚本求值失败:', e.message);
  process.exit(1);
}
console.log = realLog;

/* 1. 徽章：未绑定的 Key 按模型前缀路由。 */
assert.ok(/realm-badge-codearts[^>]*>固定 CodeArts 出口</.test(api.keyRealmBadge('codearts')),
  '绑定 CodeArts 出口的 Key 必须显示「固定 CodeArts 出口」，不能落到兜底分支');
assert.ok(/realm-badge-intl[^>]*>固定国际版出口</.test(api.keyRealmBadge('intl')),
  'intl 徽章保持原样');
assert.ok(/realm-badge-cn[^>]*>固定国内版出口</.test(api.keyRealmBadge('cn')),
  'cn 徽章保持原样');
assert.ok(/按模型前缀路由/.test(api.keyRealmBadge('')), '未绑定出口显示「按模型前缀路由」');
assert.ok(!/固定 CodeArts 出口/.test(api.keyRealmBadge('')),
  '未绑定出口不能被画成固定出口');

/* 2. 绑定 codearts 的 Key：只取 codearts 目录，且条目不混入 intl / cn。 */
(async function(){
  calls.length = 0;
  const models = await api.loadKeyModelCatalog({realm: 'codearts'});
  assert.deepStrictEqual(models.map(m => m.id), ['codearts/GLM-5.2'],
    '绑定 CodeArts 出口的 Key 应只列 CodeArts 的模型');
  assert.deepStrictEqual(calls, ['/v1/models'], '使用一个公开目录请求');

  /* 3. 切换 Key 的绑定时，更新这个 Key 可用的模型。 */
  const intl = await api.loadKeyModelCatalog({realm: 'intl'});
  assert.deepStrictEqual(intl.map(m => m.id), ['wb-intl/deepseek-v4.1-flash']);

  /* 4. 无绑定的 Key 包含目录中的全部出口和同名模型。 */
  const all = await api.loadKeyModelCatalog({});
  assert.deepStrictEqual(all.map(m => m.id).sort(),
    ['codearts/GLM-5.2', 'fixture/model', 'wb-cn/deepseek-v4.1-flash', 'wb-intl/deepseek-v4.1-flash']);

  /* 5. CodeArts 未启用时，编辑绑定它的 Key 时保留空目录。 */
  codeartsOn = false;
  assert.deepStrictEqual(await api.loadKeyModelCatalog({realm: 'codearts'}), []);

  const row = {models: []};
  api.setModelRow(row);
  const checkbox = {value: 'codearts/GLM-5.2', checked: false};
  document.getElementById('editKeyModelList_0').querySelectorAll = () => [checkbox];
  const patterns = document.getElementById('editKeyModelPatterns_0');
  api.editKeyModelPatterns(0, 'wb-cn/*; fixture/model, wb-cn/*');
  assert.deepStrictEqual(row.models, ['wb-cn/*', 'fixture/model']);
  api.setKeyModelsAll(0, true);
  assert.ok(checkbox.checked);
  assert.strictEqual(patterns.value, 'wb-cn/*, codearts/glm-5.2, fixture/model');
  api.setKeyModelsAll(0, false);
  assert.deepStrictEqual(row.models, ['wb-cn/*', 'fixture/model'],
    '取消目录模型勾选时保留手填的跨平台模型 ID 与通配符');

  console.log('_test_key_codearts.js: all assertions passed');
})().catch(function(e){
  console.error(e && e.stack || e);
  process.exit(1);
});
