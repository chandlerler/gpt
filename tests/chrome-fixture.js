// Test-only Chrome API adapter. Never included in the installable extension.
(() => {
  const event = () => {
    const listeners = [];
    return { addListener: listener => listeners.push(listener), emit: (...args) => listeners.forEach(fn => fn(...args)) };
  };
  const changed = event();
  const read = () => JSON.parse(localStorage.getItem('chrome-local-fixture') || '{}');
  const storage = {
    async get(keys) {
      const all = read();
      if (keys == null) return all;
      if (typeof keys === 'string') keys = [keys];
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter(k => k in all).map(k => [k, all[k]]));
      return Object.fromEntries(Object.entries(keys).map(([k, fallback]) => [k, all[k] ?? fallback]));
    },
    async set(values) {
      const old = read();
      localStorage.setItem('chrome-local-fixture', JSON.stringify({ ...old, ...values }));
      changed.emit(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: old[key], newValue: value }])), 'local');
    },
    async remove(keys) {
      const values = read();
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
      localStorage.setItem('chrome-local-fixture', JSON.stringify(values));
    }
  };
  window.chrome = {
    runtime: {
      id: 'study-fixture', getManifest: () => window.fixtureManifest,
      getURL: name => location.origin + '/extension/' + name,
      sendMessage: () => { throw new Error('Unexpected background/payment request'); }
    },
    i18n: { getUILanguage: () => 'zh-CN' },
    storage: { local: storage, onChanged: changed,
      get sync() { throw new Error('Unexpected sync or authorization dependency'); } },
    permissions: { contains: async () => true },
    tabs: {
      onActivated: event(),
      query: async ({ active }) => active ? window.fixtureTabs.slice(0, 1) : window.fixtureTabs,
      update: async id => window.fixtureTabs.find(t => t.id === id),
      sendMessage(id, request, callback) {
        const task = window.fixtureTabMessage(id, request);
        if (callback) task.then(callback, error => { throw error; });
        return task;
      }
    }
  };
})();
