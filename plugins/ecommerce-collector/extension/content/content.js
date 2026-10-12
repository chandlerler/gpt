// Shadow DOM 桥接
function __AIS_DOC() {
  return (typeof window !== 'undefined' && window.__AIS_SHADOW__) ? window.__AIS_SHADOW__ : document;
}
// 电商采集大师 - Content Script
// 运行在用户访问的页面上，负责数据提取和翻页控制

// ===== 热重载检测 =====
// content.js 被执行时：若已是二次加载（之前注入过）且有旧 shadow 面板，则强制重建（扩展更新后无需刷新页面）
(function() {
  try {
    var version = (chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '';
    var prev = window.__AIS_CONTENT_LOADED__ || null;
    if (prev) {
      console.log('[电商采集大师] 检测到扩展热重载, 版本 ' + prev + ' -> ' + version + ', 重建面板(不刷新页面)');
    }
    // 修复：先记录“本次是否二次注入”，避免下面读取到刚写入的新版本号导致恒为真
    window.__AIS_RELOADING__ = !!prev;
    // v1.1.44b：热重载时强制重新初始化绑定（aisInit 的一次性保护会保留旧函数引用，
    // 导致热注入后按钮仍调用旧版 showHistoryPanel 等函数——合并历史等新逻辑不生效）
    if (prev) window.__AIS_INIT_FORCE__ = true;
    window.__AIS_CONTENT_LOADED__ = version;
  } catch(e) {}
})();

// 可中断等待：每 200ms 检查采集是否已停止，停止则立即返回，让"停止"立刻生效
function checkableWait(ms) {
  return new Promise(function(resolve) {
    var start = Date.now();
    var timer = setInterval(function() {
      var sc = (typeof window !== 'undefined') ? window.__aiScraper : null;
      if (Date.now() - start >= ms || (sc && sc.isRunning === false)) { clearInterval(timer); resolve(); }
    }, 200);
  });
}


var safeSendMessage = function(msg) { try { if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) chrome.runtime.sendMessage(msg).catch(function(){}); } catch(e) {} };
var safeSetStorage = function(data, callback) { try { if (typeof chrome !== "undefined" && chrome.storage) { chrome.storage.local.set(data, callback || function(){}); } else if (callback) { callback(); } } catch(e) { if (callback) callback(); } };
var PageScraper = class {
  constructor() {
    this.extractedData = [];
    this.currentPage = 1;
    this.isRunning = false;
    this.fields = [];
    this.observer = null;
  }

  scanDataContainers() {
    var candidates = [];
    var seen = {};

    // === 优先：平台专用配置识别（精准、可靠）===
    if (window.__PlatformConfigs) {
      var pcResult = window.__PlatformConfigs.findCardContainer();
      if (pcResult && pcResult.element) {
        var pcSel = pcResult.selector;
        if (!seen[pcSel]) {
          seen[pcSel] = true;
          candidates.push({ selector: pcSel, count: pcResult.count, element: pcResult.element, platform: true });
          console.log('[电商采集大师] 平台配置识别容器:', pcSel, '卡片数:', pcResult.count, (pcResult.info||{}).name);
          // 修复：平台已识别到容器时直接采用，避免通用宽泛选择器误抓视频卡/导航等非商品容器
          return candidates;
        }
      }
    }

    var selectors = [
      'table', 'ul.list', 'ol.list',
      '[class*="list"]', '[class*="grid"]',
      '[class*="item"]', '[class*="row"]',
      '[class*="product"]', '[class*="card"]',
      'div[data-component-type]',
      'li[data-asin]', 'div[data-asin]',
      '[class*="search-result"]', '[class*="result"]',
      '[role="list"]', '[role="listbox"]',
      'tbody tr', 'div.listing',
      '#content_items_wrapper', '#J_goodsList',
      '#plist', '[id*="goodsList"]',
      '[class*="searchItems"]', '[class*="itemsWrapper"]',
      '.tbpc-content', '[class*="doubleCard"]',
      '[class*="tbpc-row"]', '[class*="tbpc-col"]',
      '[class*="waterfall"]', '[class*="goodsList"]',
    ];

    for (var si = 0; si < selectors.length; si++) {
      try {
        var els = document.querySelectorAll(selectors[si]);
        if (els.length < 3) continue;

        // 检查这些匹配元素是否共享同一个父容器
        var first = els[0];
        var parent = first.parentElement;
        if (parent && parent !== document.body) {
          var siblingCount = 0;
          var parentChildren = parent.children;
          for (var pc = 0; pc < parentChildren.length; pc++) {
            try { if (parentChildren[pc].matches(selectors[si])) siblingCount++; } catch(e) {}
          }
          // 可见性过滤：跳过 height=0 的不可见容器（如隐藏的导航列表）
          var parentRect = parent.getBoundingClientRect ? parent.getBoundingClientRect() : null;
          var parentVisible = parentRect && parentRect.height > 0 && parentRect.width > 0;
          if (siblingCount >= 3 && parentVisible) {
            var parentSel = this._generateSelector(parent);
            if (!seen[parentSel]) {
              seen[parentSel] = true;
              candidates.push({ selector: parentSel, count: siblingCount, element: parent });
            }
          }
          // 瀑布流支持：直接父级匹配不足时，向上查找祖先容器
          // (卡片常被包在列/col里，列再排在row里，直接父级只有1张卡片)
          if (siblingCount < 3 && parentVisible) {
            var ancestor = parent.parentElement;
            var depth = 0;
            while (ancestor && ancestor !== document.body && depth < 5) {
              var descCount = ancestor.querySelectorAll(selectors[si]).length;
              var ancRect = ancestor.getBoundingClientRect ? ancestor.getBoundingClientRect() : null;
              if (descCount >= 3 && ancRect && ancRect.height > 0) {
                var ancSel = this._generateSelector(ancestor);
                if (!seen[ancSel]) {
                  seen[ancSel] = true;
                  candidates.push({ selector: ancSel, count: descCount, element: ancestor });
                }
                break;
              }
              ancestor = ancestor.parentElement;
              depth++;
            }
          }
        }

        // 如果元素本身有很多子元素，它本身就是容器（如 table, ul）
        // 同样需要可见性过滤
        if (first.children.length >= 3 && first.tagName !== 'TR') {
          var selfRect = first.getBoundingClientRect ? first.getBoundingClientRect() : null;
          if (selfRect && selfRect.height > 0) {
            var selfSel = this._generateSelector(first);
            if (!seen[selfSel]) {
              seen[selfSel] = true;
              candidates.push({ selector: selfSel, count: first.children.length, element: first });
            }
          }
        }
      } catch (e) {}
    }


    // Special: check ID-based containers with many children
    var idSelectors = ['#content_items_wrapper', '#J_goodsList', '#plist', '#search-result-list', '#J_searchResultList', '#J-goods-list'];
    for (var isi = 0; isi < idSelectors.length; isi++) {
      try {
        var idEl = document.querySelector(idSelectors[isi]);
        if (idEl && idEl.children.length >= 3) {
          var sel = this._generateSelector(idEl);
          if (!seen[sel]) { seen[sel] = true; candidates.push({ selector: sel, count: idEl.children.length, element: idEl }); }
        }
      } catch(e) {}
    }

    // Special: 瀑布流/首页推荐 - 直接按已知商品卡片选择器查找包含最多卡片的祖先容器
    // 适用于"卡片被列包装器包裹"的瀑布流布局（如淘宝首页 .tb-pick-content-item）
    var cardSelectors = [
      '.tb-pick-content-item',
      '[class*="tb-pick-content-item"]',
      '[class*="Card--doubleCard"]',
      '[class*="doubleCard"]',
      '[class*="FeedItem"]',
      '[class*="feedItem"]'
    ];
    for (var csi = 0; csi < cardSelectors.length; csi++) {
      try {
        var cards = document.querySelectorAll(cardSelectors[csi]);
        if (cards.length < 3) continue;
        // 找到包含这些卡片的最小公共祖先（向上查找）
        var ancestor = cards[0].parentElement;
        var bestAncestor = null;
        var bestAncCount = 0;
        var depth = 0;
        while (ancestor && ancestor !== document.body && depth < 8) {
          var cnt = ancestor.querySelectorAll(cardSelectors[csi]).length;
          var aRect = ancestor.getBoundingClientRect ? ancestor.getBoundingClientRect() : null;
          if (cnt > bestAncCount && aRect && aRect.height > 0) {
            bestAncCount = cnt;
            bestAncestor = ancestor;
          }
          // 当祖先包含全部卡片时停止上溯
          if (cnt >= cards.length) break;
          ancestor = ancestor.parentElement;
          depth++;
        }
        if (bestAncestor) {
          var bSel = this._generateSelector(bestAncestor);
          if (!seen[bSel]) {
            seen[bSel] = true;
            candidates.push({ selector: bSel, count: bestAncCount, element: bestAncestor });
          }
        }
      } catch(e) {}
    }

candidates.sort(function(a, b) { return b.count - a.count; });
    return candidates;
  }

  // 生成 CSS 选择器（保证唯一性：当 base 选择器匹配多个元素时，添加父级路径 + nth-child）
  _generateSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var tag = el.tagName.toLowerCase();
    var classes = Array.from(el.classList).filter(function(c) { return c.length < 30 && c.indexOf(':') === -1 && c.indexOf('ai-scraper') === -1; }).slice(0, 2);
    var baseSel;
    if (classes.length > 0) baseSel = tag + '.' + classes.map(function(c) { return CSS.escape(c); }).join('.');
    else if (el.getAttribute('data-id') !== null) baseSel = tag + '[data-id]';
    else baseSel = tag;

    // 唯一性检查：若 base 选择器匹配多个元素，添加父级路径 + nth-child 以保证唯一
    try {
      var matches = document.querySelectorAll(baseSel);
      if (matches.length > 1) {
        var parent = el.parentElement;
        if (parent && parent !== document.body) {
          var parentTag = parent.tagName.toLowerCase();
          var parentClasses = Array.from(parent.classList).filter(function(c) { return c.length < 30 && c.indexOf(':') === -1 && c.indexOf('ai-scraper') === -1; }).slice(0, 1);
          var parentSel = parent.id ? '#' + CSS.escape(parent.id) : (parentClasses.length ? parentTag + '.' + parentClasses.map(function(c) { return CSS.escape(c); }).join('.') : parentTag);
          // 计算元素在父级直接子元素中的索引
          var childIdx = 1;
          for (var ci = 0; ci < parent.children.length; ci++) {
            if (parent.children[ci] === el) break;
            childIdx++;
          }
          return parentSel + ' > ' + baseSel + ':nth-child(' + childIdx + ')';
        }
      }
    } catch(e) {}
    return baseSel;
  }

  identifyFields(container) {
    var fieldMap = new Map();

    // === PATH 0 (最高优先): 平台专用字段配置 ===
    if (window.__PlatformConfigs) {
      var pcFields = window.__PlatformConfigs.extractFieldsWithConfig(container);
      if (pcFields && pcFields.length > 0) {
        for (var pfi = 0; pfi < pcFields.length; pfi++) {
          var pf = pcFields[pfi];
          if (!fieldMap.has(pf.name)) {
            fieldMap.set(pf.name, { name: pf.name, selector: pf.selector, sample: pf.sample });
          }
        }
        console.log('[电商采集大师] 平台配置识别字段:', pcFields.map(function(f){return f.name;}).join(', '));
        // 平台配置足够可靠，直接返回，避免通用逻辑覆盖
        var fields0 = [];
        fieldMap.forEach(function(v, k) { fields0.push(v); });
        return fields0;
      }
    }

    // === PATH 1 (PRIORITY): Analyze repeating item children for precise selectors ===
    var items = this._findRepeatingItems(container);
    if (items.length > 0) {
      var sampleItem = items[0];
      var allChildren = sampleItem.querySelectorAll('*');
      for (var ci = 0; ci < allChildren.length; ci++) {
        var child = allChildren[ci];
        var childText = child.textContent.trim();
        // 跳过无 class 的叶子节点：无法生成精确选择器（会退化为裸标签名如"span"），
        // 导致提取时 querySelector 匹配到错误元素（如标题span被当作商家）
        var childCls = child.className && child.className.toString ? child.className.toString().trim() : '';
        if (childText.length > 1 && childText.length < 100 && child.children.length === 0 && childCls.length > 0) {
          var name = this._suggestFieldName(child);
          if (name && name !== '' && !fieldMap.has(name)) {
            fieldMap.set(name, {
              name: name,
              selector: this._getSelector(child),
              sample: childText.substring(0, 30)
            });
          }
        }
      }
    }

    // === PATH 2 (FALLBACK): Text pattern matching for fields not yet found ===
    var textPatterns = {
      '价格': /(?:^[¥￥$]|价格|price|售价|priceInt)/i,
      '标题': /(?:title--|^title$|productname|itemname|goodstitle)/i,
      '销量': /(?:月销|已售|付款|sold|sales|成交|realSales)/i,
      '评价数': /(?:评价|评论|review|comment|rating)/i,
      '图片': /(?:img|图片|image|photo|mainImg|jpg|png)/i,
      '链接': /(?:^https?:\/\/)/i,
      '评分': /(?:star|评分|rating|score)/i,
      '库存': /(?:库存|stock|inventory|quantity)/i,
      '商家': /(?:shopName|shopNameText|shopname|shop-name|shopname|^店铺$|^品牌$)/i,
      '优惠券': /(?:券|coupon|优惠|折扣|discount)/i,
    };

    var textElements = container.querySelectorAll('span, p, a, div, h1, h2, h3, h4, h5, h6, td, th, li, strong, em, b');
    for (var ei = 0; ei < textElements.length; ei++) {
      var el = textElements[ei];
      var text = el.textContent.trim();
      var className = el.className && el.className.toString ? el.className.toString() : '';
      var combined = text + ' ' + className;

      var keys = Object.keys(textPatterns);
      for (var ki = 0; ki < keys.length; ki++) {
        var fieldName = keys[ki];
        if (!fieldMap.has(fieldName) && textPatterns[fieldName].test(combined)) {
          var targetEl = el;
          if (el.children.length > 0) {
            var leaves = el.querySelectorAll('*');
            // Find the best leaf: prefer direct text children with matching class
            var bestLeaf = null;
            var bestScore = -1;
            for (var li = 0; li < Math.min(leaves.length, 50); li++) {
              if (leaves[li].children.length === 0) {
                var leafText = leaves[li].textContent.trim();
                var leafCls = (leaves[li].className || '').toString().toLowerCase();
                if (leafText.length > 1 && leafText.length < 200) {
                  var score = 0;
                  // Prefer leaves whose text matches the pattern
                  if (textPatterns[fieldName] && textPatterns[fieldName].test(leafText)) score += 3;
                  // Prefer leaves whose class matches the field
                  var fieldClassMap = {'价格':'price|money|amount','标题':'title|productname','销量':'sale|sold','图片':'img|pic|mainimg','商家':'shop|store|brand','优惠券':'coupon'};
                  var expectedCls = fieldClassMap[fieldName];
                  if (expectedCls && new RegExp(expectedCls, 'i').test(leafCls)) score += 5;
                  // Prefer leaves whose parent class also matches
                  var pCls = '';
                  try { pCls = (leaves[li].parentElement && leaves[li].parentElement.className || '').toString().toLowerCase(); } catch(e) {}
                  if (expectedCls && new RegExp(expectedCls, 'i').test(pCls)) score += 2;
                  // Penalize very short text for non-numeric fields
                  if (leafText.length < 3 && fieldName !== '价格' && fieldName !== '销量') score -= 2;

                  if (score > bestScore) { bestScore = score; bestLeaf = leaves[li]; }
                }
              }
            }
            if (bestLeaf) targetEl = bestLeaf;
          }
          var selector = this._getSelector(targetEl);
          // Guard: skip container-level elements (tbpc columns, list wrappers)
          // Only set if field not already found by PATH 1's precise leaf analysis
          var containerClasses = ['tbpc-col', 'list', 'grid', 'waterfall'];
          var isContainer = false;
          for (var ci = 0; ci < containerClasses.length; ci++) {
            if (selector.indexOf(containerClasses[ci]) >= 0) { isContainer = true; break; }
          }
          if (!fieldMap.has(fieldName) && !isContainer) {
            fieldMap.set(fieldName, {
              name: fieldName,
              selector: selector,
              sample: targetEl.textContent.trim().substring(0, 30)
            });
          }
        }
      }
    }

    // === POST-PROCESS: 去重和校验 ===
    
    // 1. 防止多个字段指向同一个选择器
    var selectorFields = {};
    fieldMap.forEach(function(v, k) {
      if (!selectorFields[v.selector]) selectorFields[v.selector] = [];
      selectorFields[v.selector].push(k);
    });
    
    Object.keys(selectorFields).forEach(function(sel) {
      var fieldsAtSameSelector = selectorFields[sel];
      if (fieldsAtSameSelector.length > 1) {
        var priority = {'图片': 1, '价格': 2, '销量': 3, '优惠券': 4, '标题': 5, '商家': 6, '评价数': 7, '评分': 8};
        fieldsAtSameSelector.sort(function(a, b) {
          return (priority[a] || 99) - (priority[b] || 99);
        });
        fieldsAtSameSelector.slice(1).forEach(function(removeField) {
          fieldMap.delete(removeField);
        });
      }
    });

    // 2. 严格校验"商家"字段 - 确保它指向真正的店铺/商家名称，而非商品标题
    var merchantField = fieldMap.get('商家');
    if (merchantField && merchantField.sample) {
      var sample = merchantField.sample;
      var isValidMerchant = true;
      
      // 检查 1: 商家名通常较短 (< 20 字符)
      if (sample.length > 20) isValidMerchant = false;
      
      // 检查 2: 商家名不应包含商品描述词汇（注意: "旗舰店"是合法店铺名后缀，不能排除）
      if (/(?:新品|手机|数码|直播|官方正品|百亿|现货|直屏|屏幕|电池|芯片|处理器|摄像|影像|骁龙|麒麟|CPU|GPU|内存|存储|指纹|人脸|拍照|游戏|续航|大电量|超薄|抗摔|防水|全网通|双卡|鸿蒙)/.test(sample)) {
        isValidMerchant = false;
      }
      
      // 检查 3: 商家名通常不以【政府补贴】【新品上市】等商品促销开头
      if (/^【(?:政府补贴|新品上市|顺丰|现货|咨询|需当面|补贴)/.test(sample)) {
        isValidMerchant = false;
      }
      
      // 检查 4: 商家名不应包含太长的商品编号/型号字符串
      if (/\d{4,}/.test(sample) && sample.length > 15) isValidMerchant = false;
      
      // 如果判定为无效商家名，删除该字段
      if (!isValidMerchant) {
        console.log('[电商采集大师] 商家字段校验失败，删除。样本:', sample.substring(0, 40));
        fieldMap.delete('商家');
      }
    }

    // 3. 校验"标题"字段 - 确保它指向商品标题
    var titleField = fieldMap.get('标题');
    if (titleField && titleField.sample) {
      var titleSample = titleField.sample;
      var isValidTitle = true;
      
      // 标题应该有一定长度
      if (titleSample.length < 8) isValidTitle = false;
      
      // 标题应该包含商品描述性词汇（或至少看起来像商品标题）
      var hasTitleKeywords = /(?:手机|数码|新品|官方|补贴|电池|屏幕|芯片|影像|正品|现货|直播|官方正品|旗舰店|正品)/.test(titleSample);
      if (!hasTitleKeywords && titleSample.length < 15) {
        // 短文本且无商品关键词，可能不是标题
        isValidTitle = false;
      }
      
      if (!isValidTitle) {
        console.log('[电商采集大师] 标题字段校验失败，删除。样本:', titleSample.substring(0, 40));
        fieldMap.delete('标题');
      }
    }

    var fields = [];
    fieldMap.forEach(function(v, k) { fields.push(v); });
    return fields;
  }



  _findRepeatingItems(container, depth) {
    // 修复：限制递归深度，避免嵌套容器导致近似指数级查询
    depth = depth || 0;
    if (depth > 4) return [];
    // 策略 1: 先尝试用已知的电商平台选择器直接查找
    var knownSelectors = [
      // 淘宝/天猫 - 优先选择 div 卡片而非 a 包装器
      'div[class*="Card--"]',
      'div[class*="doubleCard"]',
      '[class*="doubleCard"]',
      '[class*="card--"]',
      // 淘宝首页推荐瀑布流
      '.tb-pick-content-item',
      '[class*="tb-pick-content-item"]',
      '[class*="FeedItem"]',
      '[class*="feedItem"]',
      '[class*="recommend-item"]',
      // 京东
      '[class*="gl-item"]',
      '[class*="goods-list-v2"]',
      // 拼多多
      '[class*="goods-item"]',
      '[class*="product-item"]',
      // 通用
      '[class*="item"][class*="product"]',
      '[class*="product-card"]',
      '[class*="good-item"]',
      // 包含价格元素的卡片
      '[class*="card"]'
    ];
    
    for (var ki = 0; ki < knownSelectors.length; ki++) {
      try {
        var items = container.querySelectorAll(knownSelectors[ki]);
        if (items.length >= 3 && items.length <= 300) {
          // 验证这些元素是否包含价格或标题信息
          var withPrice = 0;
          var withTitle = 0;
          var sampleSize = Math.min(items.length, 10);
          for (var si = 0; si < sampleSize; si++) {
            if (items[si].querySelector('[class*="price"], [class*="Price"], [class*="money"]')) withPrice++;
            if (items[si].querySelector('[class*="title"], [class*="Title"]')) withTitle++;
          }
          if (withPrice >= 2 || withTitle >= 2) {
            return Array.from(items);
          }
        }
      } catch(e) {}
    }
    
    // 策略 2: 按 CSS Module 基础类名分组 (去除 --hash 后缀)
    var children = Array.from(container.children);
    if (children.length < 2) return [];

    var groups = {};
    for (var ci = 0; ci < children.length; ci++) {
      var child = children[ci];
      var tag = child.tagName.toLowerCase();
      // 提取基础类名 (如 "doubleCard--hash" → "doublecard")
      var baseClasses = [];
      if (child.classList) {
        for (var cii = 0; cii < child.classList.length; cii++) {
          var cls = child.classList[cii];
          var dashIdx = cls.indexOf('--');
          var baseName = dashIdx > 0 ? cls.substring(0, dashIdx) : cls;
          baseClasses.push(baseName.toLowerCase());
        }
      }
      baseClasses.sort();
      var key = tag + ':' + baseClasses.join(' ');
      if (!groups[key]) groups[key] = [];
      groups[key].push(child);
    }

    var best = [];
    var groupKeys = Object.keys(groups);
    for (var gi = 0; gi < groupKeys.length; gi++) {
      var items = groups[groupKeys[gi]];
      if (items.length > best.length && items.length >= 2) best = items;
    }
    
    if (best.length >= 2) return best;
    
    // 策略 3: 在子元素中递归查找
    var allItems = [];
    for (var di = 0; di < children.length; di++) {
      var childItems = this._findRepeatingItems(children[di], depth + 1);
      if (childItems.length > allItems.length) {
        allItems = childItems;
      }
    }
    
    return allItems;
  }

  _getSelector(el, parent) {
    var tag = el.tagName.toLowerCase();
    var classList = Array.from(el.classList);
    // For CSS modules like priceInt--hash, use [class*="base"]
    var parts = [];
    for (var ci = 0; ci < classList.length; ci++) {
      var cls = classList[ci];
      var dashIdx = cls.indexOf('--');
      if (dashIdx > 0 && cls.length - dashIdx > 4) {
        parts.push('[class*="' + cls.substring(0, dashIdx) + '"]');
      } else {
        parts.push('.' + cls);
      }
    }
    var base = parts.length ? tag + parts.join('') : tag;
    if (parent) {
      var parentTag = parent.tagName.toLowerCase();
      var parentClassList = Array.from(parent.classList);
      var parentParts = [];
      for (var pci = 0; pci < parentClassList.length; pci++) {
        var pcls = parentClassList[pci];
        var pdashIdx = pcls.indexOf('--');
        if (pdashIdx > 0 && pcls.length - pdashIdx > 4) {
          parentParts.push('[class*="' + pcls.substring(0, pdashIdx) + '"]');
        } else {
          parentParts.push('.' + pcls);
        }
      }
      var parentSel = parentParts.length ? parentTag + parentParts.join('') : parentTag;
      base = parentSel + ' > ' + base;
    }
    return base;
  }

  _suggestFieldName(el) {
    var text = el.textContent.trim();
    var cls = el.className && el.className.toString ? el.className.toString().toLowerCase() : '';
    var tag = el.tagName.toLowerCase();
    var parentCls = '';
    try { parentCls = el.parentElement && el.parentElement.className ? el.parentElement.className.toString().toLowerCase() : ''; } catch(e) {}

    // 提取 CSS Module 基础类名 (如 "priceInt--hash" → "priceint")
    var clsBase = cls;
    var dashIdx = cls.indexOf('--');
    if (dashIdx > 0) clsBase = cls.substring(0, dashIdx);
    var parentClsBase = parentCls;
    var pDashIdx = parentCls.indexOf('--');
    if (pDashIdx > 0) parentClsBase = parentCls.substring(0, pDashIdx);

    // 图片: 标签优先 (最可靠)
    if (tag === 'img') return '图片';

    // 价格: 货币符号开头
    if (/^[¥￥$]\s*\d/.test(text)) return '价格';

    // 价格: 3位以上纯整数 (去除千分位后判断,大概率是价格)
    var cleanNum = text.replace(/[,\s]/g, '');
    if (/^\d{3,}$/.test(cleanNum)) {
      if (/price|money|amount|yen|rmb/.test(clsBase)) return '价格';
      // 修复：扩大“非价格”类名排除(销量/库存/编号/评分/月销)，并要求上下文含货币符号才判为价格，避免 1000/5688 等数字误判
      if (!/sale|sold|sales|shop|store|brand|review|comment|rating|star|coupon|stock|count|num|number|sku|card|month/.test(clsBase)) {
        var _anc = el.parentElement, _cur = false, _dep = 0;
        while (_anc && _anc !== document.body && _dep < 4) { if (/[¥￥$]/.test(_anc.textContent || '')) { _cur = true; break; } _anc = _anc.parentElement; _dep++; }
        if (_cur) return '价格';
      }
    }
    // 价格: 小数 + 价格类名 (避免把评分 4.5 误判为价格)
    if (/^\d+\.\d+$/.test(cleanNum) && /price|money|amount/.test(clsBase)) return '价格';

    // 销量: 文本模式
    if (/(?:月销|已售|销量|付款|成交|sold|sales)/i.test(text)) return '销量';
    if (/(?:sale|sold|sales|deal)/.test(clsBase)) return '销量';

    // 评分: 需要类名佐证 (避免任意小数被误判)
    if (/^[\d.]+$/.test(text) && parseFloat(text) <= 5 && /rating|star|score/.test(clsBase)) return '评分';

    // 日期
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return '日期';

    // 链接
    if (/^https?:\/\//.test(text)) return '链接';

    // 评价
    if (/(?:good|好评|差评|中评|评价|review|comment)/.test(text)) return '评价';
    if (/review|comment/.test(clsBase)) return '评价数';

    // 图片类名
    if (/(?:img|image|pic|photo|mainimg|mainpic|cardimg)/.test(clsBase)) return '图片';

    // 标题: 匹配自身类名 (支持 title, productname, p-name 等) —— 优先于优惠券文本匹配
    // 原因: .title class 是强信号，而文本含"优惠"可能是商品标题内容（如"优惠大桶"）
    if (/title|productname|itemname|goodstitle/i.test(clsBase)) return '标题';
    if (/(?:^|[-_])name$/i.test(clsBase)) return '标题';

    // 优惠券: 仅当 class 含 coupon/discount，或文本为短券信息（非长商品标题）
    if (/(?:coupon|discount)/.test(clsBase)) return '优惠券';
    if (/券/.test(text) && text.length < 15) return '优惠券';

    // 商家: 子串匹配 (支持 shop, shopNameText, p-shop, gl-i-shop, store, brand 等)
    // 修复: 增加文本长度判断，商家/店铺名通常较短，标题通常较长
    if (/(?:^|[-_])(?:shop|store|brand|merchant|seller)/i.test(clsBase)) {
      // 如果文本较长 (>25 字符)，更可能是商品标题而非商家名
      if (text.length > 25) {
        // 尝试判断是否为标题
        if (/title|productname|itemname|goodstitle/.test(parentClsBase)) return '标题';
        return '商家';
      }
      return '商家';
    }

    // 回退: 父级类名提示 (可靠性较低,放最后)
    // 修复: 父级 shop 类名仅在文本较短时才判定为商家
    if (/^(?:shop|store|brand|merchant|seller)/.test(parentClsBase)) {
      // 短文本 (<15 字符) 且父级是 shop，判定为商家/店铺名
      if (text.length > 0 && text.length <= 15) return '商家';
    }
    // 仅当自身类名不指向其他字段时,才使用父级 title 提示
    if (/title/.test(parentClsBase) && !/^(?:shop|store|brand|price|sale|sold|coupon|img|pic|review|comment|rating)/.test(clsBase)) {
      return '标题';
    }

    return '';
  }

  async extractCurrentPage(fields, containerSelector) {
    var data = [];
    var container = containerSelector
      ? document.querySelector(containerSelector)
      : document.body;

    if (!container) return [];

    // 平台配置优先：用平台专用卡片选择器查找
    var items = [];
    if (window.__PlatformConfigs) {
      var pcResult = window.__PlatformConfigs.getConfig();
      if (pcResult.config) {
        // 1. 尝试 cardSelectors
        var cardSels = pcResult.config.cardSelectors || [];
        for (var csi = 0; csi < cardSels.length; csi++) {
          try {
            var found = container.querySelectorAll(cardSels[csi]);
            if (found.length >= 3) { items = Array.from(found); break; }
          } catch(e) {}
        }
        // 2. 拼多多等纯hash class平台：通过 priceHint 反向定位卡片
        if (items.length === 0 && pcResult.config.priceHint) {
          var priceEls = container.querySelectorAll('[class*="' + pcResult.config.priceHint + '"]');
          if (priceEls.length >= 3) {
            // 对每个价格元素向上找卡片（含titleHint的容器）
            var cardSet = new Set();
            for (var pi = 0; pi < priceEls.length; pi++) {
              var p = priceEls[pi];
              for (var up = 0; up < 6; up++) {
                if (!p.parentElement || p.parentElement === container) break;
                p = p.parentElement;
                if (pcResult.config.titleHint && p.querySelector('[class*="' + pcResult.config.titleHint + '"]')) {
                  cardSet.add(p);
                  break;
                }
              }
            }
            if (cardSet.size >= 3) items = Array.from(cardSet);
          }
        }
      }
    }

    // 3. 通用回退：_findRepeatingItems
    if (items.length === 0) {
      items = this._findRepeatingItems(container);
    }

    if (items.length === 0) {
      return [this._extractFieldsFromElement(container, fields)];
    }

    for (var ii = 0; ii < items.length; ii++) {
      var row = this._extractFieldsFromElement(items[ii], fields);

      // 空行过滤: 只检查业务字段（排除 来源URL/采集时间 等系统字段，它们始终非空会干扰判断）
      var hasValue = false;
      for (var fi = 0; fi < fields.length; fi++) {
        var v = row[fields[fi].name];
        if (v && v !== '') { hasValue = true; break; }
      }
      if (!hasValue) continue;

      // 跳过表头行: 字段值与字段名大量重合
      var headerMatchCount = 0;
      for (var fi2 = 0; fi2 < fields.length; fi2++) {
        var v2 = row[fields[fi2].name];
        if (v2 && (v2 === fields[fi2].name || v2 === fields[fi2].sample)) headerMatchCount++;
      }
      if (headerMatchCount >= Math.ceil(fields.length / 2)) continue;

      // 跳过空行/分隔行: 业务字段值都极短
      var nonEmptyFieldCount = 0;
      for (var fi3 = 0; fi3 < fields.length; fi3++) {
        var v3 = row[fields[fi3].name];
        if (v3 && v3.length > 1) nonEmptyFieldCount++;
      }
      if (nonEmptyFieldCount === 0) continue;

      data.push(row);
    }
    return data;
  }

  _extractFieldsFromElement(element, fields) {
    var row = {};
    row['来源URL'] = window.location.href;
    row['采集时间'] = new Date().toLocaleString();

    for (var fi = 0; fi < fields.length; fi++) {
      var field = fields[fi];
      try {
        var el = null;
        if (field.selector) {
          el = element.querySelector(field.selector);
          // Fallback: search by class substring for CSS modules
          if (!el) {
            var clsMatch = field.selector.match(/\[class\*\="([^"]+)"\]/);
            if (clsMatch) {
              var children = element.querySelectorAll('*');
              for (var ai = 0; ai < Math.min(children.length, 200); ai++) {
                if (children[ai].className && children[ai].className.toString().indexOf(clsMatch[1]) >= 0) {
                  el = children[ai];
                  break;
                }
              }
            }
          }
        }

        if (!el) {
          row[field.name] = '';
          continue;
        }

        var value = '';
        if (field.name === '图片') {
          var img = el.tagName === 'IMG' ? el : el.querySelector('img');
          // 修复：兼容懒加载图片（data-lazyload-src/data-original/data-src-cache 等）
          value = img ? (img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-src-cache') || img.getAttribute('data-lazyload-src') || img.getAttribute('data-original') || '') : '';
        } else if (field.name === '链接') {
          var link = el.tagName === 'A' ? el : el.querySelector('a');
          value = link ? link.href : el.href || '';
        } else if (field.name === '标题') {
          // 标题优先用 title 属性（更完整，京东新版用 title 属性存标题）
          value = el.getAttribute('title') || el.textContent.trim();
        } else {
          value = el.textContent.trim();
        }

        row[field.name] = value;
      } catch (e) {
        row[field.name] = '';
      }
    }
    return row;
  }

  // 卡片指纹：基于 sku+链接+首段文本，用于判定翻页是否成功（避免整页 innerHTML 快照的性能/误判问题）
  _cardFingerprint() {
    try {
      var cards = document.querySelectorAll('.gl-item, li[data-sku], [class*="Card--doubleCard"], [class*="doubleCard"], [class*="goods"]');
      var s = '';
      for (var i = 0; i < Math.min(cards.length, 6); i++) {
        var cc = cards[i];
        var aa = cc.querySelector('a');
        s += (cc.getAttribute('data-sku') || '') + '|' + (aa ? aa.getAttribute('href') : '') + '|' + ((cc.textContent || '').trim().slice(0, 20)) + ';';
      }
      return s;
    } catch(e) { return ''; }
  }

  async findNextPageButton() {
    // 平台通用 + 京东 pn-next 专用（京东搜索/列表页翻页按钮）
    var allLinks = document.querySelectorAll('a, button, span[class*="next"], [class*="pn-next"], [class*="Pagination"] a, [class*="ivu-page-next"]');
    for (var ai = 0; ai < allLinks.length; ai++) {
      var el = allLinks[ai];
      var text = (el.textContent || '').trim();
      var cls = (el.className || '') + ' ' + (el.getAttribute('class') || '');
      // 文本匹配：下一页/Next
      if (/^(下一页|下一頁|下一|Next|next)/.test(text)) {
        if (el.getAttribute('disabled') !== null) continue;
        if (el.classList.contains('disabled')) continue;
        if (el.getAttribute('aria-disabled') === 'true') continue;
        return el;
      }
      // 京东 pn-next 专用：类名匹配（部分按钮文本可能被样式隐藏）
      if (/pn-next/.test(cls)) {
        if (el.getAttribute('disabled') !== null) continue;
        if (el.classList.contains('disabled')) continue;
        if (el.getAttribute('aria-disabled') === 'true') continue;
        return el;
      }
    }
    return null;
  }

  async clickNextPage() {
    var btn = await this.findNextPageButton();
    if (!btn) return false;

    // 翻页前执行平台限流并保留三档随机延迟，再模拟真人行为。
    if (typeof RequestPolicy !== 'undefined') {
      try { await RequestPolicy.throttle(window.location.href, 'pageTurn'); } catch(e) {}
      try { await RequestPolicy.simulateHumanBehavior(btn); } catch(e) {}
    }

    var oldUrl = window.location.href;
    var oldFp = this._cardFingerprint(); // 修复：用卡片指纹替代整页 innerHTML 快照（性能/误判）
    var cardCount = this._countProductCards();

    try {
      btn.click();
      await new Promise(function(r) { setTimeout(r, 2000); });

      var changed = false;
      for (var i = 0; i < 8; i++) {   // 最多轮询 4 秒
        await new Promise(function(r) { setTimeout(r, 500); });
        var newCard = this._countProductCards();
        if (window.location.href !== oldUrl || this._cardFingerprint() !== oldFp || newCard !== cardCount) {
          changed = true;
          break;
        }
      }
      // 翻页成功的兜底信号：页面发生滚动/顶部 URL 变化/卡片更新
      await new Promise(function(r) { setTimeout(r, 800); });
      return changed || window.location.href !== oldUrl;
    } catch (e) {
      return false;
    }
  }

  // 统计当前页商品卡片数（京东 .gl-item / 淘宝 Card 等，用于判定翻页是否成功）
  _countProductCards() {
    var selectors = ['.gl-item', '[data-sku]', '[class*="Card--doubleCard"]', '[class*="doubleCard"]', '[class*="offer-item"]', '[class*="goods"]'];
    for (var i = 0; i < selectors.length; i++) {
      try {
        var n = document.querySelectorAll(selectors[i]).length;
        if (n >= 5) return n;
      } catch(e) {}
    }
    // 通用：统计列表容器内 li
    var any = document.querySelectorAll('.gl-item, li[data-sku], [class*="goodsList"] li, ul li');
    return any.length;
  }

  async scrollToLoad(count) {
    // count 为正数：固定滚动次数（向后兼容）
    // count 为 'auto' 或省略：瀑布流模式，持续滚动直到无新内容
    var useRequestPolicy = typeof RequestPolicy !== 'undefined';
    if (count === 'auto' || count === undefined) {
      var maxScrolls = 20; // 最多滚动20次，防止无限滚动
      var lastHeight = 0;
      var stableCount = 0;
      for (var i = 0; i < maxScrolls && this.isRunning; i++) {
        var prevHeight = document.body.scrollHeight;
        // 人化滚动到底（分3-5段 + wheel，模拟真人滚轮，防反爬）
        var _tg = document.body.scrollHeight; var _cu = window.scrollY || 0; var _sg = 2 + Math.floor(Math.random() * 3);
        for (var _si = 1; _si <= _sg; _si++) { window.scrollTo(0, Math.min(_tg, _cu + Math.round((_tg - _cu) / (_sg - _si + 1)))); try { window.dispatchEvent(new WheelEvent('wheel', { deltaY: 180, bubbles: true, cancelable: true })); } catch(e){} }
        window.scrollTo(0, _tg);
        // 限速：随机延迟（1.8-3秒）
        if (useRequestPolicy) { await RequestPolicy.throttle(window.location.href, 'scrollToLoad'); }
        else { await checkableWait(5000 + Math.random() * 3000); }
        var newHeight = document.body.scrollHeight;
        if (newHeight === prevHeight) {
          stableCount++;
          // 连续2次高度不变，认为加载完毕
          if (stableCount >= 2) break;
        } else {
          stableCount = 0;
        }
      }
    } else {
      // 固定次数模式
      for (var j = 0; j < count && this.isRunning; j++) {
        // 人化滚动到底（分3-5段 + wheel）
        var _tg2 = document.body.scrollHeight; var _cu2 = window.scrollY || 0; var _sg2 = 2 + Math.floor(Math.random() * 3);
        for (var _sj = 1; _sj <= _sg2; _sj++) { window.scrollTo(0, Math.min(_tg2, _cu2 + Math.round((_tg2 - _cu2) / (_sg2 - _sj + 1)))); try { window.dispatchEvent(new WheelEvent('wheel', { deltaY: 180, bubbles: true, cancelable: true })); } catch(e){} }
        window.scrollTo(0, _tg2);
        if (useRequestPolicy) { await RequestPolicy.throttle(window.location.href, 'scrollToLoad'); }
        else { await checkableWait(5000 + Math.random() * 3000); }
      }
    }
  }

  async scrapeAllPages(fields, maxPages, containerSelector, startPage) {
    // startPage 默认为 1（向后兼容）；maxPages 为截止页码
    startPage = startPage || 1;
    if (startPage < 1) startPage = 1;
    if (maxPages < startPage) maxPages = startPage;

    this.isRunning = true;
    this.extractedData = [];
    this.currentPage = startPage;
    this._collectedPages = 0; // 已采集页数（供panel轮询）
    var totalPages = maxPages - startPage + 1; // 实际需采集的页数
    var collected = 0; // 已采集页数（用于进度）

    // 检测分页类型：平台配置优先
    var paginationType = 'nextpage';
    var containerEl = containerSelector ? document.querySelector(containerSelector) : null;
    this._lastContainer = containerEl; // 保存容器引用供瀑布流使用
    if (window.__PlatformConfigs) {
      var pcResult = window.__PlatformConfigs.getConfig();
      if (pcResult.config && pcResult.config.pagination) {
        paginationType = pcResult.config.pagination;
      }
    }

    // 瀑布流模式：滚动加载 + 去重采集，maxPages 作为滚动轮数
    if (paginationType === 'waterfall') {
      await this.scrollToLoad(2); // 初始加载
      var waterfallRounds = totalPages; // 用页数控制滚动轮数
      for (var round = 0; round < waterfallRounds && this.isRunning; round++) {
        // 访问受限检测：验证码/风控时暂停
        if (this.isRunning) await this.checkRequestPolicyPause();
        if (!this.isRunning) break;
        collected++;
        this._collectedPages = collected;
        chrome.runtime.sendMessage({
          action: 'scrapeProgress',
          page: collected,
          totalPages: totalPages,
          currentPage: round + 1
        });

        var wfData = await this.extractCurrentPage(fields, containerSelector);
        var wfBefore = this.extractedData.length;
        for (var wpi = 0; wpi < wfData.length; wpi++) {
          var wfRow = wfData[wpi];
          var wfKey = (wfRow['标题'] || '') + '|' + (wfRow['价格'] || '');
          var wfDup = false;
          for (var wdi = 0; wdi < this.extractedData.length; wdi++) {
            var wfExist = this.extractedData[wdi];
            var wfExistKey = (wfExist['标题'] || '') + '|' + (wfExist['价格'] || '');
            if (wfKey === wfExistKey && wfKey !== '|') { wfDup = true; break; }
          }
          if (!wfDup) this.extractedData.push(wfRow);
        }
        var wfNewCount = this.extractedData.length - wfBefore;

        if (round < waterfallRounds - 1) {
          // 滚动加载更多：每轮固定滚 2 次（对应"1 页"），受轮数与 isRunning 控制
          await this.scrollToLoad(2);
          await new Promise(function(r) { setTimeout(r, 1000); });
          // 若滚动后无新数据，提前结束
          if (wfNewCount === 0) {
            var wfCheck = await this.extractCurrentPage(fields, containerSelector);
            var wfCheckNew = 0;
            for (var wci = 0; wci < wfCheck.length; wci++) {
              var wck = (wfCheck[wci]['标题'] || '') + '|' + (wfCheck[wci]['价格'] || '');
              var found = false;
              for (var wcei = 0; wcei < this.extractedData.length; wcei++) {
                if (wck === ((this.extractedData[wcei]['标题']||'')+'|'+(this.extractedData[wcei]['价格']||'')) && wck !== '|') { found = true; break; }
              }
              if (!found) wfCheckNew++;
            }
            if (wfCheckNew === 0) break; // 无新内容，结束
          }
        }
      }
      this.isRunning = false;
      return this.extractedData;
    }

    // === 翻页模式 ===
    // 若起始页 > 1，先翻页到起始页（不采集中间页）
    if (startPage > 1) {
      chrome.runtime.sendMessage({
        action: 'scrapeProgress',
        page: 0,
        totalPages: totalPages,
        jumping: true,
        targetPage: startPage
      });
      for (var sp = 1; sp < startPage; sp++) {
        if (!this.isRunning) { this.isRunning = false; return this.extractedData; }
        var jumped = await this.clickNextPage();
        if (!jumped) {
          // 无法翻到目标起始页，从当前页开始采集
          this.currentPage = sp + 1;
          break;
        }
        // 限速：短暂等待翻页完成（clickNextPage 已含人化+轮询）
        await new Promise(function(r) { setTimeout(r, 1500 + Math.random() * 1000); });
      }
      // 轻量滚动（不触发 scrollToLoad 的 8-15s 空转）
      try { window.scrollTo(0, document.body.scrollHeight); } catch(e) {}
      await new Promise(function(r) { setTimeout(r, 800); });
    } else {
      // 第一页：轻量滚动 1 次触发懒加载（非瀑布流，无需 8-15s 空转）
      try { window.scrollTo(0, Math.min(document.body.scrollHeight, window.innerHeight * 0.8)); } catch(e) {}
      await new Promise(function(r) { setTimeout(r, 800); });
    }

    while (this.isRunning && this.currentPage <= maxPages) {
      // 访问受限检测：验证码/风控时暂停
      await this.checkRequestPolicyPause();
      if (!this.isRunning) break;
      collected++;
      this._collectedPages = collected;
      chrome.runtime.sendMessage({
        action: 'scrapeProgress',
        page: collected,
        totalPages: totalPages,
        currentPage: this.currentPage
      });

      var pageData = await this.extractCurrentPage(fields, containerSelector);
      // 去重：按标题+价格组合去重
      var beforeLen = this.extractedData.length;
      for (var pi = 0; pi < pageData.length; pi++) {
        var row = pageData[pi];
        var key = (row['标题'] || row['title'] || '') + '|' + (row['价格'] || row['price'] || '');
        var isDup = false;
        for (var di = 0; di < this.extractedData.length; di++) {
          var existRow = this.extractedData[di];
          var existKey = (existRow['标题'] || existRow['title'] || '') + '|' + (existRow['价格'] || existRow['price'] || '');
          if (key === existKey && key !== '|') { isDup = true; break; }
        }
        if (!isDup) this.extractedData.push(row);
      }

      this.currentPage++;
      if (this.currentPage > maxPages) break;

      // 翻页前自然浏览（防反爬）：鼠标游移 + 轻微滚动，模拟真人浏览后再翻页
      if (typeof RequestPolicy !== 'undefined') { try { await RequestPolicy.simulateHumanBehavior(); } catch(e) {} }
      var hasNext = await this.clickNextPage();
      if (!hasNext && this.currentPage <= maxPages && this.isRunning) {
        // 翻页失败重试；clickNextPage 内部会再次执行限流。
        hasNext = await this.clickNextPage();
      }
      if (!hasNext) break; // 无下一页，结束

      // RequestPolicy 已在 clickNextPage 前完成限流与随机延迟；无策略模块时保留兜底等待。
      if (typeof RequestPolicy === 'undefined') {
        await checkableWait(5000 + Math.random() * 3000);
      }
    }

    this.isRunning = false;
    return this.extractedData;
  }

  // 访问受限检测：发现验证码/风控页面时暂停采集，等待用户完成验证后恢复
  // 增加 120 秒超时自动恢复，避免误判时无限卡住
  async checkRequestPolicyPause() {
    if (typeof RequestPolicy === 'undefined') return;
    var ac = RequestPolicy.detectRestriction();
    if (!ac.detected) return;
    if (RequestPolicy.isPaused()) return; // 已暂停待处理中，避免重复触发
    RequestPolicy.setPaused(true);
    try {
      chrome.runtime.sendMessage({ action: 'RequestPolicyPaused', type: ac.type, url: ac.url || '' });
      // 通知面板弹出"完成验证/继续"浮层（用户可见，不再无声卡住）
      if (typeof ensureAntiCrawlPauseOverlay === 'function') {
        try { ensureAntiCrawlPauseOverlay(); } catch(e) {}
      }
    } catch(e) {}
    // 等用户完成验证（或 120 秒后自动恢复继续，避免永久卡死）
    var pausedStart = Date.now();
    await Promise.race([
      RequestPolicy.waitUntilResumed(),
      new Promise(function(r) { setTimeout(r, 120000); })
    ]);
    // 恢复后：若 120 秒超时仍处于暂停态，自动解除
    try { if (RequestPolicy.isPaused()) RequestPolicy.setPaused(false); } catch(e) {}
    // 恢复后等待1-2秒，让用户完成的验证生效
    if (typeof RequestPolicy !== 'undefined') {
      await RequestPolicy.wait('pageTurn');
    }
  }

  stopScraping() {
    this.isRunning = false;
    // 恢复暂停状态，避免残留
    if (typeof RequestPolicy !== 'undefined') RequestPolicy.setPaused(false);
  }
}

// ========== ManualSelector ==========

var ManualSelector = class {
  constructor() {
    this.isActive = false;
    this.overlay = null;
    this.currentHighlight = null;
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onClick = this._onClick.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  enable() {
    if (this.isActive) return;
    this.isActive = true;

    this.overlay = document.createElement('div');
    this.overlay.className = 'ai-scraper-overlay';
    this.overlay.id = 'ai-scraper-overlay';
    document.body.appendChild(this.overlay);

    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('click', this._onClick, true);
    document.addEventListener('keydown', this._onKeyDown);

    this._showTooltip('点击选择数据区域，按 ESC 取消');
  }

  disable() {
    if (!this.isActive) return;
    this.isActive = false;

    if (this.overlay) { this.overlay.remove(); this.overlay = null; }

    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('click', this._onClick, true);
    document.removeEventListener('keydown', this._onKeyDown);

    this._removeHighlight();
    this._removeTooltip();
  }

  _onMouseMove(e) {
    if (!this.isActive) return;
    var target = this._findBestContainer(e.target);
    if (target && target !== this.currentHighlight) {
      this._removeHighlight();
      this._addHighlight(target);
      this.currentHighlight = target;
    }
  }

  _onClick(e) {
    if (!this.isActive) return;
    var target = this._findBestContainer(e.target);
    if (!target) return;

    e.preventDefault();
    e.stopPropagation();

    var selector = this._generateSelector(target);
    var scraper = window.__aiScraper;
    var fields = scraper.identifyFields(target);

    this._removeHighlight();
    target.classList.add('ai-scraper-highlight-selected');

    var storeData = {
      manualSelectResult: {
        selector: selector,
        fields: fields,
        previewData: [],
        info: { tag: target.tagName.toLowerCase(), textPreview: target.textContent.trim().substring(0, 50) },
        timestamp: Date.now()
      }
    };

    chrome.storage.local.set(storeData, function() {
      chrome.runtime.sendMessage({ action: 'containerSelected', selector: selector });
    });

    var self = this;
    setTimeout(function() { target.classList.remove('ai-scraper-highlight-selected'); }, 1500);
    this.disable();

    this._showTooltip('已识别 ' + fields.length + ' 个字段！重新打开插件查看');
    var tooltipRef = this;
    setTimeout(function() { tooltipRef._removeTooltip(); }, 2500);
  }

  _onKeyDown(e) {
    if (e.key === 'Escape') {
      this.disable();
      // 同上下文消息不会触发自身onMessage，使用CustomEvent通知panel.js
      try { window.dispatchEvent(new CustomEvent('ui:cancel')); } catch(err) {}
      try { chrome.runtime.sendMessage({ action: 'manualSelectCancelled' }); } catch(err) {}
    }
  }

  _findBestContainer(el) {
    var current = el, depth = 0;
    var bestContainer = null;
    var bestScore = 0;
    
    while (current && current !== document.body && current !== document.documentElement && depth < 12) {
      var tag = current.tagName.toLowerCase();
      var childCount = current.children.length;
      var rect = current.getBoundingClientRect ? current.getBoundingClientRect() : null;
      
      // Skip tiny elements
      if (rect && (rect.width < 50 || rect.height < 50)) {
        current = current.parentElement;
        depth++;
        continue;
      }
      
      // Check if this element is a good data container: has many similarly-structured children
      if (childCount >= 3 && ['div','ul','ol','table','section','article','main','tbody','form','dl'].indexOf(tag) !== -1) {
        // Score: prefer containers with many same-tag children
        var children = Array.from(current.children);
        var tagCounts = {};
        for (var ci = 0; ci < children.length; ci++) {
          var cTag = children[ci].tagName.toLowerCase();
          var cClass = Array.from(children[ci].classList).sort().join(' ');
          var key = cTag + ':' + cClass;
          tagCounts[key] = (tagCounts[key] || 0) + 1;
        }
        var maxSame = 0;
        for (var k in tagCounts) { if (tagCounts[k] > maxSame) maxSame = tagCounts[k]; }
        var score = maxSame * 10 + childCount;
        
        if (score > bestScore) {
          bestScore = score;
          bestContainer = current;
        }
      }
      
      current = current.parentElement;
      depth++;
    }
    
    return bestContainer || el;
  }

  _generateSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);

    var dataAttrs = Array.from(el.attributes).filter(function(a) { return a.name.indexOf('data-') === 0; });
    if (dataAttrs.length > 0) {
      var attr = dataAttrs[0];
      return '[' + attr.name + '=' + JSON.stringify(attr.value) + ']';
    }

    var tag = el.tagName.toLowerCase();
    var classes = Array.from(el.classList).filter(function(c) { return c.length < 30 && c.indexOf(':') === -1 && c.indexOf('ai-scraper') === -1; }).slice(0, 2);
    if (classes.length > 0) return tag + '.' + classes.map(function(c) { return CSS.escape(c); }).join('.');

    var parent = el.parentElement;
    if (parent) {
      var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === el.tagName; });
      if (siblings.length > 1) return tag + ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
    }
    return tag;
  }

  _addHighlight(el) { el.classList.add('ai-scraper-highlight'); }

  _removeHighlight() {
    if (this.currentHighlight) {
      this.currentHighlight.classList.remove('ai-scraper-highlight');
      this.currentHighlight = null;
    }
  }

  _showTooltip(text) {
    this._removeTooltip();
    var tooltip = document.createElement('div');
    tooltip.id = 'ai-scraper-tooltip';
    tooltip.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#1e1b4b;color:white;padding:12px 24px;border-radius:12px;font-size:14px;z-index:2147483647;box-shadow:0 8px 32px rgba(0,0,0,0.3);pointer-events:none;font-family:sans-serif;';
    tooltip.textContent = text;
    document.body.appendChild(tooltip);
  }

  _removeTooltip() {
    var existing = document.getElementById('ai-scraper-tooltip');
    if (existing) existing.remove();
  }
}

