// 电商采集大师 - 通用电商平台配置模块
// 支持淘宝/天猫/京东/拼多多/1688的首页、搜索页、详情页
// 通过平台专用选择器实现精准识别，避免通用扫描误选容器

var PlatformConfigs = {
  // ========== 平台 + 页面类型检测 ==========
  detect: function() {
    var url = window.location.href;
    var host = window.location.hostname;

    // 登录页/中间页：不应被识别为任何平台的功能页
    if (/login\.taobao\.com|login\.tmall\.com|login\.jd\.com|passport\.jd\.com|passport\.pinduoduo\.com/.test(host)) {
      return { platform: 'generic', pageType: 'login', name: '登录页' };
    }

    // 淘宝
    if (/taobao\.com/.test(host)) {
      if (/item\.taobao\.com/.test(host)) return { platform: 'taobao', pageType: 'detail', name: '电商详情页' };
      if (/s\.taobao\.com|search\.taobao\.com/.test(host)) return { platform: 'taobao', pageType: 'search', name: '电商搜索页' };
      return { platform: 'taobao', pageType: 'home', name: '电商首页' };
    }
    // 天猫
    if (/tmall\.com/.test(host)) {
      if (/detail\.tmall\.com|item\.tmall\.com/.test(host)) return { platform: 'tmall', pageType: 'detail', name: '电商详情页' };
      if (/list\.tmall\.com|search\.tmall\.com|s\.tmall\.com/.test(host)) return { platform: 'tmall', pageType: 'search', name: '电商搜索页' };
      return { platform: 'tmall', pageType: 'home', name: '电商首页' };
    }
    // 京东
    if (/jd\.com/.test(host)) {
      if (/item\.jd\.com/.test(host)) return { platform: 'jd', pageType: 'detail', name: '电商详情页' };
      if (/search\.jd\.com/.test(host)) return { platform: 'jd', pageType: 'search', name: '电商搜索页' };
      return { platform: 'jd', pageType: 'home', name: '电商首页' };
    }
    // 拼多多
    if (/yangkeduo\.com|pinduoduo\.com/.test(host)) {
      if (/goods\.html/.test(url)) return { platform: 'pdd', pageType: 'detail', name: '电商详情页' };
      if (/search_result\.html|search\.html/.test(url)) return { platform: 'pdd', pageType: 'search', name: '电商搜索页' };
      return { platform: 'pdd', pageType: 'home', name: '电商首页' };
    }
    // 亚马逊（v1.2.347：此前本文件完全没有 amazon，导致面板只能显示「通用模式」）
    if (/(^|\.)amazon\.[a-z.]{2,}$/i.test(host) || /(^|\.)amzn\.com$/i.test(host)) {
      if (/\/(?:dp|product|gp\/product|gp\/aw\/d)\/[A-Z0-9]{10}/i.test(url)) return { platform: 'amazon', pageType: 'detail', name: '电商详情页' };
      if (/\/s\?|\/s\/|field-keywords/i.test(url)) return { platform: 'amazon', pageType: 'search', name: '电商搜索页' };
      return { platform: 'amazon', pageType: 'home', name: '电商首页' };
    }
    // 1688
    if (/1688\.com/.test(host)) {
      if (/detail\.1688\.com|detail\.m\.1688\.com/.test(host) || /\/offer\//.test(url)) return { platform: '1688', pageType: 'detail', name: '电商详情页' };
      if (/s\.1688\.com|search\.1688\.com/.test(host)) return { platform: '1688', pageType: 'search', name: '电商搜索页' };
      return { platform: '1688', pageType: 'home', name: '电商首页' };
    }

    return { platform: 'generic', pageType: 'unknown', name: '通用页面' };
  },

  // ========== 各平台配置 ==========
  // 每个配置包含: cardSelectors(卡片选择器), fields(字段选择器映射), pagination(分页类型)
  configs: {
    // --- 淘宝 ---
    'taobao:home': {
      cardSelectors: ['.tb-pick-content-item', '[class*="tb-pick-content-item"]'],
      containerHint: '.tb-pick-feeds-container',
      fields: {
        '标题': '[class*="info-wrapper-title-text"]',
        '价格': '.price-value',
        '销量': '[class*="month-sale"]',
        '图片': 'img',
        '链接': 'a[href*="item.taobao.com"]'
      },
      pagination: 'waterfall'
    },
    'taobao:search': {
      cardSelectors: [
        '[class*="Card--doubleCard"]',
        '[class*="doubleCard"]',
        'div[class*="Card--"]'
      ],
      fields: {
        '标题': '[class*="title--"] span, [class*="Title--"] span, [class*="title"] span',
        '价格': '[class*="priceInt"], [class*="price--"] i, [class*="price"] i',
        '销量': '[class*="realSales"], [class*="sold"], [class*="sale"]',
        '商家': '[class*="shopNameText"], [class*="shopName"], [class*="shop"]',
        '图片': 'img',
        '链接': 'a'
      },
      pagination: 'nextpage'
    },

    // --- 天猫 (与淘宝类似) ---
    'tmall:home': {
      cardSelectors: ['.tb-pick-content-item', '[class*="tb-pick-content-item"]', '[class*="Card--"]'],
      fields: {
        '标题': '[class*="title--"] span, [class*="info-wrapper-title-text"]',
        '价格': '.price-value, [class*="priceInt"]',
        '销量': '[class*="month-sale"], [class*="realSales"]',
        '图片': 'img',
        '链接': 'a'
      },
      pagination: 'waterfall'
    },
    'tmall:search': {
      cardSelectors: [
        '[class*="Card--doubleCard"]',
        '[class*="doubleCard"]',
        'div[class*="Card--"]',
        '[class*="product-iWrap"]'
      ],
      fields: {
        '标题': '[class*="title--"] span, [class*="Title--"] span, .product-title',
        '价格': '[class*="priceInt"], [class*="price--"] i, em[class*="price"]',
        '销量': '[class*="realSales"], [class*="sold"], [class*="sale"]',
        '商家': '[class*="shopNameText"], [class*="shopName"], .shopName',
        '图片': 'img',
        '链接': 'a'
      },
      pagination: 'nextpage'
    },

    // --- 京东 ---
    'jd:home': {
      cardSelectors: ['.gl-item', 'li[data-sku]', '[class*="gl-item"]', '[class*="J_goods"]', '[class*="goodsCardWrapper"]', '[class*="_wrapper_"][data-sku]'],
      fields: {
        '标题': '.p-name em, [class*="p-name"] em, [class*="_wrapper_"][title], [title]',
        '价格': '.p-price i, [class*="p-price"] i, [class*="J_price"] i, [class*="_price"] i, [class*="price"] i',
        '商家': '.p-shop a, [class*="p-shop"] a, [class*="_shop"] a, [class*="shopName"]',
        '图片': '.p-img img, img',
        '链接': '.p-name a, a'
      },
      pagination: 'nextpage'
    },
    'jd:search': {
      cardSelectors: ['.gl-item', 'li[data-sku]', '[class*="gl-item"]', 'li.gl-item', '[class*="goodsCardWrapper"]', '[class*="_wrapper_"][data-sku]', '[data-sku]'],
      fields: {
        '标题': '[class*="_wrapper_"][title][title!=""], [title]:not([title=""])',
        '价格': '[class*="_yen_"] + span, [class*="_price"] i, .p-price i, [class*="J_price"] i',
        '销量': '[title*="已售"], [title*="人加购"], [class*="_commit"] strong, .p-commit strong',
        '商家': '[class*="_limit_"], .p-shop a, [class*="p-shop"] a, [class*="shopName"]',
        '图片': '[class*="_img_"] img, img[class*="_img_"], .p-img img, img',
        '链接': 'a[href*="item.jd.com"], a[href*="jd.com"]'
      },
      pagination: 'nextpage'
    },

    // --- 拼多多 (PC首页 + H5搜索) ---
    'pdd:home': {
      // PC首页卡片是 .goods，H5是纯hash class
      cardSelectors: ['.goods', '[class*="goods"]', '[class*="goods-item"]', '[class*="product-item"]', '[class*="GoodsCard"]'],
      fields: {
        '标题': '.title, [class*="title"]',
        '价格': '.group-price, .market-price, [class*="price"]',
        '图片': 'img.img, img[class*="img"], img',
        '链接': 'a'
      },
      pagination: 'waterfall'
    },
    'pdd:search': {
      // H5搜索页用纯hash class，通过价格元素反向定位
      cardSelectors: ['.goods', '[class*="goods"]', '[class*="goods-item"]', '[class*="product-item"]'],
      priceHint: '_3f_Cp5GQ',
      titleHint: '_3ANzdjkc',
      fields: {
        '标题': '.title, [class*="_3ANzdjkc"], [class*="title"]',
        '价格': '.group-price, [class*="_3f_Cp5GQ"] + span, [class*="price"]',
        '销量': '[class*="_32q8gNKM"], [class*="sold"], [class*="sale"]',
        '图片': 'img.img, img[class*="img"], img',
        '链接': 'a'
      },
      pagination: 'waterfall'
    },

    // --- 1688 (B2B批发) ---
    '1688:home': {
      cardSelectors: ['[class*="offer-item"]', '.search-offer-wrapper', '[class*="card"]'],
      fields: {
        '标题': '.title-text div, .title-text, [class*="title"]',
        '价格': '.text-main, [class*="price"] [class*="text"]',
        '图片': '.main-img, img',
        '链接': 'a'
      },
      pagination: 'nextpage'
    },
    '1688:search': {
      cardSelectors: ['[class*="offer-item"]', '.search-offer-wrapper', '.search-offer-item', '[class*="card"]'],
      fields: {
        '标题': '.title-text div, .title-text, [class*="title"]',
        '价格': '.text-main, [class*="price"] [class*="text"]',
        '图片': '.main-img, img',
        '链接': 'a'
      },
      pagination: 'nextpage'
    },

  },

  // ========== 获取当前页面配置 ==========
  getConfig: function() {
    var info = this.detect();
    var key = info.platform + ':' + info.pageType;
    var config = this.configs[key] || null;
    return { info: info, config: config, key: key };
  },

  // ========== 查找商品卡片容器（平台专用，优先于通用扫描）==========
  findCardContainer: function() {
    var result = this.getConfig();
    if (!result.config) return null;

    var cardSels = result.config.cardSelectors;
    var bestContainer = null;
    var bestCount = 0;
    var bestSelector = null;

    for (var i = 0; i < cardSels.length; i++) {
      try {
        var _all = document.querySelectorAll(cardSels[i]);
        if (_all.length < 1) continue;
        // 修复：优先用“含价格/图片”的真实商品卡片，宽泛选择器不再把非商品元素当卡片；识别不足则回退全量（不阻塞）
        var _real = [];
        for (var _r = 0; _r < _all.length; _r++) { try { if (this._isLikelyProductCard(_all[_r])) _real.push(_all[_r]); } catch(e){} }
        var cards = (_real.length >= 3) ? _real : _all;
        // 找到包含最多卡片的祖先容器
        var ancestor = cards[0].parentElement;
        var depth = 0;
        while (ancestor && ancestor !== document.body && depth < 8) {
          var cnt = ancestor.querySelectorAll(cardSels[i]).length;
          var rect = ancestor.getBoundingClientRect ? ancestor.getBoundingClientRect() : null;
          if (cnt >= 3 && rect && rect.height > 0) {
            // 优先使用 containerHint 指定的容器
            if (cnt > bestCount) {
              bestCount = cnt;
              bestContainer = ancestor;
            }
            // 当达到全部卡片数时停止上溯
            if (cnt >= cards.length) break;
          }
          ancestor = ancestor.parentElement;
          depth++;
        }
      } catch(e) {}
    }

    // 若有 containerHint，直接尝试
    if (!bestContainer && result.config.containerHint) {
      try {
        var hintEl = document.querySelector(result.config.containerHint);
        if (hintEl && hintEl.querySelectorAll(cardSels[0]).length >= 3) {
          bestContainer = hintEl;
          bestCount = hintEl.querySelectorAll(cardSels[0]).length;
        }
      } catch(e) {}
    }

    // 拼多多等纯hash class平台：通过 priceHint/titleHint 反向定位卡片
    // 找到价格元素 → 向上找卡片容器 → 按class统计同类卡片
    if (!bestContainer && result.config.priceHint) {
      try {
        var priceEls = document.querySelectorAll('[class*="' + result.config.priceHint + '"]');
        if (priceEls.length >= 3) {
          // 对每个价格元素向上找卡片（向上4-6层，找含标题的容器）
          var cardClasses = {};
          for (var pi = 0; pi < priceEls.length; pi++) {
            var p = priceEls[pi];
            for (var up = 0; up < 6; up++) {
              if (!p.parentElement || p.parentElement === document.body) break;
              p = p.parentElement;
              // 卡片应包含标题元素
              if (result.config.titleHint && p.querySelector('[class*="' + result.config.titleHint + '"]')) {
                var pc = (p.className || '').toString().split(' ')[0];
                if (pc) {
                  cardClasses[pc] = (cardClasses[pc] || 0) + 1;
                }
                break;
              }
            }
          }
          // 选数量最多的卡片class
          var bestCardClass = null;
          var bestCardCount = 0;
          for (var cc in cardClasses) {
            if (cardClasses[cc] > bestCardCount) {
              bestCardCount = cardClasses[cc];
              bestCardClass = cc;
            }
          }
          if (bestCardClass && bestCardCount >= 3) {
            // 找到第一个该class的元素作为容器（其父级为列表容器）
            var firstCard = document.querySelector('.' + (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(bestCardClass) : bestCardClass.replace(/[^a-zA-Z0-9_-]/g, '\\$&')) );
            if (firstCard && firstCard.parentElement) {
              bestContainer = firstCard.parentElement;
              bestCount = bestCardCount;
            }
          }
        }
      } catch(e) {}
    }

    if (bestContainer) {
      bestSelector = this._generateUniqueSelector(bestContainer);
    }
    return { element: bestContainer, selector: bestSelector, count: bestCount, config: result.config, info: result.info };
  },

  // 生成唯一选择器
  _generateUniqueSelector: function(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var tag = el.tagName.toLowerCase();
    var classes = Array.from(el.classList).filter(function(c) {
      return c.length < 30 && c.indexOf(':') === -1 && c.indexOf('ai-scraper') === -1;
    }).slice(0, 2);
    var baseSel = classes.length > 0
      ? tag + '.' + classes.map(function(c) { return CSS.escape(c); }).join('.')
      : tag;

    // 唯一性检查
    try {
      var matches = document.querySelectorAll(baseSel);
      if (matches.length > 1) {
        var parent = el.parentElement;
        if (parent && parent !== document.body) {
          var pTag = parent.tagName.toLowerCase();
          var pClasses = Array.from(parent.classList).filter(function(c) {
            return c.length < 30 && c.indexOf(':') === -1 && c.indexOf('ai-scraper') === -1;
          }).slice(0, 1);
          var pSel = parent.id ? '#' + CSS.escape(parent.id)
            : (pClasses.length ? pTag + '.' + pClasses.map(function(c) { return CSS.escape(c); }).join('.') : pTag);
          var childIdx = 1;
          for (var ci = 0; ci < parent.children.length; ci++) {
            if (parent.children[ci] === el) break;
            childIdx++;
          }
          return pSel + ' > ' + baseSel + ':nth-child(' + childIdx + ')';
        }
      }
    } catch(e) {}
    return baseSel;
  },

  // ========== 使用平台配置提取字段 ==========
  extractFieldsWithConfig: function(container) {
    var result = this.getConfig();
    if (!result.config || !result.config.fields) return null;

    var fields = [];
    var fieldConfig = result.config.fields;
    var cardSels = result.config.cardSelectors;

    // 找到一张样本卡片
    var sampleCard = null;
    for (var i = 0; i < cardSels.length; i++) {
      sampleCard = container.querySelector(cardSels[i]);
      if (sampleCard) break;
    }
    if (!sampleCard) return null;

    var fieldNames = Object.keys(fieldConfig);
    var usedElements = new Set(); // 防止同一元素被多个字段复用
    for (var fi = 0; fi < fieldNames.length; fi++) {
      var name = fieldNames[fi];
      var sel = fieldConfig[name];
      // 选择器可能是逗号分隔的多个（fallback）
      var selParts = sel.split(/\s*,\s*/);
      var foundEl = null;
      for (var sp = 0; sp < selParts.length; sp++) {
        try {
          foundEl = sampleCard.querySelector(selParts[sp]);
          if (foundEl && !usedElements.has(foundEl)) break;
          // 若该元素已被其他字段使用，尝试下一个选择器
          if (foundEl && usedElements.has(foundEl)) { foundEl = null; continue; }
        } catch(e) {}
      }
      if (foundEl) {
        usedElements.add(foundEl);
        var sample = '';
        if (name === '图片') {
          var img = foundEl.tagName === 'IMG' ? foundEl : foundEl.querySelector('img');
          sample = img ? (img.src || img.getAttribute('data-src') || '').substring(0, 60) : '';
        } else if (name === '链接') {
          var link = foundEl.tagName === 'A' ? foundEl : foundEl.querySelector('a');
          sample = link ? link.href.substring(0, 60) : '';
        } else if (name === '标题') {
          // 标题优先用 title 属性（更完整）
          sample = (foundEl.getAttribute('title') || foundEl.textContent.trim()).substring(0, 40);
        } else {
          sample = foundEl.textContent.trim().substring(0, 40);
        }
        var fieldSel = this._getFieldSelector(foundEl, sampleCard);
        fields.push({ name: name, selector: fieldSel, sample: sample });
      }
    }
    return fields;
  },

  // 为字段元素生成选择器（相对于卡片）
  _getFieldSelector: function(el, card) {
    var tag = el.tagName.toLowerCase();
    var classList = Array.from(el.classList);
    var parts = [];
    for (var ci = 0; ci < classList.length; ci++) {
      var cls = classList[ci];
      var dashIdx = cls.indexOf('--');
      if (dashIdx > 0 && cls.length - dashIdx > 4) {
        // CSS Module 类名 (如 priceInt--hash)，用 [class*="base"] 匹配
        parts.push('[class*="' + cls.substring(0, dashIdx) + '"]');
      } else {
        // 处理 _name_hash_ 形式的 CSS Module (如 _wrapper_zj7ke_3)
        var m = cls.match(/^(_[a-zA-Z]+)_([a-z0-9]+)_/);
        if (m) {
          parts.push('[class*="' + m[1] + '_"]');
        } else if (cls.length > 0 && cls.length < 30 && cls.indexOf(':') === -1 && cls.indexOf('ai-scraper') === -1) {
          parts.push('.' + cls);
        }
      }
    }
    // 优先用 class 选择器，但需确保在卡片内唯一
    if (parts.length > 0) {
      var sel = tag + parts[0];
      try {
        if (card.querySelectorAll(sel).length === 1) return sel;
        // 多个匹配，加上第二个 class
        if (parts.length > 1) {
          var sel2 = tag + parts[0] + parts[1];
          if (card.querySelectorAll(sel2).length === 1) return sel2;
        }
      } catch(e) {}
      return sel;
    }
    // 无 class 的元素，使用属性选择器
    if (el.getAttribute('title')) return tag + '[title]';
    if (el.getAttribute('data-src')) return tag + '[data-src]';
    // 无 class 无属性：用父级 class 生成 .parent > tag 选择器
    var parent = el.parentElement;
    if (parent && parent !== card) {
      var pClasses = Array.from(parent.classList).filter(function(c) {
        return c.length > 0 && c.length < 30 && c.indexOf(':') === -1;
      });
      if (pClasses.length > 0) {
        var pSel = '.' + pClasses[0] + ' > ' + tag;
        try {
          if (card.querySelectorAll(pSel).length === 1) return pSel;
        } catch(e) {}
        // 加 nth-child 进一步限定
        var childIdx = 1;
        for (var ci = 0; ci < parent.children.length; ci++) {
          if (parent.children[ci] === el) break;
          childIdx++;
        }
        return '.' + pClasses[0] + ' > ' + tag + ':nth-child(' + childIdx + ')';
      }
    }
    return tag;
  }
};

// 暴露到全局
window.__PlatformConfigs = PlatformConfigs;
