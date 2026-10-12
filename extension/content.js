'use strict';
const PLATFORM = DownloaderPlatforms.identify(location.href);
const MAIN_SELECTORS = PLATFORM?.main || [];
const DETAIL_SELECTORS = PLATFORM?.detail || [];
let activeScan = null;

function absoluteUrl(value, allowBlob = false) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), document.baseURI || location.href);
    if (['http:', 'https:'].includes(url.protocol) || (allowBlob && url.protocol === 'blob:')) return url.href;
  } catch (_) { /* Ignore a malformed source without stopping the scan. */ }
  return null;
}
function cleanUrl(value) {
  const absolute = absoluteUrl(value);
  if (!absolute) return null;
  const url = new URL(absolute);
  // Resize rewrites apply only to Ali's CDN paths. Preserve queries (including
  // signatures), and keep the actual source as a fallback if the rewrite fails.
  if (url.hostname === 'alicdn.com' || url.hostname.endsWith('.alicdn.com')) {
    url.pathname = url.pathname.replace(/(\.(?:jpe?g|png|gif|webp|avif|heic))_(?:\d+x\d+|q\d+|sum|\.(?:webp|avif|heic|jpe?g)).*$/i, '$1');
  }
  return url.href;
}
// The same picture appears on several Ali hosts and paths (img/gw, imgextra or
// bao/uploaded). Its file name identifies it.
function assetKey(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'alicdn.com' || parsed.hostname.endsWith('.alicdn.com')) {
      // A gallery thumbnail may name a crop of the same file ("…~crop,100,0,600,800~…").
      const name = parsed.pathname.split('/').pop().replace(/~crop,[\d,]+~/i, '');
      if (/^(?:O1CN|TB)[\w~,.!-]+$/.test(name)) return 'ali:' + name;
    }
  } catch (_) { /* Fall through to the full address. */ }
  return url;
}
// Lazy-load stand-ins and platform-wide pictures (price notes, icons) are not
// seller material: 2×2 placeholders, spacer GIFs and "!!6000000…-tps-W-H" files.
// Also any "-tps-W-H" platform asset, and icon-sized files named by their size
// ("…-48-48.png": tab icons such as 视频 or 3D next to the gallery).
function placeholderUrl(value) {
  if (/\/(?:grey|spacer|blank|s)\.(?:gif|png)(?:[?#]|$)/i.test(value) || /!!6000000\d+-\d+-tps-\d+-\d+\./.test(value)) return true;
  if (/-tps-\d+-\d+\.(?:png|gif|jpe?g|webp|svg)/i.test(value)) return true;
  const size = String(value).match(/[-_](\d{1,4})-(\d{1,4})\.(?:png|gif|jpe?g|webp|svg)(?:[_?#]|$)/i);
  return !!size && Number(size[1]) <= 120 && Number(size[2]) <= 120;
}
// Things that can sit in the main-image data or gallery but are not pictures:
// empty entries, video files and data: URIs.
function notAPicture(value) {
  if (typeof value !== 'string' || !value.trim() || /^data:/i.test(value.trim())) return true;
  try { return /\.(?:mp4|m3u8|mov|webm|flv)(?:$|[?#])/i.test(new URL(value.trim(), location.href).pathname); }
  catch (_) { return true; }
}
// Gallery tabs that are not pictures (视频, 3D, 参数…) carry an icon or a cover, not a main image.
function galleryTab(img) {
  for (let el = img.parentElement, depth = 0; el && depth < 6; el = el.parentElement, depth++) {
    if (PLATFORM?.mainRoots && el.matches?.(PLATFORM.mainRoots)) return false;
    if (/(?:video|3d|play|icon|other)/i.test(String(el.className || ''))) return true;
  }
  return false;
}
function isJunk(img) {
  const tokens = ['reviews', 'j_reviews', 'tm-rate', 'rate-grid', 'kg-rate', 'recommend', 'guessyoulike', 'guess-you-like', 'guesslike', 'guess-like', 'related-items', 'footer', 'sidebar', 'tb-shop-search', 'tb-revbd', 'j_usercover', 'avatar'];
  for (let el = img, depth = 0; el && depth < 12; el = el.parentElement, depth++) {
    const text = (String(el.id || '') + ' ' + String(el.className || '')).toLowerCase();
    // Product galleries can sit inside a product/detail header. Only exclude
    // site navigation headers, not every ancestor containing "header".
    if (tokens.some(token => text.includes(token)) || /(?:^|\s)(?:header|site-header|global-header|site-nav)(?:\s|$)/.test(text)) return true;
  }
  return false;
}
function imageSources(img) {
  const lazy = ['data-src', 'data-original', 'data-lazy-src', 'data-ks-lazyload', 'data-lazyload', 'data-lazyload-src'].map(name => img.getAttribute(name));
  const responsive = [img.getAttribute('data-lazy-srcset'), img.getAttribute('data-srcset'), img.getAttribute('srcset')];
  if (img.parentElement?.tagName === 'PICTURE') for (const source of img.parentElement.querySelectorAll('source')) {
    responsive.push(source.getAttribute('data-srcset'), source.getAttribute('srcset'));
  }
  const srcset = responsive.filter(Boolean).join(',').split(',').map(part => {
    const match = part.trim().match(/^(\S+)\s+(\d+(?:\.\d+)?)[wx]$/);
    return match ? { url: match[1], size: Number(match[2]) } : null;
  }).filter(Boolean).sort((a, b) => b.size - a.size).map(item => item.url);
  return [...new Set([...lazy, ...srcset, img.currentSrc, img.src].map(value => absoluteUrl(value)).filter(value =>
    value && !placeholderUrl(value)))];
}
// Server data embedded in the page (main images, style images with names and
// IDs, main video). Read once per page; null when the page has none.
let pageDataCache;
function pageData() {
  if (pageDataCache === undefined) {
    try { pageDataCache = PLATFORM && globalThis.DownloaderPageData ? DownloaderPageData.read(document, PLATFORM.id) : null; }
    catch (_) { pageDataCache = null; }
  }
  return pageDataCache;
}
function productRegions() { return [PLATFORM?.mainRoots, ...DETAIL_SELECTORS].filter(Boolean).join(', '); }
function inMainRegion(node) { return !!PLATFORM?.mainRoots && !!node.closest?.(PLATFORM.mainRoots); }
// Live-stream and promotion players float over the page with position: fixed.
function floating(node) {
  for (let el = node, depth = 0; el && depth < 15; el = el.parentElement, depth++) {
    try { if (getComputedStyle(el)?.position === 'fixed') return true; } catch (_) { return false; }
  }
  return false;
}
// Product ID behind a link, for Taobao/Tmall item pages only.
function linkedProductId(href) {
  try {
    const url = new URL(href, document.baseURI || location.href);
    if (!['taobao.com', 'tmall.com', 'tmall.hk'].some(h => url.hostname === h || url.hostname.endsWith('.' + h))) return '';
    const id = url.searchParams.get('id');
    if (/\/(?:item|detail)\.htm[l]?$/.test(url.pathname) && /^\d{1,30}$/.test(id || '')) return id;
    return url.pathname.match(/^\/i(\d{1,30})\.htm$/)?.[1] || '';
  } catch (_) { return ''; }
}
// A description picture wrapped by, or overlaid with, a link to a different
// product is a promotion poster for that product.
function linksToOtherProduct(img) {
  const anchors = [img.closest?.('a[href]'), ...(img.closest?.('.descV8-singleImage')?.querySelectorAll('a[href]') || [])];
  return anchors.some(a => { const id = a && linkedProductId(a.getAttribute('href')); return !!id && id !== PLATFORM?.id; });
}
const reviewVideo = url => /\/play\/u\/null\//.test(url);
function videoKey(src) { return src.match(/^https?:\/\/cloud\.video\.taobao\.com\/.*\/(\d+)\.(?:mp4|m3u8)(?:[?#]|$)/)?.[1] || src; }
function collectVideos(extent) {
  const results = [], seen = new Set();
  const add = (value, poster, source) => {
    const src = absoluteUrl(value, true);
    if (!src || reviewVideo(src) || seen.has(videoKey(src))) return;
    seen.add(videoKey(src)); results.push({ type: 'video', src, poster: absoluteUrl(poster), source });
  };
  const data = pageData();
  for (const video of data?.videos || []) add(video.src, video.poster, 'data');
  const regions = productRegions();
  // Only the main-image area and the description; never reviews, live windows or ads.
  const usable = el => !!regions && !!el.closest?.(regions) && !isJunk(el) && !beyondProduct(el, extent) && !floating(el);
  document.querySelectorAll(PLATFORM?.video || 'video').forEach(video => {
    if (!usable(video)) return;
    // currentSrc is the source the player actually selected, including <source>.
    const src = video.currentSrc || video.src || video.querySelector('source')?.src;
    // The gallery player streams the same main video that the page data names.
    if (String(src || '').startsWith('blob:') && data?.videos?.length && inMainRegion(video)) return;
    add(src, video.poster || video.getAttribute('poster'), 'layout');
  });
  document.querySelectorAll(PLATFORM?.videoLinks || '[class*="video"]').forEach(el => {
    if (!usable(el)) return;
    el.querySelectorAll('a[href*=".mp4"]').forEach(a => add(a.href, null, 'layout'));
  });
  return results;
}
function createCollector() {
  const images = new Map(), videos = new Map(), skus = new Map();
  let ordinal = 0, revision = 0;
  function put(key, entry) {
    const current = images.get(key);
    if (!current) { images.set(key, { ...entry, ordinal: ordinal++ }); revision++; return; }
    current.fallbackUrls = [...new Set([...current.fallbackUrls, ...entry.fallbackUrls])].filter(u => u !== current.url).slice(0, 3);
    if (entry.otherProduct && !current.otherProduct) { current.otherProduct = true; revision++; }
    if (entry.priority > current.priority || (entry.priority === current.priority && entry.type === 'main' && current.type !== 'main')) {
      current.type = entry.type; current.priority = entry.priority; current.source = entry.source; revision++;
    }
  }
  function addImage(img, type, explicit, extent) {
    if (isJunk(img) || beyondProduct(img, extent)) return;
    if (type === 'detail' && PLATFORM?.detailExclude && img.closest?.(PLATFORM.detailExclude)) return;
    if (type === 'main' && explicit && galleryTab(img)) return;
    const sources = imageSources(img), url = cleanUrl(sources[0]);
    if (!url) return;
    const rect = img.getBoundingClientRect();
    const top = rect.top + window.scrollY;
    const width = img.naturalWidth || 0;
    if (type === 'main' && !explicit && !(top < 900 && width > 300 && img.naturalHeight > 300)) return;
    const loadedSource = absoluteUrl(img.currentSrc || img.src);
    // A tiny loaded placeholder must not suppress the separate full-size lazy
    // source. Continue to reject genuinely small loaded decoration images.
    const smallLoadedDetail = width > 0 && width < 300 && sources[0] === loadedSource;
    if (type === 'detail' && (explicit ? smallLoadedDetail : !(top > 1000 && width > 400))) return;
    const fallbackUrls = [...new Set(sources)].filter(source => source !== url).slice(0, 3);
    const otherProduct = type === 'detail' && linksToOtherProduct(img);
    put(assetKey(url), { url, type, fallbackUrls, top, priority: explicit ? 2 : 1, source: explicit ? 'layout' : 'guess', otherProduct });
  }
  function addSku(item, source) {
    const key = assetKey(item.url), current = skus.get(key);
    if (!current) { skus.set(key, { ...item, source }); revision++; return; }
    const labels = [...new Set([...current.labels, ...item.labels])];
    const variantIds = [...new Set([...current.variantIds, ...item.variantIds])];
    if (labels.length !== current.labels.length || variantIds.length !== current.variantIds.length) revision++;
    current.labels = labels; current.variantIds = variantIds;
    for (const variant of item.variants) {
      // A page-data entry already names this option; on-screen text adds nothing.
      if (current.variants.some(v => v.id === variant.id && (v.label === variant.label || !variant.label))) continue;
      const unnamed = current.variants.find(v => v.id === variant.id && !v.label);
      if (unnamed) unnamed.label = variant.label; else current.variants.push(variant);
      revision++;
    }
    current.fallbackUrls = [...new Set([...current.fallbackUrls, item.url, ...item.fallbackUrls])].filter(u => u !== current.url).slice(0, 3);
  }
  function sample() {
    const extent = productExtent();
    const data = pageData();
    // A crop of a picture that is also listed whole is the same picture: keep the whole one, in its place.
    const wholeKeys = new Set((data?.main || []).filter(url => typeof url === 'string' && !/~crop,/i.test(url)).map(url => assetKey(cleanUrl(url) || url)));
    for (const url of data?.main || []) {
      // Page data can also list empty entries, video files or placeholder pictures.
      if (notAPicture(url) || placeholderUrl(url)) continue;
      if (/~crop,/i.test(url) && wholeKeys.has(assetKey(cleanUrl(url) || url))) continue;
      const clean = cleanUrl(url);
      if (clean) put(assetKey(clean), { url: clean, type: 'main', fallbackUrls: [], top: 0, priority: 3, source: 'data', otherProduct: false });
    }
    for (const item of data?.skus || []) {
      const clean = cleanUrl(item.url);
      if (clean) addSku({ ...item, url: clean, labels: [...item.labels], variantIds: [...item.variantIds], variants: item.variants.map(v => ({ ...v })) }, 'data');
    }
    const sku = DownloaderSku.collect({ document, sourcesOf: imageSources, normalizeUrl: cleanUrl,
      isJunk: node => isJunk(node) || beyondProduct(node, extent), adapter: PLATFORM || DownloaderPlatforms.TAOBAO,
      mapVariantId: data ? data.variantIdOf : undefined });
    sku.items.forEach(item => addSku(item, 'layout'));
    const explicitMain = new Set(), explicitDetail = new Set();
    MAIN_SELECTORS.forEach(selector => document.querySelectorAll(selector).forEach(img => explicitMain.add(img)));
    if (!explicitMain.size && !data?.main?.length) (PLATFORM?.mainFallback || []).forEach(selector =>
      document.querySelectorAll(selector).forEach(img => explicitMain.add(img)));
    DETAIL_SELECTORS.forEach(selector => document.querySelectorAll(selector).forEach(container =>
      container.querySelectorAll('img').forEach(img => explicitDetail.add(img))));
    explicitMain.forEach(img => addImage(img, 'main', true, extent));
    for (const selector of PLATFORM?.backgrounds || []) document.querySelectorAll(selector).forEach(el => {
      if (isJunk(el)) return;
      let urls = [];
      try { urls = DownloaderSku.backgroundUrls(getComputedStyle(el).backgroundImage); } catch (_) { return; }
      for (const src of urls) addImage({ src, currentSrc: '', parentElement: el, naturalWidth: 0,
        getAttribute: () => null, getBoundingClientRect: () => el.getBoundingClientRect() }, 'main', true, extent);
    });
    explicitDetail.forEach(img => addImage(img, 'detail', true, extent));
    const foundMain = [...images.values()].some(item => item.type === 'main' && item.priority >= 2);
    const foundDetail = [...images.values()].some(item => item.type === 'detail' && item.priority >= 2);
    if (PLATFORM?.fallbackImages && (!foundMain || !foundDetail)) document.querySelectorAll('img').forEach(img => {
      if (explicitMain.has(img) || explicitDetail.has(img) || sku.elements.has(img)) return;
      if (!foundMain) addImage(img, 'main', false, extent);
      if (!foundDetail) addImage(img, 'detail', false, extent);
    });
    collectVideos(extent).forEach(video => {
      if (!videos.has(videoKey(video.src))) { videos.set(videoKey(video.src), video); revision++; }
    });
  }
  function kept() {
    const values = [...images.values()];
    // Once an explicit product container appears, drop speculative matches
    // outside it for that category; virtualized explicit images stay retained.
    const hasMain = values.some(i => i.type === 'main' && i.priority >= 2);
    const hasDetail = values.some(i => i.type === 'detail' && i.priority >= 2);
    const extent = productExtent();
    const filtered = values.filter(i => i.priority >= 2 || ((!extent.bounded || i.top < extent.height) &&
      !skus.has(assetKey(i.url)) && !(i.type === 'main' ? hasMain : hasDetail)));
    filtered.sort((a, b) => (a.type === 'main' ? 0 : 1) - (b.type === 'main' ? 0 : 1) ||
      (a.type === 'detail' ? a.top - b.top : 0) || a.ordinal - b.ordinal);
    return filtered;
  }
  function items() {
    const clean = kept().map(({ top, ordinal, priority, source, otherProduct, ...item }) => otherProduct ? { ...item, otherProduct: true } : item);
    const skuItems = [...skus.values()].map(({ source, ...item }) => item);
    const videoItems = [...videos.values()].map(({ source, ...item }) => item);
    return [...videoItems, ...clean.filter(i => i.type === 'main'), ...skuItems, ...clean.filter(i => i.type === 'detail')];
  }
  // Where each category came from: page data, known layout, or a guess.
  function sources() {
    const pick = list => list.some(s => s === 'data') ? 'data' : list.some(s => s === 'layout') ? 'layout' : list.length ? 'guess' : 'none';
    const values = kept();
    return { main: pick(values.filter(i => i.type === 'main').map(i => i.source)), sku: pick([...skus.values()].map(i => i.source)),
      detail: pick(values.filter(i => i.type === 'detail').map(i => i.source)), video: pick([...videos.values()].map(i => i.source)) };
  }
  return { sample, items, sources, get revision() { return revision; } };
}
// Whether the page visibly has each section, so a zero result can be flagged.
function sectionsPresent() {
  const any = selectors => selectors.some(selector => [...document.querySelectorAll(selector)].some(node => !isJunk(node)));
  const data = pageData();
  const skuImages = (PLATFORM?.sku || []).some(selector => [...document.querySelectorAll(selector)].some(row =>
    !isJunk(row) && [...(row.querySelectorAll?.('img') || [])].length > 0));
  const videoTab = [...document.querySelectorAll(PLATFORM?.videoTabs || '[class*="switchTabsItem--"]')]
    .some(tab => /视频|視頻|影片|video/i.test(tab.textContent || ''));
  return {
    main: !!data?.main?.length || any([PLATFORM?.mainRoots].filter(Boolean)),
    sku: !!data?.skus?.length || skuImages,
    detail: DETAIL_SELECTORS.some(selector => [...document.querySelectorAll(selector)].some(node => !isJunk(node) && documentBox(node))),
    video: !!data?.videos?.length || videoTab
  };
}
// Separate verdict per category: a guessed result, or nothing found although the
// page clearly shows that section, means the page layout may have changed.
function layoutReport(collector, data) {
  const present = sectionsPresent(), sources = collector.sources(), layout = {}, warnings = [];
  for (const type of ['main', 'sku', 'detail', 'video']) {
    const count = data.filter(item => item.type === type).length;
    layout[type] = { count, source: sources[type], present: present[type] };
    if (!count && present[type]) warnings.push(type + '_missing');
    else if (count && sources[type] === 'guess') warnings.push(type + '_guessed');
  }
  return { layout, warnings };
}
// For the optional anonymous layout notice: the stable "name" part of the page's
// "name--hash" class names around the sections that looked broken (at most 20).
// Only ASCII code names; never text, addresses, ids or attributes from the page.
function layoutClassPrefixes(types) {
  const names = new Set();
  const add = node => {
    const value = typeof node?.className === 'string' ? node.className : node?.className?.baseVal || '';
    for (const token of value.split(/\s+/)) {
      const match = /^([A-Za-z][A-Za-z0-9_]{0,39})--/.exec(token);
      if (match && names.size < 20) names.add(match[1]);
    }
  };
  const near = root => {
    for (let node = root, depth = 0; node && depth < 6; node = node.parentElement, depth++) add(node);
    const queue = [[root, 0]];
    for (let seen = 0; queue.length && seen < 300 && names.size < 20; seen++) {
      const [node, depth] = queue.shift(); add(node);
      if (depth < 3) for (const child of node.children || []) queue.push([child, depth + 1]);
    }
  };
  const regions = { main: PLATFORM?.mainRoots, video: PLATFORM?.mainRoots, sku: (PLATFORM?.sku || []).join(', '), detail: DETAIL_SELECTORS.join(', ') };
  for (const type of types) {
    if (!regions[type]) continue;
    try { for (const root of [...document.querySelectorAll(regions[type])].slice(0, 3)) near(root); } catch (_) { /* invalid selector list */ }
  }
  // Nothing recognised (or a guessed section): fall back to the first named blocks on the page.
  if (!names.size) for (const node of [...document.querySelectorAll('[class*="--"]')].slice(0, 400)) add(node);
  return [...names];
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function pageHeight() { return Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0); }
function documentBox(node) {
  if (typeof node?.getBoundingClientRect !== 'function') return null;
  const rect = node.getBoundingClientRect();
  if (![rect.top, rect.bottom, rect.width].every(Number.isFinite) || rect.width <= 0 || rect.bottom <= rect.top) return null;
  return { top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY, width: rect.width };
}
function productExtent() {
  const page = pageHeight(), roots = new Set();
  let detailEnd = 0, detailMediaEnd = 0, mainEnd = 0;
  for (const selector of DETAIL_SELECTORS) {
    for (const node of document.querySelectorAll(selector)) {
      if (roots.has(node) || isJunk(node)) continue;
      const box = documentBox(node);
      if (!box) continue;
      roots.add(node); detailEnd = Math.max(detailEnd, box.bottom);
      for (const img of node.querySelectorAll('img')) {
        if (!isJunk(img)) detailMediaEnd = Math.max(detailMediaEnd, documentBox(img)?.bottom || 0);
      }
    }
  }
  for (const selector of MAIN_SELECTORS) {
    for (const node of document.querySelectorAll(selector)) {
      if (!isJunk(node)) mainEnd = Math.max(mainEnd, documentBox(node)?.bottom || 0);
    }
  }
  // A wide recommendation section below the product is a boundary. Sidebars,
  // top-page carousels and sections before the description must not truncate it.
  let recommendationStart = Infinity;
  for (const selector of ['[class*="recommend" i]', '[id*="recommend" i]', '[class*="guessyoulike" i]', '[id*="guessyoulike" i]',
    '[class*="guesslike" i]', '[id*="guesslike" i]', '[class*="guess-like" i]']) {
    for (const node of document.querySelectorAll(selector)) {
      const box = documentBox(node);
      if (!box || box.top < Math.max(1000, mainEnd) ||
          box.width < Math.min(320, (window.innerWidth || 1024) * 0.6)) continue;
      if (detailEnd) {
        if ([...roots].some(root => node.contains?.(root))) continue;
        const insideDetail = [...roots].some(root => root.contains?.(node));
        if (box.top < (insideDetail ? detailMediaEnd : detailEnd) - 3) continue;
      }
      recommendationStart = Math.min(recommendationStart, box.top);
    }
  }
  const height = Math.min(page, detailEnd || Infinity, recommendationStart);
  return { height, bounded: !!detailEnd || Number.isFinite(recommendationStart) };
}
function beyondProduct(node, extent) {
  if (!extent?.bounded || typeof node?.getBoundingClientRect !== 'function') return false;
  const top = node.getBoundingClientRect().top + window.scrollY;
  return Number.isFinite(top) && top >= extent.height;
}
function pendingVisibleImages(extent = productExtent()) {
  return [...document.querySelectorAll('img')].some(img => {
    if (isJunk(img) || beyondProduct(img, extent) || img.complete !== false) return false;
    const rect = img.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0;
  });
}
function scanState() {
  return activeScan ? { running: true, id: activeScan.id, count: activeScan.collector.items().length,
    elapsedMs: Date.now() - activeScan.startedAt } : { running: false };
}
// Choosing a style rewrites the address (&skuId=…) without changing the product.
const sameProductPage = url => !!PLATFORM && DownloaderPlatforms.identify(url)?.productKey === PLATFORM.productKey;
function collectLoadedMedia(expectedUrl) {
  if (activeScan) return { success: false, code: 'SCAN_BUSY' };
  const initialUrl = location.href;
  if (!sameProductPage(initialUrl) || !sameProductPage(expectedUrl)) return { success: false, code: 'PAGE_CHANGED' };
  try {
    const collector = createCollector();
    collector.sample();
    if (!sameProductPage(location.href)) return { success: false, code: 'PAGE_CHANGED' };
    // A single synchronous snapshot: do not move the page, start playback,
    // change a SKU, or claim that all lazy content has loaded.
    return { success: true, data: collector.items(), pageUrl: initialUrl };
  } catch (_) { return { success: false, code: 'CAPTURE_FAILED' }; }
}
async function runTaobaoScan(sendResponse, scanId = '') {
  if (!sameProductPage(location.href)) { sendResponse({ success: false, msg: '請開啟受支援的商品詳情頁；切換商品後請重新整理。' }); return; }
  if (activeScan) { sendResponse({ success: false, msg: '已有掃描正在進行，請等待或先停止。' }); return; }
  const startX = window.scrollX || 0, startY = window.scrollY || 0;
  const collector = createCollector();
  const scan = { id: scanId, collector, startedAt: Date.now(), cancelled: false, manual: false };
  activeScan = scan;
  const manualStop = event => {
    if (event.type === 'keydown' && !['ArrowDown','ArrowUp','PageDown','PageUp','Home','End',' '].includes(event.key)) return;
    if (event.isTrusted) { scan.cancelled = true; scan.manual = true; }
  };
  ['wheel', 'touchstart', 'keydown'].forEach(event => window.addEventListener(event, manualStop, { passive: true }));
  const root = document.scrollingElement || document.documentElement;
  const oldScrollBehavior = root.style?.getPropertyValue('scroll-behavior') || '';
  const oldPriority = root.style?.getPropertyPriority('scroll-behavior') || '';
  root.style?.setProperty('scroll-behavior', 'auto', 'important');
  let response;
  try {
    collector.sample();
    window.scrollTo(0, 0);
    await pause(300);
    let stableSince = Date.now(), lastHeight = productExtent().height, lastRevision = collector.revision;
    let complete = false;
    while (!scan.cancelled && Date.now() - scan.startedAt < 60000) {
      if (!sameProductPage(location.href)) throw new Error('商品頁面已切換，請重新掃描。');
      collector.sample();
      const extent = productExtent(), height = extent.height, viewport = window.innerHeight || 600;
      const atBottom = window.scrollY + viewport >= height - 3;
      if (height !== lastHeight || collector.revision !== lastRevision) stableSince = Date.now();
      lastHeight = height; lastRevision = collector.revision;
      if (atBottom && !pendingVisibleImages(extent) && Date.now() - stableSince >= 1500) { complete = true; break; }
      if (!atBottom) {
        stableSince = Date.now();
        const step = Math.min(600, Math.max(200, Math.floor(viewport * 0.7)));
        window.scrollBy(0, Math.min(step, Math.max(0, height - viewport - window.scrollY)));
      }
      await pause(200);
      // Allow visible images time to settle, but never let one broken resource
      // stall the page forever. Deferred URLs are collected even before decode.
      for (let waited = 0; pendingVisibleImages() && waited < 1000 && !scan.cancelled; waited += 100) {
        collector.sample(); await pause(100);
      }
    }
    if (!sameProductPage(location.href)) throw new Error('商品頁面已切換，請重新掃描。');
    collector.sample();
    const data = collector.items();
    const reason = scan.cancelled ? 'cancelled' : complete ? 'settled' : 'timeout';
    const { layout, warnings: layoutWarnings } = layoutReport(collector, data);
    const warnings = [];
    if (reason === 'cancelled') warnings.push('已停止掃描；目前顯示已收集的項目，可能尚未完整。');
    if (reason === 'timeout') warnings.push('已達 60 秒掃描上限；目前顯示已收集的項目，可能尚未完整。');
    if (!data.some(item => item.type === 'video') && !layoutWarnings.includes('video_missing')) warnings.push('未偵測到可用影片網址；若商品有影片，請先播放再重新掃描。');
    const recognised = [...MAIN_SELECTORS, ...DETAIL_SELECTORS, ...(PLATFORM?.sku || [])]
      .some(selector => [...document.querySelectorAll(selector)].some(node => !isJunk(node)));
    const visibleImages = [...document.querySelectorAll('img')].filter(img => !isJunk(img) &&
      imageSources(img).length && documentBox(img) && (img.naturalWidth || 0) >= 120).length;
    const code = data.length ? '' : !recognised && visibleImages ? 'LAYOUT_UNRECOGNIZED' : 'IMAGES_NOT_READY';
    const brokenTypes = [...new Set(layoutWarnings.map(code => code.split('_')[0]))];
    const layoutClasses = brokenTypes.length || code === 'LAYOUT_UNRECOGNIZED' ? layoutClassPrefixes(brokenTypes) : [];
    response = { success: data.length > 0, data, title: document.title || '',
      msg: reason === 'cancelled' ? '已停止掃描，尚未取得商品圖片。' : '沒有取得商品圖片，請確認商品已載入、需要時先登入或展開詳情。',
      scan: { reason, code, elapsedMs: Date.now() - scan.startedAt, count: data.length, warnings, layout, layoutWarnings, layoutClasses } };
  } catch (error) {
    response = { success: false, msg: error.message || '掃描中斷，請重新整理商品頁後再試。' };
  } finally {
    ['wheel', 'touchstart', 'keydown'].forEach(event => window.removeEventListener(event, manualStop));
    if (sameProductPage(location.href) && !scan.manual) window.scrollTo(startX, startY);
    if (oldScrollBehavior) root.style?.setProperty('scroll-behavior', oldScrollBehavior, oldPriority);
    else root.style?.removeProperty('scroll-behavior');
    activeScan = null;
  }
  sendResponse(response);
}
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (req.action === 'collectLoadedMedia') { sendResponse(collectLoadedMedia(req.pageUrl)); return; }
  if (req.action === 'scan') { runTaobaoScan(sendResponse, req.scanId || ''); return true; }
  if (req.action === 'scanStatus') { sendResponse(scanState()); return; }
  if (req.action === 'cancelScan') {
    if (activeScan && (!req.scanId || req.scanId === activeScan.id)) activeScan.cancelled = true;
    sendResponse({ ok: true });
  }
});
