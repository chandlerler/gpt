// 电商采集大师 - Background Service Worker
// 负责定时任务调度、数据存储管理和通知

// 加载全局配置（统一服务器地址入口）
// v1.2.405【真根因】：MV3 里 importScripts 在 SW 重启后会直接抛
//   "importScripts() of new scripts after service worker installation is not allowed"
// （真机实测 SW 控制台：config.js 加载失败 → license.js 也没加载）→ SW 里既没有 AIS_CONFIG
// 也没有 LicenseManager，会员二次校验恒 fail-closed。
// 改为【零依赖内联】：配置常量与 lib/config.js 同源维护；授权判定改读 chrome.storage（见 aisReviewDownloadAllowed）。
var AIS_CONFIG = { serverUrl: 'https://www.facailo.xyz' };
try {
  Object.defineProperty(AIS_CONFIG, 'apiBase', { get: function () { return this.serverUrl + '/api'; } });
  Object.defineProperty(AIS_CONFIG, 'dataApi', { get: function () { return this.serverUrl + '/api/data'; } });
  Object.defineProperty(AIS_CONFIG, 'feedbackApi', { get: function () { return this.serverUrl + '/api/feedback'; } });
} catch (eCfg) {}
try { self.AIS_CONFIG = AIS_CONFIG; } catch (eCfg2) {}
const API_BASE = AIS_CONFIG.apiBase;

// 主世界凭据请求只允许当前标签页所属平台家族的 HTTPS API。
const AIS_PLATFORM_HOSTS = {
  jd: ['jd.com', '3.cn', 'jdcloud.com', '360buyimg.com'],
  taobao: ['taobao.com', 'tmall.com'],
  pdd: ['pinduoduo.com', 'yangkeduo.com'],
  alibaba: ['1688.com', 'alibaba.com'],
};
function aisHostMatches(host, suffix) { return host === suffix || host.endsWith('.' + suffix); }
function aisPlatformFamily(host) {
  host = String(host || '').toLowerCase();
  for (const family of Object.keys(AIS_PLATFORM_HOSTS)) {
    if (AIS_PLATFORM_HOSTS[family].some((suffix) => aisHostMatches(host, suffix))) return family;
  }
  return '';
}
function validateMainWorldFetch(requestUrl, senderUrl) {
  if (typeof requestUrl !== 'string' || requestUrl.length > 4096 || typeof senderUrl !== 'string') return null;
  try {
    const req = new URL(requestUrl);
    const sender = new URL(senderUrl);
    if (req.protocol !== 'https:' || sender.protocol !== 'https:' || (req.port && req.port !== '443')) return null;
    const senderFamily = aisPlatformFamily(sender.hostname);
    if (!senderFamily || aisPlatformFamily(req.hostname) !== senderFamily) return null;
    return req.href;
  } catch (e) { return null; }
}

// === 安装/更新 ===
chrome.runtime.onInstalled.addListener((details) => {
  console.log('电商采集大师 installed', details.reason);
  // 仅首次安装时初始化；update/chrome_update 保留用户数据（修复：每次更新清空采集配置/定时任务/历史）
  if (details.reason === 'install') {
    chrome.storage.local.set({
      settings: { autoDetect: true, maxPages: 10, delay: 1500 },
      scheduleTasks: [],
      dataHistory: [],
    });
  }
  // 创建右键菜单
  createContextMenus();
});

// 单独调用以兼容浏览器重启后菜单丢失的情况
try { createContextMenus(); } catch(e) {}

// === 右键菜单 ===
function createContextMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(function() {
    chrome.contextMenus.create({
      id: 'ais-scan-list',
      title: '🛰 电商采集大师：抓取这个列表',
      contexts: ['page', 'selection', 'link', 'image'],
      documentUrlPatterns: [ '*://taobao.com/*', '*://*.taobao.com/*', '*://tmall.com/*', '*://*.tmall.com/*', '*://jd.com/*', '*://*.jd.com/*', '*://3.cn/*', '*://*.3.cn/*', '*://pinduoduo.com/*', '*://*.pinduoduo.com/*', '*://yangkeduo.com/*', '*://*.yangkeduo.com/*', '*://1688.com/*', '*://*.1688.com/*', '*://alibaba.com/*', '*://*.alibaba.com/*' ]
    });
    chrome.contextMenus.create({
      id: 'ais-scan-detail',
      title: '🎯 电商采集大师：深度采集此商品详情',
      contexts: ['page', 'link'],
      documentUrlPatterns: [ '*://taobao.com/*', '*://*.taobao.com/*', '*://tmall.com/*', '*://*.tmall.com/*', '*://jd.com/*', '*://*.jd.com/*', '*://3.cn/*', '*://*.3.cn/*', '*://pinduoduo.com/*', '*://*.pinduoduo.com/*', '*://yangkeduo.com/*', '*://*.yangkeduo.com/*', '*://1688.com/*', '*://*.1688.com/*', '*://alibaba.com/*', '*://*.alibaba.com/*' ]
    });
    chrome.contextMenus.create({
      id: 'ais-resume',
      title: '⏯ 电商采集大师：从断点恢复采集',
      contexts: ['page'],
      documentUrlPatterns: [ '*://taobao.com/*', '*://*.taobao.com/*', '*://tmall.com/*', '*://*.tmall.com/*', '*://jd.com/*', '*://*.jd.com/*', '*://3.cn/*', '*://*.3.cn/*', '*://pinduoduo.com/*', '*://*.pinduoduo.com/*', '*://yangkeduo.com/*', '*://*.yangkeduo.com/*', '*://1688.com/*', '*://*.1688.com/*', '*://alibaba.com/*', '*://*.alibaba.com/*' ]
    });
    chrome.contextMenus.create({
      id: 'ais-incremental',
      title: '➕ 电商采集大师：增量去重采集',
      contexts: ['page'],
      documentUrlPatterns: [ '*://taobao.com/*', '*://*.taobao.com/*', '*://tmall.com/*', '*://*.tmall.com/*', '*://jd.com/*', '*://*.jd.com/*', '*://3.cn/*', '*://*.3.cn/*', '*://pinduoduo.com/*', '*://*.pinduoduo.com/*', '*://yangkeduo.com/*', '*://*.yangkeduo.com/*', '*://1688.com/*', '*://*.1688.com/*', '*://alibaba.com/*', '*://*.alibaba.com/*' ]
    });
  });
}

chrome.contextMenus && chrome.contextMenus.onClicked.addListener(function(info, tab) {
  if (!tab || !tab.id) return;
  var action = null;
  var payload = {};
  switch (info.menuItemId) {
    case 'ais-scan-list':
      action = 'contextScanList';
      break;
    case 'ais-scan-detail':
      action = 'contextScanDetail';
      payload.linkUrl = info.linkUrl;
      break;
    case 'ais-resume':
      action = 'contextResume';
      break;
    case 'ais-incremental':
      action = 'contextIncremental';
      break;
  }
  if (action) {
    chrome.tabs.sendMessage(tab.id, { action: action, payload: payload, tabUrl: tab.url }, function(resp) {
      if (chrome.runtime.lastError) {
        // content script 未注入，忽略
        console.log('[电商采集大师] context menu msg failed:', chrome.runtime.lastError.message);
      }
    });
  }
});

// === 点击扩展图标：完整热重载 ===
// 注入 manifest 中 content_scripts 的全部文件（含 panel.js），content.js 检测到重载后自动重建 shadow 面板。
// 每次修改扩展代码后，点扩展图标即可让已打开页面生效，无需刷新页面（避免刷新触发反爬）。
const HOT_RELOAD_FILES = null; // 从 manifest 动态读取
async function getHotReloadFiles() {
  try {
    const mf = await (await fetch(chrome.runtime.getURL('manifest.json'))).json();
    const files = [];
    if (mf.content_scripts) {
      for (const cs of mf.content_scripts) {
        (cs.js || []).forEach((f) => { if (!files.includes(f)) files.push(f); });
      }
    }
    // 确保 panel.css/content.css 也刷新（insertCSS 部分由注入脚本处理样式，这里只注入 js + 触发重建）
    return files;
  } catch(e) {
    // 兜底：硬编码完整列表
    return ['lib/config.js','lib/jszip.min.js','lib/xlsx.full.min.js','lib/platform-configs.js',
      'lib/request-policy.js','lib/incremental-collector.js','lib/stats.js','lib/csv-beautifier.js',
      'lib/export.js','lib/license.js','lib/license-modal.js',
      'lib/review-prompt.js','content/content.js','content/panel.js','content/manual.js'];
  }
}
chrome.action.onClicked.addListener(async (tab) => {
  // 完整热重载：重新注入全部 content script（含 panel.js），content.js 的 reload 标记触发 shadow 面板重建
  try {
    const files = await getHotReloadFiles();
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: files
    });
    try { await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/content.css'] }); } catch (e) {}
    try { await chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' }); } catch (e) {}
    console.log('[电商采集大师] 完整热重载完成 (不刷新页面)', tab.id, files.length, 'files');
  } catch (err) {
    console.error('热重载失败:', err.message);
  }
});

// === 开发热重载（MV3 定制版，借鉴 crx-hotreload 机制；正式版自动禁用） ===
// 本地跑 `node dev/hotreload-server.mjs` 监听源码目录，变化经 SSE 推送到这里：
//   scope=content：对所有已打开页面重注入 content scripts（面板无感重建，不刷新页面，防反爬）
//   scope=sw：manifest/background 变化 → chrome.runtime.reload()，新 SW 启动后重连并自动重注入
// 开发模式判定：以"加载已解压的扩展程序"安装时 manifest 无 update_url；商店/正式版自动跳过。
const IS_DEV_BUILD = false; // Installable local release, no development SSE connection.
async function hotReloadAllTabs() {
  try {
    const files = await getHotReloadFiles();
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: files });
        try { await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/content.css'] }); } catch (e) {}
      } catch (e) { /* chrome:// 等不可注入页跳过 */ }
    }
    console.log('[电商采集大师][hotreload] 已重注入', tabs.length, '个标签页');
  } catch (e) { console.warn('[hotreload] 重注入失败:', e && e.message); }
}
function devHotReloadConnect() {
  if (!IS_DEV_BUILD) return;
  const SRC = 'http://127.0.0.1:57132/events';
  let retry = 3000;
  (async function loop() {
    for (;;) {
      try {
        const resp = await fetch(SRC, { cache: 'no-store' });
        retry = 3000;
        const rd = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const m = chunk.match(/^data: (.+)$/m);
            if (!m) continue;
            let evt; try { evt = JSON.parse(m[1]); } catch (e) { continue; }
            if (evt.scope === 'sw') { console.log('[hotreload] SW 源码变化 → runtime.reload'); chrome.runtime.reload(); return; }
            if (evt.scope === 'content') { console.log('[hotreload] 内容脚本变化 →', evt.file); await hotReloadAllTabs(); }
          }
        }
      } catch (e) { /* server 未启动时静默重试 */ }
      await new Promise(r => setTimeout(r, retry));
      retry = Math.min(retry * 2, 10000);
    }
  })();
}
devHotReloadConnect();

