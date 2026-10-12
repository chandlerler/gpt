'use strict';
(function () {
  const el = id => document.getElementById(id);
  const nodes = () => Array.from(document.querySelectorAll('.image-item'));
  const keyOfNode = node => DownloaderSupplement.key({ type: node.dataset.type, url: node.dataset.url });
  const busy = () => downloadInProgress || scanInProgress || isQueueRunning() || isAssetInspectionRunning();
  let added = new Set();
  function syncBusy() {
    el('supplementControls').hidden = !currentImages.length || !currentScanContext;
    el('supplementBtn').disabled = busy() || window.DownloaderPreferencesUI?.loading === true;
    const visible = nodes().filter(n => !n.hidden && added.has(keyOfNode(n))).length;
    el('selectAddedBtn').disabled = busy() || !visible;
    DownloaderI18n.bind(el('selectAddedBtn'), 'textContent', () => DownloaderI18n.t('m_f1dee5fe82', [visible, added.size]));
  }
  function markAdded() {
    for (const node of nodes()) {
      if (added.has(keyOfNode(node)) && !node.supplementBadge) {
        const label = document.createElement('span'); label.className = 'supplement-badge'; DownloaderI18n.bind(label, 'textContent', () => DownloaderI18n.t('m_0c384e9376'));
        node.appendChild(label); node.supplementBadge = label;
      }
      if (node.supplementBadge) node.supplementBadge.hidden = !added.has(keyOfNode(node));
    }
  }
  function applyMerge(merged) {
    const existing = new Map(nodes().map(node => [keyOfNode(node), node]));
    const changed = new Set(merged.updated);
    for (const item of merged.items) {
      const node = existing.get(DownloaderSupplement.key(item));
      if (!node || !changed.has(DownloaderSupplement.key(item))) continue;
      if (item.type === 'video') {
        if (item.poster) { node.children[0].src = item.poster; node.children[0].style.display = ''; }
      } else {
        node.dataset.labels = JSON.stringify(item.labels || []);
        node.dataset.variants = JSON.stringify(item.variants || []);
        node.dataset.fallbackUrls = JSON.stringify(item.fallbackUrls || []);
        const label = Array.from(node.children).find(child => child.classList?.contains('sku-label'));
        if (label) {
          DownloaderI18n.bind(label, 'textContent', () => item.labels?.length ? item.labels.join('／') : DownloaderI18n.t('m_49e9e40a8c', [node.dataset.sequence]));
          DownloaderI18n.bind(node, 'title', () => label.textContent);
        }
      }
    }
    const newKeys = new Set(merged.added);
    for (const type of ['video', 'main', 'sku', 'detail']) {
      const before = currentImages.filter(i => i.type === type).length;
      const incoming = merged.items.filter(i => i.type === type && newKeys.has(DownloaderSupplement.key(i)));
      if (incoming.length) {
        if (!before) el(type + 'Grid').innerHTML = '';
        const options = { append: true, offset: before, selected: false };
        if (type === 'video') renderVideoGrid(type + 'Grid', incoming, options);
        else renderGrid(type + 'Grid', incoming, options);
      }
      DownloaderI18n.bind(el(type + 'Count'), 'textContent', () => merged.items.filter(i => i.type === type).length);
    }
    currentImages = merged.items;
    added = newKeys; markAdded();
    window.DownloaderAssetsUI?.refreshFilter();
  }
  function record(outcome, started, merged) {
    const previous = scanInfo.supplement || {};
    scanInfo.supplement = { attempts: (previous.attempts || 0) + 1,
      completed: (previous.completed || 0) + (outcome === 'completed' ? 1 : 0),
      added: (previous.added || 0) + (merged?.added.length || 0),
      updated: (previous.updated || 0) + (merged?.updated.length || 0),
      lastResult: outcome, lastElapsedMs: Math.max(0, Date.now() - started) };
    window.DownloaderSupportUI?.refresh();
  }
  async function supplement() {
    await window.DownloaderPreferencesUI?.ready;
    if (busy() || !currentScanContext || !currentImages.length) return;
    const task = async () => {
      if (busy() || !currentScanContext || !currentImages.length) return;
      const source = { ...currentScanContext, tabId: currentScanTabId };
      scanInProgress = true; updateDownloadBtn(); window.DownloaderQueueUI?.refresh();
      DownloaderI18n.bind(el('supplementStatus'), 'textContent', () => DownloaderI18n.t('m_e6dbc4174c'));
      const started = Date.now();
      try {
        const captured = await DownloaderSupplement.capture({ chrome, source });
        const merged = DownloaderSupplement.merge(currentImages, captured.data);
        applyMerge(merged);
        currentScanContext = captured.context;
        record('completed', started, merged);
        const message = () => DownloaderI18n.t('m_d4e6e84e5e', [merged.added.length, merged.updated.length]) +
          (merged.added.length ? DownloaderI18n.t('m_e5f907d988') : DownloaderI18n.t('m_3a2fcd65d7')) +
          (merged.skipped ? DownloaderI18n.t('m_9212f79429', [merged.skipped, DownloaderSupplement.MAX_ITEMS]) : '') +
          (failedTargets.length ? DownloaderI18n.t('m_757aa40b26') : '');
        DownloaderI18n.bind(el('supplementStatus'), 'textContent', () => message());
        DownloaderI18n.bind(el('status'), 'textContent', () => message());
      } catch (error) {
        const known = ['WRONG_TAB', 'PAGE_CHANGED', 'SCAN_BUSY', 'CAPTURE_FAILED', 'CAPTURE_TIMEOUT'].includes(error.code);
        record(known ? error.code : 'CAPTURE_FAILED', started);
        DownloaderI18n.bind(el('supplementStatus'), 'textContent', () => known ? DownloaderI18n.legacy(error.message) : DownloaderI18n.t('m_0574cf2225'));
      } finally {
        scanInProgress = false; updateDownloadBtn(); window.DownloaderQueueUI?.refresh();
      }
    };
    try {
      if (window.DownloaderQueueUI) {
        const result = await window.DownloaderQueueUI.exclusive(task);
        if (!result.acquired) DownloaderI18n.bind(el('supplementStatus'), 'textContent', () => DownloaderI18n.t('m_3b3f24bb67'));
      } else await task();
    } catch (_) { DownloaderI18n.bind(el('supplementStatus'), 'textContent', () => DownloaderI18n.t('m_1fbee81e45')); }
  }
  el('supplementBtn').addEventListener('click', supplement);
  el('selectAddedBtn').addEventListener('click', () => {
    if (busy() || !nodes().some(node => !node.hidden && added.has(keyOfNode(node)))) return;
    for (const node of nodes()) {
      if (!node.hidden && added.has(keyOfNode(node))) node.classList.add('selected');
      else node.classList.remove('selected');
    }
    updateDownloadBtn();
  });
  window.DownloaderSupplementUI = { syncBusy, reset() { added.clear(); DownloaderI18n.clear(el('supplementStatus'), 'textContent'); syncBusy(); } };
  syncBusy();
})();
