// 电商采集大师 - CSV 美化生成器
// 生成结构化、带分区和装饰分隔符的 CSV 报告
// 依赖：无（纯生成模块，calculateGoodRate 由外部传入或预计算）

var CSVBeautifier = {
  // 装饰线常量
  LINE_DOUBLE: '═══════════════════════════════════════════════════════════════════════════════════════════════════',
  LINE_SINGLE: '───────────────────────────────────────────────────────────────────────────────────────────────────',
  LINE_DOTTED:  '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄',

  // CSV 单元格转义
  esc: function(v) {
    if (v === null || v === undefined) v = '';
    var s = String(v);
    // 防 CSV 公式注入：以 = + - @ 或制表符开头的单元格前缀单引号
    if (/^[=+\-@\t]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  },

  // 一行数据 → CSV 行（多列）
  row: function(cells) {
    return cells.map(this.esc).join(',');
  },

  // 单列装饰行（如标题、分隔线）
  decoLine: function(text) {
    return this.esc(text);
  },

  // 区块标题（带左右装饰线）
  sectionTitle: function(title) {
    var text = '── ' + title + ' ──';
    return this.esc(text);
  },

  // 顶部标题块
  headerBlock: function(title, meta) {
    var lines = [];
    lines.push(this.decoLine(this.LINE_DOUBLE));
    lines.push(this.esc('  ' + title));
    lines.push(this.decoLine(this.LINE_DOUBLE));
    lines.push('');
    if (meta && meta.length) {
      var self = this;
      meta.forEach(function(m) {
        lines.push(self.row([m[0], m[1]]));
      });
      lines.push('');
    }
    return lines.join('\n');
  },

  // 分隔空行
  blank: function() { return ''; },

  // 免责声明文本
  DISCLAIMER: '本数据由 电商采集大师 工具自动采集自公开网页，仅供个人学习、研究使用。用户应遵守各平台服务协议及相关法律法规，不得用于商业用途或侵权行为。数据准确性不作保证，使用风险自负。工具开发者不承担因数据使用产生的任何法律责任。',

  // 免责声明区块
  disclaimerBlock: function() {
    var lines = [];
    lines.push(this.sectionTitle('免责声明'));
    lines.push(this.esc(this.DISCLAIMER));
    lines.push(this.blank());
    return lines.join('\n');
  },

  // 列表页美化 CSV
  buildListCSV: function(data, fields, stats, meta) {
    var self = this;
    var lines = [];

    // 1. 顶部标题块
    lines.push(self.headerBlock('电商采集大师 · 商品列表采集报告', meta));

    // 2. 数据表格区
    lines.push(self.sectionTitle('商品数据（共 ' + data.length + ' 条）'));
    lines.push(self.row(fields));
    data.forEach(function(d) {
      lines.push(self.row(fields.map(function(f) { return d[f] || ''; })));
    });
    lines.push(self.blank());

    // 3. 统计摘要区
    if (stats) {
      lines.push(self.sectionTitle('数据统计摘要'));
      lines.push(self.row(['指标', '数值']));
      lines.push(self.row(['数据总数', stats.total]));
      if (stats.price) {
        lines.push(self.row(['─ 价格分析 ─', '']));
        lines.push(self.row(['价格·均价', stats.price.avg]));
        lines.push(self.row(['价格·最低', stats.price.min]));
        lines.push(self.row(['价格·最高', stats.price.max]));
        lines.push(self.row(['价格·中位数', stats.price.median]));
        if (stats.price.distribution && stats.price.distribution.length) {
          lines.push(self.row(['─ 价格区间分布 ─', '']));
          stats.price.distribution.forEach(function(d) {
            lines.push(self.row([d.label, d.count + ' 件']));
          });
        }
      }
      if (stats.sales) {
        lines.push(self.row(['─ 销量分析 ─', '']));
        lines.push(self.row(['销量·总销量', stats.sales.total]));
        lines.push(self.row(['销量·平均销量', stats.sales.avg]));
        lines.push(self.row(['销量·最高', stats.sales.max]));
      }
      if (stats.shop) {
        lines.push(self.row(['─ 商家分析 ─', '']));
        lines.push(self.row(['商家总数', stats.shop.uniqueCount]));
        if (stats.shop.topShops && stats.shop.topShops.length) {
          lines.push(self.row(['─ Top 商家排行 ─', '']));
          stats.shop.topShops.forEach(function(s, i) {
            lines.push(self.row(['Top' + (i + 1) + ' · ' + s.name, s.count + ' 件']));
          });
        }
      }
      if (stats.coupon) {
        lines.push(self.row(['─ 优惠券分析 ─', '']));
        lines.push(self.row(['有优惠券商品数', stats.coupon.withCoupon]));
        lines.push(self.row(['优惠券覆盖率', stats.coupon.rate + '%']));
      }
      lines.push(self.blank());
    }

    // 4. 免责声明 + 底部页脚
    lines.push(self.disclaimerBlock());
    lines.push(self.decoLine(self.LINE_DOTTED));
    lines.push(self.esc('  由 电商采集大师 生成 · ' + new Date().toLocaleString('zh-CN')));
    lines.push(self.decoLine(self.LINE_DOTTED));

    return '\uFEFF' + lines.join('\n') + '\n';
  },

  // 详情页美化 CSV（分区结构）
  // goodRate 可选：预计算的好评率字符串，未提供时留空
  buildDetailCSV: function(detailData, stats, goodRate) {
    var self = this;
    var lines = [];
    var d = detailData || {};
    var basic = d.basic || {};

    // 1. 顶部标题块
    var meta = [
      ['商品ID', d.itemId || ''],
      ['商品标题', basic.title || ''],
      ['详情页URL', d.url || ''],
      ['采集时间', d.timestamp || '']
    ];
    lines.push(self.headerBlock('电商采集大师 · 商品详情采集报告', meta));

    // 2. 基本信息
    lines.push(self.sectionTitle('一、商品基本信息'));
    lines.push(self.row(['字段', '内容']));
    lines.push(self.row(['商品标题', basic.title || '']));
    lines.push(self.row(['商品价格', basic.price || '']));
    lines.push(self.row(['店铺名称', basic.shopName || '']));
    lines.push(self.row(['销量', basic.salesText || '']));
    lines.push(self.row(['评分', basic.rating || '']));
    lines.push(self.row(['好评率', goodRate || '']));
    lines.push(self.blank());

    // 3. 商品参数
    if (d.parameters && d.parameters.length) {
      lines.push(self.sectionTitle('二、商品参数（共 ' + d.parameters.length + ' 项）'));
      lines.push(self.row(['参数名', '参数值']));
      d.parameters.forEach(function(p) {
        lines.push(self.row([p.name || '', p.value || '']));
      });
      lines.push(self.blank());
    }

    // 4. SKU 规格
    if (d.skus && d.skus.length) {
      lines.push(self.sectionTitle('三、SKU 规格信息（共 ' + d.skus.length + ' 个）'));
      lines.push(self.row(['SKU ID', '规格', '价格', '库存']));
      d.skus.forEach(function(s) {
        lines.push(self.row([
          s.skuId || s.id || '',
          s.name || s.title || s.spec || s.skuText || s.skuName || '',
          s.price || '',
          (s.stock !== undefined ? s.stock : (s.quantity || ''))
        ]));
      });
      lines.push(self.blank());
    }

    // 5. 评论数据
    if (d.reviews && d.reviews.length) {
      lines.push(self.sectionTitle('四、评论数据（共 ' + d.reviews.length + ' 条）'));
      lines.push(self.row(['用户名', '评分', '时间', 'SKU', '内容']));
      d.reviews.forEach(function(r) {
        lines.push(self.row([
          r.username || r.user || r.userName || '',
          r.rating || r.score || '',
          r.time || r.date || '',
          r.skuInfo || r.sku || r.skuText || '',
          r.content || r.comment || ''
        ]));
      });
      lines.push(self.blank());
    }

    // 6. 图片列表
    if (d.images && d.images.length) {
      lines.push(self.sectionTitle('五、商品图片（共 ' + d.images.length + ' 张）'));
      lines.push(self.row(['序号', '图片URL']));
      d.images.forEach(function(url, i) {
        lines.push(self.row(['图片 ' + (i + 1), url]));
      });
      lines.push(self.blank());
    }

    // 7. 统计摘要
    if (stats) {
      lines.push(self.sectionTitle('六、数据统计摘要'));
      lines.push(self.row(['指标', '数值']));
      lines.push(self.row(['SKU 数量', (d.skus || []).length]));
      lines.push(self.row(['评论数量', (d.reviews || []).length]));
      lines.push(self.row(['参数项数', (d.parameters || []).length]));
      lines.push(self.row(['图片数量', (d.images || []).length]));
      if (stats.reviewAnalysis) {
        var ra = stats.reviewAnalysis;
        lines.push(self.row(['─ 评论分析 ─', '']));
        if (ra.goodRate !== undefined) lines.push(self.row(['好评率', ra.goodRate + '%']));
        if (ra.avgScore !== undefined) lines.push(self.row(['平均评分', ra.avgScore]));
        if (ra.distribution) {
          lines.push(self.row(['─ 评分分布 ─', '']));
          ra.distribution.forEach(function(item) {
            lines.push(self.row([item.label || item.score, item.count + ' 条']));
          });
        }
      }
      lines.push(self.blank());
    }

    // 8. 免责声明 + 底部页脚
    lines.push(self.disclaimerBlock());
    lines.push(self.decoLine(self.LINE_DOTTED));
    lines.push(self.esc('  由 电商采集大师 生成 · ' + new Date().toLocaleString('zh-CN')));
    lines.push(self.decoLine(self.LINE_DOTTED));

    return '\uFEFF' + lines.join('\n') + '\n';
  }
};

// 暴露到全局（浏览器环境）
if (typeof window !== 'undefined') window.CSVBeautifier = CSVBeautifier;
// CommonJS（测试环境）
if (typeof module !== 'undefined' && module.exports) module.exports = { CSVBeautifier: CSVBeautifier };
