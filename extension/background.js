'use strict';

// Preserve the published side-panel opening behavior.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(err));

// Tmall Global (optional site): keep its content scripts registered exactly while
// the customer's optional permission is granted, including after an update.
importScripts('optional-sites.js');
if (chrome.permissions?.onAdded && chrome.scripting) {
  const syncOptionalSites = () => DownloaderOptionalSites.sync(chrome).catch(error => console.error(error));
  chrome.runtime.onInstalled?.addListener(syncOptionalSites);
  chrome.runtime.onStartup?.addListener(syncOptionalSites);
  chrome.permissions.onAdded.addListener(syncOptionalSites);
  chrome.permissions.onRemoved.addListener(syncOptionalSites);
}
