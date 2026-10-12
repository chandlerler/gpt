(function () {
  'use strict';
  if (window.AisFloatSettings) { window.AisFloatSettings.apply(); return; }
  const defaults = { visible: true, motion: false };
  let prefs = { ...defaults }, revision = 0;
  function apply() {
    const root = window.__AIS_SHADOW__ || document;
    const panel = root.getElementById('ai-scraper-root');
    if (!panel) return;
    panel.setAttribute('data-float-visible', prefs.visible ? 'on' : 'off');
    panel.setAttribute('data-float-motion', prefs.motion ? 'on' : 'off');
    for (const [id, key] of [['ais-float-visible', 'visible'], ['ais-float-motion', 'motion']]) {
      const input = root.getElementById(id);
      if (!input) continue;
      input.checked = prefs[key];
      if (!input.dataset.floatBound) {
        input.dataset.floatBound = '1';
        input.addEventListener('change', () => {
          revision++; prefs[key] = input.checked; apply();
          chrome.storage.local.set({ aisFloatSettings: { ...prefs } });
        });
      }
    }
  }
  function load() {
    const start = revision;
    chrome.storage.local.get('aisFloatSettings', result => {
      if (revision !== start) return;
      const value = result && result.aisFloatSettings || {};
      prefs = { visible: value.visible !== false, motion: value.motion === true }; apply();
    });
  }
  window.AisFloatSettings = { apply };
  window.addEventListener('ui:ready', apply);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.aisFloatSettings) return;
    revision++;
    const v = changes.aisFloatSettings.newValue || {};
    prefs = { visible: v.visible !== false, motion: v.motion === true }; apply();
  });
  load(); apply();
  [0, 300, 1000].forEach(ms => setTimeout(apply, ms));
})();