// ========== 初始化 ==========

window.__aiScraper = new PageScraper();
window.__manualSelector = new ManualSelector();

// 命名消息处理器：热重载时先移除旧监听再注册，避免重复处理
var __AIS_ON_MESSAGE = function __AIS_ON_MESSAGE(request, sender, sendResponse) {
  var scraper = window.__aiScraper;

  switch (request.action) {
    case 'scanPage':
      var containers = scraper.scanDataContainers();
      var fields = [];
      if (containers.length > 0) {
        fields = scraper.identifyFields(containers[0].element);
      }
      sendResponse({ containers: containers, fields: fields });
      break;

    case 'scanCustom':
      var targetContainer = request.selector
        ? document.querySelector(request.selector)
        : document.body;
      fields = targetContainer
        ? scraper.identifyFields(targetContainer)
        : [];
      sendResponse({ fields: fields });
      break;

    case 'startScrape':
      scraper.extractCurrentPage(request.fields, request.containerSelector)
        .then(function(data) { sendResponse({ data: data }); })
        .catch(function(err) { sendResponse({ error: err.message }); });
      return true;

    case 'startBatchScrape':
      // 消息通道保持到本次采集真正完成；定时任务据此关闭标签页并导出本次结果。
      var scheduledRunId = request.runId || '';
      scraper.scrapeAllPages(request.fields, request.maxPages, request.containerSelector, request.startPage)
        .then(function(data) {
          var result = { success: true, runId: scheduledRunId, data: data, fields: request.fields || [], total: data.length };
          chrome.runtime.sendMessage({ action: 'batchComplete', runId: scheduledRunId, data: data, total: data.length }).catch(function(){});
          sendResponse(result);
        })
        .catch(function(err) {
          console.error('[电商采集大师] 批量采集异常:', err);
          var message = (err && err.message) || String(err);
          chrome.runtime.sendMessage({ action: 'batchComplete', runId: scheduledRunId, data: [], total: 0, error: message }).catch(function(){});
          sendResponse({ success: false, runId: scheduledRunId, data: [], fields: request.fields || [], total: 0, error: message });
        });
      return true;

    case 'monitorCheck':
      // 定时监控：轻量提取当前详情页的目标字段（价格/库存/标题）
      try {
        var fieldValue = extractMonitorField(request.targetField || 'price');
        sendResponse({ value: fieldValue });
      } catch (e) {
        sendResponse({ value: '', error: e.message });
      }
      break;

    case 'playMonitorSound':
      // 监控变动声音提醒：用 Web Audio API 生成短促提示音（无需音频文件）
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) {
          var ctx = new AC();
          // 连续三个音符：do-mi-sol（C-E-G）上行
          [523.25, 659.25, 783.99].forEach(function(freq, i) {
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.value = freq;
            var startTime = ctx.currentTime + i * 0.15;
            gain.gain.setValueAtTime(0, startTime);
            gain.gain.linearRampToValueAtTime(0.3, startTime + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.25);
            osc.start(startTime);
            osc.stop(startTime + 0.3);
          });
          setTimeout(function () { try { if (ctx && ctx.close) ctx.close(); } catch (eClose) {} }, 900);
        }
        sendResponse({ success: true });
      } catch(e) {
        sendResponse({ success: false, error: e.message });
      }
      break;

    case 'stopScrape':
      scraper.stopScraping();
      sendResponse({ status: 'stopped' });
      break;

    case 'togglePanel':
      var floatBtn = __AIS_DOC().getElementById('ais-float-btn');
      var panel = __AIS_DOC().getElementById('ais-panel');
      if (panel) {
        if (panel.classList.contains('ais-minimized')) {
          panel.classList.remove('ais-minimized');
          if (floatBtn) floatBtn.style.display = 'flex';
          // Reset to scan step
          var steps = panel.querySelectorAll('.ais-step');
          for (var si = 0; si < steps.length; si++) steps[si].classList.remove('active');
          var scanStep = panel.querySelector('#ais-step-scan');
          if (scanStep) scanStep.classList.add('active');
        } else {
          panel.classList.add('ais-minimized');
        }
      }
      sendResponse({ status: 'toggled' });
      break;

    case 'manualSelectMode':
      var ms = window.__manualSelector;
      if (request.enable) {
        ms.enable();
      } else {
        ms.disable();
      }
      sendResponse({ status: 'ok' });
      break;

    // === 右键菜单触发 ===
    case 'contextScanList':
      // 展开面板并触发AI识别
      try {
        var panel1 = __AIS_DOC().getElementById('ais-panel');
        var float1 = __AIS_DOC().getElementById('ais-float-btn');
        if (float1) float1.style.display = 'flex';
        if (panel1) panel1.classList.remove('ais-minimized');
        // 触发 panel.js 的 scanPage
        setTimeout(function() {
          var evt = new CustomEvent('ui:scan');
          window.dispatchEvent(evt);
        }, 300);
        sendResponse({ status: 'ok' });
      } catch(e) { sendResponse({ status: 'error', error: e.message }); }
      break;

    case 'contextScanDetail':
      // 在详情页触发深度采集
      try {
        var panel2 = __AIS_DOC().getElementById('ais-panel');
        var float2 = __AIS_DOC().getElementById('ais-float-btn');
        if (float2) float2.style.display = 'flex';
        if (panel2) panel2.classList.remove('ais-minimized');
        setTimeout(function() {
          var evt = new CustomEvent('ui:detail', { detail: request.payload || {} });
          window.dispatchEvent(evt);
        }, 300);
        sendResponse({ status: 'ok' });
      } catch(e) { sendResponse({ status: 'error', error: e.message }); }
      break;

    case 'contextResume':
      // 从断点恢复
      try {
        var panel3 = __AIS_DOC().getElementById('ais-panel');
        var float3 = __AIS_DOC().getElementById('ais-float-btn');
        if (float3) float3.style.display = 'flex';
        if (panel3) panel3.classList.remove('ais-minimized');
        setTimeout(function() {
          var evt = new CustomEvent('ui:resume');
          window.dispatchEvent(evt);
        }, 300);
        sendResponse({ status: 'ok' });
      } catch(e) { sendResponse({ status: 'error', error: e.message }); }
      break;

    case 'contextIncremental':
      // 增量去重采集
      try {
        var panel4 = __AIS_DOC().getElementById('ais-panel');
        var float4 = __AIS_DOC().getElementById('ais-float-btn');
        if (float4) float4.style.display = 'flex';
        if (panel4) panel4.classList.remove('ais-minimized');
        setTimeout(function() {
          var evt = new CustomEvent('ui:incr');
          window.dispatchEvent(evt);
        }, 300);
        sendResponse({ status: 'ok' });
      } catch(e) { sendResponse({ status: 'error', error: e.message }); }
      break;

    // === 增量采集：返回增量分析结果 ===
    case 'getIncremental':
      if (window.IncrementalCollector) {
        IncrementalCollector.getIncremental(request.url || location.href, request.data || [])
          .then(function(result) { sendResponse(result); });
        return true;
      }
      sendResponse({ isNewCollection: true, newData: request.data || [], dupCount: 0 });
      break;

    // === 断点续采：保存/读取/清除 ===
    case 'saveBreakpoint':
      if (window.IncrementalCollector) {
        IncrementalCollector.saveBreakpoint(request.state)
          .then(function(ok) { sendResponse({ success: ok }); });
        return true;
      }
      sendResponse({ success: false });
      break;

    case 'getBreakpoint':
      if (window.IncrementalCollector) {
        IncrementalCollector.getBreakpoint(request.url || location.href)
          .then(function(bp) { sendResponse({ breakpoint: bp }); });
        return true;
      }
      sendResponse({ breakpoint: null });
      break;

    case 'clearBreakpoint':
      if (window.IncrementalCollector) {
        IncrementalCollector.clearBreakpoint(request.url || location.href)
          .then(function(ok) { sendResponse({ success: ok }); });
        return true;
      }
      sendResponse({ success: false });
      break;

    case 'saveHistory':
      if (window.IncrementalCollector) {
        IncrementalCollector.saveHistory(request.url || location.href, request.data)
          .then(function(ok) { sendResponse({ success: ok }); });
        return true;
      }
      sendResponse({ success: false });
      break;

    case '__e2eTrial':
      // e2e 测试桥：触发试用提示弹窗并返回按钮状态
      try {
        if (typeof showTrialNotice === 'function') showTrialNotice('评论全量采集（测试）', {});
        var _sh2 = window.__AIS_SHADOW__;
        var _btn = _sh2 ? _sh2.getElementById('ais-trial-go') : null;
        sendResponse({ noticeShown: true, trialBtnExists: !!_btn, btnText: _btn ? _btn.textContent : null });
      } catch(e) { sendResponse({ err: e.message }); }
      return true;

    case '__e2eState':
      // e2e 测试桥：返回面板状态（生产逻辑不触发任何副作用）
      try {
        var _sh = window.__AIS_SHADOW__;
        var _pnl = _sh ? _sh.getElementById('ais-panel') : null;
        var _fb = _sh ? _sh.getElementById('ais-float-btn') : null;
        var _r = _fb ? _fb.getBoundingClientRect() : null;
        sendResponse({
          hasShadow: !!_sh,
          hasPanel: !!_pnl,
          hasFloatBtn: !!_fb,
          minimized: _pnl ? _pnl.classList.contains('ais-minimized') : null,
          panelW: _pnl ? Math.round(_pnl.getBoundingClientRect().width) : 0,
          floatX: _r ? Math.round(_r.x) : 0,
          floatY: _r ? Math.round(_r.y) : 0,
          floatRightGap: _r ? Math.round(window.innerWidth - _r.right) : -1,
          floatBottomGap: _r ? Math.round(window.innerHeight - _r.bottom) : -1,
          pageSeesPanel: !!document.getElementById('ais-panel'),
          pageAisClasses: document.querySelectorAll('[class*="ais-"]').length,
          trialProbe: window.__TRIAL_PROBE__ || null
        });
      } catch(e) { sendResponse({ err: e.message }); }
      return true;

    default:
      sendResponse({ error: 'Unknown action' });
  }
  return true;
};

