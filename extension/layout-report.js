'use strict';
// Optional anonymous notice to the developer when a product page was not read
// well (a section that is clearly there came back empty, or had to be guessed).
// Nothing is sent unless the customer presses 通知 for that page. While
// REPORT_ENDPOINT is empty the whole feature stays invisible.
(function (root) {
  // The Google Apps Script web app address ("…/exec"). The only place it is set.
  const REPORT_ENDPOINT = '';
  const PLATFORMS = ['taobao', 'tmall', 'tmallhk'];
  const CODES = ['main_missing', 'main_guessed', 'sku_missing', 'detail_missing', 'detail_guessed', 'video_missing', 'layout_unrecognized'];
  const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
  const ASKED_KEY = 'layoutReportAskedV1';
  const ASKED_LIMIT = 300;
  const localDate = (now = new Date()) => [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  // Everything that leaves the browser is built here, from fixed lists only:
  // no product address, product id, title, key, cookie or picture address.
  function payload({ version, platform, codes = [], classes = [], now = new Date() } = {}) {
    return {
      v: /^\d+(?:\.\d+){1,3}$/.test(String(version)) ? String(version) : '',
      platform: PLATFORMS.includes(platform) ? platform : 'unknown',
      problems: [...new Set(codes)].filter(code => CODES.includes(code))
        .map(code => ({ category: code === 'layout_unrecognized' ? 'page' : code.split('_')[0], code })),
      classes: [...new Set(classes)].filter(name => typeof name === 'string' && CLASS_NAME.test(name)).slice(0, 20),
      date: localDate(now)
    };
  }
  // A plain-text POST without CORS: no extra permission and no cookies. The
  // answer cannot be read, so "sent" means the request left without a network error.
  async function send(body, { endpoint = REPORT_ENDPOINT, fetchFn = root.fetch } = {}) {
    if (!endpoint) throw new Error('disabled');
    await fetchFn(endpoint, { method: 'POST', mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
  }
  // Same product and same problem are asked about once. Kept only in this browser.
  async function unasked(storage, productKey, codes) {
    try {
      const asked = new Set((await storage.get(ASKED_KEY))?.[ASKED_KEY] || []);
      return codes.filter(code => !asked.has(productKey + '|' + code));
    } catch (_) { return codes; }
  }
  async function remember(storage, productKey, codes) {
    try {
      const list = ((await storage.get(ASKED_KEY))?.[ASKED_KEY] || []).filter(item => typeof item === 'string');
      for (const code of codes) if (!list.includes(productKey + '|' + code)) list.push(productKey + '|' + code);
      await storage.set({ [ASKED_KEY]: list.slice(-ASKED_LIMIT) });
    } catch (_) { /* Asking again later is harmless. */ }
  }
  const api = { payload, send, unasked, remember, CODES, ASKED_KEY, get enabled() { return !!REPORT_ENDPOINT; } };
  root.DownloaderLayoutReport = api;
  if (typeof module !== 'undefined') module.exports = api;

  // Panel part: a question inside the layout warning, never a pop-up.
  const doc = root.document;
  const box = doc?.getElementById?.('layoutReport');
  if (!box) return;
  const el = id => doc.getElementById(id);
  const I = root.DownloaderI18n;
  let current = null, round = 0;
  function reset() {
    round++; current = null;
    box.hidden = true;
    for (const id of ['layoutReportAsk', 'layoutReportActions', 'layoutReportDetails']) el(id).hidden = false;
    el('layoutReportDetails').open = false;
    el('layoutReportStatus').hidden = true;
    I.clear(el('layoutReportStatus'), 'textContent');
  }
  async function offer({ productKey, platform, codes, classes, version }) {
    reset();
    if (!api.enabled || !productKey || !root.chrome?.storage?.local) return;
    const mine = round;
    const open = await unasked(root.chrome.storage.local, productKey, payload({ codes }).problems.map(p => p.code));
    if (mine !== round || !open.length) return;
    current = { productKey, codes: open, body: payload({ version, platform, codes: open, classes }) };
    el('layoutReportPreview').textContent = JSON.stringify(current.body, null, 2);
    // Names the problem itself ("variant pictures were missed"), so "this page" is never read as sending the address.
    const names = open.map(code => 'warn_' + code);
    I.bind(el('layoutReportAsk'), 'textContent', () => I.t('report_ask', [names.map(key => I.t(key)).join(I.locale === 'en' ? ', ' : '、')]));
    box.hidden = false;
    el('scanWarning').hidden = false;
  }
  // After pressing Notify the whole question becomes one line. The answer of a no-cors
  // request cannot be read, so it says "sent", never "the developer was notified".
  function finish(key) {
    for (const id of ['layoutReportAsk', 'layoutReportActions', 'layoutReportDetails']) el(id).hidden = true;
    I.bind(el('layoutReportStatus'), 'textContent', () => I.t(key));
    el('layoutReportStatus').hidden = false;
    root.keepAboveDock?.(el('scanWarning'));
  }
  el('layoutReportSend').addEventListener('click', async () => {
    if (!current) return;
    const { productKey, codes, body } = current; current = null;
    el('layoutReportSend').disabled = el('layoutReportSkip').disabled = true;
    remember(root.chrome.storage.local, productKey, codes);
    try { await send(body); finish('report_sent'); }
    catch (_) { finish('report_failed'); }
    finally { el('layoutReportSend').disabled = el('layoutReportSkip').disabled = false; }
  });
  el('layoutReportSkip').addEventListener('click', () => {
    if (!current) return;
    remember(root.chrome.storage.local, current.productKey, current.codes);
    current = null;
    box.hidden = true;
    // The warning box stays only if it still has a warning in it.
    if (!el('scanNote').textContent) el('scanWarning').hidden = true;
  });
  root.DownloaderLayoutReportUI = { offer, reset };
})(globalThis);
