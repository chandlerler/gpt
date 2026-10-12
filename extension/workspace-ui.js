'use strict';
(function () {
  const el = id => document.getElementById(id);
  const tabs = DownloaderWorkspace.create({
    buttons: Array.from(document.querySelectorAll('[data-workspace-tab]')),
    panels: Array.from(document.querySelectorAll('.workspace-panel')),
    resultArea: el('resultArea'),
    densityButtons: Array.from(document.querySelectorAll('[data-gallery-density]')),
    storage: chrome.storage.local,
    readPosition: () => window.scrollY,
    restorePosition: position => {
      if (position === undefined) el('workspaceTabs').scrollIntoView({ behavior: 'instant', block: 'start' });
      else window.scrollTo({ top: position, behavior: 'instant' });
    },
    preferenceStatus: ok => {
      el('workspacePreferenceStatus').hidden = ok;
      if (ok) DownloaderI18n.clear(el('workspacePreferenceStatus'), 'textContent');
      else DownloaderI18n.bind(el('workspacePreferenceStatus'), 'textContent', () => DownloaderI18n.t('workspace_memoryError'));
    }
  });
  // from: the tab the customer came from, so the bottom button can take them back there.
  let returnTo = null;
  function syncBack() {
    if (!el('backToMedia')) return;
    const toQueue = returnTo === 'queue';
    el('backToMedia').dataset.jump = toQueue ? 'queueTitle' : 'selectionCount';
    DownloaderI18n.bind(el('backToMedia'), 'textContent', () => DownloaderI18n.t(toQueue ? 'ux_backToBatch' : 'ux_backToMedia'));
    window.DownloaderFlowUI?.sync();
  }
  function openSection(id, { from = null } = {}) {
    const target = el(id);
    if (!target) return;
    const panel = target.closest('.workspace-panel');
    if (panel) tabs.select(panel.id.replace('tabPanel-', ''), { reveal: false });
    for (let node = target; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
    target.scrollIntoView({ behavior: 'instant', block: 'start' });
    // The tab bar stays pinned on top; leave room so the heading is not hidden under it.
    const bar = el('workspaceTabs');
    const covered = (bar?.getBoundingClientRect?.().bottom || 0) + 12 - (target.getBoundingClientRect?.().top ?? Infinity);
    if (covered > 0) window.scrollBy?.({ top: -covered, behavior: 'instant' });
    if (target.tabIndex < 0) target.setAttribute('tabindex', '-1');
    target.focus?.({ preventScroll: true });
    returnTo = from; syncBack();
  }
  // Choosing a tab yourself ends the "take me back" offer.
  for (const button of document.querySelectorAll('[data-workspace-tab]')) button.addEventListener('click', () => { if (returnTo) { returnTo = null; syncBack(); } });
  for (const node of document.querySelectorAll('[data-jump]')) node.addEventListener('click', () => {
    if (node.id === 'backToMedia') { const jump = node.dataset.jump; returnTo = null; syncBack(); openSection(jump); return; }
    openSection(node.dataset.jump);
  });
  function syncBusy() {
    const missingVideo = !!currentScanContext && currentImages.length > 0 && !currentImages.some(item => item.type === 'video');
    el('videoRecovery').hidden = !missingVideo;
    el('supplementVideoBtn').disabled = !missingVideo || el('supplementBtn').disabled;
  }
  el('supplementVideoBtn').addEventListener('click', () => {
    syncBusy();
    if (el('supplementVideoBtn').disabled) return;
    // Use the existing page-context checks and incremental capture path.
    openSection('supplementControls');
    el('supplementBtn').click();
  });
  function clearResult() {
    DownloaderI18n.clear(el('downloadReceipt'), 'textContent');
    el('downloadReceipt').hidden = true;
    if (el('downloadIssues')) el('downloadIssues').hidden = true;
  }
  // Reasons: two short lines stay in the download area; everything else waits behind
  // "see all", so the pinned area never squeezes out the download button.
  const PREVIEW = 2;
  function fillList(list, renders) {
    DownloaderI18n.clear(list, 'textContent');
    for (const render of renders) {
      const li = document.createElement('li');
      DownloaderI18n.bind(li, 'textContent', () => typeof render === 'function' ? render() : DownloaderI18n.legacy(render));
      list.appendChild(li);
    }
  }
  function showIssues(reasons = [], advice = []) {
    if (!el('downloadIssues')) return;
    fillList(el('downloadIssuePreview'), reasons.slice(0, PREVIEW));
    fillList(el('downloadIssueList'), reasons);
    fillList(el('downloadAdviceList'), [...new Set(advice)]);
    el('downloadAdvice').hidden = !advice.length;
    const more = reasons.length > PREVIEW || advice.length > 0;
    el('downloadIssuesAll').hidden = !more;
    DownloaderI18n.bind(el('downloadIssuesAll'), 'textContent', () => DownloaderI18n.t('dl_issuesAll', [reasons.length]));
    DownloaderI18n.bind(el('downloadIssueTitle'), 'textContent', () => DownloaderI18n.t('dl_issuesTitle', [reasons.length]));
    el('downloadIssues').hidden = !reasons.length;
  }
  el('downloadIssuesAll')?.addEventListener('click', () => el('downloadIssuesDialog').showModal());
  el('closeDownloadIssues')?.addEventListener('click', () => el('downloadIssuesDialog').close());
  function showResult(result, reasons = [], advice = []) {
    // These counts describe handoff, not confirmation that files exist on disk.
    const packed = result.packed.length;
    const handedOff = result.dispatched.length + result.unconfirmed.length;
    const failed = result.failed.length;
    const warnings = result.conversionWarnings?.length || 0;
    const unconfirmed = result.unconfirmed.length;
    // Green only when everything arrived; the first sentence says what went wrong and where to retry.
    el('downloadReceipt').dataset.tone = failed ? (packed || handedOff ? 'warn' : 'error') : unconfirmed || warnings ? 'warn' : 'ok';
    const copies = result.copyFiles?.length ?? result.converted?.length ?? 0;
    DownloaderI18n.bind(el('downloadReceipt'), 'textContent', () => DownloaderI18n.sentences([
      failed && DownloaderI18n.t(packed || handedOff ? 'dl_receiptFailed' : 'dl_receiptNone', [failed]),
      // With failures the advice comes first, so the rest is said in one short line.
      packed && DownloaderI18n.t(failed ? 'dl_receiptPackedRest' : 'dl_receiptPacked', [packed]),
      packed && copies && DownloaderI18n.t('dl_receiptCopies', [copies]),
      handedOff && DownloaderI18n.t('dl_receiptHandoff', [handedOff]),
      warnings && DownloaderI18n.t('workspace_copyWarnings', [warnings])]));
    el('downloadReceipt').hidden = false;
    showIssues(reasons, advice);
  }
  window.DownloaderWorkspaceUI = { tabs, openSection, syncBusy, clearResult, showResult, showIssues };
  syncBack();
  syncBusy();
})();