// 防重注册：先移除旧监听（热重载时旧 handler 仍在），再加新监听
try {
  chrome.runtime.onMessage.removeListener(window.__AIS_ON_MESSAGE_OLD__);
} catch(e) {}
window.__AIS_ON_MESSAGE_OLD__ = __AIS_ON_MESSAGE;
chrome.runtime.onMessage.addListener(__AIS_ON_MESSAGE);

// ========== Panel Injection ==========
function injectPanel(forceRebuild) {
  // v1.2.298 平台白名单：名单外平台【完全不注入面板】（改 anchor-rules.json 后点「立即更新规则」即生效，无需发版）
  try { var PFinj = window.AisPlatforms; if (PFinj && PFinj.allowed && !PFinj.allowed(location.hostname)) { console.log('[电商采集大师] 当前平台未开放，跳过注入：' + location.hostname); return; } } catch (ePFinj) {}
  // Wait for body
  if (!document.body) { setTimeout(function(){ injectPanel(forceRebuild); }, 100); return; }
  // 已注入面板：默认保留（避免热注入抖动）；forceRebuild=true 时销毁旧 shadow 重建（用于扩展更新后的全量热重载）
  if (window.__AIS_SHADOW_HOST__) {
    if (!forceRebuild) return;
    // 销毁旧 shadow host（closed shadow 引用在隔离世界，页面无从感知）
    try {
      var oldHost = window.__AIS_SHADOW_HOST__;
      if (oldHost && oldHost.parentNode) oldHost.parentNode.removeChild(oldHost);
    } catch(e) {}
    window.__AIS_SHADOW_HOST__ = null;
    window.__AIS_SHADOW__ = null;
  }

  // ===== Shadow DOM 隔离方案 =====
  // 面板整体挂载到 closed ShadowRoot：
  //  - 页面 JS 无法通过 document.getElementById/querySelector 访问面板内部 DOM
  //  - host 元素本身只有一个随机 id 的空 div，无面板特征
  //  - shadowRoot 引用只保存在 content script 隔离世界（window.__AIS_SHADOW__），页面读不到
  var host = document.createElement('div');  // host 尺寸 0，不参与命中；shadowRoot 内元素（overlay/modal/面板）继承默认 auto 可正常点击
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483640;';
  try {
    var shadow = host.attachShadow({ mode: 'closed' });
  } catch(e) {
    // 极端情况 shadow 不可用，回退普通挂载（功能优先）
    host.remove();
    injectPanelLegacy();
    return;
  }
  document.body.appendChild(host);
  window.__AIS_SHADOW_HOST__ = host;
  window.__AIS_SHADOW__ = shadow;

  // 并发加载面板 HTML 与 CSS 到 shadow root
  // v1.2.368：优先使用【内联面板资源】（content/panel-inline.js）——不再运行时 fetch 扩展资源，
  // 因此 manifest 无需 web_accessible_resources（避免任意网页用 chrome-extension:// 探测到插件）。
  var __inlP = (window.__AIS_PANEL_HTML__ && window.__AIS_PANEL_CSS__)
    ? Promise.resolve([window.__AIS_PANEL_HTML__, window.__AIS_PANEL_CSS__])
    : (function () {
        var panelUrl = chrome.runtime.getURL('content/panel.html');
        var cssUrl = chrome.runtime.getURL('content/panel.css');
        var dialogsCssUrl = chrome.runtime.getURL('content/dialogs.css');
        return Promise.all([
          fetch(panelUrl).then(function(r){ return r.text(); }),
          fetch(cssUrl).then(function(r){ return r.text(); }),
          fetch(dialogsCssUrl).then(function(r){ return r.text(); })
        ]).then(function (r) { return [r[0], r[1] + '\n' + r[2]]; });
      })();
  __inlP.then(function(results){
    var html = results[0], cssText = results[1] + '\n' + results[2];
    if (!window.__AIS_SHADOW__) { window.__AIS_SHADOW__ = shadow; window.__AIS_SHADOW_HOST__ = host; }
    // CSS 样式注入 shadow（不污染页面，也不被页面样式污染）
    try {
      var styleEl = document.createElement('style');
      styleEl.textContent = cssText;
      shadow.appendChild(styleEl);
    } catch(e) { console.error('[电商采集大师] 注入样式失败:', e.message); }
    // panel.html root is <div id="ai-scraper-root">…</div>
    var tmp = document.createElement('div');
    tmp.innerHTML = html.trim();
    var root = tmp.firstElementChild;
    if (root) {
      root.style.display = 'block';
      shadow.appendChild(root);
      // v1.2.330/334：面板就绪信号（闩锁 + 直接回调 + 事件，覆盖任意注册顺序）
      try { window.__AIS_PANEL_READY__ = true; } catch (eL) {}
      try { if (typeof window.__aisOnPanelReady === 'function') window.__aisOnPanelReady(); } catch (eCB) {}
      // v1.2.336：函数已由 panel.js 挂到隔离世界全局——注入完成这一刻直接写平台名（时机最准，不依赖任何回调时序）
      try { if (typeof window.updatePlatformInfo === 'function') window.updatePlatformInfo(0); } catch (eUP) {}
      try { window.dispatchEvent(new CustomEvent('ui:ready')); } catch (ePr) {}
    }
  }).catch(function(err){
    console.error('[电商采集大师] Failed to load panel into shadow:', err);
  });
}