// v1.1.154：后台下载来源与评论图片会员二次校验（前端门控不可作为唯一边界）
function aisSenderIsPlatformTab(sender) {
  try { return !!(sender && sender.tab && /^https:\/\//.test(sender.tab.url || '') && !!aisPlatformFamily(new URL(sender.tab.url).hostname)); } catch (e) { return false; }
}
async function aisReviewDownloadAllowed() { return true; }

// v1.1.154：受控单图下载，供消息分支统一执行来源与会员校验
function aisHandleSingleDownload(request, sendResponse) {
  if (!request.url) { sendResponse({ success: false, error: 'no url' }); return; }
  chrome.downloads.download({ url: request.url, filename: request.filename || 'aiscraper-img/image.jpg', saveAs: false, conflictAction: 'uniquify' }, function(downloadId) {
    if (chrome.runtime.lastError) { sendResponse({ success: false, error: chrome.runtime.lastError.message }); return; }
    setTimeout(function() {
      chrome.downloads.search({ id: downloadId }, function(items) {
        if (chrome.runtime.lastError || !items || !items.length) { sendResponse({ success: true, id: downloadId, filename: request.filename }); return; }
        var item = items[0];
        sendResponse({ success: true, id: downloadId, filename: request.filename, localPath: item.filename || '', fileSize: item.fileSize || 0 });
      });
    }, 300);
  });
}
// === 消息处理 ===
// v1.2.208：拼多多评论页 opener 登记（采完焦点零刷新切回商品页再关评论页）
var __pddCmtOpeners = {};
try { chrome.tabs.onRemoved.addListener(function (tid) { delete __pddCmtOpeners[tid]; }); } catch (ePddOrphan) {}

// ===== v1.2.338：远程规则「广播 + 定时自动刷新」=====
// 目标：只改服务器 anchor-rules.json，用户端自动生效——不需更新插件、不需刷新页面、不需手动点按钮。
// v1.2.339：远程规则源（按优先级）。★国内可达源放第一位——否则国内用户永远拉不到更新。
//   · Gitee 镜像（国内直连可用）：把本仓库 anchor-rules.json 同步一份到 Gitee 后，把 <user>/<repo> 换成你的；
//   · 国内对象存储 + CDN（腾讯云 COS / 阿里云 OSS）最稳，可放第一位；
//   · facailo.xyz / GitHub / jsdelivr 作为海外/兜底源保留。
// v1.2.340（用户指定）：**只用 facailo.xyz 这一个源**。
// 历史备用源（私有仓库的 raw/jsDelivr、未建的 Gitee）实测恒 404 或不可达，已删除；
// 现改为：自有主源 + 【公有的规则镜像仓库】（jsDelivr/GitHub raw），数据同源、原子部署、无 404 白等。
// ===== v1.2.377：接口名/版本【服务器可改】=====
// 平台接口升版（如 rate.detaillist.get 6.0→7.0、wdj.list.merge.search→新名）时，
// 只需改 anchor-rules.json 的 tb.*Api / ali.*Api 键，**不必发版**。
// worker 读 chrome.storage.local.aisAnchorRulesCache（与面板同一份缓存），同步注入主世界 args。
var __rulesMem = null;
function loadRulesMem() { try { chrome.storage.local.get(['aisAnchorRulesCache'], function (o) { __rulesMem = (o && o.aisAnchorRulesCache) || null; }); } catch (e) {} }
try { loadRulesMem(); chrome.storage.onChanged.addListener(function (ch, area) { if (area === 'local' && ch && ch.aisAnchorRulesCache) loadRulesMem(); }); } catch (e) {}
function rgv(key, def) {
  try {
    var r = __rulesMem && (__rulesMem.rules || __rulesMem);
    var v = r, ks = String(key).split('.');
    for (var i = 0; i < ks.length; i++) { if (v == null) return def; v = v[ks[i]]; }
    return (v === undefined || v === null || v === '') ? def : v;
  } catch (e) { return def; }
}

const RULES_SOURCES = [
  'https://www.facailo.xyz/anchor-rules.json',
  'https://facailo.xyz/anchor-rules.json'   // apex 301 → www，仅作 www 异常时的兜底
];

function broadcastRules(rules) {
  try {
    chrome.tabs.query({}, function (tabs) {
      (tabs || []).forEach(function (t) {
        if (!t || !t.id || !/^https?:/i.test(String(t.url || ''))) return;
        // ① 隔离世界：面板 AisAnchors 就地 merge（v1.2.338）
        try {
          chrome.tabs.sendMessage(t.id, { type: 'aisRulesUpdated', action: 'aisRulesUpdated', rules: rules }, function () { try { void chrome.runtime.lastError; } catch (eLE) {} });
        } catch (e1) {}
        // ② v1.2.403【真热加载】：主世界的 window.__AIS_RULES__ 也要就地刷新，
        //    否则「拦截器用的规则」（SSR 路径/键名/阈值）改完必须刷新页面才生效。
        try {
          chrome.scripting.executeScript({
            target: { tabId: t.id },
            world: 'MAIN',
            args: [rules || {}],
            func: function (r) { try { window.__AIS_RULES__ = r || {}; } catch (e) {} }
          }, function () { try { void chrome.runtime.lastError; } catch (eML) {} });
        } catch (e2) {}
      });
    });
  } catch (e0) {}
}
function selfRefreshRules() {
  try { chrome.runtime.sendMessage({ type: 'aisAnchorRules', action: 'aisAnchorRules' }, function () { try { void chrome.runtime.lastError; } catch (eLE2) {} }); } catch (e2) {}
}
try {
  // v1.2.404：刷新间隔改为【远程可调】common.rulesRefreshMinutes（默认 10，钳制 2~180）。
  // 用途：要紧急下发修复时，服务器先把间隔调成 2 分钟 → 全量用户几分钟内自动拿到新规则，
  // **无需任何用户操作**（不必点「立即更新规则」）。平时可调回 30 降低请求量。
  function __aisAlarmMinutes() {
    var n = 10;
    try { n = Number(rgv('common.rulesRefreshMinutes', 10)) || 10; } catch (eNm) {}
    return Math.max(2, Math.min(180, n));
  }
  function __aisArmRulesAlarm() {
    try { chrome.alarms.create('aisRulesRefresh', { periodInMinutes: __aisAlarmMinutes() }); } catch (eAr) {}
  }
  __aisArmRulesAlarm();
  chrome.alarms.onAlarm.addListener(function (a) { if (a && a.name === 'aisRulesRefresh') selfRefreshRules(); });
  if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(function () { selfRefreshRules(); });
  selfRefreshRules();   // worker 每次唤醒也检查一次（浏览器启动/扩展重载都会走到）
  // 规则缓存变化后重设闹钟——间隔本身也是远程可调的
  try { chrome.storage.onChanged.addListener(function (ch, area) { if (area === 'local' && ch && ch.aisAnchorRulesCache) __aisArmRulesAlarm(); }); } catch (eArm) {}
} catch (eAL) {}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[worker] 收到消息:', request.action, '来自:', sender.tab ? sender.tab.id : 'unknown');
  switch (request.action) {
    case 'aisAnchorRules': {
      // v1.2.257 远程锚点规则：缓存优先（24h TTL），过期刷新。
      // 【重要修复】原两个地址都指向**私有仓库**的 raw / jsdelivr —— 未登录客户端恒 404
      // （实测对照：公开仓库 raw=200、本仓库 raw=404），该通道自 v1.1.172 起**从未真正生效**，
      // 且失败被静默 continue，所以长期无人发现。现以自有站点为主源，并补上成功/失败日志。
      // v1.2.264：支持 force —— 面板「立即检查规则更新」绕过 24h 缓存强制重拉，并回报来源与失败原因。
      (async () => {
        var force = !!(request && request.force);
        var cached = null;
        try { cached = (await chrome.storage.local.get(['aisAnchorRulesCache'])).aisAnchorRulesCache || null; } catch (e0) {}
        var now = Date.now();
        var src = '', err = '', errs = [];
        // v1.2.266：给用户看的原因**不含真实地址**，只写「主源/备用源 + HTTP 状态」；完整 URL 仍打 console 供排查
        var srcLabel = function (idx) { return idx <= 1 ? '主源' : '备用源'; };
        // v1.2.339：TTL 24h → 3h（配合 v1.2.338 的 alarms 每 3h 检查）——服务器改规则后最迟 3h 全量生效
        if (force || !cached || now - (cached.fetchedAt || 0) > 30 * 60000) {   // v1.2.360：TTL 3h → 30min（规则改了要更快到达用户）
          // v1.2.339：源列表（真机实测：GitHub raw / jsdelivr 在国内浏览器【全部不可达】，facailo.xyz 亦常不可达
          // → 客户端长期沿用旧缓存，「只改服务器」看起来失效）。**国内可达源必须放最前**。
          // RULES_SOURCES 定义在文件顶部，便于一处维护。
          var urls2 = RULES_SOURCES;
          for (var ui = 0; ui < urls2.length; ui++) {
            try {
              var ctl2 = new AbortController();
              var tmo2 = setTimeout(function () { try { ctl2.abort(); } catch (eT) {} }, 8000);
              // v1.2.341：加唯一查询串破中间/边缘缓存（服务器未设 Cache-Control，历史 v16 可能来自陈旧缓存）
              var uBust = urls2[ui] + (urls2[ui].indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
              var resp2 = await fetch(uBust, { cache: 'no-store', signal: ctl2.signal });
              clearTimeout(tmo2);
              if (!resp2.ok) { errs.push('HTTP ' + resp2.status + '（' + srcLabel(ui) + '）'); console.log('[电商采集大师] 远程锚点规则源不可用 HTTP ' + resp2.status + '：' + urls2[ui]); continue; }
              var j2 = await resp2.json();
              if (j2 && typeof j2 === 'object' && j2.v) {
                // v1.2.341：版本降级保护——任何源返回的 v 低于本地缓存时【忽略】，避免旧镜像/陈旧缓存把规则“回退”
                if (cached && cached.rules && Number(cached.rules.v) && Number(j2.v) < Number(cached.rules.v)) {
                  errs.push('源版本更低(v' + j2.v + ' < v' + cached.rules.v + ')，已忽略');
                  console.log('[电商采集大师] 忽略低版本规则源 v' + j2.v + '（本地缓存 v' + cached.rules.v + '）');
                  continue;
                }
                cached = { fetchedAt: now, rules: j2, source: urls2[ui] };
                try { await chrome.storage.local.set({ aisAnchorRulesCache: cached }); } catch (e4) {}
                src = urls2[ui]; errs = [];
                console.log('[电商采集大师] 远程锚点规则已获取 v' + j2.v + '（源：' + urls2[ui] + '）');
                try { broadcastRules(j2); } catch (eBR) {}   // v1.2.338：即时广播给所有已打开页面
                break;
              }
              errs.push('响应内容无效（' + srcLabel(ui) + '）');
            } catch (e3) { errs.push('拉取异常（' + srcLabel(ui) + '）'); console.log('[电商采集大师] 远程锚点规则拉取异常：' + urls2[ui] + ' ' + ((e3 && e3.message) || e3)); }
          }
          // v1.2.265：error 只报**主源**（最有可操作性），全部原因放 errors；避免用户误以为是最末尾的 jsdelivr 出问题
          err = errs[0] || '';
          if (!cached) { console.log('[电商采集大师] 远程锚点规则全部源不可用，使用内置默认（页面采集不受影响）'); if (!err) err = '全部源不可用'; }
        }
        try {
          sendResponse({
            ok: true,
            rules: cached ? cached.rules : null,
            fetchedAt: cached ? cached.fetchedAt : 0,
            source: src || (cached && cached.source) || '',
            v: (cached && cached.rules && cached.rules.v) || 0,
            error: err,
            errors: errs,
            stale: !!(cached && err)
          });
        } catch (e5) {}
      })();
      return true;
    }

    case 'trackPlatform':
      // 记录用户正在使用的平台（用于会话保活）
      if (sender.tab && sender.tab.url) {
        try { var u = new URL(sender.tab.url); trackPlatformActivity(u.hostname); } catch(e) {}
      }
      sendResponse({ success: true });
      break;

    case 'scrapeProgress':
      // 转发进度到 popup
      chrome.runtime.sendMessage(request);
      break;

    case 'notifyCollectDone':
      // 采集完成通知（标题/条数由 content script 传入），点通知可聚焦采集 tab
      notify(request.title || '采集完成', request.message || '');
      sendResponse({ success: true });
      break;

    case 'batchComplete':
      // 保存到历史
      chrome.storage.local.get(['aisHistory'], (result) => {
        const history = result.aisHistory || [];
        history.unshift({
          url: request.data?.[0]?.['来源URL'] || '',
          time: new Date().toISOString(),
          count: request.total,
          data: Array.isArray(request.data) ? request.data.slice(0, 100) : [], // 只存前100条到storage(判空防 TypeError)
        });
        if (history.length > 50) history.length = 50;
        chrome.storage.local.set({ aisHistory: history });
      });
      chrome.runtime.sendMessage(request);
      break;

    case 'scheduleTask':
      addSchedule(request);
      sendResponse({ status: 'scheduled' });
      break;

    case 'scheduleMonitorTask':
      addMonitorTask(request.task);
      sendResponse({ status: 'scheduled' });
      break;

    case 'cancelMonitorTask':
      cancelMonitorTask(request.task);
      sendResponse({ status: 'cancelled' });
      break;

    case 'testMonitorWebhook':
      // 测试 Webhook 推送
      (async function() {
        try {
          await sendMonitorWebhook(
            request.webhookType,
            request.webhookUrl,
            '电商采集大师 测试通知',
            '这是一条测试消息，收到说明 Webhook 配置正确',
            {
              taskName: '测试商品',
              url: 'https://example.com',
              fieldName: '价格',
              prevValue: '¥99.00',
              newValue: '¥89.00',
              trend: '下降',
              checkedAt: Date.now()
            }
          );
          sendResponse({ success: true });
        } catch(e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;

    case 'getHistory':
      chrome.storage.local.get(['aisHistory', 'dataHistory'], (result) => {
        sendResponse((result.aisHistory && result.aisHistory.length) ? result.aisHistory : (result.dataHistory || []));
      });
      return true;

    case 'getSettings':
      chrome.storage.local.get(['settings'], (result) => {
        sendResponse(result.settings || {});
      });
      return true;

    case 'saveSettings':
      chrome.storage.local.set({ settings: request.settings });
      sendResponse({ status: 'saved' });
      break;

    case 'downloadImage':
      if (!aisSenderIsPlatformTab(sender)) { sendResponse({ success: false, error: 'invalid sender' }); break; }
      if (request.type === 'review') {
        aisReviewDownloadAllowed().then(function(ok) { if (!ok) sendResponse({ success: false, error: '评论图片下载需要会员授权' }); else aisHandleSingleDownload(request, sendResponse); });
        return true;
      }
      aisHandleSingleDownload(request, sendResponse);
      return true;


    case 'downloadData': {
    if (!aisSenderIsPlatformTab(sender)) { sendResponse({ ok: false, error: 'invalid sender' }); break; } // v1.1.155：导出数据也仅接受受支持平台标签页
    try {
      const du = 'data:' + (request.mime || 'text/csv') + ';base64,' + request.base64;
      chrome.downloads.download({ url: du, filename: request.filename || 'export.csv', saveAs: false }, function (id) {
        void chrome.runtime.lastError;
        sendResponse({ ok: id != null, id: id });
      });
      return true;
    } catch (e) { sendResponse({ ok: false, error: e.message }); return true; }
  }
  case 'fetchDescImages':
      // v1.1.36 图片快采：抓取 descUrl（详情描述 HTML/CDN 文本）并提取图片 URL
      try {
        aisFetchDescImages(request.descUrl, sender && sender.tab && sender.tab.id).then(function(images){
          sendResponse({ ok: true, images: images });
        }).catch(function(e){ sendResponse({ ok: false, error: String(e && e.message || e) }); });
      } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
      return true;

    case 'downloadImages':
      if (!aisSenderIsPlatformTab(sender)) { sendResponse({ ok: false, error: 'invalid sender' }); break; }
      if (sender && sender.tab && sender.tab.id != null) aisDlTabId = sender.tab.id; // v1.2.180 进度回传目标
      // v1.2.176 防盗链：记录发起下载的商品页 origin，供 offscreen 请求 DNR Referer 规则
      try { if (sender && sender.tab && sender.tab.url) request.pageOrigin = new URL(sender.tab.url).origin; } catch (ePage) {}
      if ((request.images || []).some(function(i) { return i && i.type === 'review'; })) {
        aisReviewDownloadAllowed().then(function(ok) { if (!ok) sendResponse({ ok: false, error: '评论图片下载需要会员授权' }); else aisHandleImageDownload(request).then(function(r){ sendResponse(r); }).catch(function(e){ sendResponse({ ok: false, error: String(e && e.message || e) }); }); });
        return true;
      }
      // v1.1.36 图片快采：批量下载（offscreen 抓图/转格式/ZIP 打包）
      console.log('[电商采集大师] 图片快采批量下载:', (request.images || []).length, '张, asZip=', !!request.asZip);
      try {
        aisHandleImageDownload(request).then(function(r){ sendResponse(r); }).catch(function(e){ sendResponse({ ok: false, error: String(e && e.message || e) }); });
      } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
      return true;

    case 'aisDlProgress':
      // v1.2.180：来自 offscreen 的下载进度 → 转发给发起下载的标签页面板
      aisReportToPanel(request);
      sendResponse({ ok: true });
      break;

    case 'longImage':
      // v1.2.179 详情长图：offscreen 逐图抓取→画布纵向拼接→分卷 PNG→逐个落盘
      if (!aisSenderIsPlatformTab(sender)) { sendResponse({ ok: false, error: 'invalid sender' }); break; }
      if (sender && sender.tab && sender.tab.id != null) aisDlTabId = sender.tab.id; // v1.2.180
      try { if (sender && sender.tab && sender.tab.url) request.pageOrigin = new URL(sender.tab.url).origin; } catch (eLI) {}
      try {
        aisHandleLongImage(request).then(function(r){ sendResponse(r); }).catch(function(e){ sendResponse({ ok: false, error: String(e && e.message || e) }); });
      } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
      return true;

    case 'openDownloadFolder':
      // 打开下载所在文件夹
      try {
        var _odf = false, _odfErr = '';
        var _hasDl = (typeof chrome !== 'undefined' && chrome.downloads);
        if (request.id != null && _hasDl && chrome.downloads.show) {
          try { chrome.downloads.show(Number(request.id)); _odf = true; } catch (e) { _odfErr = String(e && e.message || e); }
        }
        // v1.2.416：没有下载记录（id=null）或 show() 失败时，退回「打开浏览器默认下载目录」。
        // 原实现此处直接回「无法打开文件夹」→ 面板按钮点了没反应（用户反馈「点击无效」）。
        if (!_odf && _hasDl && chrome.downloads.showDefaultFolder) {
          try { chrome.downloads.showDefaultFolder(); _odf = true; } catch (e2) { _odfErr = String(e2 && e2.message || e2); }
        }
        if (!_odf) sendResponse({ ok: false, error: _odfErr || '无法打开文件夹' });
        else sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); }
      return true;

    case 'searchDownloads':
      // 查询最近的下载状态，用于诊断
      console.log('[worker] searchDownloads开始查询...');
      try {
        chrome.downloads.search({}, function(items) {
          console.log('[worker] searchDownloads查询完成, 数量:', (items || []).length);
          // 只取最近10个，按id降序
          var sorted = (items || []).sort(function(a, b) { return (b.id || 0) - (a.id || 0); }).slice(0, 10);
          var summary = sorted.map(function(d) {
            return {
              id: d.id,
              filename: d.filename,
              state: d.state,
              exists: d.exists,
              error: d.error
            };
          });
          try {
            sendResponse({success: true, downloads: summary});
            console.log('[worker] searchDownloadssendResponse成功');
          } catch(se) {
            console.error('[worker] searchDownloadssendResponse失败:', se.message);
          }
        });
      } catch(e) {
        console.error('[worker] searchDownloads异常:', e.message);
        sendResponse({success: false, error: e.message});
      }
      return true;


    case 'injectInterceptor':
      // 通过 chrome.scripting.executeScript 在主世界注入拦截器
      // 绕过页面CSP限制（京东等平台CSP阻止inline script）
      // 使用 files 方式注入独立文件（比 func 更可靠，避免序列化问题）
      if (sender.tab) {
        // v1.2.379：先给主世界注入【规则快照】——主世界读不到 AisAnchors（隔离世界才有），
        // 于是 main-world-interceptor 里的 ICE 路径/全局名只能写死，平台改版就得发版。
        // 这里把规则快照挂到 window.__AIS_RULES__，拦截器即可远程可配。
        try {
          // v1.2.403：改为注入【整份】规则（含 v / flags / 其余平台段），此前只挑 5 个段且丢了 v，
          // 导致主世界无法做版本比对，也无法就地热更新（改选择器类规则必须刷新页面才生效）。
          var __snap = null;
          try { __snap = (__rulesMem && (__rulesMem.rules || __rulesMem)) || null; } catch (eSnap) {}
          chrome.scripting.executeScript({
            target: { tabId: sender.tab.id },
            world: 'MAIN',
            args: [__snap || {}],
            func: function (r) { try { window.__AIS_RULES__ = r || {}; } catch (e) {} }
          });
        } catch (eRs) {}
        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          files: ['lib/main-world-interceptor.js']
        }).then(function(results){
          console.log('[worker] 拦截器注入成功(files), tabId:', sender.tab.id);
          sendResponse({ success: true });
        }).catch(function(err){
          console.error('[worker] 拦截器注入失败(files):', err.message, '尝试func方式');
          // files 方式失败时，回退到 func 方式
          chrome.scripting.executeScript({
            target: { tabId: sender.tab.id },
            world: 'MAIN',
            func: mainWorldInterceptorFn
          }).then(function(results){
            console.log('[worker] 拦截器注入成功(func), tabId:', sender.tab.id);
            sendResponse({ success: true });
          }).catch(function(err2){
            console.error('[worker] 拦截器注入失败(func):', err2.message);
            sendResponse({ success: false, error: err2.message });
          });
        });
      } else {
        sendResponse({ success: false, error: 'no sender tab' });
      }
      return true;

    case 'mainWorldPing':
      sendResponse({ success: true, pong: true });
      break;

    case 'mainWorldGetPddRawData':
      // 在页面主世界读取拼多多 H5 SSR JSON（window.rawData）中的商品列表，
      // 隔离世界拿不到主世界变量，必须经主世界脚本桥接
      if (sender.tab) {
        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          func: function() {
            try {
              var raw = window.rawData;
              if (!raw) return { ok: false, error: 'no rawData' };
              var store = raw.stores && raw.stores.store;
              var list = null;
              if (store && store.data) {
                list = store.data.ssrListData && store.data.ssrListData.list;
                if ((!list || !list.length) && store.data.dataMap && store.data.dataMap[0]) {
                  list = store.data.dataMap[0].list;
                }
              }
              if (!list || !list.length) return { ok: false, error: 'no list' };
              return { ok: true, list: list };
            } catch (e) {
              return { ok: false, error: String(e && e.message || e) };
            }
          }
        }).then(function(results) {
          if (results && results[0]) {
            sendResponse({ success: true, result: results[0] });
          } else {
            sendResponse({ success: false, error: 'no result' });
          }
        }).catch(function(err) {
          sendResponse({ success: false, error: err.message });
        });
      } else {
        sendResponse({ success: false, error: 'no tab' });
      }
      return true;

    case 'mainWorldGet1688RawData':
      // v1.1.77：1688 SSR 直读（window.context 主世界变量，隔离世界拿不到，经主世界脚本桥接）
      if (sender.tab) {
        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          func: function() {
            try {
              var ctx = window.context;
              if (!ctx || !ctx.result) return { ok: false, error: 'no context' };
              var model = (ctx.result.global && ctx.result.global.globalData && ctx.result.global.globalData.model) || {};
              var od = model.offerDetail || null;
              var g = (ctx.result.data && ctx.result.data.gallery && ctx.result.data.gallery.fields) || null;
              if (!od && !(g && g.offerImgList)) return { ok: false, error: 'no offerDetail' };
              var out = { ok: true };
              if (od) {
                out.subject = String(od.subject || '');
                out.detailUrl = String(od.detailUrl || '');
                out.imageList = (od.imageList || []).map(function (x) { return String(x && (x.fullPathImageURI || x.imageURI) || ''); }).filter(function (s) { return /^https?:/.test(s); });
                out.skuProps = (od.skuProps || []).map(function (p) { return { prop: String(p && p.prop || ''), value: (p && p.value || []).map(function (v) { return { name: String(v && v.name || ''), imageUrl: String(v && v.imageUrl || '') }; }).filter(function (v) { return v.imageUrl; }) }; });
                if (od.wirelessVideo) { try { var wv = od.wirelessVideo; out.video = String((wv.videoUrl || wv.videoPath || wv.url) || ''); } catch (e2) {} }
              }
              if (g && g.offerImgList) out.offerImgList = g.offerImgList.filter(function (s) { return /^https?:/.test(String(s)); });
              // v1.1.81：商品属性（featureAttributes）+ 包装信息（件重尺）
              try {
                if (od && od.featureAttributes) {
                  out.featureAttrs = (od.featureAttributes || []).map(function (f) {
                    var val = String(f && f.value || '');
                    if (!val && f && f.values && f.values.length) val = f.values.join(',');
                    return { name: String(f && f.name || ''), value: val };
                  }).filter(function (x) { return x.name && x.value; });
                }
                var ppi = (ctx.result.data && ctx.result.data.productPackInfo && ctx.result.data.productPackInfo.fields) || null;
                if (ppi && ppi.unitWeight != null) out.packInfo = { unitWeight: Number(ppi.unitWeight) || 0 };
              } catch (e7) {}
              // v1.1.79：SKU 规格表数据（Root.fields.dataJson.skuModel——价格/库存/规格组合）
              try {
                var dj = (ctx.result.data && ctx.result.data.Root && ctx.result.data.Root.fields && ctx.result.data.Root.fields.dataJson) || null;
                var sm = dj && dj.skuModel;
                if (sm && sm.skuProps) {
                  out.skuModel = {
                    props: (sm.skuProps || []).map(function (p) { return { prop: String(p && p.prop || ''), value: (p && p.value || []).map(function (v) { return { name: String(v && v.name || ''), imageUrl: String(v && v.imageUrl || '') }; }).filter(function (v) { return v.name; }) }; }),
                    infoMap: sm.skuInfoMap || {},
                    infoMapOriginal: sm.skuInfoMapOriginal || {}
                  };
                }
              } catch (e4) {}
              // v1.1.80：内联 SSR 快照兜底（页面运行时可能把 skuModel 的 map 清空，脚本里的原始 JSON 永不失效）
              try {
                var needSku = !out.skuModel || !out.skuModel.infoMap || !Object.keys(out.skuModel.infoMap).length || !out.skuModel.infoMapOriginal || !Object.keys(out.skuModel.infoMapOriginal).length;
                var needProps = !out.skuModel || !out.skuModel.props || !out.skuModel.props.length;
                if (needSku || needProps) {
                  var balGr = function (src, start) {
                    var depth = 0, inStr = false, esc = false;
                    for (var i = start; i < src.length; i++) {
                      var ch = src[i];
                      if (esc) { esc = false; continue; }
                      if (ch === '\\') { esc = true; continue; }
                      if (inStr) { if (ch === '"') inStr = false; continue; }
                      if (ch === '"') { inStr = true; continue; }
                      if (ch === '{' || ch === '[') depth++;
                      else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return src.slice(start, i + 1); }
                    }
                    return '';
                  };
                  var grab = function (st, key) {
                    var kx = st.indexOf('"' + key + '":');
                    if (kx < 0) return null;
                    var vs = kx + key.length + 3;
                    while (vs < st.length && (st[vs] === ' ' || st[vs] === '\\n' || st[vs] === '\\r' || st[vs] === '\\t')) vs++;
                    if (st[vs] !== '{' && st[vs] !== '[') return null;
                    var raw = balGr(st, vs);
                    if (!raw) return null;
                    try { return JSON.parse(raw); } catch (e5x) { return null; }
                  };
                  for (var si = 0; si < document.scripts.length && (needSku || needProps); si++) {
                    var st = document.scripts[si].textContent || '';
                    if (st.length < 2000 || st.indexOf('skuInfoMap') < 0) continue;
                    if (needSku) {
                      var m1 = grab(st, 'skuInfoMap'), m2 = grab(st, 'skuInfoMapOriginal');
                      if (m1 || m2) {
                        out.skuModel = out.skuModel || { props: [], infoMap: {}, infoMapOriginal: {} };
                        if (m1 && (!out.skuModel.infoMap || !Object.keys(out.skuModel.infoMap).length)) out.skuModel.infoMap = m1;
                        if (m2 && (!out.skuModel.infoMapOriginal || !Object.keys(out.skuModel.infoMapOriginal).length)) out.skuModel.infoMapOriginal = m2;
                        needSku = !((out.skuModel.infoMap && Object.keys(out.skuModel.infoMap).length) || (out.skuModel.infoMapOriginal && Object.keys(out.skuModel.infoMapOriginal).length));
                      }
                    }
                    if (needProps && (!out.skuModel || !out.skuModel.props || !out.skuModel.props.length)) {
                      var ps = grab(st, 'skuProps');
                      if (ps && ps.length) {
                        out.skuModel = out.skuModel || { props: [], infoMap: {}, infoMapOriginal: {} };
                        out.skuModel.props = ps.map(function (p) { return { prop: String(p && p.prop || ''), value: (p && p.value || []).map(function (v) { return { name: String(v && v.name || ''), imageUrl: String(v && v.imageUrl || '') }; }).filter(function (v) { return v.name; }) }; });
                        needProps = false;
                      }
                    }
                  }
                }
              } catch (e6) {}
              return out;
            } catch (e) {
              return { ok: false, error: String(e && e.message || e) };
            }
          }
        }).then(function(results) {
          if (results && results[0] && results[0].result && results[0].result.ok) {
            sendResponse({ success: true, result: results[0].result });
          } else {
            sendResponse({ success: false, error: (results && results[0] && results[0].result && results[0].result.error) || 'no result' });
          }
        }).catch(function(err) {
          sendResponse({ success: false, error: err.message });
        });
      } else {
        sendResponse({ success: false, error: 'no tab' });
      }
      return true;

    case 'openPddCommentsTab':
      // v1.2.208：评论页必须【前台】打开——PDD 增量加载靠 IntersectionObserver，后台标签页无渲染帧
      // → IO 永不触发 → 页面不翻页（v1.2.199-207 只采到首屏 ~20 条的根因）。读完自动切回商品页（零刷新）。
      try {
        var _pddOpener0 = sender && sender.tab ? sender.tab.id : 0;
        chrome.tabs.create({ url: 'https://mobile.yangkeduo.com/goods_comments.html?goods_id=' + encodeURIComponent(String(request.goodsId || '')), active: true }, function (t) {
          if (t && t.id) __pddCmtOpeners[t.id] = _pddOpener0;
          sendResponse({ ok: !!t, tabId: t && t.id });
        });
      } catch (eOptPdd) { sendResponse({ ok: false, error: String(eOptPdd && eOptPdd.message || eOptPdd) }); }
      return true;

    case 'closePddCommentsTab':
      // v1.2.208：activate:true 先把焦点切回原商品页（不刷新），再关评论页
      try {
        var _pddCid = parseInt(request.tabId, 10) || 0;
        var _pddOpener = __pddCmtOpeners[_pddCid];
        delete __pddCmtOpeners[_pddCid];
        if (request.activate && _pddOpener) {
          chrome.tabs.update(_pddOpener, { active: true }, function () {
            try { chrome.tabs.remove(_pddCid, function () {}); } catch (eRmPdd) {}
          });
        } else {
          chrome.tabs.remove(_pddCid, function () {});
        }
      } catch (eClsPdd) {}
      sendResponse({ ok: true });
      return false;

    case 'mainWorldPddCommentsStart': {
      // v1.2.208 重设计：页内自驱滚动循环（前台 MAIN world，定时器零节流；SW 立即返回零长任务，
      // 彻底摆脱消息通道依赖）。面板按轮 Poll 增量。风控：零点击零构造请求、翻页由页面自身
      // IO 触发、人类化间隔 1.1-1.9s、110s 硬顶/停滞 6 拍止损、可随时 Stop。
      var tidPddS = request.tabId ? parseInt(request.tabId, 10) : (sender.tab && sender.tab.id);
      if (!tidPddS) { sendResponse({ success: false, error: 'no tab' }); return false; }
      chrome.scripting.executeScript({
        target: { tabId: tidPddS },
        world: 'MAIN',
        args: [{ maxRows: parseInt(request.maxRows, 10) || 0 }],
        func: function (a) {
          try {
            if (!window.rawData || !window.rawData.store || !window.rawData.store.commentsList) return { ok: false, error: 'store-not-ready' };
            var C0 = window.__PDD_CMT_COLLECT__;
            if (C0 && C0.running) return { ok: true, already: true };
            var seen = {}, list = [], storeIdx = {};
            var normTxt = function (s) { return String(s || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, ''); };
            var txtKey = function (row) {
              var c = normTxt(row.content);
              return c.slice(0, 80) + '~' + c.slice(-40) + '|' + String(row.time || '');
            };
            var pickImg = function (p) {
              var u = '';
              if (typeof p === 'string') u = p;
              else if (p && typeof p === 'object') u = p.url || p.masterPic || p.big || p.pictureUrl || p.imgUrl || '';
              u = String(u || '');
              if (u.indexOf('//') === 0) u = 'https:' + u;
              return /^https?:/.test(u) ? u : '';
            };
            var push = function (row) {
              if (!row.reviewId) {
                row.reviewId = storeIdx[txtKey(row)] || '';
                if (!row.reviewId) {
                  var hc = normTxt(row.content), h = 5381;
                  for (var q0 = 0; q0 < hc.length; q0++) h = ((h * 33) ^ hc.charCodeAt(q0)) >>> 0;
                  row.reviewId = 'dh' + h.toString(36) + '|' + (row.time || '');
                }
              } else {
                storeIdx[txtKey(row)] = row.reviewId;
              }
              var k = 'ID:' + row.reviewId;
              if (seen[k]) return;
              seen[k] = 1; list.push(row);
            };
            var st = function () { try { return window.rawData && window.rawData.store; } catch (e) { return null; } };
var readStore = function () {
              try {
                (st().commentsList || []).forEach(function (c) {
                  var id = String(c.reviewId || c.key || '');
                  // v1.2.223：图字段名防漂移——pictures 优先，取不到就扫任意 /pic|img|image/ 数组键（PDD 各模板键名不一）
                  var picsOf = function (c0, pref) {
                    var arr0 = c0[pref];
                    if (Array.isArray(arr0) && arr0.length) return arr0;
                    for (var kk in c0) { try { if (/pic|img|image/i.test(kk) && Array.isArray(c0[kk]) && c0[kk].length) { arr0 = c0[kk]; break; } } catch (eK) {} }
                    return arr0 || [];
                  };
                  var imgs = picsOf(c, 'pictures').map(pickImg).filter(Boolean);
                  var apImgs = picsOf(c, 'additionalPicAndVideo').map(pickImg).filter(Boolean);
                  var appendContent = (c.hasAdditionalComment && c.additionalComment && String(c.additionalComment).indexOf('未填写') < 0) ? String(c.additionalComment) : '';
                  push({
                    reviewId: id,
                    content: String(c.comment || ''),
                    rating: parseInt(c.stars, 10) || 0,
                    username: String(c.name || '') + (parseInt(c.anonymous, 10) === 1 ? '（匿名）' : ''),
                    skuInfo: String(c.orderSpecsString || ''),
                    time: String(c.time || ''),
                    hasImage: imgs.length > 0 || apImgs.length > 0,
                    images: imgs,
                    appendImages: apImgs,
                    isAppend: !!appendContent,
                    appendContent: appendContent,
                    replyCount: parseInt(c.replyCount, 10) || 0
                  });
                });
              } catch (eR) {}
            };
            var readDom = function () {
              try {
                var lst = document.querySelector('.pdd-list-container');
                if (!lst) return;
                Array.prototype.forEach.call(lst.children, function (card) {
                  try {
                    if (!card || card.nodeType !== 1) return;
                    var txts = [];
                    var ns2 = card.querySelectorAll('div,span,p');
                    for (var q = 0; q < ns2.length; q++) {
                      if (ns2[q].children.length) continue;
                      var t2 = (ns2[q].textContent || '').trim();
                      if (t2 && t2.length > 1 && txts.indexOf(t2) < 0) txts.push(t2);
                    }
                    if (txts.length < 2) return;
                    // v1.2.202：短评兼容（如「欺骗我感情」5字也算正文）+ 动作标签过滤
                    var LAB = { '赞': 1, '评论': 1, '回复': 1, '举报': 1, '收起': 1, '查看全部': 1, '已评价': 1 };
                    var content = '', name = '', time = '', sku = '';
                    for (var w = 0; w < txts.length; w++) {
                      var t3 = txts[w];
                      if (LAB[t3]) continue;
                      if (/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(t3)) { if (!time) time = t3; continue; }
                      if (!sku && /^\S{1,8}[：:]/.test(t3) && t3.length < 40) { sku = t3; continue; }
                      if (t3.length > content.length && t3.length >= 2 && !/^\d+$/.test(t3)) content = t3;
                    }
                    if (!content) return;
                    for (var w2 = 0; w2 < txts.length; w2++) {
                      var t4 = txts[w2];
                      if (t4 === content || t4 === time || t4 === sku || LAB[t4]) continue;
                      if (!name && t4.length >= 2 && t4.length <= 12 && !/^\d+$/.test(t4) && !/[\u00a5\uffe5]/.test(t4)) { name = t4; break; }
                    }
                    var imgs = [];
                    var im2s = card.querySelectorAll('img');
                    for (var y = 0; y < im2s.length; y++) {
                      var im2 = im2s[y];
                      var u2 = im2.currentSrc || im2.src || im2.getAttribute('data-src') || im2.getAttribute('data-actualsrc') || '';
                      if (u2.indexOf('pddpic') < 0) continue;
                      var rc2 = im2.getBoundingClientRect();
                      if (rc2.width < 80 || rc2.height < 80) continue; // 排除头像（约40px小图）
                      u2 = u2.split('?')[0];
                      if (imgs.indexOf(u2) < 0) imgs.push(u2);
                    }
                    push({ reviewId: '', content: content, rating: 0, username: name, skuInfo: sku, time: time, hasImage: imgs.length > 0, images: imgs, isAppend: false, appendContent: '', replyCount: 0 });
                  } catch (eC) {}
                });
              } catch (eL) {}
            };
            var C = window.__PDD_CMT_COLLECT__ = { running: true, done: false, stopped: false, rows: list, cursor: 0, total: 0, reason: '', goodsId: '', grand: 0, t0: Date.now() };
            var lastDom = -1, domSame = 0, pokeCount = 0, flagStuck = 0;
            // v1.2.209：IO「已相交不再触发」死锁破解——上滚 700px 再回底，强制哨兵产生 不相交→相交 跃变
            var poke = function () {
              try { window.scrollTo(0, Math.max(0, (document.documentElement.scrollHeight || 0) - 1600)); } catch (eP1) {}
              setTimeout(function () { try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (eP2) {} }, 450);
              setTimeout(function () { try { window.scrollTo(0, Math.max(0, (document.documentElement.scrollHeight || 0) - 900)); } catch (eP3) {} }, 1000);
              setTimeout(function () { try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (eP4) {} }, 1450);
            };
            var finish = function (why) {
              C.running = false; C.done = true; C.reason = why; C.total = list.length;
            };
            var tick = function () {
              try {
                if (C.stopped) { finish('stopped'); return; }
                var s = st();
                if (!s || !s.commentsList) { finish('page-gone'); return; }
                C.goodsId = String(s.goodsId || '');
                var before = list.length;
                readStore(); readDom();
                C.total = list.length;
                var grand = 0;
                try { grand = parseInt((s.goodsCommentInfo && s.goodsCommentInfo.number) || 0, 10) || 0; } catch (eG) {}
                if (grand > 0 && grand < 1000000) C.grand = grand;
                if (a.maxRows > 0 && list.length >= a.maxRows) { finish('capped'); return; }
                // v1.2.209：页面自带评论总数为准——没到总数不早收工（40/50 卡第 3 页的判据缺口）
                if (C.grand > 0 && list.length >= C.grand) { finish('nomore'); return; }
                var domN = 0;
                try { var lc = document.querySelector('.pdd-list-container'); domN = lc ? lc.children.length : 0; } catch (eD) {}
                domSame = (domN === lastDom) ? domSame + 1 : 0; lastDom = domN;
                var flag = !!(s.noMoreComments);
                C.diag = { domN: domN, storeLen: (s.commentsList || []).length, pn: s.pageNumber, flag: flag, grand: C.grand, rows: list.length, poke: pokeCount + flagStuck };
                if (list.length > before) { flagStuck = 0; }
                // v1.2.211：noMore 标志与页面总数矛盾时不再早杀——flag=true 但 grand 未达 → 戳步追问，
                // 连续 6 拍确实无新行才认「页面只给这么多」（nomore-flagged，诊断照实上报）
                if (flag && list.length === before && domSame >= 2) {
                  if (!C.grand || list.length >= C.grand) { finish('nomore'); return; }
                  flagStuck++;
                  if (flagStuck >= 6) { finish('nomore-flagged'); return; }
                  poke();
                }
                if (Date.now() - C.t0 > 150000) { finish('timeout'); return; }
                if (domSame >= 4 && list.length === before) {
                  pokeCount++;
                  if (pokeCount >= 4) { finish(flag ? 'nomore' : 'stalled'); return; }
                  poke();
                } else if (list.length > before) { pokeCount = 0; }
                try { window.scrollTo(0, document.documentElement.scrollHeight); } catch (eSc) {}
                setTimeout(tick, 1100 + Math.floor(Math.random() * 800));
              } catch (eT) { finish('error:' + (eT && eT.message || eT)); }
            };
            readStore(); readDom(); C.total = list.length;
            setTimeout(tick, 700);
            return { ok: true };
          } catch (eS) { return { ok: false, error: String(eS && eS.message || eS) }; }
        }
      }).then(function (rs) {
        var r0 = rs && rs[0] && rs[0].result;
        sendResponse(r0 && r0.ok ? { success: true, already: !!r0.already } : { success: false, error: (r0 && r0.error) || 'inject failed' });
      }).catch(function (err) { sendResponse({ success: false, error: String(err && err.message || err) }); });
      return true;
    }

    case 'mainWorldPddCommentsPoll': {
      // v1.2.208：取页内循环的增量行（游标式，面板是唯一读者）；短调用 <100ms，SW 安全
      var tidPddP = request.tabId ? parseInt(request.tabId, 10) : (sender.tab && sender.tab.id);
      if (!tidPddP) { sendResponse({ success: false, error: 'no tab' }); return false; }
      chrome.scripting.executeScript({
        target: { tabId: tidPddP },
        world: 'MAIN',
        func: function () {
          try {
            var C = window.__PDD_CMT_COLLECT__;
            if (!C) return { ok: false, error: 'not-started' };
            var out = C.rows.slice(C.cursor);
            C.cursor = C.rows.length;
            return { ok: true, rows: out, total: C.total || C.rows.length, done: !!C.done, reason: C.reason || '', goodsId: C.goodsId || '', grand: C.grand || 0, diag: C.diag || null };
          } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        }
      }).then(function (rs) {
        var r0 = rs && rs[0] && rs[0].result;
        sendResponse(r0 && r0.ok ? { success: true, rows: r0.rows, total: r0.total, done: r0.done, reason: r0.reason, goodsId: r0.goodsId, grand: r0.grand, diag: r0.diag } : { success: false, error: (r0 && r0.error) || 'no result' });
      }).catch(function (err) { sendResponse({ success: false, error: String(err && err.message || err) }); });
      return true;
    }

    case 'mainWorldPddCommentsStop': {
      // v1.2.208：用户点「停止采集」→ 页内循环下一拍体面退出（立刻止滚，不留狂滚尾巴）
      var tidPddQ = request.tabId ? parseInt(request.tabId, 10) : (sender.tab && sender.tab.id);
      if (tidPddQ) {
        chrome.scripting.executeScript({
          target: { tabId: tidPddQ },
          world: 'MAIN',
          func: function () { try { var C = window.__PDD_CMT_COLLECT__; if (C) { C.stopped = true; if (!C.rows) C.rows = []; } return { ok: true }; } catch (e) { return { ok: false }; } }
        }, function () { sendResponse({ ok: true }); });
        return true;
      }
      sendResponse({ ok: true });
      return false;
    }

    case 'mainWorldPddGallery': {
      // v1.2.221：拼多多主图校准——仅读官方轮播清单 topGallery（SSR rawData 下 store.initDataObj.goods，
      // 页面本地内存读取，零点击零新请求）。SPA 模板读不到就直接返回空（静默）；SKU 采集已按用户要求移除。
      var tidGal = request.tabId ? parseInt(request.tabId, 10) : (sender.tab && sender.tab.id);
      if (!tidGal) { sendResponse({ success: false }); return false; }
      chrome.scripting.executeScript({
        target: { tabId: tidGal },
        world: 'MAIN',
        func: function () {
          try {
            var g = (((window.rawData || {}).store || {}).initDataObj || {}).goods || {};
            var gal = g.topGallery || g.gallery || [];
            var out = [];
            for (var i = 0; i < gal.length; i++) { var u = String(gal[i] || ''); if (u && out.indexOf(u) < 0) out.push(u); }
            return { ok: true, gallery: out };
          } catch (e) { return { ok: false, gallery: [] }; }
        }
      }, function (rs) {
        var r0 = rs && rs[0] && rs[0].result;
        sendResponse(r0 && r0.ok && r0.gallery && r0.gallery.length ? { success: true, gallery: r0.gallery } : { success: false, gallery: [] });
      });
      return true;
    }

    case 'mainWorld1688Rates':
      // v1.1.82：1688 评论 mtop 分页（主世界 lib.mtop 直调，页面自带签名；零点击零滚动）
      if (sender.tab) {
        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          args: [{ api: rgv('ali.rateApi', 'mtop.1688.trade.service.MtopRateService.queryItemRatedListV2'), apiV: rgv('ali.rateApiV', '1.0'), offerId: String(request.offerId || ''), page: parseInt(request.page, 10) || 1 }],
          func: async function (a) {
            try {
              if (!window.lib || !window.lib.mtop) return { ok: false, error: 'no lib.mtop' };
              var loginId = '';
              try {
                var ctx = window.context;
                var dj = ctx && ctx.result && ctx.result.data && ctx.result.data.Root && ctx.result.data.Root.fields && ctx.result.data.Root.fields.dataJson;
                loginId = (dj && dj.offerBaseInfo && dj.offerBaseInfo.sellerLoginId) || '';
              } catch (e0) {}
              if (!loginId) { try { var s2 = JSON.stringify(window.context || {}); var m2 = s2.match(/"sellerLoginId":"([^"]+)"/); loginId = m2 ? m2[1] : ''; } catch (e0b) {} }
              var r = await window.lib.mtop.request({
                api: (a && a.api) || 'mtop.1688.trade.service.MtopRateService.queryItemRatedListV2',
                v: (a && a.apiV) || '1.0',
                data: { scene: 'item', itemId: a.offerId, page: a.page, loginId: loginId, site: '1688MixTb' },
                type: 'POST', dataType: 'json', timeout: 9000
              });
              var model = (r && r.data && r.data.model) || [];
              var systemCount = 0; // v1.2.241：系统默认好评「不过滤」——照收，只打标计数，供面板分别展示
              var rows = [];
              model.forEach(function (m) {
                var imgs = m.imageList || m.posterImgList || m.images || [];
                if (!Array.isArray(imgs)) imgs = [];
                var _isSys = !!(m.isSystemRemark || m.systemRemark);
                if (_isSys) systemCount++;
                // v1.1.83/85：specInfo 解码——#7C 拆多规格组，「颜色#3B黑色【长袖】#3A尺码#3BXL」→「颜色：黑色【长袖】；尺码：XL」
                var specStr = String(m.specInfo || '');
                if (specStr) {
                  try {
                    var decPair = function (pair) {
                      var pp = pair.split('#3B');
                      return pp.length > 1 ? pp[0] + '：' + pp.slice(1).join('：') : pair;
                    };
                    specStr = specStr.split('#7C').map(function (grp) { return grp.split('#3A').map(decPair).join('；'); }).join('；');
                  } catch (eS) {}
                }
                rows.push({
                  reviewId: m.id != null ? String(m.id) : '',
                  content: String(m.content || ''),
                  isSystem: _isSys, // v1.2.240：供面板/导出识别系统默认好评
                  feedback: String(m.feedBackAddress || ''),
                  rating: parseInt(m.starLevel, 10) || 0,
                  username: String(m.raterUserNick || m.ratedUserNick || ''),
                  skuInfo: specStr,
                  time: String(m.gmtCreate || ''),
                  hasImage: imgs.length > 0,
                  // v1.1.123：协议相对补全（同淘宝映射）
                  images: imgs.map(function (u) { u = String(u || ''); return u.indexOf('//') === 0 ? 'https:' + u : u; }).filter(function (u) { return /^https?:/.test(u); }),
                  isAppend: false, appendContent: ''
                });
              });
              return { ok: true, rows: rows, systemCount: systemCount };
            } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
          }
        }).then(function (results) {
          var res0 = results && results[0] && results[0].result;
          if (res0 && res0.ok) sendResponse({ success: true, rows: res0.rows, systemCount: res0.systemCount || 0 });
          else sendResponse({ success: false, error: (res0 && res0.error) || 'no result' });
        }).catch(function (err) { sendResponse({ success: false, error: err.message }); });
      } else sendResponse({ success: false, error: 'no tab' });
      return true;

    case 'mainWorld1688RateSummary':
      // v1.2.240：1688 评价统计（页面本身用的 DSR 汇总：全部/有内容/有图/好评/中评/差评）——用于给用户一个真实分母
      if (sender.tab) {
        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          args: [{ api: rgv('ali.dsrApi', 'mtop.1688.trade.service.MtopRateService.queryDsrRateDataV2'), apiV: rgv('ali.dsrApiV', '1.0'), offerId: String(request.offerId || ''), loginId: String(request.loginId || '') }],
          func: async function (a) {
            try {
              if (!window.lib || !window.lib.mtop) return { ok: false, error: 'no lib.mtop' };
              var loginId = a.loginId || '';
              if (!loginId) { try { var s2 = JSON.stringify(window.context || {}); var m2 = s2.match(/"sellerLoginId":"([^"]+)"/); loginId = m2 ? m2[1] : ''; } catch (e0) {} }
              var r = await window.lib.mtop.request({
                api: (a && a.api) || 'mtop.1688.trade.service.MtopRateService.queryDsrRateDataV2',
                v: (a && a.apiV) || '1.0',
                data: { loginId: loginId, scene: 'item', offerId: Number(a.offerId), site: null },
                type: 'POST', dataType: 'json', timeout: 9000
              });
              var mm = r && r.data && r.data.model;
              if (!mm) return { ok: false, error: 'no model' };
              var tags = (mm.commonTagNodeList || []).map(function (t) { return { name: String(t.name || ''), count: Number(t.count) || 0 }; });
              return { ok: true, goodRates: mm.goodRates, systemRemarkCnt: mm.systemRemarkCnt, tags: tags };
            } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
          }
        }).then(function (results) {
          var r0 = results && results[0] && results[0].result;
          if (r0 && r0.ok) sendResponse({ success: true, goodRates: r0.goodRates, systemRemarkCnt: r0.systemRemarkCnt, tags: r0.tags });
          else sendResponse({ success: false, error: (r0 && r0.error) || 'no result' });
        }).catch(function (err) { sendResponse({ success: false, error: err.message }); });
      } else sendResponse({ success: false, error: 'no tab' });
      return true;

    case 'mainWorldTaobaoDesc':
      // v1.2.321：淘宝/天猫详情图 mtop 直拉（主世界 lib.mtop 调 detail.getdesc，页面自带签名）
      // 背景（真机实测）：详情图原有四通道**全断** ——
      //   ① 拦截器 `descResponse` 实测为 null（不再命中 getdesc/desc）
      //   ② 捕获的 detail 响应仅 856 字节、imgs=0
      //   ③ DOM 兜底只拿页内直出的图（实测某商品仅 1 张，详情在 iframe/H5 壳页）
      //   ④ itemDesc.htm 端点实测 **HTTP 204**（淘宝已废弃）
      // ⇒ 唯一还活着的源是页面自己的 mtop 详情接口 → 主世界直调。
      if (sender.tab) {
        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          args: [{ api: rgv('tb.descApi', 'mtop.taobao.detail.getdesc'), apiV: rgv('tb.descApiV', '6.0'), itemId: String(request.itemId || '') }],
          func: async function (a) {
            try {
              if (!window.lib || !window.lib.mtop) return { ok: false, error: 'no lib.mtop' };
              var r = await window.lib.mtop.request({
                api: (a && a.api) || 'mtop.taobao.detail.getdesc', v: (a && a.apiV) || '6.0',
                data: { id: a.itemId },
                type: 'GET', dataType: 'jsonp', timeout: 15000
              });
              var s = '';
              try { s = JSON.stringify((r && r.data) || {}); } catch (eS) { s = ''; }
              return { ok: true, len: s.length, data: s };
            } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
          }
        }).then(function (results) {
          var r0 = results && results[0] && results[0].result;
          if (r0 && r0.ok) sendResponse({ ok: true, len: r0.len, data: r0.data });
          else sendResponse({ ok: false, error: (r0 && r0.error) || 'no result' });
        }).catch(function (err) { sendResponse({ ok: false, error: err.message }); });
      } else sendResponse({ ok: false, error: 'no tab' });
      return true;

    case 'mainWorldTaobaoRates':
      // v1.1.90：淘宝评论 mtop 直拉（主世界 lib.mtop 调 detaillist.get 6.0，页面零滚动）
      if (sender.tab) {
        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          args: [{ api: rgv('tb.rateApi', 'mtop.taobao.rate.detaillist.get'), apiV: rgv('tb.rateApiV', '6.0'), pageSize: rgv('tb.ratePageSize', 20), itemId: String(request.itemId || ''), page: parseInt(request.page, 10) || 1 }],
          func: async function (a) {
            try {
              if (!window.lib || !window.lib.mtop) return { ok: false, error: 'no lib.mtop' };
              var r = await window.lib.mtop.request({
                api: (a && a.api) || 'mtop.taobao.rate.detaillist.get', v: (a && a.apiV) || '6.0',
                // v1.2.304：实测 currentPage 被接口无视（v1.1.111 的 8 变体恒同页结论仍成立），而 pageNo 能真正翻页（真机 12 页/219 条/500 total）→ 改用它
data: { auctionNumId: a.itemId, rateType: '', pageNo: a.page, pageSize: (a && a.pageSize) || 20, fold: 1 },   // v1.2.382：pageSize 远程可调
                type: 'GET', dataType: 'jsonp', timeout: 15000
              });
              var d = (r && r.data) || {};
              var model = d.rateList || [];
              var rows = model.map(function (m) {
                var imgs = m.feedPicPathList || m.feedPicList || m.images || m.picUrls || [];
                if (!Array.isArray(imgs)) imgs = [];
                var ap = m.appendedFeed || null;
                var apC = ap ? String(ap.feedback || ap.content || '') : '';
                var rt = parseInt(m.rateType, 10);
                var rating = rt === 1 ? 5 : (rt === 0 ? 3 : (rt === -1 ? 1 : 0)); // v1.2.304 实测真实语义：1=好评(5星) 0=中评(3星) -1=差评(1星) -2=系统占位(15天内未评价,记0星)
var isSys = rt === -2;
                return {
                  reviewId: m.id != null ? String(m.id) : '',
                  content: String(m.feedback || m.content || ''),
                  rating: rating,
                  username: String(m.userNick || m.reduceUserNick || ''),
                  skuInfo: String(m.skuValueStr || ''),
                  time: String(m.feedbackDate || m.createTime || ''),
                  hasImage: imgs.length > 0,
                  // v1.1.123：feedPicPathList 是 //img.alicdn.com/... 协议相对——先补 https 再过滤（原过滤器把全部晒图滤光，实时明细无图）
                  images: imgs.map(function (u) { u = typeof u === 'string' ? u : String((u && (u.url || u.src)) || ''); return u.indexOf('//') === 0 ? 'https:' + u : u; }).filter(function (u) { return /^https?:/.test(u); }),
                  isAppend: false, appendContent: apC,
                  isSystem: isSys // v1.2.304：系统占位评价标记（面板 analyze 会按 PLACEHOLDER_RE 剔除）
                };
              });
              return { ok: true, rows: rows, total: parseInt(d.total, 10) || 0, totalPage: parseInt(d.totalPage, 10) || 0, hasNext: String(d.hasNext) !== 'false' };
            } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
          }
        }).then(function (results) {
          var res0 = results && results[0] && results[0].result;
          if (res0 && res0.ok) sendResponse({ success: true, rows: res0.rows, total: res0.total, totalPage: res0.totalPage, hasNext: res0.hasNext });
          else sendResponse({ success: false, error: (res0 && res0.error) || 'no result' });
        }).catch(function (err) { sendResponse({ success: false, error: err.message }); });
      } else sendResponse({ success: false, error: 'no tab' });
      return true;

    case 'mainWorldTaobaoWdj':
      // v1.2.224：淘宝/天猫「问大家」问答 mtop 分页直拉（主世界 lib.mtop，页面自带签名；零滚动零点击）。
      // 详情页自身用 JSONP(script) 发 mtop.taobao.wdj.list.merge.search，fetch/XHR 拦截器抓不到 → 复用页面 SDK 主动调用。
      // userId=卖家id：优先从页面自身已发出的 wdj 请求 data 参数里原样取回，其次 SSR 上下文 user_id，再兜底不带。
      if (sender.tab) {
        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          args: [{ api: rgv('tb.wdjApi', 'mtop.taobao.wdj.list.merge.search'), apiV: rgv('tb.wdjApiV', '1.0'), itemId: String(request.itemId || ''), page: parseInt(request.page, 10) || 1, pageSize: parseInt(request.pageSize, 10) || 10 }],
          func: async function (a) {
            try {
              if (!window.lib || !window.lib.mtop) return { ok: false, error: 'no lib.mtop' };
              var itemId = String(a.itemId || '');
              var sellerId = '';
              try {
                var ents = (typeof performance !== 'undefined' && performance.getEntriesByType) ? (performance.getEntriesByType('resource') || []) : [];
                for (var ei = 0; ei < ents.length && !sellerId; ei++) {
                  var eu = String((ents[ei] && ents[ei].name) || '');
                  if (eu.indexOf('wdj') < 0 || eu.indexOf('data=') < 0) continue;
                  var qs = eu.split('?')[1] || '';
                  var ps = qs.split('&');
                  for (var pi = 0; pi < ps.length; pi++) {
                    if (ps[pi].indexOf('data=') !== 0) continue;
                    try {
                      var pd = JSON.parse(decodeURIComponent(ps[pi].slice(5)));
                      if (pd && pd.userId) sellerId = String(pd.userId);
                      if (pd && pd.itemId && !itemId) itemId = String(pd.itemId);
                    } catch (ePd) {}
                  }
                }
              } catch (ePerf) {}
              if (!sellerId) {
                try {
                  var s2 = JSON.stringify(window.__ICE_APP_CONTEXT__ || window.context || {});
                  var m2 = s2.match(/"user_id":"?(\d{4,20})"?/);
                  if (m2) sellerId = m2[1];
                } catch (eIce) {}
              }
              var clean = function (t) { return String(t == null ? '' : t).replace(/\s*[\r\n]+\s*/g, ' ').trim(); };
              // 回答的 gmtCreate 是 13 位毫秒戳，问题却是格式化字符串 → 统一成 'YYYY-MM-DD HH:mm:ss' 再导出
              var fmtTs = function (t) {
                var s = String(t == null ? '' : t).trim();
                if (!/^\d{13}$/.test(s)) return s;
                try {
                  var d = new Date(parseInt(s, 10)); var p = function (n) { return (n < 10 ? '0' : '') + n; };
                  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
                } catch (eTs) { return s; }
              };
              var skuOf = function (f) {
                var s = String((f && f.sku_v2) || '');
                if (!s) return '';
                var seg = s.split('|');
                if (seg.length > 1) seg = seg.slice(1);
                return clean(seg.join(' ')).replace(/:/g, '：');
              };
              var buildData = function (withUid) {
                var d = { itemId: itemId, pageSize: a.pageSize || 10, page: a.page || 1, type: 'mix_group', tagId: '', extraInfo: JSON.stringify({ searchText: '' }), ecode: 0, biz: 'pc' };
                if (withUid && sellerId) d.userId = Number(sellerId);
                return d;
              };
              var callOnce = function (withUid) {
                return window.lib.mtop.request({ api: (a && a.api) || 'mtop.taobao.wdj.list.merge.search', v: (a && a.apiV) || '1.0', data: buildData(withUid), type: 'GET', dataType: 'json', timeout: 15000 });
              };
              var r = null, err1 = '';
              try { r = await callOnce(!!sellerId); }
              catch (eA) {
                err1 = String((eA && (eA.message || eA.retMsg)) || eA);
                if (sellerId) { try { r = await callOnce(false); sellerId = ''; } catch (eB) { return { ok: false, error: err1 + ' | ' + String((eB && (eB.message || eB.retMsg)) || eB) }; } }
                else return { ok: false, error: err1 };
              }
              var d = (r && r.data) || {};
              var retArr = (r && r.ret) || [];
              var retStr = String(retArr.join ? retArr.join(',') : retArr);
              var list = d.questionList || [];
              if (!list.length) {
                if (/FAIL|ERROR|TOKEN/i.test(retStr)) return { ok: false, error: retStr.slice(0, 140) };
                return { ok: true, rows: [], total: parseInt(d.questionTotal, 10) || 0, hasNext: false };
              }
              var rows = list.map(function (q) {
                var f = q.features || {};
                var ans = (q.topAnswerList || []).map(function (an) {
                  var af = an.features || {}; var uu = an.answerUserInfo || {};
                  var tg = (uu.userTags || []).map(function (t) { return String((t && t.text) || ''); }).filter(Boolean).join('/');
                  return {
                    answerId: an.answerId != null ? String(an.answerId) : '',
                    content: clean(an.answerTitle),
                    userTags: tg,
                    time: fmtTs(an.gmtCreate || an.createTime || ''),
                    ipLocation: String(af.ip_location || ''),
                    skuInfo: skuOf(af)
                  };
                });
                return {
                  questionId: q.questionId != null ? String(q.questionId) : '',
                  content: clean(q.questionTitle),
                  time: String(q.gmtCreate || q.createTime || ''),
                  answerCount: parseInt(q.answerCount, 10) || ans.length || 0,
                  itemId: String(q.itemId || f.ref_id || itemId || ''),
                  ipLocation: String(f.ip_location || ''),
                  sellerId: String(f.seller_id || sellerId || ''),
                  answers: ans
                };
              });
              return { ok: true, rows: rows, total: parseInt(d.questionTotal, 10) || 0, hasNext: (d.hasNext === true || String(d.hasNext) === 'true'), tagged: (d.tags || []).map(function (t) { return String(t.keyword || '') + ':' + String(t.count || ''); }).slice(0, 12) };
            } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
          }
        }).then(function (results) {
          var res0 = results && results[0] && results[0].result;
          if (res0 && res0.ok) sendResponse({ success: true, rows: res0.rows, total: res0.total, hasNext: res0.hasNext, tagged: res0.tagged });
          else sendResponse({ success: false, error: (res0 && res0.error) || 'no result' });
        }).catch(function (err) { sendResponse({ success: false, error: err.message }); });
      } else sendResponse({ success: false, error: 'no tab' });
      return true;

    case 'mainWorldTaobaoWdjAnswers':
      // v1.2.224：单问「查看全部回答」全量回答——mtop.taobao.social.ugc.post.detail 2.0（页面点「查看全部回答」用的就是它）
      // 列表接口每条问题只回 1 条代表回答（topAnswerList），answerCount 才是真实回答数 → 逐问补全才能采到全部回答。
      if (sender.tab) {
        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          args: [{ api: rgv('tb.wdjAnswerApi', 'mtop.taobao.social.ugc.post.detail'), apiV: rgv('tb.wdjAnswerApiV', '2.0'), id: String(request.questionId || ''), page: parseInt(request.page, 10) || 1 }],
          func: async function (a) {
            try {
              if (!window.lib || !window.lib.mtop) return { ok: false, error: 'no lib.mtop' };
              var fmt = function (t) {
                var s = String(t == null ? '' : t).trim();
                if (!/^\d{13}$/.test(s)) return s;
                try { var d = new Date(parseInt(s, 10)); var p = function (n) { return (n < 10 ? '0' : '') + n; };
                  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); } catch (eT) { return s; }
              };
              var txt = function (t) { return String(t == null ? '' : t).replace(/\s*[\r\n]+\s*/g, ' ').trim(); };
              var r = await window.lib.mtop.request({ api: (a && a.api) || 'mtop.taobao.social.ugc.post.detail', v: (a && a.apiV) || '2.0', data: { id: a.id, page: a.page, biz: 'pc', ecode: 0 }, type: 'GET', dataType: 'json', timeout: 15000 });
              var d = (r && r.data) || {};
              var L = d.list || {};
              var arr = L.list || [];
              var retStr = String(((r && r.ret) || []).join ? ((r && r.ret) || []).join(',') : '');
              if (!arr.length && /FAIL|ERROR|TOKEN/i.test(retStr)) return { ok: false, error: retStr.slice(0, 140) };
              var rows = arr.map(function (an) {
                var ic = an.interact || {};
                var tags = [].concat(an.answererTagList || []).concat(an.rateTag ? [an.rateTag] : []).map(function (t) { return String((t && t.text) || ''); }).filter(Boolean).join('/');
                var pics = (an.elements || []).map(function (el) { return String((el && (el.url || el.path || el.picUrl || el.imageUrl)) || ''); }).filter(function (u) { return /^https?:/.test(u); });
                var ipLoc = String(an.ipLocation || an.ipLocationName || an.publishIpLocation || (an.features && an.features.ip_location) || '');
                return {
                  answerId: an.id != null ? String(an.id) : '',
                  content: txt(an.title || an.content),
                  userTags: tags,
                  time: fmt(an.gmtCreate),
                  timeStr: String(an.gmtCreateStr || ''),
                  ipLocation: ipLoc,
                  skuInfo: txt(an.sku || an.skuStr),
                  likeCount: parseInt(ic.likeCount, 10) || 0,
                  commentCount: parseInt(ic.commentCount, 10) || 0,
                  isAiAnswer: !!an.isAiAnswer,
                  isVip: !!an.blackCardUser,
                  fold: !!(an.interact && an.interact.foldAfterDislike && an.folded),
                  images: pics
                };
              });
              return { ok: true, rows: rows, totalCount: parseInt(L.totalCount, 10) || rows.length, isEnd: String(L.isEnd || '') === 'y' || String(L.isEnd) === 'true', nextPage: parseInt(L.nextPage, 10) || 0, questionTitle: txt(d.title), qIpLocation: String(d.ipLocation || '') };
            } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
          }
        }).then(function (results) {
          var res0 = results && results[0] && results[0].result;
          if (res0 && res0.ok) sendResponse({ success: true, rows: res0.rows, totalCount: res0.totalCount, isEnd: res0.isEnd, nextPage: res0.nextPage });
          else sendResponse({ success: false, error: (res0 && res0.error) || 'no result' });
        }).catch(function (err) { sendResponse({ success: false, error: err.message }); });
      } else sendResponse({ success: false, error: 'no tab' });
      return true;

    case 'scrollReviewSection':
      // v1.1.111：淘宝评论区渐进加载（MAIN 世界）——已展开则向下滚 400~800px；
      // 未展开则滚到「查看全部评价」按钮处尽力 JS 点击（实测真点击需真实鼠标，仅回报未展开标记）
      if (sender.tab) {
        chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          func: async function (resetExpand, showBtnOnly) {
            try {
              if (resetExpand) { window.__expandTries__ = 0; try { Object.defineProperty(window, '__expandTries__', { enumerable: false, configurable: true, writable: true }); } catch (eHd) {} } // v1.1.116：每场采集重置展开尝试基线
              var btn = document.querySelector('[class*="ShowButton"]');
              var btnVisible = !!(btn && btn.offsetParent !== null);
              if (btnVisible) {
                if (showBtnOnly) {
                  // v1.1.145：仅定位时绝不改页面遮挡层样式，避免合法浮层永久失去交互。
                  try { btn.scrollIntoView({ block: 'center' }); } catch (eS1) {}
                  return { ok: true, expanded: false, shown: true, gap: 0 };
                }
                // v1.1.137：循环清除按钮中心所有遮挡层（至多 8 层）。旧正则只认 splitLine/mask 等装饰类，
                // 漏掉天猫评论晒图网格（photo--/album--/itemImgWrap--），用户点击落在晒图上打开黑灯页看图，
                // 永远点不到展开按钮——静默浏览器实证（h28-h33）。
                var _overlayRestore = [];
                var _restoreOverlays = function () {
                  for (var _or = _overlayRestore.length - 1; _or >= 0; _or--) {
                    try { _overlayRestore[_or].el.style.pointerEvents = _overlayRestore[_or].value; } catch (eR) {}
                  }
                  _overlayRestore = [];
                };
                try {
                  try { btn.scrollIntoView({ block: 'center' }); } catch (eCi) {}
                  for (var _oc = 0; _oc < 8; _oc++) {
                    var br = btn.getBoundingClientRect();
                    var at = document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2);
                    if (!at || at === btn || btn.contains(at) || at.contains(btn)) break;
                    _overlayRestore.push({ el: at, value: at.style.pointerEvents });
                    at.style.pointerEvents = 'none';
                  }
                } catch (e0) {}
                // v1.1.140：A/B 实证（h51-ab）——合成 pointerdown/up 指针序列会被天猫中间件(J_MIDDLEWARE_FRAME_WIDGET)
                // 吞掉后续点击（B 方案全失败），而直接 btn.click() 稳定开抽屉（A 方案 3.5s 成功）。
                // 防风控靠「停留后再点」：平滑滚到位→700~1400ms 停留→click→点后短停留；配合面板开场 12s 只滚不点。每场仍最多 2 次。
                window.__expandTries__ = (typeof window.__expandTries__ === 'number') ? window.__expandTries__ : 0;
                try { Object.defineProperty(window, '__expandTries__', { enumerable: false, configurable: true, writable: true }); } catch (eHd) {}
                var tried = false;
                if (window.__expandTries__ < 2) {
                  window.__expandTries__++;
                  tried = true;
                  var _slp = function (ms) { return new Promise(function (r3) { setTimeout(r3, ms); }); };
                  try { btn.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e1) {}
                  await _slp(700 + Math.floor(Math.random() * 700));
                  try { btn.click(); } catch (e2) {}
                  await _slp(400 + Math.floor(Math.random() * 600));
                }
                _restoreOverlays();
                return { ok: true, expanded: false, clicked: tried, gap: 0 };
              }
              window.__expandTries__ = 99; // 已展开
              // 已展开：优先滚评论区可滚动容器，否则窗口滚动（评论就地展开随页面长高）
              var amount = 400 + Math.floor(Math.random() * 401); // 400~800px
              var best = null, bestGap = 0;
              document.querySelectorAll('div').forEach(function (d) {
                var cls = String(d.className || '');
                if (!/comments|comment|Comment|rate|Rate|evaluation/i.test(cls)) return;
                var st = window.getComputedStyle(d);
                if (!/(auto|scroll)/.test(st.overflowY)) return;
                var gap = d.scrollHeight - d.clientHeight;
                if (gap > bestGap) { bestGap = gap; best = d; }
              });
              if (best && bestGap > 50) {
                best.scrollTop += amount;
                best.dispatchEvent(new Event('scroll', { bubbles: true }));
                return { ok: true, expanded: true, clicked: false, gap: bestGap };
              }
              window.scrollBy(0, amount);
              return { ok: true, expanded: true, clicked: false, gap: amount };
            } catch (e) { try { if (typeof _restoreOverlays === 'function') _restoreOverlays(); } catch (eR2) {} return { ok: false, error: String(e && e.message || e) }; }
          },
          args: [!!request.resetExpand, !!request.showBtnOnly]
        }).then(function (results) {
          var res0 = results && results[0] && results[0].result;
          if (res0 && res0.ok) sendResponse({ success: true, expanded: !!res0.expanded, clicked: !!res0.clicked, gap: res0.gap || 0 });
          else sendResponse({ success: false, error: (res0 && res0.error) || 'no result' });
        }).catch(function (err) { sendResponse({ success: false, error: err.message }); });
      } else sendResponse({ success: false, error: 'no tab' });
      return true;

    case 'mainWorldFetch': {
      // 只允许来自扩展内容脚本、且目标与当前标签页属于同一电商平台家族的 HTTPS GET。
      var fetchUrl = sender.tab && validateMainWorldFetch(request.url, sender.tab.url);
      if (!sender.tab || !fetchUrl) {
        sendResponse({ success: false, error: 'invalid main-world fetch target' });
        return true;
      }
      console.log('[worker] mainWorldFetch, tabId:', sender.tab.id, 'url:', fetchUrl.substring(0, 80));
      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        world: 'MAIN',
        func: function(url, maxBytes) {
          return fetch(url, { method: 'GET', credentials: 'include', redirect: 'error' }).then(function(resp) {
            var declared = Number(resp.headers.get('content-length') || 0);
            if (declared > maxBytes) throw new Error('response too large');
            return resp.text().then(function(text) {
              if (text.length > maxBytes) throw new Error('response too large');
              var json = null;
              try { json = JSON.parse(text); } catch(e) {
                var m = text.match(/\{[\s\S]+\}/);
                if (m) { try { json = JSON.parse(m[0]); } catch(e2) {} }
              }
              return { json: json, text: text.substring(0, 500), length: text.length, status: resp.status };
            });
          }).catch(function(err) { return { error: err.message || String(err) }; });
        },
        args: [fetchUrl, 1048576]
      }).then(function(results) {
        if (results && results[0]) sendResponse({ success: true, result: results[0] });
        else sendResponse({ success: false, error: 'no result' });
      }).catch(function(err) {
        console.error('[worker] mainWorldFetch失败:', err.message);
        sendResponse({ success: false, error: err.message });
      });
      return true;
    }

    case 'submitFeedback': {
      // 用户反馈提交：只允许转发到反馈服务器 origin（与授权服务器同源校验，防 SSRF）。
      // 不记录/打印反馈内容，仅记录长度，避免用户内容进入日志。
      try {
        if (typeof request.url !== 'string' || !/^https?:\/\//.test(request.url)) throw new Error('invalid url');
        var fbOrigin = (typeof AIS_CONFIG !== 'undefined' && AIS_CONFIG.feedbackApi) ? new URL(AIS_CONFIG.feedbackApi).origin : new URL(API_BASE).origin;
        if (new URL(request.url).origin !== fbOrigin) throw new Error('origin mismatch');
        var payload = request.payload;
        if (!payload || typeof payload !== 'object') throw new Error('invalid payload');
        var size = JSON.stringify(payload).length;
        if (size > 65536) throw new Error('feedback too large');
        var title = String(payload.title || '').trim();
        if (!title || title.length < 2) throw new Error('title too short');
        const controller = new AbortController();
        const fbTimer = setTimeout(() => controller.abort(), 8000);
        fetch(request.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        }).then(function(resp) {
          clearTimeout(fbTimer);
          return resp.json().catch(function() { return { ok: false, error: 'bad response' }; }).then(function(json) {
            console.log('[worker] 反馈提交完成', { status: resp.status, bytes: size });
            sendResponse({ success: !!(json && json.ok), id: json && json.id, error: (json && json.error) || null });
          });
        }).catch(function(err) {
          clearTimeout(fbTimer);
          console.error('[worker] 反馈提交失败:', (err && err.name === 'AbortError') ? 'timeout' : (err && err.message || err));
          sendResponse({ success: false, error: (err && err.name === 'AbortError') ? '请求超时' : ((err && err.message) || '请求失败') });
        });
      } catch (e) {
        console.warn('[worker] submitFeedback 拒绝:', e.message);
        sendResponse({ success: false, error: e.message || 'invalid request' });
      }
      return true;
    }

    case 'fixImageReferer': {
      // v1.2.176 防盗链（移植自竞品反编译）：把图片域名请求的 Referer 改写为商品页 origin，
      // 使 alicdn/360buyimg 等校验图床允许 offscreen fetch 与直链下载。规则随下次任务整体替换。
      try {
        if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) {
          sendResponse({ ok: false, error: 'declarativeNetRequest unavailable' });
          break;
        }
        const referer = (typeof request.referer === 'string' && /^https?:\/\//.test(request.referer)) ? request.referer.slice(0, 200) : '';
        const domains = (Array.isArray(request.domains) ? request.domains : [])
          .filter(function (d) { return typeof d === 'string' && /^[a-z0-9.-]{1,100}$/i.test(d); })
          .slice(0, 100);
        const addRules = [];
        if (referer && domains.length) {
          domains.forEach(function (dm, i) {
            addRules.push({
              id: 950000 + i,
              priority: 1,
              action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }] },
              condition: { requestDomains: [dm], resourceTypes: ['xmlhttprequest', 'image', 'media', 'other'] }
            });
          });
        }
        chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: aisImgRuleIds.concat(addRules.map(function (r2) { return r2.id; })), addRules: addRules }, function () {
          const lerr = chrome.runtime.lastError;
          if (lerr) { sendResponse({ ok: false, error: String(lerr.message || lerr) }); return; }
          aisImgRuleIds = addRules.map(function (r2) { return r2.id; });
          sendResponse({ ok: true, rules: aisImgRuleIds.length });
        });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
      return true;
    }

    case 'fetchReviewImage': {
      if (!aisSenderIsPlatformTab(sender)) { sendResponse({ ok: false, error: 'invalid sender' }); return false; }
      aisFetchReviewImage(request.url).then(sendResponse).catch(function (e) { sendResponse({ ok: false, error: e.message || '图片请求失败' }); });
      return true;
    }
    case 'licenseFetch': {
      sendResponse({ ok: false, error: '本地版不使用授权服务器' });
      return false;
    }
  }


  return false; // 仅真正异步的 case(如 licenseFetch) 在 case 内返回 true；其余同步/无响应的不占用消息通道
});

