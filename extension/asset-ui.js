'use strict';
(function () {
  const el = id => document.getElementById(id);
  const nodes = () => Array.from(document.querySelectorAll('.image-item'));
  const processor = DownloaderAssets.createProcessor();
  let metadata = new WeakMap(), inspecting = false, stop = false;
  let lastDownload = null, lastPlatform = '', lastOutput = {};
  const busy = () => downloadInProgress || scanInProgress || isQueueRunning() || inspecting;
  const getOutput = () => DownloaderAssets.outputOptions({ format: el('outputFormat').value, maxEdge: el('outputMaxEdge').value, square: el('outputSquare').checked, splitHeight: el('outputSplitHeight').value, maxKB: el('outputMaxKB').value });
  const getFilter = () => DownloaderAssets.filterOptions({ minWidth: el('filterWidth').value, minHeight: el('filterHeight').value,
    format: el('filterFormat').value, includeUnknown: el('filterUnknown').checked });
  function inspectionStats() {
    const images = nodes().filter(n => n.dataset.type !== 'video');
    return { inspected: images.filter(n => metadata.get(n)?.width).length, unknown: images.filter(n => !metadata.get(n)?.width).length };
  }
  function refreshFilter() {
    const all = nodes(), filter = getFilter();
    for (const node of all) node.hidden = !DownloaderAssets.matches(metadata.get(node), filter, node.dataset.type);
    const stats = inspectionStats();
    DownloaderI18n.bind(el('filterStatus'), 'textContent', () => DownloaderI18n.t('m_6d1ac01a2a', [all.filter(n => !n.hidden).length, all.length, stats.unknown]));
    updateDownloadBtn();
  }
  function syncBusy() {
    for (const id of ['filterWidth','filterHeight','filterFormat','filterUnknown','filterReset','outputFormat','outputMaxEdge','outputSquare','outputSplitHeight','outputMaxKB']) el(id).disabled = busy();
    if (!busy()) for (const id of ['outputMaxEdge','outputSquare','outputSplitHeight','outputMaxKB']) el(id).disabled = getOutput().format === 'original';
    el('inspectAssets').disabled = busy() || !nodes().some(n => n.dataset.type !== 'video');
    el('stopInspect').hidden = !inspecting; el('stopInspect').disabled = stop;
    el('scanBtn').disabled = busy();
    window.DownloaderPreferencesUI?.syncBusy();
    window.DownloaderRecoveryUI?.syncBusy();
    window.DownloaderSupplementUI?.syncBusy();
    window.DownloaderProductBookUI?.syncBusy();
  }
  // Each tile has one size label: the picture's own size as soon as it shows, completed
  // with the file format once the size filter has read the file.
  function showSize(node, width, height) {
    const data = metadata.get(node);
    if (!data?.label || data.width) return;
    metadata.set(node, { ...data, natural: [width, height] });
    DownloaderI18n.bind(data.label, 'textContent', () => width + '×' + height);
    data.label.hidden = false;
  }
  function register(node) {
    const label = document.createElement('span'); label.className = 'asset-meta'; label.hidden = true;
    DownloaderI18n.bind(label, 'textContent', () => DownloaderI18n.t('m_406dedf560'));
    node.appendChild(label); metadata.set(node, { label });
  }
  function reset() {
    metadata = new WeakMap(); lastDownload = null; lastPlatform = ''; lastOutput = {};
    window.DownloaderSupportUI?.newResult();
    DownloaderI18n.clear(el('inspectStatus'), 'textContent'); DownloaderI18n.clear(el('filterStatus'), 'textContent');
  }
  async function inspect() {
    if (busy()) return;
    const task = async () => {
      if (busy()) return;
      inspecting = true; stop = false; updateDownloadBtn(); window.DownloaderQueueUI?.refresh();
      const images = nodes().filter(n => n.dataset.type !== 'video');
      const cache = new Map(); let done = 0, errors = 0;
      try {
        for (const node of images) {
          if (stop) break;
          const old = metadata.get(node) || {};
          if (old.width) { done++; continue; }
          const urls = [...new Set([node.dataset.url, ...JSON.parse(node.dataset.fallbackUrls || '[]')])].slice(0, 4);
          let info;
          for (const url of urls) {
            if (stop) break;
            try {
              if (!cache.has(url)) cache.set(url, await processor.inspect(await DownloaderMedia.fetchMedia(url, 'image')));
              info = { ...cache.get(url), fallback: url !== node.dataset.url }; break;
            } catch (_) { /* Keep unknowns visible; never export raw network errors. */ }
          }
          if (!stop && old.label) old.label.hidden = false;
          if (info) {
            metadata.set(node, { ...old, ...info });
            if (old.label) DownloaderI18n.bind(old.label, 'textContent', () => `${info.width}×${info.height} · ${info.ext.toUpperCase()}${info.fallback ? DownloaderI18n.t('m_01e9ce64db') : ''}`);
          } else if (!stop) { errors++; if (old.label && !old.natural) DownloaderI18n.bind(old.label, 'textContent', () => DownloaderI18n.t('m_db7232e33a')); }
          done++; refreshFilter();
          DownloaderI18n.bind(el('inspectStatus'), 'textContent', () => DownloaderI18n.t('m_2bd5089fb6', [done, images.length, errors]));
        }
        if (stop) DownloaderI18n.append(el('inspectStatus'), 'textContent', () => DownloaderI18n.t('m_75db23a2c4'));
      } finally { inspecting = false; stop = false; refreshFilter(); window.DownloaderQueueUI?.refresh(); }
    };
    try {
      if (window.DownloaderQueueUI) {
        const result = await window.DownloaderQueueUI.exclusive(task);
        if (!result.acquired) DownloaderI18n.bind(el('inspectStatus'), 'textContent', () => DownloaderI18n.t('m_8b0df53c66'));
      } else await task();
    } catch (_) { DownloaderI18n.bind(el('inspectStatus'), 'textContent', () => DownloaderI18n.t('m_749086e67d')); }
  }
  el('inspectAssets').addEventListener('click', inspect);
  el('stopInspect').addEventListener('click', () => { stop = true; syncBusy(); DownloaderI18n.bind(el('inspectStatus'), 'textContent', () => DownloaderI18n.t('m_d4ed12cf56')); });
  window.addEventListener('pagehide', () => { stop = true; });
  for (const id of ['filterWidth','filterHeight','filterFormat','filterUnknown']) el(id).addEventListener('change', () => { if (!busy()) refreshFilter(); });
  for (const id of ['filterWidth','filterHeight']) el(id).addEventListener('input', () => { if (!busy()) refreshFilter(); });
  el('filterReset').addEventListener('click', () => {
    if (busy()) return;
    el('filterWidth').value = ''; el('filterHeight').value = ''; el('filterFormat').value = 'all'; el('filterUnknown').checked = true; refreshFilter();
  });
  for (const id of ['outputFormat','outputMaxEdge','outputSquare','outputSplitHeight','outputMaxKB']) el(id).addEventListener('change', syncBusy);
  window.DownloaderAssetsUI = { get inspecting() { return inspecting; }, getOutput, getFilter, syncBusy, register, showSize, reset, refreshFilter,
    // Facts for the support report; the support panel builds and shows the report itself.
    diagnosticInput: () => ({ downloadPlatform: lastPlatform, downloadOutput: lastOutput, result: lastDownload,
      filter: getFilter(), output: getOutput(), inspection: inspectionStats() }),
    recordDownload(result, pageUrl, output) {
      lastDownload = result; lastOutput = output; lastPlatform = DownloaderPlatforms.identify(pageUrl)?.key || '';
      window.DownloaderSupportUI?.newResult();
    } };
  syncBusy();
})();
