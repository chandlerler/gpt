// 电商采集大师 - 断点续采 & 增量去重采集模块
// 提供：
//   1. 断点续采：采集中断后保存状态，下次同URL可恢复
//   2. 增量去重：基于内容hash过滤已采集过的数据，只保留新增/变更
// 依赖：chrome.storage.local

var IncrementalCollector = {
  // === 断点续采 ===
  // 存储结构：breakpoints: { [url]: { url, fields, containerSelector, startPage, endPage, lastPage, collectedData, savedAt } }

  // 保存当前采集断点
  saveBreakpoint: function(state) {
    if (!state || !state.url) return Promise.resolve(false);
    return new Promise(function(resolve) {
      chrome.storage.local.get(['breakpoints'], function(r) {
        var bps = r.breakpoints || {};
        bps[state.url] = {
          url: state.url,
          fields: state.fields,
          containerSelector: state.containerSelector,
          startPage: state.startPage,
          endPage: state.endPage,
          lastPage: state.lastPage,           // 已完成的最后一页
          collectedCount: state.collectedCount || 0,
          collectedHashes: state.collectedHashes || [], // 已采集数据hash（增量用）
          savedAt: Date.now()
        };
        chrome.storage.local.set({ breakpoints: bps }, function() {
          resolve(true);
        });
      });
    });
  },

  // 读取某URL的断点
  getBreakpoint: function(url) {
    return new Promise(function(resolve) {
      chrome.storage.local.get(['breakpoints'], function(r) {
        var bps = r.breakpoints || {};
        resolve(bps[url] || null);
      });
    });
  },

  // 列出所有断点（用于断点列表UI）
  listBreakpoints: function() {
    return new Promise(function(resolve) {
      chrome.storage.local.get(['breakpoints'], function(r) {
        var bps = r.breakpoints || {};
        var list = Object.keys(bps).map(function(k) { return bps[k]; });
        // 按保存时间倒序
        list.sort(function(a, b) { return (b.savedAt || 0) - (a.savedAt || 0); });
        resolve(list);
      });
    });
  },

  // 清除某URL的断点
  clearBreakpoint: function(url) {
    return new Promise(function(resolve) {
      chrome.storage.local.get(['breakpoints'], function(r) {
        var bps = r.breakpoints || {};
        if (bps[url]) {
          delete bps[url];
          chrome.storage.local.set({ breakpoints: bps }, function() {
            resolve(true);
          });
        } else {
          resolve(false);
        }
      });
    });
  },

  // 清除所有断点
  clearAllBreakpoints: function() {
    return new Promise(function(resolve) {
      chrome.storage.local.set({ breakpoints: {} }, function() {
        resolve(true);
      });
    });
  },

  // === 增量去重 ===
  // 基于数据内容生成hash：标题+价格+链接（链接优先，无则用标题+价格）
  hashRow: function(row) {
    if (!row) return '';
    var link = row['链接'] || row['link'] || row['url'] || '';
    var title = (row['标题'] || row['商品标题'] || row['title'] || '').trim();
    var price = String(row['价格'] || row['price'] || '').trim();
    // 修复：仅用链接做 hash 会漏掉“价格/标题变更”；改为 链接+标题+价格 组合，能识别新增/变更
    var cleanPrice = price.replace(/[¥￥,，]/g, '');
    var key = [link, title, cleanPrice].join('|');
    if (!link && !title && !cleanPrice) return '';
    return 'K:' + key;
  },

  // 无身份字段记录的内容级键（用于去重，避免无标题/价格/链接的记录重复累加）
  _contentKey: function(row) {
    try {
      var ks = Object.keys(row).sort();
      var s = '';
      for (var i = 0; i < ks.length; i++) { s += ks[i] + '=' + String(row[ks[i]] == null ? '' : row[ks[i]]).trim() + '|'; }
      return s || '';
    } catch(e) { return ''; }
  },

  // 批量计算hash
  hashRows: function(rows) {
    var hashes = [];
    for (var i = 0; i < rows.length; i++) {
      hashes.push(this.hashRow(rows[i]));
    }
    return hashes;
  },

  // 从已有数据中提取hash集合（用于增量去重的比对源）
  buildHashSet: function(existingData) {
    var set = {};
    if (!existingData || existingData.length === 0) return set;
    for (var i = 0; i < existingData.length; i++) {
      var h = this.hashRow(existingData[i]);
      if (h) set[h] = true;
      else { var ck = this._contentKey(existingData[i]); if (ck) set['C:' + ck] = true; } // 修复：无身份记录也建内容级索引
    }
    return set;
  },

  // 过滤出新数据（增量模式）
  // 返回 { newData, dupCount }
  filterNew: function(newData, existingHashSet) {
    var result = [];
    var dupCount = 0;
    var seenInThisBatch = {}; // 同批次去重
    for (var i = 0; i < newData.length; i++) {
      var h = this.hashRow(newData[i]);
      if (!h) {
        // 修复：无身份字段记录按内容级键去重，避免重复累加；无任何内容的记录才保留
        var ck = this._contentKey(newData[i]);
        if (!ck) { result.push(newData[i]); continue; }
        var ckKey = 'C:' + ck;
        if (existingHashSet[ckKey] || seenInThisBatch[ckKey]) { dupCount++; }
        else { result.push(newData[i]); seenInThisBatch[ckKey] = true; }
        continue;
      }
      if (existingHashSet[h] || seenInThisBatch[h]) {
        dupCount++;
      } else {
        result.push(newData[i]);
        seenInThisBatch[h] = true;
      }
    }
    return { newData: result, dupCount: dupCount };
  },

  // === 历史数据管理（增量采集的对照源） ===
  // 存储结构：historyData: { [url]: { data: [...], savedAt, count } }

  saveHistory: function(url, data) {
    if (!url || !data) return Promise.resolve(false);
    return new Promise(function(resolve) {
      chrome.storage.local.get(['historyData'], function(r) {
        var all = r.historyData || {};
        all[url] = {
          url: url,
          data: data,
          count: data.length,
          savedAt: Date.now()
        };
        chrome.storage.local.set({ historyData: all }, function() {
          resolve(true);
        });
      });
    });
  },

  getHistory: function(url) {
    return new Promise(function(resolve) {
      chrome.storage.local.get(['historyData'], function(r) {
        var all = r.historyData || {};
        resolve(all[url] || null);
      });
    });
  },

  // 获取增量采集结果：新数据 + 变更统计
  getIncremental: function(url, newData) {
    var self = this;
    return new Promise(function(resolve) {
      self.getHistory(url).then(function(hist) {
        if (!hist || !hist.data || hist.data.length === 0) {
          // 无历史，全部是新数据
          resolve({
            isNewCollection: true,
            newData: newData,
            dupCount: 0,
            previousCount: 0,
            currentCount: newData.length
          });
        } else {
          var hashSet = self.buildHashSet(hist.data);
          var filtered = self.filterNew(newData, hashSet);
          resolve({
            isNewCollection: false,
            newData: filtered.newData,
            dupCount: filtered.dupCount,
            previousCount: hist.data.length,
            currentCount: newData.length,
            newCount: filtered.newData.length
          });
        }
      });
    });
  }
};

window.IncrementalCollector = IncrementalCollector;