// 主世界拦截器函数（通过 chrome.scripting.executeScript 注入，绕过CSP）
// 此函数必须完全自包含，不能引用任何外部变量
function mainWorldInterceptorFn() {
  if (window.__ssrCache__) {
    console.log('[电商采集大师] 拦截器已存在，跳过重复注入');
    return;
  }

  var OriginalFetch = window.fetch;
  var OriginalXHRSend = XMLHttpRequest.prototype.send;
  var originalXHROpen = XMLHttpRequest.prototype.open;

  window.__ssrCache__ = {
    detailResponse: null,
    skuResponse: null,
    reviewResponse: null,
    allResponses: []
  };

  function notifyContentScript(type, url, data) {
    try {
      window.dispatchEvent(new CustomEvent('ssr:ready', {
        detail: { type: type, url: url, data: data }
      }));
    } catch(e) {}
  }

  function isEcommerceApi(url) {
    if (typeof url !== 'string') return false;
    return url.indexOf('taobao.com') > -1 || url.indexOf('tmall.com') > -1 ||
           url.indexOf('jd.com') > -1 || url.indexOf('3.cn') > -1 ||
           url.indexOf('jdcloud.com') > -1 || url.indexOf('360buyimg.com') > -1 ||
           url.indexOf('pinduoduo.com') > -1 || url.indexOf('yangkeduo.com') > -1 ||
           url.indexOf('1688.com') > -1 || url.indexOf('alibaba.com') > -1;
  }

  function classifyResponse(url, json) {
    if (!url || !json) return;
    var data = window.__ssrCache__;
    data.allResponses.push({ url: url, data: json, timestamp: Date.now() });
    var interceptType = null;

    if (url.indexOf('jd.com') > -1 || url.indexOf('3.cn') > -1) {
      if (url.indexOf('wareBusiness') > -1 || url.indexOf('pc_detailpage') > -1 || url.indexOf('item-soa') > -1) {
        data.detailResponse = json; interceptType = 'detail';
      } else if (url.indexOf('p.3.cn') > -1 || url.indexOf('prices') > -1) {
        if (!data.detailResponse) { data.detailResponse = json; interceptType = 'detail'; }
      } else if (url.indexOf('getLegoWareDetailComment') > -1 || url.indexOf('club.jd') > -1 ||
                 url.indexOf('productPageComments') > -1 || url.indexOf('commentList') > -1 ||
                 url.indexOf('productCommentSummaries') > -1) {
        data.reviewResponse = json; interceptType = 'review';
      } else if (url.indexOf('cdnware') > -1 || url.indexOf('getStockState') > -1 ||
                 url.indexOf('sku') > -1 || url.indexOf('colorSize') > -1 || url.indexOf('stockState') > -1) {
        data.skuResponse = json; interceptType = 'sku';
      } else if (url.indexOf('queryPlusInfo') > -1) {
        if (!data.detailResponse) { data.detailResponse = json; interceptType = 'detail'; }
      }
    } else if (url.indexOf('taobao.com') > -1 || url.indexOf('tmall.com') > -1) {
      if (url.indexOf('sku') > -1 || url.indexOf('spec') > -1) {
        data.skuResponse = json; interceptType = 'sku';
      } else if (url.indexOf('review') > -1 || url.indexOf('comment') > -1 || url.indexOf('rate') > -1) {
        data.reviewResponse = json; interceptType = 'review';
      } else if (url.indexOf('detail') > -1 || url.indexOf('iteminfo') > -1 || url.indexOf('getItemInfo') > -1 ||
                 url.indexOf('h5api.m.tmall.com') > -1 || url.indexOf('h5api.m.taobao.com') > -1) {
        data.detailResponse = json; interceptType = 'detail';
      }
    } else if (url.indexOf('pinduoduo.com') > -1 || url.indexOf('yangkeduo.com') > -1) {
      if (url.indexOf('review') > -1 || url.indexOf('comment') > -1 || url.indexOf('rate') > -1) {
        data.reviewResponse = json; interceptType = 'review';
      } else if (url.indexOf('sku') > -1 || url.indexOf('spec') > -1 || url.indexOf('goods') > -1) {
        data.skuResponse = json; interceptType = 'sku';
      } else { data.detailResponse = json; interceptType = 'detail'; }
    } else if (url.indexOf('1688.com') > -1 || url.indexOf('alibaba.com') > -1) {
      if (url.indexOf('review') > -1 || url.indexOf('comment') > -1 || url.indexOf('rate') > -1) {
        data.reviewResponse = json; interceptType = 'review';
      } else if (url.indexOf('sku') > -1 || url.indexOf('spec') > -1) {
        data.skuResponse = json; interceptType = 'sku';
      } else if (url.indexOf('detail') > -1 || url.indexOf('offer') > -1 || url.indexOf('productinfo') > -1) {
        data.detailResponse = json; interceptType = 'detail';
      }
    }   // v1.2.300 关闭外层 if 链（原 douyin 分支的收尾随该分支一并删除，这里补回）

    if (interceptType) {
      notifyContentScript(interceptType, url, json);
    }
  }

  // Hook Fetch
  window.fetch = function() {
    var args = arguments;
    return OriginalFetch.apply(this, args).then(function(response) {
      var url = '';
      if (args[0] instanceof Request) url = args[0].url || '';
      else if (typeof args[0] === 'string') url = args[0];
      if (isEcommerceApi(url)) {
        try {
          var clone = response.clone();
          clone.text().then(function(text) {
            try {
              var json = JSON.parse(text);
              classifyResponse(url, json);
            } catch(e) {
              if (text && text.length > 20) {
                var m = text.match(/\{[\s\S]+\}/);
                if (m) { try { classifyResponse(url, JSON.parse(m[0])); } catch(e2) {} }
              }
            }
          }).catch(function(){});
        } catch(e) {}
      }
      return response;
    });
  };

  // Hook XHR
  XMLHttpRequest.prototype.open = function(method, url) {
    this._url = url;
    return originalXHROpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function() {
    var self = this;
    self.addEventListener('load', function() {
      var url = self._url || '';
      if (isEcommerceApi(url)) {
        try {
          var text = self.responseText || '';
          try {
            var json = JSON.parse(text);
            classifyResponse(url, json);
          } catch(e) {
            if (text && text.length > 20) {
              var m = text.match(/\{[\s\S]+\}/);
              if (m) { try { classifyResponse(url, JSON.parse(m[0])); } catch(e2) {} }
            }
          }
        } catch(e) {}
      }
    });
    return OriginalXHRSend.apply(this, arguments);
  };

  console.log('[电商采集大师] 拦截器已通过chrome.scripting注入(绕过CSP)');
}

// === 定时任务 ===

function addSchedule(task) {
  const id = 'schedule_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8); // 修复：同毫秒多任务调度 id 碰撞
  chrome.alarms.create(id, {
    periodInMinutes: task.interval || 60,
  });
  chrome.storage.local.get(['scheduleTasks'], (result) => {
    const tasks = result.scheduleTasks || [];
    tasks.push({ ...task, id });
    chrome.storage.local.set({ scheduleTasks: tasks });
  });
}

// P2-C 本地 CSV 生成（定时自动导出用；BOM+公式注入防护）
function exportRowsToCsv(rows, fields) {
  var esc = function(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t]/.test(s)) s = "'" + s; // 公式注入防护
    return '"' + s.replace(/"/g, '""') + '"';
  };
  var csv = fields.map(esc).join(',') + '\n';
  (rows || []).forEach(function(r) {
    csv += fields.map(function(f) { return esc(r[f]); }).join(',') + '\n';
  });
  return '\uFEFF' + csv; // BOM
}

