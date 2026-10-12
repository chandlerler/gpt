// 电商采集大师 - 数据统计分析模块
// 提供列表页采集后的数据分布统计 + 详情页评论深度分析
// 依赖：无（纯计算模块）

var StatsAnalyzer = {
  // ========== 列表页统计 ==========

  // 分析列表采集数据，返回统计摘要
  analyzeListData: function(data, fields) {
    if (!data || data.length === 0) return null;

    var stats = {
      total: data.length,
      price: this._analyzePrice(data, fields),
      sales: this._analyzeSales(data, fields),
      shop: this._analyzeShop(data, fields),
      coupon: this._analyzeCoupon(data, fields)
    };
    return stats;
  },

  // 价格统计：均价/最低/最高/中位数/价格区间分布
  _analyzePrice: function(data, fields) {
    var priceField = this._findField(data, fields, ['价格', 'price', 'Price']);
    if (!priceField) return null;

    var prices = [];
    data.forEach(function(row) {
      var v = row[priceField];
      if (!v) return;
      var rawPrice = String(v).replace(/\s/g, '');
      var num = parseFloat(rawPrice.split(/[-~～至]/)[0].replace(/[^\d.]/g, ''));
      if (!isNaN(num) && num > 0) prices.push(num);
    });

    if (prices.length === 0) return null;
    prices.sort(function(a, b) { return a - b; });

    var sum = prices.reduce(function(a, b) { return a + b; }, 0);
    var avg = sum / prices.length;
    var median = prices.length % 2 === 0
      ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
      : prices[Math.floor(prices.length / 2)];

    // 价格区间分布
    var min = prices[0], max = prices[prices.length - 1];
    var ranges = this._buildRanges(min, max, 5);
    var distribution = ranges.map(function(r) {
      return {
        label: r.label,
        count: prices.filter(function(p) { return p >= r.min && p < r.max; }).length,
        min: r.min, max: r.max
      };
    });
    // 最后一个区间含上界
    if (distribution.length > 0) {
      distribution[distribution.length - 1].count +=
        prices.filter(function(p) { return p === max; }).length;
    }

    return {
      field: priceField,
      count: prices.length,
      avg: Math.round(avg * 100) / 100,
      min: min,
      max: max,
      median: Math.round(median * 100) / 100,
      distribution: distribution
    };
  },

  // 销量统计
  _analyzeSales: function(data, fields) {
    var salesField = this._findField(data, fields, ['销量', '月销', '已售', '付款', 'sales', 'sold']);
    if (!salesField) return null;

    var values = [];
    data.forEach(function(row) {
      var v = row[salesField];
      if (!v) return;
      var raw = String(v).replace(/\s+/g, '');
      var match = raw.match(/([\d.]+)\s*(万|w|千|k|亿)?/i);
      if (!match) return;
      var num = parseFloat(match[1]);
      var unit = (match[2] || '').toLowerCase();
      if (unit === '万' || unit === 'w') num *= 10000;
      else if (unit === '千' || unit === 'k') num *= 1000;
      else if (unit === '亿') num *= 100000000;
      if (!isNaN(num) && num >= 0) values.push(Math.round(num));
    });
    if (values.length === 0) return null;

    values.sort(function(a, b) { return a - b; });
    var sum = values.reduce(function(a, b) { return a + b; }, 0);
    return {
      field: salesField,
      count: values.length,
      total: sum,
      avg: Math.round(sum / values.length),
      median: values[Math.floor(values.length / 2)],
      max: values[values.length - 1]
    };
  },

  // 商家分布 Top10
  _analyzeShop: function(data, fields) {
    var shopField = this._findField(data, fields, ['商家', '店铺', 'shop', 'store']);
    if (!shopField) return null;

    var counts = {};
    data.forEach(function(row) {
      var v = (row[shopField] || '').trim();
      if (v) counts[v] = (counts[v] || 0) + 1;
    });

    var sorted = Object.keys(counts)
      .map(function(k) { return { name: k, count: counts[k] }; })
      .sort(function(a, b) { return b.count - a.count; })
      .slice(0, 10);

    return {
      field: shopField,
      uniqueCount: Object.keys(counts).length,
      topShops: sorted
    };
  },

  // 优惠券统计
  _analyzeCoupon: function(data, fields) {
    var couponField = this._findField(data, fields, ['优惠券', '券', 'coupon']);
    if (!couponField) return null;
    var withCoupon = data.filter(function(row) {
      return (row[couponField] || '').trim().length > 0;
    }).length;
    return {
      field: couponField,
      withCoupon: withCoupon,
      withoutCoupon: data.length - withCoupon,
      rate: Math.round(withCoupon / data.length * 100)
    };
  },

  // ========== 评论深度分析 ==========

  // 差评话题聚类：把差评关键词归到主题(质量/假货山寨/描述不符/物流包装/服务/售后)
  _clusterNegTopics: function(keywords) {
    var map = { '质量':'质量', '质量差':'质量', '有质量问题':'质量', '很差':'质量', '太差':'质量', '极差':'质量', '很差劲':'质量', '质量烂':'质量', '很烂':'质量', '损坏':'质量', '坏':'质量', '裂':'质量', '开裂':'质量', '裂开':'质量', '掉色':'质量', '异味':'质量', '过敏':'质量', '不能用':'质量', '不能开机':'质量', '垃圾':'质量',
                '假货':'假货/山寨', '假冒':'假货/山寨', '山寨':'假货/山寨', '翻新':'假货/山寨', '骗':'假货/山寨', '骗人':'假货/山寨', '虚假':'描述不符', '与描述不符':'描述不符',
                '破损':'物流/包装', '差评':'综合', '退货':'售后/退货', '退款':'售后/退货', '不满意':'售后/退货', '客服':'服务', '客服态度差':'服务', '服务':'服务', '发货':'服务/物流', '物流':'物流', '快递':'物流' };
    var topics = {};
    (keywords || []).forEach(function(k) { var t = map[k.word] || '其他'; topics[t] = (topics[t] || 0) + (k.count || 1); });
    var arr = Object.keys(topics).map(function(t) { return { topic: t, count: topics[t] }; }).sort(function(x, y) { return y.count - x.count; });
    return arr.slice(0, 6);
  },

  analyzeReviews: function(reviews) {
    if (!reviews || reviews.length === 0) return null;

    var negativeAlert = this._negativeAlert(reviews);
    var rd = this._ratingDistribution(reviews);
    var total = reviews.length;
    var pos = ((rd['4'] && rd['4'].count) || 0) + ((rd['5'] && rd['5'].count) || 0);
    var neg = ((rd['1'] && rd['1'].count) || 0) + ((rd['2'] && rd['2'].count) || 0);
    var sumCnt = 0, sumRate = 0;
    for (var i = 1; i <= 5; i++) { var c = (rd[String(i)] && rd[String(i)].count) || 0; sumCnt += c; sumRate += i * c; }
    // 优化：集中计算汇总（含差评归因 Top + 话题聚类），供评论卡/分析弹窗直接用
    var negKw = (negativeAlert && negativeAlert.riskKeywords) ? negativeAlert.riskKeywords : [];
    var summary = {
      positiveRate: total > 0 ? Math.round(pos / total * 100) : 0,
      negativeRate: total > 0 ? Math.round(neg / total * 100) : 0,
      avgRating: sumCnt > 0 ? (sumRate / sumCnt).toFixed(1) : '0',
      total: total,
      negativeKeywords: negKw,
      negativeTopics: this._clusterNegTopics(negKw)   // 优化：差评话题聚类（质量/假货/描述/物流/服务/售后）
    };

    return {
      total: total,
      ratingDistribution: rd,
      wordFrequency: this._wordFrequency(reviews),
      skuDistribution: this._skuDistribution(reviews),
      timeTrend: this._timeTrend(reviews),
      withImage: reviews.filter(function(r) { return r.hasImage; }).length,
      appendCount: reviews.filter(function(r) { return r.isAppend; }).length,
      negativeAlert: negativeAlert,
      summary: summary
    };
  },

  // 差评预警：预警等级只由明确 1-2 星评价驱动；无星级文本只保留为待确认线索，
  // 避免“不是坏的”“物流快”等单词命中把正常评论放大成风险。
  _negativeAlert: function(reviews) {
    var EXPLICIT_ISSUES = ['质量差','质量问题','无法使用','不能使用','不能开机','频繁死机','严重破损',
      '与描述不符','货不对板','疑似假货','假货','假冒','翻新机','开裂','掉色','异味','过敏',
      '退货退款','拒绝退款','客服态度差','售后不处理','虚假宣传','不推荐购买'];
    var NEGATIONS = ['不是','没有','并不','并非','不算','没那么','无'];
    function textOf(r) { return ((r.content || '') + ' ' + (r.appendContent || '')).replace(/\s+/g, ' ').trim(); }
    function hasExplicitIssue(text) {
      for (var i = 0; i < EXPLICIT_ISSUES.length; i++) {
        var phrase = EXPLICIT_ISSUES[i], at = text.indexOf(phrase);
        if (at < 0) continue;
        var before = text.slice(Math.max(0, at - 3), at);
        var negated = NEGATIONS.some(function(n) { return before.indexOf(n) >= 0; });
        if (!negated) return phrase;
      }
      return '';
    }
    var ratedReviews = reviews.filter(function(r) { var v = parseInt(r.rating, 10); return v >= 1 && v <= 5; });
    var negatives = ratedReviews.filter(function(r) { return parseInt(r.rating, 10) <= 2; });
    var suspected = reviews.filter(function(r) {
      var v = parseInt(r.rating, 10);
      return !(v >= 1 && v <= 5) && !!hasExplicitIssue(textOf(r));
    });
    var negativeCount = negatives.length;
    var total = ratedReviews.length;
    var negativeRate = total > 0 ? Math.round(negativeCount / total * 100) : 0;

    // 小样本不制造风险等级：单条差评仅作为明细展示，至少两条才触发低危。
    var level = 'none';
    if (negativeCount >= 5 && negativeRate >= 15) level = 'high';
    else if (negativeCount >= 3 && negativeRate >= 8) level = 'medium';
    else if (negativeCount >= 2 && negativeRate >= 5) level = 'low';

    var riskHits = {};
    negatives.forEach(function(r) {
      var phrase = hasExplicitIssue(textOf(r));
      if (phrase) riskHits[phrase] = (riskHits[phrase] || 0) + 1;
    });
    var riskKeywords = Object.keys(riskHits)
      .map(function(kw) { return { word: kw, count: riskHits[kw] }; })
      .sort(function(a, b) { return b.count - a.count || b.word.length - a.word.length; })
      .slice(0, 5);

    var recent = negatives.slice().sort(function(a, b) { return (b.time || '').localeCompare(a.time || ''); })
      .slice(0, 8).map(function(r) {
        return { rating: parseInt(r.rating, 10) || 0, content: (r.content || '').substring(0, 100),
          skuInfo: r.skuInfo || '', time: r.time || '', username: r.username || r.userName || '匿名' };
      });

    return { level: level, negativeCount: negativeCount, negativeRate: negativeRate,
      ratedCount: total, suspectedCount: suspected.length, riskKeywords: riskKeywords, recentNegatives: recent };
  },

  // 星级分布
  _ratingDistribution: function(reviews) {
    var dist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    reviews.forEach(function(r) {
      var rating = parseInt(r.rating) || 0;
      if (rating >= 1 && rating <= 5) dist[rating]++;
      else if (rating > 0) dist[5]++; // 异常高分归入5星
    });
    var total = dist[1] + dist[2] + dist[3] + dist[4] + dist[5];
    var pct = function(count) { return total > 0 ? Math.round(count / total * 100) : 0; };
    return {
      '5': { count: dist[5], pct: pct(dist[5]) },
      '4': { count: dist[4], pct: pct(dist[4]) },
      '3': { count: dist[3], pct: pct(dist[3]) },
      '2': { count: dist[2], pct: pct(dist[2]) },
      '1': { count: dist[1], pct: pct(dist[1]) },
      knownTotal: total,
      unknownCount: reviews.length - total,
      positiveRate: total > 0 ? Math.round((dist[5] + dist[4]) / total * 100) : 0
    };
  },

  // 词频分析 Top20（中文分词简化版：2-4字滑动窗口 + 停用词过滤）
  _wordFrequency: function(reviews) {
    var stopwords = '的,了,是,在,我,也,都,就,还,很,太,不,没,有,这,那,个,买,用,给,到,和,与,及,或,但,而,且,要,会,能,可,以,为,被,把,让,使,对,从,向,着,过,地,得,吗,呢,吧,啊,哦,嗯,哈,啦,呀,哇,一个,可以,这个,那个,自己,我们,你们,他们,真的,确实,觉得,感觉,时候,现在,然后,因为,所以,但是,如果,虽然,不过,这样,那样,什么,怎么,为什么,非常,特别,比较,稍微,一点,一些,一直,已经,还是,或者,还是';
    var stopSet = {};
    stopwords.split(',').forEach(function(w) { stopSet[w] = true; });

    var freq = {};
    reviews.forEach(function(r) {
      var text = (r.content || '') + (r.appendContent || '');
      if (!text) return;
      // 2-4字滑动窗口
      for (var len = 2; len <= 4; len++) {
        for (var i = 0; i <= text.length - len; i++) {
          var word = text.substring(i, i + len);
          // 跳过含非中文字符的片段
          if (!/^[\u4e00-\u9fa5]+$/.test(word)) continue;
          if (stopSet[word]) continue;
          freq[word] = (freq[word] || 0) + 1;
        }
      }
    });

    // 只保留出现≥2次且长度≥2的词，按频率降序
    var words = Object.keys(freq)
      .filter(function(w) { return freq[w] >= 2; })
      .map(function(w) { return { word: w, count: freq[w] }; })
      .sort(function(a, b) { return b.count - a.count; });

    // 去重子串：若"手机壳"已存在，移除"手机"和"机壳"（简化处理）
    var filtered = [];
    var seen = {};
    for (var i = 0; i < words.length && filtered.length < 20; i++) {
      var w = words[i].word;
      var isSub = false;
      // 检查是否是已选词的子串
      for (var j = 0; j < filtered.length; j++) {
        if (filtered[j].word.indexOf(w) >= 0 || w.indexOf(filtered[j].word) >= 0) {
          // 保留更长的词
          if (w.length > filtered[j].word.length) {
            filtered[j] = words[i];
          }
          isSub = true;
          break;
        }
      }
      if (!isSub) filtered.push(words[i]);
    }
    return filtered;
  },

  // SKU 评论分布
  _skuDistribution: function(reviews) {
    var counts = {};
    reviews.forEach(function(r) {
      var sku = (r.skuInfo || '').trim() || '未指定SKU';
      counts[sku] = (counts[sku] || 0) + 1;
    });
    return Object.keys(counts)
      .map(function(k) { return { sku: k, count: counts[k] }; })
      .sort(function(a, b) { return b.count - a.count; })
      .slice(0, 8);
  },

  // 评论时间趋势（按天聚合）
  _timeTrend: function(reviews) {
    var counts = {};
    reviews.forEach(function(r) {
      var t = r.time || '';
      // 提取 YYYY-MM-DD
      var m = t.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
      if (m) {
        var day = m[1] + '-' + (m[2].length < 2 ? '0' + m[2] : m[2]) + '-' + (m[3].length < 2 ? '0' + m[3] : m[3]);
        counts[day] = (counts[day] || 0) + 1;
      }
    });
    var sorted = Object.keys(counts).sort();
    if (sorted.length === 0) return [];
    return sorted.slice(-14).map(function(day) { // 最近14天
      return { date: day, count: counts[day] };
    });
  },

  // ========== 工具函数 ==========

  _findField: function(data, fields, candidates) {
    if (!fields || fields.length === 0) {
      // 从 data 第一行推断
      if (data.length === 0) return null;
      var keys = Object.keys(data[0]);
      for (var i = 0; i < candidates.length; i++) {
        if (keys.indexOf(candidates[i]) >= 0) return candidates[i];
      }
      return null;
    }
    for (var i = 0; i < candidates.length; i++) {
      for (var j = 0; j < fields.length; j++) {
        if (fields[j].name === candidates[i] || fields[j] === candidates[i]) return candidates[i];
      }
    }
    // 模糊匹配
    for (var k = 0; k < fields.length; k++) {
      var fname = fields[k].name || fields[k];
      for (var c = 0; c < candidates.length; c++) {
        if (fname.indexOf(candidates[c]) >= 0 || candidates[c].indexOf(fname) >= 0) return fname;
      }
    }
    return null;
  },

  _buildRanges: function(min, max, count) {
    if (min === max) max = min + 1;
    var step = (max - min) / count;
    var ranges = [];
    for (var i = 0; i < count; i++) {
      var rMin = min + step * i;
      var rMax = min + step * (i + 1);
      ranges.push({
        min: Math.round(rMin),
        max: Math.round(rMax),
        label: '¥' + Math.round(rMin) + '-' + Math.round(rMax)
      });
    }
    return ranges;
  },

  // ========== SKU 矩阵展开 ==========
  // 将详情页采集的SKU数据展开为矩阵：每个SKU一行，含规格、价格、库存
  // 入参：skus 数组 [{skuId, name, price, stock, available, specs:{}}]
  // 出参：{ rows: [...], summary: {...} }
  buildSkuMatrix: function(skus) {
    if (!skus || skus.length === 0) {
      return { rows: [], summary: { total: 0, available: 0, priceRange: '', avgPrice: 0 } };
    }

    // 收集所有规格维度（从specs对象或name解析）
    var specKeys = {};
    skus.forEach(function(s) {
      if (s.specs && typeof s.specs === 'object') {
        Object.keys(s.specs).forEach(function(k) { specKeys[k] = true; });
      }
    });
    // 若没有specs对象，尝试从name解析 "颜色:红 尺码:L"
    var specKeyList = Object.keys(specKeys);
    if (specKeyList.length === 0) {
      // 尝试从name解析
      var parsedKeys = {};
      skus.forEach(function(s) {
        var name = s.name || '';
        var parts = name.split(/\s+/);
        parts.forEach(function(p) {
          var m = p.match(/^([^:：]+)[:：](.+)$/);
          if (m) parsedKeys[m[1]] = true;
        });
      });
      specKeyList = Object.keys(parsedKeys);
    }

    var rows = skus.map(function(s, idx) {
      var row = {
        '序号': idx + 1,
        'SKU_ID': s.skuId || '',
        'SKU名称': s.name || '',
        '价格': s.price || '',
        '库存': s.stock || '',
        '是否有货': s.available ? '是' : '否'
      };
      // 展开规格维度
      if (s.specs && typeof s.specs === 'object') {
        specKeyList.forEach(function(k) {
          row[k] = s.specs[k] || '';
        });
      } else if (specKeyList.length > 0) {
        // 从name解析规格
        var nameParts = {};
        var nameStr = s.name || '';
        nameStr.split(/\s+/).forEach(function(p) {
          var m = p.match(/^([^:：]+)[:：](.+)$/);
          if (m) nameParts[m[1]] = m[2];
        });
        specKeyList.forEach(function(k) {
          row[k] = nameParts[k] || '';
        });
      }
      return row;
    });

    // 统计摘要
    var prices = skus
      .map(function(s) { return parseFloat(String(s.price || '').replace(/[^\d.]/g, '')); })
      .filter(function(p) { return !isNaN(p) && p > 0; });
    var stockSum = skus.reduce(function(sum, s) {
      var st = parseInt(String(s.stock || '').replace(/[^\d]/g, ''));
      return sum + (isNaN(st) ? 0 : st);
    }, 0);
    var availableCount = skus.filter(function(s) { return s.available; }).length;

    var summary = {
      total: skus.length,
      available: availableCount,
      outOfStock: skus.length - availableCount,
      stockSum: stockSum,
      priceMin: prices.length ? Math.min.apply(null, prices) : 0,
      priceMax: prices.length ? Math.max.apply(null, prices) : 0,
      priceRange: prices.length ? ('¥' + Math.min.apply(null, prices) + ' ~ ¥' + Math.max.apply(null, prices)) : '',
      avgPrice: prices.length ? Math.round(prices.reduce(function(a, b) { return a + b; }, 0) / prices.length) : 0,
      specDimensions: specKeyList
    };

    return { rows: rows, summary: summary };
  },

  // ========== 评论聚合分析（按SKU/星级/时间） ==========
  // 入参：reviews 数组 [{rating, content, skuInfo, time, username, hasImage, isAppend}]
  // 出参：{ total, byRating, bySku, byTime, summary, topKeywords, sentimentDist }
  aggregateReviews: function(reviews) {
    if (!reviews || reviews.length === 0) {
      return {
        total: 0,
        byRating: { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 },
        bySku: [],
        byTime: { last7d: 0, last30d: 0, older: 0 },
        summary: { positiveRate: 0, negativeRate: 0, avgRating: 0, withImageRate: 0 },
        topKeywords: []
      };
    }

    var total = reviews.length;

    // 按星级
    var byRating = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 };
    reviews.forEach(function(r) {
      var rating = parseInt(r.rating) || 0;
      if (rating >= 1 && rating <= 5) byRating[rating]++;
      else if (rating > 5) byRating[5]++;
    });

    // 按SKU聚合（包含星级细分）
    var skuMap = {};
    reviews.forEach(function(r) {
      var sku = (r.skuInfo || '').trim() || '未指定SKU';
      if (!skuMap[sku]) {
        skuMap[sku] = { sku: sku, total: 0, ratings: { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 }, withImage: 0 };
      }
      skuMap[sku].total++;
      var rating = parseInt(r.rating) || 0;
      if (rating >= 1 && rating <= 5) skuMap[sku].ratings[rating]++;
      else if (rating > 5) skuMap[sku].ratings[5]++;
      if (r.hasImage) skuMap[sku].withImage++;
    });
    var bySku = Object.keys(skuMap).map(function(k) {
      var s = skuMap[k];
      var positive = s.ratings[5] + s.ratings[4];
      s.positiveRate = s.total > 0 ? Math.round(positive / s.total * 100) : 0;
      return s;
    }).sort(function(a, b) { return b.total - a.total; });

    // 按时间段
    var now = new Date();
    var byTime = { last7d: 0, last30d: 0, older: 0 };
    reviews.forEach(function(r) {
      var t = r.time || '';
      var m = t.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
      if (m) {
        var d = new Date(m[1] + '-' + (m[2].length < 2 ? '0' + m[2] : m[2]) + '-' + (m[3].length < 2 ? '0' + m[3] : m[3]));
        if (!isNaN(d.getTime())) {
          var days = (now - d) / (1000 * 60 * 60 * 24);
          if (days <= 7) byTime.last7d++;
          else if (days <= 30) byTime.last30d++;
          else byTime.older++;
          return;
        }
      }
      byTime.older++;
    });

    // 摘要
    var positiveCount = byRating[5] + byRating[4];
    var negativeCount = byRating[1] + byRating[2];
    var knownRatingTotal = byRating[1] + byRating[2] + byRating[3] + byRating[4] + byRating[5];
    var sumRating = reviews.reduce(function(s, r) { var v = parseInt(r.rating) || 0; return s + (v >= 1 && v <= 5 ? v : 0); }, 0);
    var withImageCount = reviews.filter(function(r) { return r.hasImage; }).length;
    var summary = {
      positiveRate: knownRatingTotal > 0 ? Math.round(positiveCount / knownRatingTotal * 100) : 0,
      negativeRate: knownRatingTotal > 0 ? Math.round(negativeCount / knownRatingTotal * 100) : 0,
      avgRating: knownRatingTotal > 0 ? (sumRating / knownRatingTotal).toFixed(1) : 0,
      knownRatingTotal: knownRatingTotal,
      unknownRatingCount: total - knownRatingTotal,
      withImageRate: total > 0 ? Math.round(withImageCount / total * 100) : 0,
      appendCount: reviews.filter(function(r) { return r.isAppend; }).length
    };

    // 高频关键词（复用已有词频逻辑）
    var topKeywords = this._wordFrequency(reviews).slice(0, 8);

    // 差评预警：1-2星评论提取（按时间倒序，最多10条）
    var NEG_ALERT_KEYWORDS = ['差评','假货','假冒','破损','坏了','开裂','裂开','掉色','异味','过敏','不能用','不能开机','退货','退款','垃圾','骗人','虚假','与描述不符','山寨','翻新','不满意','不推荐','客服态度差','失望','质量差','有质量问题','很差','太差','极差','很差劲','质量烂','很烂','损坏'];
    var negativeReviews = reviews
      .filter(function(r) {
        var v = parseInt(r.rating);
        if (!isNaN(v) && v >= 1 && v <= 5) return v <= 2;
        var t = ((r.content||'') + ' ' + (r.appendContent||'')).toLowerCase();
        for (var i = 0; i < NEG_ALERT_KEYWORDS.length; i++) if (t.indexOf(NEG_ALERT_KEYWORDS[i]) > -1) return true;
        return false;
      })
      .sort(function(a, b) { return (b.time || '').localeCompare(a.time || ''); })
      .slice(0, 10)
      .map(function(r) {
        return {
          rating: parseInt(r.rating) || 0,
          content: (r.content || '').substring(0, 120),
          skuInfo: r.skuInfo || '',
          time: r.time || '',
          username: r.username || r.userName || '匿名'
        };
      });

    // 差评预警关键词命中检测（预设风险词库）
    var RISK_KEYWORDS = ['质量', '假货', '假冒', '破损', '坏', '裂', '掉色', '异味', '过敏', '不能用', '不能开机', '退货', '退款', '差评', '垃圾', '骗', '虚假', '与描述不符', '山寨', '翻新'];
    var riskHits = {};
    negativeReviews.forEach(function(r) {
      var c = r.content || '';
      RISK_KEYWORDS.forEach(function(kw) {
        if (c.indexOf(kw) >= 0) {
          riskHits[kw] = (riskHits[kw] || 0) + 1;
        }
      });
    });
    var topRiskKeywords = Object.keys(riskHits)
      .map(function(kw) { return { word: kw, count: riskHits[kw] }; })
      .sort(function(a, b) { return b.count - a.count; })
      .slice(0, 5);

    // 差评预警等级（基于差评率和差评数）
    var alertLevel = 'none';
    var negativeRate = summary.negativeRate;
    if (negativeCount >= 5 && negativeRate >= 15) alertLevel = 'high';
    else if (negativeCount >= 3 && negativeRate >= 8) alertLevel = 'medium';
    else if (negativeCount >= 1) alertLevel = 'low';

    return {
      total: total,
      byRating: byRating,
      bySku: bySku.slice(0, 10),
      byTime: byTime,
      summary: summary,
      topKeywords: topKeywords,
      // 差评预警
      negativeAlert: {
        level: alertLevel,
        negativeCount: negativeCount,
        negativeRate: negativeRate,
        recentNegatives: negativeReviews,
        riskKeywords: topRiskKeywords
      }
    };
  },

  // P2-A 标题归一（跨平台同款匹配用）：去空格/大小写/平台与店铺后缀词
  normalizeTitle: function(title) {
    if (!title) return '';
    var s = String(title).toLowerCase().replace(/\s+/g, '').replace(/(\d+)gb/g, '$1'); // P2-A：8GB+256GB → 8+256，便于同款匹配
    s = s.replace(/(官方旗舰店|旗舰店|专营店|专卖店|自营|京东自营|包邮|现货|正品|官方)/g, '');
    s = s.replace(/[|｜/，,、;；()[\]（）【】]/g, '');
    return s;
  },

  // P2-A 同款匹配键：品牌 + 归一标题前段
  sameSkuKey: function(title) {
    var t = this.normalizeTitle(title);
    var m = t.match(/(华为|小米|oppo|vivo|荣耀|苹果|iphone|三星|一加|红米|realme|联想|戴尔|索尼|飞利浦)/);
    return ((m && m[0]) || '') + ':' + t.slice(0, 14);
  },

  // P2-A 价格分布（比价直方图）：输入价格数组，输出区间分布
  priceDistribution: function(prices) {
    var nums = [];
    (prices || []).forEach(function(p) {
      var rawPrice = String(p).replace(/\s/g, '');
      var n = parseFloat(rawPrice.split(/[-~～至]/)[0].replace(/[^\d.]/g, ''));
      if (!isNaN(n) && n > 0) nums.push(n);
    });
    if (nums.length === 0) return { count: 0, ranges: [], min: null, max: null };
    nums.sort(function(x, y) { return x - y; });
    var min = nums[0], max = nums[nums.length - 1];
    var buckets = Math.min(5, nums.length);
    var step = (max - min) / buckets || 1;
    var ranges = [];
    for (var i = 0; i < buckets; i++) {
      var lo = min + i * step, hi = (i === buckets - 1) ? max : min + (i + 1) * step;
      var cnt = nums.filter(function(n) { return n >= lo && n <= hi; }).length;
      ranges.push({ range: Math.round(lo) + '-' + Math.round(hi), count: cnt });
    }
    return { count: nums.length, min: min, max: max, ranges: ranges };
  },

  // P2-A 同款分组比价：输入 rows([{标题,价格}])，按归一标题分组输出 最低/最高/均价/条数
  groupSameSku: function(rows) {
    var self = this; // 修复：forEach 回调内 this 丢失
    var groups = {};
    (rows || []).forEach(function(r) {
      var k = self.sameSkuKey(r['标题'] || r.title || '');
      if (!k || k.indexOf(':') <= 0) return;
      var price = parseFloat(String(r['价格'] || r.price || '').replace(/[^\d.]/g, ''));
      if (isNaN(price) || price <= 0) return;
      if (!groups[k]) groups[k] = { key: k, title: r['标题'] || r.title || '', prices: [], count: 0, min: null, max: null, avg: 0 };
      var g = groups[k];
      g.prices.push(price);
      g.count++;
      g.min = (g.min == null) ? price : Math.min(g.min, price);
      g.max = (g.max == null) ? price : Math.max(g.max, price);
    });
    var out = [];
    for (var k in groups) {
      var g = groups[k];
      if (g.count < 1) continue;
      g.avg = Math.round(g.prices.reduce(function(x, y) { return x + y; }, 0) / g.prices.length);
      out.push({ key: g.key, title: g.title, count: g.count, min: g.min, max: g.max, avg: g.avg });
    }
    out.sort(function(x, y) { return x.min - y.min; });
    return out;
  }
};

// 暴露到全局
if (typeof window !== 'undefined') window.StatsAnalyzer = StatsAnalyzer;
