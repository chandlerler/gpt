'use strict';
(function () {
  const el = id => document.getElementById(id);
  const manager = DownloaderPreferences.createManager({ storage: chrome.storage.local, locks: navigator.locks });
  const queueFields = [['queueMain','main'], ['queueSku','sku'], ['queueDetail','detail'], ['queueVideo','video']];
  let state = DownloaderPreferences.normalize(), loading = true, revision = 0;
  const unsaved = new Map();
  const busy = () => loading || downloadInProgress || scanInProgress || isQueueRunning() || isAssetInspectionRunning();
  function render() {
    el('downloadPreset').value = DownloaderPreferences.identify(state);
    el('outputFormat').value = state.output.format;
    el('outputMaxEdge').value = String(state.output.maxEdge || (state.output.format === 'original' ? 1600 : 0));
    el('outputSquare').checked = state.output.square === true;
    el('outputSplitHeight').value = String(state.output.splitHeight || 0);
    el('outputMaxKB').value = String(state.output.maxKB || 0);
    for (const [id, type] of queueFields) el(id).checked = state.queueCategories.includes(type);
  }
  function syncBusy() {
    for (const id of ['downloadPreset', 'outputFormat', 'outputMaxEdge', 'outputSquare', 'outputSplitHeight', 'outputMaxKB', ...queueFields.map(([id]) => id)]) el(id).disabled = busy();
    if (!busy()) for (const id of ['outputMaxEdge','outputSquare','outputSplitHeight','outputMaxKB']) el(id).disabled = state.output.format === 'original';
  }
  function applySelection() {
    for (const node of document.querySelectorAll('.image-item')) {
      // Posters that link to another product stay unselected until chosen by hand.
      // Posters for another product and pictures that look blank stay unselected too.
      if (!node.hidden && state.categories.includes(node.dataset.type) && !node.dataset.otherProduct && !node.dataset.maybeBlank && !node.dataset.dropped) node.classList.add('selected');
      else node.classList.remove('selected');
    }
    updateDownloadBtn();
  }
  async function save(changes) {
    const current = ++revision;
    for (const [key, value] of Object.entries(changes)) unsaved.set(key, { value, revision: current });
    const snapshot = new Map(unsaved);
    DownloaderI18n.bind(el('preferenceStatus'), 'textContent', () => DownloaderI18n.t('m_39df5b98e3'));
    try {
      await manager.patch(Object.fromEntries([...snapshot].map(([key, entry]) => [key, entry.value])));
      for (const [key, entry] of snapshot) if (unsaved.get(key)?.revision === entry.revision) unsaved.delete(key);
      if (current === revision) DownloaderI18n.bind(el('preferenceStatus'), 'textContent', () => DownloaderI18n.t('m_e598bf6bff'));
    } catch (_) {
      if (current === revision) DownloaderI18n.bind(el('preferenceStatus'), 'textContent', () => DownloaderI18n.t('m_5cc723cd3e'));
    }
  }
  const ready = manager.read().then(value => {
    state = value; render(); DownloaderI18n.bind(el('preferenceStatus'), 'textContent', () => DownloaderI18n.t('m_2fcd3c5db2'));
  }).catch(() => {
    render(); DownloaderI18n.bind(el('preferenceStatus'), 'textContent', () => DownloaderI18n.t('m_b310a4886b'));
  }).finally(() => { loading = false; updateDownloadBtn(); window.DownloaderQueueUI?.refresh(); });
  window.DownloaderPreferencesUI = { ready, get loading() { return loading; }, syncBusy, applySelection };
  el('downloadPreset').addEventListener('change', async () => {
    if (busy()) { render(); return; }
    const next = DownloaderPreferences.preset(el('downloadPreset').value);
    if (!next) return;
    state = next; render(); applySelection(); syncBusy();
    await save({ categories: state.categories, output: state.output, queueCategories: state.queueCategories });
  });
  for (const id of ['outputFormat', 'outputMaxEdge', 'outputSquare', 'outputSplitHeight', 'outputMaxKB']) el(id).addEventListener('change', async () => {
    if (busy()) { render(); return; }
    state.output = window.DownloaderAssetsUI.getOutput();
    render(); syncBusy();
    window.DownloaderWorkspaceUI?.clearResult();
    updateDownloadBtn();
    await save({ output: state.output });
  });
  for (const [id] of queueFields) el(id).addEventListener('change', async () => {
    if (busy()) { render(); return; }
    state.queueCategories = queueFields.filter(([id]) => el(id).checked).map(([,type]) => type);
    await save({ queueCategories: state.queueCategories });
  });
  syncBusy();
})();
