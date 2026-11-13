/* Passive page-world observer. It does not call APIs, read cookies, or bypass verification. */
(() => {
  if (window.__SHOP_SKU_OBSERVER__) return;
  Object.defineProperty(window, '__SHOP_SKU_OBSERVER__', {value: true});
  const buffer = [];
  Object.defineProperty(window, '__SHOP_SKU_CAPTURE__', {value: buffer, configurable: true});
  const matches = url => /(?:mtop\.(?:taobao|tmall)\.(?:pcdetail|detail)|mtop\.alibaba\.detail)/i.test(String(url)) && !/getdesc|recommend|rate|review/i.test(String(url));
  const itemIdFromRequest = (url, body) => {
    try {
      const parsed = new URL(String(url), location.href);
      let data = parsed.searchParams.get('data');
      if (!data && typeof body === 'string') data = new URLSearchParams(body).get('data') || body;
      const value = data ? JSON.parse(data) : {};
      const id = value.itemId || value.id || value.itemNumId || value.numIid;
      return /^\d+$/.test(String(id ?? '')) ? String(id) : '';
    } catch { return ''; }
  };
  const trimPayload = payload => {
    const pieces = [];
    const seen = new WeakSet();
    let walked = 0;
    const visit = (value, depth = 0, inheritedId = '') => {
      if (++walked > 15000 || depth > 16) return;
      if (typeof value === 'string' && value.length < 3000000 && /^[\s]*[\[{]/.test(value)) {
        try { value = JSON.parse(value); } catch { return; }
      }
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      const itemId = String(value.item?.itemId || value.itemDO?.itemId || value.itemInfo?.itemId || value.itemId || inheritedId || '');
      if (value.skuBase || value.skuCore || value.valItemInfo || value.item || value.itemDO || value.seller || value.sku2info) {
        const piece = {itemId};
        for (const key of ['skuBase', 'skuCore', 'valItemInfo', 'sku2info']) if (value[key]) piece[key] = value[key];
        for (const key of ['item', 'itemDO', 'itemInfo']) if (value[key] && typeof value[key] === 'object') {
          const src = value[key];
          piece[key] = {};
          for (const field of ['itemId', 'id', 'numIid', 'title', 'name', 'itemName', 'images', 'picUrl', 'image']) if (src[field] !== undefined) piece[key][field] = src[field];
        }
        if (value.seller && typeof value.seller === 'object') {
          piece.seller = {};
          for (const key of ['shopId', 'userId', 'sellerId', 'sellerUid', 'shopName']) if (value.seller[key] !== undefined) piece.seller[key] = value.seller[key];
        }
        pieces.push(piece);
      }
      for (const [key, child] of Object.entries(value).slice(0, 5000)) {
        if (/^(?:skuBase|skuCore|sku2info|valItemInfo|item|itemDO|itemInfo|seller|buyer|userInfo|address|delivery|rate|review|itemList|itemsList|auctionList|auctions|shopItems)$/i.test(key) || /recommend|related|guess|crossShop|otherItems|hotItems|ranking/i.test(key)) continue;
        if (child && typeof child === 'object' || typeof child === 'string' && /^(?:value|data)$/.test(key)) visit(child, depth + 1, itemId);
      }
    };
    visit(payload);
    return pieces;
  };
  const capture = (payload, url, requestId = '') => {
    try {
      if (typeof payload === 'string') {
        if (payload.length > 4000000) return;
        payload = JSON.parse(payload);
      }
      const pieces = trimPayload(payload);
      if (!pieces.length) return;
      const data = {pieces};
      if (JSON.stringify(data).length > 3000000) return;
      buffer.push({itemId: requestId, data, capturedAt: Date.now()});
      if (buffer.length > 12) buffer.splice(0, buffer.length - 12);
    } catch {}
  };
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const requestURL = typeof args[0] === 'string' || args[0] instanceof URL ? String(args[0]) : args[0]?.url || '';
      const promise = Reflect.apply(originalFetch, this, args);
      if (matches(requestURL)) {
        promise.then(response => {
          try {
            if (!response.ok || Number(response.headers.get('content-length') || 0) > 4000000) return;
            response.clone().text().then(text => capture(text, requestURL, itemIdFromRequest(requestURL, args[1]?.body))).catch(() => {});
          } catch {}
        }, () => {});
      }
      return promise;
    };
  }
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const xhrMeta = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    xhrMeta.set(this, {url: String(url)});
    return Reflect.apply(originalOpen, this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const meta = xhrMeta.get(this);
    if (meta && matches(meta.url)) {
      meta.itemId = itemIdFromRequest(meta.url, body);
      this.addEventListener('load', () => {
        try {
          if (this.status >= 200 && this.status < 300) capture(this.responseType === 'json' ? this.response : this.responseText, meta.url, meta.itemId);
        } catch {}
      }, {once: true});
    }
    return Reflect.apply(originalSend, this, [body]);
  };
  const hooked = new WeakSet();
  const hookJSONP = script => {
    if (!(script instanceof HTMLScriptElement) || !matches(script.src)) return;
    try {
      const parsed = new URL(script.src, location.href);
      const callback = parsed.searchParams.get('callback');
      if (!callback || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callback) || callback.split('.').some(p => ['__proto__', 'prototype', 'constructor'].includes(p))) return;
      const parts = callback.split('.');
      let owner = window;
      for (const key of parts.slice(0, -1)) { owner = owner[key]; if (!owner) return; }
      const key = parts[parts.length - 1];
      const original = owner[key];
      if (typeof original !== 'function' || hooked.has(original)) return;
      const wrapped = function (...args) {
        capture(args[0], script.src, itemIdFromRequest(script.src));
        return Reflect.apply(original, this, args);
      };
      hooked.add(wrapped);
      owner[key] = wrapped;
    } catch {}
  };
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') hookJSONP(record.target);
      for (const node of record.addedNodes || []) {
        if (node.nodeType !== 1) continue;
        hookJSONP(node);
        node.querySelectorAll?.('script[src]').forEach(hookJSONP);
      }
    }
  }).observe(document, {subtree: true, childList: true, attributes: true, attributeFilter: ['src']});
})();
