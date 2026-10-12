// 电商采集大师 - 导出工具
// 支持 CSV、Excel、JSON 等多种格式

var ExportUtils = {
  // CSV 导出
  toCSV(data, fields) {
    // 修复1：字段值若以 = + - @ 开头，前缀单引号，防止 Excel/表格 公式注入
    const escape = v => {
      let s = String(v == null ? '' : v);
      if (/^[=+\-@\t]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    // 修复2：原为双转义 '\n'（运行时产出字面 \n，无换行），改为单转义换行
    let csv = fields.map(escape).join(',') + '\n';
    data.forEach(row => {
      csv += fields.map(f => escape(row[f] == null ? '' : row[f])).join(',') + '\n';
    });
    // 修复3：'\uFEFF' 原为字面 BOM 文本，改为真实 UTF-8 BOM
    return '\uFEFF' + csv; // BOM for Excel Chinese support
  },

  toJSON(data) {
    return JSON.stringify(data, null, 2);
  },

  download(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  exportCSV(data, fields, filename) {
    const csv = this.toCSV(data, fields);
    this.download(csv, filename, 'text/csv;charset=utf-8');
  },

  exportJSON(data, filename) {
    const json = this.toJSON(data);
    this.download(json, filename, 'application/json');
  },

  copyAsTable(data, fields) {
    // 修复4：'\t'、'\n' 原为字面，改为真实制表符/换行
    let text = fields.join('\t') + '\n';
    data.forEach(row => {
      text += fields.map(f => row[f] || '').join('\t') + '\n';
    });
    return navigator.clipboard.writeText(text);
  },

  formatData(data, fields) {
    // P2-1 数据清洗：价格清理 + 销量单位归一（2万+→20000），并修正 || 吞 0 值
    return data.map(row => {
      const clean = {};
      fields.forEach(f => {
        let val = row[f] == null ? '' : row[f];
        if (typeof val === 'string' && (f.includes('价格') || f.includes('price') || f.includes('Price'))) {
          val = this.cleanPrice(val);
        } else if ((f.includes('销量') || f.includes('已售') || /sale|sold/i.test(f))) {
          val = this.normalizeSales(val);
        }
        val = String(val).trim().replace(/\s+/g, ' ');
        clean[f] = val;
      });
      return clean;
    });
  },

  // P2-1 销量单位归一："2万+/1.2千/5000+" → 数字
  normalizeSales(value) {
    if (value == null) return '';
    const s = String(value).replace(/\s+/g, '');
    if (s === '') return '';
    const m = s.match(/^([\d.]+)\s*(万|w|千|k|亿)?\s*\+?$/i);
    if (!m) return s;
    const num = parseFloat(m[1]);
    if (isNaN(num)) return s;
    const unit = (m[2] || '').toLowerCase();
    let n = num;
    if (unit === '万' || unit === 'w') n = num * 10000;
    else if (unit === '千' || unit === 'k') n = num * 1000;
    else if (unit === '亿') n = num * 100000000;
    return String(Math.round(n));
  },

  // 价格清理：去货币符/千分位 → 纯数字
  cleanPrice(value) {
    if (value == null) return '';
    return String(value).replace(/[¥￥$,\s]/g, '').trim();
  },

  // 通用单元格清洗（按类型：price/sales/其它）
  cleanCell(value, type) {
    if (value == null) return '';
    if (type === 'price') return this.cleanPrice(value);
    if (type === 'sales') return this.normalizeSales(value);
    return String(value).trim().replace(/\s+/g, ' ');
  },

  // 去重：默认按 标题|价格，可传自定义 keyFn
  dedupRows(data, keyFn) {
    const seen = {};
    const out = [];
    (data || []).forEach(function(r) {
      const k = keyFn ? keyFn(r) : (String(r['标题'] || '') + '|' + String(r['价格'] || ''));
      if (!k || seen[k]) return;
      seen[k] = true;
      out.push(r);
    });
    return out;
  },
};

if (typeof window !== 'undefined') {
  window.ExportUtils = ExportUtils;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ExportUtils };
}