chrome.alarms && chrome.alarms.onAlarm && chrome.alarms.onAlarm.addListener(async (alarm) => {
  const result = await chrome.storage.local.get(['scheduleTasks']);
  const tasks = result.scheduleTasks || [];
  const task = tasks.find(t => t.id === alarm.name);
  if (!task || !task.url) return;

  const runId = task.id + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: task.url, active: false });
    await new Promise(resolve => setTimeout(resolve, 5000));
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('定时采集超过5分钟')), 5 * 60 * 1000));
    const collect = chrome.tabs.sendMessage(tab.id, {
      action: 'startBatchScrape', runId: runId, fields: task.fields,
      maxPages: task.maxPages || 5, containerSelector: task.containerSelector, startPage: task.startPage || 1
    });
    const response = await Promise.race([collect, timeout]);
    if (!response || response.runId !== runId || !response.success) throw new Error((response && response.error) || '定时采集未返回有效结果');

    const rows = Array.isArray(response.data) ? response.data : [];
    if (task.autoExport && rows.length > 0) {
      const fields = (Array.isArray(response.fields) && response.fields.length > 0)
        ? response.fields : Object.keys(rows[0] || {}).filter(function(k) { return k !== '来源URL'; });
      const csv = exportRowsToCsv(rows, fields);
      const safeName = (task.name || 'collection').replace(/[\/:*?"<>|]/g, '_');
      await chrome.downloads.download({
        url: 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv),
        filename: 'scheduled-' + safeName + '-' + new Date().toISOString().slice(0, 10) + '.csv', saveAs: false
      });
      console.log('[worker] 定时任务自动导出完成:', task.name, runId, rows.length + '条');
    }
  } catch (e) {
    console.error('[worker] 定时采集失败:', task.name, runId, e && e.message);
  } finally {
    if (tab && tab.id) { try { await chrome.tabs.remove(tab.id); } catch(e) {} }
  }
});

