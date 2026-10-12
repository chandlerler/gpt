'use strict';
(function (root) {
  const platforms = root.DownloaderPlatforms || (typeof require === 'function' ? require('./platforms.js') : null);
  const CATEGORIES = { main: '主圖', sku: 'SKU款式圖', detail: '詳情圖', video: '影片' };
  const STATUS = { packed: '已放入ZIP', dispatched: '交由商品頁下載（不在ZIP）',
    unconfirmed: '已觸發，需確認（不在ZIP）', failed: '取得失敗' };
  function safeName(value, maxLength = 70) {
    const cleaned = String(value || '').normalize('NFC')
      .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069/\\:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '');
    let shortened = Array.from(cleaned).slice(0, maxLength).join('');
    while (new TextEncoder().encode(shortened).length > 180) shortened = Array.from(shortened).slice(0, -1).join('');
    shortened = shortened.replace(/[. ]+$/g, '');
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(shortened)) shortened = '_' + shortened;
    return shortened || '未命名';
  }
  function productSource(value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) ||
          !['taobao.com', 'tmall.com', 'tmall.hk'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return { id: '', url: '' };
      const id = /^\d{1,30}$/.test(url.searchParams.get('id') || '') ? url.searchParams.get('id') : '';
      return { id, url: url.origin + url.pathname + (id ? '?id=' + id : '') };
    } catch (_) { return { id: '', url: '' }; }
  }
  function referenceUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'blob:') return '[頁面暫存影片]';
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      return url.origin + url.pathname;
    } catch (_) { return ''; }
  }
  function fileName(target, ext) {
    if (!['jpg','png','gif','webp','avif','mp4','mov','webm'].includes(ext)) throw new Error('無法辨識輸出格式');
    const type = Object.hasOwn(CATEGORIES, target.type) ? target.type : 'detail';
    const sequence = Number.isSafeInteger(target.sequence) && target.sequence > 0 ? target.sequence :
      Number.isSafeInteger(target.index) && target.index >= 0 ? target.index + 1 : 1;
    const labels = Array.isArray(target.labels) ? target.labels.filter(label => typeof label === 'string') : [];
    const label = type === 'sku' && labels.length ? '_' + safeName(labels.join('、'), 60) : '';
    return `${CATEGORIES[type]}_${String(sequence).padStart(3, '0')}${label}.${ext}`;
  }
  function archiveName(title, pageUrl, retry = false) {
    const source = productSource(pageUrl);
    return `${source.id ? source.id + '_' : ''}${safeName(title)}${retry ? '_retry' : ''}.zip`;
  }
  function csvCell(value) {
    let text = String(value ?? '');
    // Page titles and SKU labels are untrusted cells, including quoted cells.
    if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  // The customer's own clock and time zone, e.g. 2026/10/08 15:40（電腦時區 UTC+08:00）.
  function localTime(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return '未記錄';
    const pad = n => String(n).padStart(2, '0');
    const offset = -date.getTimezoneOffset(), abs = Math.abs(offset);
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}` +
      `（電腦時區 UTC${offset >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}）`;
  }
  const SCAN_RESULT = { settled: '完整掃描完成', cancelled: '中途停止，只有停止前找到的素材', timeout: '到了掃描時間上限，只有已找到的素材' };
  function buildManifest({ title = '', pageUrl = '', extensionVersion = '', scannedAt = '', scanReason = '', retry = false, output = {} } = {}, entries) {
    const source = productSource(pageUrl);
    const rows = entries.map(({ target, status, path = '', usedUrl = '', copy, copies }) => ({
      category: CATEGORIES[target.type] || CATEGORIES.detail,
      sequence: target.sequence || target.index + 1,
      labels: Array.isArray(target.labels) ? target.labels.filter(v => typeof v === 'string').map(v => v.slice(0,120)) : [],
      variants: Array.isArray(target.variants) ? target.variants.map(v => ({ id: String(v.id || '').slice(0,120), label: String(v.label || '').slice(0,120) })) : [],
      file: path, status: STATUS[status] || STATUS.failed,
      requestedSource: referenceUrl(target.url), usedSource: referenceUrl(usedUrl),
      fallback: !!usedUrl && usedUrl !== target.url,
      copy: copy || null, copies: copies || (copy?.status === 'packed' ? [copy] : [])
    }));
    const report = {
      schemaVersion: 3, output, platform: platforms.identify(pageUrl)?.key || '', extensionVersion: String(extensionVersion), title: String(title), productId: source.id,
      productUrl: source.url, scannedAt: String(scannedAt), scanResult: String(scanReason), retry: retry === true,
      note: '媒體來源已省略查詢參數，僅供追溯，未必能直接下載。商品頁另行下載的影片不在 ZIP 中。', items: rows
    };
    const headers = ['分類','順序','款式名稱','檔案','結果','請求來源（已去參數）','實際來源（已去參數）','使用備援','副本檔案','副本結果','副本尺寸','副本位元組'];
    const csv = '\uFEFF' + [headers, ...rows.map(row => [row.category,row.sequence,row.labels.join('／'),row.file,
      row.status,row.requestedSource,row.usedSource,row.fallback?'是':'否',row.copies.map(c => c.file).join('\n'), row.copy ? (row.copy.status === 'packed' ? '已放入ZIP' : '失敗（原檔保留）') : '',
      row.copies.map(c => c.width + ' × ' + c.height).join('\n'), row.copies.map(c => c.bytes ?? '').join('\n')])].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    // Plain words for the customer; the exact fields stay in 素材清單.json.
    const text = [String(title), `商品編號：${source.id || '未取得'}`, `商品連結：${source.url || '未取得'}`,
      `外掛版本：${extensionVersion}`, `掃描時間：${localTime(scannedAt)}`,
      `掃描結果：${SCAN_RESULT[scanReason] || (scanReason ? '沒有完整結束' : '未記錄')}`,
      retry ? '這份是「重試失敗項目」的檔案，只有這次重新下載的素材。' : '素材分別放在「主圖」「SKU款式圖」「詳情圖」「影片」資料夾（沒有的類別就沒有資料夾）。',
      '每個檔案是哪個款式，請看「素材清單.csv」（可以用 Excel 開啟）。',
      '有做上架副本時，副本放在「上架副本」資料夾：副本是靜態圖片（動圖只取第一張），JPG 的透明處會變成白底；原檔另外保留。',
      '很長的詳情圖如果有切段，檔名依 part001、part002 排序；有設定容量上限時，畫質或尺寸可能會降低。',
      '清單裡的網址拿掉了後面的參數，只用來查來源，不一定能直接下載。在商品頁另外下載的影片不在這個壓縮檔裡。',
      '「已放入ZIP」表示素材在這個壓縮檔裡；外掛沒辦法確認電腦是否已存好，請打開壓縮檔看看。'].join('\r\n');
    return { report, csv, text };
  }
  root.DownloaderArchive = { CATEGORIES, safeName, productSource, referenceUrl, fileName, archiveName, buildManifest };
  if (typeof module !== 'undefined') module.exports = root.DownloaderArchive;
})(globalThis);
