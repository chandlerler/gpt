'use strict';
(function (root) {
  const STORAGE_KEY = 'downloaderWorkspaceV1';
  function create({ buttons, panels, resultArea, densityButtons, storage,
    readPosition = () => 0, restorePosition = () => {}, preferenceStatus = () => {} }) {
    let active = null, revision = 0, writes = Promise.resolve();
    const positions = new Map();
    function select(key, { focus = false, reveal = true } = {}) {
      const button = buttons.find(node => node.dataset.workspaceTab === key);
      if (!button || !panels.some(node => node.id === button.getAttribute('aria-controls'))) return false;
      if (active === key) { if (focus) button.focus({ preventScroll: true }); return true; }
      if (active !== null) positions.set(active, readPosition());
      active = key;
      // Preserve the same controls, media objects, selections and unsaved form values.
      for (const tab of buttons) {
        const selected = tab === button;
        tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      }
      for (const panel of panels) panel.hidden = panel.id !== button.getAttribute('aria-controls');
      if (focus) button.focus({ preventScroll: true });
      if (reveal) restorePosition(positions.get(key));
      return true;
    }
    for (const button of buttons) {
      button.addEventListener('click', () => select(button.dataset.workspaceTab));
      button.addEventListener('keydown', event => {
        let next = buttons.indexOf(button);
        if (event.key === 'ArrowRight') next = (next + 1) % buttons.length;
        else if (event.key === 'ArrowLeft') next = (next + buttons.length - 1) % buttons.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        else return;
        event.preventDefault(); select(buttons[next].dataset.workspaceTab, { focus: true });
      });
    }
    function applyDensity(value) {
      resultArea.dataset.density = value;
      for (const button of densityButtons) button.setAttribute('aria-pressed', String(button.dataset.galleryDensity === value));
    }
    function density(value) {
      if (!['large', 'compact'].includes(value)) return false;
      const change = ++revision;
      applyDensity(value);
      // Serial writes ensure a slower earlier save cannot replace the latest choice.
      writes = writes.then(async () => {
        try {
          await storage.set({ [STORAGE_KEY]: { version: 1, density: value } });
          if (change === revision) preferenceStatus(true);
        } catch (_) { if (change === revision) preferenceStatus(false); }
      });
      return true;
    }
    for (const button of densityButtons) button.addEventListener('click', () => density(button.dataset.galleryDensity));
    select('media', { reveal: false }); applyDensity('compact');
    const ready = (async () => {
      try {
        const record = (await storage.get(STORAGE_KEY))?.[STORAGE_KEY];
        if (revision === 0 && record?.version === 1 && ['large', 'compact'].includes(record.density)) applyDensity(record.density);
      } catch (_) { if (revision === 0) preferenceStatus(false); }
    })();
    return { select, density, ready, get settled() { return writes; }, get active() { return active; } };
  }
  const api = { create, STORAGE_KEY };
  if (typeof module !== 'undefined') module.exports = api;
  root.DownloaderWorkspace = api;
})(globalThis);
