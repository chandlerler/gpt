'use strict';
(function () {
  const el = id => document.getElementById(id);
  const bind = (id, key, args = []) => DownloaderI18n.bind(el(id), 'textContent', () => DownloaderI18n.t(key, args));
  const accessibleItems = new WeakSet();
  function sync() {
    const hasMedia = currentImages.length > 0;
    document.body.dataset.mediaReady = String(hasMedia && !scanInProgress);
    const busy = downloadInProgress || scanInProgress || isQueueRunning() || isAssetInspectionRunning();
    const selected = selectedVisible().length;
    const visibleItems = [...document.querySelectorAll('.image-item, .img-box')].filter(node => !node.hidden);
    const visible = visibleItems.length;
    el('mediaWelcome').hidden = hasMedia || scanInProgress;
    el('welcomeShortcuts').hidden = hasMedia || scanInProgress;
    el('mediaFilter').hidden = !hasMedia || scanInProgress;
    el('filterEmpty').hidden = !hasMedia || visible > 0 || scanInProgress;
    el('filterSummary').hidden = !hasMedia || visible === currentImages.length || scanInProgress;
    bind('filterSummaryText', 'v5_filterSummary', [visible, currentImages.length]);
    el('clearActiveFilter').disabled = busy;
    el('quickFilterReset').disabled = busy;
    el('mediaTools').hidden = !hasMedia || scanInProgress;
    el('moreMediaTools').hidden = !hasMedia || scanInProgress;
    el('downloadDock').hidden = !hasMedia || scanInProgress;
    el('backToMedia').hidden = !hasMedia && el('backToMedia').dataset.jump !== 'queueTitle';
    el('bookScanHint').hidden = hasMedia;
    el('noSelectionHint').hidden = !hasMedia || selected > 0 || busy;
    el('scanBtn').dataset.rescan = String(hasMedia && !scanInProgress);
    bind('scanBtn', hasMedia && !scanInProgress ? 'ux_rescanGo' : 'm_7298362020');
    for (const id of ['selectAllBtn', 'deselectAllBtn', 'selectionMode']) el(id).disabled = busy;
    bind('selectionCount', 'ux_selected', [selected, visible]);
    for (const item of document.querySelectorAll('.image-item')) {
      if (!accessibleItems.has(item)) {
        accessibleItems.add(item);
        item.setAttribute('role', 'checkbox');
        item.tabIndex = 0;
        DownloaderI18n.bind(item, 'aria-label', () => {
          const key = { main: 'item_main', sku: 'item_sku', detail: 'item_detail', video: 'item_video' }[item.dataset.type] || 'item_detail';
          const labels = JSON.parse(item.dataset.labels || '[]');
          return DownloaderI18n.t(key) + ' ' + item.dataset.sequence + (labels.length ? ' ' + labels.join(' / ') : '');
        });
        item.addEventListener('keydown', event => {
          if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); item.click(); }
        });
      }
      item.setAttribute('aria-checked', String(item.classList.contains('selected')));
      item.setAttribute('aria-disabled', String(busy));
    }
    const format = el('outputFormat').value;
    el('copyOptionsRow').hidden = format === 'original';
    el('settingsOutputFormat').value = format;
    el('settingsOutputFormat').disabled = el('outputFormat').disabled;
    el('outputSummary').disabled = busy;
    el('zipBtn').hidden = false;
    for (const [id, type] of [['mainGrid','main'], ['skuGrid','sku'], ['detailGrid','detail'], ['videoGrid','video']]) {
      const grid = el(id);
      const empty = !visibleItems.some(item => item.dataset.type === type);
      grid.hidden = empty;
      if (grid.previousElementSibling?.classList.contains('category-title')) grid.previousElementSibling.hidden = empty;
    }
    window.DownloaderImagePreview?.sync();
    window.DownloaderQueueUI?.syncSummary();
  }
  el('selectionMode').addEventListener('change', () => {
    const id = { main: 'selectMainBtn', sku: 'selectSkuBtn', detail: 'selectDetailBtn', video: 'selectVideoBtn' }[el('selectionMode').value];
    if (id) el(id).click();
    el('selectionMode').value = '';
    sync();
  });
  for (const id of ['outputFormat', 'downloadPreset']) el(id).addEventListener('change', sync);
  el('settingsOutputFormat').addEventListener('change', () => {
    if (el('outputFormat').disabled) { sync(); return; }
    el('outputFormat').value = el('settingsOutputFormat').value;
    el('outputFormat').dispatchEvent(new Event('change', { bubbles: true }));
    sync();
  });
  window.DownloaderFlowUI = { sync };
  el('quickFilterReset').addEventListener('click', () => el('filterReset').click());
  el('clearActiveFilter').addEventListener('click', () => el('filterReset').click());
  el('filterDone').addEventListener('click', () => {
    el('mediaFilter').open = false;
    window.DownloaderWorkspaceUI?.openSection('selectionCount');
  });
  sync();
})();
