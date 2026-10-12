// 电商采集大师 - 主世界拦截器
// 此文件通过 chrome.scripting.executeScript({world:'MAIN', files:[...]}) 注入主世界
// 绕过页面 CSP 限制（京东等平台 CSP 阻止 inline script）
// 注意：此文件必须完全自包含，不能引用任何外部变量
(function() {
  if (window.__ssrCache__) {
    console.log('[电商采集大师] 拦截器已存在，跳过重复注入');
    return;
  }

  var OriginalFetch = window.fetch;
  var OriginalXHRSend = XMLHttpRequest.prototype.send;
  var originalXHROpen = XMLHttpRequest.prototype.open;

  try { Object.defineProperty(window, '__ssrCache__', { value: {}, writable: true, configurable: true, enumerable: false }); } catch (eNd) {}
window.__ssrCache__ = Object.assign(window.__ssrCache__ || {}, {
    detailResponse: null,
    descResponse: null,
    skuResponse: null,
    descResponse: null,
    reviewResponse: null,
    allResponses: []
  });

  function notifyContentScript(type, url, data) {
    try {
      window.dispatchEvent(new CustomEvent('ssr:ready', {
        detail: { type: type, url: url, data: data }
      }));
    } catch(e) {}
  }

  function isEcommerceApi(url) {
    if (typeof url !== 'string' || url.length > 4096) return false;
    try {
      var parsed = new URL(url, window.location.href);
      if (!/^https?:$/.test(parsed.protocol)) return false;
      var host = parsed.hostname.toLowerCase();
      var allowed = ['taobao.com','tmall.com','jd.com','3.cn','jdcloud.com','360buyimg.com',
        'pinduoduo.com','yangkeduo.com','1688.com','alibaba.com'];   // v1.2.300 抖音已下线
      return allowed.some(function(suffix) { return host === suffix || host.endsWith('.' + suffix); });
    } catch(e) { return false; }
  }

  // 京东通用API响应内容深度检测
  // api.m.jd.com/client.action 这类URL不含功能关键字，需通过响应体字段识别
  function detectJdResponseType(json) {
    // v1.1.44b：风控/统计/日志响应一律不识别为业务数据（umdc wcfg 等含 priceList/stockState 等字样会误判为 sku）
    try {
      var raw = '';
      try { raw = JSON.stringify(json).slice(0, 400); } catch (eRaw) {}
      if (raw && /"(bx|umid|umdc|acw|_m_h5_tk|x5seq|isg|cna|tfas|wl_bu)"/i.test(raw)) return null;
    } catch (eBL) {}

    if (!json || typeof json !== 'object') return null;
    // 兼容 {code, result/data} 包裹结构
    var inner = json;
    if (json.result && typeof json.result === 'object') inner = json.result;
    else if (json.data && typeof json.data === 'object') inner = json.data;

    var keys = Object.keys(inner || {});

    // 评论响应特征字段
    var reviewKeys = ['commentInfoList', 'commentInfo', 'rateList', 'productCommentSummary',
                      'comments', 'commentData', 'hotCommentTagStatistics',
                      'commentPageResult', 'rateFloorContent', 'commentSummary'];
    var reviewHit = 0;
    for (var i = 0; i < reviewKeys.length; i++) {
      if (keys.indexOf(reviewKeys[i]) > -1) reviewHit++;
    }
    if (reviewHit >= 1) return 'review';

    // 京东新版楼层化评论：result.floors + result.pageInfo（name含"评价列表"）
    if (Array.isArray(inner.floors) && inner.pageInfo) {
      var pname = inner.pageInfo.name || '';
      if (pname.indexOf('评价') > -1 || pname.indexOf('评论') > -1 || pname.indexOf('comment') > -1) {
        return 'review';
      }
      // 或 floors 中存在 mId 含 commentlist 的楼层
      for (var fi = 0; fi < inner.floors.length; fi++) {
        var fmId = inner.floors[fi].mId || '';
        if (fmId.indexOf('commentlist') > -1 || fmId.indexOf('comment-list') > -1) {
          return 'review';
        }
      }
    }

    // SKU响应特征字段
    var skuKeys = ['priceMap', 'stockStateMapResponses', 'priceInfoResponses',
                   'colorSizeVO', 'skuList', 'priceList', 'stockState'];
    var skuHit = 0;
    for (var j = 0; j < skuKeys.length; j++) {
      if (keys.indexOf(skuKeys[j]) > -1) skuHit++;
    }
    if (skuHit >= 2) return 'sku';

    // 详情响应特征字段
    var detailKeys = ['shopName', 'wareName', 'skuId', 'itemId', 'pcExtension',
                      'overSeasSale', 'shopInfo', 'brandInfo', 'imageList',
                      'wareInfo', 'subTitle'];
    var detailHit = 0;
    for (var k = 0; k < detailKeys.length; k++) {
      if (keys.indexOf(detailKeys[k]) > -1) detailHit++;
    }
    if (detailHit >= 2) return 'detail';

    // v1.1.167 抗改版深度签名：键名随京东版本变化，但数据形状稳定。
    // 递归有界扫描（深度≤4、节点≤300），按语义字段命中数判定类型。
    function __aisDeepSign(node, depth, stat) {
      if (!node || typeof node !== 'object' || depth > 4 || stat.nodes > 300) return;
      stat.nodes++;
      if (Array.isArray(node)) {
        var ai2 = Math.min(node.length, 30);
        for (var ai = 0; ai < ai2; ai++) __aisDeepSign(node[ai], depth + 1, stat);
        return;
      }
      for (var key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        var val = node[key];
        var kl = key.toLowerCase();
        if (kl.indexOf('skuid') > -1 || kl.indexOf('skuname') > -1 ||
            kl.indexOf('colorsize') > -1 || kl.indexOf('specid') > -1 ||
            kl.indexOf('specname') > -1 || kl.indexOf('specvalue') > -1) stat.sku++;
        if (kl.indexOf('warename') > -1 || kl.indexOf('brandname') > -1 ||
            kl.indexOf('shopname') > -1 || kl.indexOf('wareinfo') > -1 ||
            kl.indexOf('spuid') > -1 || kl.indexOf('venderid') > -1) stat.detail++;
        if (typeof val === 'string') {
          if (val.indexOf('360buyimg.com') > -1 && val.indexOf('jfs/') > -1) stat.jdimgs++;
          if (val.length > 500 && val.indexOf('360buyimg.com') > -1 && val.indexOf('<') > -1) stat.html++;
        }
        if (val && typeof val === 'object') __aisDeepSign(val, depth + 1, stat);
      }
    }
    try {
      var stat = { sku: 0, detail: 0, jdimgs: 0, html: 0, nodes: 0 };
      __aisDeepSign(inner, 0, stat);
      if (stat.sku >= 2 && stat.sku >= stat.detail) return 'sku';
      if (stat.detail >= 2) return 'detail';
      if (stat.jdimgs >= 3 && stat.html >= 1) return 'desc';
    } catch (eDeep) {}

    return null;
  }

  // v1.1.36 详情响应质量识别（参照 picchajian looksLikeDetail）
  function looksLikeDetail(json) {
    try {
      if (!json || typeof json !== 'object') return false;
      var d = json.data || json;
      var it = d.item || d.offer || d;
      var imgs = it && (it.images || it.imageUrls || it.mainImages || it.itemImages);
      if (Array.isArray(imgs) && imgs.length) return true;
      if (it && (it.itemId || it.offerId) && (it.title || it.subject)) return true;
      return false;
    } catch (e) { return false; }
  }
  function classifyResponse(url, json) {
    if (!url || !json) return;
    var data = window.__ssrCache__;
    if (data.allResponses.length > 200) data.allResponses.shift(); // 修复：限制拦截响应缓存，避免内存无限增长
    data.allResponses.push({ url: url, data: json, timestamp: Date.now() });
    var interceptType = null;

    // 京东 API 分类
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
      } else {
        // 京东新版通用API（api.m.jd.com/client.action）URL不含关键字
        // 通过响应内容深度检测识别评论/SKU/详情
        var detected = detectJdResponseType(json);
        if (detected === 'review') {
          data.reviewResponse = json; interceptType = 'review';
        } else if (detected === 'sku') {
          if (!data.skuResponse) { data.skuResponse = json; interceptType = 'sku'; }
        } else if (detected === 'detail') {
          if (!data.detailResponse) { data.detailResponse = json; interceptType = 'detail'; }
        } else if (detected === 'desc') {
          // v1.1.167：详情内容响应（京东新版把详情图放 API 返回的 HTML 里）
          data.descResponse = json; interceptType = 'desc';
        }
      }
    }
    // 淘宝/天猫 API 分类
    else if (url.indexOf('taobao.com') > -1 || url.indexOf('tmall.com') > -1) {
      if (url.indexOf('sku') > -1 || url.indexOf('spec') > -1) {
        data.skuResponse = json; interceptType = 'sku';
      } else if (url.indexOf('review') > -1 || url.indexOf('comment') > -1 || url.indexOf('rate') > -1) {
        data.reviewResponse = json; interceptType = 'review';
      } else if (url.toLowerCase().indexOf('getdesc') > -1 || url.toLowerCase().indexOf('/desc') > -1) {
        // v1.1.36：详情描述接口（getdesc 等）单独归类，避免覆盖 detailResponse
        data.descResponse = json; interceptType = 'desc';
      } else if (url.indexOf('detail') > -1 || url.indexOf('iteminfo') > -1 || url.indexOf('getItemInfo') > -1 ||
                 url.indexOf('h5api.m.tmall.com') > -1 || url.indexOf('h5api.m.taobao.com') > -1) {
        // v1.1.36 质量门控：防止推荐流/垃圾响应覆盖真实详情数据
        var newGood = looksLikeDetail(json), oldGood = data.detailResponse && looksLikeDetail(data.detailResponse);
        if (!data.detailResponse || (newGood && !oldGood)) { data.detailResponse = json; interceptType = 'detail'; }
      }
    }
    // 拼多多 API 分类
    else if (url.indexOf('pinduoduo.com') > -1 || url.indexOf('yangkeduo.com') > -1) {
      if (url.indexOf('review') > -1 || url.indexOf('comment') > -1 || url.indexOf('rate') > -1) {
        data.reviewResponse = json; interceptType = 'review';
      } else if (url.indexOf('sku') > -1 || url.indexOf('spec') > -1 || url.indexOf('goods') > -1) {
        data.skuResponse = json; interceptType = 'sku';
      } else { data.detailResponse = json; interceptType = 'detail'; }
    }
    // 1688 API 分类
    else if (url.indexOf('1688.com') > -1 || url.indexOf('alibaba.com') > -1) {
      if (url.indexOf('review') > -1 || url.indexOf('comment') > -1 || url.indexOf('rate') > -1) {
        data.reviewResponse = json; interceptType = 'review';
      } else if (url.indexOf('sku') > -1 || url.indexOf('spec') > -1) {
        data.skuResponse = json; interceptType = 'sku';
      } else if (url.indexOf('detail') > -1 || url.indexOf('offer') > -1 || url.indexOf('productinfo') > -1) {
        data.detailResponse = json; interceptType = 'detail';
      }
    }

    if (interceptType) {
      notifyContentScript(interceptType, url, json);
    }
  }

  // Hook Fetch
  var __origFetch = window.fetch;
