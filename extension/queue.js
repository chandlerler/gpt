'use strict';
(function (root) {
  const platforms = root.DownloaderPlatforms || (typeof require === 'function' ? require('./platforms.js') : null);
  const assets = root.DownloaderAssets || (typeof require === 'function' ? require('./assets.js') : null);
  const STORAGE_KEY = 'productDownloadQueueV1', BACKUP_KEY = 'productDownloadQueueV1Backup';
  const RUN_LOCK = 'product-downloader-runner-v1', WRITE_LOCK = 'product-downloader-queue-write-v1';
  const MAX_JOBS = 30;
  const LABELS = { queued: '等待處理', running: '處理中', delivered: '已下載', partial: '部分失敗', failed: '失敗', review: '請確認結果', unsupported: '平台已停用' };
  function createManager({ storage, locks, randomId = () => crypto.randomUUID(), pausePollMs = 1000 }) {
    const usable = j => !!j && typeof j === 'object' && !!LABELS[j.status] && !!platforms.identifyStored(j.url) &&
      typeof j.id === 'string' && Array.isArray(j.categories);
    async function read() {
      const value = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
      if (!value) return { version: 1, pauseRequested: true, jobs: [] };
      if (value.version !== 1 || !Array.isArray(value.jobs)) throw new Error('佇列紀錄無法讀取，請聯絡客服。');
      // One damaged entry must not lock the whole list: skip it, keep the rest,
      // and keep an untouched copy of the original for support.
      const kept = value.jobs.filter(usable).slice(0, MAX_JOBS);
      if (kept.length !== value.jobs.length) {
        try { await storage.set({ [BACKUP_KEY]: { savedAt: new Date().toISOString(), value } }); } catch (_) { /* best effort */ }
      }
      const result = structuredClone({ ...value, jobs: kept });
      for (const job of result.jobs) if (!platforms.identify(job.url)) {
        job.status = 'unsupported'; job.message = '此平台已停止支援，可移除這筆待辦。';
        delete job.retry;
      }
      return result;
    }
    function requireLocks() { if (!locks?.request) throw new Error('目前瀏覽器不支援安全的佇列互斥，請更新桌機 Chrome。'); }
    async function mutate(change) {
      requireLocks();
      return locks.request(WRITE_LOCK, async () => {
        const state = await read();
        const result = change(state);
        if (new TextEncoder().encode(JSON.stringify(state)).length > 2000000) throw new Error('佇列資料過大，請先移除已完成商品。');
        await storage.set({ [STORAGE_KEY]: state });
        return { state, result };
      });
    }
    async function exclusive(task) {
      requireLocks();
      return locks.request(RUN_LOCK, { ifAvailable: true }, async lock => {
        if (!lock) return { acquired: false };
        return { acquired: true, value: await task() };
      });
    }
    function recoverState(state) {
      for (const job of state.jobs) if (job.status === 'running') {
        job.status = 'review'; job.message = '上次處理中斷，請先核對 Chrome 下載清單。需要重做時按「重新掃描」，可能產生重複檔案。';
        delete job.retry;
      }
    }
    async function recover() {
      await exclusive(() => mutate(state => { recoverState(state); state.pauseRequested = true; }));
      return read();
    }
    // A job stays "running" in storage when the panel that ran it was closed.
    // Only the runner lock proves someone is still working on it.
    async function recoverIfOrphaned() {
      const state = await read();
      if (!state.jobs.some(j => j.status === 'running') || typeof locks?.query !== 'function') return null;
      const snapshot = await locks.query();
      if ((snapshot?.held || []).some(lock => lock.name === RUN_LOCK)) return null;
      return recover();
    }
    async function add(tabs, categories = ['main', 'sku', 'detail', 'video'], output = {}) {
      const types = [...new Set(categories)].filter(t => ['main','sku','detail','video'].includes(t));
      if (!types.length) throw new Error('請至少選擇一種素材分類。');
      return mutate(state => {
        let added = 0, duplicates = 0, skipped = 0;
        for (const tab of tabs) {
          const product = platforms.identify(tab.url);
          if (!product || !Number.isSafeInteger(tab.id)) { skipped++; continue; }
          const existing = state.jobs.find(j => j.productKey === product.productKey);
          if (existing) { if (existing.status !== 'running') existing.tabId = tab.id; duplicates++; continue; }
          if (state.jobs.length >= MAX_JOBS) { skipped++; continue; }
          state.jobs.push({ id: randomId(), productKey: product.productKey, platform: product.key, url: product.url,
            tabId: tab.id, title: String(tab.title || `${product.name} ${product.id}`).slice(0, 300),
            categories: types, output: assets.outputOptions(output), status: 'queued', attempts: 0, message: '' });
          added++;
        }
        return { added, duplicates, skipped };
      });
    }
    const pause = () => mutate(state => { state.pauseRequested = true; });
    const remove = id => mutate(state => { state.jobs = state.jobs.filter(j => j.id !== id || j.status === 'running'); });
    const clearDelivered = () => mutate(state => { state.jobs = state.jobs.filter(j => j.status !== 'delivered'); });
    async function retry(id, rescan = false) {
      return mutate(state => {
        const job = state.jobs.find(j => j.id === id);
        if (!job || !['failed','partial','review'].includes(job.status)) throw new Error('這筆商品目前不能重試。');
        if (job.status === 'review' && !rescan) throw new Error('請先確認下載結果，再決定是否重新掃描。');
        if (rescan) delete job.retry;
        job.status = 'queued'; job.message = rescan ? '將重新掃描，可能與先前下載重複。' : '等待重試失敗項目。';
      });
    }
    async function run(process, onChange = () => {}) {
      return exclusive(async () => {
        await mutate(state => { recoverState(state); state.pauseRequested = false; });
        try {
          while (true) {
            const selected = await mutate(state => {
              if (state.pauseRequested) return null;
              const job = state.jobs.find(j => j.status === 'queued');
              if (!job) return null;
              job.status = 'running'; job.attempts++; job.message = job.retry ? '重試失敗素材中…' : '掃描商品中…';
              return structuredClone(job);
            });
            onChange(selected.state);
            const job = selected.result;
            if (!job) break;
            let outcome;
            // Pause is a storage flag that another panel may set; watch it so a
            // product still waiting on its tab can be interrupted.
            const controller = new AbortController();
            const watcher = setInterval(() => {
              read().then(state => { if (state.pauseRequested) controller.abort(); }).catch(() => {});
            }, pausePollMs);
            try { outcome = await process(job, controller.signal); }
            catch (error) {
              if (error.code === 'PAUSED') outcome = { status: 'queued', message: '', pause: true, retry: job.retry };
              else outcome = { status: 'failed',
                message: error.message || '無法處理商品，請確認原分頁仍開啟。', pause: false, retry: job.retry };
            } finally { clearInterval(watcher); }
            // A storage failure after dispatch must leave running -> review on
            // recovery, never silently requeue media that may have been saved.
            const saved = await mutate(state => {
              const current = state.jobs.find(j => j.id === job.id);
              if (!current || current.status !== 'running') throw new Error('佇列狀態已變更，請重新開啟側邊欄。');
              if (!['queued','delivered','partial','failed','review'].includes(outcome.status)) throw new Error('無法辨識下載結果。');
              current.status = outcome.status; current.message = String(outcome.message || '').slice(0, 1000);
              if (outcome.title) current.title = String(outcome.title).slice(0, 300);
              if (outcome.retry?.targets?.length) current.retry = outcome.retry; else delete current.retry;
              if (outcome.pause) state.pauseRequested = true;
            });
            onChange(saved.state);
          }
        } finally {
          const stopped = await pause(); onChange(stopped.state);
        }
        return read();
      });
    }
    return { read, recover, recoverIfOrphaned, add, pause, remove, clearDelivered, retry, run, exclusive };
  }
  root.DownloaderQueue = { createManager, STORAGE_KEY, BACKUP_KEY, MAX_JOBS, LABELS, RUN_LOCK, WRITE_LOCK };
  if (typeof module !== 'undefined') module.exports = root.DownloaderQueue;
})(globalThis);
