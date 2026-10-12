// 电商采集大师 - 请求策略模块
// 提供随机延迟、请求限流、访问受限页面检测功能
// 作用：控制采集节奏，避免对目标站点造成过大负载（礼貌抓取策略）
(function(global) {
  'use strict';

  // ============ 配置 ============
  var CONFIG = {
    // 请求限流：每分钟最大请求数（按平台）
    rateLimit: {
      'jd.com': { maxPerMin: 10, windowMs: 60000 },        // 京东：10次/分钟（防反爬）
      'taobao.com': { maxPerMin: 8, windowMs: 60000 },     // 淘宝：8次/分钟（最严）
      'tmall.com': { maxPerMin: 8, windowMs: 60000 },      // 天猫：8次/分钟
      'pinduoduo.com': { maxPerMin: 8, windowMs: 60000 },  // 拼多多：8次/分钟
      '1688.com': { maxPerMin: 8, windowMs: 60000 },       // 1688：8次/分钟
      'default': { maxPerMin: 12, windowMs: 60000 }
    },
    // 随机延迟范围（毫秒）——默认 5-8 秒随机，模拟真人节奏，防反爬
    delays: {
      pageTurn: [8000, 15000],        // 翻页延迟：8-15秒（慢速人化，防反爬）
      detailLoad: [8000, 15000],      // 详情页加载等待：8-15秒
      reviewScroll: [12000, 20000],   // 评论滚动间隔：12-20秒（更慢，防爬）
      batchItem: [8000, 15000],       // 批量采集间隔：8-15秒
      scrollToLoad: [8000, 15000]     // 瀑布流滚动间隔：8-15秒
    },
    // 访问受限页面关键词（验证码/风控提示等）
    // 强风控关键词：单次命中即判定（多为明确验证码/安全验证）
    RequestPolicyPatterns: [
      '请输入验证码', '安全验证', '人工验证', '滑动验证',
      '人机验证', 'security verification', '请完成下方验证'
    ],
    // 弱风控关键词：需≥2处命中才判定，避免正常页面页脚/提示误暂停（修复原过宽误判）
    RequestPolicyWeakPatterns: [
      '验证码', '为了您的安全', '系统繁忙', '请稍后再试',
      '您的访问出现异常', '访问太频繁', '登录验证', '账号验证'
    ],
    // 访问受限URL模式
    RequestPolicyUrlPatterns: [
      /risk\.jd\.com/i, /sec\.taobao\.com/i, /sec\.tmall\.com/i,
      /passport\.jd\.com\/new\/login/i, /login\.taobao\.com/i,
      /login\.tmall\.com/i, /captcha/i, /verify/i
    ]
  };

  // ============ 请求计数器（按平台）============
  var requestCounters = {};

  function getPlatform(url) {
    if (!url) return 'default';
    url = String(url);
    if (url.indexOf('jd.com') > -1 || url.indexOf('3.cn') > -1) return 'jd.com';
    if (url.indexOf('taobao.com') > -1) return 'taobao.com';
    if (url.indexOf('tmall.com') > -1) return 'tmall.com';
    if (url.indexOf('pinduoduo.com') > -1 || url.indexOf('yangkeduo.com') > -1) return 'pinduoduo.com';
    if (url.indexOf('1688.com') > -1 || url.indexOf('alibaba.com') > -1) return '1688.com';
    return 'default';
  }

  function getPlatformConfig(platform) {
    return CONFIG.rateLimit[platform] || CONFIG.rateLimit.default;
  }

  // 记录一次请求，返回是否超过限流
  function recordRequest(url) {
    var platform = getPlatform(url);
    var now = Date.now();
    var cfg = getPlatformConfig(platform);

    if (!requestCounters[platform]) {
      requestCounters[platform] = [];
    }
    // 清理过期记录
    requestCounters[platform] = requestCounters[platform].filter(function(t) {
      return now - t < cfg.windowMs;
    });
    // 添加当前请求
    requestCounters[platform].push(now);

    return requestCounters[platform].length > cfg.maxPerMin;
  }

  // 获取需要等待的时间（如果超过限流）
  function getWaitTime(url) {
    var platform = getPlatform(url);
    var cfg = getPlatformConfig(platform);
    var now = Date.now();
    var counter = requestCounters[platform] || [];

    if (counter.length < cfg.maxPerMin) return 0;

    // 计算最早请求的过期时间
    var oldest = Math.min.apply(null, counter);
    var waitMs = cfg.windowMs - (now - oldest) + 100; // +100ms 缓冲
    return Math.max(0, waitMs);
  }

  // ============ 随机延迟 ============
  // 速度档位：所有延迟 × 倍率
  //   fast=0.4（快速：翻页 3-6 秒 / 批量 3-6 秒）
  //   normal=1.0（标准：翻页 8-15 秒，默认）
  //   slow=2.5（慢速：更保守，防最严风控）
  var SPEED_MULTIPLIERS = { fast: 0.4, normal: 1.0, slow: 2.5 };
  var speedMode = 'normal';
  // P2-B 风控自适应：记录最近风控命中，连续命中则延长等待（降采速、减风控概率）
  var restrictionLog = [];
  function recordRestriction() {
    restrictionLog.push(Date.now());
    if (restrictionLog.length > 20) restrictionLog.shift();
  }
  function adaptiveMultiplier() {
    var now = Date.now();
    var recent = restrictionLog.filter(function(t) { return now - t < 10 * 60 * 1000; }).length;
    if (recent >= 4) return 3.0;
    if (recent >= 2) return 1.8;
    return 1.0;
  }

  function randomDelay(type) {
    var range = CONFIG.delays[type] || CONFIG.delays.pageTurn;
    var min = range[0], max = range[1];
    var m = SPEED_MULTIPLIERS[speedMode] || 1.0;
    min = Math.round(min * m);
    max = Math.round(max * m);
    return Math.floor(min + Math.random() * (max - min));
  }

  // 执行随机延迟（Promise）
  function wait(type) {
    // P2-B：按最近风控命中次数放大等待时长
    var ms = Math.round(randomDelay(type) * adaptiveMultiplier());
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }

  // 执行限流+随机延迟：先检查限流，再随机延迟
  async function throttle(url, delayType) {
    var platform = getPlatform(url);
    // 如果超过限流，等待
    var waitMs = getWaitTime(url);
    if (waitMs > 0) {
      console.log('[RequestPolicy] 限速等待', platform, waitMs + 'ms');
      await new Promise(function(r) { setTimeout(r, waitMs); });
    }
    // 记录请求
    recordRequest(url);
    // 随机延迟
    if (delayType) {
      await wait(delayType);
    }
  }

  // ============ 访问受限页面检测 ============
  function detectRestriction() {
    var url = window.location.href;
    var host = window.location.hostname;
    var bodyText = '';
    try { bodyText = (document.body && document.body.innerText) || ''; } catch(e) {}
    var title = document.title || '';

    // 1. URL 模式检测
    for (var i = 0; i < CONFIG.RequestPolicyUrlPatterns.length; i++) {
      if (CONFIG.RequestPolicyUrlPatterns[i].test(url)) {
        return {
          detected: true,
          type: 'url_redirect',
          pattern: String(CONFIG.RequestPolicyUrlPatterns[i]),
          url: url
        };
      }
    }

    // 2. 页面文本检测（强关键词单次命中即判定；弱关键词需≥2处，避免正常页面误暂停）
    var strongHit = '';
    for (var j = 0; j < CONFIG.RequestPolicyPatterns.length; j++) {
      var pattern = CONFIG.RequestPolicyPatterns[j];
      if (bodyText.indexOf(pattern) > -1 || title.indexOf(pattern) > -1) { strongHit = pattern; break; }
    }
    if (strongHit) {
      return { detected: true, type: 'text_pattern', pattern: strongHit, url: url };
    }
    var weakCount = 0, weakHit = '';
    var weakPatterns = CONFIG.RequestPolicyWeakPatterns || [];
    for (var k = 0; k < weakPatterns.length; k++) {
      var wp = weakPatterns[k];
      if (bodyText.indexOf(wp) > -1 || title.indexOf(wp) > -1) { weakCount++; weakHit = wp; }
    }
    if (weakCount >= 2) {
      return { detected: true, type: 'text_pattern_weak', pattern: weakHit, url: url };
    }

    // 3. 特定平台检测
    if (host.indexOf('jd.com') > -1) {
      // 京东风控页面特征
      if (url.indexOf('risk') > -1 || /(?:^|[\\/?&])403(?:[\\/?#&]|$)/.test(url)) {
        return { detected: true, type: 'jd_risk', url: url };
      }
      // 京东"系统繁忙"提示
      if (bodyText.indexOf('系统繁忙') > -1 && bodyText.length < 500) {
        return { detected: true, type: 'jd_busy', url: url };
      }
    }

    if (host.indexOf('taobao.com') > -1 || host.indexOf('tmall.com') > -1) {
      // 淘宝/天猫风控
      if (url.indexOf('login') > -1 && url.indexOf('redirect') > -1) {
        return { detected: true, type: 'taobao_login_redirect', url: url };
      }
      if (bodyText.indexOf('验证码') > -1 || (bodyText.indexOf('滑动') > -1 && (bodyText.indexOf('验证') > -1 || bodyText.indexOf('安全') > -1))) {
        return { detected: true, type: 'taobao_captcha', url: url };
      }
    }

    return { detected: false };
  }

  // ============ 模拟人类行为 ============
  // v1.1.166：合成鼠标/滚动事件 isTrusted=false、无真实轨迹，被风控识别为自动化特征的风险更高——
  // 降级为纯随机停留（保留点击前人化节奏），事件合成移除。
  async function simulateHumanBehavior(targetEl) {
    try {
      var base = targetEl ? 200 : 120;
      await new Promise(function (r) { setTimeout(r, base + Math.floor(Math.random() * 900)); });
    } catch(e) {}
  }

  // ============ 风控暂停机制 ============
  // 采集循环检测到验证码/风控页面时调用 setPaused(true)，
  // 面板显示提示，用户完成验证后调用 setPaused(false) 恢复采集
  var paused = false;
  var pausedResolvers = [];

  function setPaused(v) {
    paused = !!v;
    if (paused) recordRestriction(); // P2-B：暂停即视为一次风控命中
    if (!paused) {
      var resolvers = pausedResolvers;
      pausedResolvers = [];
      resolvers.forEach(function(r) { r(); });
    }
  }

  function isPaused() {
    return paused;
  }

  function waitUntilResumed() {
    if (!paused) return Promise.resolve();
    return new Promise(function(resolve) {
      pausedResolvers.push(resolve);
    });
  }

  // ============ 导出 API ============
  global.RequestPolicy = {
    CONFIG: CONFIG,
    wait: wait,
    throttle: throttle,
    randomDelay: randomDelay,
    detectRestriction: detectRestriction,
    detectAntiCrawl: detectRestriction, // 兼容旧 AntiCrawl 调用
    simulateHumanBehavior: simulateHumanBehavior,
    recordRequest: recordRequest,
    getWaitTime: getWaitTime,
    getPlatform: getPlatform,
    // 速度档位（fast/normal/slow）；兼容旧 setSlowMode（true→slow, false→normal）
    setSpeedMode: function(m) { if (SPEED_MULTIPLIERS[m]) speedMode = m; },
    getSpeedMode: function() { return speedMode; },
    getSpeedMultiplier: function() { return SPEED_MULTIPLIERS[speedMode] || 1.0; },
    setSlowMode: function(v) { speedMode = v ? 'slow' : 'normal'; },
    isSlowMode: function() { return speedMode === 'slow'; },
    getSlowMultiplier: function() { return SPEED_MULTIPLIERS.slow; },
    // 风控暂停
    setPaused: setPaused,
    isPaused: isPaused,
    waitUntilResumed: waitUntilResumed
  };

  console.log('[RequestPolicy] 请求策略模块已加载');
  // 兼容旧全局名 AntiCrawl（早期版本使用，改名后历史引用仍指向此对象）
  global.AntiCrawl = global.RequestPolicy;
})(typeof window !== 'undefined' ? window : this);


