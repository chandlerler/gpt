'use strict';
(function (root) {
  const assets = root.DownloaderAssets || (typeof require === 'function' ? require('./assets.js') : null);
  const CODES = ['DECODE_FAILED','IMAGE_TOO_LARGE','ENCODE_FAILED','OUTPUT_FORMAT','IMAGE_TIMEOUT','ZIP_FAILED','FETCH_FAILED', 'FETCH_TIMEOUT', 'EMPTY_MEDIA', 'INVALID_IMAGE', 'INVALID_VIDEO', 'UNSUPPORTED_SOURCE', 'COPY_SIZE_LIMIT', 'TOO_MANY_PARTS', 'STREAM_VIDEO'];
  const count = n => Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 1000000) : 0;
  const PLATFORMS = ['taobao', 'tmall', 'tmallhk'];
  const LAYOUT_WARNINGS = ['main_missing', 'main_guessed', 'sku_missing', 'detail_missing', 'detail_guessed', 'video_missing'];
  // Where each category came from (page data, known layout, guess) and which
  // categories looked broken. Enumerations only; nothing from the page itself.
  function layoutFacts(scan) {
    const sources = {};
    for (const type of ['main', 'sku', 'detail', 'video']) {
      const source = scan.layout?.[type]?.source;
      sources[type] = ['data', 'layout', 'guess', 'none'].includes(source) ? source : 'unknown';
    }
    const warnings = (Array.isArray(scan.layoutWarnings) ? scan.layoutWarnings : []).filter(code => LAYOUT_WARNINGS.includes(code));
    return { sources, warnings: [...new Set(warnings)] };
  }
  function errorCode(error) {
    if (CODES.includes(error?.code)) return error.code;
    if (/^HTTP_[45]\d{2}$/.test(error?.code)) return error.code;
    const http = /\bHTTP (\d{3})\b/.exec(String(error?.message || ''));
    if (http && +http[1] >= 400 && +http[1] <= 599) return 'HTTP_' + http[1];
    return 'FETCH_FAILED';
  }
  function build({ version, platform, downloadPlatform, downloadOutput, scan = {}, items = [], result, queue = {}, filter, output, inspection = {}, feedback = {} } = {}) {
    const categories = { main: 0, sku: 0, detail: 0, video: 0 };
    for (const item of items) if (Object.hasOwn(categories, item.type)) categories[item.type]++;
    const statuses = { queued: 0, running: 0, delivered: 0, partial: 0, failed: 0, review: 0 };
    for (const job of queue.jobs || []) if (Object.hasOwn(statuses, job.status)) statuses[job.status]++;
    const last = result ? Object.fromEntries(['packed','dispatched','unconfirmed','failed','fallbacks','converted','copyFiles','conversionWarnings']
      .map(key => [key, count(result[key]?.length)])) : null;
    if (last) { last.platform = PLATFORMS.includes(downloadPlatform) ? downloadPlatform : 'unknown'; last.output = assets.outputOptions(downloadOutput); }
    if (last) last.issues = [...(result.failed || []), ...(result.conversionWarnings || [])].slice(0, 100).map(entry => ({
      category: Object.hasOwn(categories, entry.target?.type) ? entry.target.type : 'unknown',
      sequence: count(entry.target?.sequence), code: errorCode(entry)
    }));
    return { schemaVersion: 2, extensionVersion: /^\d+(?:\.\d+){1,3}$/.test(version) ? version : '',
      platform: PLATFORMS.includes(platform) ? platform : 'unknown',
      scan: { result: ['settled','cancelled','timeout','failed','running'].includes(scan.scanReason) ? scan.scanReason : 'unknown',
        elapsedMs: count(scan.elapsedMs), counts: categories, layout: layoutFacts(scan),
        supplement: { attempts: count(scan.supplement?.attempts), completed: count(scan.supplement?.completed),
          added: count(scan.supplement?.added), updated: count(scan.supplement?.updated), lastElapsedMs: count(scan.supplement?.lastElapsedMs),
          lastResult: ['completed','WRONG_TAB','PAGE_CHANGED','SCAN_BUSY','CAPTURE_FAILED','CAPTURE_TIMEOUT'].includes(scan.supplement?.lastResult) ? scan.supplement.lastResult : 'none' } },
      lastDownload: last, queueCounts: statuses, filter: assets.filterOptions(filter), output: assets.outputOptions(output),
      inspection: { inspected: count(inspection.inspected), unknown: count(inspection.unknown) },
      feedback: { reason: ['missing_images','video_failed','slow','confusing','price','occasional'].includes(feedback.reason) ? feedback.reason : 'unspecified',
        fileCheck: ['checked_opened','some_failed','no_download'].includes(feedback.fileCheck) ? feedback.fileCheck : 'unchecked', source: 'user_reported' },
      note: '僅包含本側邊欄的技術統計與自願填寫選項。不含商品標題、商品ID、網址、Cookie、序號、API金鑰或原始錯誤訊息；不會自動傳送。檔案可開啟與否由使用者填寫，並非自動驗證。' };
  }
  root.DownloaderDiagnostics = { build, errorCode };
  if (typeof module !== 'undefined') module.exports = root.DownloaderDiagnostics;
})(globalThis);