// ========== 定时监控任务调度 ==========
// 监控任务用 monitor_ 前缀的 alarm，与普通 scheduleTask 区分

function addMonitorTask(task) {
  if (!task || !task.id) return;
  chrome.alarms.create(task.id, {
    periodInMinutes: Math.max(1, task.interval || 360)
  });
  console.log('[worker] 监控任务已创建:', task.id, '间隔', task.interval, '分钟');
}

function cancelMonitorTask(task) {
  if (!task || !task.id) return;
  chrome.alarms.clear(task.id);
  console.log('[worker] 监控任务已取消:', task.id);
}

// Webhook 推送：支持飞书/钉钉/企业微信/自定义
async function sendMonitorWebhook(type, url, title, message, extra) {
  var body;
  var headers = { 'Content-Type': 'application/json' };

  if (type === 'feishu') {
    // 飞书机器人格式
    body = JSON.stringify({
      msg_type: 'interactive',
      card: {
        header: { title: { tag: 'plain_text', content: title }, template: 'orange' },
        elements: [
          { tag: 'div', text: { tag: 'lark_md', content: '**' + message + '**' } },
          { tag: 'div', fields: [
            { is_short: true, text: { tag: 'lark_md', content: '**商品**\n' + (extra.taskName || '-') } },
            { is_short: true, text: { tag: 'lark_md', content: '**' + extra.fieldName + '**\n' + extra.prevValue + ' → ' + extra.newValue } },
            { is_short: true, text: { tag: 'lark_md', content: '**趋势**\n' + extra.trend } },
            { is_short: true, text: { tag: 'lark_md', content: '**链接**\n[' + (extra.taskName || '查看商品') + '](' + extra.url + ')' } }
          ]},
          { tag: 'note', elements: [{ tag: 'plain_text', content: '电商采集大师 监控 · ' + new Date(extra.checkedAt).toLocaleString('zh-CN') }] }
        ]
      }
    });
  } else if (type === 'dingtalk') {
    // 钉钉机器人格式
    body = JSON.stringify({
      msgtype: 'markdown',
      markdown: {
        title: title,
        text: '### ' + title + '\n\n' +
              '**' + message + '**\n\n' +
              '- **商品**：' + (extra.taskName || '-') + '\n' +
              '- **' + extra.fieldName + '**：' + extra.prevValue + ' → ' + extra.newValue + '\n' +
              '- **趋势**：' + extra.trend + '\n' +
              '- **链接**：[' + (extra.taskName || '查看商品') + '](' + extra.url + ')\n\n' +
              '> 电商采集大师 监控 · ' + new Date(extra.checkedAt).toLocaleString('zh-CN')
      }
    });
  } else if (type === 'wechat') {
    // 企业微信机器人格式
    body = JSON.stringify({
      msgtype: 'markdown',
      markdown: {
        content: '### ' + title + '\n' +
                 '**' + message + '**\n' +
                 '> 商品：<font color="info">' + (extra.taskName || '-') + '</font>\n' +
                 '> ' + extra.fieldName + '：<font color="' + (extra.trend === '上涨' ? 'warning' : 'comment') + '">' + extra.prevValue + ' → ' + extra.newValue + '</font>\n' +
                 '> 趋势：<font color="' + (extra.trend === '上涨' ? 'warning' : 'info') + '">' + extra.trend + '</font>\n' +
                 '> [查看商品](' + extra.url + ')\n' +
                 '> 电商采集大师 · ' + new Date(extra.checkedAt).toLocaleString('zh-CN')
      }
    });
  } else {
    // 自定义：通用 JSON
    body = JSON.stringify({
      title: title,
      message: message,
      taskName: extra.taskName,
      url: extra.url,
      fieldName: extra.fieldName,
      prevValue: extra.prevValue,
      newValue: extra.newValue,
      trend: extra.trend,
      checkedAt: extra.checkedAt,
      source: '电商采集大师'
    });
  }

  var wc = new AbortController();
  var wt = setTimeout(function(){ wc.abort(); }, 8000); // 修复：Webhook 无超时可能挂起 SW
  var resp;
  try {
    resp = await fetch(url, { method: 'POST', headers: headers, body: body, signal: wc.signal });
  } catch (e) {
    clearTimeout(wt);
    throw new Error('webhook 请求超时/失败: ' + (e && e.message));
  }
  clearTimeout(wt);
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.text();
}

