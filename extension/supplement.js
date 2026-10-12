'use strict';
(function (root) {
  const platforms = root.DownloaderPlatforms || (typeof require === 'function' ? require('./platforms.js') : null);
  const TYPES = ['main', 'sku', 'detail', 'video'];
  const MAX_ITEMS = 2000;
  const failure = (code, message) => Object.assign(new Error(message), { code });
  function url(value, video = false) {
    if (typeof value !== 'string') return null;
    try {
      const u = new URL(value);
      return (['https:', 'http:'].includes(u.protocol) || (video && u.protocol === 'blob:')) && !u.username && !u.password ? u.href : null;
    } catch (_) { return null; }
  }
  function key(item) {
    if (!TYPES.includes(item?.type)) return '';
    const source = url(item.type === 'video' ? item.src || item.url : item.url, item.type === 'video');
    return source ? item.type + '\n' + source : '';
  }
  const strings = values => [...new Set((Array.isArray(values) ? values : []).filter(v => typeof v === 'string' && v.trim()).map(v => v.slice(0, 120)))].slice(0, 100);
  function clean(item) {
    if (!key(item)) return null;
    if (item.type === 'video') return { type: 'video', src: url(item.src || item.url, true), poster: url(item.poster) };
    const variants = [];
    for (const v of Array.isArray(item.variants) ? item.variants : []) {
      const id = typeof v?.id === 'string' ? v.id.slice(0, 120) : '';
      const label = typeof v?.label === 'string' ? v.label.slice(0, 120) : '';
      if ((id || label) && !variants.some(v => v.id === id && v.label === label)) variants.push({ id, label });
      if (variants.length >= 100) break;
    }
    const source = url(item.url);
    const result = { type: item.type, url: source, labels: strings(item.labels), variantIds: strings(item.variantIds), variants,
      fallbackUrls: [...new Set((Array.isArray(item.fallbackUrls) ? item.fallbackUrls : []).map(v => url(v)).filter(v => v && v !== source))].slice(0, 3) };
    // A description poster that links to a different product stays marked.
    if (item.type === 'detail' && item.otherProduct === true) result.otherProduct = true;
    return result;
  }
  function merge(existing, incoming, maxItems = MAX_ITEMS) {
    const items = existing.map(item => ({ ...item }));
    const byKey = new Map(items.map((item, i) => [key(item), i]));
    const added = new Set(), updated = new Set();
    const limit = Math.max(items.length, maxItems);
    let skipped = 0;
    for (const value of incoming) {
      const item = clean(value);
      if (!item) { skipped++; continue; }
      const id = key(item), index = byKey.get(id);
      if (index == null) {
        if (items.length >= limit) { skipped++; continue; }
        byKey.set(id, items.length); items.push(item); added.add(id); continue;
      }
      const old = items[index];
      let next;
      if (item.type === 'video') next = { ...old, poster: item.poster || old.poster || null };
      else {
        const previous = clean(old);
        next = { ...old, labels: strings([...previous.labels, ...item.labels]), variantIds: strings([...previous.variantIds, ...item.variantIds]),
          variants: [...previous.variants], ...(previous.otherProduct || item.otherProduct ? { otherProduct: true } : {}),
          // Prefer currently observed alternatives; the primary source never changes.
          fallbackUrls: [...new Set([...item.fallbackUrls, ...previous.fallbackUrls])].slice(0, 3) };
        for (const v of item.variants) if (next.variants.length < 100 && !next.variants.some(x => x.id === v.id && x.label === v.label)) next.variants.push(v);
      }
      if (JSON.stringify(clean(next)) !== JSON.stringify(clean(old))) {
        items[index] = next; if (!added.has(id)) updated.add(id);
      }
    }
    return { items, added: [...added], updated: [...updated], skipped };
  }
  async function capture({ chrome, source, timeoutMs = 10000 }) {
    const expected = { ...source };
    const product = platforms.identify(expected.pageUrl);
    if (!product || !expected.documentToken || expected.tabId == null) throw failure('PAGE_CHANGED', '請先掃描商品，再使用補抓。');
    const sameDocument = context => context?.ok && context.documentToken === expected.documentToken &&
      platforms.identify(context.pageUrl)?.productKey === product.productKey;
    async function checkTab() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== expected.tabId || platforms.identify(tab?.url)?.productKey !== product.productKey) {
        throw failure('WRONG_TAB', '目前分頁不是原本掃描的商品。請切回原分頁再補抓，或對新商品重新掃描。');
      }
    }
    // The asynchronous task only reads data. A late response after timeout
    // cannot commit changes to the panel.
    const task = (async () => {
      await checkTab();
      const before = await chrome.tabs.sendMessage(expected.tabId, { action: 'mediaContext' });
      if (!sameDocument(before)) throw failure('PAGE_CHANGED', '原商品頁已重新載入或切換，請重新掃描；舊清單仍保留。');
      const result = await chrome.tabs.sendMessage(expected.tabId, { action: 'collectLoadedMedia', pageUrl: before.pageUrl });
      if (!result?.success || !Array.isArray(result.data)) {
        if (result?.code === 'SCAN_BUSY') throw failure('SCAN_BUSY', '商品頁正在掃描，請等掃描結束後再補抓。');
        if (result?.code === 'PAGE_CHANGED') throw failure('PAGE_CHANGED', '補抓期間商品頁已變更，請確認原頁後再試。');
        throw failure('CAPTURE_FAILED', '未能取得補抓結果。請確認商品頁可正常查看，舊清單仍保留。');
      }
      const after = await chrome.tabs.sendMessage(expected.tabId, { action: 'mediaContext' });
      // Choosing a style adds &skuId=… to the address; the product must stay the same.
      if (!sameDocument(after) || !platforms.sameProduct(after.pageUrl, before.pageUrl) || !platforms.sameProduct(result.pageUrl, before.pageUrl)) {
        throw failure('PAGE_CHANGED', '補抓期間商品頁已變更，這次結果沒有加入；請確認原頁後再試。');
      }
      await checkTab();
      return { data: result.data, context: after };
    })();
    let timer;
    try {
      return await Promise.race([task, new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('CAPTURE_TIMEOUT', '補抓回應逾時，舊清單仍保留。請確認商品頁後再試。')), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  root.DownloaderSupplement = { key, merge, capture, MAX_ITEMS };
  if (typeof module !== 'undefined') module.exports = root.DownloaderSupplement;
})(globalThis);
