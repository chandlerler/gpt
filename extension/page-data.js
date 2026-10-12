'use strict';
(function (root) {
  // Taobao/Tmall 2025+ pages embed their server data in an inline script:
  //   window.__ICE_APP_CONTEXT__ = {... loaderData.home.data.res ...}
  // A content script cannot see page variables, so this reads the script's text,
  // cuts out the JSON object and parses it. Page code is never executed and no
  // request is made. Pages without the data fall back to the on-screen layout.
  const MAX_TEXT = 8 * 1024 * 1024;
  function objectAt(text, start) {
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    return null;
  }
  // Only look after the first mention of the variable, and try at most a few
  // candidates: each attempt reads to the end of the object (or of the text), so
  // trying every candidate would grow with the square of the script size.
  const MAX_CANDIDATES = 3;
  function parse(text) {
    if (typeof text !== 'string' || text.length > MAX_TEXT) return null;
    const at = text.indexOf('__ICE_APP_CONTEXT__');
    if (at < 0) return null;
    const pattern = /\{\s*"(?:appData|loaderData)"\s*:/g;
    pattern.lastIndex = at;
    for (let tries = 0, match; tries < MAX_CANDIDATES && (match = pattern.exec(text)); tries++) {
      const json = objectAt(text, match.index);
      if (!json) continue;
      try {
        const data = JSON.parse(json);
        const loaders = data?.loaderData && typeof data.loaderData === 'object' ? Object.values(data.loaderData) : [];
        const res = data?.loaderData?.home?.data?.res || loaders.map(l => l?.data?.res).find(r => r?.item);
        if (res?.item) return res;
      } catch (_) { /* Not JSON; try the next candidate. */ }
    }
    return null;
  }
  const httpsUrl = value => {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.trim(), 'https://item.taobao.com/');
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      url.protocol = 'https:';
      return url.href;
    } catch (_) { return null; }
  };
  // Buyer-show videos from reviews carry a "/play/u/null/" path.
  const reviewVideo = url => /\/play\/u\/null\//.test(url);
  const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  // Returns the product's own media, or null when the page has no usable data or
  // the data cannot be tied to this product: its item ID must equal the address's id.
  function extract(res, itemId) {
    if (!res?.item) return null;
    const id = String(res.item.itemId ?? '');
    if (!id || id !== String(itemId ?? '')) return null;
    const list = value => Array.isArray(value) ? value : [];
    // The gallery the page shows comes from componentsVO.headImageVO. item.images can still
    // list pictures the seller deleted long ago; those answer with a 1×1 transparent pixel
    // (seen on a real page in 2026-10), so they are only a fallback when the gallery data is empty.
    const head = res.componentsVO?.headImageVO;
    const pictureUrl = entry => httpsUrl(typeof entry === 'string' ? entry : entry?.url || entry?.image || entry?.src || entry?.picUrl);
    const pictures = value => [...new Set(list(value).map(pictureUrl).filter(Boolean))];
    const headImages = pictures(head?.images);
    const main = headImages.length ? headImages : pictures(res.item.images);
    // Field names of a gallery video are read loosely; http is upgraded to https.
    const videoOf = video => typeof video === 'string' ? { src: httpsUrl(video), poster: null } :
      { src: httpsUrl(video?.url || video?.videoUrl || video?.videoURL || video?.src),
        poster: httpsUrl(video?.videoThumbnailURL || video?.coverUrl || video?.coverURL || video?.picUrl || video?.thumbnail) };
    const collect = value => {
      const found = [];
      for (const video of list(value).map(videoOf)) {
        if (video.src && !reviewVideo(video.src) && !found.some(v => v.src === video.src)) found.push(video);
      }
      return found;
    };
    const headVideos = collect(head?.videos);
    const videos = headVideos.length ? headVideos : collect(res.item.videos);
    const variants = new Map(), skus = [];
    for (const prop of list(res.skuBase?.props)) {
      for (const value of list(prop?.values)) {
        if (value?.vid == null) continue;
        const variantId = prop?.pid != null ? `${prop.pid}:${value.vid}` : String(value.vid);
        variants.set(String(value.vid), variantId);
        const url = httpsUrl(value.image), label = text(value.name);
        if (!url) continue;
        let item = skus.find(s => s.url === url);
        if (!item) skus.push(item = { url, type: 'sku', labels: [], variantIds: [], variants: [], fallbackUrls: [] });
        if (label && !item.labels.includes(label)) item.labels.push(label);
        if (!item.variantIds.includes(variantId)) item.variantIds.push(variantId);
        if (!item.variants.some(v => v.id === variantId)) item.variants.push({ id: variantId, label });
      }
    }
    return { main, videos, skus, variantIdOf: vid => variants.get(String(vid)) || String(vid) };
  }
  function read(document, itemId) {
    for (const script of document.querySelectorAll('script:not([src])')) {
      const res = parse(script.textContent || '');
      if (res) return extract(res, itemId);
    }
    return null;
  }
  root.DownloaderPageData = { parse, extract, read };
  if (typeof module !== 'undefined') module.exports = root.DownloaderPageData;
})(globalThis);