window.fetch = __aisWrapNative(__origFetch, function() {
    var args = arguments;
    return OriginalFetch.apply(this, args).then(function(response) {
      var url = '';
      if (args[0] instanceof Request) url = args[0].url || '';
      else if (typeof args[0] === 'string') url = args[0];
      else if (args[0] && args[0].href) url = args[0].href;
      else if (args[0] && args[0].toString) url = String(args[0]);
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
  });

  // Hook XHR
  var __origXhrOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = __aisWrapNative(__origXhrOpen, function(method, url) {
    this._url = url;
    return originalXHROpen.apply(this, arguments);
  });
  var __origXhrSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = __aisWrapNative(__origXhrSend, function() {
    var self = this;
    self.addEventListener('load', function() {
      var url = self._url || '';
      if (typeof url !== 'string') {
        if (url && url.href) url = url.href;
        else if (url) url = String(url);
        else url = '';
      }
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
  });

  // v1.1.166：伪装覆写函数特征——toString 返回原生样式，降低「原生函数被改写」检测面
  // v1.2.366：用 Proxy 包裹原生函数——`Function.prototype.toString.call(proxy)` 返回 `[native code]`，
// 而旧做法（只给函数对象挂 toString）可被 `Function.prototype.toString.call` 绕过检测。
function __aisWrapNative(orig, impl) {
  try {
    var proxy = new Proxy(orig, {
      apply: function (t, thisArg, args) { return impl.apply(thisArg, args); },
      construct: function (t, args) { return Reflect.construct(t, args); }
    });
    try { Object.defineProperty(proxy, 'toString', { value: function () { return Function.prototype.toString.call(t || orig); }, writable: true, configurable: true }); } catch (e1) {}
    return proxy;
  } catch (e2) { return impl; }   // Proxy 不可用时退回普通包装（功能优先）
}
function __aisMaskNative(fn, nativeName) {
    try {
      var src = 'function ' + nativeName + '() { [native code] }';
      Object.defineProperty(fn, 'toString', { value: function () { return src; }, writable: true, configurable: true });
    } catch (e) {}
    return fn;
  }
  __aisMaskNative(window.fetch, 'fetch');
  __aisMaskNative(XMLHttpRequest.prototype.open, 'open');
  __aisMaskNative(XMLHttpRequest.prototype.send, 'send');

  // 主动 fetch 不再使用公开 DOM 事件桥；统一由 background worker 校验目标后执行。




  // v1.1.44 SSR SKU 捕获：新版淘宝详情页把 skuBase/skuCore 内联在 ICE loaderData（res.skuBase / res.skuCore），
  // 页面不点规格就不发 sku 接口请求，且 mtop detail 响应不含 skuBase —— 必须无条件单独捕获，否则 SKU 图恒为空。
  // v1.2.414：主世界 → 隔离世界的【DOM 桥】。跨世界读 DOM 不受消息时序影响。
  function __aisWriteSsrBridge(id, payload) {
    try {
      var doc = document;
      var el = doc.getElementById(id);
      if (!el) {
        el = doc.createElement('script');
        el.type = 'application/json';
        el.id = id;
        el.style.display = 'none';
        (doc.head || doc.documentElement || doc.body).appendChild(el);
      }
      el.textContent = JSON.stringify(payload);
    } catch (e) {}
  }

  function trySkuSsrCaptureTaobao() {
    try {
      var ice = window.__ICE_APP_CONTEXT__;
      if (!ice || !ice.loaderData) return;
      var home = ice.loaderData.home;
      if (!home || !home.data || !home.data.res) return;
      var r = home.data.res;
      if (!r.skuBase && !r.skuCore) return;
      if (window.__ssrCache__.skuResponse && (function(s) { try { return !!(s.data && (s.data.skuBase || s.data.skuCore || (s.data.data && (s.data.data.skuBase || s.data.data.skuCore)))); } catch (e) { return true; } })(window.__ssrCache__.skuResponse)) return;
      var payload = { data: { skuBase: r.skuBase || null, skuCore: r.skuCore || null } };
      window.__ssrCache__.skuResponse = payload;
      notifyContentScript('sku', 'ssr://taobao-ice-sku', payload);
      // v1.2.414【根治补强】：同一份 SSR SKU 再写一份到【DOM 桥】。
      // 真机实证：主世界 __ssrCache__.skuResponse 完整（props/skus 齐全），但面板 collectState() 拿不到
      // → 只用 DOM 兜底（propNames 变成「规格1」、多行共用一张图）。根因是跨世界消息的时序/丢失。
      // DOM 桥与消息通道无关，面板在采集时随时可读，是最可靠的一层。
      try { __aisWriteSsrBridge('ais-ssr-sku-bridge', payload); } catch (eBr) {}
      console.log('[电商采集大师] SSR SKU 数据已捕获（skuBase/skuCore）');
    } catch (e) {}
  }
  // v1.1.36 天猫/淘宝 ICE SSR 兜底（参照 picchajian）：descUrl 常在 window.__ICE_APP_CONTEXT__
  // v1.2.375：官方主图【独立通道】——真机取证：面板拿到的 detailResponse 是 mtop 响应
  // （{api,data:{traceId,resultValue}}，没有 item.images），SSR 的 res.item.images 因“detailResponse 已被占用”
  // 被 looksLikeDetail 闸门拦下、从未送到面板 → extractMainImages 抓不到 → 主图退化成 DOM 扫描，把 logo/海报扫进来。
  // 这里不受闸门影响，只要 ICE 里有 images 就单独通知一次。
  // v1.2.379：主世界规则读取（由 worker 注入的 window.__AIS_RULES__ 快照）——
  // ICE 全局名与各数据路径改为【服务器可改】：平台改版只改 anchor-rules.json，无需发版。
  function aisRule(path, def) {
    try {
      var r = window.__AIS_RULES__ || {}; var v = r, ks = String(path).split('.');
      for (var i = 0; i < ks.length; i++) { if (v == null) return def; v = v[ks[i]]; }
      return (v === undefined || v === null || v === '') ? def : v;
    } catch (e) { return def; }
  }
  // v1.2.382：按候选键列表取值（字段改名只改服务器）
  function aisPick(obj, keysPath, def) {
    try {
      var ks = aisRule(keysPath, []);
      if (typeof ks === 'string') ks = ks.split(',');
      for (var i = 0; i < ks.length; i++) { var k = String(ks[i]).trim(); if (k && obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k]; }
    } catch (e) {}
    return def;
  }
  function aisIce() { try { return window[aisRule('tb.iceGlobal', '__ICE_APP_CONTEXT__')]; } catch (e) { return null; } }
  function aisIceRes() {
    try {
      var ice = aisIce(); if (!ice) return null;
      var v = ice, ks = String(aisRule('tb.ssrResPath', 'loaderData.home.data.res')).split('.');
      for (var i = 0; i < ks.length; i++) { if (v == null) return null; v = v[ks[i]]; }
      return v || null;
    } catch (e) { return null; }
  }
  function trySsrMainImagesTaobao() {
    try {
      var r = aisIceRes();
      var it = r && r[aisRule('tb.ssrItemPath', 'item')];
      var __imgsM = aisPick(it, 'tb.ssrImagesKeys', it.images);
      if (!it || !__imgsM || !__imgsM.length) return;
      var imgs = __imgsM.slice(0, 60);
      if (window.__ssrCache__.ssrMainImgs && window.__ssrCache__.ssrMainImgs.length === imgs.length) return;
      window.__ssrCache__.ssrMainImgs = imgs;
      notifyContentScript('mainimages', 'ssr://taobao-main-images', { images: imgs });
      console.log('[电商采集大师] 官方主图已捕获 ' + imgs.length + ' 张（独立通道）');
    } catch (eMi) {}
  }
  function trySsrCaptureTaobao() {
    try {
      var ice = window.__ICE_APP_CONTEXT__;
      if (!ice || !ice.loaderData) return;
      var home = ice.loaderData.home;
      if (!home || !home.data || !home.data.res) return;
      var r = home.data.res, it = r[aisRule('tb.ssrItemPath', 'item')] || {};
      var __imgs = aisPick(it, 'tb.ssrImagesKeys', it.images);
      var __itemId = aisPick(it, 'tb.ssrItemIdKeys', it.itemId);
      if (!__itemId && !(__imgs && __imgs.length)) return;
      if (!window.__ssrCache__.detailResponse || !looksLikeDetail(window.__ssrCache__.detailResponse)) {
        var payload = { data: { item: {
          title: String(aisPick(it, 'tb.ssrTitleKeys', it.title) || ''), itemId: __itemId || '',
          images: Array.isArray(__imgs) ? __imgs.slice(0, 50) : [],
          descUrl: (function () { try { var ks = aisRule('tb.ssrDescUrlKeys', ['pcADescUrl', 'descUrl', 'descURL', 'pcDescUrl']); if (typeof ks === 'string') ks = ks.split(','); for (var i = 0; i < ks.length; i++) { var k = String(ks[i]).trim(); if (k && it[k]) return it[k]; } } catch (e) {} return it.pcADescUrl || it.descUrl || ''; })(),
          videos: (function () { var v = aisPick(it, 'tb.ssrVideoKeys', it.videos); return Array.isArray(v) ? v : []; })(),
          skuBase: (function () { try { var ks = aisRule('tb.ssrSkuBaseKeys', ['skuBase', 'skuBaseModel', 'skuBaseVO']); if (typeof ks === 'string') ks = ks.split(','); for (var i = 0; i < ks.length; i++) { var k = String(ks[i]).trim(); if (k && it[k]) return it[k]; } } catch (e) {} return it.skuBase || it.skuBaseModel || null; })()
        } } };
        window.__ssrCache__.detailResponse = payload;
        notifyContentScript('detail', 'ssr://taobao-ice-detail', payload);
      }
    } catch (e) {}
  }
  setTimeout(trySsrCaptureTaobao, 400);
  setTimeout(trySsrCaptureTaobao, 1600);
  setTimeout(trySsrCaptureTaobao, 4200);
  setTimeout(trySkuSsrCaptureTaobao, 400);
  setTimeout(trySkuSsrCaptureTaobao, 1600);
  setTimeout(trySkuSsrCaptureTaobao, 4200);
  setTimeout(trySkuSsrCaptureTaobao, 8000);
  setTimeout(trySsrMainImagesTaobao, 400);
  setTimeout(trySsrMainImagesTaobao, 1600);
  setTimeout(trySsrMainImagesTaobao, 4200);
  setTimeout(trySsrMainImagesTaobao, 8000);
  // v1.2.460【移植自电商宝 content/panel.js:2926】京东：直接读买家页 window.pageConfig.product
//   （colorSize 规格维度 + skus 组合表）——不依赖接口拦截 / DOM 类名 / 登录态，电商宝靠它长期稳定取到京东 SKU。
//   经 ssr:ready(type='jdsku') + DOM 桥 #ais-ssr-jdsku-bridge 双通道交给隔离世界（与淘宝 SKU 桥同一套机制）。
//   平台字段名全部走规则键（jd.pcObj / jd.pcProduct / jd.pcColorSize / jd.pcSkus / jd.pcSku），可远程改。
function tryJdPageConfigSku() {
  try {
    if (!/(^|\.)jd\.com$/i.test(location.hostname)) return;
    if (aisRule('jd.pcSku', 'on') === 'off') return;
    var pcObj = window[aisRule('jd.pcObj', 'pageConfig')];
    var p = pcObj && pcObj[aisRule('jd.pcProduct', 'product')];
    if (!p) return;
    var cs = p[aisRule('jd.pcColorSize', 'colorSize')];
    var sk = p[aisRule('jd.pcSkus', 'skus')];
    if (!cs || !sk) return;
    var n = 0; try { n = Object.keys(sk).length; } catch (eN) {}
    if (!n) return;
    var cache = window.__ssrCache__ && window.__ssrCache__.jdPageConfig;
    if (cache && cache.__n === n) return;                 // 同规模数据已发布过 → 不重复广播
    var payload = { colorSize: cs, skus: sk };
    try { if (window.__ssrCache__) window.__ssrCache__.jdPageConfig = { __n: n, colorSize: cs, skus: sk }; } catch (eC) {}
    try { __aisWriteSsrBridge('ais-ssr-jdsku-bridge', payload); } catch (eB) {}
    notifyContentScript('jdsku', 'ssr://jd-pageConfig', payload);
  } catch (e) {}
}
setTimeout(tryJdPageConfigSku, 300);
setTimeout(tryJdPageConfigSku, 1200);
setTimeout(tryJdPageConfigSku, 3000);
setTimeout(tryJdPageConfigSku, 6000);
setTimeout(tryJdPageConfigSku, 10000);
console.log('[电商采集大师] 主世界拦截器已通过文件注入(绕过CSP)');
})();
