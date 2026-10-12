'use strict';
(function (root) {
  const platforms = root.DownloaderPlatforms || (typeof require === 'function' ? require('./platforms.js') : null);
  const recovery = root.DownloaderRecovery || (typeof require === 'function' ? require('./recovery.js') : null);
  const optionalSites = () => root.DownloaderOptionalSites;
  function targetsFrom(items, categories) {
    const counts = { main: 0, sku: 0, detail: 0, video: 0 };
    // Description posters that link to another product start unselected in the
    // single-product view; the batch skips them the same way.
    return items.filter(i => Object.hasOwn(counts, i.type) && !(i.type === 'detail' && i.otherProduct === true)).map((item, index) => ({
      type: item.type, url: item.type === 'video' ? item.src : item.url,
      sequence: ++counts[item.type], index,
      labels: item.labels || [], variants: item.variants || [], fallbackUrls: item.fallbackUrls || []
    })).filter(item => categories.includes(item.type) && typeof item.url === 'string');
  }
  const paused = () => Object.assign(new Error(''), { code: 'PAUSED' });
  // Every message to a product tab is bounded: a frozen or discarded tab never
  // answers, and an unanswered message must not hold the queue forever.
  function askTab(chrome, tabId, message, ms, signal, timeoutMessage) {
    return bounded(() => chrome.tabs.sendMessage(tabId, message), ms, signal, timeoutMessage);
  }
  function bounded(task, ms, signal, timeoutMessage = '商品頁沒有及時回應，這次尚無可確認的結果。請確認原頁可正常顯示，再重新掃描。') {
    if (signal?.aborted) return Promise.reject(paused());
    let timer, onAbort;
    return Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(timeoutMessage), { code: 'TAB_TIMEOUT' })), ms);
        onAbort = () => reject(paused());
        signal?.addEventListener('abort', onAbort, { once: true });
      })
    ]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); });
  }
  function createProcessor({ chrome, download, onProgress = () => {}, timeoutMs = 75000, messageTimeoutMs = 15000 }) {
    let signal = null;
    // A Tmall Global tab opened before the customer allowed tmall.hk has no
    // content script; add it (once) instead of failing with Chrome's own error.
    async function prepareTab(job) {
      const sites = optionalSites();
      if (!sites || platforms.identify(job.url)?.key !== 'tmallhk') return;
      if (!(await bounded(() => sites.granted(chrome), messageTimeoutMs, signal).catch(error => { if (error.code === 'PAUSED') throw error; return false; }))) {
        throw new Error('這個天貓國際商品還沒允許讀取。請切到該分頁，在「下載素材」按掃描，再按「允許天貓國際」。');
      }
      try { await bounded(() => sites.ensureInjected(chrome, job.tabId), messageTimeoutMs, signal); }
      catch (error) {
        if (error.code === 'PAUSED') throw error;
        throw new Error('還沒連上這個天貓國際商品頁，請重新整理該分頁後再按掃描。');
      }
    }
    // A closed tab rejects with Chrome's own English text; say it plainly instead.
    const LOST = '原商品分頁已切換或未載入，請重新開啟商品並加入佇列以更新分頁。';
    const plainTabError = error => ['PAUSED', 'TAB_TIMEOUT'].includes(error?.code) ? error : new Error(LOST);
    async function contextFor(job) {
      const context = await askTab(chrome, job.tabId, { action: 'mediaContext' }, messageTimeoutMs, signal).catch(error => { throw plainTabError(error); });
      if (!context?.ok || !context.documentToken || platforms.identify(context.pageUrl)?.productKey !== job.productKey) {
        throw new Error(LOST);
      }
      return context;
    }
    async function scan(job) {
      const scanId = 'queue-' + job.id + '-' + job.attempts;
      try { return await askTab(chrome, job.tabId, { action: 'scan', scanId }, timeoutMs, signal, '掃描回應逾時，請先開啟商品分頁確認載入狀態。'); }
      catch (error) {
        Promise.resolve().then(() => chrome.tabs.sendMessage(job.tabId, { action: 'cancelScan', scanId })).catch(() => {});
        throw plainTabError(error);
      }
    }
    // signal: aborted when the user presses pause. Before downloading starts the
    // product goes back to the queue; a download already under way is finished.
    return async function process(job, pauseSignal = null) {
      signal = pauseSignal;
      await prepareTab(job);
      const current = await contextFor(job);
      let snapshot = job.retry;
      if (snapshot) {
        if (!platforms.samePage(snapshot.context, current)) {
          return { status: 'partial', message: '原頁已重新載入；保留失敗清單。可按重新掃描，但可能重複下載先前成功的檔案。', retry: snapshot };
        }
      } else {
        onProgress(job, '掃描商品中…');
        const result = await scan(job);
        // A page-side exception may be English; only the page's own Chinese message is kept.
        const pageMessage = /[㐀-鿿]/.test(String(result?.msg || '')) ? result.msg : '沒有取得商品素材。';
        if (!result?.success) throw new Error(pageMessage + ' 請確認商品可正常查看，必要時登入；展開詳情或播放影片後重試。');
        const after = await contextFor(job);
        if (!platforms.samePage(current, after)) throw new Error('掃描期間原商品頁面已變更，未開始下載。');
        if (result.scan?.reason !== 'settled') return { status: 'failed', message: '掃描未完整結束，尚未下載。請確認商品頁後重試。' };
        const targets = targetsFrom(result.data, job.categories);
        if (!targets.length) throw new Error('沒有找到所選分類的素材，請確認商品內容與分類設定；若要抓影片，先在原頁播放後重試。');
        if (targets.length > 1000) throw new Error('單一商品素材超過 1000 項，請改用單頁預覽挑選下載。');
        snapshot = { context: current, title: result.title || job.title, targets,
          scannedAt: new Date().toISOString(), scanReason: result.scan.reason, output: job.output };
      }
      // Check the page again at the actual download boundary.
      if (signal?.aborted) throw paused();
      const beforeDownload = await contextFor(job);
      if (!platforms.samePage(beforeDownload, snapshot.context)) throw new Error('原商品頁面已變更，未開始下載。');
      const result = await download({ targets: snapshot.targets, source: { ...snapshot.context, tabId: job.tabId },
        title: snapshot.title, output: snapshot.output || job.output, scanInfo: { scannedAt: snapshot.scannedAt, scanReason: snapshot.scanReason }, retry: !!job.retry,
        onProgress: (done, total) => onProgress(job, `取得素材 ${done} / ${total}…`) });
      const failed = result.failed.map(entry => entry.target);
      const delivered = result.packed.length + result.dispatched.length;
      const copyWarnings = (result.conversionWarnings?.length || 0) + (snapshot.copyWarningCount || 0);
      const warnings = result.unconfirmed.length + (snapshot.unconfirmedCount || 0);
      const status = failed.length ? (delivered || warnings ? 'partial' : 'failed') : (warnings || copyWarnings) ? 'review' : 'delivered';
      // Counts of zero are left out (each part is its own translated sentence).
      const messages = [];
      if (result.packed.length) messages.push(`本次 ZIP 內 ${result.packed.length} 項。`);
      if (result.dispatched.length) messages.push(`另有 ${result.dispatched.length} 項由商品頁下載。`);
      if (failed.length) messages.push(`${failed.length} 項沒有下載成功。`);
      if (warnings) messages.push(`${warnings} 部影片已觸發，請確認 Chrome 下載清單。`);
      if (result.converted?.length) messages.push(`已另存 ${result.copyFiles?.length ?? result.converted.length} 張上架副本（來自 ${result.converted.length} 張圖片）。`);
      if (copyWarnings) messages.push(`${copyWarnings} 張圖片的副本失敗，原檔已保留；重新掃描會重抓原檔。`);
      if (result.fallbacks?.length) messages.push(`${result.fallbacks.length} 項使用頁面備援圖片，請確認解析度。`);
      // Plain reasons, the same words as a single-product download; never raw codes like "HTTP 403".
      for (const sentence of new Set(result.failed.map(recovery.sentence))) messages.push(sentence);
      messages.push(...recovery.forResult(result));
      return { status, title: snapshot.title, message: messages.join(' '),
        retry: failed.length ? { ...snapshot, targets: failed, unconfirmedCount: warnings, copyWarningCount: copyWarnings } : null };
    };
  }
  root.DownloaderQueueWorker = { targetsFrom, createProcessor, askTab };
  if (typeof module !== 'undefined') module.exports = root.DownloaderQueueWorker;
})(globalThis);