// 监控任务执行：开标签页 → 提取目标字段 → 比对历史 → 变动通知
chrome.alarms && chrome.alarms.onAlarm && chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name || alarm.name.indexOf('monitor_') !== 0) return;

  const result = await chrome.storage.local.get(['monitorTasks']);
  const tasks = result.monitorTasks || [];
  const task = tasks.find(t => t.id === alarm.name);
  if (!task || !task.enabled || !task.url) return;

  console.log('[worker] 执行监控任务:', task.name);
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: task.url, active: false });
    // 等待页面加载
    await new Promise(resolve => setTimeout(resolve, 6000));

    // 请求 content script 提取目标字段
    let extractedValue = '';
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, {
        action: 'monitorCheck',
        targetField: task.targetField || 'price'
      });
      if (resp && resp.value) extractedValue = String(resp.value);
    } catch (e) {
      console.error('[worker] 监控采集失败:', e.message);
    }

    // 比对历史（数值化，用于趋势与新高/新低）
    const prevValue = task.lastValue || '';
    const changed = extractedValue && prevValue && extractedValue !== prevValue;
    const now = Date.now();
    var _curNum = parseFloat(String(extractedValue).replace(/[^\d.]/g, ''));
    var _prevNum = parseFloat(String(prevValue).replace(/[^\d.]/g, ''));
    // 优化：记录历史极值，用于“突破新高/新低”提醒
    if (!isNaN(_curNum)) {
      if (task.minValue == null || _curNum < task.minValue) task.minValue = _curNum;
      if (task.maxValue == null || _curNum > task.maxValue) task.maxValue = _curNum;
    }
    var isNewLow = !isNaN(_curNum) && !isNaN(_prevNum) && _curNum < _prevNum && task.minValue != null && _curNum <= task.minValue;
    var isNewHigh = !isNaN(_curNum) && !isNaN(_prevNum) && _curNum > _prevNum && task.maxValue != null && _curNum >= task.maxValue;
    var trend = (!isNaN(_prevNum) && !isNaN(_curNum)) ? (_curNum > _prevNum ? '上涨' : '下降') : (String(extractedValue) > String(prevValue) ? '上涨' : '下降');

    // 更新任务
    task.lastCheckAt = now;
    task.lastTrend = trend;
    if (extractedValue) {
      task.lastValue = extractedValue;
    }
    if (!task.history) task.history = [];
    task.history.push({
      checkedAt: now,
      value: extractedValue,
      prevValue: prevValue,
      changed: changed,
      trend: trend,
      isNewLow: isNewLow,
      isNewHigh: isNewHigh,
      min: task.minValue,
      max: task.maxValue
    });
    // 历史最多保留 100 条
    if (task.history.length > 100) task.history = task.history.slice(-100);

    // 写回 storage
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) {
      tasks[idx] = task;
      await chrome.storage.local.set({ monitorTasks: tasks });
    }

    // 变动通知（多通道）
    if (changed && task.notifyOnChange) {
      var channels = task.notifyChannels || ['browser'];
      // 优化：复用外层数值化 trend，并追加“突破历史新高/新低”金提示
      var fieldName = (task.targetField === 'stock' ? '库存' : (task.targetField === 'title' ? '标题' : '价格'));
      var notifyTitle = fieldName + '变动提醒 · ' + (task.name || '监控任务');
      var extremes = isNewLow ? ('（已突破历史新低 ' + task.minValue + '，建议出手）') : (isNewHigh ? ('（已突破历史新高 ' + task.maxValue + '）') : '');
      var notifyMsg = '检测到' + fieldName + trend + '：' + prevValue + ' → ' + extractedValue + extremes;
      var notifyClickUrl = task.url;

      // 1. 浏览器原生通知
      if (channels.indexOf('browser') >= 0) {
        chrome.notifications && chrome.notifications.create('monitor_' + task.id, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: notifyTitle,
          message: notifyMsg,
          requireInteraction: false
        });
      }

      // 2. 声音提醒（通过向所有标签页注入 Audio 实现）
      if (channels.indexOf('sound') >= 0) {
        try {
          // 在 service worker 中无法直接播放声音，发送消息让 content script 播放
          chrome.tabs.query({}, function(tabs) {
            tabs.forEach(function(t) {
              if (t.id) {
                chrome.tabs.sendMessage(t.id, { action: 'playMonitorSound' }).catch(function(){});
              }
            });
          });
        } catch(e) {}
      }

      // 3. Webhook 推送
      if (channels.indexOf('webhook') >= 0 && task.webhookUrl) {
        sendMonitorWebhook(task.webhookType || 'custom', task.webhookUrl, notifyTitle, notifyMsg, {
          taskName: task.name,
          url: task.url,
          fieldName: fieldName,
          prevValue: prevValue,
          newValue: extractedValue,
          trend: trend,
          checkedAt: now
        }).catch(function(e) {
          console.error('[worker] Webhook推送失败:', e.message);
        });
      }
    }
  } catch (e) {
    console.error('[worker] 监控任务执行异常:', e.message);
  } finally {
    // 关闭标签页
    if (tab) {
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
    }
  }
});

