'use strict';
(function () {
  const hint = document.getElementById('panelWidthHint');
  const dismiss = document.getElementById('dismissPanelWidthHint');
  const key = 'downloaderPanelHintDismissedV1';
  const narrow = window.matchMedia('(max-width: 559px)');
  let dismissed = false;
  let ready = false;
  // One line, shown in one panel session only: once it has been on screen it is
  // remembered as seen, so later sessions start without it.
  const remember = () => Promise.resolve().then(() => chrome.storage.local.set({ [key]: true })).catch(() => {});
  let remembered = false;
  function render() {
    hint.hidden = !ready || dismissed || !narrow.matches;
    if (!hint.hidden && !remembered && hint.offsetParent !== null && hint.offsetParent !== undefined) { remembered = true; remember(); }
  }
  dismiss.addEventListener('click', () => {
    dismissed = true;
    render();
    // Keep the panel hint separate from download preferences.
    if (!remembered) { remembered = true; remember(); }
    document.querySelector('[data-gallery-density][aria-pressed="true"]')?.focus({ preventScroll: true });
  });
  narrow.addEventListener('change', render);
  // The hint lives in the media tools, which appear after a scan.
  new MutationObserver(render).observe(document.getElementById('mediaTools'), { attributes: true, attributeFilter: ['hidden'] });
  // A slow or unavailable preference store must not delay the product UI.
  let timeout;
  Promise.race([
    Promise.resolve().then(() => chrome.storage.local.get(key)),
    new Promise(resolve => { timeout = setTimeout(() => resolve({}), 2000); })
  ]).then(record => { if (record?.[key] === true) dismissed = true; }).catch(() => {}).finally(() => {
    clearTimeout(timeout);
    ready = true;
    render();
  });
})();