// 兜底：shadow DOM 不可用时的普通挂载（功能优先，隔离性降低）
function injectPanelLegacy() {
  try { var PFinj2 = window.AisPlatforms; if (PFinj2 && PFinj2.allowed && !PFinj2.allowed(location.hostname)) { console.log('[电商采集大师] 当前平台未开放，跳过 legacy 注入：' + location.hostname); return; } } catch (ePFinj2) {}   // v1.2.298
  var panelUrl = chrome.runtime.getURL('content/panel.html');
  var cssUrl = chrome.runtime.getURL('content/panel.css');
  var dialogsCssUrl = chrome.runtime.getURL('content/dialogs.css');
  // 兜底路径同时加载统一弹窗主题，避免普通挂载时样式不一致。
  // v1.2.368：优先使用【内联面板资源】（content/panel-inline.js）——不再运行时 fetch 扩展资源，
  // 因此 manifest 无需 web_accessible_resources（避免任意网页用 chrome-extension:// 探测到插件）。
  var __inlP = (window.__AIS_PANEL_HTML__ && window.__AIS_PANEL_CSS__)
    ? Promise.resolve([window.__AIS_PANEL_HTML__, window.__AIS_PANEL_CSS__])
    : (function () {
        var panelUrl = chrome.runtime.getURL('content/panel.html');
        var cssUrl = chrome.runtime.getURL('content/panel.css');
        var dialogsCssUrl = chrome.runtime.getURL('content/dialogs.css');
        return Promise.all([
          fetch(panelUrl).then(function(r){ return r.text(); }),
          fetch(cssUrl).then(function(r){ return r.text(); }),
          fetch(dialogsCssUrl).then(function(r){ return r.text(); })
        ]).then(function (r) { return [r[0], r[1] + '\n' + r[2]]; });
      })();
  __inlP.then(function(results){
    var html = results[0], cssText = results[1] + '\n' + results[2];
    try {
      var styleEl = document.createElement('style');
      styleEl.textContent = cssText;
      document.head.appendChild(styleEl);
    } catch(e) { console.error('[电商采集大师] 注入样式失败:', e.message); }
    var tmp = document.createElement('div');
    tmp.innerHTML = html.trim();
    var root = tmp.firstElementChild;
    if (root) {
      root.style.display = 'block';
      document.body.appendChild(root);
      // v1.2.330/334：同上（legacy 挂载路径）
      try { window.__AIS_PANEL_READY__ = true; } catch (eL2) {}
      try { if (typeof window.__aisOnPanelReady === 'function') window.__aisOnPanelReady(); } catch (eCB2) {}
      try { if (typeof window.updatePlatformInfo === 'function') window.updatePlatformInfo(0); } catch (eUP2) {}
      try { window.dispatchEvent(new CustomEvent('ui:ready')); } catch (ePr2) {}
    }
  }).catch(function(err){
    console.error('[电商采集大师] Failed to load panel:', err);
  });
}
// Create scraper instances
window.__aiScraper = new PageScraper();
window.__manualSelector = new ManualSelector();

