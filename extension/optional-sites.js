'use strict';
(function (root) {
  // Tmall Global (tmall.hk) is an optional site. Its host permission is listed under
  // optional_host_permissions, so updating the extension asks existing customers
  // for nothing. The customer grants it once from the panel; the same content
  // scripts as Taobao/Tmall are then registered for tmall.hk pages.
  const ID = 'tmallhk-content';
  const ORIGINS = ['*://*.tmall.hk/*'];
  const scriptFiles = chrome => chrome.runtime.getManifest().content_scripts[0].js;
  const granted = chrome => chrome.permissions.contains({ origins: ORIGINS });
  // Must be the first call inside a click handler: Chrome only shows the
  // permission prompt during a user gesture.
  const request = chrome => chrome.permissions.request({ origins: ORIGINS });
  // Keep the registration in step with the permission (granted, removed, or an
  // extension update that cleared dynamic scripts).
  async function sync(chrome) {
    const has = await granted(chrome);
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [ID] });
    if (has && !existing.length) {
      try {
        await chrome.scripting.registerContentScripts([{ id: ID, matches: ORIGINS, js: scriptFiles(chrome), runAt: 'document_idle', persistAcrossSessions: true }]);
      } catch (error) {
        // Two events (install and permission added) can race; one registration is enough.
        if (!/duplicate/i.test(String(error?.message))) throw error;
      }
    } else if (!has && existing.length) await chrome.scripting.unregisterContentScripts({ ids: [ID] });
    return has;
  }
  // A tab opened before the permission was granted has no content script yet.
  // Inject once; a page that already answers is left alone. Overlapping calls for
  // the same tab share one attempt, and media-bridge.js ignores a second copy.
  const pending = new Map();
  async function inject(chrome, tabId) {
    try {
      const context = await chrome.tabs.sendMessage(tabId, { action: 'mediaContext' });
      if (context?.ok) return true;
    } catch (_) { /* No content script in this tab yet. */ }
    await chrome.scripting.executeScript({ target: { tabId }, files: scriptFiles(chrome) });
    return true;
  }
  function ensureInjected(chrome, tabId) {
    if (!pending.has(tabId)) pending.set(tabId, inject(chrome, tabId).finally(() => pending.delete(tabId)));
    return pending.get(tabId);
  }
  root.DownloaderOptionalSites = { ID, ORIGINS, granted, request, sync, ensureInjected };
  if (typeof module !== 'undefined') module.exports = root.DownloaderOptionalSites;
})(globalThis);
