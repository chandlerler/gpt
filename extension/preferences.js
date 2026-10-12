'use strict';
(function (root) {
  const assets = root.DownloaderAssets || (typeof require === 'function' ? require('./assets.js') : null);
  const STORAGE_KEY = 'productDownloadPreferencesV1';
  const TYPES = ['main', 'sku', 'detail', 'video'];
  const PRESETS = {
    all: { categories: TYPES, output: { format: 'original', maxEdge: 0 } },
    catalog: { categories: ['main', 'sku'], output: { format: 'original', maxEdge: 0 } },
    jpg: { categories: TYPES, output: { format: 'jpg', maxEdge: 1600 } },
    listing: { categories: TYPES, output: { format: 'jpg', maxEdge: 1600, square: true, splitHeight: 1600, maxKB: 500 } }
  };
  function categories(value) {
    return Array.isArray(value) ? TYPES.filter(t => value.includes(t)) : [...TYPES];
  }
  function normalize(value) {
    const v = value?.version === 1 ? value : {};
    const selected = categories(v.categories);
    return { version: 1, categories: selected.length ? selected : [...TYPES],
      output: assets.outputOptions(v.output), queueCategories: categories(v.queueCategories) };
  }
  function preset(id) {
    if (!Object.hasOwn(PRESETS, id)) return null;
    const p = PRESETS[id];
    return normalize({ version: 1, ...p, queueCategories: p.categories });
  }
  function identify(value) {
    const v = normalize(value);
    return Object.keys(PRESETS).find(id => {
      const p = preset(id);
      return JSON.stringify(v.categories) === JSON.stringify(p.categories) &&
        JSON.stringify(v.output) === JSON.stringify(p.output);
    }) || 'custom';
  }
  function createManager({ storage, locks, timeoutMs = 3000 }) {
    let pending = Promise.resolve();
    async function read() {
      let timer;
      try {
        const data = await Promise.race([storage.get(STORAGE_KEY), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('設定讀取逾時')), timeoutMs);
        })]);
        return normalize(data[STORAGE_KEY]);
      } finally { clearTimeout(timer); }
    }
    function patch(changes) {
      // Only owned fields are merged, under a shared lock when supported.
      const update = async () => {
        const current = await read();
        for (const key of ['categories', 'output', 'queueCategories']) {
          if (Object.hasOwn(changes, key)) current[key] = changes[key];
        }
        const next = normalize(current);
        await storage.set({ [STORAGE_KEY]: next });
        return next;
      };
      const task = pending.then(() => locks?.request ? locks.request(STORAGE_KEY, update) : update());
      pending = task.catch(() => {});
      return task;
    }
    return { read, patch };
  }
  root.DownloaderPreferences = { STORAGE_KEY, normalize, preset, identify, createManager };
  if (typeof module !== 'undefined') module.exports = root.DownloaderPreferences;
})(globalThis);
