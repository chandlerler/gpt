'use strict';
(function () {
  const manager = DownloaderQueue.createManager({ storage: chrome.storage.local, locks: navigator.locks });
  let state = { jobs: [], pauseRequested: true }, localRun = false, ready = false;
  const element = id => document.getElementById(id);
  const ui = { get running() { return localRun || state.jobs.some(j => j.status === 'running'); }, exclusive: manager.exclusive, getDiagnosticState: () => state, refresh: () => render(state), syncSummary };
  window.DownloaderQueueUI = ui;
  const bind = (id, key, values = []) => DownloaderI18n.bind(element(id), 'textContent', () => DownloaderI18n.t(key, values));
  const counts = () => ({
    queued: state.jobs.filter(job => job.status === 'queued').length,
    running: state.jobs.filter(job => job.status === 'running').length,
    delivered: state.jobs.filter(job => job.status === 'delivered').length,
    attention: state.jobs.filter(job => ['partial', 'failed', 'review', 'unsupported'].includes(job.status)).length,
    missing: state.jobs.filter(job => ['partial', 'failed'].includes(job.status)).length,
    check: state.jobs.filter(job => ['review', 'unsupported'].includes(job.status)).length
  });

  function describeOutput(value) {
    const o = DownloaderAssets.outputOptions(value);
    if (o.format === 'original') return DownloaderI18n.t('m_9fd331306d');
    return [DownloaderI18n.t('m_07c6470870', [o.format.toUpperCase()]), o.maxEdge ? DownloaderI18n.t('m_0597806e5a', [o.maxEdge, o.splitHeight ? DownloaderI18n.t('m_ba9c5282f0') : '']) : DownloaderI18n.t('m_4338e48e3b'), o.square ? DownloaderI18n.t('m_7743cdde1f') : '', o.splitHeight ? DownloaderI18n.t('m_43672617b0', [o.splitHeight]) : '', o.maxKB ? DownloaderI18n.t('m_cfb829fe72', [o.maxKB]) : ''].filter(Boolean).join(', ');
  }
  DownloaderI18n.subscribe(() => render(state));
  // Chrome's own English errors (a closed tab, for example) are never shown raw.
  function report(error) { DownloaderI18n.bind(element('queueStatus'), 'textContent', () => DownloaderI18n.plain(error.message, 'm_2105134527') || DownloaderI18n.t('m_2105134527')); }
  let askingRescan = null;
  function syncSummary() {
    const total = counts();
    const busy = ui.running;
    const blocked = scanInProgress || downloadInProgress || isAssetInspectionRunning();
    element('queueRunDock').dataset.mode = busy ? 'running' : total.queued ? 'ready' : 'done';
    DownloaderI18n.bind(element('queueCount'), 'textContent', () => `${state.jobs.length} / ${DownloaderQueue.MAX_JOBS}`);
    element('queueStart').disabled = !ready || busy || blocked || !total.queued;
    element('queuePause').disabled = !busy || state.pauseRequested;
    element('queuePause').hidden = !busy;
    element('queueAddCurrent').disabled = element('queueAddTabs').disabled = !ready;
    element('queueClear').disabled = !ready || !total.delivered;
    element('scanBtn').disabled = busy || blocked;
    element('queueEmpty').hidden = !ready || state.jobs.length > 0;
    element('queueRunDock').hidden = ready && state.jobs.length === 0;
    element('queueSummary').hidden = !state.jobs.length;
    bind('queueSummary', 'flow_queueSummary', [total.queued, total.running, total.delivered, total.attention]);
    element('queueSummary').dataset.state = !state.jobs.length ? 'empty' : busy ? 'running' : total.attention ? 'attention' : total.queued ? (state.jobs.some(job => job.attempts > 0) ? 'paused' : 'ready') : 'delivered';
    bind('queueStart', busy ? 'flow_queueWorking' : !total.queued ? 'm_23ed5e955d' : state.jobs.some(job => job.attempts > 0) ? 'flow_queueContinue' : 'flow_queueStart', [total.queued]);
    bind('queuePause', busy && state.pauseRequested ? 'flow_queuePausing' : 'm_4cde363f27');
    let hint = 'flow_queueReady';
    if (!ready) hint = 'flow_queueLoading';
    else if (busy) hint = state.pauseRequested ? 'flow_queuePausePending' : 'flow_queueRunning';
    else if (!state.jobs.length) hint = 'flow_queueAddFirst';
    else if (blocked) hint = 'flow_queueBusy';
    else if (total.queued) hint = total.attention ? 'flow_queueRemainingAttention' : 'flow_queueReady';
    else if (total.attention) hint = 'flow_queueAttention';
    else hint = 'flow_queueDelivered';
    bind('queueRunHint', hint, [total.queued, total.attention, total.delivered]);
    DownloaderI18n.bind(element('queueOutputSummary'), 'textContent', () => DownloaderI18n.t('flow_queueOutput', [describeOutput(window.DownloaderAssetsUI?.getOutput())]));
  }
  function stoppedStatus() {
    const total = counts();
    if (total.running) bind('queueStatus', 'flow_queueRunning');
    else if (!state.jobs.length) DownloaderI18n.clear(element('queueStatus'), 'textContent');
    else if (total.queued) bind('queueStatus', state.jobs.some(job => job.attempts > 0) ? 'flow_queuePaused' : 'flow_queueReady', [total.queued, total.attention]);
    // A finished round reads as done, with what still needs a look, not as an interruption.
    else if (total.attention) bind('queueStatus', 'flow_queueRoundDone', [total.delivered, total.missing, total.check]);
    else bind('queueStatus', 'flow_queueFinished', [total.delivered]);
  }
  let orphanTimer = null;
  function watchOrphan() {
    const foreign = !localRun && state.jobs.some(job => job.status === 'running');
    if (!foreign) { clearInterval(orphanTimer); orphanTimer = null; return; }
    if (orphanTimer) return;
    orphanTimer = setInterval(() => {
      manager.recoverIfOrphaned().then(value => { if (value) { render(value); stoppedStatus(); } }).catch(() => {});
    }, 3000);
  }
  function render(next) {
    state = next;
    watchOrphan();
    syncSummary();
    const list = element('queueList'); DownloaderI18n.clear(list, 'textContent');
    for (const job of state.jobs) {
      const row = document.createElement('li'); row.dataset.status = job.status;
      const title = document.createElement('div'); title.className = 'queue-item-title';
      DownloaderI18n.bind(title, 'textContent', () => `[${job.platform === 'taobao' ? DownloaderI18n.t('m_bd01d8b18f') : job.platform === 'tmall' ? DownloaderI18n.t('m_1bfaa1ef73') : job.platform === 'tmallhk' ? DownloaderI18n.t('plat_tmallhk') : DownloaderI18n.t('ux_retiredPlatform')}] ${job.title}`);
      row.appendChild(title);
      const message = document.createElement('p'); message.className = 'queue-item-message';
      // Category names as shown in the panel (not the ZIP folder names); empty parts are left out.
      const categoryKeys = { main: 'm_34696300ad', sku: 'm_5d76158bc0', detail: 'm_1461c52827', video: 'm_8d85cec270' };
      DownloaderI18n.bind(message, 'textContent', () => [DownloaderI18n.legacy(DownloaderQueue.LABELS[job.status]),
        job.categories.map(t => DownloaderI18n.t(categoryKeys[t] || 'm_1461c52827')).join(DownloaderI18n.locale === 'en' ? ', ' : '、'),
        describeOutput(job.output), DownloaderI18n.plain(job.message, 'm_2105134527')].filter(Boolean).join(' · '));
      row.appendChild(message);
      const actions = document.createElement('div'); actions.className = 'queue-item-actions';
      let rescanButton = null;
      const askRescan = () => { askingRescan = job.id; };
      function button(label, action, disabled = false) {
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'toolbar-btn'; DownloaderI18n.bind(btn, 'textContent', () => label); btn.disabled = disabled;
        if (action === askRescan) rescanButton = btn;
        btn.addEventListener('click', async () => { try { await action(); render(await manager.read()); } catch (error) { report(error); } });
        actions.appendChild(btn);
      }
      button(DownloaderI18n.t('m_6caef27088'), () => chrome.tabs.update(job.tabId, { active: true }));
      // Same words as the single-product page and the advice: "retry failed items".
      if (['partial','failed'].includes(job.status)) button(job.retry ? DownloaderI18n.t('m_f054050a7a') : DownloaderI18n.t('m_27138174d7'), () => manager.retry(job.id));
      // Rescanning may download files again, so it asks inside this row, not in a browser dialog.
      if (job.status === 'review' || job.retry) button(DownloaderI18n.t('m_fd15d62e7e'), askRescan);
      button(DownloaderI18n.t('m_2f752c005e'), () => manager.remove(job.id), job.status === 'running');
      if (rescanButton) rescanButton.dataset.rescanJob = job.id;
      row.appendChild(actions);
      if (askingRescan === job.id) {
        const ask = document.createElement('div'); ask.className = 'inline-confirm'; ask.setAttribute('role', 'group');
        const text = document.createElement('p'); DownloaderI18n.bind(text, 'textContent', () => DownloaderI18n.t('m_c9dea6f42e')); ask.appendChild(text);
        const choices = document.createElement('div'); choices.className = 'inline-confirm-actions';
        for (const [key, yes] of [['m_fd15d62e7e', true], ['ux_cancel', false]]) {
          const choice = document.createElement('button'); choice.type = 'button'; choice.className = 'toolbar-btn' + (yes ? ' confirm-go' : '');
          DownloaderI18n.bind(choice, 'textContent', () => DownloaderI18n.t(key));
          choice.addEventListener('click', async () => {
            askingRescan = null;
            try { if (yes) await manager.retry(job.id, true); render(await manager.read()); } catch (error) { report(error); }
            // Focus goes back to the row's rescan button, or the start button once the product is queued again.
            (document.querySelector?.('[data-rescan-job="' + job.id + '"]') || element('queueStart'))?.focus?.();
          });
          choices.appendChild(choice);
        }
        ask.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault?.(); choices.children[1].click(); } });
        ask.appendChild(choices); row.appendChild(ask);
        choices.children[1].focus?.();
      }
      list.appendChild(row);
    }
    updateDownloadBtn();
  }
  const process = DownloaderQueueWorker.createProcessor({ chrome, download: downloadProductAssets,
    onProgress: (job, message) => { DownloaderI18n.bind(element('queueStatus'), 'textContent', () => `${job.title}：${DownloaderI18n.legacy(message)}`); } });
  for (const [id, current] of [['queueAddCurrent', true], ['queueAddTabs', false]]) element(id).addEventListener('click', async () => {
    try {
      await window.DownloaderPreferencesUI?.ready;
      const tabs = await chrome.tabs.query(current ? { currentWindow: true, active: true } : { currentWindow: true });
      const categories = [['queueMain','main'],['queueSku','sku'],['queueDetail','detail'],['queueVideo','video']].filter(([id]) => element(id).checked).map(([,type]) => type);
      const result = await manager.add(tabs, categories, window.DownloaderAssetsUI?.getOutput()); render(result.state);
      DownloaderI18n.bind(element('queueStatus'), 'textContent', () => DownloaderI18n.t('m_22ac34c5d7', [result.result.added, result.result.duplicates, result.result.skipped]));
    } catch (error) { report(error); }
  });
  element('queueStart').addEventListener('click', async () => {
    if (!ready || ui.running || scanInProgress || downloadInProgress || isAssetInspectionRunning()) return;
    localRun = true; render(state);
    try {
      const result = await manager.run(process, render);
      if (result.acquired) { state = result.value; stoppedStatus(); }
      else bind('queueStatus', 'm_4a1288bf7c');
    } catch (error) { report(error); }
    finally { localRun = false; try { render(await manager.read()); } catch (error) { report(error); } }
  });
  element('queuePause').addEventListener('click', async () => {
    try { const result = await manager.pause(); render(result.state); DownloaderI18n.bind(element('queueStatus'), 'textContent', () => DownloaderI18n.t('m_966c623a33')); } catch (error) { report(error); }
  });
  element('queueClear').addEventListener('click', async () => { try { const result = await manager.clearDelivered(); render(result.state); stoppedStatus(); } catch (error) { report(error); } });
  for (const id of ['outputFormat', 'outputMaxEdge', 'outputSquare', 'outputSplitHeight', 'outputMaxKB', 'downloadPreset']) element(id).addEventListener('change', syncSummary);
  if (chrome.storage.onChanged) chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[DownloaderQueue.STORAGE_KEY]) manager.read().then(render).catch(report);
  });
  window.addEventListener('pagehide', () => {
    if (!localRun) return;
    const job = state.jobs.find(j => j.status === 'running');
    if (job) chrome.tabs.sendMessage(job.tabId, { action: 'cancelScan', scanId: 'queue-' + job.id + '-' + job.attempts }).catch(() => {});
    manager.pause().catch(() => {});
  });
  manager.recover().then(value => { ready = true; render(value); stoppedStatus(); }).catch(report);
})();
