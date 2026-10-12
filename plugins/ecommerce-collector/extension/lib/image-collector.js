// 电商采集大师 - 图片快采拦截器（v1.1.36）
// document_start 注入（隔离世界）。职责：
// 1. 立即请求 worker 注入 MAIN 世界拦截器（抓 initial mtop 请求）
// 2. 监听 MAIN 世界的 ssr:ready CustomEvent（旧名 ais-intercepted 亦兼容），归档 detail/sku/desc/review 响应
// 3. 暴露 window.__AIS_IMG_COLLECTOR__ 供 panel.js 读取
(function(){
'use strict';
if (window.__AIS_IMG_COLLECTOR__) return;

var DETAIL_HOST_RE = /^(?:detail|item)[.]tmall[.]com$/;
var DETAIL_TB_RE = /^item[.]taobao[.]com$/;
var DETAIL_JD_RE = /^item[.]jd[.]com$/;
var DETAIL_1688_RE = /^detail[.]1688[.]com$/;

function isDetailPage(){
  try {
    var h = location.hostname;
    if (DETAIL_HOST_RE.test(h)) return true;
    if (DETAIL_TB_RE.test(h)) return /item[.]html|[?&]id=/.test(location.href);
    if (DETAIL_JD_RE.test(h)) return /[.]html/.test(location.pathname);
    if (DETAIL_1688_RE.test(h)) return /\/offer\//.test(location.pathname);
  } catch(e){}
  return false;
}

var state = {
  detailResponse: null,
  skuResponse: null,
  descResponse: null,
  reviewResponse: null,
  allResponses: [],
  isDetailPage: isDetailPage(),
  readyAt: Date.now(),
  lastAt: 0
};

function archive(type, url, data){
  try {
    var entry = { type: type, url: String(url || ''), at: Date.now() };
    state.allResponses.push(entry);
    if (state.allResponses.length > 200) state.allResponses.splice(0, state.allResponses.length - 200);
    if (type === 'detail') { state.detailResponse = { url: entry.url, data: data }; state.lastAt = entry.at; }
    else if (type === 'sku') { var __prevSku = state.skuResponse; var __hasBase = function(x) { try { return !!(x && x.data && (x.data.skuBase || x.data.skuCore || (x.data.data && (x.data.data.skuBase || x.data.data.skuCore)))); } catch (e) { return false; } }; if (!__prevSku || __hasBase({ data: data }) || !__hasBase(__prevSku)) { state.skuResponse = { url: entry.url, data: data }; } state.lastAt = entry.at; }
    else if (type === 'desc') { state.descResponse = { url: entry.url, data: data }; state.lastAt = entry.at; }
    else if (type === 'review') { if (!state.reviewResponse) state.reviewResponse = { url: entry.url, data: data }; state.lastAt = entry.at; }
  } catch(e){}
}

// 监听 MAIN 世界拦截器派发的事件（注意：DetailCollector 的监听只认 detail/sku/review，
// 图片快采这里独立监听，额外接受 desc，互不干扰）
// v1.2.442【根因修复·事件名对齐】v1.2.365「自定义事件名中性化」把主世界/worker 派发的
// `ais-intercepted` 统一改名为 `ssr:ready`（该次共改 67 处 / 8 个文件），**本文件被漏改**：
// 于是 `window.__AIS_IMG_COLLECTOR__` 自 v1.2.365 起永远收不到任何响应
// （真机实测：allResponses 恒为 0、skuResponse/detailResponse 恒为 null，面板全部退化成 DOM 兜底
//  —— 这正是「SKU 采集为 0 / 详情图与参数只能靠 DOM 猜」的上游根因）。
// 现同时监听新名（当前主用）与旧名（兼容可能仍派发旧名的主世界脚本）。
function __aisArchiveIntercept(ev){
  try {
    var d = ev && ev.detail;
    if (!d || !d.type) return;
    if (d.type === 'detail' || d.type === 'sku' || d.type === 'desc' || d.type === 'review') {
      archive(d.type, d.url, d.data);
    }
  } catch(e){}
}
window.addEventListener('ssr:ready', __aisArchiveIntercept, true);        // v1.2.365 起的当前事件名
window.addEventListener('ais-intercepted', __aisArchiveIntercept, true);  // 旧名兼容

// 请求 worker 注入 MAIN 世界拦截器（0/800/2500ms 三连发，确保抢在首屏 mtop 之前）
function kick(){
  try { chrome.runtime.sendMessage({ action: 'injectInterceptor' }, function(){ void chrome.runtime.lastError; }); } catch(e){}
}
kick();
setTimeout(kick, 800);
setTimeout(kick, 2500);

window.__AIS_IMG_COLLECTOR__ = state;
})();