// === 通知 ===

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: title,
    message: message,
    priority: 2,
  });
}

console.log('电商采集大师 background worker ready');
// 标记worker已加载，用于诊断
try { chrome.storage.local.set({workerLoaded: true, workerLoadedAt: Date.now()}); } catch(e) {}

// ============ 会话保活机制 ============
// 定时 ping 电商平台，保持登录 session 活跃，防止掉线
// 每 10 分钟 ping 一次用户最近使用过的平台
// v1.1.166：保活心跳已移除——每10分钟裸调 mtop（无 sign）/JD 伪 skuId 请求是无签名异常流量，
// 反向给风控送「有效登录态+非法调用」关联信号；登录态由页面采集请求自然维持，掉线由采集时检测提示。

// 记录用户活跃的平台（采集时调用）
function trackPlatformActivity(hostname) {
  if (!hostname) return;
  var platform = null;
  if (hostname.indexOf('jd.com') > -1) platform = 'jd.com';
  else if (hostname.indexOf('taobao.com') > -1) platform = 'taobao.com';
  else if (hostname.indexOf('tmall.com') > -1) platform = 'tmall.com';
  else if (hostname.indexOf('pinduoduo.com') > -1 || hostname.indexOf('yangkeduo.com') > -1) platform = 'pdd';
  else if (hostname.indexOf('1688.com') > -1) platform = '1688';
  if (!platform) return;

  chrome.storage.local.get(['activePlatforms'], function(result) {
    var platforms = result.activePlatforms || {};
    platforms[platform] = { lastUsed: Date.now(), loginOk: true };
    chrome.storage.local.set({ activePlatforms: platforms });
  });
}

