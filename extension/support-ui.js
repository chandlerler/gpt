'use strict';
// Local diagnostics and the study project link. Reports are never submitted automatically.
(function () {
  const el = id => document.getElementById(id);
  const D = DownloaderDiagnostics, I = DownloaderI18n;
  const dialog = el('supportDialog');
  let opener = null;
  const version = () => chrome.runtime.getManifest?.().version || '';
  const reportFile = () => I.t('m_abc582c53c');
  // The address is never written on screen (only the Gmail draft's To field carries it).
  const say = key => I.bind(el('supportStatus'), 'textContent', () => I.t(key, ['', reportFile()]));

  // The report is rebuilt whenever it is shown or used, so it always matches the current panel.
  function refresh() {
    const report = D.build({ version: version(), platform: DownloaderPlatforms.identify(currentScanContext?.pageUrl)?.key,
      scan: scanInfo, items: currentImages, queue: window.DownloaderQueueUI?.getDiagnosticState() || {},
      ...window.DownloaderAssetsUI?.diagnosticInput(),
      feedback: { reason: el('feedbackReason').value, fileCheck: el('feedbackOutcome').value } });
    el('diagnosticPreview').value = JSON.stringify(report, null, 2);
    return report;
  }
  function open(event) {
    opener = event?.currentTarget || null;
    I.clear(el('supportStatus'), 'textContent');
    refresh();
    if (!dialog.open) dialog.showModal();
  }
  dialog.addEventListener('close', () => { if (opener?.isConnected) opener.focus(); opener = null; });
  el('closeSupport').addEventListener('click', () => dialog.close());
  for (const node of document.querySelectorAll('[data-open-support]')) node.addEventListener('click', open);

  const projectUrl = 'https://github.com/chandlerler/gpt';
  el('copyProjectUrl').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(projectUrl); say('study_linkCopied'); }
    catch (_) { say('study_copyFailed'); }
  });
  el('projectHome').addEventListener('click', () => {
    window.open(projectUrl, '_blank', 'noopener,noreferrer');
    say('study_projectOpened');
  });
  el('downloadReport').addEventListener('click', () => {
    refresh();
    const url = URL.createObjectURL(new Blob([el('diagnosticPreview').value], { type: 'application/json' }));
    try {
      const a = document.createElement('a'); a.href = url; a.download = reportFile(); document.body.appendChild(a); a.click(); a.remove();
      say('support_reportSaved');
    } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
  });
  for (const id of ['feedbackReason', 'feedbackOutcome']) el(id).addEventListener('change', () => { I.clear(el('supportStatus'), 'textContent'); refresh(); });

  // Only these product messages ask the user to contact support. A status line gets
  // a link when it is, or ends with, one of them in the current language. Free text
  // such as product titles (shown before queue progress) can never trigger it.
  const SUPPORT_MESSAGES = ['m_64ef34170d', 'm_0b36e05381', 'm_7a11ed34e0', 'book_corrupt', 'ux_layoutRecovery'];
  function asksForSupport(text) {
    const value = String(text || '').trim();
    return !!value && SUPPORT_MESSAGES.some(key => { const message = I.t(key); return value === message || value.endsWith(message); });
  }
  function linkAfter(id) {
    const target = el(id);
    if (!target) return;
    const link = document.createElement('button');
    link.type = 'button'; link.className = 'text-button support-link'; link.hidden = true;
    I.bind(link, 'textContent', () => I.t('support_open'));
    link.addEventListener('click', open);
    target.after(link);
    // List containers (recovery steps) are checked item by item.
    const lines = () => target.children?.length ? [...target.children].map(node => node.textContent) : [target.textContent];
    // The link sits in the same container, so it hides together with a hidden card.
    const sync = () => { link.hidden = !lines().some(asksForSupport); };
    new MutationObserver(sync).observe(target, { childList: true, characterData: true, subtree: true });
    I.subscribe(sync); sync();
  }
  for (const id of ['recoverySteps', 'queueStatus', 'bookStatus']) linkAfter(id);

  window.DownloaderSupportUI = {
    open, refresh, asksForSupport,
    // A new scan or download starts a new report; the user's file check answer no longer applies.
    newResult() { el('feedbackOutcome').value = 'unchecked'; refresh(); }
  };
})();
