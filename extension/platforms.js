'use strict';
(function (root) {
  // The one place that lists page selectors. Taobao and Tmall desktop pages share
  // one front end (tbpc-pc-detail-ssr-2025) whose classes look like "name--hash";
  // only the "name--" part is stable, so match it with [class*="name--"].
  // Older layouts stay listed after the 2026 ones as a fallback.
  const TAOBAO = {
    key: 'taobao', name: '淘寶', experimental: false, fallbackImages: true,
    // Regions that hold the product's own media. Videos outside them are ignored.
    mainRoots: '#picGalleryEle, [class*="picGallery--"], #J_UlThumb, .tb-thumb, #J_ImgBooth',
    main: ['#picGalleryEle [class*="thumbnails--"] img', 'img[class*="thumbnailPic--"]',
      '#J_UlThumb img', '.tb-thumb img', '#J_ImgBooth'],
    // The large picture shows whichever thumbnail or style is selected, so it is
    // used only when the page has no thumbnails at all.
    mainFallback: ['img#mainPicImageEl', 'img[class*="mainPic--"]'],
    detail: ['#imageTextInfo-content', '.desc-root', '[class*="descV8-container"]',
      '#description', '#J_DivItemDesc', '.content-detail', '.desc-list'],
    // Platform price notes inside the description are not seller material.
    detailExclude: '[class*="descV8-declaration"]',
    // One SKU row (for example "colour"). Each value is an option (valueItemBig-- in
    // large-picture mode); its image wrap also carries data-vid, so [data-vid]
    // alone would select the wrong level.
    sku: ['#skuOptionsArea [class*="skuItem--"]', '.sku-images', '#J_Prop_Color', '.J_TSaleProp', '.tm-sale-prop'],
    options: '[class*="valueItem--"], [class*="valueItemBig--"], [data-value], [data-sku-id], [role="option"], li',
    optionRoots: '[class*="valueItem--"], [class*="valueItemBig--"], [role="option"], li',
    variantAttributes: ['data-value', 'data-sku-id', 'data-vid'],
    label: '[class*="valueItemText--"]',
    skuNodes: 'img, a, button, li, [role="option"], [data-value], [data-sku-id], [style]',
    video: 'video', videoLinks: '[class*="lib-video"], [class*="video-content"], [class*="video"]',
    videoTabs: '[class*="switchTabsItem--"]',
    backgrounds: []
  };
  // Tmall Global needs an optional host permission that the customer grants once.
  const OPTIONAL_SITES = { tmallhk: ['*://*.tmall.hk/*'] };
  const HOSTS = [['taobao.com', 'taobao', '淘寶'], ['tmall.com', 'tmall', '天貓'], ['tmall.hk', 'tmallhk', '天貓國際']];
  function identify(value) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
      const host = HOSTS.find(([h]) => url.hostname === h || url.hostname.endsWith('.' + h));
      if (!host || !/\/(?:item|detail)\.htm[l]?$/.test(url.pathname) || !/^\d{1,30}$/.test(url.searchParams.get('id') || '')) return null;
      const id = url.searchParams.get('id');
      const adapter = host[1] === 'taobao' ? TAOBAO : { ...TAOBAO, key: host[1], name: host[2] };
      const canonical = url.origin + url.pathname + '?id=' + id;
      return { ...adapter, id, url: canonical, productKey: adapter.key + ':' + id };
    } catch (_) { return null; }
  }
  // Choosing a style adds &skuId=… to the address without loading a new page.
  // Two addresses are the same product page when they name the same product.
  function sameProduct(a, b) {
    const first = identify(a), second = identify(b);
    return !!first && !!second && first.productKey === second.productKey;
  }
  // Two page contexts ({documentToken, pageUrl}) are the same loaded page and product.
  function samePage(a, b) {
    return !!a?.documentToken && a.documentToken === b?.documentToken && sameProduct(a.pageUrl, b.pageUrl);
  }
  // Read-only compatibility for records saved before support was retired.
  // Capture, queue admission and media access must always use identify().
  function identifyStored(value) {
    const current = identify(value);
    if (current) return current;
    try {
      const url = new URL(value), match = url.pathname.match(/^\/offer\/(\d{1,30})\.html$/);
      if (!['https:','http:'].includes(url.protocol) || url.hostname !== 'detail.1688.com' ||
          url.username || url.password || url.port || !match) return null;
      return { key: '1688', id: match[1], productKey: '1688:' + match[1], url: url.origin + url.pathname, retired: true };
    } catch (_) { return null; }
  }
  root.DownloaderPlatforms = { identify, identifyStored, sameProduct, samePage, TAOBAO, OPTIONAL_SITES };
  if (typeof module !== 'undefined') module.exports = root.DownloaderPlatforms;
})(globalThis);