// ==================== v1.1.36 图片快采：desc 抓取 + offscreen 批量下载引擎 ====================
var __aisOffscreenReady = false;
var __aisOffscreenCreating = null;
function aisEnsureOffscreen() {
  if (__aisOffscreenReady) return Promise.resolve(true);
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return Promise.resolve(false);
  if (__aisOffscreenCreating) return __aisOffscreenCreating;
  __aisOffscreenCreating = chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then(function(ctxs) {
    if (ctxs && ctxs.length) { __aisOffscreenReady = true; return true; }
    return chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('background/offscreen.html'),
      reasons: ['BLOBS'],
      justification: '抓取商品图片并转格式/打包 ZIP，生成 blob 下载链接（SW 无 URL.createObjectURL）'
    }).then(function() {
      // 等待 offscreen 内部监听器就绪
      return new Promise(function(res) { setTimeout(res, 400); });
    }).then(function() { __aisOffscreenReady = true; return true; });
  }).catch(function(e) {
    console.log('[电商采集大师] offscreen 创建失败（可能已存在）:', e && e.message);
    __aisOffscreenReady = true;
    return true;
  }).then(function(r) { __aisOffscreenCreating = null; return r; });
  return __aisOffscreenCreating;
}
function aisSanitize(n) { return String(n || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'product'; }
function aisSendToOffscreen(data, retries) {
  retries = retries == null ? 4 : retries;
  return aisEnsureOffscreen().then(function() {
    return new Promise(function(resolve, reject) {
      try {
        chrome.runtime.sendMessage({ type: 'download', data: data }, function(r) {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else if (!r) reject(new Error('offscreen 无响应'));
          else resolve(r);
        });
      } catch (e) { reject(e); }
    });
  }).catch(function(e) {
    if (retries > 0) {
      __aisOffscreenReady = false; // offscreen 可能被 SW 重启清掉，触发重建
      return new Promise(function(res) { setTimeout(res, 700); }).then(function() { return aisSendToOffscreen(data, retries - 1); });
    }
    throw e;
  });
}
// v1.2.176 防盗链：DNR 会话规则 ID 登记表（950000~950099 固定号段，每次任务整体替换）
var aisImgRuleIds = [];
// v1.2.180：当前下载任务的发起标签页（offscreen 进度经 SW 转发到该页面板）
var aisDlTabId = null;
function aisReportToPanel(payload) {
  if (aisDlTabId == null) return;
  try { chrome.tabs.sendMessage(aisDlTabId, Object.assign({ action: 'aisDlProgress' }, payload)); } catch (e) {}
}
async function aisHandleImageDownload(msg) {
  const images = (msg.images || []).map(function(i) { return Object.assign({}, i); });
  if (!images.length) return { ok: false, error: '没有可下载的图片' };
  const data = {
    images: images,
    asZip: !!msg.asZip,
    nest: !!msg.nest, // v1.2.179 按商品分文件夹（标题/分类/属性名）
    base: aisSanitize(msg.itemTitle) + '_' + aisSanitize(msg.itemId || String(Date.now())),
    summaryCsvBase64: msg.summaryCsvBase64 || '',
    extraFiles: Array.isArray(msg.extraFiles) ? msg.extraFiles : [], // v1.2.268 整合包：额外文件塞进同一个 ZIP
    pageOrigin: msg.pageOrigin || ''
  };
  let r = null, lastErr = null;
  try { r = await aisSendToOffscreen(data, 4); } catch (e) { lastErr = e; }
  if (!r) return { ok: false, error: (lastErr && lastErr.message) || 'offscreen 通信失败' };
  if (!r.ok) return r;
  if (r.mode === 'zip') {
    try {
      const did = await chrome.downloads.download({ url: r.url, filename: r.filename, saveAs: false, conflictAction: 'uniquify' });
      let fp = '';
      for (let t = 0; t < 8; t++) {
        const its = await new Promise(function(res) { chrome.downloads.search({ id: did }, res); });
        if (its && its[0] && its[0].filename) { fp = its[0].filename; break; }
        await new Promise(function(res) { setTimeout(res, 200); });
      }
      return { ok: true, mode: 'zip', count: r.count, down: r.down, failed: r.failed, fileName: r.filename, filePath: fp, downloadId: did };
    } catch (e) { return { ok: false, error: String(e && e.message || e), count: r.count, down: r.down, failed: r.failed }; }
  }
  // 散图模式：逐个 chrome.downloads 落盘
  let d = 0, f = 0; const ids = [];
  const itemsAll = r.items || [];
  for (const it of itemsAll) {
    if (it && it.url && it.filename) {
      try { const did = await chrome.downloads.download({ url: it.url, filename: it.filename, saveAs: false, conflictAction: 'uniquify' }); ids.push(did); d++; }
      catch (e) { f++; }
    } else f++;
    aisReportToPanel({ phase: 'save', kind: 'files', done: d + f, total: itemsAll.length, failed: f }); // v1.2.180
    await new Promise(function(res) { setTimeout(res, 300 + Math.floor(Math.random() * 500)); }); // v1.1.166 人化随机间隔
  }
  return { ok: true, mode: 'files', count: data.images.length, down: d, failed: f + (r.failed || 0), downloadIds: ids };
}
// v1.2.180：在商品页主世界内抓图+拼长图（fetch 自带页面 Referer，绕开图床防盗链 403）
async function aisLongImageInPage(tabId, urls, base) {
  const func = function (urls2, baseName, MAX_H, MAX_W, MIN_W) {
    return (async () => {
      const files = [], failedUrls = [], failedSet = {}, failReasons = [];
      const markFail = (u, e) => { if (!failedSet[u]) { failedSet[u] = 1; failedUrls.push(u); failReasons.push({ url: String(u).slice(-40), err: String((e && e.message) || e).slice(0, 120) }); } };
      const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
      const fetchOne = async (u) => {
        let last = null;
        for (let t = 0; t < 3; t++) {
          try {
            // v1.2.180：不能带 credentials —— alicdn 等图床返回 ACAO:* 但不允许携带凭证，带 include 会被 CORS 拒绝（实测 Failed to fetch）
            const r = await fetch(u, { referrer: location.href, referrerPolicy: 'unsafe-url' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await r.blob();
          } catch (e) { last = e; await sleep2(400 + t * 700); }
        }
        throw last || new Error('fetch failed');
      };
      const probe = []; let targetW = MIN_W;
      for (let i = 0; i < Math.min(5, urls2.length); i++) {
        try { const b = await fetchOne(urls2[i]); const bmp = await createImageBitmap(b); probe.push({ i: i, bmp: bmp }); if (bmp.width > targetW) targetW = bmp.width; } catch (e) {}
      }
      targetW = Math.max(MIN_W, Math.min(MAX_W, targetW));
      let canvas = null, ctx = null, usedH = 0, idx = 0, done = 0, okCount = 0;
      const report = () => { try { window.dispatchEvent(new CustomEvent('img:progress', { detail: { done: done, total: urls2.length, failed: Object.keys(failedSet).length, files: idx } })); } catch (e) {} };
      const ensure = () => { if (!canvas) { canvas = document.createElement('canvas'); canvas.width = targetW; canvas.height = MAX_H; ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, targetW, MAX_H); usedH = 0; } };
      const flush = () => {
        if (!canvas || !usedH) return;
        const h = Math.max(1, Math.round(usedH));
        const out = document.createElement('canvas'); out.width = targetW; out.height = h;
        out.getContext('2d').drawImage(canvas, 0, 0, targetW, h, 0, 0, targetW, h);
        idx++;
        try { files.push({ name: baseName + '/详情长图/详情长图-' + idx + '.png', dataUrl: out.toDataURL('image/png') }); } catch (e) {}
        canvas = null; ctx = null; usedH = 0;
        report();
      };
      const drawBmp = (bmp) => {
        const scale = targetW / bmp.width;
        const destH = Math.max(1, Math.round(bmp.height * scale));
        let drawn = 0;
        while (drawn < destH) {
          ensure();
          const room = MAX_H - usedH;
          if (room < 2) { flush(); continue; }
          const dh = Math.min(destH - drawn, room);
          const sh = Math.max(1, Math.min(bmp.height, Math.round(dh / scale)));
          const sy = Math.max(0, Math.min(bmp.height - sh, Math.round(drawn / scale)));
          ctx.drawImage(bmp, 0, sy, bmp.width, sh, 0, usedH, targetW, dh);
          usedH += dh; drawn += dh;
          if (usedH >= MAX_H - 2) flush();
        }
      };
      const probeMap = {}; probe.forEach((p) => { probeMap[p.i] = p.bmp; });
      for (let i = 0; i < urls2.length && i < 200; i++) {
        let bmp = probeMap[i];
        try {
          if (!bmp) { const b = await fetchOne(urls2[i]); bmp = await createImageBitmap(b); }
          drawBmp(bmp);
          if (bmp && bmp.close) bmp.close();
          okCount++;
        } catch (e) { markFail(urls2[i], e); }
        done++;
        if (done % 2 === 0 || done === urls2.length) report();
      }
      flush();
      return { files: files, count: urls2.length, down: okCount, failed: Object.keys(failedSet).length, failedUrls: failedUrls.slice(0, 8), failReasons: failReasons.slice(0, 8) };
    })();
  };
  const res = await chrome.scripting.executeScript({ target: { tabId: tabId }, world: 'MAIN', args: [urls, base, 16000, 2400, 800], func: func });
  return res && res[0] ? res[0].result : null;
}
// v1.2.179 详情长图：与图片下载共用 offscreen 通道（d.longImage 分支）
async function aisHandleLongImage(msg) {
  const imgs = (msg.images || []).filter(Boolean).map(function(u) { return { url: u }; });
  if (!imgs.length) return { ok: false, error: '没有可导出的详情图' };
  const data = {
    images: imgs,
    longImage: true,
    base: aisSanitize(msg.itemTitle) + '_' + aisSanitize(msg.itemId || String(Date.now())),
    pageOrigin: msg.pageOrigin || ''
  };
  // v1.2.180：优先在商品页主世界内抓图拼接（fetch 自带 Referer，防盗链不再 403）
  let pageRes = null;
  try {
    if (aisDlTabId != null && chrome.scripting && chrome.scripting.executeScript) {
      pageRes = await aisLongImageInPage(aisDlTabId, imgs.map(function (x) { return x.url; }), data.base);
    }
  } catch (ePage) { console.log('[电商采集大师] 页面内长图失败，回退 offscreen:', ePage && ePage.message); }
  if (pageRes && pageRes.files && pageRes.files.length) {
    let pd = 0, pf = 0; const pids = [];
    for (const fl of pageRes.files) {
      try { const did = await chrome.downloads.download({ url: fl.dataUrl, filename: fl.name, saveAs: false, conflictAction: 'uniquify' }); pids.push(did); pd++; }
      catch (e) { pf++; }
      aisReportToPanel({ phase: 'save', kind: 'longimage', done: pd + pf, total: pageRes.files.length, failed: pf });
      await new Promise(function (res) { setTimeout(res, 300); });
    }
    return { ok: true, mode: 'longimage', count: pageRes.count, down: pd, failed: pf + (pageRes.failed || 0), downloadIds: pids, failedUrls: pageRes.failedUrls || [], failReasons: pageRes.failReasons || [], source: 'page' };
  }
  let r = null, lastErr = null;
  try { r = await aisSendToOffscreen(data, 4); } catch (e) { lastErr = e; }
  if (!r) return { ok: false, error: (lastErr && lastErr.message) || 'offscreen 通信失败' };
  if (!r.ok) return r;
  let d = 0, f = 0; const ids = [];
  const filesAll = r.files || [];
  for (const it of filesAll) {
    if (it && it.url && it.filename) {
      try { const did = await chrome.downloads.download({ url: it.url, filename: it.filename, saveAs: false, conflictAction: 'uniquify' }); ids.push(did); d++; }
      catch (e) { f++; }
    } else f++;
    aisReportToPanel({ phase: 'save', kind: 'longimage', done: d + f, total: filesAll.length, failed: f }); // v1.2.180
    await new Promise(function(res) { setTimeout(res, 300); });
  }
  return { ok: true, mode: 'longimage', count: r.count, down: d, failed: f + (r.failed || 0), downloadIds: ids, failedUrls: r.failedUrls || [] };
}
function aisFetchDescImages(descUrl, tabId) {
  if (!descUrl) return Promise.reject(new Error('无 descUrl'));
  const ctrl = new AbortController();
  const timer = setTimeout(function() { ctrl.abort(); }, 20000);
  // v1.1.166：优先走商品页主世界抓取（与页面同 Referer/Sec-Fetch 上下文，指纹一致），失败回退后台抓取
  var htmlPromise;
  if (tabId != null && chrome.scripting && chrome.scripting.executeScript) {
    htmlPromise = chrome.scripting.executeScript({ target: { tabId: tabId }, world: 'MAIN',
      func: function (u) { return fetch(u, { credentials: 'include' }).then(function (resp) { return resp.text(); }).catch(function (e) { return '__ais_desc_err__' + (e && e.message || e); }); },
      args: [descUrl] }).then(function (results) {
      var t = results && results[0] && results[0].result;
      if (typeof t === 'string' && t.length > 64 && t.indexOf('__ais_desc_err__') !== 0) return t;
      throw new Error('mainWorld desc unavailable');
    }).catch(function () {
      return fetch(descUrl, { credentials: 'include', signal: ctrl.signal }).then(function (resp) { clearTimeout(timer); if (!resp.ok) throw new Error('HTTP ' + resp.status); return resp.text(); });
    });
  } else {
    htmlPromise = fetch(descUrl, { credentials: 'include', signal: ctrl.signal }).then(function (resp) { clearTimeout(timer); if (!resp.ok) throw new Error('HTTP ' + resp.status); return resp.text(); });
  }
  return htmlPromise.then(function(text) {
    const html = String(text || '').replace(/\\u002F/gi, '/').replace(/\\/g, '/');
    const seen = {}, out = [];
    function push(u) {
      if (!u) return;
      if (u.indexOf('//') === 0) u = 'https:' + u;
      if (!/^https?:/.test(u)) return;
      if (seen[u]) return;
      seen[u] = 1; out.push(u);
    }
    const re1 = /(?:data-ks-lazyload|data-lazyload|data-lazy|data-original|data-src|src)\s*=\s*["']([^"']+[.](?:jpg|jpeg|jfif|png|webp|avif|bmp|gif)(?:\?[^"']*)?)/gi;
    let m;
    while ((m = re1.exec(html)) !== null) push(m[1]);
    const re2 = /(?:https?:)?\/\/[^"'<>\s]+[.](?:jpg|jpeg|jfif|png|webp|avif|bmp|gif)(?:\?[^"'<>\s]*)?/gi;
    while ((m = re2.exec(html)) !== null) push(m[0]);
    return out.slice(0, 200);
  }).catch(function(e) { clearTimeout(timer); throw e; });
}

// Background-only image transport for Excel embedding. No arbitrary URL proxy.
function aisReviewImageUrl(value) {
  try {
    const url = new URL(String(value).startsWith('//') ? 'https:' + value : value);
    const hosts = ['alicdn.com', 'taobaocdn.com', 'tbcdn.cn', '360buyimg.com', 'pddpic.com', 'pinduoduo.com', 'yangkeduo.com', 'media-amazon.com', 'ssl-images-amazon.com', 'images-amazon.com'];
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    if (!hosts.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) return null;
    url.protocol = 'https:';
    return url.href;
  } catch (e) { return null; }
}
async function aisFetchReviewImage(value) {
  const url = aisReviewImageUrl(value);
  if (!url) throw new Error('不支持的图片地址');
  const max = 8 * 1024 * 1024, controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { credentials: 'include', redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new Error('图片 HTTP ' + response.status);
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(jpeg|jpg|png|webp|gif|avif|bmp)$/.test(mime)) throw new Error('响应不是支持的图片格式');
    if (Number(response.headers.get('content-length')) > max) throw new Error('图片超过 8 MB');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    for (;;) {
      const { done, value: chunk } = await reader.read(); if (done) break;
      size += chunk.length;
      if (size > max) { await reader.cancel(); throw new Error('图片超过 8 MB'); }
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return { ok: true, base64: btoa(binary), mime };
  } finally { clearTimeout(timer); }
}
