'use strict';
(function () {
  const el = id => document.getElementById(id);
  // Scan advice sits under the scan button. It has no button of its own: the scan button
  // (or the rescan button beside the status line) is the one place to scan again.
  // Download advice lives with the download reasons (workspace-ui.js).
  function show(steps) {
    DownloaderI18n.clear(el('recoverySteps'), 'textContent');
    for (const step of [...new Set(steps)]) {
      const li = document.createElement('li'); DownloaderI18n.bind(li, 'textContent', () => typeof step === 'function' ? step() : DownloaderI18n.legacy(step)); el('recoverySteps').appendChild(li);
    }
    el('recoveryCard').hidden = !steps.length;
  }
  window.DownloaderRecoveryUI = { show, syncBusy() {} };
})();
