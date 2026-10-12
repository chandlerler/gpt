'use strict';
(function () {
  // The same page can receive these scripts twice (registered for tmall.hk and
  // injected by hand while it was loading). A second copy would answer every
  // message again with a different token.
  if (globalThis.__downloaderMediaBridge) return;
  globalThis.__downloaderMediaBridge = true;
  const documentToken = crypto.randomUUID();
  // Only an address the page cannot hand back as a file is a stream: a player fed
  // by MediaSource (or a blob the page already released) makes fetch() reject
  // with a TypeError. Timeouts, empty files and non-video data keep their own
  // reason so the result and the support report say what really happened.
  function readFailure(error) {
    if (typeof error?.code === 'string' && error.code) return { ok: false, code: error.code, error: error.message };
    if (error?.name === 'TypeError') return { ok: false, code: 'STREAM_VIDEO', error: '這支影片是串流，無法保存。' };
    return { ok: false, code: 'FETCH_FAILED', error: error?.message || '影片讀取失敗' };
  }
  // Choosing a style adds &skuId=… to the address; that is still the same page.
  const samePage = url => globalThis.DownloaderPlatforms ? DownloaderPlatforms.sameProduct(url, location.href) : url === location.href;
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (request.action === 'mediaContext') {
      sendResponse({ ok: true, documentToken, pageUrl: location.href });
      return;
    }
    if (request.action !== 'downloadBlobMedia') return;
    (async () => {
      if (request.documentToken !== documentToken || !samePage(request.pageUrl)) {
        throw new Error('商品頁面已變更，請重新掃描');
      }
      if (typeof request.url !== 'string' || !request.url.startsWith('blob:' + location.origin + '/')) {
        throw new Error('影片不屬於原商品頁面，請重新掃描');
      }
      const product = globalThis.DownloaderPlatforms?.identify(location.href);
      if (globalThis.DownloaderPlatforms && !product) throw new Error('請在淘寶或天貓商品詳情頁使用此功能。');
      const prefix = product ? `${product.key}_${product.id}_video` : 'taobao_video';
      let media;
      try {
        media = await DownloaderMedia.fetchMedia(request.url, 'video', fetch, true);
      } catch (error) {
        return readFailure(error);
      }
      const url = URL.createObjectURL(media.blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        const sequence = Number.isSafeInteger(request.sequence) && request.sequence > 0 ? request.sequence : Number.isSafeInteger(request.index) ? request.index + 1 : 1;
        a.download = `${prefix}_${sequence}.${media.ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
      return { ok: true, dispatched: true, verified: true };
    })().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