// Initialize DetailCollector for detail page scraping
if (window.DetailCollector) {
  window.__detailCollector = window.DetailCollector;
  // Auto-initialize on detail pages to inject interceptors
  if (window.__detailCollector.isDetailPage()) {
    window.__detailCollector.init().then(function(result) {
      if (result.success) {
        console.log('[电商采集大师] 详情页采集模式已激活，商品ID:', result.itemId);
      }
    });
  }
}

// 定时监控：轻量提取详情页目标字段
// targetField: 'price' | 'stock' | 'title'
function extractMonitorField(targetField) {
  var url = window.location.href;
  // 京东详情页
  if (/item\.jd\.com|item\.m\.jd\.com/.test(url)) {
    if (targetField === 'price') {
      // 京东价格在 .price 或 [class*=price]
      var el = document.querySelector('.price, .J-p-' + getItemIdFromUrl(url) + ', [class*=price]:not([class*=priceInt])');
      // 优先用 pageData
      if (window.pageData && window.pageData.product && window.pageData.product.price) {
        return String(window.pageData.product.price);
      }
      if (el) return cleanMonitorText(el.textContent);
    }
    if (targetField === 'title') {
      var tEl = document.querySelector('.itemInfo .sku-name, .product-intro .sku-name, [class*=sku-name], [class*="skuname"], [class*="sku-title"]');
      if (tEl) return cleanMonitorText(tEl.textContent);
    }
  }
  // 淘宝/天猫详情页
  if (/item\.taobao\.com|detail\.tmall\.com|item\.tmall\.com/.test(url)) {
    if (targetField === 'price') {
      var tbEl = document.querySelector('[class*=Price]:not([class*=PriceInt]), .tb-rmb, .tm-price, [class*=price]');
      if (tbEl) return cleanMonitorText(tbEl.textContent);
    }
    if (targetField === 'title') {
      var tbTitle = document.querySelector('[class*=ItemHeader--title], .tb-detail-hd h1, [class*=mainTitle]');
      if (tbTitle) return cleanMonitorText(tbTitle.textContent);
    }
  }
  // 1688 详情页
  if (/detail\.1688\.com/.test(url)) {
    if (targetField === 'price') {
      var aEl = document.querySelector('.price, .od-pc-price-v2, [class*=price]');
      if (aEl) return cleanMonitorText(aEl.textContent);
    }
    if (targetField === 'title') {
      var aTitle = document.querySelector('[class*="offer-title"], .title-text, .mod-detail-title h1, h1[class*="title"]');
      if (aTitle) return cleanMonitorText(aTitle.textContent);
    }
  }
  // 拼多多详情页
  if (/yangkeduo\.com\/goods|pinduoduo\.com\/goods/.test(url)) {
    if (targetField === 'price') {
      var pEl = document.querySelector('[class*=price], .goods-price');
      if (pEl) return cleanMonitorText(pEl.textContent);
    }
  }

  // 通用兜底
  if (targetField === 'price') {
    // 找包含¥/￥的元素
    var all = document.querySelectorAll('span, div, em, strong');
    for (var i = 0; i < all.length && i < 200; i++) {
      var t = all[i].textContent.trim();
      if (/^[¥￥]\s*\d/.test(t) && t.length < 20) return cleanMonitorText(t);
    }
  }
  if (targetField === 'title') {
    return document.title.substring(0, 80);
  }
  return '';
}

function getItemIdFromUrl(url) {
  var m = url.match(/(?:id=|product\/|item\/)(\d+)/);
  return m ? m[1] : '';
}

function cleanMonitorText(text) {
  return String(text || '').trim().replace(/\s+/g, ' ').substring(0, 50);
}


// 热重载：二次加载时已存在的 shadow 面板强制重建（新代码生效，不刷新页面）
var __AIS_RELOADING__ = false;
try { __AIS_RELOADING__ = !!window.__AIS_RELOADING__; } catch(e) {}
injectPanel(__AIS_RELOADING__);
// 面板重建后强制 aisInit 重新初始化（清防重标记；shadow 是新 DOM，必须重绑事件）
if (__AIS_RELOADING__) {
  try {
    window.__AIS_INIT_DONE__ = false;
    window.__AIS_INIT_FORCE__ = true;
    var _retryInit = setInterval(function() {
      var sh = window.__AIS_SHADOW__;
      if (sh && sh.getElementById('ais-panel')) {
        clearInterval(_retryInit);
        if (typeof aisInit === 'function') { try { aisInit(); } catch(e) {} }
      }
    }, 300);
    setTimeout(function() { clearInterval(_retryInit); }, 15000);
  } catch(e) {}
}

