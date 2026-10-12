// 电商采集大师 - 详情页深度采集模块
// 目标：解决SKU规格、评论数据、商品参数等深度数据的采集

// v1.1.172 锚点注册表快捷取值（注册表缺失自动回退内置字面量）
function aisDcSel(p, f) { try { return window.AisAnchors.sel(p, f); } catch (e) { return f; } }

// v1.1.172 锚点注册表快捷取值（anchor-registry.js 先行加载；注册表缺失自动回退内置字面量）
function aisSel(p, f) { try { return (window.AisAnchors && window.AisAnchors.sel) ? window.AisAnchors.sel(p, f) : f; } catch (e) { return f; } }

// v1.2.260：京东图床统一清洗 —— 本文件多处 JD 路径此前都没做这两件事：
//   ① .avif 后缀还原（JD 会下发 .../xxx.jpg.avif，落在本地不通用）
//   ② 尺寸前缀过小的占位/图标剔除（/s{n}x{n}_jfs/ 任一边 < jd.skuMinPx，默认 32）
// 非 360buyimg 的 URL 原样返回（不强改其它图床）。返回 '' 表示应丢弃该图。
function jdNormImg(u) {
  var s = String(u || '');
  if (s.indexOf('//') === 0) s = 'https:' + s;
  if (!/360buyimg\.com/.test(s)) return s;
  var minPx = 32;
  try { if (window.AisAnchors && window.AisAnchors.num) minPx = window.AisAnchors.num('jd.skuMinPx', 32); } catch (e) {}
  var m = s.match(/\/s(\d+)x(\d+)_jfs\//i);
  if (m && (parseInt(m[1], 10) < minPx || parseInt(m[2], 10) < minPx)) return '';
  // v1.2.261：必须**去掉尺寸前缀**归一到 /jfs/ 原图。实测同一张图：s48x48=48x48（页面色卡是小图）、
  // jfs 原始=800x800、s800x800=800x800。只去 .avif 而不去前缀，等于把 48x48 小图存下来。
  s = s.replace(/\/s\d+x\d+_(jfs\/)/i, '/$1');
  return s.replace(/(?:\.avif)+(?=$|\?)/gi, '').replace(/!cc_\d+x\d+\.(?:jpe?g|png|webp)(?=$|\?)/gi, '');
}

var DetailCollector = {
  // 拦截到的原始数据存储
  interceptedData: {},

  // 是否已注入拦截器
  interceptorInjected: false,

  // 公开 DOM 事件无法证明发送方身份；这里只接受当前页面同平台、有限大小的被动响应。
  _isTrustedInterceptDetail(detail) {
    if (!detail || ['detail', 'sku', 'review'].indexOf(detail.type) < 0 || !detail.url || !detail.data || typeof detail.data !== 'object') return false;
    function family(host) {
      host = String(host || '').toLowerCase();
      // v1.2.298：名单外平台连网络拦截器都不挂（host 粒度）
      try { var PFfa = window.AisPlatforms; if (PFfa && PFfa.allowed && !PFfa.allowed(host)) return ''; } catch (ePFfa) {}
      var groups = {
        jd:['jd.com','3.cn','jdcloud.com','360buyimg.com'], taobao:['taobao.com','tmall.com'],
        pdd:['pinduoduo.com','yangkeduo.com'], alibaba:['1688.com','alibaba.com'],
        // v1.2.284 亚马逊（多站点；图片走官方载荷，见 lib/amazon.js）
        amazon:['amazon.com','amazon.co.uk','amazon.de','amazon.fr','amazon.it','amazon.es','amazon.co.jp','amazon.ca','amazon.com.mx','amazon.com.au','amazon.in','amazon.nl','amazon.se','amazon.pl','amazon.sg','amazon.ae','amazon.com.br','amazon.com.tr','amazon.sa','amazon.cn','amzn.com']
      };
      function hit(s) { return host === s || host.endsWith('.' + s); }
      for (var name in groups) if (groups[name].some(hit)) return name;
      return '';
    }
    try {
      var eventUrl = new URL(detail.url, window.location.href);
      if (!/^https?:$/.test(eventUrl.protocol) || !family(window.location.hostname) || family(eventUrl.hostname) !== family(window.location.hostname)) return false;
      return JSON.stringify(detail.data).length <= 1048576;
    } catch(e) { return false; }
  },

  // 商品ID
  itemId: null,

  // 调试日志
  debugLogs: [],

  // 用户停止标志（详情/评论采集可被终止）
  _stopped: false,

  // 暂停/恢复
  stopCollection() { this._stopped = true; },
  resetStopped() { this._stopped = false; },

  // 可中断等待：每200ms检查是否停止，停止则立即返回（让"停止采集"立即生效）
  _interruptibleWait(ms) {
    var self = this;
    return new Promise(function(resolve) {
      var start = Date.now();
      var t = setInterval(function() {
        if (Date.now() - start >= ms || self._stopped) { clearInterval(t); resolve(); }
      }, 200);
    });
  },

  // 记录调试日志（同时写入页面 DOM 隐藏区，供测试时读取定位断点）
  log(stage, message, data) {
    const log = {
      stage: stage,
      message: message,
      data: data || null,
      timestamp: new Date().toISOString()
    };
    this.debugLogs.push(log);
    try { console.log(`[DetailCollector][${stage}] ${message}`, data || ''); } catch(_){}
    try {
      // 调试日志挂载到 shadow root 内（反爬：不在页面 DOM 留下痕迹）；无 shadow 时仅保留内存日志
      var _sh = (typeof window !== 'undefined') ? (window.__AIS_SHADOW__ || null) : null;
      if (_sh) {
        var el = _sh.getElementById('dc-log');
        if (!el) { el = document.createElement('pre'); el.id='dc-log'; el.style.cssText='position:fixed;top:0;left:0;opacity:0;pointer-events:none;z-index:-99999;display:block;'; _sh.appendChild(el); }
        if (el) {
          var line = '[DetailCollector][' + stage + '] ' + message + (data ? ' ' + JSON.stringify(data).slice(0,200) : '');
          el.textContent = (el.textContent ? el.textContent + '\n' : '') + line;
          var _l = el.textContent.split('\n'); if(_l.length > 300) el.textContent = _l.slice(-300).join('\n');
        }
      }
    } catch(e) {}
    return log;
  },

  // 获取调试日志
  getDebugLogs() {
    return this.debugLogs;
  },

  // 统一评论评分：仅确认到 1-5 星才返回；缺失保持 0，禁止猜成 5 星
  normalizeReviewRating(source) {
    if (source == null) return 0;
    var obj = typeof source === 'object' ? source : { value: source };
    var fields = ['commentScore', 'score', 'rating', 'star', 'userStar', 'starLevel', 'rate', 'grade', 'sellerRate', 'displayRate', 'value'];
    for (var i = 0; i < fields.length; i++) {
      var raw = obj[fields[i]];
      if (raw == null || raw === '') continue;
      var text = String(raw).trim();
      var num = Number(text);
      if (Number.isFinite(num) && num >= 1 && num <= 5) return Math.round(num);
      var starMatch = text.match(/([1-5])[ \t]*(?:星|star)/i);
      if (starMatch) return parseInt(starMatch[1], 10);
      if (/差评|不满意|negative|bad/i.test(text)) return 1;
      if (/中评|一般|neutral/i.test(text)) return 3;
      if (/好评|满意|positive|good/i.test(text)) return 5;
    }
    var rateType = obj.rateType != null ? String(obj.rateType).toLowerCase() : '';
    if (rateType === '-1' || /bad|negative|差评/.test(rateType)) return 1;
    if (rateType === '0' || /neutral|中评/.test(rateType)) return 3;
    if (rateType === '1' || /good|positive|好评/.test(rateType)) return 5;
    return 0;
  },


  // 判断一条评论是否差评：星级优先，无星级时用差评关键词识别内容
  isNegativeReview(review) {
    var rating = parseInt(review && review.rating);
    if (!isNaN(rating)) {
      if (rating <= 2) return true;   // 1-2 星 = 差评
      if (rating >= 3) return false;  // 3 星中评 / 4-5 星好评，都不算差评
    }
    var text = ((review && (review.content || '')) + ' ' + (review && (review.appendContent || ''))).toLowerCase();
    // 精确差评关键词（避免"质量很好/不错"等好评句因含"质量/差"被误判）
    var NEG = ['差评','假货','假冒','破损','坏了','开裂','裂开','掉色','异味','过敏','不能用','不能开机','退货','退款','垃圾','骗人','虚假','与描述不符','山寨','翻新','不满意','不推荐','客服态度差','失望','质量差','有质量问题','很差','太差','极差','很差劲','质量烂','很烂','损坏'];
    for (var i = 0; i < NEG.length; i++) { if (text.indexOf(NEG[i]) > -1) return true; }
    return false;
  },

  // 清除调试日志
  clearDebugLogs() {
    this.debugLogs = [];
  },

  // 初始化
  async init() {
    this.clearDebugLogs();
    this.log('init', '开始初始化详情页采集器');

    this.itemId = this.extractItemIdFromUrl();
    if (!this.itemId) {
      this.log('init', '未在URL中找到商品ID');
      return { success: false, error: '未在URL中找到商品ID' };
    }
    this.log('init', `提取到商品ID: ${this.itemId}`);

    // 注入网络请求拦截器（异步：优先通过 background worker 注入以绕过 CSP）
    if (!this.interceptorInjected) {
      await this.injectInterceptor();
      this.interceptorInjected = true;
      this.log('init', '已注入网络请求拦截器');
    }

    return { success: true, itemId: this.itemId };
  },

  // 从URL提取商品ID
  extractItemIdFromUrl() {
    const url = window.location.href;
    // 淘宝详情页URL格式: item.taobao.com/item.htm?id=123456
    // 京东详情页URL格式: item.jd.com/100012345.html
    // 1688详情页URL格式: detail.1688.com/offer/123456.html
    // 拼多多详情页URL格式: yangkeduo.com/goods.html?goods_id=123456
    const match = url.match(/[?&]id=(\d+)/) || url.match(/\/item\/(\d+)/) ||
                  url.match(/[?&]itemId=(\d+)/) || url.match(/item\.jd\.com\/(\d+)/) ||
                  url.match(/\/offer\/(\d+)/) || url.match(/[?&]goods_id=(\d+)/) ||
                  url.match(/[?&]product_id=(\w+)/) || url.match(/\/goods\/(\w+)/);
    return match ? match[1] : null;
  },

  // 判断是否为商品详情页
  // 注意：使用 hostname 而非 href，避免登录页 redirectURL 参数中的 item.taobao.com 导致误判
  isDetailPage() {
    var host = window.location.hostname;
    // v1.2.298 平台白名单：名单外平台不采集（远程 flags 控制，无需发版）
    try { var PFdc = window.AisPlatforms; if (PFdc && PFdc.allowed && !PFdc.allowed(host)) return false; } catch (ePFdc) {}
    var path = window.location.pathname;
    // 登录页/中间页：不是详情页（全平台过滤）
    if (/login\.taobao\.com|login\.tmall\.com|login\.jd\.com|passport\.jd\.com|login\.pinduoduo\.com|login\.1688\.com/.test(host) || /^login\./.test(host)) {
      return false;
    }
    // v1.2.284 亚马逊：/dp/<ASIN>、/gp/product/<ASIN>、/product/<ASIN>（用官方解析，兼容多站点与重写过的 URL）
    try {
      var __AZ = window.__AIS_AMAZON__;
      if (__AZ && __AZ.asinFromUrl && __AZ.asinFromUrl(window.location.href)) return true;
    } catch (eAZ) {}
    // 淘宝/天猫/京东/拼多多/1688 详情页（基于 hostname 判断）
    return /item\.taobao\.com|detail\.tmall\.com|item\.tmall\.com|item\.jd\.com|item\.m\.jd\.com/.test(host) ||
           /yangkeduo\.com\/goods\.html|pinduoduo\.com\/goods|detail\.1688\.com|1688\.com\/offer/.test(host + path);
  },

  // 登录状态检测：检查当前页面是否处于已登录状态
  // 京东/淘宝等平台未登录时会跳转到登录页或显示登录提示
  checkLoginStatus() {
    var url = window.location.href;
    var host = window.location.hostname;
    var bodyText = (document.body && document.body.innerText) || '';

    // 1. URL是否跳转到了登录页
    if (/passport\.jd\.com|login\.jd\.com|login\.taobao\.com|login\.tmall\.com|login\.pinduoduo\.com|login\.1688\.com/.test(host)) {
      return { loggedin: false, platform: this._getPlatformName(), hint: 'URL跳转到了登录页' };
    }

    // 2. 京东登录状态检测
    if (host.indexOf('jd.com') > -1) {
      // 京东未登录标志：页面包含"你好，请登录"
      if (bodyText.indexOf('请登录') > -1 && bodyText.indexOf('你好') > -1) {
        return { loggedin: false, platform: '京东', hint: '页面显示"请登录"' };
      }
      // 检查是否有用户昵称元素（已登录标志）
      var nickEl = document.querySelector(aisSel('common.reviewUser', '.nickname, .user-name, [class*="userInfo"] [class*="name"]'));
      if (nickEl) {
        var nickText = nickEl.textContent.trim();
        if (nickText && !/登录|注册/.test(nickText)) {
          return { loggedin: true, platform: '京东' };
        }
      }
      // 京东API响应中检测：detailResponse.isLogin
      if (this._interceptedData && this._interceptedData.detailResponse) {
        var dr = this._interceptedData.detailResponse;
        if (dr.isLogin === false || dr.isLogin === 0) {
          return { loggedin: false, platform: '京东', hint: 'API响应显示未登录' };
        }
        if (dr.isLogin === true || dr.isLogin === 1 || dr.isLogin === '1') {
          return { loggedin: true, platform: '京东' };
        }
      }
      // 默认认为已登录（不阻塞采集）
      return { loggedin: true, platform: '京东' };
    }

    // 3. 淘宝/天猫登录状态检测
    if (host.indexOf('taobao.com') > -1 || host.indexOf('tmall.com') > -1) {
      // 淘宝未登录标志：URL包含login，或页面包含"请登录"
      if (url.indexOf('login') > -1 && url.indexOf('redirect') > -1) {
        return { loggedin: false, platform: '淘宝/天猫', hint: 'URL包含login重定向' };
      }
      // 检查是否有登录元素
      if (bodyText.indexOf('请登录') > -1 && bodyText.indexOf('免费注册') > -1) {
        return { loggedin: false, platform: '淘宝/天猫', hint: '页面显示"请登录"' };
      }
      return { loggedin: true, platform: '淘宝/天猫' };
    }

    // 4. 其他平台：默认已登录
    return { loggedin: true, platform: this._getPlatformName() };
  },

  // 获取平台名称
  _getPlatformName() {
    var host = window.location.hostname;
    if (host.indexOf('jd.com') > -1) return '京东';
    if (host.indexOf('taobao.com') > -1) return '淘宝';
    if (host.indexOf('tmall.com') > -1) return '天猫';
    if (host.indexOf('pinduoduo.com') > -1 || host.indexOf('yangkeduo.com') > -1) return '拼多多';
    if (host.indexOf('1688.com') > -1) return '1688';
    if (/(^|\.)amazon\.[a-z.]{2,}$/i.test(host) || /(^|\.)amzn\.com$/i.test(host)) return '亚马逊';   // v1.2.284
    return '';
  },

  // 注入网络请求拦截器
  // 注意：MV3 隔离世界限制 - 注入的 script 运行在主世界，content script 运行在隔离世界
  // window.__ssrCache__ 在主世界设置，隔离世界不可见
  // 解决方案：使用 CustomEvent 跨世界传递拦截数据
  // CSP 问题：京东等平台 CSP 阻止 inline script，需通过 background worker 用 chrome.scripting.executeScript 注入
  async injectInterceptor() {
    // 先在隔离世界注册事件监听器，接收主世界派发的拦截数据
    if (!this._interceptListenerRegistered) {
      this._interceptedData = {
        detailResponse: null,
        skuResponse: null,
        reviewResponse: null,
        allResponses: []
      };
      window.addEventListener('ssr:ready', function(e) {
        try {
          var detail = e.detail;
          if (!DetailCollector._isTrustedInterceptDetail(detail)) return;
          // 存储到隔离世界的本地对象
          if (detail.type === 'detail' && detail.data) {
            DetailCollector._interceptedData.detailResponse = detail.data;
          } else if (detail.type === 'sku' && detail.data) {
            DetailCollector._interceptedData.skuResponse = detail.data;
          } else if (detail.type === 'review' && detail.data) {
            DetailCollector._interceptedData.reviewResponse = detail.data;
          }
          if (detail.url && detail.data) {
            var _arr = DetailCollector._interceptedData.allResponses;
            if (_arr.length > 200) _arr.shift();
            _arr.push({
              url: detail.url,
              data: detail.data,
              timestamp: Date.now()
            });
          }
        } catch(err) {
          console.warn('[电商采集大师] 处理拦截事件失败:', err);
        }
      });
      this._interceptListenerRegistered = true;
    }

    // 方案1（优先）：通过 background worker 用 chrome.scripting.executeScript 注入主世界拦截器
    // 此方案绕过页面 CSP 限制（京东/淘宝等平台 CSP 阻止 inline script）
    var workerSuccess = false;
    try {
      var resp = await new Promise(function(resolve) {
        var done = false;
        // 超时保护：5秒内无响应则回退到 inline script
        var timer = setTimeout(function() {
          if (!done) {
            done = true;
            console.warn('[电商采集大师] worker注入超时(5s)，回退到inline script');
            resolve({ success: false, error: 'worker注入超时' });
          }
        }, 5000);
        try {
          chrome.runtime.sendMessage({ action: 'injectInterceptor' }, function(r) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              console.warn('[电商采集大师] worker注入通信失败:', chrome.runtime.lastError.message);
              resolve({ success: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(r || { success: false });
            }
          });
        } catch(e) {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve({ success: false, error: e.message });
          }
        }
      });
      workerSuccess = !!(resp && resp.success);
      if (workerSuccess) {
        this.log('init', '主世界拦截器已通过background worker注入（绕过CSP）');
      } else {
        this.log('init', 'worker注入失败，回退到inline script', { error: resp && resp.error });
      }
    } catch(e) {
      this.log('init', 'worker注入异常，回退到inline script', { error: e.message });
    }

    // 方案2（兜底）：inline script 注入（CSP 不严格时有效，如淘宝）
    if (!workerSuccess) {
      this.injectInlineInterceptor();
    }
  },

  // inline script 方式注入拦截器（兜底方案，CSP 不严格时有效）
  injectInlineInterceptor() {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        if (window.__ssrCache__) {
          console.log('[电商采集大师] 拦截器已存在(inline)，跳过');
          return;
        }
        // 存储原始方法
        const OriginalFetch = window.fetch;
        const OriginalXHRSend = XMLHttpRequest.prototype.send;

        // 存储拦截数据的全局对象（主世界，仅用于调试）
        window.__ssrCache__ = window.__ssrCache__ || {
          detailResponse: null,
          skuResponse: null,
          reviewResponse: null,
          allResponses: []
        };

        // 跨世界通信：通过 CustomEvent 将拦截数据发送到隔离世界（content script）
        function notifyContentScript(type, url, data) {
          try {
            var event = new CustomEvent('ssr:ready', {
              detail: { type: type, url: url, data: data }
            });
            window.dispatchEvent(event);
          } catch(e) {}
        }

        // 判断URL是否为电商API请求（全平台：淘宝/天猫/京东/拼多多/1688）
        function isEcommerceApi(url) {
          if (typeof url !== 'string') return false;
          return url.includes('taobao.com') || url.includes('tmall.com') ||
                 url.includes('jd.com') || url.includes('3.cn') ||
                 url.includes('jdcloud.com') || url.includes('360buyimg.com') ||
                 url.includes('pinduoduo.com') || url.includes('yangkeduo.com') ||
                 url.includes('1688.com') || url.includes('alibaba.com');
        }

        // 根据URL特征分类响应（全平台）
        function classifyResponse(url, json) {
          if (!url || !json) return;
          var data = window.__ssrCache__;
          if (data.allResponses.length > 200) data.allResponses.shift();
          data.allResponses.push({url: url, data: json, timestamp: Date.now()});

          var interceptType = null;

          // 京东 API 分类
          if (url.includes('jd.com') || url.includes('3.cn')) {
            // 京东商品详情API: wareBusiness 是主商品信息（含colorSize/SKU名称/参数）
            if (url.includes('wareBusiness') || url.includes('pc_detailpage') || url.includes('item-soa')) {
              data.detailResponse = json;
              interceptType = 'detail';
            }
            // 京东价格API
            else if (url.includes('p.3.cn') || url.includes('prices')) {
              if (!data.detailResponse) { data.detailResponse = json; interceptType = 'detail'; }
            }
            // 京东评论API（含v3新版接口）
            else if (url.includes('getLegoWareDetailComment') || url.includes('club.jd') ||
                     url.includes('productPageComments') || url.includes('commentList') ||
                     url.includes('productCommentSummaries')) {
              data.reviewResponse = json;
              interceptType = 'review';
            }
            // 京东SKU/规格
            else if (url.includes('cdnware') || url.includes('getStockState') ||
                     url.includes('sku') || url.includes('colorSize') || url.includes('stockState')) {
              data.skuResponse = json;
              interceptType = 'sku';
            }
            // queryPlusInfo 可能包含价格
            else if (url.includes('queryPlusInfo')) {
              if (!data.detailResponse) { data.detailResponse = json; interceptType = 'detail'; }
            }
          }
          // 淘宝/天猫 API 分类
          else if (url.includes('taobao.com') || url.includes('tmall.com')) {
            if (url.includes('sku') || url.includes('spec')) {
              data.skuResponse = json;
              interceptType = 'sku';
            } else if (url.includes('review') || url.includes('comment') || url.includes('rate')) {
              data.reviewResponse = json;
              interceptType = 'review';
            } else if (url.includes('detail') || url.includes('iteminfo') || url.includes('getItemInfo') ||
                       url.includes('h5api.m.tmall.com') || url.includes('h5api.m.taobao.com')) {
              data.detailResponse = json;
              interceptType = 'detail';
            }
          }
          // 拼多多 API 分类
          else if (url.includes('pinduoduo.com') || url.includes('yangkeduo.com')) {
            if (url.includes('review') || url.includes('comment') || url.includes('rate')) {
              data.reviewResponse = json;
              interceptType = 'review';
            } else if (url.includes('sku') || url.includes('spec') || url.includes('goods')) {
              data.skuResponse = json;
              interceptType = 'sku';
            } else {
              data.detailResponse = json;
              interceptType = 'detail';
            }
          }
          // 1688 API 分类
          else if (url.includes('1688.com') || url.includes('alibaba.com')) {
            if (url.includes('review') || url.includes('comment') || url.includes('rate')) {
              data.reviewResponse = json;
              interceptType = 'review';
            } else if (url.includes('sku') || url.includes('spec')) {
              data.skuResponse = json;
              interceptType = 'sku';
            } else if (url.includes('detail') || url.includes('offer') || url.includes('productinfo')) {
              data.detailResponse = json;
              interceptType = 'detail';
            }
          }

          // 通过 CustomEvent 将拦截结果发送到隔离世界
          if (interceptType) {
            notifyContentScript(interceptType, url, json);
          }
        }

        // Hook Fetch
        window.fetch = function(...args) {
          return OriginalFetch.apply(this, args).then(async function(response) {
            // 兼容 fetch(new Request(url), options) 形式
            var url = '';
            if (args[0] instanceof Request) url = args[0].url || '';
            else if (typeof args[0] === 'string') url = args[0];
            if (isEcommerceApi(url)) {
              try {
                const clone = response.clone();
                const text = await clone.text();
                try {
                  const json = JSON.parse(text);
                  classifyResponse(url, json);
                } catch(e) {
                  // 非JSON，尝试jsonp提取
                  if (text && text.length > 20) {
                    var m = text.match(/\\{[\\s\\S]+\\}/);
                    if (m) {
                      try { classifyResponse(url, JSON.parse(m[0])); } catch(e2) {}
                    }
                  }
                }
              } catch(e) {}
            }
            return response;
          });
        };

        // Hook XMLHttpRequest
        XMLHttpRequest.prototype.send = function(...args) {
          const self = this;
          self.addEventListener('load', function() {
            const url = self._url || '';
            if (isEcommerceApi(url)) {
              try {
                const text = self.responseText || '';
                try {
                  const json = JSON.parse(text);
                  classifyResponse(url, json);
                } catch(e) {
                  // 尝试jsonp提取
                  if (text && text.length > 20) {
                    var m = text.match(/\\{[\\s\\S]+\\}/);
                    if (m) {
                      try { classifyResponse(url, JSON.parse(m[0])); } catch(e2) {}
                    }
                  }
                }
              } catch(e) {}
            }
          });
          return OriginalXHRSend.apply(this, args);
        };

        // 存储URL到XHR实例
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
          this._url = url;
          return originalOpen.apply(this, arguments);
        };

        console.log('[电商采集大师] 网络请求拦截器已注入(inline，支持淘宝/天猫/京东，CustomEvent跨世界通信）');
      })();
    `;

    // document_start 时 document.head 可能不存在，使用 document.documentElement
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  },

  // 等待网络请求响应
  // 从隔离世界的本地存储读取（由 CustomEvent 从主世界传递过来）
  // type 参数为完整字段名: 'detailResponse' / 'skuResponse' / 'reviewResponse'
  waitForResponse(type, timeout = 5000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        // 优先从隔离世界本地存储读取（CustomEvent 通道）
        var localData = this._interceptedData;
        if (localData && localData[type]) {
          resolve(localData[type]);
          return;
        }
        if (Date.now() - start > timeout) {
          resolve(null);
          return;
        }
        setTimeout(check, 200);
      };
      check();
    });
  },

  // 提取商品完整数据
  async extractDetailData(options) {
    options = options || {};
    var collectAllReviews = options.collectAllReviews !== false; // 默认采集全部评论
    var collectReviewImages = options.collectReviewImages !== false; // 默认采集评论图片
    var collectReviews = options.collectReviews !== false; // 默认采集评论
    // v1.1.172：京东评论采集已下线——京东强制不采评论
    if (typeof location !== 'undefined' && /jd\.com|3\.cn/.test(location.href)) collectReviews = false;
    var collectSkus = options.collectSkus !== false; // 默认采集SKU
    var collectParameters = options.collectParameters !== false; // 默认采集参数
    var collectMainImages = options.collectMainImages !== false; // 默认采集主图
    var collectDescImages = options.collectDescImages !== false; // 默认采集详情图
    var reviewLimit = options.reviewLimit || 0; // 0=不限（按条数截断，采集后）
    var reviewPageLimit = options.reviewPageLimit || 0; // 0=不限（按页数限制，采集中）
    var reviewSpeed = options.reviewSpeed || 'normal'; // 采集速度：slow/normal/fast（防反爬）

    // 联动：评论关闭时，强制关闭评论图片和全部评论
    if (!collectReviews) {
      collectReviewImages = false;
      collectAllReviews = false;
    }

    // 保护性调用：若 itemId 未初始化（如测试钩子直接调用），先尝试提取
    if (!this.itemId) {
      this.itemId = this.extractItemIdFromUrl();
      this.log('extract', '保护性提取 itemId', { itemId: this.itemId });
    }

    // 保护性注入拦截器（若未注入，如测试钩子直接调用 extractDetailData）
    if (!this.interceptorInjected) {
      await this.injectInterceptor();
      this.interceptorInjected = true;
      this.log('extract', '保护性注入网络请求拦截器');
    } else if (!this._interceptedData || (
      !this._interceptedData.detailResponse &&
      !this._interceptedData.skuResponse &&
      !this._interceptedData.reviewResponse &&
      this._interceptedData.allResponses.length === 0
    )) {
      // 已标记注入但无拦截数据，可能注入失败，重试一次
      this.log('extract', '拦截器已标记但无拦截数据，重新注入');
      await this.injectInterceptor();
    }

    if (!this.isDetailPage()) {
      this.log('extract', '当前页面不是商品详情页');
      return { success: false, error: '当前页面不是商品详情页' };
    }

    // 登录状态检测：京东/淘宝等平台未登录时会跳转到登录页，导致采集失败
    var loginCheck = this.checkLoginStatus();
    if (!loginCheck.loggedin) {
      this.log('extract', '登录状态检测：未登录', { platform: loginCheck.platform, hint: loginCheck.hint });
      return { success: false, error: '登录已失效，请重新登录' + (loginCheck.platform ? loginCheck.platform : '') + '后再次采集', loginRequired: true };
    }
    this.log('extract', '登录状态检测：已登录', { platform: loginCheck.platform });

    // 反爬检测：检测到风控页面时停止采集，提醒用户
    if (typeof AntiCrawl !== 'undefined') {
      var antiCrawl = AntiCrawl.detectAntiCrawl();
      if (antiCrawl.detected) {
        this.log('extract', '反爬检测：触发风控', antiCrawl);
        return {
          success: false,
          error: '检测到反爬验证页面！\n\n类型：' + antiCrawl.type + '\n\n请放慢采集速度，完成人工验证后再试。\n建议：间隔30秒以上再进行下一次采集。',
          antiCrawl: true,
          antiCrawlType: antiCrawl.type
        };
      }
    }

    // 通知 background worker 记录平台活跃（用于会话保活）
    try { chrome.runtime.sendMessage({ action: 'trackPlatform' }); } catch(e) {}

    this.log('extract', '开始提取商品详情数据', {
      url: window.location.href,
      collectAllReviews: collectAllReviews, collectReviewImages: collectReviewImages,
      collectReviews: collectReviews, collectSkus: collectSkus,
      collectParameters: collectParameters, collectMainImages: collectMainImages,
      collectDescImages: collectDescImages, reviewLimit: reviewLimit
    });

    // 等待必要的网络请求
    this.log('extract', '等待网络请求响应...');
    const [detailResponse, skuResponse, reviewResponse] = await Promise.all([
      this.waitForResponse('detailResponse', 3000),
      this.waitForResponse('skuResponse', 3000),
      this.waitForResponse('reviewResponse', 3000)
    ]);
    
    this.log('extract', '网络请求等待完成', {
      hasDetailResponse: !!detailResponse,
      hasSkuResponse: !!skuResponse,
      hasReviewResponse: !!reviewResponse
    });

    // 同时从DOM提取基础信息
    this.log('extract', '开始从DOM提取基础信息...');
    // v1.2.314：先做有界滚动预热触发详情图懒加载，再同步提取（否则只拿到占位/已加载的 1~2 张）
    if (collectDescImages) { try { await this.warmDescLazyImages(); } catch (eWarm2) {} }
    // v1.2.316：DOM 提取加固 + 诊断暴露
    // 详情图采集不全排查时无法区分「没采到」与「DOM 提取抛异常被吞」。现包 try/catch：
    // ① DOM 异常不再拖垮整条链路（API 数据仍可用）；② 暴露 window.__AIS_DESC_INFO__ 供定位。
    let domData = {};
    try {
      domData = this.extractFromDOM();
    } catch (eDom) {
      this.log('dom', 'DOM提取异常(已降级，保留API数据): ' + ((eDom && eDom.message) || eDom));
      try { window.__AIS_DOM_ERR__ = String((eDom && eDom.message) || eDom); } catch (eX) {}
    }
    try {
      window.__AIS_DESC_INFO__ = {
        descImages: (domData.descImages || []).length,
        descHtmlLen: (domData.descHtml || '').length,
        mainImages: (domData.images || []).length,
        err: window.__AIS_DOM_ERR__ || ''
      };
    } catch (eY) {}

    // 合并数据（DOM作为基础，源端数据优先覆盖）
    const result = {
      itemId: this.itemId,
      url: window.location.href,
      timestamp: new Date().toISOString(),
      basic: domData.basic || {},
      skus: [],
      parameters: [],
      reviews: [],
      images: collectMainImages ? (domData.images || []) : [],
      description: collectDescImages ? (domData.description || '') : '',
      descHtml: collectDescImages ? (domData.descHtml || '') : '',
      descImages: collectDescImages ? (domData.descImages || []) : []
    };

    // ===== v1.2.284 亚马逊：优先读官方载荷（ImageBlockATF/BTF） =====
    // 实测 amazon.com/dp/B01GJOMWVA：DOM 只给 8 张（6 张缩略图），载荷里直接写着 14 张 hiRes 原图。
    // A+ 区块（#aplus）当详情图；视频只收直链 mp4（亚马逊有 HLS .m3u8，当 mp4 存会得到 699 字节文本）。
    var __amz = null;
    try {
      var AZ = window.__AIS_AMAZON__;
      if (AZ && AZ.asinFromUrl && AZ.asinFromUrl(window.location.href)) {
        var atf = []; try { atf = AZ.readAtfFromRoot(document) || []; } catch (e1) {}
        var btf = null; try { btf = AZ.readBtfFromRoot(document) || null; } catch (e2) {}
        var mainUrls = [];
        (atf || []).forEach(function (x) { var u = x && (x.hiRes || x.large || x.thumb); if (u && mainUrls.indexOf(u) < 0) mainUrls.push(u); });
        var varImgs = [];
        try { (AZ.variantsFromBtf(btf) || []).forEach(function (v) { if (v && v.image && mainUrls.indexOf(v.image) < 0 && varImgs.indexOf(v.image) < 0) varImgs.push(v.image); }); } catch (e3) {}
        var aplus = [];
        try {
          var abox = document.querySelector('#aplus, #aplus_feature_div, .aplus-v2, #aplus3p_feature_div');
          if (abox) Array.prototype.forEach.call(abox.querySelectorAll('img'), function (im) {
            var u = im.getAttribute('data-src') || im.getAttribute('src') || '';
            if (u && u.indexOf('data:') !== 0 && u.indexOf('sprite') < 0 && aplus.indexOf(u) < 0) aplus.push(u);
          });
        } catch (e4) {}
        var vids = [];
        try { (AZ.videosFromBtf(btf) || []).forEach(function (v) { if (v && v.url && /\.mp4(\?|$)/i.test(v.url) && vids.indexOf(v.url) < 0) vids.push(v.url); }); } catch (e5) {}
        __amz = { main: mainUrls, variantImgs: varImgs, aplus: aplus, video: vids[0] || '', asin: AZ.asinFromUrl(window.location.href) };
        this.log('extract', '亚马逊载荷：主图 ' + mainUrls.length + ' · 变体图 ' + varImgs.length + ' · A+ ' + aplus.length + ' · 视频 ' + vids.length);
      }
    } catch (eAZ2) {}
    if (__amz) {
      result.amazon = __amz;
      result.itemId = result.itemId || __amz.asin;
      if (collectMainImages && __amz.main.length) result.images = __amz.main.concat(__amz.variantImgs);
      if (collectDescImages && __amz.aplus.length) result.descImages = __amz.aplus;
    }

    // 从源端（拦截的API响应）解析全平台数据，覆盖DOM结果
    // 复用 isDetailPage() 避免规则双重维护（覆盖淘宝/天猫/京东/拼多多/1688）
    var isEcomDetail = this.isDetailPage();
    if (isEcomDetail) {
      this.log('extract', '全平台：从源端API响应解析数据...');
      // 修复：parseApiResponse 包 try/catch，避免单条异常丢弃整个 DOM 采集结果
      var apiData = { basic: {}, images: [], skus: [], parameters: [], reviews: [] };
      try { apiData = this.parseApiResponse(detailResponse, skuResponse, reviewResponse); }
      catch (e) { this.log('api', 'parseApiResponse 异常，回退 DOM 数据: ' + (e && e.message)); }
      if (apiData.basic) {
        // 源端数据优先覆盖
        Object.keys(apiData.basic).forEach(function(k){
          if (apiData.basic[k]) result.basic[k] = apiData.basic[k];
        });
      }
      if (collectMainImages && apiData.images && apiData.images.length > 0) result.images = apiData.images;
      if (collectSkus && apiData.skus && apiData.skus.length > 0) result.skus = apiData.skus;
      if (collectParameters && apiData.parameters && apiData.parameters.length > 0) result.parameters = apiData.parameters;
      if (collectReviews && apiData.reviews && apiData.reviews.length > 0) result.reviews = apiData.reviews;
      this.log('extract', '源端数据解析完成', {
        basicKeys: apiData.basic ? Object.keys(apiData.basic) : [],
        skuCount: (apiData.skus||[]).length,
        reviewCount: (apiData.reviews||[]).length,
        imgCount: (apiData.images||[]).length
      });
    }

    // 京东兜底：如果价格/店铺/SKU/参数/评论为空，直接请求京东API获取
    // 拦截器因 run_at=document_idle 可能错过页面加载时的API请求
    if (location.href.indexOf('jd.com') > -1 && this.itemId) {
      var needJdFallback = !result.basic.price || !result.basic.shopName ||
                           (collectSkus && result.skus.length === 0) ||
                           (collectParameters && result.parameters.length === 0) ||
                           (collectReviews && result.reviews.length === 0);
      if (needJdFallback) {
        this.log('extract', '京东兜底：部分数据缺失，直接请求京东API', {
          hasPrice: !!result.basic.price,
          hasShop: !!result.basic.shopName,
          skuCount: result.skus.length,
          paramCount: result.parameters.length,
          reviewCount: result.reviews.length
        });
        try {
          var jdDetail = await this.fetchJdDetailDirectly(this.itemId);
          if (jdDetail) {
            // 从详情API补充价格、店铺、参数等
            var d = jdDetail;
            // 价格
            if (!result.basic.price && d.price) {
              if (typeof d.price === 'object') {
                if (d.price.p) result.basic.price = String(d.price.p);
                else if (d.price.price) result.basic.price = String(d.price.price);
                if (d.price.op) result.basic.originalPrice = String(d.price.op);
              } else {
                result.basic.price = String(d.price);
              }
            }
            if (!result.basic.price && d.jdPrice) result.basic.price = String(d.jdPrice);
            if (!result.basic.price && d.p && d.p !== '无价') result.basic.price = String(d.p);
            // 店铺
            if (!result.basic.shopName && d.shopName) result.basic.shopName = d.shopName;
            if (!result.basic.shopName && d.brand) result.basic.shopName = d.brand;
            if (!result.basic.shopName && d.price && typeof d.price === 'object' && d.price.m) {
              result.basic.shopName = d.price.m;
            }
            // 参数
            if (collectParameters && result.parameters.length === 0 && d.productAttributeVO) {
              var coreAttrs = d.productAttributeVO.coreAttributes || [];
              coreAttrs.forEach(function(a) {
                if (a && a.labelName && a.labelValue) {
                  result.parameters.push({ name: a.labelName, value: a.labelValue });
                }
              });
              this.log('extract', '京东API补充参数', { count: result.parameters.length });
            }
            // SKU: 从 colorSize 提取
            if (collectSkus && result.skus.length === 0) {
              var colorSize = d.colorSize || (d.data && d.data.colorSize) || {};
              var skuList = colorSize.sku || colorSize.skuList || [];
              if (Array.isArray(skuList) && skuList.length > 0) {
                skuList.forEach(function(s) {
                  if (!s || !s.skuId) return;
                  var parts = [];
                  if (s.color) parts.push(s.color);
                  if (s.size) parts.push(s.size);
                  if (s.version) parts.push(s.version);
                  if (s.dim) parts.push(s.dim);
                  if (s.attributes && Array.isArray(s.attributes)) {
                    s.attributes.forEach(function(a) { if (a && a.value) parts.push(a.value); });
                  }
                  result.skus.push({
                    skuId: String(s.skuId).replace(/^J_/, ''),
                    name: parts.join(' / ') || s.name || s.title || s.skuName || '',
                    price: s.price || s.jdPrice || '',
                    stock: s.stockState || s.stock || ''
                  });
                });
                this.log('extract', '京东API补充SKU', { count: result.skus.length });
              }
            }
            // 评论数
            if (!result.basic.reviewCount && d.commentCount) {
              result.basic.reviewCount = String(d.commentCount);
            }
            this.log('extract', '京东API兜底完成', {
              price: result.basic.price, shopName: result.basic.shopName,
              skuCount: result.skus.length, paramCount: result.parameters.length
            });
          }
        } catch (e) {
          this.log('extract', '京东API兜底失败', { error: e.message });
        }
      }
    }


    // 解析SKU数据（只在 parseApiResponse 未提取到时才解析，避免覆盖）
    if (collectSkus) {
      if (result.skus.length === 0 && skuResponse) {
        this.log('extract', '从API响应解析SKU数据');
        var parsedSkus = this.parseSkuResponse(skuResponse);
        if (parsedSkus.length > 0) result.skus = parsedSkus;
      }
      // 如果没有从拦截获得SKU，从DOM解析
      if (result.skus.length === 0) {
        this.log('extract', '尝试从DOM解析SKU数据');
        result.skus = this.extractSkusFromDOM();
      }
      // 京东兜底：如果SKU名称为空（只有priceMap的price无name），从colorSizeVO/colorSize提取SKU名称
      var hasEmptySkuName = result.skus.length > 0 && result.skus.every(function(s) {
        return !s.name || s.name === '';
      });
      if (hasEmptySkuName && location.href.indexOf('jd.com') > -1 && this.itemId) {
        this.log('extract', '京东SKU名称为空，尝试从已拦截数据提取colorSizeVO/colorSize');

        // 诊断：打印 detailResponse 的结构
        if (detailResponse) {
          var topKeys = Object.keys(detailResponse).slice(0, 15);
          this.log('extract', 'detailResponse结构', {
            topKeys: topKeys,
            hasColorSize: !!detailResponse.colorSize,
            hasColorSizeVO: !!detailResponse.colorSizeVO,
            hasDataColorSize: !!(detailResponse.data && detailResponse.data.colorSize)
          });
        } else {
          this.log('extract', 'detailResponse为空');
        }

        // 方案1：从已拦截的 detailResponse 中提取 colorSizeVO（京东新版）或 colorSize（旧版）
        var jdDetail = detailResponse;

        // 构建 skuId -> name 映射
        var skuNameMap = {};

        // 京东新版：colorSizeVO.colorSizeList（属性分组结构）
        if (jdDetail && jdDetail.colorSizeVO && jdDetail.colorSizeVO.colorSizeList) {
          this.log('extract', '从colorSizeVO.colorSizeList提取SKU名称');
          var colorSizeList = jdDetail.colorSizeVO.colorSizeList;
          if (Array.isArray(colorSizeList)) {
            // colorSizeList 是属性分组数组，每个分组包含 buttons（属性选项）
            // 每个 button 有 text（属性名）和 skuList（包含该属性的SKU ID列表）
            // 需要反向构建：对每个skuId，收集它所属的所有属性名
            var skuAttrs = {}; // skuId -> [attr1, attr2, ...]
            colorSizeList.forEach(function(group) {
              if (!group || !group.buttons) return;
              group.buttons.forEach(function(btn) {
                if (!btn || !btn.text) return;
                var attrName = btn.text.trim();
                var btnSkuId = btn.skuId ? String(btn.skuId) : '';
                // 该按钮自己的 skuId 映射
                if (btnSkuId && !skuAttrs[btnSkuId]) skuAttrs[btnSkuId] = [];
                if (btnSkuId) skuAttrs[btnSkuId].push(attrName);
                // skuList 中的所有 skuId 也包含该属性
                if (btn.skuList && Array.isArray(btn.skuList)) {
                  btn.skuList.forEach(function(sid) {
                    var id = String(sid);
                    if (!skuAttrs[id]) skuAttrs[id] = [];
                    if (skuAttrs[id].indexOf(attrName) < 0) skuAttrs[id].push(attrName);
                  });
                }
              });
            });
            // 组合属性名作为SKU名称
            Object.keys(skuAttrs).forEach(function(sid) {
              var attrs = skuAttrs[sid];
              if (attrs.length > 0) {
                skuNameMap[sid] = attrs.join(' / ');
              }
            });
            this.log('extract', 'colorSizeVO映射构建完成', { mapSize: Object.keys(skuNameMap).length });
          }
        }

        // 京东旧版：colorSize.sku
        if (Object.keys(skuNameMap).length === 0 && jdDetail) {
          var colorSize = jdDetail.colorSize || (jdDetail.data && jdDetail.data.colorSize) || {};
          var skuList = colorSize.sku || colorSize.skuList || [];
          if (!Array.isArray(skuList) && Array.isArray(colorSize)) {
            skuList = colorSize;
          }
          if (Array.isArray(skuList) && skuList.length > 0) {
            skuList.forEach(function(s) {
              if (s.skuId) {
                var parts = [];
                if (s.color) parts.push(s.color);
                if (s.size) parts.push(s.size);
                if (s.version) parts.push(s.version);
                if (s.dim) parts.push(s.dim);
                if (s.attributes && Array.isArray(s.attributes)) {
                  s.attributes.forEach(function(a) {
                    if (a && a.value) parts.push(a.value);
                  });
                }
                var name = parts.join(' / ') || s.name || s.title || s.skuName || '';
                if (name) skuNameMap[String(s.skuId)] = name;
              }
            });
          }
        }

        // 方案2：如果已拦截数据无法提取，尝试直接请求API（CSP允许时）
        if (Object.keys(skuNameMap).length === 0) {
          this.log('extract', '已拦截数据无SKU名称，尝试直接请求详情API');
          try {
            var fetchedDetail = await this.fetchJdDetailDirectly(this.itemId);
            if (fetchedDetail) {
              if (fetchedDetail.colorSizeVO && fetchedDetail.colorSizeVO.colorSizeList) {
                var csList = fetchedDetail.colorSizeVO.colorSizeList;
                if (Array.isArray(csList)) {
                  var sAttrs = {};
                  csList.forEach(function(group) {
                    if (!group || !group.buttons) return;
                    group.buttons.forEach(function(btn) {
                      if (!btn || !btn.text) return;
                      var aName = btn.text.trim();
                      var bSid = btn.skuId ? String(btn.skuId) : '';
                      if (bSid && !sAttrs[bSid]) sAttrs[bSid] = [];
                      if (bSid) sAttrs[bSid].push(aName);
                      if (btn.skuList && Array.isArray(btn.skuList)) {
                        btn.skuList.forEach(function(sid) {
                          var id = String(sid);
                          if (!sAttrs[id]) sAttrs[id] = [];
                          if (sAttrs[id].indexOf(aName) < 0) sAttrs[id].push(aName);
                        });
                      }
                    });
                  });
                  Object.keys(sAttrs).forEach(function(sid) {
                    if (sAttrs[sid].length > 0) skuNameMap[sid] = sAttrs[sid].join(' / ');
                  });
                }
              } else if (fetchedDetail.colorSize) {
                var oldCs = fetchedDetail.colorSize;
                var oldList = oldCs.sku || oldCs.skuList || [];
                if (Array.isArray(oldList)) {
                  oldList.forEach(function(s) {
                    if (s.skuId) {
                      var parts = [];
                      if (s.color) parts.push(s.color);
                      if (s.size) parts.push(s.size);
                      var name = parts.join(' / ') || s.name || '';
                      if (name) skuNameMap[String(s.skuId)] = name;
                    }
                  });
                }
              }
            }
          } catch (e) {
            this.log('extract', '直接请求京东详情API失败', { error: e.message });
          }
        }

        // 方案3：从DOM提取SKU名称（京东新版 .specification-item-sku）
        if (Object.keys(skuNameMap).length === 0) {
          this.log('extract', 'API无SKU名称，从DOM .specification-item-sku 提取');
          var domSkus = this.extractJdSkuFromDOM();
          if (domSkus.length > 0) {
            // 如果DOM提取到SKU（含名称），直接替换空名称SKU
            domSkus.forEach(function(ds) {
              if (ds.skuId && ds.name) skuNameMap[String(ds.skuId)] = ds.name;
            });
            // 如果DOM SKU有价格，也更新价格
            if (domSkus.length > 0 && result.skus.every(function(s){return !s.price;})) {
              result.skus = domSkus;
            }
          }
        }

        // 更新已有SKU的名称
        if (Object.keys(skuNameMap).length > 0) {
          var updated = 0;
          result.skus.forEach(function(sku) {
            var rawId = String(sku.skuId || '').replace(/^J_/, '');
            if (skuNameMap[rawId]) {
              sku.name = skuNameMap[rawId];
              updated++;
            }
          });
          this.log('extract', 'SKU名称补全', { total: result.skus.length, updated: updated, nameMapSize: Object.keys(skuNameMap).length });
        }
      }
      // SKU去重：J_前缀的和非J_前缀的可能是同一个SKU
      if (result.skus.length > 0 && location.href.indexOf('jd.com') > -1) {
        var seenSkuIds = {};
        var dedupedSkus = [];
        result.skus.forEach(function(s) {
          var rawId = String(s.skuId || '').replace(/^J_/, '');
          // skuId为空时保留SKU（不参与去重），避免丢失数据
          if (!rawId) {
            dedupedSkus.push(s);
            return;
          }
          if (!seenSkuIds[rawId]) {
            seenSkuIds[rawId] = true;
            // 统一去除J_前缀
            s.skuId = rawId;
            dedupedSkus.push(s);
          }
        });
        if (dedupedSkus.length < result.skus.length) {
          this.log('extract', 'SKU去重', { before: result.skus.length, after: dedupedSkus.length });
          result.skus = dedupedSkus;
        }
      }
      // 京东价格回退：如果SKU没有价格，使用主商品价格作为回退
      if (location.href.indexOf('jd.com') > -1 && result.basic.price) {
        var emptyPriceCount = 0;
        result.skus.forEach(function(sku) {
          if (!sku.price) {
            sku.price = result.basic.price;
            emptyPriceCount++;
          }
        });
        if (emptyPriceCount > 0) {
          this.log('extract', 'SKU价格回退（使用主商品价格）', { emptyCount: emptyPriceCount, fallbackPrice: result.basic.price });
        }
      }
      this.log('extract', `SKU数据提取完成`, { count: result.skus.length });
    } else {
      this.log('extract', '已跳过SKU采集');
    }

    // 解析评论数据 —— 先获取初始评论（只在 parseApiResponse 未提取到时才解析）
    if (collectReviews) {
      if (result.reviews.length === 0 && reviewResponse) {
        this.log('extract', '从API响应解析评论数据');
        var parsedReviews = this.parseReviewResponse(reviewResponse);
        if (parsedReviews.length > 0) result.reviews = parsedReviews;
      }
      // 京东兜底：拦截器可能注入太晚错过评论API，直接请求京东评论API
      if (result.reviews.length === 0 && location.href.indexOf('jd.com') > -1 && this.itemId) {
        this.log('extract', '京东评论拦截缺失，尝试直接请求评论API');
        try {
          var jdReviews = await this.fetchJdReviewsDirectly(this.itemId);
          if (jdReviews && jdReviews.length > 0) {
            result.reviews = jdReviews;
            this.log('extract', '直接请求京东评论API成功', { count: jdReviews.length });
          }
        } catch (e) {
          this.log('extract', '直接请求京东评论API失败', { error: e.message });
        }
      }
      if (result.reviews.length === 0) {
        this.log('extract', '尝试从DOM解析评论数据');
        result.reviews = this.extractReviewsFromDOM();
      }
      // 天猫/淘宝 SSR 兜底：Lite 页不渲染评价区且无评论API请求时，
      // 从内嵌脚本的 rateVO.group.items 解析评论（用户/内容/SKU/时间/图片）
      if (result.reviews.length === 0 &&
          /detail\.tmall\.com|item\.taobao\.com|item\.tmall\.com/.test(location.href)) {
        this.log('extract', '尝试从页面SSR数据解析评论（rateVO）');
        var ssrReviews = this.extractReviewsFromSsr();
        if (ssrReviews.length > 0) {
          result.reviews = ssrReviews;
          this.log('extract', 'SSR评论解析成功', { count: ssrReviews.length });
        }
      }
      // 检查评论字段完整性：如果评论有reviewId但content/rating/time全为空，说明数据不完整
      // 尝试从拦截的原始响应中重新解析
      if (result.reviews.length > 0 && location.href.indexOf('jd.com') > -1) {
        var needRefetch = result.reviews.every(function(r) {
          return r.reviewId && !r.content && !r.rating && !r.time;
        });
        if (needRefetch) {
          this.log('extract', '检测到评论字段不完整（有ID但无内容），尝试直接请求京东评论API补全');
          try {
            var refetched = await this.fetchJdReviewsDirectly(this.itemId);
            if (refetched && refetched.length > 0) {
              result.reviews = refetched;
              this.log('extract', '评论字段补全成功', { count: refetched.length });
            }
          } catch (e) {
            this.log('extract', '评论字段补全失败', { error: e.message });
          }
        }
      }
      this.log('extract', `初始评论提取完成`, { count: result.reviews.length });

      // 评论采集二选一都需要进入翻页器：全部=0页上限，自定义=指定页数。
      if (collectAllReviews || reviewPageLimit > 0) {
        this.log('extract', collectAllReviews ? '开始采集全部评论（翻页）...' : '开始按自定义页数采集评论（翻页）...');
        try {
          var allReviews = await this.collectAllReviews(result.reviews, { reviewPageLimit: reviewPageLimit, reviewSpeed: reviewSpeed, reviewLimit: 0 });
          result.reviews = allReviews;
          this.log('extract', collectAllReviews ? '全部评论采集完成' : '自定义评论页数采集完成', { totalCount: allReviews.length, pageLimit: reviewPageLimit });
        } catch (e) {
          this.log('extract', '采集全部评论时出错(不影响已采集数据)', { error: e.message });
          // 派发异常终止事件，避免 panel.js 进度状态卡住
          this._dispatchProgress(-1, result.reviews.length, 0);
        }
      }

      // 应用评论数量上限
      if (reviewLimit > 0 && result.reviews.length > reviewLimit) {
        this.log('extract', '应用评论数量上限', { before: result.reviews.length, limit: reviewLimit });
        result.reviews = result.reviews.slice(0, reviewLimit);
      }

      // 如果关闭了"采集评论图片"，清空每条评论的 images 字段（节省内存/存储）
      if (!collectReviewImages) {
        this.log('extract', '已关闭评论图片采集，清空评论 images 字段');
        result.reviews.forEach(function(r) {
          if (r && r.images) r.images = [];
        });
      } else {
        var totalReviewImgs = 0;
        result.reviews.forEach(function(r) {
          if (r && r.images) totalReviewImgs += r.images.length;
        });
        this.log('extract', '评论图片统计', { totalReviewImages: totalReviewImgs });
      }
    } else {
      this.log('extract', '已跳过评论采集');
      result.reviews = [];
    }

    // 解析商品参数（只在 parseApiResponse 未提取到时才解析，避免覆盖）
    if (collectParameters) {
      if (result.parameters.length === 0 && detailResponse) {
        this.log('extract', '从API响应解析商品参数');
        var parsedParams = this.parseParameters(detailResponse);
        if (parsedParams.length > 0) result.parameters = parsedParams;
      }
      if (result.parameters.length === 0) {
        this.log('extract', '尝试从DOM解析商品参数');
        result.parameters = this.extractParametersFromDOM();
      }
      this.log('extract', `商品参数提取完成`, { count: result.parameters.length });
    } else {
      this.log('extract', '已跳过参数采集');
    }

    // 关闭主图采集时清空
    if (!collectMainImages) {
      this.log('extract', '已关闭主图采集，清空 images');
      result.images = [];
    }
    // 关闭详情图采集时清空
    if (!collectDescImages) {
      this.log('extract', '已关闭详情图采集，清空 descHtml/descImages/description');
      result.descHtml = '';
      result.descImages = [];
      result.description = '';
    }

    // 京东标题清理：去除SEO后缀（如"【需预约购买】【行情 报价 价格 评测】"）
    if (result.basic.title && location.href.indexOf('jd.com') > -1) {
      var originalTitle = result.basic.title;
      // 清理 【xxx】 后缀（京东常见的SEO后缀）
      result.basic.title = result.basic.title
        .replace(/【需预约购买】/g, '')
        .replace(/【行情\s*报价\s*价格\s*评测】/g, '')
        .replace(/【.*?报价.*?评测.*?】/g, '')
        .replace(/\s*【[^】]*】\s*$/g, '')  // 末尾的【xxx】
        .replace(/\s+/g, ' ')
        .trim();
      if (result.basic.title !== originalTitle) {
        this.log('extract', '京东标题SEO后缀清理', { before: originalTitle.slice(-40), after: result.basic.title.slice(-40) });
      }
    }

    this.log('extract', '商品详情数据提取完成', {
      success: true,
      hasTitle: !!result.basic.title,
      hasPrice: !!result.basic.price,
      hasShop: !!result.basic.shopName,
      skuCount: result.skus.length,
      reviewCount: result.reviews.length,
      paramCount: result.parameters.length,
      imageCount: result.images.length,
      descLen: (result.description || '').length,
      descImgCount: (result.descImages || []).length
    });

    return { success: true, data: result };
  },

  // 解析全平台API响应数据（源端优先）
  parseApiResponse(detailResponse, skuResponse, reviewResponse) {
    var result = { basic: {}, images: [], skus: [], parameters: [], reviews: [] };
    var self = this;
    // 优先从隔离世界本地存储读取（CustomEvent 通道），降级到主世界
    var intercepted = this._interceptedData || window.__ssrCache__;
    var isJd = location.href.indexOf('jd.com') > -1;
    var isTaobao = location.href.indexOf('taobao.com') > -1 || location.href.indexOf('tmall.com') > -1;
    var isPdd = location.href.indexOf('pinduoduo.com') > -1 || location.href.indexOf('yangkeduo.com') > -1;
    var is1688 = location.href.indexOf('1688.com') > -1;

    if (intercepted && intercepted.allResponses) {
      self.log('api', '已拦截请求数:', intercepted.allResponses.length);
      intercepted.allResponses.slice(0, 10).forEach(function(r){
        console.log('[电商采集大师] 拦截URL:', r.url.substring(0, 120));
      });
    }

    // 1. 从详情响应解析基础信息
    var detailData = detailResponse;
    if (!detailData && intercepted) {
      for (var i = 0; i < intercepted.allResponses.length; i++) {
        var r = intercepted.allResponses[i];
        if (r.url && (r.url.indexOf('item.jd') > -1 || r.url.indexOf('api.m.jd') > -1 ||
            r.url.indexOf('wareBusiness') > -1 || r.url.indexOf('productinfo') > -1 ||
            r.url.indexOf('h5api.m.tmall') > -1 || r.url.indexOf('h5api.m.taobao') > -1 ||
            r.url.indexOf('mobile.yangkeduo') > -1 || r.url.indexOf('goods.pinduoduo') > -1 ||
            r.url.indexOf('detail.1688') > -1 || r.url.indexOf('offer') > -1)) {
          detailData = r.data;
          self.log('api', '从URL找到详情数据:', r.url.substring(0, 80));
          break;
        }
      }
    }

    if (detailData) {
      var d = detailData;
      // 通用字段路径（适配全平台）
      if (d.name) result.basic.title = d.name;
      else if (d.title) result.basic.title = d.title;
      else if (d.skuName) result.basic.title = d.skuName;
      else if (d.itemName) result.basic.title = d.itemName;
      else if (d.productInfo && d.productInfo.name) result.basic.title = d.productInfo.name;
      else if (d.data && d.data.name) result.basic.title = d.data.name;
      else if (d.data && d.data.title) result.basic.title = d.data.title;

      // 京东特有：从 productAttributeVO 提取品牌和属性
      if (d.productAttributeVO) {
        var attrs = d.productAttributeVO.attributes || [];
        attrs.forEach(function(a){
          if (a.labelName === '品牌' || a.labelName === '商品编号') {
            if (a.labelName === '品牌' && !result.basic.shopName) result.basic.shopName = a.labelValue;
          }
        });
        // coreAttributes 作为商品参数
        var coreAttrs = d.productAttributeVO.coreAttributes || [];
        coreAttrs.forEach(function(a){
          result.parameters.push({name: a.labelName, value: a.labelValue});
        });
      }

      // 价格解析（京东 price 是对象）
      if (d.price) {
        if (typeof d.price === 'string' || typeof d.price === 'number') {
          result.basic.price = String(d.price);
        } else if (typeof d.price === 'object') {
          // 京东 price 对象可能包含 {p, m, op} 或 {price, originPrice}
          if (d.price.p) result.basic.price = String(d.price.p);
          else if (d.price.price) result.basic.price = String(d.price.price);
          else if (d.price.np) result.basic.price = String(d.price.np);
          if (d.price.op) result.basic.originalPrice = String(d.price.op);
          if (d.price.m) result.basic.shopName = result.basic.shopName || d.price.m;
        }
      }
      if (!result.basic.price && d.jdPrice) result.basic.price = String(d.jdPrice);
      if (!result.basic.price && d.p && d.p !== '无价') result.basic.price = String(d.p);
      if (!result.basic.price && d.priceInfo && d.priceInfo.p) result.basic.price = String(d.priceInfo.p);
      if (!result.basic.price && d.data && d.data.price) result.basic.price = String(d.data.price);
      if (!result.basic.price && d.minPrice) result.basic.price = String(d.minPrice);
      if (!result.basic.price && d.minGroupPrice) result.basic.price = String(d.minGroupPrice);

      if (!result.basic.shopName && d.shopName) result.basic.shopName = d.shopName;
      if (!result.basic.shopName && d.shop && d.shop.name) result.basic.shopName = d.shop.name;
      if (!result.basic.shopName && d.brand) result.basic.shopName = d.brand;
      if (!result.basic.shopName && d.mallName) result.basic.shopName = d.mallName;
      if (!result.basic.shopName && d.data && d.data.shopName) result.basic.shopName = d.data.shopName;

      // 京东价格API: p.3.cn/prices/mgets 返回数组 [{p, op, m}]
      if (Array.isArray(d) && d.length > 0) {
        if (d[0].p) result.basic.price = d[0].p;
        if (d[0].op) result.basic.originalPrice = d[0].op;
        if (d[0].m) result.basic.shopName = result.basic.shopName || d[0].m;
      }

      // 图片（通用提取）
      var imgList = d.imageList || d.images || d.galleryList ||
        (d.data && (d.data.imageList || d.data.images)) || [];
      if (Array.isArray(imgList)) {
        imgList.forEach(function(img){
          if (!img) return;
          if (typeof img === 'string') result.images.push(img);
          else if (img.url) result.images.push(img.url);
          else if (img.imgUrl) result.images.push(img.imgUrl);
          else if (img.src) result.images.push(img.src);
        });
      }
    }

    // 2. 从价格API获取价格（京东 p.3.cn）
    if (intercepted && !result.basic.price) {
      for (var i = 0; i < intercepted.allResponses.length; i++) {
        var r = intercepted.allResponses[i];
        if (r.url && r.url.indexOf('p.3.cn') > -1 && Array.isArray(r.data) && r.data.length > 0) {
          if (r.data[0].p) {
            result.basic.price = r.data[0].p;
            if (r.data[0].op) result.basic.originalPrice = r.data[0].op;
            self.log('api', '从p.3.cn获取价格:', r.data[0].p);
            break;
          }
        }
      }
    }

    // 3. 从SKU响应解析规格（通用）
    var skuData = skuResponse;
    if (!skuData && intercepted) {
      for (var i = 0; i < intercepted.allResponses.length; i++) {
        var r = intercepted.allResponses[i];
        if (r.url && (r.url.indexOf('cdnware') > -1 || r.url.indexOf('getStockState') > -1 ||
            r.url.indexOf('sku') > -1 || r.url.indexOf('spec') > -1)) {
          skuData = r.data;
          break;
        }
      }
    }
    if (skuData) {
      // 京东新版：优先从 colorSizeVO 提取SKU（避免 priceList/priceMap 中的跨卖商品干扰）
      var jdColorSizeVO = intercepted && intercepted.detailResponse ? intercepted.detailResponse.colorSizeVO : null;
      if (jdColorSizeVO && jdColorSizeVO.colorSizeList && Array.isArray(jdColorSizeVO.colorSizeList)) {
        self.log('api', '从colorSizeVO.colorSizeList提取SKU（优先）');
        // 构建 skuId -> name 映射（同 extractDetailData 中的逻辑）
        var skuAttrs = {};
        jdColorSizeVO.colorSizeList.forEach(function(group) {
          if (!group || !group.buttons) return;
          group.buttons.forEach(function(btn) {
            if (!btn || !btn.text) return;
            var attrName = btn.text.trim();
            var btnSkuId = btn.skuId ? String(btn.skuId) : '';
            if (btnSkuId) {
              if (!skuAttrs[btnSkuId]) skuAttrs[btnSkuId] = [];
              if (skuAttrs[btnSkuId].indexOf(attrName) < 0) skuAttrs[btnSkuId].push(attrName);
            }
            if (btn.skuList && Array.isArray(btn.skuList)) {
              btn.skuList.forEach(function(sid) {
                var id = String(sid);
                if (!skuAttrs[id]) skuAttrs[id] = [];
                if (skuAttrs[id].indexOf(attrName) < 0) skuAttrs[id].push(attrName);
              });
            }
          });
        });
        // 构建价格映射（从 priceMap 获取价格）
        var priceLookup = {};
        if (skuData.priceMap && typeof skuData.priceMap === 'object') {
          Object.keys(skuData.priceMap).forEach(function(skuId) {
            var p = skuData.priceMap[skuId];
            if (p) priceLookup[skuId] = p;
          });
        }
        // 构建 stock 映射
        var stockLookup = {};
        if (skuData.stockStateMapResponses && typeof skuData.stockStateMapResponses === 'object') {
          Object.keys(skuData.stockStateMapResponses).forEach(function(skuId) {
            var s = skuData.stockStateMapResponses[skuId];
            if (s) stockLookup[skuId] = s;
          });
        }
        // 生成SKU列表
        Object.keys(skuAttrs).forEach(function(skuId) {
          var attrs = skuAttrs[skuId];
          var name = attrs.length > 0 ? attrs.join(' / ') : '';
          var pm = priceLookup[skuId] || {};
          var stockInfo = stockLookup[skuId] || {};
          result.skus.push({
            skuId: skuId,
            price: pm.p || pm.price || '',
            name: name,
            stock: stockInfo.stockState || stockInfo.stock || 0
          });
        });
        self.log('api', 'colorSizeVO SKU提取完成', { count: result.skus.length, withPrice: result.skus.filter(function(s){return !!s.price;}).length });
      } else {
        // 旧版：从 skuList/priceList 提取
        var skuList = skuData.skuList || skuData.skus || skuData.priceList ||
          (skuData.colorSize && skuData.colorSize.sku) ||
          (skuData.data && (skuData.data.skuList || skuData.data.skus || skuData.data.priceList)) || [];
        if (Array.isArray(skuList)) {
          skuList.forEach(function(s){
            if (!s) return;
            if (s.skuId || s.id) {
              result.skus.push({
                skuId: s.skuId || s.id,
                price: s.price || s.jdPrice || s.minPrice || s.p || '',
                name: s.name || s.title || s.spec || s.skuName || '',
                stock: s.stockCount || s.stock || s.quantity || 0
              });
            }
          });
        }
        // 京东 priceMap 格式: { "skuId": {p, op, m} }
        if (skuData.priceMap && typeof skuData.priceMap === 'object') {
        // 京东priceMap可能包含跨卖商品（推荐商品），需要过滤
        // 只保留属于当前商品的SKU（在colorSizeVO.spiderMap或canAddCartMap中的）
        var validSkuIds = null;
        if (intercepted && intercepted.detailResponse) {
          var csvo = intercepted.detailResponse.colorSizeVO;
          if (csvo) {
            if (csvo.spiderMap) validSkuIds = validSkuIds || {};
            if (csvo.spiderMap) Object.keys(csvo.spiderMap).forEach(function(k){ validSkuIds[k] = true; });
            if (csvo.canAddCartMap) {
              Object.keys(csvo.canAddCartMap).forEach(function(k){ validSkuIds[k] = true; });
            }
          }
        }
        Object.keys(skuData.priceMap).forEach(function(skuId){
          var p = skuData.priceMap[skuId];
          if (p && (p.p || p.price)) {
            // 如果有有效SKU列表，只保留其中的SKU
            if (validSkuIds && !validSkuIds[skuId]) {
              return; // 跳过跨卖商品
            }
            result.skus.push({
              skuId: skuId,
              price: p.p || p.price || '',
              name: p.name || p.m || '',
              stock: 0
            });
          }
        });
        if (validSkuIds) {
          self.log('api', 'priceMap过滤完成', { total: Object.keys(skuData.priceMap).length, kept: result.skus.length });
        }
        }
      }
    }

    // 4. 从评论响应解析评论（通用）
    var revData = reviewResponse;
    if (!revData && intercepted) {
      for (var i = 0; i < intercepted.allResponses.length; i++) {
        var r = intercepted.allResponses[i];
        if (r.url && (r.url.indexOf('club.jd') > -1 || r.url.indexOf('productPageComments') > -1 ||
            r.url.indexOf('rate') > -1 || r.url.indexOf('comment') > -1)) {
          revData = r.data;
          break;
        }
      }
    }
    if (revData) {
      // 京东评论: commentInfoList; 通用: comments / rateList
      var comments = revData.commentInfoList || revData.comments ||
        (revData.data && revData.data.commentInfoList) ||
        (revData.data && revData.data.comments) ||
        revData.rateList || revData.reviewList || [];
      if (Array.isArray(comments)) {
        comments.forEach(function(c){
          if (!c) return;
          // 京东图片: pictureInfoList; 通用: images
          var imgs = [];
          if (c.pictureInfoList) c.pictureInfoList.forEach(function(img){
            if (img.largePicURL) imgs.push(img.largePicURL);
            else if (img.picURL) imgs.push(img.picURL);
            else if (img.imgUrl) imgs.push(img.imgUrl);
          });
          if (c.images) c.images.forEach(function(img){
            if (img.imgUrl) imgs.push(img.imgUrl);
            else if (typeof img === 'string') imgs.push(img);
          });
          // 京东SKU: wareAttribute; 通用: productColor
          var skuInfo = '';
          if (c.wareAttribute && Array.isArray(c.wareAttribute)) {
            var parts = [];
            c.wareAttribute.forEach(function(attr){
              if (typeof attr === 'object') Object.keys(attr).forEach(function(k){ parts.push(k+':'+attr[k]); });
            });
            skuInfo = parts.join(' ');
          }
          if (!skuInfo) skuInfo = c.productColor || c.productSize || c.skuInfo || '';
          // 京东内容: commentData; 通用: content
          var content = c.commentData || c.content || c.comment || '';
          if (!content && c.tagCommentContent) {
            content = String(c.tagCommentContent).replace(/\{\$\%\&[^&]*\&\$\%\}/g, '').trim();
          }
          result.reviews.push({
            reviewId: c.commentId || c.id || '',
            username: c.userNickName || c.nickname || c.userName || '',
            content: content,
            rating: DetailCollector.normalizeReviewRating(c),
            time: c.commentDate || c.creationTime || c.referenceTime || c.date || '',
            images: imgs,
            skuInfo: skuInfo,
            publishArea: c.publishArea || '',
            praiseCnt: c.praiseCnt || 0,
            hasImage: imgs.length > 0
          });
        });
      }
      // 评分汇总（京东: allCnt/goodCnt/goodRate 在顶层）
      if (revData.allCnt) result.basic.reviewCount = String(revData.allCnt);
      if (revData.goodRate) result.basic.rating = String(revData.goodRate).replace('%','') + '%';
      if (revData.pictureCnt) result.basic.pictureReviewCount = String(revData.pictureCnt);
      // 淘宝/通用 productCommentSummary
      var summary = revData.productCommentSummary ||
        (revData.data && revData.data.productCommentSummary) || {};
      if (summary.goodRate && !result.basic.rating) result.basic.rating = summary.goodRate;
      if (summary.commentCount && !result.basic.reviewCount) result.basic.reviewCount = summary.commentCount;
    }

    // 1688：响应结构深层嵌套，通用字段路径难以命中，启用 picchajian 式深度扫描兜底
    if (is1688) {
      self.enrich1688Data(result, intercepted || { allResponses: [] });
    }

    self.log('api', '源端解析完成', {
      platform: isJd ? 'JD' : isTaobao ? 'Taobao' : isPdd ? 'PDD' : is1688 ? '1688' : 'unknown',
      hasTitle: !!result.basic.title,
      hasPrice: !!result.basic.price,
      hasShop: !!result.basic.shopName,
      skuCount: result.skus.length,
      reviewCount: result.reviews.length,
      imgCount: result.images.length
    });

    // Fallback: 从 skuResponse.data 中提取标题（京东 skuResponse.data[0] 可能含 name/title）
    if (!result.basic.title && skuData && skuData.data && Array.isArray(skuData.data)) {
      for (var i = 0; i < skuData.data.length; i++) {
        var item = skuData.data[i];
        if (item && (item.name || item.title || item.skuName)) {
          result.basic.title = item.name || item.title || item.skuName;
          break;
        }
      }
    }

    // Fallback: 从页面 <title> 提取标题
    if (!result.basic.title) {
      var pageTitle = document.title || '';
      // 京东: "商品名 - 京东" / 淘宝: "商品名 - 淘宝网"
      pageTitle = pageTitle.replace(/\s*[-–—]\s*(京东|淘宝网|天猫|JD\.com|Taobao\.com|Tmall\.com).*$/i, '').trim();
      if (pageTitle.length > 5) {
        result.basic.title = pageTitle;
        self.log('api', '从 <title> 提取标题:', pageTitle.substring(0, 50));
      }
    }

    return result;
  },

  // 从DOM提取基础信息
  // v1.2.314：详情图懒加载预热——有界滚动触发懒加载（300ms/步，最多 12 步，连续 3 步无新增即停），结束恢复滚动位置
  async warmDescLazyImages() {
    try {
      var sels = [
        aisDcSel('tb.desc', '#J_DivItemDesc, #description, [class*="descV8"], [class*="Description--"], [class*="detail--"]'),
        '#J_DivItemDesc', '#description', '.descV8-container', '[class*="descV8"]',
        '[class*="Description--"]', '[class*="detail--"]',
        '#detail-desc', '.item-detail .content', '[class*="detail-content"]', '[class*="DetailBanner"]',
        '[class*="item-desc"]', '[class*="product-desc"]', '[class*="goods-desc"]'
      ];
      var el = null;
      for (var i = 0; i < sels.length; i++) {
        var cand = document.querySelector(sels[i]);
        if (cand && cand.querySelectorAll('img').length >= 1) { el = cand; break; }
      }
      var y0 = window.pageYOffset || 0;
      // 容器找不到时退化为「窗口级渐进滚动」——同样能触发全页懒加载（淘宝/天猫/1688 详情区常在 iframe/自适应容器里）
      var probe = function () { return el ? el.querySelectorAll('img').length : document.querySelectorAll('img').length; };
      var seen = probe(), idle = 0;
      for (var step = 0; step < 14; step++) {
        if (idle >= 3) break;
        if (el) {
          var rect = el.getBoundingClientRect();
          try { window.scrollTo(0, rect.top + (window.pageYOffset || 0) + step * 700); } catch (e1) {}
          try { if (el.scrollHeight > el.clientHeight + 20) el.scrollTop = step * 700; } catch (e2) {}
        } else {
          try { window.scrollTo(0, y0 + (step + 1) * 700); } catch (e4) {}
        }
        await new Promise(function (res) { setTimeout(res, 300); });
        var now = probe();
        if (now > seen) { seen = now; idle = 0; } else { idle++; }
      }
      try { window.scrollTo(0, y0); } catch (e3) {}
      this.log('dom', '详情图懒加载预热完成', { imgEls: seen });
      return seen;
    } catch (eWarm) { return 0; }
  },

  extractFromDOM() {
    const basic = {};
    const selectorLog = {};

    // 拼多多"已售罄"壳页检测（整页仅显示"商品已售罄，推荐以下相似商品"+相似推荐）
    var isPddSoldOutShell = false;
    if (/yangkeduo\.com/.test(location.href)) {
      var shellBody = document.body ? (document.body.innerText || '') : '';
      isPddSoldOutShell = shellBody.indexOf('商品已售罄') > -1 && shellBody.indexOf('推荐以下相似商品') > -1;
      if (isPddSoldOutShell) {
        basic.soldOut = true;
        this.log('dom', '拼多多检测到已售罄壳页（页面级）');
      }
    }

    // 标题 - 优先使用稳定的data-spm属性
    const titleSelectors = [
      // 京东（旧版 .sku-name）
      '.sku-name',
      'div.sku-name',
      // 京东新版 CSS Module 类名
      '[class*="goodsName--"]',
      '[class*="GoodsName--"]',
      '[class*="itemTitle--"]',
      '[class*="ItemTitle--"]',
      '[class*="sku-name--"]',
      // 京东新版：跳过 .calculator-title（非商品标题）
      // 淘宝/天猫
      'h1[data-spm="1000983"]',
      'h1.tb-main-title',
      '.tb-detail-hd h1',
      '#J_DetailMeta h1',
      'div[data-spm="detail"] h1',
      'h1.itemInfo-sku-title',
      '.tb-main-title',
      '.itemInfo-sku-title',
      'h1[title]',
      'h1:not(.calculator-title)'
    ];
    for (const sel of titleSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 5) {
        basic.title = el.textContent.trim();
        selectorLog.title = { selector: sel, found: true, length: basic.title.length };
        this.log('dom', `标题选择器命中: ${sel}`, { title: basic.title.substring(0, 30) });
        break;
      }
    }
    if (!basic.title) {
      this.log('dom', '所有标题选择器均未命中', { tried: titleSelectors.length });
    }

    // 价格
    const priceSelectors = [
      // 京东（旧版）
      '.p-price .price',
      '.p-price span',
      '.p-price',
      '.JD-price',
      // 京东新版 CSS Module 类名
      '[class*="priceWrap--"]',
      '[class*="PriceWrap--"]',
      '[class*="priceText--"]',
      '[class*="PriceText--"]',
      '[class*="currentPrice--"]',
      '[class*="jdPrice--"]',
      // 淘宝/天猫新版（CSS Module hash类）- highlightPrice 通常只含单一活动价，最易解析
      '[class*="highlightPrice--"]',
      '[class*="normalPrice--"]',
      '[class*="beltPrice--"]',
      // 淘宝/天猫旧版
      '.tm-price',
      'em.tb-rmb-num',
      '.price-promo',
      '.tb-rmb-num',
      '[class*="price-now"]',
      '[class*="price "]',
      '.price'
    ];
    for (const sel of priceSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const priceText = el.textContent.trim();
        const normalized = this.normalizePrice(priceText);
        if (normalized) {
          basic.price = normalized;
          selectorLog.price = { selector: sel, found: true };
          this.log('dom', `价格选择器命中: ${sel}`, { raw: priceText, normalized: normalized });
          break;
        }
      }
    }
    if (!basic.price) {
      this.log('dom', '所有价格选择器均未命中', { tried: priceSelectors.length });
      // 通用兜底：新版/Lite 页面价格元素类名不可预测时，取 body 文本中第一个 ¥ 金额
      // （拼多多已售罄壳页除外：该页首个金额可能是推荐商品价格）
      if (!isPddSoldOutShell) {
        try {
          var bodyPriceMatch = (document.body.innerText || '').match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
          if (bodyPriceMatch) {
            basic.price = this.normalizePrice(bodyPriceMatch[0]);
            selectorLog.price = { selector: 'body-text-first-yuan', found: true };
            this.log('dom', '价格通用兜底命中（body首个¥金额）', { raw: bodyPriceMatch[0], price: basic.price });
          }
        } catch(e) {}
      }
    }

    // 店铺名
    const shopSelectors = [
      // 京东（旧版）
      '.J-hove-wrap .name',
      '.J-shop-name',
      '.shop-name a',
      // 京东新版 CSS Module 类名
      '[class*="shopName--"]',
      '[class*="ShopName--"]',
      '[class*="storeName--"]',
      '[class*="J-shop-name"] a',
      // 淘宝/天猫
      'a.shop-name',
      '.shop-name',
      '.shop-name-link',
      '.J_ShopInfo a',
      '[class*="shopName"]',
      '.shop-name span',
      'a[href*="shop"]'
    ];
    for (const sel of shopSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 1) {
        basic.shopName = el.textContent.trim();
        selectorLog.shop = { selector: sel, found: true };
        this.log('dom', `店铺选择器命中: ${sel}`, { shop: basic.shopName });
        break;
      }
    }
    if (!basic.shopName) {
      this.log('dom', '所有店铺选择器均未命中', { tried: shopSelectors.length });
    }

    // 销量（v1.2.313 三级兜底：平台选择器 → 通用选择器 → 整页文本正则）
    // 背景：用户反馈「除了销量没数据」——原实现只有一串京东式选择器，
    // 淘宝/天猫/1688/拼多多的详情页取不到值，且没有文本兜底，改版即失效。
    let salesSelectors = [
      // 淘宝/天猫
      '[class*="month-sale"]',
      '[class*="realSales"]',
      '[class*="salesCount"]',
      '[class*="soldQuantity"]',
      '[class*="Sales--"]',
      // 1688
      '[class*="sale-quantity"]',
      '[class*="deal-count"]',
      '[class*="sold-count"]',
      // 拼多多
      '[class*="_commit"] strong',
      '.p-commit strong',
      '[class*="salesTip"]',
      '[class*="sales-tip"]',
      // 京东
      '#comment-count',
      '.J-sale-num',
      '[class*="sale-num"]',
      '[class*="sales-num"]',
      // 1688（成交/销量区域，类名随机化严重，主要靠下方文本兜底）
      '[class*="saleInfo"]',
      '[class*="sale-info"]',
      '[class*="transaction"]',
      // 通用兜底
      '[class*="sales"]',
      '[class*="sold"]'
    ];
    // v1.2.313 远程可覆盖（common.salesSelectors）：平台改版时只推规则、不发版
    try {
      const __rsel = (window.AisAnchors && window.AisAnchors.arr) ? window.AisAnchors.arr('common.salesSelectors', []) : [];
      if (Array.isArray(__rsel) && __rsel.length) salesSelectors = __rsel;
    } catch (eRsel) {}
    for (const sel of salesSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
      // 校验：必须含数字且长度合理，避免把容器整段文字/「销量榜」之类当销量
      if (!txt || txt.length > 24 || !/[0-9]/.test(txt)) continue;
      basic.salesText = txt;
      this.log('dom', `销量选择器命中: ${sel}`, { sales: basic.salesText });
      break;
    }
    // 文本正则兜底：不依赖类名，抗前端改版（各平台常见文案）
    if (!basic.salesText) {
      const pageText = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ');
      // v1.2.313 默认文案（含 1688 成交/已售/人已购）；远程 common.salesPatterns 可整体替换（字符串数组→RegExp）
      const salesPatterns = (function () {
        try {
          const rs = (window.AisAnchors && window.AisAnchors.arr) ? window.AisAnchors.arr('common.salesPatterns', []) : [];
          if (Array.isArray(rs) && rs.length) {
            const out = [];
            for (const s of rs) { try { out.push(new RegExp(s)); } catch (eP) {} }
            if (out.length) return out;
          }
        } catch (eRpat) {}
        return [
          /月销\s*([0-9][0-9.,]*\s*[万千百]?\+?)/,
          /已售\s*([0-9][0-9.,]*\s*[万千百]?\+?)/,
          /([0-9][0-9.,]*\s*[万千百]?\+?)\s*人付款/,
          /([0-9][0-9.,]*\s*[万千百]?\+?)\s*人已购/,
          /累计销量\s*[:：]?\s*([0-9][0-9.,]*\s*[万千百]?\+?)/,
          /近\s*30\s*天成交\s*[:：]?\s*([0-9][0-9.,]*\s*[万千百]?\+?)/,
          /成交\s*[:：]?\s*([0-9][0-9.,]*\s*[万千百]?\+?)/,
          /([0-9][0-9.,]*\s*[万千百]?\+?)\s*(?:笔|件)?成交/,
          /已拼\s*([0-9][0-9.,]*\s*[万千百]?\+?)/,
          /销量\s*[:：]?\s*([0-9][0-9.,]*\s*[万千百]?\+?)/
        ];
      })();
      for (const re of salesPatterns) {
        const m = pageText.match(re);
        if (m && m[1]) {
          basic.salesText = String(m[1]).replace(/\s+/g, '');
          this.log('dom', '销量文本兜底命中', { pattern: String(re), sales: basic.salesText });
          break;
        }
      }
    }

    // 评分
    const ratingSelectors = [
      // 京东
      '.score',
      '.J-score',
      // 淘宝/天猫
      '[class*="rate-score"]',
      '[class*="rating-score"]',
      '.tb-rating',
      '[class*="star"]',
      '[class*="score"]'
    ];
    for (const sel of ratingSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        basic.rating = el.textContent.trim();
        this.log('dom', `评分选择器命中: ${sel}`, { rating: basic.rating });
        break;
      }
    }

    // 图片
    const images = [];
    const imgSelectors = [
      // 京东
      '#spec-list img',
      '#spec-img img',
      '[class*="spec-items"] img',
      // 京东新版 CSS Module
      '[class*="continuous-product--image"] img',
      '[class*="pc-component-__image_main__"]',
      '.product-img img',
      // 淘宝/天猫
      '[class*="tb-sku-thumb"] img',
      '[class*="image-thumb"] img',
      '[class*="Gallery"] img',
      '[class*="imgItem"] img',
      '#J_ImgBox img',
      '[class*="main-image"] img'
    ];
    imgSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(img => {
        var src = img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
        // 兼容协议相对 URL（//img.alicdn.com/...）
        if (src && src.startsWith('//')) src = 'https:' + src;
        if (src && src.startsWith('http') && !images.includes(src)) {
          images.push(src);
        }
      });
    });
    // 京东兜底：从 360buyimg.com 提取主图（过滤缩略图 s200x200）
    if (images.length === 0) {
      document.querySelectorAll('img').forEach(function(img) {
        var src = jdNormImg(img.src || img.getAttribute('data-src') || '');   // v1.2.260 去 .avif + 剔超小图
        if (src && src.indexOf('360buyimg.com') > -1 && src.indexOf('jfs') > -1 &&
            src.indexOf('s200x200') === -1 && !images.includes(src)) {
          images.push(src);
        }
      });
      // 如果还没有，用缩略图也行（升级分辨率）
      if (images.length === 0) {
        document.querySelectorAll('img').forEach(function(img) {
          var src = jdNormImg(img.src || img.getAttribute('data-src') || '');  // v1.2.260 去 .avif + 剔超小图
          if (src && src.indexOf('360buyimg.com') > -1 && src.indexOf('jfs') > -1 &&
              !images.includes(src)) {
            // 将 s200x200 升级为 s800x800
            var hiRes = src.replace(/s\d+x\d+/, 's800x800');
            images.push(hiRes);
          }
        });
      }
    }
    this.log('dom', `图片提取完成`, { count: images.length });

    // 商品描述（详情内容 + 详情图片）
    var description = '';
    var descImages = [];
    var descHtml = '';
    // v1.2.247：淘宝/天猫详情容器改走锚点注册表（与 anchor-registry.js 的 desc 锚点同源），
    // 并移除裸 '.content'——该选择器过于宽泛，querySelector 会命中 DOM 中第一个 .content（常非详情容器），
    // 叠加下方「首个命中即用」的循环，会让详情图只剩 1 张。
    const descSelectors = [
      // 淘宝/天猫（锚点注册表优先，站点改版只改注册表）
      aisDcSel('tb.desc', '#J_DivItemDesc, #description, [class*="descV8"], [class*="Description--"], [class*="detail--"]'),
      '#J_DivItemDesc',
      '#description',
      '.descV8-container',
      '[class*="descV8"]',
      // 淘宝/天猫 CSS Module
      '[class*="Description--"]',
      '[class*="detail--"]',
      // 京东
      '#detail-desc',
      '.item-detail .content',
      '[class*="detail-content"]',
      '[class*="DetailBanner"]',
      // 通用
      '[class*="item-desc"]',
      '[class*="product-desc"]',
      '[class*="goods-desc"]'
    ];
    var descEl = null;
    for (var di = 0; di < descSelectors.length; di++) {
      descEl = document.querySelector(descSelectors[di]);
      if (descEl && descEl.innerHTML && descEl.innerHTML.length > 100) {
        this.log('dom', `商品描述选择器命中: ${descSelectors[di]}`, { htmlLen: descEl.innerHTML.length });
        break;
      }
      descEl = null;
    }
    // v1.2.314 详情图「取真图」：data-* 优先（懒加载真图常在 data-src），并剔除占位/无效 URL
    var pickDescSrc = function (img) {
      var cands = [
        img.getAttribute('data-src'),
        img.getAttribute('data-ks-lazyload'),
        img.getAttribute('data-lazyload'),
        img.getAttribute('data-original'),
        img.getAttribute('data-img'),
        img.getAttribute('data-srcset'),
        img.getAttribute('srcset'),
        img.getAttribute('src')
      ];
      for (var ci = 0; ci < cands.length; ci++) {
        var u = String(cands[ci] || '').trim();
        if (!u) continue;
        u = u.split(',')[0].trim().split(/\s+/)[0];
        if (u.indexOf('//') === 0) u = 'https:' + u;
        if (!/^https?:\/\//i.test(u)) continue;
        if (/\.gif(?:\?|$)/i.test(u)) continue;
        if (/(?:blank|loading|placeholder|spacer|1x1)/i.test(u)) continue;
        return u;
      }
      return '';
    };
    var collectDescImgsFrom = function (root) {
      if (!root) return;
      var els = root.querySelectorAll('img');
      for (var i2 = 0; i2 < els.length; i2++) {
        var u2 = pickDescSrc(els[i2]);
        if (u2 && descImages.indexOf(u2) < 0) descImages.push(u2);
      }
    };
    if (descEl) {
      // 提取纯文本描述
      description = (descEl.innerText || descEl.textContent || '').trim();
      // 提取HTML（保留图片引用）
      descHtml = descEl.innerHTML;
      // v1.2.314：详情图懒加载修复（用户反馈「详情图只采到 1~2 张」）
      // 根因：① 原实现优先读 img.src → 淘宝/天猫懒加载占位图被当真图，去重后只剩 1 张；
      //       ② 详情区不滚动就不触发懒加载，未加载的图没有真实 src。
      // 修法：① data-* 优先取真图、剔除占位/无效 URL；② 有界滚动触发懒加载（300ms/步，最多 12 步，连续 3 步无新增即停）；③ 结束恢复滚动位置。
      collectDescImgsFrom(descEl);   // 懒加载预热已在 extractDetailData 里先行（本方法同步，不能 await）
      this.log('dom', `商品描述提取完成`, {
        descLen: description.length,
        descImgCount: descImages.length
      });
    } else {
      this.log('dom', '未找到商品描述容器');
    }

    // v1.2.314 自适应兜底（淘宝/天猫/1688 改版频繁，不再依赖具体容器或类名）：
    // 语义 = 「页面下半部、图床域名、长边够大」的图簇。容器命中但图太少（<3）时同样启用。
    if (descImages.length < 3) {
      try {
        var adaptMinEdge = 300, adaptTopRatio = 0.45, adaptMax = 60;
        try {
          if (window.AisAnchors && window.AisAnchors.num) {
            adaptMinEdge = window.AisAnchors.num('common.descAdaptiveMinEdge', 300);
            adaptTopRatio = window.AisAnchors.num('common.descAdaptiveTopRatio', 0.45);
          }
        } catch (eAdNum) {}
        var hostRe = /(alicdn\.com|360buyimg\.com|cbuimg\.com|tbcdn\.cn|pddpic\.com|yangkeduo\.com)/i;
        var badRe = /(babel|imagetools|\/icon|\/logo|sprite|avatar|\/tps\/)/i;
        var pageH = Math.max(document.documentElement.scrollHeight || 0, (document.body && document.body.scrollHeight) || 0);
        var yTop = pageH * adaptTopRatio;
        var allImgs = document.querySelectorAll('img');
        var added = 0;
        for (var ai = 0; ai < allImgs.length && added < adaptMax; ai++) {
          var im = allImgs[ai];
          var u3 = pickDescSrc(im);
          if (!u3 || badRe.test(u3) || !hostRe.test(u3)) continue;
          var r3 = im.getBoundingClientRect();
          var absY = r3.top + (window.pageYOffset || 0);
          if (absY < yTop) continue;                        // 排除头部主图/推荐位
          var w3 = im.naturalWidth || r3.width || 0, h3 = im.naturalHeight || r3.height || 0;
          var longEdge = Math.max(w3, h3);
          if (longEdge && longEdge < adaptMinEdge) continue; // 排除小图标/占位
          if (descImages.indexOf(u3) > -1) continue;
          descImages.push(u3); added++;
        }
        if (added) this.log('dom', '详情图自适应兜底完成', { added: added, total: descImages.length });
      } catch (eAdapt) {}
    }

    // v1.1.167 京东详情图语义兜底（抗改版）：新版京东详情楼层类名随机化/更换，
    // 旧选择器（#detail-desc/[class*="detail-content"] 等）全部落空。
    // 策略：不依赖具体类名——先按京东「detail」命名族，再按「页面下方大图簇」位置启发式。
    if (!descEl && /jd\.com|3\.cn/.test(location.href) && descImages.length === 0) {
      var jdFloorImgs = [];
      // v1.2.251 纠正：真详情容器是 #detail-main；原 jdmccBagWrap 实为福袋营销组件，已弃用
      (function () {
        var bagSeen = {};
        document.querySelectorAll(aisDcSel('jd.descBag', '#detail-main img, [id*="detail-main"] img')).forEach(function (bim) {
          var bu = jdNormImg(bim.src || bim.getAttribute('data-lazyload') || bim.getAttribute('data-src') || bim.getAttribute('data-original') || bim.getAttribute('data-lazy-img') || ''); // v1.2.260
          if (!/^https?:\/\//.test(bu) || !/360buyimg\.com/.test(bu) || bagSeen[bu]) return;
          if (/\/imagetools\//.test(bu)) return;
          var bw = bim.naturalWidth || bim.width || 0, bh = bim.naturalHeight || bim.height || 0;
          if (bw && (bw < 250 || (bh && bh < 250))) return;
          if (images.indexOf(bu) > -1) return;
          bagSeen[bu] = 1; jdFloorImgs.push(bu);
        });
      })();
      var __aisCollectDescImg = function (img) {
        var dsrc = jdNormImg(img.src || img.getAttribute('data-lazyload') || img.getAttribute('data-src') ||
                   img.getAttribute('data-original') || img.getAttribute('data-lazy-img') || ''); // v1.2.260
        if (!/^https?:\/\//.test(dsrc)) return;
        if (!/360buyimg\.com/.test(dsrc)) return;
        // 排除推荐位商品卡（详情图不会包在商品链接里）
        try { if (img.closest && img.closest(aisDcSel('jd.excludeAnchor', 'a[href*="item.jd.com"], a[href*="//item.jd"], a[href*="npcitem.jd"], [class*="recommend"]'))) return; } catch (eA) {}
        // v1.1.170 实测修订：babel 是详情图 CDN 本身不能封（实测详情图在 babel/jfs）；只封 imagetools 图标，靠尺寸门槛杀 logo
        if (/\/imagetools\//.test(dsrc)) return;
        var dw = img.naturalWidth || img.width || (parseInt(img.getAttribute('width'), 10) || 0);
        var dh = img.naturalHeight || img.height || (parseInt(img.getAttribute('height'), 10) || 0);
        if (dw && (dw < 300 || (dh && dh < 200))) return;
        if (jdFloorImgs.indexOf(dsrc) < 0 && images.indexOf(dsrc) < 0) jdFloorImgs.push(dsrc);
      };
      // 层1：京东 detail 命名族（v1.2.251：elevator 族已移除——那是楼层导航/魔方装修）；bag 锚定已命中时跳过
      if (jdFloorImgs.length < 3) document.querySelectorAll(aisDcSel('jd.descFloor', '[id*="detail"] img, [class*="detail"] img')).forEach(__aisCollectDescImg);
      this.log('dom', '京东详情图楼层族扫描', { count: jdFloorImgs.length });
      // 层2：位置启发式——详情楼层是页面下方（首屏之后）的大图簇
      if (jdFloorImgs.length < 3) {
        jdFloorImgs = [];
        var bigs = [];
        document.querySelectorAll('img').forEach(function (dimg) {
          var dsrc = jdNormImg(dimg.src || dimg.getAttribute('data-lazyload') || dimg.getAttribute('data-src') ||
                     dimg.getAttribute('data-original') || dimg.getAttribute('data-lazy-img') || ''); // v1.2.260
          if (!/^https?:\/\//.test(dsrc) || !/360buyimg\.com/.test(dsrc)) return;
          try { if (dimg.closest && dimg.closest(aisDcSel('jd.excludeAnchor', 'a[href*="item.jd.com"], a[href*="//item.jd"], a[href*="npcitem.jd"], [class*="recommend"]'))) return; } catch (eB) {}
          // v1.1.170 实测修订：babel 是详情图 CDN 不能封；只封 imagetools，靠尺寸门槛杀 logo
          if (/\/imagetools\//.test(dsrc)) return;
          var dw2 = dimg.naturalWidth || dimg.width || (parseInt(dimg.getAttribute('width'), 10) || 0);
          var dh2 = dimg.naturalHeight || dimg.height || (parseInt(dimg.getAttribute('height'), 10) || 0);
          if (dw2 && (dw2 < 300 || (dh2 && dh2 < 200))) return;
          var dtop = 0;
          try { dtop = dimg.getBoundingClientRect().top + (window.pageYOffset || 0); } catch (eC) {}
          if (dtop > (window.innerHeight || 800) * 1.2) bigs.push({ src: dsrc, top: dtop });
        });
        bigs.sort(function (a, b) { return a.top - b.top; });
        // v1.1.170：连续簇切分（相邻间距 < 2.5 屏），取图数最多的簇（详情楼层 = 连续多张长图）
        var runs = [], run = [];
        for (var bi = 0; bi < bigs.length; bi++) {
          if (!run.length) { run.push(bigs[bi]); continue; }
          if (bigs[bi].top - run[run.length - 1].top < (window.innerHeight || 800) * 2.5) run.push(bigs[bi]);
          else { runs.push(run); run = [bigs[bi]]; }
        }
        if (run.length) runs.push(run);
        var best = null;
        for (var ri = 0; ri < runs.length; ri++) {
          if (runs[ri].length < 3) continue;
          if (!best || runs[ri].length >= best.length) best = runs[ri];
        }
        (best || []).forEach(function (c) { if (jdFloorImgs.indexOf(c.src) < 0) jdFloorImgs.push(c.src); });
        this.log('dom', '京东详情图位置兜底', { bigCount: bigs.length, cluster: (best || []).length }); // v1.2.247：原引用未定义变量 cluster，抛 ReferenceError 致层2/层3 兜底整体失效
      }
      // 层3：拦截数据兜底——新版京东详情楼层懒挂载，采集时 DOM 可能还没有 img；
      // 详情图随 API HTML 下发，从拦截响应文本中提取 jfs 原图（有界：末尾40条响应、上限60张）
      if (jdFloorImgs.length < 3 && this._interceptedData) {
        var seenMap = {};
        var __scanResp = function (respItem) {
          try {
            if (!respItem || !respItem.data) return;
            var url3 = respItem.url || '';
            if (url3.indexOf('jd.com') < 0 && url3.indexOf('3.cn') < 0 && url3.indexOf('desc') < 0) return;
            var text3 = '';
            try { text3 = JSON.stringify(respItem.data); } catch (eS) { return; }
            if (!text3 || text3.length < 200) return;
            var re3 = /(https?:)?\/\/img\d*\.360buyimg\.com\/[^"'\\\s<>]+?\/jfs\/[^"'\\\s<>]+/g;
            var m3;
            while ((m3 = re3.exec(text3)) !== null && jdFloorImgs.length < 60) {
              var u3 = jdNormImg(m3[0]);   // v1.2.260 去 .avif + 剔超小图
              if (!u3) continue;
              if (seenMap[u3] || images.indexOf(u3) > -1) continue;
              if (/\/imagetools\//.test(u3)) continue; // v1.1.170：只封 imagetools，babel 是详情图 CDN
              seenMap[u3] = 1;
              jdFloorImgs.push(u3);
            }
          } catch (eT) {}
        };
        if (this._interceptedData.descResponse) __scanResp({ url: 'https://desc.jd.com/intercepted', data: this._interceptedData.descResponse });
        if (jdFloorImgs.length < 3) (this._interceptedData.allResponses || []).slice(-40).forEach(__scanResp);
        this.log('dom', '京东详情图拦截数据兜底', { count: jdFloorImgs.length });
      }
      jdFloorImgs.forEach(function (u) { descImages.push(u); });
      if (descImages.length > 0) {
        this.log('dom', '京东详情图语义兜底完成', { descImgCount: descImages.length });
      }
    }

    // 拼多多移动端兑底：DOM 使用旋转 hash class + 自定义字体混淆，
    // 但标题/价格/主图仍以明文存在，按语义规则提取
    if (images.length === 0 || !basic.title || !basic.price) {
      if (/yangkeduo\.com/.test(location.href)) {
        this.log('dom', '拼多多移动端兑底提取...', { hasTitle: !!basic.title, hasPrice: !!basic.price, imgCount: images.length });
        // （isPddSoldOutShell 已在 extractFromDOM 开头检测，此处仅保留跳过逻辑）
        if (isPddSoldOutShell) {
          this.log('dom', '拼多多已售罄壳页，跳过兜底提取');
        }
        // 标题：DOM 顺序中第一个 12-90 字的中文文本块（商品主标题，排除价格/操作类）
        if (!basic.title && !isPddSoldOutShell) {
          var pddCands = document.querySelectorAll('div,span');
          for (var pdi = 0; pdi < pddCands.length; pdi++) {
            var pddEl = pddCands[pdi];
            if (pddEl.children.length !== 0) continue;
            var pddTxt = (pddEl.textContent || '').trim();
            if (pddTxt.length < 12 || pddTxt.length > 90) continue;
            if (!/[\u4e00-\u9fa5]/.test(pddTxt)) continue;
            if (/[\u00a5\uffe5]|[\d.]+\s*元/.test(pddTxt)) continue;
            if (/^(已选|分享|收藏|加购物车|立即购买|包邮|精选|促销|活动|优惠券)/.test(pddTxt)) continue;
            basic.title = pddTxt;
            selectorLog.title = { selector: 'pdd-mobile-first-text', found: true };
            this.log('dom', '拼多多移动端标题兑底命中', { title: pddTxt.substring(0, 40) });
            break;
          }
        }
        // 价格：页面内第一个 ¥ 金额（已售罄壳页不采用）
        if (!basic.price && !isPddSoldOutShell) {
          var pddBodyText = document.body.innerText || '';
          var pddM = pddBodyText.match(/[\u00a5\uffe5]\s*(\d+(?:\.\d+)?)/);
          if (pddM && pddM[1]) {
            basic.price = this.normalizePrice(pddM[0]);
            selectorLog.price = { selector: 'pdd-mobile-price-regex', found: true };
            this.log('dom', '拼多多移动端价格兑底命中', { raw: pddM[0], price: basic.price });
          }
        }
        // 主图：pddpic 商品图（过滤小图标；壳页不采用）
        if (images.length === 0 && !isPddSoldOutShell) {
          document.querySelectorAll('img').forEach(function(pddImg) {
            var src = pddImg.src || pddImg.getAttribute('data-src') || '';
            if (src && src.indexOf('pddpic.com') > -1 && src.indexOf('mms-goods-image') > -1 &&
                pddImg.width >= 120 && pddImg.height >= 120 && images.indexOf(src) < 0) {
              images.push(src);
            }
          });
          this.log('dom', '拼多多移动端图片兑底', { count: images.length });
        }
      }
    }

    return { basic, images, description: description, descHtml: descHtml, descImages: descImages };
  },


  // ===================== 1688 专用增强（借鉴 picchajian/电商宝 的 URL 模式深扫，抗改版） =====================
  // alicdn 商品图 URL 模式（排除头像/logo/icon/图表等干扰图）
  _isAliImgUrl(u) {
    if (!u || typeof u !== 'string') return false;
    if (!/(alicdn\.com|alicdnimg\.com|taobaocdn\.com|cbu01\.alicdn\.com)/.test(u)) return false;
    if (/avatar|sns_logo|icon|logo|flag|credit|vip88|sprite|loading|\.gif(\?|$)/i.test(u)) return false;
    return true;
  },

  // 任意 JSON 结构里按 key 名找第一个字符串 URL（深度优先）
  _deepFindUrl(obj, keyRe, cap) {
    cap = cap || 50;
    var found = 0, out = null;
    var seen = [];
    function walk(o, depth) {
      if (out || found > cap || depth > 14 || !o || typeof o !== 'object') return;
      try { seen.push(o); } catch (e) { return; }
      if (Array.isArray(o)) {
        for (var i = 0; i < o.length && !out; i++) walk(o[i], depth + 1);
      } else {
        for (var k in o) {
          if (out) break;
          if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
          var v = o[k];
          if (keyRe.test(k) && typeof v === 'string' && v) { out = v; return; }
          walk(v, depth + 1);
        }
      }
      seen.pop();
    }
    walk(obj, 0);
    return out;
  },

  // 任意 JSON 结构里按 key 名找第一个值（对象/数组/字符串均可，供 skuMaps/images 别名用）
  _deepFindAny(obj, keyRe, cap) {
    cap = cap || 50;
    var out = null, visited = 0;
    function walk(o, depth) {
      if (out !== null || visited > cap || depth > 14 || !o || typeof o !== 'object') return;
      visited++;
      if (Array.isArray(o)) {
        for (var i = 0; i < o.length && out === null; i++) walk(o[i], depth + 1);
      } else {
        for (var k in o) {
          if (out !== null) break;
          if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
          var v = o[k];
          if (keyRe.test(k) && v != null && (typeof v !== 'string' || v)) { out = v; return; }
          if (v && typeof v === 'object') walk(v, depth + 1);
        }
      }
    }
    walk(obj, 0);
    return out;
  },

  // 全树扫描 alicdn 图片 URL（去重，保序）
  _deepCollectAliImages(root, cap) {
    cap = cap || 300;
    var out = [], set = Object.create(null);
    var self = this;
    function push(u) {
      if (!u || out.length >= cap) return;
      u = String(u);
      if (u.indexOf('//') === 0) u = 'https:' + u;
      if (!self._isAliImgUrl(u)) return;
      if (set[u]) return;
      set[u] = 1;
      out.push(u);
    }
    function walk(o, depth) {
      if (out.length >= cap || depth > 14 || !o || typeof o !== 'object') return;
      if (Array.isArray(o)) {
        for (var i = 0; i < o.length; i++) walk(o[i], depth + 1);
        return;
      }
      for (var k in o) {
        if (out.length >= cap) break;
        if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
        var v = o[k];
        if (typeof v === 'string') {
          if (self._isAliImgUrl(v)) push(v);
          else if (v.length < 4000 && /[",\[]/.test(v) && v.indexOf('alicdn') > -1) {
            try {
              var m = String(v).match(/https?:[^"'\\\s]+\/\w+\.(?:jpg|jpeg|jfif|png|webp|avif|bmp)[^"'\\\s]*/gi);
              if (m) m.forEach(push);
            } catch (e) {}
          }
        } else walk(v, depth + 1);
      }
    }
    walk(root, 0);
    return out;
  },

  // 1688 数据增强：优先字段别名，逐级降级到全树 URL 深扫（借鉴 picchajian extractMainImages）
  enrich1688Data(result, intercepted) {
    try {
      var responses = (intercepted && intercepted.allResponses) || [];
      var detail = (intercepted && intercepted.detailResponse) || null;
      if (!detail) {
        for (var i = 0; i < responses.length; i++) {
          var u = responses[i] && responses[i].url || '';
          if (u.indexOf('detail.1688') > -1 || u.indexOf('offer') > -1 || u.indexOf('productinfo') > -1 || u.indexOf('alibaba') > -1) { detail = responses[i].data; break; }
        }
      }
      var bags = [];
      if (detail) bags.push(detail);
      for (var j = 0; j < responses.length; j++) { if (responses[j] && responses[j].data) bags.push(responses[j].data); }
      if (typeof window !== 'undefined' && window.__ssrCache__ && window.__ssrCache__ !== intercepted) {
        var w = window.__ssrCache__;
        if (w.detailResponse) bags.push(w.detailResponse);
        for (var k = 0; k < (w.allResponses || []).length; k++) { var wd = w.allResponses[k] && w.allResponses[k].data; if (wd) bags.push(wd); }
      }

      // --- 标题/价格/公司（deepFind 别名优先） ---
      var self = this;
      if (!result.basic.title) {
        for (var b1 = 0; b1 < bags.length && !result.basic.title; b1++) {
          var t = this._deepFindUrl(bags[b1], /^(name|title|subject|itemName)$/);
          if (t && t.length > 4 && t.length < 300 && !/alicdn|http/.test(t)) result.basic.title = t;
        }
      }
      if (!result.basic.price) {
        for (var b2 = 0; b2 < bags.length && !result.basic.price; b2++) {
          var p = this._deepFindAny(bags[b2], /^(price|priceRange|priceInfo|beginAmount|salePrice)$/);
          if (p != null && typeof p === 'number' && p > 0) result.basic.price = String(p);
          else if (p && typeof p === 'object' && (p.price || p.rangePrice)) result.basic.price = String(p.price || p.rangePrice);
          else if (p && typeof p === 'string' && /\d/.test(p) && p.length < 40) result.basic.price = p;
        }
      }
      if (!result.basic.shopName) {
        for (var b3 = 0; b3 < bags.length &&bags.length; b3++) {
          var s = this._deepFindUrl(bags[b3], /^(companyName|company|sellerName|shopName|loginId|sellerLoginId)$/);
          if (s && s.length < 100) { result.basic.shopName = s; break; }
        }
      }

      // --- 图片：别名字段优先，再全树深扫 ---
      var imgs = [];
      var seenI = Object.create(null);
      function addI(u) {
        if (!u) return;
        u = String(u);
        if (u.indexOf('//') === 0) u = 'https:' + u;
        if (!self._isAliImgUrl(u) || seenI[u]) return;
        seenI[u] = 1; imgs.push(u);
      }
      var aliasHit = false;
      for (var b4 = 0; b4 < bags.length; b4++) {
        var arr = this._deepFindAny(bags[b4], /^(mainImages|images|imageList|productImages|offerImages)$/);
        if (Array.isArray(arr)) { arr.forEach(function(x){ addI(typeof x === 'string' ? x : (x && (x.url || x.imgUrl || x.imageURL || x.fullPathImageURL))); }); aliasHit = true; break; }
        if (arr && typeof arr === 'string') { addI(arr); aliasHit = true; break; }
      }
      if (imgs.length === 0) {
        for (var b5 = 0; b5 < bags.length && imgs.length < 300; b5++) {
          var got = this._deepCollectAliImages(bags[b5], 300 - imgs.length);
          got.forEach(addI);
        }
      }
      imgs.forEach(function(u){ if (result.images.indexOf(u) === -1) result.images.push(u); });

      // --- SKU：1688 saleProperties/skuMaps 深扫兜底 ---
      if (result.skus.length === 0) {
        for (var b6 = 0; b6 < bags.length && result.skus.length === 0; b6++) {
          var d = bags[b6];
          if (!d || typeof d !== 'object') continue;
          var skuMaps = this._deepFindAny(d, /^(skuMaps|skuMap|skuInfos|skuInfoMap)$/);
          if (skuMaps && typeof skuMaps === 'object') {
            var self2 = this;
            Object.keys(skuMaps).forEach(function(key) {
              var s = skuMaps[key];
              if (!s || typeof s !== 'object') return;
              var name = s.name || s.spec || key;
              var price = s.price || (s.priceRange && s.priceRange[0] && s.priceRange[0].price) || '';
              var stock = s.quantity || s.stock || (s.canBookCount != null ? s.canBookCount : 0);
              result.skus.push({ skuId: s.skuId || key, name: name, price: String(price), stock: stock, available: true });
            });
          }
        }
      }
      if (result.skus.length > 0 || imgs.length > 0) {
        this.log('extract', '1688增强完成', { imgs: result.images.length, skus: result.skus.length, title: !!result.basic.title, price: !!result.basic.price });
      }
    } catch (e) {
      try { this.log('extract', '1688增强异常', { error: e.message }); } catch (e2) {}
    }
  },
  parseSkuResponse(response) {
    try {
      const skus = [];
      // 尝试多种数据结构
      const data = response.data || response.result || response;

      // 结构1: { data: { skus: [...] } }
      if (data.skus && Array.isArray(data.skus)) {
        data.skus.forEach(sku => {
          skus.push({
            skuId: sku.skuId || sku.sku_id || '',
            name: sku.propertiesName || sku.name || '',
            price: sku.price || sku.priceText || '',
            stock: sku.quantity || sku.stock || sku.inventory || 0,
            available: sku.enable !== false
          });
        });
      }

      // 结构2: { data: { list: [...] } }
      if (data.list && Array.isArray(data.list)) {
        data.list.forEach(item => {
          if (item.skuId || item.sku_id) {
            skus.push({
              skuId: item.skuId || item.sku_id || '',
              name: item.propertiesName || item.name || item.skuName || '',
              price: item.price || '',
              stock: item.quantity || item.stock || 0
            });
          }
        });
      }

      // 京东特有：priceList 数组 [{skuId, price, name, ...}]
      if (response.priceList && Array.isArray(response.priceList)) {
        response.priceList.forEach(function(item) {
          if (item.skuId || item.id) {
            skus.push({
              skuId: item.skuId || item.id || '',
              name: item.name || item.skuName || item.title || '',
              price: item.price || item.p || item.jdPrice || '',
              stock: item.stockCount || item.stock || 0,
              available: true
            });
          }
        });
      }

      // 京东特有：priceMap 对象 { "skuId": {p, op, m} }
      if (response.priceMap && typeof response.priceMap === 'object') {
        Object.keys(response.priceMap).forEach(function(skuId) {
          var p = response.priceMap[skuId];
          if (p && (p.p || p.price)) {
            skus.push({
              skuId: skuId,
              name: p.name || p.m || '',
              price: p.p || p.price || '',
              stock: 0,
              available: true
            });
          }
        });
      }

      // 京东特有：stockStateMapResponses 库存信息
      if (response.stockStateMapResponses && typeof response.stockStateMapResponses === 'object') {
        Object.keys(response.stockStateMapResponses).forEach(function(skuId) {
          var s = response.stockStateMapResponses[skuId];
          // 找到对应的sku并更新库存
          var existing = skus.find(function(x) { return x.skuId === skuId; });
          if (existing) {
            existing.stock = s.stockCount || s.stock || existing.stock;
          }
        });
      }

      return skus;
    } catch (e) {
      console.error('解析SKU响应失败:', e);
      return [];
    }
  },

  // 从DOM解析SKU
  extractSkusFromDOM() {
    const skus = [];

    // 非SKU文本黑名单（京东常见的非SKU文本：累计评价、降价通知等）
    function isValidSkuName(text) {
      if (!text || text.length === 0 || text.length > 100) return false;
      // 排除提示性、统计性、操作类文本
      if (/累计评价|降价通知|请选择|^选择|已选|加入购物车|立即购买|关注|收藏|分享|到货通知|无货|有货|预售|抢购|秒杀/.test(text)) return false;
      // 排除纯数字+加号（如 "5000+" 评价数）
      if (/^\d+\+\s*$/.test(text)) return false;
      // 排除纯数字（可能是计数）
      if (/^\d+$/.test(text) && text.length > 5) return false;
      return true;
    }

    // 方案1: 查找完整SKU列表项（使用更精确的选择器，避免误采集非SKU文本）
    const skuItemSelectors = [
      // 京东（旧版：#choose-attr/#choose-color/#choose-version 等容器下的 .item）
      '#choose-attr .item',
      '#choose-color .item',
      '#choose-version .item',
      '#choose-type .item',
      '#choose-size .item',
      'a[data-sku]',
      // 京东新版 CSS Module 类名
      '[class*="skuItem--"]',
      '[class*="SkuItem--"]',
      '[class*="skuItemWrap--"] [class*="item--"]',
      // 淘宝/天猫
      '[class*="sku-item"]',
      '.tb-sku-item',
      '[class*="SkuItem"]',
      'li[data-sku-id]'
    ];
    skuItemSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(item => {
        const nameEl = item.querySelector(aisSel('common.skuNameAny', '[class*="sku-name"], [class*="skuName"], [class*="name"]'));
        const priceEl = item.querySelector(aisSel('common.skuPriceAny', '[class*="sku-price"], [class*="skuPrice"], [class*="price"]'));
        const stockEl = item.querySelector(aisSel('common.skuStockAny', '[class*="sku-stock"], [class*="stock"]'));

        const name = nameEl ? nameEl.textContent.trim() : item.textContent.trim();
        if (isValidSkuName(name)) {
          skus.push({
            skuId: item.getAttribute('data-sku-id') || item.getAttribute('data-sku') || item.id || '',
            name: name,
            price: priceEl ? priceEl.textContent.trim() : '',
            stock: stockEl ? stockEl.textContent.trim() : '',
            available: !item.classList.contains('disabled') && !item.hasAttribute('disabled')
          });
        }
      });
    });

    // 方案2: 从属性选项组合生成（如果上面没找到，使用更精确的选择器）
    if (skus.length === 0) {
      const propSelectors = [
        // 京东新版 CSS Module
        '[class*="propGroup--"] [class*="prop-item--"]',
        '[class*="skuProps--"] [class*="prop-item--"]',
        '[class*="Props--"] [class*="item--"]',
        // 淘宝/天猫
        'ul.sku-props li',
        '[class*="propGroup"] [class*="prop-item"]',
        '[class*="property"] [class*="option"]',
        '[data-spm="prop"] [class*="value"]'
      ];
      propSelectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(option => {
          const text = option.textContent.trim();
          if (isValidSkuName(text) && text.length < 50) {
            skus.push({
              skuId: option.getAttribute('data-sku-id') || option.getAttribute('data-value') || '',
              name: text,
              price: '',
              stock: '',
              available: !option.classList.contains('disabled') && !option.hasAttribute('disabled')
            });
          }
        });
      });
    }

    return skus;
  },

  // 京东新版DOM提取SKU（.specification-item-sku 选择器）
  // 京东新版详情页使用 specification-item-sku 类名，属性分组在 specification-group-content 容器中
  extractJdSkuFromDOM() {
    var skus = [];
    var self = this;

    // 查找所有规格选择按钮
    var specEls = document.querySelectorAll(aisDcSel('jd.skuItem', '.specification-item-sku'));
    if (specEls.length === 0) {
      // v1.1.167 抗改版兜底：类名失效时读结构化数据 ld+json（schema.org Product，跨改版稳定）
      try {
        var lds = document.querySelectorAll(aisDcSel('common.skuLdJson', 'script[type="application/ld+json"]'));   // v1.2.267 可远程覆盖
        for (var li = 0; li < lds.length; li++) {
          var ld = JSON.parse(lds[li].textContent || '{}');
          var prod = ld && (ld['@type'] === 'Product' ? ld : (ld.mainEntity && ld.mainEntity['@type'] === 'Product' ? ld.mainEntity : null));
          if (!prod) continue;
          var offers = prod.offers;
          var offArr = offers ? (Array.isArray(offers) ? offers : (offers.offers || [offers])) : [];
          offArr.forEach(function (of) {
            var nm = (of && (of.name || of.skuName || (of.itemOffered && of.itemOffered.name))) || '';
            if (nm) skus.push({ skuId: String((of && (of.sku || of.skuID)) || ''), name: String(nm), price: String((of && of.price) || ''), stock: 1, available: true });
          });
          if (skus.length) { self.log('dom', '京东SKU ld+json 兜底命中', { count: skus.length }); break; }
        }
      } catch (eLd) {}
      return skus;
    }

    // 按属性分组收集（每个父容器是一组属性，如"颜色"、"型号"）
    var groups = [];
    var groupContainers = {};
    specEls.forEach(function(el) {
      var parent = el.parentElement;
      var parentClass = parent ? parent.className : '';
      // v1.1.167：分组键加组标题——CSS Module 下各组容器类名可能相同，仅按类名分组会把不同属性组合并
      var groupTitle = '';
      if (parent) {
        var titleEl = parent.querySelector(aisDcSel('jd.skuTitle', '[class*="title"], [class*="Title"]') + ', .specification-group-title');   // v1.2.267 可远程覆盖
        if (titleEl) groupTitle = titleEl.textContent.trim();
      }
      var gKey = parentClass + '|' + groupTitle;
      if (!groupContainers[gKey]) {
        groupContainers[gKey] = {
          className: parentClass,
          title: groupTitle,
          items: []
        };
        groups.push(groupContainers[gKey]);
      }
      var text = el.textContent.trim();
      var selected = el.className.indexOf('selected') > -1;
      groupContainers[gKey].items.push({
        text: text,
        selected: selected,
        el: el
      });
    });

    this.log('dom', '京东DOM规格分组', {
      groupCount: groups.length,
      groups: groups.map(function(g){ return { title: g.title, itemCount: g.items.length, items: g.items.map(function(i){return i.text;}) }; })
    });

    // 如果只有一组属性，直接作为SKU列表
    if (groups.length === 1) {
      groups[0].items.forEach(function(item) {
        skus.push({
          skuId: self._skuOptionId(item.el),
          name: item.text,
          image: self._skuOptionImage(item.el),
          price: '',
          stock: item.selected ? 1 : 0,
          available: true
        });
      });
    } else if (groups.length > 1) {
      // 多组属性：生成笛卡尔积作为SKU名称
      // 但没有skuId，只能生成名称组合
      // 实际skuId需要从colorSizeVO获取，这里只提供名称
      var allCombos = [];
      function combine(idx, current) {
        if (idx >= groups.length) {
          allCombos.push(current.join(' / '));
          return;
        }
        for (var i = 0; i < groups[idx].items.length; i++) {
          combine(idx + 1, current.concat([groups[idx].items[i].text]));
        }
      }
      combine(0, []);
      allCombos.forEach(function(name) {
        skus.push({
          skuId: '',
          name: name,
          price: '',
          stock: 0,
          available: true
        });
      });
    }

    return skus;
  },

  // v1.1.167：SKU 选项辅助——data-sku 属性与选项缩略图（抗改版：属性/图片优先于类名）
  _skuOptionId(el) {
    try {
      if (!el) return '';
      var own = el.getAttribute('data-sku') || el.getAttribute('data-skuId') || el.getAttribute('data-id') || '';
      if (own) return String(own);
      var inner = el.querySelector(aisSel('common.skuAttrAny', '[data-sku], [data-skuId]'));
      if (inner) return String(inner.getAttribute('data-sku') || inner.getAttribute('data-skuId') || '');
      var link = el.tagName === 'A' ? el : el.querySelector('a[href*="item.jd.com"]');
      if (link) { var m = String(link.href).match(/(\d{6,})\.html/); if (m) return m[1]; }
    } catch (e) {}
    return '';
  },

  _skuOptionImage(el) {
    try {
      if (!el) return '';
      var im = el.querySelector('img');
      if (!im) return '';
      var src = im.src || im.getAttribute('data-lazyload') || im.getAttribute('data-src') || '';
      if (src.indexOf('//') === 0) src = 'https:' + src;
      // v1.2.261：统一走 jdNormImg —— 与面板路径（jdImgUp）产出**完全相同的 URL**，
      // 因此同图不会再以 s800x800 / s48x48 / jfs 三种形态重复入库（这正是「12 张变 24 张」的原因），
      // 且归一后是 /jfs/ 原图（实测 800x800），不是 48x48 小图。
      if (/360buyimg\.com/.test(src)) return jdNormImg(src);
    } catch (e) {}
    return '';
  },

  // 解析评论响应
  parseReviewResponse(response) {
    try {
      const reviews = [];
      const data = response.data || response.result || response;

      // 京东新版楼层化评论：result.floors 中 mId="commentlist-list" 的楼层
      // data 是对象，数字键(0,1,2...)对应每条评论
      if (Array.isArray(data.floors)) {
        var self = this;
        for (var fi = 0; fi < data.floors.length; fi++) {
          var floor = data.floors[fi];
          if (!floor || !floor.data) continue;
          var fmId = floor.mId || '';
          if (fmId.indexOf('commentlist-list') < 0 && fmId.indexOf('comment-list') < 0) continue;
          var floorData = floor.data;
          // data 是对象，数字键对应评论
          Object.keys(floorData).forEach(function(key) {
            var item = floorData[key];
            if (item && typeof item === 'object') {
              var parsed = self._parseJdFloorComment(item);
              if (parsed) reviews.push(parsed);
            }
          });
        }
        if (reviews.length > 0) return reviews;
      }

      // 京东 getLegoWareDetailComment: data.commentInfoList
      // 淘宝/天猫: data.comments 或 data.rateList
      // 通用: data.reviews / data.list / data.reviewList
      const reviewList = data.commentInfoList || data.comments || data.commentInfoList ||
        data.reviews || data.rateList || data.reviewList || data.list || [];

      reviewList.forEach(review => {
        if (!review) return;
        // 京东评论图片: pictureInfoList 数组 [{picURL, largePicURL, ...}]
        var imgs = [];
        if (review.pictureInfoList && Array.isArray(review.pictureInfoList)) {
          review.pictureInfoList.forEach(function(img) {
            if (img.largePicURL) imgs.push(img.largePicURL);
            else if (img.picURL) imgs.push(img.picURL);
            else if (img.imgUrl) imgs.push(img.imgUrl);
            else if (img.url) imgs.push(img.url);
          });
        }
        // 淘宝/通用图片: images / picUrls 数组
        if (review.images && Array.isArray(review.images)) {
          review.images.forEach(function(img) {
            if (typeof img === 'string') imgs.push(img);
            else if (img.imgUrl) imgs.push(img.imgUrl);
            else if (img.url) imgs.push(img.url);
          });
        }
        if (review.picUrls && Array.isArray(review.picUrls)) {
          review.picUrls.forEach(function(url) {
            if (typeof url === 'string') imgs.push(url);
          });
        }

        // 京东 SKU 属性: wareAttribute 数组 [{"颜色":"..."}]
        var skuInfo = '';
        if (review.wareAttribute && Array.isArray(review.wareAttribute)) {
          var parts = [];
          review.wareAttribute.forEach(function(attr) {
            if (typeof attr === 'object') {
              Object.keys(attr).forEach(function(k) {
                parts.push(k + ':' + attr[k]);
              });
            }
          });
          skuInfo = parts.join(' ');
        }
        if (!skuInfo) {
          skuInfo = review.productColor || review.productSize ||
                   review.auctionSku || review.sku || review.properties || '';
        }

        // 京东评论内容: commentData (纯文本) 或 tagCommentContent (带标签)
        var content = review.commentData || review.content || review.comment ||
                      review.rateContent || review.text || '';
        // 如果没有纯文本内容，从 tagCommentContent 提取（去除标签标记）
        if (!content && review.tagCommentContent) {
          content = String(review.tagCommentContent).replace(/\{\$\%\&[^&]*\&\$\%\}/g, '').trim();
        }

        reviews.push({
          reviewId: review.commentId || review.reviewId || review.guid || review.id || '',
          content: content,
          rating: DetailCollector.normalizeReviewRating(review),
          username: review.userNickName || review.nickname || review.userNnick ||
                    review.userName || review.nick || '',
          skuInfo: skuInfo,
          time: review.commentDate || review.creationTime || review.referenceTime ||
                review.date || review.time || review.created || '',
          hasImage: imgs.length > 0,
          images: imgs,
          // 京东扩展字段
          publishArea: review.publishArea || '',
          praiseCnt: review.praiseCnt || 0,
          buyCount: review.buyCount || 0,
          isAppend: review.isAppend || (review.commentType === '2'),
          appendContent: review.appendContent || review.addFeedback || ''
        });
      });

      return reviews;
    } catch (e) {
      console.error('解析评论响应失败:', e);
      return [];
    }
  },

  // 解析京东新版楼层化评论单项（commentlist-list.data 中的元素）
  // 京东楼层评论可能嵌套在 commentInfo / comment 字段中，也可能直接平铺
  _parseJdFloorComment(item) {
    if (!item || typeof item !== 'object') return null;
    // 楼层评论可能有包裹层：{ commentInfo: {...} } 或 { comment: {...} }
    var c = item.commentInfo || item.comment || item.commentData_info || item;
    if (!c || typeof c !== 'object') return null;

    // 提取评论图片
    var imgs = [];
    var picList = c.pictureInfoList || c.pictures || c.imageList || item.pictureInfoList || [];
    if (Array.isArray(picList)) {
      picList.forEach(function(img) {
        if (!img) return;
        if (img.largePicURL) imgs.push(img.largePicURL);
        else if (img.picURL) imgs.push(img.picURL);
        else if (img.imgUrl) imgs.push(img.imgUrl);
        else if (img.url) imgs.push(img.url);
        else if (typeof img === 'string') imgs.push(img);
      });
    }

    // 提取SKU属性
    var skuInfo = '';
    var wareAttr = c.wareAttribute || item.wareAttribute || c.productSkuInfo || item.productSkuInfo;
    if (Array.isArray(wareAttr)) {
      var parts = [];
      wareAttr.forEach(function(attr) {
        if (typeof attr === 'object') {
          Object.keys(attr).forEach(function(k) { parts.push(k + ':' + attr[k]); });
        } else if (typeof attr === 'string') {
          parts.push(attr);
        }
      });
      skuInfo = parts.join(' ');
    } else if (typeof wareAttr === 'string') {
      skuInfo = wareAttr;
    }
    if (!skuInfo) {
      skuInfo = c.productColor || c.productSize || c.auctionSku || c.sku || c.properties || item.skuInfo || '';
    }

    // 提取评论内容
    var content = c.commentData || c.content || c.comment || c.commentText ||
                  c.rateContent || c.text || item.content || item.commentData || '';
    if (!content && c.tagCommentContent) {
      content = String(c.tagCommentContent).replace(/\{\$\%\&[^&]*\&\$\%\}/g, '').trim();
    }

    // 提取评论ID
    var reviewId = c.commentId || c.guid || c.id || c.commentGuid || item.commentId || item.guid || '';

    // 无内容和ID的项视为无效
    if (!content && !reviewId) return null;

    return {
      reviewId: String(reviewId),
      content: content,
      rating: DetailCollector.normalizeReviewRating(Object.assign({}, item, c)),
      username: c.userNickName || c.nickname || c.userName || c.nick || c.userImage || item.userNickName || '',
      skuInfo: skuInfo,
      time: c.commentDate || c.creationTime || c.referenceTime || c.date || c.time || c.created || item.commentDate || '',
      hasImage: imgs.length > 0,
      images: imgs,
      publishArea: c.publishArea || c.location || '',
      praiseCnt: c.praiseCnt || c.usefulVoteCount || 0,
      buyCount: c.buyCount || 0,
      isAppend: c.isAppend || (c.commentType === '2'),
      appendContent: c.appendContent || c.addFeedback || c.replyList2 || ''
    };
  },

  // 主世界 fetch 统一通过 background worker 执行。公开 CustomEvent 可被页面脚本伪造，
  // 不再用于携带凭据的主动请求。
  async fetchInMainWorld(url, options, timeout) {
    var self = this;
    timeout = timeout || 10000;

    // worker 校验 sender.tab.url、目标平台家族、HTTPS、端口和响应大小。
    try {
      var resp = await new Promise(function(resolve) {
        var done = false;
        var timer = setTimeout(function() {
          if (!done) {
            done = true;
            resolve({ success: false, error: 'worker fetch超时' });
          }
        }, timeout);
        try {
          chrome.runtime.sendMessage({ action: 'mainWorldFetch', url: url }, function(r) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              resolve({ success: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(r || { success: false });
            }
          });
        } catch(e) {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve({ success: false, error: e.message });
          }
        }
      });

      if (resp.success && resp.result) {
        var result = resp.result;
        if (result.error) {
          self.log('jd-api', 'worker fetch返回错误', { error: result.error });
        } else {
          self.log('jd-api', 'worker fetch成功', { length: result.length, jsonKeys: result.json ? Object.keys(result.json).slice(0, 10) : null });
          return { json: result.json, text: result.text || '' };
        }
      } else {
        self.log('jd-api', 'worker fetch失败', { error: resp.error });
      }
    } catch(e) {
      self.log('jd-api', 'worker fetch异常', { error: e.message });
    }

    // 最终回退：返回空
    return { json: null, text: '' };
  },

  // 京东兜底：直接请求评论API（当拦截器错过API时使用）
  // 使用主世界fetch避免CORS限制
  async fetchJdReviewsDirectly(itemId) {
    if (!itemId) return [];
    var self = this;
    self.log('jd-api', '直接请求京东评论API（主世界fetch）', { itemId: itemId });

    var apiUrl = 'https://api.m.jd.com/?functionId=getLegoWareDetailComment' +
      '&body=' + encodeURIComponent(JSON.stringify({
        shopType: '0',
        sku: parseInt(itemId) || itemId,
        commentNum: 10,
        source: 'pc',
        own: '0',
        sortType: 5,
        currentSkuid: parseInt(itemId) || itemId,
        page: 1,
        pageSize: (function(){try{return Number(aisNum('common.reviewPageSize',10))||10;}catch(e){return 10;}})(),
        isOriginTag: 0
      })) +
      '&appid=item-v3&functionId=getLegoWareDetailComment&t=' + Date.now();

    try {
      var result = await this.fetchInMainWorld(apiUrl, { credentials: 'include' }, 10000);
      var json = result.json;
      self.log('jd-api', '京东评论API响应', {
        hasData: !!json,
        allCnt: json ? json.allCnt : null,
        commentInfoListLen: json && json.commentInfoList ? json.commentInfoList.length : 0,
        rawTextHead: result.text.substring(0, 100)
      });
      if (json) {
        var parsed = self.parseReviewResponse(json);
        self.log('jd-api', '京东评论解析完成', { count: parsed.length });
        return parsed;
      }
    } catch (e) {
      self.log('jd-api', '主世界fetch评论失败', { error: e.message });
    }
    return [];
  },

  // 京东新版：通过API翻页采集全部评论（不依赖DOM tab点击）
  // 京东新版详情页评价区是懒加载，DOM tab点击不可靠，直接调用API翻页更高效
  async fetchJdAllReviewsDirectly(itemId, initialReviews, opts) {
    // 修复：不再无条件重置停止标志，尊重用户“停止采集”（由 collectAllReviews 入口统一复位）
    if (!itemId) return initialReviews || [];
    var self = this;
    var allReviews = [];
    var seenIds = {};
    opts = opts || {};
    var reviewPageLimit = opts.reviewPageLimit || 0; // 0=不限
    var reviewSpeedMs = { slow: 12000, normal: 6500, fast: 4000 }[opts.reviewSpeed || 'slow'] || 12000;

    // 合并初始评论
    (initialReviews || []).forEach(function(r) {
      var key = r.reviewId || (r.content || '').slice(0, 30);
      if (!seenIds[key]) { seenIds[key] = true; allReviews.push(r); }
    });

    var initCount = allReviews.length;
    self.log('jd-api', '开始API翻页采集京东评论', { itemId: itemId, initCount: initCount, reviewPageLimit: reviewPageLimit });

    var maxPages = 100; // 最多翻100页（约1000条）
    // 免费版页数限制
    if (reviewPageLimit > 0 && reviewPageLimit < maxPages) {
      maxPages = reviewPageLimit;
      self.log('jd-api', '已应用评论页数限制', { maxPages: maxPages });
    }
    var emptyPages = 0;
    var maxEmptyPages = 2; // 连续2页无新评论则停止
    var startTime = Date.now();
    var maxDuration = 120000; // 总耗时上限2分钟

    for (var page = 1; page <= maxPages && !this._stopped; page++) {
      if (Date.now() - startTime > maxDuration) {
        self.log('jd-api', 'API翻页总超时，停止', { page: page, duration: Math.round((Date.now() - startTime) / 1000) + 's' });
        break;
      }

      var apiUrl = 'https://api.m.jd.com/?functionId=getLegoWareDetailComment' +
        '&body=' + encodeURIComponent(JSON.stringify({
          shopType: '0',
          sku: parseInt(itemId) || itemId,
          commentNum: 10,
          source: 'pc',
          own: '0',
          sortType: 5,
          currentSkuid: parseInt(itemId) || itemId,
          page: page,
          pageSize: (function(){try{return Number(aisNum('common.reviewPageSize',10))||10;}catch(e){return 10;}})(),
          isOriginTag: 0
        })) +
        '&appid=item-v3&functionId=getLegoWareDetailComment&t=' + Date.now();

      try {
        var result = await self.fetchInMainWorld(apiUrl, { credentials: 'include' }, 10000);
        var json = result.json;
        if (!json) {
          self.log('jd-api', 'API返回非JSON，停止翻页', { page: page, rawText: (result.text || '').substring(0, 200) });
          break;
        }

        // 京东接口 605 = 需要登录认证，明确提示，避免静默只采几条
        if (json && json.code === '605') {
          self.log('jd-api', '京东接口需登录认证(605)，请先登录京东', { page: page });
          if (typeof chrome !== 'undefined' && chrome.runtime) {
            try { chrome.runtime.sendMessage({ action: 'jdLoginRequired', url: 'https://passport.jd.com/new/login.aspx' }); } catch(e){}
          }
          break;
        }
        var comments = json.commentInfoList || (json.data && json.data.commentInfoList) || [];
        if (!Array.isArray(comments) || comments.length === 0) {
          emptyPages++;
          self.log('jd-api', 'API返回空评论', { page: page, emptyPages: emptyPages });
          if (emptyPages >= maxEmptyPages) {
            self.log('jd-api', '连续' + maxEmptyPages + '页无新评论，停止');
            break;
          }
          continue;
        }
        emptyPages = 0;

        // 解析评论
        var parsed = self.parseReviewResponse(json);
        var newCount = 0;
        parsed.forEach(function(r) {
          var key = r.reviewId || (r.content || '').slice(0, 30);
          if (!seenIds[key]) { seenIds[key] = true; allReviews.push(r); newCount++; }
        });

        self.log('jd-api', 'API翻页', { page: page, got: parsed.length, newCount: newCount, total: allReviews.length });

        self._dispatchProgress(page, allReviews.length, newCount);

        // 如果本页无新评论（全部重复），可能到尾了
        if (newCount === 0) {
          emptyPages++;
          if (emptyPages >= maxEmptyPages) {
            self.log('jd-api', '连续' + maxEmptyPages + '页无新评论，停止');
            break;
          }
        }

        // 安全上限
        if (allReviews.length >= 2000) {
          self.log('jd-api', '达到评论上限2000，停止');
          break;
        }

        // 请求间隔（防风控）：按采集速度随机延迟（±30%）+ 限流
        var jdWait = reviewSpeedMs * (0.7 + Math.random() * 0.6);
        if (typeof AntiCrawl !== 'undefined' && AntiCrawl.wait) {
          await self._interruptibleWait(jdWait);
          // 检测是否触发京东风控，触发则立即停止翻页
          try {
            var ac = AntiCrawl.detectAntiCrawl();
            if (ac && ac.detected) {
              self.log('jd-api', '检测到京东风控，停止翻页', { type: ac.type });
              break;
            }
          } catch (e2) {}
        } else {
          await new Promise(function(r) { setTimeout(r, 2500); });
        }
      } catch (e) {
        self.log('jd-api', 'API翻页请求失败', { page: page, error: e.message });
        emptyPages++;
        if (emptyPages >= maxEmptyPages) break;
      }
    }

    self.log('jd-api', 'API翻页采集完成', { totalPages: page, totalReviews: allReviews.length, initCount: initCount });
    return allReviews;
  },

  // 京东新版：DOM滚动+API拦截方案采集评论
  // 滚动到评价区，让京东页面自己加载评论，通过拦截器捕获新评论API响应
  // 每次新评论API响应到达时，解析并合并评论
  async collectJdReviewsByScrolling(initialReviews, opts) {
    var self = this;
    var allReviews = [];
    var seenIds = {};
    opts = opts || {};
    var reviewPageLimit = opts.reviewPageLimit || 0; // 0=不限
    var reviewLimit = opts.reviewLimit || 0; // 0=不限（条数上限，采够即停）

    // 合并初始评论
    (initialReviews || []).forEach(function(r) {
      var key = r.reviewId || (r.content || '').slice(0, 30);
      if (!seenIds[key]) { seenIds[key] = true; allReviews.push(r); }
    });

    var initCount = allReviews.length;
    self.log('jd-scroll', '开始DOM滚动采集京东评论', { initCount: initCount, reviewPageLimit: reviewPageLimit });

    // 监听拦截器的评论API响应事件
    var newReviewResponses = [];
    function onIntercepted(e) {
      if (DetailCollector._isTrustedInterceptDetail(e.detail) && e.detail.type === 'review') {
        newReviewResponses.push(e.detail.data);
        self.log('jd-scroll', '捕获新评论API响应', { queued: newReviewResponses.length });
      }
    }
    window.addEventListener('ssr:ready', onIntercepted);

    // 查找评价区元素
    var reviewSection = document.querySelector(aisSel('common.reviewTitleAny', '#comment-title, .comment-title, [class*="comment-title"]')) ||
                        document.querySelector(aisSel('common.reviewBoxAny', '#comment, [class*="comment"], [id*="comment"]'));

    if (!reviewSection) {
      self.log('jd-scroll', '未找到评价区，尝试等待评价区加载');
      await new Promise(function(r) { setTimeout(r, 2000); });
      reviewSection = document.querySelector(aisSel('common.reviewTitleAny', '#comment-title, .comment-title, [class*="comment-title"]')) ||
                      document.querySelector('#comment, [class*="comment"]');
    }

    if (reviewSection) {
      self.log('jd-scroll', '找到评价区', { tag: reviewSection.tagName, id: reviewSection.id, className: reviewSection.className });

      // 点击评价标题触发评论加载
      try { reviewSection.click(); } catch(e) {}
      await new Promise(function(r) { setTimeout(r, 2000); });

      // 点击"全部评价"按钮（京东新版有 .all-btn 按钮触发评价弹窗）
      var allBtn = document.querySelector('.all-btn, [class*="all-btn"], [class*="allBtn"]');
      if (allBtn) {
        self.log('jd-scroll', '点击"全部评价"按钮', { text: (allBtn.textContent||'').trim() });
        try { allBtn.click(); } catch(e) {}
        await new Promise(function(r) { setTimeout(r, 4000); });
      }

      // 处理已捕获的评论API响应
      while (newReviewResponses.length > 0) {
        var resp = newReviewResponses.shift();
        var parsed = self.parseReviewResponse(resp);
        var newCount = 0;
        parsed.forEach(function(r) {
          var key = r.reviewId || (r.content || '').slice(0, 30);
          if (!seenIds[key]) { seenIds[key] = true; allReviews.push(r); newCount++; }
        });
        self.log('jd-scroll', '解析拦截的评论API', { got: parsed.length, newCount: newCount, total: allReviews.length });
      }

      // 查找评价弹窗容器（京东新版弹窗是 #rateList / .jdc-page-overlay）
      var rateModal = document.querySelector('#rateList') ||
                      document.querySelector('[class*="rateListBox"], [class*="RateListBox"], [class*="rate-list-box"]') ||
                      document.querySelector('.jdc-page-overlay');

      if (rateModal) {
        self.log('jd-scroll', '找到评价弹窗', { id: rateModal.id, className: (rateModal.className||'').substring(0, 80) });
      }

      // 主循环：在弹窗内滚动，触发加载更多评论
      var maxIterations = 50;
      // 免费版页数限制
      if (reviewPageLimit > 0 && reviewPageLimit < maxIterations) {
        maxIterations = reviewPageLimit;
        self.log('jd-scroll', '已应用评论页数限制', { maxIterations: maxIterations });
      }
      var iterCount = 0;
      var emptyCount = 0;
      var maxEmpty = 5;
      var startTime = Date.now();
      var maxDuration = 120000; // 2分钟

      while (iterCount < maxIterations && !self._stopped) {
        if (Date.now() - startTime > maxDuration) {
          self.log('jd-scroll', '总超时，停止', { duration: Math.round((Date.now() - startTime) / 1000) + 's' });
          break;
        }
        iterCount++;

        // 优先在评价弹窗内滚动。用启发式查找"真正可滚动且含评论"的容器：
        // 弹窗内优先，回退全页。避免因京东弹窗类名变化找不到滚动列表。
        var scrollContainer = null;
        function _isScrollable(el) { try { return el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 60; } catch(e) { return false; } }
        var _scope = rateModal || document;
        var _sels = ['[class*="continuous-scroll"]','[class*="continuous"]','[class*="_list_"]','[class*="comment-list"]','[class*="CommentList"]','[class*="commentList"]','[class*="rate-list"]','[class*="RateList"]','[class*="comment"]','[class*="Comment"]','.comment-root','#comment-root','ul.comment','div.comment'];
        var _list = [];
        try { _sels.forEach(function(s){ var _ns=_scope.querySelectorAll(s); for(var _qi=0;_qi<_ns.length;_qi++) _list.push(_ns[_qi]); }); } catch(e) {}
        for (var _i=0;_i<_list.length;_i++){ var _el=_list[_i]; if(_isScrollable(_el)){ scrollContainer=_el; break; } }
        if (!scrollContainer && rateModal) { try { var _divs=rateModal.querySelectorAll('div'); for(var _j=_divs.length-1;_j>=0;_j--){ if(_isScrollable(_divs[_j])){ scrollContainer=_divs[_j]; break; } } } catch(e) {} }
        if (scrollContainer) self.log('jd-scroll', '锁定可滚动评论容器', { tag: scrollContainer.tagName, cls: (scrollContainer.className||'').substring(0,60) });

        if (scrollContainer) {
          // 自然滚动：分3-5段小步滚到底（模拟真实滚轮，避免瞬间跳到底被风控）
          var _target = scrollContainer.scrollHeight;
          var _curTop = scrollContainer.scrollTop || 0;
          var _before = scrollContainer.scrollHeight;
          var _seg = 3 + Math.floor(Math.random() * 3); // 3-5 段
          for (var _s = 1; _s <= _seg; _s++) {
            _curTop = Math.min(_target, _curTop + Math.round((_target - _curTop) / (_seg - _s + 1)));
            try { scrollContainer.scrollTop = _curTop; } catch(e) {}
            try { scrollContainer.dispatchEvent(new Event('scroll', { bubbles: false })); } catch(e) {}
            for (var _w = 0; _w < 3; _w++) {
              try { scrollContainer.dispatchEvent(new WheelEvent('wheel', { deltaY: 180, bubbles: true, cancelable: true })); } catch(e) {}
              await new Promise(function(r){ setTimeout(r, 90 + Math.random() * 140); });
            }
          }
          try { scrollContainer.scrollTop = scrollContainer.scrollHeight; scrollContainer.dispatchEvent(new Event('scroll', { bubbles: false })); } catch(e) {}
          scrollContainer.__beforeH = _before;
        }

        // 等待新评论加载（可中断：停止采集时立即返回）+ 风控检测
        var _delayMs = 12000;
        if (typeof AntiCrawl !== 'undefined' && AntiCrawl.randomDelay) { _delayMs = AntiCrawl.randomDelay('reviewScroll'); }
        await self._interruptibleWait(_delayMs);
        if (typeof AntiCrawl !== 'undefined') {
          try {
            var _ac = AntiCrawl.detectAntiCrawl();
            if (_ac && _ac.detected) { self.log('jd-scroll', '检测到京东风控，停止滚动采集', { type: _ac.type }); break; }
          } catch(e2) {}
        }

        // 处理新捕获的评论API响应
        var iterNewCount = 0;
        while (newReviewResponses.length > 0) {
          var resp2 = newReviewResponses.shift();
          var parsed2 = self.parseReviewResponse(resp2);
          parsed2.forEach(function(r) {
            var key = r.reviewId || (r.content || '').slice(0, 30);
            if (!seenIds[key]) { seenIds[key] = true; allReviews.push(r); iterNewCount++; }
          });
        }

        // 也尝试从DOM提取评论（弹窗中的评论）
        var domReviews = self._extractReviewsFromCurrentPage();
        domReviews.forEach(function(r) {
          var key = r.reviewId || (r.content || '').slice(0, 30);
          if (!seenIds[key]) { seenIds[key] = true; allReviews.push(r); iterNewCount++; }
        });

        self.log('jd-scroll', '迭代 ' + iterCount, { newCount: iterNewCount, total: allReviews.length, hasModal: !!rateModal, hasScroll: !!scrollContainer });
        self._dispatchProgress(iterCount, allReviews.length, iterNewCount);

        // 采够数量上限则提前停止
        if (reviewLimit > 0 && allReviews.length >= reviewLimit) {
          self.log('jd-scroll', '已达评论数量上限，提前停止', { total: allReviews.length, limit: reviewLimit });
          break;
        }

        if (iterNewCount === 0) {
          emptyCount++;
          if (emptyCount >= maxEmpty) {
            self.log('jd-scroll', '连续' + maxEmpty + '次无新评论，停止');
            break;
          }
        } else {
          emptyCount = 0;
        }

        // 安全上限
        if (allReviews.length >= 2000) {
          self.log('jd-scroll', '达到评论上限2000，停止');
          break;
        }
      }
    } else {
      self.log('jd-scroll', '未找到评价区，无法滚动采集');
    }

    // 清理监听器
    window.removeEventListener('ssr:ready', onIntercepted);

    // 处理剩余的评论API响应
    while (newReviewResponses.length > 0) {
      var resp4 = newReviewResponses.shift();
      var parsed4 = self.parseReviewResponse(resp4);
      parsed4.forEach(function(r) {
        var key = r.reviewId || (r.content || '').slice(0, 30);
        if (!seenIds[key]) { seenIds[key] = true; allReviews.push(r); }
      });
    }

    // 回退方案：直接扫描 allResponses 查找未被分类为 review 的评论数据
    // 京东新版 client.action 通用URL可能未被正确分类，这里做兜底扫描
    var intercepted = window.__ssrCache__ || {};
    var allResps = intercepted.allResponses || [];
    var beforeFallbackCount = allReviews.length;
    allResps.forEach(function(respItem) {
      if (!respItem || !respItem.data) return;
      var respUrl = respItem.url || '';
      // 只处理 jd.com 的响应
      if (respUrl.indexOf('jd.com') < 0 && respUrl.indexOf('3.cn') < 0) return;
      // 尝试解析为评论
      var parsed = self.parseReviewResponse(respItem.data);
      if (parsed && parsed.length > 0) {
        parsed.forEach(function(r) {
          var key = r.reviewId || (r.content || '').slice(0, 30);
          if (!seenIds[key]) { seenIds[key] = true; allReviews.push(r); }
        });
      }
    });
    if (allReviews.length > beforeFallbackCount) {
      self.log('jd-scroll', 'allResponses兜底扫描发现额外评论', { added: allReviews.length - beforeFallbackCount, total: allReviews.length, scannedResps: allResps.length });
    }

    self.log('jd-scroll', 'DOM滚动采集完成', { totalReviews: allReviews.length, initCount: initCount });

    // 达到免费/过期版页数上限时，提示用户续期
    if (reviewPageLimit > 0 && iterCount >= reviewPageLimit) {
      try {
        if (window.LicenseManager && typeof window.LicenseManager.getStatusSummary === 'function') {
          var _licSt = await window.LicenseManager.getStatusSummary();
          if (_licSt && (_licSt.status === 'expired' || _licSt.status === 'free')) {
            try { chrome.runtime.sendMessage({ action: 'licenseLimitReached', pageLimit: reviewPageLimit, count: allReviews.length }); } catch(e) {}
          }
        }
      } catch(e) {}
    }
    return allReviews;
  },

  // 京东兜底：直接请求商品详情API（获取SKU名称、参数等）
  // 使用主世界fetch避免CORS限制
  async fetchJdDetailDirectly(itemId) {
    if (!itemId) return null;
    var self = this;
    self.log('jd-api', '直接请求京东详情API（主世界fetch）', { itemId: itemId });

    // 京东新版详情API: pc_detailpage_wareBusiness（走 api.m.jd.com）
    // 旧版 wareBusiness.action 已弃用
    var body = JSON.stringify({
      skuId: String(itemId),
      area: '1_72_4137_0',
      num: '1',
      isModify: false,
      isReceivePc: 1
    });
    var apiUrl = 'https://api.m.jd.com/?functionId=pc_detailpage_wareBusiness' +
      '&body=' + encodeURIComponent(body) +
      '&appid=item-v3&functionId=pc_detailpage_wareBusiness&t=' + Date.now();

    try {
      var result = await this.fetchInMainWorld(apiUrl, { credentials: 'include' }, 10000);
      var json = result.json;
      if (json) {
        self.log('jd-api', '京东详情API响应', {
          hasData: !!json,
          keys: Object.keys(json).slice(0, 15),
          rawTextHead: result.text.substring(0, 100)
        });
        return json;
      } else {
        self.log('jd-api', '京东详情API响应非JSON', { rawTextHead: result.text.substring(0, 200) });
      }
    } catch (e) {
      self.log('jd-api', '主世界fetch详情失败', { error: e.message });
    }
    return null;
  },

  // 从页面SSR数据解析评论（天猫/淘宝 Lite 页不渲染评价区且无评论API时兜底）
  // 数据源：页面内嵌脚本中的 rateVO.group.items（含 user/content/skuInfo/time/media）
  extractReviewsFromSsr() {
    const reviews = [];
    try {
      const html = document.documentElement.outerHTML || '';
      const keyIdx = html.indexOf('"rateVO":{');
      if (keyIdx < 0) {
        this.log('ssr', '未找到 rateVO 数据');
        return reviews;
      }
      // 平衡括号提取 rateVO JSON
      let depth = 0, inStr = false, i = keyIdx + 9;
      let end = -1;
      for (; i < html.length; i++) {
        const ch = html[i];
        if (inStr) {
          if (ch === '\\') { i++; continue; }
          if (ch === '"') inStr = false;
        } else {
          if (ch === '"') inStr = true;
          else if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
      }
      if (end < 0) return reviews;
      const rateVO = JSON.parse(html.substring(keyIdx + 9, end));
      const items = (rateVO.group && rateVO.group.items) || rateVO.items || [];
      items.forEach(function(it) {
        if (!it) return;
        const media = (it.media || []).filter(function(m) { return m && m.imageUrl; }).map(function(m) {
          var src = m.imageUrl;
          if (src && src.indexOf('//') === 0) src = 'https:' + src;
          return src;
        });
        reviews.push({
          reviewId: it.feedId || it.id || it.reviewId || '',
          content: it.content || it.comment || it.reviewContent || '',
          rating: it.rating || it.star || it.score || 0,
          username: it.userName || it.user || it.nick || '',
          skuInfo: it.skuInfo || it.sku || it.property || '',
          time: it.dateTime || it.time || it.createTime || it.createTimeStr || '',
          hasImage: media.length > 0,
          images: media,
          isAppend: !!(it.isAppend || it.append),
          appendContent: it.appendContent || it.appendContentText || ''
        });
      });
      this.log('ssr', 'SSR评论解析', { count: reviews.length, totalCount: rateVO.totalCount || '' });
    } catch (e) {
      this.log('ssr', 'SSR评论解析失败', { error: e.message });
    }
    return reviews;
  },

  // 从DOM解析评论
  extractReviewsFromDOM() {
    const reviews = [];

    // 查找评论列表容器（含新版天猫/京东 CSS Module 类名）
    const reviewContainerSelectors = [
      // 京东
      '#comment-0 .comment-item',
      '#comment-0 .comment-con',
      '.comment-list .comment-item',
      '[class*="comment-item"]',
      '[class*="J-comment-item"]',
      '[class*="CommentItem--"]',
      '[class*="commentItem--"]',
      // 淘宝/天猫
      '#J_Reviews .rate-item',
      '.tm-rate-list .rate-item',
      '[class*="rate-list"] .rate-item',
      '.review-item',
      '.comment-item',
      '[class*="RateList"] [class*="item"]',
      // 新版天猫/淘宝 CSS Module 类名：div.Comment-- 为单条评论
      'div[class*="Comment--"]',
      '[class*="comments--"] [class*="Comment--"]',
      '[class*="Review--"] [class*="Item--"]',
      '.rate-item'
    ];

    reviewContainerSelectors.forEach(sel => {
      const items = document.querySelectorAll(sel);
      items.forEach(item => {
        const contentSelectors = [
          // 京东
          '.comment-con',
          '.comment-content',
          '[class*="comment-content"]',
          '[class*="commentContent"]',
          '[class*="CommentContent--"]',
          // 淘宝/天猫
          '[class*="rate-content"]',
          '[class*="tm-rate-content"]',
          '[class*="contentWrapper--"]',
          '[class*="content--"]',
          '[class*="Content--"]',
          '[class*="content"]',
          '[class*="review-content"]',
          'p'
        ];
        const userSelectors = [
          '[class*="rate-user"]',
          '[class*="tm-rate-user"]',
          '[class*="header--"]',
          '[class*="User--"]',
          '[class*="user--"]',
          '[class*="user"]',
          '[class*="nick"]',
          '.user-name'
        ];
        const skuSelectors = [
          '[class*="rate-sku"]',
          '[class*="tm-rate-sku"]',
          '[class*="Sku--"]',
          '[class*="sku--"]',
          '[class*="sku"]',
          '[class*="spec"]',
          '[class*="properties"]'
        ];
        const timeSelectors = [
          '[class*="rate-date"]',
          '[class*="tm-rate-date"]',
          '[class*="Date--"]',
          '[class*="date--"]',
          '[class*="time"]',
          '[class*="date"]',
          '[class*="create-time"]'
        ];
        const starSelectors = [
          '[class*="rate-star"]',
          '[class*="tm-rate-star"]',
          '[class*="Star--"]',
          '[class*="star"]',
          '[class*="rating"]',
          '.J_RateStar'
        ];

        const contentEl = this.queryFirst(item, contentSelectors);
        const userEl = this.queryFirst(item, userSelectors);
        const skuEl = this.queryFirst(item, skuSelectors);
        const timeEl = this.queryFirst(item, timeSelectors);
        const starEl = this.queryFirst(item, starSelectors);

        let content = contentEl ? contentEl.textContent.trim() : '';

        // 新版天猫评论：用户名/日期/SKU 可能内嵌在文本中，尝试解析
        let username = userEl ? userEl.textContent.trim() : '';
        let time = timeEl ? timeEl.textContent.trim() : '';
        let skuInfo = skuEl ? skuEl.textContent.trim() : '';

        // 若文本包含"已购："格式，提取SKU信息
        const skuMatch = content.match(/已购[：:]\s*([^，。！！\s]{2,30})/);
        if (skuMatch && !skuInfo) skuInfo = skuMatch[1];

        // 若文本以用户名开头，提取用户名
        const userMatch = content.match(/^([^\d\s]{2,15})\s*\d{4}/);
        if (userMatch && !username) username = userMatch[1];

        // 提取日期
        const dateMatch = content.match(/(\d{4}[-./]\d{1,2}[-./]\d{1,2})/);
        if (dateMatch && !time) time = dateMatch[1];

        // 清理内容：移除已购信息和日期前缀，保留正文
        if (skuMatch) content = content.replace(/已购[：:]\s*[^，。！！\s]{2,30}/, '').trim();
        if (userMatch) content = content.replace(/^([^\d\s]{2,15})\s*/, '').trim();
        if (dateMatch) content = content.replace(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/, '').trim();

        // 提取评论图片URL
        var reviewImages = [];
        try {
          var rImgs = item.querySelectorAll('img');
          for (var ri2 = 0; ri2 < rImgs.length; ri2++) {
            var rSrc = rImgs[ri2].src || rImgs[ri2].getAttribute('src') || '';
            if ((rSrc.indexOf('alicdn') >= 0 || rSrc.indexOf('taobaocdn') >= 0 || rSrc.indexOf('rate.jpg') >= 0 || rSrc.indexOf('360buyimg.com') >= 0) &&
                rSrc.indexOf('avatar') < 0 && rSrc.indexOf('logo') < 0) {
              var rw = rImgs[ri2].naturalWidth || rImgs[ri2].width || 0;
              var rh = rImgs[ri2].naturalHeight || rImgs[ri2].height || 0;
              if (rw > 0 && rw < 30) continue;
              if (rh > 0 && rh < 30) continue;
              if (reviewImages.indexOf(rSrc) < 0) reviewImages.push(rSrc);
            }
          }
        } catch(e) {}

        // 过滤空白评论和过短内容
        if (content && content.length > 2) {
          reviews.push({
            reviewId: item.getAttribute('data-rate-id') || item.id || '',
            content: content,
            rating: starEl ? this.extractRating(starEl) : 0, // 无星级保持0（未知），不默认好评
            username: username,
            skuInfo: skuInfo,
            time: time,
            hasImage: reviewImages.length > 0,
            images: reviewImages,
            isAppend: !!item.querySelector('[class*="append"], [class*="追评"]'),
            appendContent: ''
          });
        }
      });
    });

    // 去重（根据内容和用户名）
    const seen = new Set();
    return reviews.filter(r => {
      const key = r.content + r.username;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },

  // 从选择器列表中查找第一个匹配元素
  queryFirst(root, selectors) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el && el.textContent.trim()) return el;
    }
    return null;
  },

  // 提取评分
  extractRating(starEl) {
    const fullStars = starEl.querySelectorAll('[class*="full"], [class*="active"], [class*="filled"], [aria-checked="true"]').length;
    const allStars = starEl.querySelectorAll('svg, .iconfont, span, [class*="star"]').length;
    // 未识别到明确已点亮星时返回 0（未知），不猜好评
    if (fullStars === 0) return 0;
    return allStars > 0 ? Math.min(5, Math.max(1, Math.round((fullStars / allStars) * 5))) : fullStars;
  },

  // 解析商品参数
  parseParameters(response) {
    try {
      const params = [];
      const data = response.data || response.result || response;

      // 京东特有：productAttributeVO.coreAttributes
      if (data.productAttributeVO) {
        var coreAttrs = data.productAttributeVO.coreAttributes || [];
        coreAttrs.forEach(function(p) {
          params.push({
            name: p.labelName || p.name || '',
            value: p.labelValue || p.value || ''
          });
        });
        // attributes 中的非品牌/编号项也作为参数
        var attrs = data.productAttributeVO.attributes || [];
        attrs.forEach(function(p) {
          var name = p.labelName || p.name || '';
          if (name && name !== '品牌' && name !== '商品编号') {
            params.push({
              name: name,
              value: p.labelValue || p.value || ''
            });
          }
        });
      }

      // 查找参数列表（通用）
      const paramList = data.params || data.parameters || data.attrs || [];
      if (Array.isArray(paramList)) {
        paramList.forEach(p => {
          params.push({
            name: p.name || p.key || p.field || p.labelName || '',
            value: p.value || p.val || p.content || p.labelValue || ''
          });
        });
      }

      // 另一种结构: { data: { item: { params: [...] } } }
      const itemData = data.item || data.goods || data.product;
      if (itemData && itemData.params) {
        itemData.params.forEach(p => {
          params.push({
            name: p.name || '',
            value: p.value || ''
          });
        });
      }

      return params;
    } catch (e) {
      return [];
    }
  },

  // 从DOM提取商品参数
  extractParametersFromDOM() {
    const params = [];

    // 查找参数表格
    const paramTables = document.querySelectorAll('.Ptable, [class*="Ptable"], [class*="parameter"], [class*="params"], [class*="property"], [class*="attr-table"]');

    paramTables.forEach(table => {
      const rows = table.querySelectorAll('tr, li, dt, dd, [class*="row"]');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td, th, dt, dd, [class*="name"], [class*="value"]');
        if (cells.length >= 2) {
          const name = cells[0].textContent.trim().replace(/[：:]$/, '');
          const value = cells[1].textContent.trim();
          if (name && value) {
            params.push({ name, value });
          }
        }
      });
    });

    // 另一种格式: 列表项
    const listItems = document.querySelectorAll('[class*="prop-list"] li, [class*="param-list"] li');
    listItems.forEach(li => {
      const text = li.textContent.trim();
      const match = text.match(/^([^：:]+)[：:](.+)$/);
      if (match) {
        params.push({ name: match[1].trim(), value: match[2].trim() });
      }
    });

    return params;
  },

  // ========== 全部评论翻页采集 ==========

  // 查找并点击"全部评价" / "累计评价" 标签
  _clickReviewTab() {
    return new Promise(function(resolve) {
      // 尝试的点击目标(按优先级)
      var tabSelectors = [
        // 京东（旧版）
        '#detail-tab-commission a',
        '[data-tab="item"] a',
        '.tab-main a',
        // 京东新版 CSS Module
        '[class*="commentTab--"]',
        '[class*="CommentTab--"]',
        '[class*="tabItem--"]:contains("评价")',
        'a:contains("商品评价")',
        'a:contains("累计评价")',
        // 京东新版评价标题（div#comment-title / .comment-title，文本"买家评价(5000+)"）
        '#comment-title',
        '.comment-title',
        '[class*="comment-title"]',
        // 天猫新版 CSS Module：tabTitleItem-- 含"用户评价"文本
        '[class*="tabTitleItem--"]',
        '[class*="tabTitle--"]',
        // 淘宝: 累计评价 tab
        '#J_TabMore a[href*="review"]',
        '#J_TabMore li:last-child a',
        '#J_TabMore .tb-tab:last-child',
        '#J_TabMore [data-spm-anchor-id*="review"]',
        // 天猫: 评价/累计评价 tab
        '.tm-detail-reviews .tb-reviews-tab',
        '.rate-detail-tab a:last-child',
        '.tab-item:last-child',
        '[class*="reviews--"] [class*="tab--"][class*="active"]',
        // 通用: 包含"评价"字样的 tab
        'a:contains("评价")',
        'button:contains("评价")',
        'li:contains("评价") > a',
        'div[class*="tab"]:contains("评价")',
        // 淘宝新版 CSS Module
        '[class*="TabPanel--"] [class*="tab--"][class*="active"]',
        '[class*="Tab--"] button:contains("评价")'
      ];

      function tryClick(index) {
        if (index >= tabSelectors.length) {
          this.log('collectReviews', '未找到评价tab，使用当前已加载评论');
          return resolve(false);
        }

        // 对于 :contains 选择器，手动查找（原生 querySelectorAll 不支持 :contains）
        var selector = tabSelectors[index];
        var el = null;
        if (selector.indexOf(':contains(') >= 0) {
          // 用 split 解析，避免正则把 :contains 误当作 base 选择器
          var cIdx = selector.indexOf(':contains(');
          var base = selector.substring(0, cIdx) || '*';  // :contains 前的部分作为 base
          var textMatch = selector.substring(cIdx).match(/:contains\(['"]?(.+?)['"]?\)/);
          var text = textMatch ? textMatch[1] : '';
          if (text) {
            try {
              var candidates = document.querySelectorAll(base);
              for (var i = 0; i < candidates.length; i++) {
                var ct = (candidates[i].textContent || '').trim();
                // 文本长度限制，避免匹配到包含"评价"的大容器
                if (ct.length < 50 && ct.indexOf(text) >= 0) {
                  el = candidates[i];
                  break;
                }
              }
            } catch(e) {
              this.log('collectReviews', ':contains选择器查询异常', { base: base, text: text, error: e.message });
            }
          }
        } else {
          // 对所有匹配项优先选择文本含"评价"/"评论"的（避免误点其他 tab）
          try {
            var matches = document.querySelectorAll(selector);
            if (matches.length > 0) {
              // 优先找文本含"评价"或"评论"的
              for (var mi = 0; mi < matches.length; mi++) {
                var t = (matches[mi].textContent || '').trim();
                if (t.length < 30 && (t.indexOf('评价') >= 0 || t.indexOf('评论') >= 0)) {
                  el = matches[mi];
                  break;
                }
              }
              // 兜底：取第一个
              if (!el) el = matches[0];
            }
          } catch(e) {}
        }

        if (el) {
          el.click();
          this.log('collectReviews', '已点击评价tab', { selector: selector, text: (el.textContent || '').trim().slice(0, 30) });
          resolve(true);
        } else {
          tryClick.bind(this)(index + 1);
        }
      }

      tryClick.bind(this)(0);
    }.bind(this));
  },

  // 点击"查看全部评价"按钮（天猫新版 CSS Module 详情页）
  // 详情页评价区默认只显示2条精选评论，点击此按钮才弹出全部评论 modal
  _clickShowAllReviewsButton() {
    return new Promise(function(resolve) {
      var btnSelectors = [
        '[class*="ShowButton--"]',
        '[class*="showAll--"]',
        '[class*="allReviews--"]',
        '[class*="viewAll--"]',
        // 天猫新版：footer 容器（含"查看全部评价"文本）
        '[class*="footer--"]',
        '[class*="Footer--"]'
      ];
      var texts = ['查看全部评价', '全部评价', '查看更多评价', '展开全部评价'];

      function trySelector(idx) {
        if (idx >= btnSelectors.length) {
          // 兜底：找文本匹配（不要求可见，因为按钮可能在视口外）
          var all = document.querySelectorAll('a, button, div, span');
          for (var i = 0; i < all.length; i++) {
            var t = (all[i].textContent || '').trim();
            if (t.length < 20 && texts.indexOf(t) >= 0) {
              // 用 scrollIntoView 让按钮回到视口（解决按钮在视口外点击无效的问题）
              try { all[i].scrollIntoView({block: 'center', behavior: 'instant'}); } catch(e){}
              // 等待布局更新
              setTimeout(function(){
                try { all[i].click(); } catch(e){}
                // 模拟真实鼠标事件（部分框架只响应真实事件）
                try {
                  var rect = all[i].getBoundingClientRect();
                  var x = rect.x + rect.width/2;
                  var y = rect.y + rect.height/2;
                  ['mousedown', 'mouseup', 'click'].forEach(function(evt){
                    all[i].dispatchEvent(new MouseEvent(evt, {bubbles: true, clientX: x, clientY: y}));
                  });
                } catch(e){}
              }, 100);
              this.log('collectReviews', '已点击查看全部评价按钮(文本匹配)', { text: t });
              return resolve(true);
            }
          }
          this.log('collectReviews', '未找到"查看全部评价"按钮，可能已在全部评论视图');
          return resolve(false);
        }
        try {
          var els = document.querySelectorAll(btnSelectors[idx]);
          for (var i = 0; i < els.length; i++) {
            var t = (els[i].textContent || '').trim();
            if (t.length < 20 && texts.indexOf(t) >= 0) {
              // 用 scrollIntoView 让按钮回到视口（不要求 offsetParent 可见）
              try { els[i].scrollIntoView({block: 'center', behavior: 'instant'}); } catch(e){}
              setTimeout(function(){
                try { els[i].click(); } catch(e){}
                try {
                  var rect = els[i].getBoundingClientRect();
                  var x = rect.x + rect.width/2;
                  var y = rect.y + rect.height/2;
                  ['mousedown', 'mouseup', 'click'].forEach(function(evt){
                    els[i].dispatchEvent(new MouseEvent(evt, {bubbles: true, clientX: x, clientY: y}));
                  });
                } catch(e){}
              }, 100);
              this.log('collectReviews', '已点击查看全部评价按钮', { selector: btnSelectors[idx], text: t });
              return resolve(true);
            }
          }
        } catch(e) {}
        trySelector.bind(this)(idx + 1);
      }
      trySelector.bind(this)(0);
    }.bind(this));
  },

  // 等待评论面板加载（含天猫新版 modal）
  _waitReviewPanelLoaded() {
    return new Promise(function(resolve) {
      var maxWait = 8000; // 最多等8秒（modal 加载较慢）
      var startTime = Date.now();
      var checkInterval = 200;

      function check() {
        if (Date.now() - startTime > maxWait) {
          resolve(false);
          return;
        }
        // 检查评论容器是否存在且有内容
        var reviewContainers = [
          // 京东
          '#detail-tab-commission',
          '[class*="J-comment-"]',
          '#comment-0',
          // 天猫新版 modal 容器
          '.descV8-quality-modal',
          '[class*="CommentModal--"]',
          '[class*="RateModal--"]',
          // 传统容器
          '#J_Reviews',
          '.tm-rate-full',
          '.rate-full',
          '[class*="reviews--"] [class*="list--"]',
          '[class*="ReviewList--"]',
          '[class*="CommentsPanel--"]',
          // 新版 CSS Module 评论容器（含多条评论）
          '[class*="Comments--"] [class*="comments--"]'
        ];
        for (var i = 0; i < reviewContainers.length; i++) {
          try {
            var c = document.querySelector(reviewContainers[i]);
            if (c && c.children.length > 0) {
              resolve(true);
              return;
            }
          } catch(e) {}
        }
        setTimeout(check, checkInterval);
      }
      check();
    });
  },

  // 滚动评论容器加载更多评论（天猫新版采用无限滚动，非翻页）
  // 返回 true 表示滚动后可能有新评论加载，false 表示已到底
  _scrollForMoreReviews() {
    return new Promise(function(resolve) {
      // 查找可滚动的评论容器
      var scrollables = [];
      var containerSelectors = [
        // 天猫新版 Drawer 内的评论列表（Drawer 可能 visible:false 但仍可滚动）
        '[class*="Drawer--"] [class*="comments--"]',
        '[class*="drawer--"] [class*="comments--"]',
        '.descV8-quality-modal [class*="comments--"]',
        '[class*="CommentModal--"] [class*="comments--"]',
        '[class*="Comments--"] [class*="comments--"]',
        '.beautify-scroll-bar',
        // 通用滚动容器
        '[class*="comments--"]',
        '#J_Reviews',
        '.tm-rate-full'
      ];
      for (var i = 0; i < containerSelectors.length; i++) {
        try {
          var els = document.querySelectorAll(containerSelectors[i]);
          els.forEach(function(el) {
            // 不要求 offsetParent 可见（Drawer 可能 visible:false）
            // 只要 scrollHeight > clientHeight 就可滚动
            if (el.scrollHeight > el.clientHeight) {
              scrollables.push(el);
            }
          });
        } catch(e) {}
      }

      if (scrollables.length === 0) {
        this.log('collectReviews', '未找到可滚动评论容器');
        return resolve(false);
      }

      // 选择 scrollHeight 最大的容器
      var target = scrollables[0];
      for (var j = 1; j < scrollables.length; j++) {
        if (scrollables[j].scrollHeight > target.scrollHeight) {
          target = scrollables[j];
        }
      }

      var beforeTop = target.scrollTop;
      var beforeHeight = target.scrollHeight;
      var beforeCount = target.querySelectorAll('[class*="Comment--"]').length;

      // 滚动到底部
      target.scrollTop = target.scrollHeight;
      // 同时滚动 body（保险）
      window.scrollBy(0, 300);

      // 等待新内容加载
      setTimeout(function() {
        var afterTop = target.scrollTop;
        var afterHeight = target.scrollHeight;
        var afterCount = target.querySelectorAll('[class*="Comment--"]').length;
        var hasNew = afterCount > beforeCount || afterHeight > beforeHeight;
        this.log('collectReviews', '滚动结果', {
          beforeCount: beforeCount,
          afterCount: afterCount,
          beforeHeight: beforeHeight,
          afterHeight: afterHeight,
          hasNew: hasNew
        });
        resolve(hasNew);
      }.bind(this), 1500);
    }.bind(this));
  },

  // 从当前页 DOM 提取评论（翻页/滚动用）
  _extractReviewsFromCurrentPage() {
    var reviews = [];
    // 提取当前可见评论（按优先级，命中即用）
    var reviewSelectors = [
      // 京东
      '#comment-0 .comment-item',
      '[class*="comment-item"]',
      '[class*="J-comment-item"]',
      // 天猫新版 modal 内评论
      '[class*="comments--"] [class*="Comment--"]',
      'div[class*="Comment--"]',
      // 传统容器
      '#J_Reviews .rate-item',
      '.tm-rate-list .rate-item',
      '.rate-item',
      '[class*="RateList"] [class*="item"]',
      '[class*="Review--"] [class*="Item--"]',
      '.review-item',
      '.comment-item'
    ];
    var items = [];
    for (var si = 0; si < reviewSelectors.length; si++) {
      try {
        var found = document.querySelectorAll(reviewSelectors[si]);
        if (found.length > 0) { items = found; break; }
      } catch(e) {}
    }

    var self = this;
    items.forEach(function(item) {
      try {
        var content = '';
        var contentSel = [
          // 京东
          '.comment-con',
          '.comment-content',
          '[class*="comment-content"]',
          '[class*="commentContent"]',
          '[class*="CommentContent--"]',
          // 天猫新版
          '[class*="content--"]',
          '[class*="CommentContent--"]',
          '[class*="rate-content"]',
          '[class*="tm-rate-content"]',
          '[class*="contentWrapper--"]',
          '[class*="review-content"]',
          '.rate-content'
        ];
        for (var i = 0; i < contentSel.length; i++) {
          try {
            var el = item.querySelector(contentSel[i]);
            if (el) {
              // 优先使用 title 属性（完整内容，避免被 CSS 截断）
              var title = el.getAttribute('title');
              if (title && title.trim().length > 5) {
                content = title.trim();
                break;
              }
              var txt = el.textContent.trim();
              if (txt.length > 5) {
                content = txt;
                break;
              }
            }
          } catch(e) {}
        }

        // 提取评分
        var rating = 0;
        var ratingSel = [
          '[data-rate]', '[data-score]', '[aria-label*="星"]', '[title*="星"]',
          '[class*="rate-star"]', '[class*="Star--"]', '[class*="starWrapper"]', '[class*="rating"]'
        ];
        var ratingEl = null;
        for (var ri = 0; ri < ratingSel.length; ri++) {
          try {
            ratingEl = item.querySelector(ratingSel[ri]);
            if (ratingEl) break;
          } catch(e) {}
        }
        if (ratingEl) {
          var ratingText = [
            ratingEl.getAttribute('data-rate'), ratingEl.getAttribute('data-score'),
            ratingEl.getAttribute('aria-label'), ratingEl.getAttribute('title'),
            ratingEl.className, ratingEl.textContent
          ].filter(Boolean).join(' ');
          rating = self.normalizeReviewRating(ratingText);
          // 只统计明确标记为已填充/激活的星，不能把5个空心图标当5星
          if (!rating) {
            var filled = ratingEl.querySelectorAll('[class*="filled"], [class*="active"], [class*="full"], [aria-checked="true"]');
            if (filled.length >= 1 && filled.length <= 5) rating = filled.length;
          }
        }
        // 部分平台只显示“好评/中评/差评”标签
        if (!rating) rating = self.normalizeReviewRating(item.textContent || '');
        // 仍无法确认时保持0（未知），不伪造五星

        // 提取用户名
        var username = '';
        var userSel = [
          '[class*="userName--"] span',  // 天猫新版（span 避免取到 img）
          '[class*="userName--"]',
          '[class*="user-info"]',
          '[class*="username"]',
          '[class*="userName"]',
          '[class*="member"]',
          '.rate-user'
        ];
        for (var ui = 0; ui < userSel.length; ui++) {
          try {
            var uel = item.querySelector(userSel[ui]);
            if (uel && uel.textContent.trim()) {
              username = uel.textContent.trim();
              break;
            }
          } catch(e) {}
        }

        // 天猫新版：时间+SKU 都在 meta-- 元素中（格式: "2026-07-06已购：银色 / 512GB / 官方标配"）
        var metaText = '';
        try {
          var metaEl = item.querySelector('[class*="meta--"]');
          if (metaEl) metaText = metaEl.textContent.trim();
        } catch(e) {}

        // 提取时间（优先从 meta 解析）
        var time = '';
        if (metaText) {
          // 匹配 "2026-07-06" 或 "2026年7月6日" 等格式
          var dateM1 = metaText.match(/(\d{4}[-./]\d{1,2}[-./]\d{1,2})/);
          var dateM2 = metaText.match(/(\d{4}年\d{1,2}月\d{1,2}日)/);
          if (dateM1) time = dateM1[1];
          else if (dateM2) time = dateM2[1];
        }
        if (!time) {
          var timeSel = [
            '[class*="time"]',
            '[class*="date"]',
            '.rate-date'
          ];
          for (var ti = 0; ti < timeSel.length; ti++) {
            try {
              var tel = item.querySelector(timeSel[ti]);
              if (tel && tel.textContent.trim()) {
                time = tel.textContent.trim();
                break;
              }
            } catch(e) {}
          }
        }

        // 提取 SKU 信息（优先从 meta 解析）
        var skuInfo = '';
        if (metaText) {
          var skuM = metaText.match(/已购[：:]\s*(.+)/);
          if (skuM) skuInfo = skuM[1].trim();
        }
        if (!skuInfo) {
          var skuSel = [
            // 京东
            '.comment-con .sku-info',
            '[class*="comment-sku"]',
            '[class*="skuInfo"]',
            '[class*="SkuInfo--"]',
            // 淘宝/天猫
            '[class*="sku"]',
            '[class*="spec"]',
            '[class*="property"]',
            '.rate-sku'
          ];
          for (var si2 = 0; si2 < skuSel.length; si2++) {
            try {
              var sel = item.querySelector(skuSel[si2]);
              if (sel && sel.textContent.trim()) {
                skuInfo = sel.textContent.trim();
                break;
              }
            } catch(e) {}
          }
        }

        // 提取评论图片URL（天猫新版图片在 [class*="photo--"] img，京东在 .comment-item img）
        var reviewImages = [];
        try {
          var imgEls = item.querySelectorAll('img');
          for (var ii = 0; ii < imgEls.length; ii++) {
            var src = imgEls[ii].src || imgEls[ii].getAttribute('src') || '';
            // 必须是评论图片域名，且排除头像/评分图标等小图
            if ((src.indexOf('alicdn') >= 0 || src.indexOf('taobaocdn') >= 0 || src.indexOf('rate.jpg') >= 0 || src.indexOf('360buyimg.com') >= 0 || src.indexOf('pddpic') >= 0 || src.indexOf('pinduoduo') >= 0 || src.indexOf('yangkeduo') >= 0 || src.indexOf('alibaba') >= 0) &&
                src.indexOf('avatar') < 0 && src.indexOf('logo') < 0) {
              // 过滤掉 16x16 以下的小图标（评分星星等）
              var w = imgEls[ii].naturalWidth || imgEls[ii].width || 0;
              var h = imgEls[ii].naturalHeight || imgEls[ii].height || 0;
              if (w > 0 && w < 30) continue;
              if (h > 0 && h < 30) continue;
              // 去重
              if (reviewImages.indexOf(src) < 0) reviewImages.push(src);
            }
          }
        } catch(e) {}

        // reviewId：使用用户名+时间+内容前20字作为兜底（新版无 data-rate-id）
        var reviewId = item.getAttribute('data-rate-id') || item.id || '';
        if (!reviewId) {
          reviewId = (username || '') + '|' + (time || '') + '|' + content.slice(0, 20);
        }

        if (content && content.length > 5) {
          reviews.push({
            reviewId: reviewId,
            content: content,
            rating: rating,
            username: username,
            skuInfo: skuInfo,
            time: time,
            hasImage: reviewImages.length > 0,
            images: reviewImages,
            isAppend: false,
            appendContent: ''
          });
        }
      } catch(e) {}
    });

    return reviews;
  },

  // 获取翻页控制元素
  _getPaginationControls() {
    var paginationSelectors = [
      // 京东
      '#comment-0 .pagination',
      '.comment-pagination',
      // 淘宝/天猫
      '#J_Reviews .page-wrap',
      '.tm-rate-full .page-wrap',
      '.rate-page',
      '.tm-rate-page',
      '[class*="Pagination--"]',
      '[class*="pagination--"]',
      '.pagination',
      '.page-nav',
      // 通用分页
      'div[class*="page"] a',
      'ul[class*="page"]',
      // 翻页按钮
      '[class*="next"] a',
      '[class*="pagination"] button'
    ];

    for (var i = 0; i < paginationSelectors.length; i++) {
      try {
        var el = document.querySelector(paginationSelectors[i]);
        if (el) return el;
      } catch(e) {}
    }
    return null;
  },

  // 点击下一页
  _clickNextPage() {
    return new Promise(function(resolve) {
      // 下一页选择器（按优先级）
      var nextSelectors = [
        // 京东
        '#comment-0 .page-next:not(.disabled)',
        '.comment-pagination .next:not(.disabled)',
        'a[class*="next"]:not([class*="disable"])',
        // 淘宝/天猫
        'a.page-next:not(.disabled)',
        'a.next:not(.disabled)',
        'span.next:not(.disabled) a',
        'li.next:not(.disabled) a',
        'button.next:not([disabled])',
        'a[class*="next"]:not([class*="disable"])',
        '[class*="nextPage"]:not([class*="disable"])',
        'a[rel="next"]',
        'a:contains("下一页")',
        'button:contains("下一页")',
        'a:contains(">")',
        'a:contains("»")',
        'li:not(.disabled) > a:contains("下一页")'
      ];

      for (var i = 0; i < nextSelectors.length; i++) {
        try {
          var selector = nextSelectors[i];
          var el = null;
          if (selector.indexOf(':contains(') >= 0) {
            // 用 split 解析 :contains 伪选择器（原生不支持）
            var cIdx = selector.indexOf(':contains(');
            var base = selector.substring(0, cIdx) || '*';
            // 处理 "li:not(.disabled) > a:contains(...)" 这种带前缀的
            if (base.indexOf(':not(') >= 0) {
              // 提取 :not() 完整部分，base可能形如 "li:not(.disabled) > a"
              // querySelectorAll 支持 :not()，直接使用 base
            }
            var textMatch = selector.substring(cIdx).match(/:contains\(['"]?(.+?)['"]?\)/);
            var text = textMatch ? textMatch[1] : '';
            if (text) {
              var candidates = document.querySelectorAll(base);
              for (var ci = 0; ci < candidates.length; ci++) {
                var ct = (candidates[ci].textContent || '').trim();
                if (ct.length < 30 && ct.indexOf(text) >= 0) {
                  el = candidates[ci];
                  break;
                }
              }
            }
          } else {
            el = document.querySelector(selector);
          }
          if (el && el.offsetParent !== null) { // 可见
            el.click();
            resolve(true);
            return;
          }
        } catch(e) {}
      }
      resolve(false);
    });
  },

  // 发送进度事件（panel.js 监听此事件更新状态显示）
  _dispatchProgress(page, totalReviews, newCount) {
    try {
      var event = new CustomEvent('rev:progress', {
        detail: {
          page: page || 0,
          totalReviews: totalReviews || 0,
          newCount: newCount || 0,
          timestamp: Date.now()
        }
      });
      window.dispatchEvent(event);
    } catch(e) {}
  },

  // 采集全部评论（自适应：滚动加载 / 翻页）
  async collectAllReviews(initialReviews, opts) {
    opts = opts || {};
    this._stopped = false; // 重置停止标志，允许新采集
    var reviewPageLimit = opts.reviewPageLimit || 0; // 0=不限
    var reviewLimit = opts.reviewLimit || 0; // 0=不限（条数上限，采够即停）
    var reviewSpeed = opts.reviewSpeed || 'normal'; // 采集速度：slow/normal/fast（此前未定义导致弹窗/API采集崩溃）
    this.log('collectReviews', '开始采集全部评论（自适应滚动/翻页）', { reviewPageLimit: reviewPageLimit, reviewLimit: reviewLimit });

    // 用Set去重
    var seenIds = {};
    var allReviews = [];

    // 合并初始评论
    (initialReviews || []).forEach(function(r) {
      var key = r.reviewId || (r.content || '').slice(0, 30);
      if (!seenIds[key]) {
        seenIds[key] = true;
        allReviews.push(r);
      }
    });

    // 京东新版：DOM滚动+API拦截方案（直接fetch API会被403拒绝）
    // 滚动到评价区，让京东页面自己加载评论，通过拦截器捕获新评论API响应
    if (location.href.indexOf('jd.com') > -1 && this.itemId) {
      // 双通道：弹窗滚动采集 + API翻页补全，取合并去重后的最大值（避免弹窗只采一屏就停）
      try {
        this.log('collectReviews', '京东：弹窗滚动采集');
        var jdScrollReviews = await this.collectJdReviewsByScrolling(allReviews, { reviewPageLimit: reviewPageLimit, reviewSpeed: reviewSpeed, reviewLimit: reviewLimit });
        if (jdScrollReviews && jdScrollReviews.length > allReviews.length) {
          allReviews = jdScrollReviews;
          this.log('collectReviews', '京东弹窗采集', { total: allReviews.length });
        }
      } catch (e) {
        this.log('collectReviews', '京东弹窗采集失败', { error: e.message });
      }
      // API 翻页补全（合并去重；若直连被403也会吞掉，不影响已有数据）
      try {
        this.log('collectReviews', '京东：API翻页补全');
        var jdApiReviews = await this.fetchJdAllReviewsDirectly(this.itemId, allReviews, { reviewPageLimit: reviewPageLimit, reviewSpeed: reviewSpeed, reviewLimit: reviewLimit });
        if (jdApiReviews && jdApiReviews.length > allReviews.length) {
          allReviews = jdApiReviews;
          this.log('collectReviews', '京东API翻页补全', { total: allReviews.length });
        }
      } catch (e) {
        this.log('collectReviews', '京东API翻页失败(跳过，不影响已有数据)', { error: e.message });
      }
      if (allReviews.length > 0) return allReviews;
    }

    // 1. 点击评价tab
    var tabClicked = await this._clickReviewTab();
    if (!tabClicked) {
      this.log('collectReviews', '无法找到评价tab，返回初始评论');
      return allReviews;
    }

    // 2. 等待评价预览面板加载
    await this._waitReviewPanelLoaded();
    await new Promise(function(r) { setTimeout(r, 800); });

    // 3. 尝试点击"查看全部评价"按钮（天猫新版需要展开 modal）
    var showBtnClicked = await this._clickShowAllReviewsButton();
    if (showBtnClicked) {
      this.log('collectReviews', '已展开全部评论 modal，等待加载...');
      // 等待 modal 内评论加载
      await new Promise(function(r) { setTimeout(r, 2500); });
      await this._waitReviewPanelLoaded();
      await new Promise(function(r) { setTimeout(r, 500); });
    }

    // 4. 提取初始评论（modal 内）
    var initReviews = this._extractReviewsFromCurrentPage();
    var initNewCount = 0;
    initReviews.forEach(function(r) {
      var key = r.reviewId || r.content.slice(0, 30);
      if (!seenIds[key]) {
        seenIds[key] = true;
        allReviews.push(r);
        initNewCount++;
      }
    });
    this.log('collectReviews', '初始评论提取', { count: initReviews.length, newCount: initNewCount, total: allReviews.length });
    this._dispatchProgress(1, allReviews.length, initNewCount);

    // 5. 主循环：先尝试滚动加载，无果则尝试翻页
    var maxIterations = 200; // 最多滚动/翻页 200 次
    // 免费版页数限制（reviewPageLimit > 0 时取较小值）
    if (reviewPageLimit > 0 && reviewPageLimit < maxIterations) {
      maxIterations = reviewPageLimit;
      this.log('collectReviews', '已应用评论页数限制', { maxIterations: maxIterations });
    }
    var iterCount = 0;
    var emptyCount = 0;
    var maxEmpty = 5; // 连续 5 次无新内容则停止
    var startTime = Date.now();
    var maxDuration = 120000; // 总耗时上限 2 分钟，避免无限循环

    while (iterCount < maxIterations && !this._stopped) {
      // 总超时保护
      if (Date.now() - startTime > maxDuration) {
        this.log('collectReviews', '评论翻页总超时，提前结束', { iterCount: iterCount, duration: Math.round((Date.now() - startTime) / 1000) + 's' });
        break;
      }
      iterCount++;
      var iterNewCount = 0;

      // 5.1 先尝试滚动加载（天猫新版）
      var scrolled = await this._scrollForMoreReviews();
      if (scrolled) {
        // 等待新评论加载
        await new Promise(function(r) { setTimeout(r, 1200); });
        var scrolledReviews = this._extractReviewsFromCurrentPage();
        scrolledReviews.forEach(function(r) {
          var key = r.reviewId || r.content.slice(0, 30);
          if (!seenIds[key]) {
            seenIds[key] = true;
            allReviews.push(r);
            iterNewCount++;
          }
        });
      }

      // 5.2 滚动无果则尝试翻页（传统分页）
      if (!scrolled || iterNewCount === 0) {
        var hasNext = await this._clickNextPage();
        if (hasNext) {
          await new Promise(function(r) { setTimeout(r, 1500); });
          var pagedReviews = this._extractReviewsFromCurrentPage();
          pagedReviews.forEach(function(r) {
            var key = r.reviewId || r.content.slice(0, 30);
            if (!seenIds[key]) {
              seenIds[key] = true;
              allReviews.push(r);
              iterNewCount++;
            }
          });
        }
      }

      // 采够数量上限则提前停止（避免全采完再截断）
      if (reviewLimit > 0 && allReviews.length >= reviewLimit) {
        this.log('collectReviews', '已达评论数量上限，提前停止翻页', { total: allReviews.length, limit: reviewLimit });
        break;
      }

      this.log('collectReviews', '迭代 ' + iterCount + ' 新增 ' + iterNewCount + ' 条', { total: allReviews.length, scrolled: scrolled });
      this._dispatchProgress(iterCount + 1, allReviews.length, iterNewCount);

      if (iterNewCount === 0) {
        emptyCount++;
        if (emptyCount >= maxEmpty) {
          this.log('collectReviews', '连续 ' + emptyCount + ' 次无新内容，停止采集');
          break;
        }
      } else {
        emptyCount = 0;
      }

      // 安全上限：单商品最多 2000 条评论
      if (allReviews.length >= 2000) {
        this.log('collectReviews', '达到评论数量上限 2000，停止采集');
        break;
      }
    }

    this.log('collectReviews', '全部评论采集完成', {
      totalIterations: iterCount,
      totalReviews: allReviews.length,
      initialCount: (initialReviews || []).length
    });

    return allReviews;
  },

  // 规范化价格
  normalizePrice(priceText) {
    if (!priceText) return '';
    // 修复：先去除货币符/千分位逗号/空白，避免 ¥1,299.00 被截成 "1"
    var cleaned = String(priceText).replace(/[¥￥,，\s]/g, '');
    var match = cleaned.match(/\d+(?:\.\d+)?/);
    return match ? match[0] : '';
  },

  // 生成扁平化数据（用于导出）
  exportFlatData(detailData) {
    if (!detailData.success) return null;

    const { data } = detailData;
    
    // 数据清洗和验证
    const cleanTitle = (data.basic.title || '').trim();
    const cleanPrice = (data.basic.price || '').trim();
    const cleanShopName = (data.basic.shopName || '').trim();
    
    // 验证必要字段
    if (!cleanTitle || cleanTitle.length < 2) {
      console.warn('[详情采集] 商品标题无效:', data.basic.title);
    }

    const result = {
      '商品ID': data.itemId || '',
      '商品标题': cleanTitle,
      '商品价格': cleanPrice,
      '店铺名称': cleanShopName,
      '销量': (data.basic.salesText || '').trim(),
      '评分': (data.basic.rating || '').trim(),
      '详情页URL': data.url || '',
      '采集时间': data.timestamp || '',
      '商品参数': data.parameters.filter(p => p.name && p.value).map(p => `${p.name}:${p.value}`).join('; '),
      'SKU列表': data.skus.filter(s => s.name).map(s => `${s.name}/${s.price}/库存${s.stock}`).join('; '),
      '评论数量': data.reviews.length,
      '好评率': this.calculateGoodRate(data.reviews)
    };

    // 添加图片URL（过滤空值）
    data.images.filter(img => img && img.trim()).forEach((img, i) => {
      result['图片' + (i + 1)] = img.trim();
    });

    return result;
  },

  // 计算好评率
  calculateGoodRate(reviews) {
    if (!reviews || reviews.length === 0) return '';
    const goodCount = reviews.filter(r => r.rating >= 4).length;
    return `${Math.round((goodCount / reviews.length) * 100)}%`;
  },

  // 生成SKU详情表（用于Excel多Sheet）
  generateSkuSheetData(detailData) {
    if (!detailData.success) return [];
    return detailData.data.skus
      .filter(sku => sku.name && sku.name.trim())
      .map(sku => ({
        'SKU_ID': sku.skuId || '',
        'SKU名称': sku.name.trim(),
        'SKU价格': sku.price || '',
        '库存': sku.stock || '',
        '是否有货': sku.available ? '是' : '否'
      }));
  },

  // 生成评论详情表（用于Excel多Sheet）
  generateReviewSheetData(detailData) {
    if (!detailData.success) return [];
    return detailData.data.reviews
      .filter(review => review.content && review.content.trim())
      .map(review => ({
        '评论ID': review.reviewId || '',
        '用户名': review.username || '',
        '评分': review.rating || 0,
        '评论内容': review.content.trim(),
        'SKU信息': review.skuInfo || '',
        '评论时间': review.time || '',
        '是否有图': review.hasImage ? '是' : '否',
        '是否追评': review.isAppend ? '是' : '否',
        '追评内容': review.appendContent || ''
      }));
  }
};

// 导出给全局使用（同时暴露两个别名，兼容 panel.js 的 __detailCollector 引用）
window.DetailCollector = DetailCollector;
window.__detailCollector = DetailCollector;

// 自动注入拦截器（页面加载时立即生效，不等待 extractDetailData 调用）
// 确保能捕获页面加载过程中的所有 API 请求
// 注意：injectInterceptor 是 async（通过 background worker 注入以绕过 CSP）
// 这里不 await，让注入异步进行；CustomEvent 监听器同步注册，不会丢失拦截数据
// 不提前设置 interceptorInjected=true，允许 init/extractDetailData 在注入失败时重试
(function autoInject() {
  try {
    var url = window.location.href;
    // 所有电商平台详情页都自动注入（与 isDetailPage 判断保持一致）
    if (DetailCollector.isDetailPage()) {
      console.log('[电商采集大师] auto-inject: 检测到详情页，开始注入拦截器', url);
      DetailCollector.injectInterceptor().then(function() {
        DetailCollector.interceptorInjected = true; // 注入完成后才标记
        DetailCollector.log('auto-inject', '拦截器已在页面加载时自动注入', { url: url });
      }).catch(function(e) {
        DetailCollector.log('auto-inject', '拦截器自动注入失败', { error: e && e.message });
      });
    } else {
      console.log('[电商采集大师] auto-inject: 非详情页，跳过注入', url);
    }
  } catch (e) {
    console.error('[电商采集大师] 自动注入拦截器失败:', e);
  }
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DetailCollector;
}