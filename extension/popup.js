let currentScanTabId = null;
let currentScanContext = null;
let failedTargets = [];
let failedOutput = {};
let currentImages = [];
let pageTitle = '';
let downloadInProgress = false;
let scanInProgress = false;
let scanId = null;
let scanInfo = {};
const PAGE_CHECK_TIMEOUT_MS = 15000;
const LAYOUT_WARNINGS = ['main_missing', 'main_guessed', 'sku_missing', 'detail_missing', 'detail_guessed', 'video_missing'];
// Tmall Global: one-time optional permission, asked only when the customer clicks.
// Offered only when the address is unreadable (a tmall.hk tab hides it without the
// permission) or is on tmall.hk; a Taobao home or search page never shows it.
function mayBeTmallHk(url) {
  if (!url) return true;
  try { const host = new URL(url).hostname; return host === 'tmall.hk' || host.endsWith('.tmall.hk'); } catch (_) { return true; }
}
function hideTmallHkOffer() { document.getElementById('tmallHkBox').hidden = true; }
async function needsTmallHkOffer(url) {
  if (!window.DownloaderOptionalSites || !chrome.permissions || !mayBeTmallHk(url)) return false;
  return !(await DownloaderOptionalSites.granted(chrome).catch(() => true));
}
// One quiet box right under the scan button: what to do and one button, nothing red.
function showTmallHkOffer(url) {
  // An unreadable address can also be some other site; one small line covers that case.
  document.getElementById('tmallHkOther').hidden = !!url;
  document.getElementById('tmallHkBtn').hidden = false;
  DownloaderI18n.clear(document.getElementById('tmallHkStatus'), 'textContent');
  document.getElementById('tmallHkBox').hidden = false;
}
chrome.tabs.onActivated?.addListener(hideTmallHkOffer);
let selectionTouched = false;
// Problems with the scan sit right under the scan button and stand out.
function setStatusTone(tone) {
  const status = document.getElementById('status');
  if (tone) status.dataset.tone = tone; else delete status.dataset.tone;
}
function resetScanNotices() {
  setStatusTone(null);
  document.getElementById('scanWarning').hidden = true;
  document.getElementById('rescanConfirm').hidden = true;
  DownloaderI18n.clear(document.getElementById('scanNote'), 'textContent');
  document.getElementById('warnSupplementBtn').hidden = true;
  window.DownloaderLayoutReportUI?.reset();
}
// After a scan, nudge the page just enough that the first row of pictures is not
// hidden behind the download area. Never scrolls the first picture's top away.
function revealFirstImages() {
  if (typeof document.querySelector !== 'function' || typeof window.scrollBy !== 'function') return;
  const tile = document.querySelector('#resultArea .image-item:not([hidden])');
  const dock = document.getElementById('downloadDock');
  if (!tile?.getBoundingClientRect) return;
  const rect = tile.getBoundingClientRect();
  const limit = dock && !dock.hidden ? dock.getBoundingClientRect().top : window.innerHeight;
  const tabs = document.getElementById('workspaceTabs')?.getBoundingClientRect?.().bottom || 0;
  // A warning or advice box under the scan button must stay in view: it matters more than pictures.
  const notices = ['scanWarning', 'recoveryCard'].map(id => document.getElementById(id)).filter(node => node && !node.hidden && node.closest?.('#tabPanel-media'));
  const keep = notices.length ? Math.min(...notices.map(node => node.getBoundingClientRect().top)) : rect.top;
  const needed = Math.min(rect.bottom - limit + 8, keep - tabs - 8);
  if (needed > 0) window.scrollBy({ top: needed, behavior: 'instant' });
}
// Scroll just enough that a box is neither hidden behind the pinned download area nor
// under the pinned tab bar (used after the anonymous notice turns into one line).
function keepAboveDock(node) {
  if (!node?.getBoundingClientRect || typeof window.scrollBy !== 'function') return;
  const dock = document.getElementById('downloadDock');
  const limit = dock && !dock.hidden ? dock.getBoundingClientRect().top : window.innerHeight;
  const top = (document.getElementById('workspaceTabs')?.getBoundingClientRect?.().bottom || 0) + 8;
  const rect = node.getBoundingClientRect();
  if (rect.top < top) window.scrollBy({ top: rect.top - top, behavior: 'instant' });
  else if (rect.bottom > limit - 8) window.scrollBy({ top: Math.min(rect.bottom - limit + 8, rect.top - top), behavior: 'instant' });
}
// Rescanning clears the failed list and the customer's own picks; ask only then.
function rescanNeedsConfirm() { return currentImages.length > 0 && (failedTargets.length > 0 || selectionTouched); }
function requestRescan() {
  if (downloadInProgress || scanInProgress || isQueueRunning() || isAssetInspectionRunning()) return;
  if (!rescanNeedsConfirm()) return startScan();
  const failed = failedTargets.length;
  DownloaderI18n.bind(document.getElementById('rescanConfirmText'), 'textContent', () => failed ? DownloaderI18n.t('ux_rescanAskFailed', [failed]) : DownloaderI18n.t('ux_rescanAskPicks'));
  document.getElementById('rescanConfirm').hidden = false;
  document.getElementById('rescanConfirmNo').focus?.();
}
document.getElementById('rescanConfirmYes').addEventListener('click', () => {
  document.getElementById('rescanConfirm').hidden = true;
  document.getElementById('scanBtn').focus?.();
  return startScan();
});
// In-panel questions: Esc is the same as the cancel button.
for (const [box, no] of [['rescanConfirm', 'rescanConfirmNo']]) {
  document.getElementById(box).addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.getElementById(box).hidden) { event.preventDefault?.(); document.getElementById(no).click(); }
  });
}
document.getElementById('rescanConfirmNo').addEventListener('click', () => {
  document.getElementById('rescanConfirm').hidden = true;
  document.getElementById('scanBtn').focus?.();
});
document.getElementById('tmallHkBtn')?.addEventListener('click', () => {
  const note = document.getElementById('tmallHkStatus');
  // The permission prompt must be requested before any await in this click.
  DownloaderOptionalSites.request(chrome).then(async granted => {
    if (!granted) { DownloaderI18n.bind(note, 'textContent', () => DownloaderI18n.t('hk_denied')); return; }
    document.getElementById('tmallHkBtn').hidden = true;
    document.getElementById('tmallHkOther').hidden = true;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Allowed on a Tmall Global product page: scan it right away instead of asking for another click.
    if (DownloaderPlatforms.identify(tab?.url)?.key === 'tmallhk') { hideTmallHkOffer(); return startScan(); }
    DownloaderI18n.bind(note, 'textContent', () => DownloaderI18n.t('hk_enabledOpen'));
  }).catch(() => DownloaderI18n.bind(note, 'textContent', () => DownloaderI18n.t('hk_denied')));
});
function isAssetInspectionRunning() { return window.DownloaderAssetsUI?.inspecting === true; }
function selectedVisible() { return Array.from(document.querySelectorAll('.image-item.selected, .img-box.selected')).filter(el => !el.hidden); }
function isQueueRunning() { return window.DownloaderQueueUI?.running === true; }

function updateUIState() {
  updateDownloadBtn();
}

document.addEventListener('DOMContentLoaded', () => {
  updateUIState();

  const closePanelBtn = document.getElementById('closePanelBtn');
  if (closePanelBtn) closePanelBtn.addEventListener('click', () => window.close());

  const selectAllBtn = document.getElementById('selectAllBtn');
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => {
      if (downloadInProgress || scanInProgress || isQueueRunning() || isAssetInspectionRunning()) return;
      document.querySelectorAll('.image-item, .img-box').forEach((el) => { if (!el.hidden) el.classList.add('selected'); });
      selectionTouched = true;
      updateDownloadBtn();
      updateUIState();
    });
  }

  const deselectAllBtn = document.getElementById('deselectAllBtn');
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', () => {
      if (downloadInProgress || scanInProgress || isQueueRunning() || isAssetInspectionRunning()) return;
      document.querySelectorAll('.image-item, .img-box').forEach((el) => el.classList.remove('selected'));
      selectionTouched = true;
      updateDownloadBtn();
      updateUIState();
    });
  }
});

for (const [id, type] of [['selectMainBtn','main'], ['selectSkuBtn','sku'], ['selectDetailBtn','detail'], ['selectVideoBtn','video']]) {
  document.getElementById(id).addEventListener('click', () => {
    if (downloadInProgress || scanInProgress || isQueueRunning() || isAssetInspectionRunning()) return;
    document.querySelectorAll('.image-item, .img-box').forEach(el => {
      if (!el.hidden && el.dataset.type === type) el.classList.add('selected');
      else el.classList.remove('selected');
    });
    selectionTouched = true;
    updateUIState();
  });
}
document.getElementById('stopScanBtn').addEventListener('click', async () => {
  if (!scanInProgress || currentScanTabId == null) return;
  document.getElementById('stopScanBtn').disabled = true;
  try { await chrome.tabs.sendMessage(currentScanTabId, { action: 'cancelScan', scanId }); }
  catch (_) { DownloaderI18n.bind(document.getElementById('status'), 'textContent', () => DownloaderI18n.t('m_9efb5efe15')); }
});

document.getElementById('scanBtn').addEventListener('click', () => currentImages.length && !scanInProgress ? requestRescan() : startScan());
async function startScan() {
  await window.DownloaderPreferencesUI?.ready;
  if (downloadInProgress || scanInProgress || isQueueRunning() || isAssetInspectionRunning()) return;
  scanInProgress = true;
  resetScanNotices();
  hideTmallHkOffer();
  selectionTouched = false;
  window.DownloaderRecoveryUI?.show([]);
  updateDownloadBtn();
  scanId = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
  currentImages = [];
  window.DownloaderSupplementUI?.reset();
  failedTargets = []; failedOutput = {};
  for (const id of ['videoGrid','mainGrid','skuGrid','detailGrid']) document.getElementById(id).innerHTML = '';
  window.DownloaderAssetsUI?.reset();
  scanInfo = { scanReason: 'running' };
  currentScanContext = null;
  currentScanTabId = null;
  const scanBtn = document.getElementById('scanBtn');
  const zipBtn = document.getElementById('zipBtn');
  const status = document.getElementById('status');
  const resultArea = document.getElementById('resultArea');
  const productTitleWrap = document.getElementById('productTitleWrap');
  const productTitleEl = document.getElementById('productTitle');

  if (typeof JSZip === 'undefined') {
    scanInProgress = false;
    setStatusTone('error');
    DownloaderI18n.bind(status, 'textContent', () => DownloaderI18n.t('m_f8d6fda103'));
    return;
  }

  scanBtn.disabled = true;
  zipBtn.style.display = 'none';
  document.getElementById('toolbar').style.display = 'none';
  resultArea.style.display = 'none';
  productTitleWrap.style.display = 'none';
  DownloaderI18n.bind(status, 'textContent', () => DownloaderI18n.t('m_f57650141d'));
  document.getElementById('stopScanBtn').hidden = true;
  document.getElementById('stopScanBtn').disabled = false;

  const finishScan = () => {
    scanInProgress = false; scanBtn.disabled = false;
    document.getElementById('stopScanBtn').hidden = true;
    if (scanInfo.scanReason === 'running') scanInfo.scanReason = 'failed';
    updateDownloadBtn(); window.DownloaderQueueUI?.refresh();
  };
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); }
  catch (_) { finishScan(); setStatusTone('error'); DownloaderI18n.bind(status, 'textContent', () => DownloaderI18n.t('m_4937ec9397')); window.DownloaderRecoveryUI?.show([() => DownloaderI18n.t('m_8431f50bec')]); return; }
  const scannedProduct = DownloaderPlatforms.identify(tab?.url);
  if (!scannedProduct) {
    finishScan();
    // Without the optional permission a tmall.hk tab hides its address, so offer it
    // here — but only for an unreadable address or a tmall.hk page. That box is the
    // whole answer: no red error and no general advice next to it.
    if (await needsTmallHkOffer(tab?.url)) { DownloaderI18n.clear(status, 'textContent'); showTmallHkOffer(tab?.url); return; }
    setStatusTone('error'); DownloaderI18n.bind(status, 'textContent', () => DownloaderI18n.t('ux_notProductPage'));
    return;
  }
  if (scannedProduct.key === 'tmallhk') {
    // The address can be visible through activeTab alone; scanning still needs the permission.
    if (!(await DownloaderOptionalSites.granted(chrome).catch(() => false))) {
      finishScan(); DownloaderI18n.clear(status, 'textContent');
      showTmallHkOffer(tab.url);
      return;
    }
    try { await DownloaderOptionalSites.ensureInjected(chrome, tab.id); }
    catch (_) {
      finishScan(); setStatusTone('error'); DownloaderI18n.bind(status, 'textContent', () => DownloaderI18n.t('hk_injectFailed'));
      return;
    }
  }

  currentScanTabId = tab.id;
  failedTargets = [];
  document.getElementById('downloadIssues').hidden = true;
  window.DownloaderWorkspaceUI?.clearResult();
  document.getElementById('retryDownloadBtn').hidden = true;
  try {
    currentScanContext = await chrome.tabs.sendMessage(tab.id, { action: 'mediaContext' });
    if (!currentScanContext?.ok) throw new Error(DownloaderI18n.canonical('m_ca796a0b5f'));
  } catch (_) {
    finishScan(); setStatusTone('error');
    DownloaderI18n.bind(status, 'textContent', () => DownloaderI18n.t('m_4390ce4349'));
    window.DownloaderRecoveryUI?.show([() => DownloaderI18n.t('m_2811a8b26d')]);
    return;
  }
  document.getElementById('stopScanBtn').hidden = false;
  const progressTimer = setInterval(async () => {
    try {
      const progress = await chrome.tabs.sendMessage(tab.id, { action: 'scanStatus' });
      if (scanInProgress && progress?.running && progress.id === scanId) {
        DownloaderI18n.bind(status, 'textContent', () => DownloaderI18n.t('m_cd5336882f', [progress.count, Math.floor(progress.elapsedMs / 1000)]));
      }
    } catch (_) { /* The main scan response reports a lost tab. */ }
  }, 1000);
  const scanWatchdog = setTimeout(() => {
    if (!scanInProgress) return;
    clearInterval(progressTimer);
    chrome.tabs.sendMessage(tab.id, { action: 'cancelScan', scanId }).catch(() => {});
    finishScan(); currentScanContext = null; setStatusTone('error');
    DownloaderI18n.bind(status, 'textContent', () => DownloaderI18n.t('m_ed9eb8b5ad'));
    scanInfo.scanReason = 'timeout';
    window.DownloaderRecoveryUI?.show([() => DownloaderI18n.t('m_404a057f84')]);
  }, 75000);
  const expectedScanId = scanId;
  chrome.tabs.sendMessage(tab.id, { action: 'scan', scanId }, (res) => {
    clearInterval(progressTimer); clearTimeout(scanWatchdog);
    if (!scanInProgress || scanId !== expectedScanId) return;
    finishScan();
    if (chrome.runtime.lastError || !res) {
      setStatusTone('error');
      DownloaderI18n.bind(status, 'textContent', () => DownloaderI18n.t('m_c24b28964b'));
      window.DownloaderRecoveryUI?.show([() => DownloaderI18n.t('m_ff312293c9')]);
      return;
    }
    if (!res.success) {
      scanInfo = { scanReason: res.scan?.reason || 'failed', elapsedMs: res.scan?.elapsedMs || 0, layout: res.scan?.layout, layoutWarnings: res.scan?.layoutWarnings || [] };
      const layoutMissing = res.scan?.code === 'LAYOUT_UNRECOGNIZED';
      const unloaded = res.scan?.code === 'IMAGES_NOT_READY';
      setStatusTone('error');
      offerLayoutReport(scannedProduct, [...(layoutMissing ? ['layout_unrecognized'] : []), ...scanInfo.layoutWarnings], res.scan?.layoutClasses);
      DownloaderI18n.bind(status, 'textContent', () => layoutMissing ? DownloaderI18n.t('ux_layoutMissing') : unloaded ? DownloaderI18n.t('ux_imagesNotReady') : DownloaderI18n.plain(res.msg, 'm_00c835c32a') || DownloaderI18n.t('m_00c835c32a'));
      window.DownloaderRecoveryUI?.show([() => DownloaderI18n.t(layoutMissing ? 'ux_layoutRecovery' : unloaded ? 'ux_loadRecovery' : 'm_b14c2ee822')]);
      return;
    }

    currentImages = res.data;
    scanInfo = { scannedAt: new Date().toISOString(), scanReason: res.scan?.reason || '', elapsedMs: res.scan?.elapsedMs || 0,
      layout: res.scan?.layout, layoutWarnings: res.scan?.layoutWarnings || [] };
    // Per-category layout verdicts from the page (e.g. a variant row with no variant pictures).
    const layoutWarnings = scanInfo.layoutWarnings.filter(code => LAYOUT_WARNINGS.includes(code));
    const emptyTip = (type, fallbackKey) => layoutWarnings.includes(type + '_missing') ? 'crawl_' + type + '_missing' : fallbackKey;
    pageTitle = (res.title && String(res.title).trim()) || '';

    if (productTitleEl) DownloaderI18n.bind(productTitleEl, 'textContent', () => pageTitle || DownloaderI18n.t('m_361df5a39d'));
    if (productTitleEl) productTitleEl.title = pageTitle;
    if (productTitleWrap) productTitleWrap.style.display = 'block';

    const videoItems = currentImages.filter(x => x.type === 'video');
    const mainImgs = currentImages.filter(x => x.type === 'main');
    const detailImgs = currentImages.filter(x => x.type === 'detail');
    const skuImgs = currentImages.filter(x => x.type === 'sku');

    const videoTitle = document.getElementById('videoTitle');
    const videoGrid = document.getElementById('videoGrid');
    const mainGrid = document.getElementById('mainGrid');
    const detailGrid = document.getElementById('detailGrid');

    videoTitle.style.display = 'block';
    DownloaderI18n.bind(document.getElementById('videoCount'), 'textContent', () => videoItems.length);
    if (videoItems.length > 0) {
      renderVideoGrid('videoGrid', videoItems);
    } else {
      videoGrid.innerHTML = '';
      if (!window.DownloaderWorkspaceUI) {
        const tip = document.createElement('div');
        tip.className = 'empty-tip';
        DownloaderI18n.bind(tip, 'textContent', () => DownloaderI18n.t(emptyTip('video', 'm_8fe513dc8a')));
        videoGrid.appendChild(tip);
      }
    }

    DownloaderI18n.bind(document.getElementById('mainCount'), 'textContent', () => mainImgs.length);
    if (mainImgs.length > 0) {
      renderGrid('mainGrid', mainImgs);
    } else {
      mainGrid.innerHTML = '';
      const tip = document.createElement('div');
      tip.className = 'empty-tip';
      DownloaderI18n.bind(tip, 'textContent', () => DownloaderI18n.t(emptyTip('main', 'm_3cb1dee0ad')));
      mainGrid.appendChild(tip);
    }

    DownloaderI18n.bind(document.getElementById('skuCount'), 'textContent', () => skuImgs.length);
    renderGrid('skuGrid', skuImgs);
    if (!skuImgs.length) {
      const tip = document.createElement('div');
      tip.className = 'empty-tip';
      DownloaderI18n.bind(tip, 'textContent', () => DownloaderI18n.t(emptyTip('sku', 'm_c238781d50')));
      document.getElementById('skuGrid').appendChild(tip);
    }

    DownloaderI18n.bind(document.getElementById('detailCount'), 'textContent', () => detailImgs.length);
    if (detailImgs.length > 0) {
      renderGrid('detailGrid', detailImgs);
    } else {
      detailGrid.innerHTML = '';
      const tip = document.createElement('div');
      tip.className = 'empty-tip';
      DownloaderI18n.bind(tip, 'textContent', () => DownloaderI18n.t(emptyTip('detail', 'm_621b772635')));
      detailGrid.appendChild(tip);
    }

    window.DownloaderAssetsUI?.refreshFilter();
    window.DownloaderPreferencesUI?.applySelection();
    resultArea.style.display = 'block';
    zipBtn.style.display = 'block';
    document.getElementById('toolbar').style.display = 'flex';
    DownloaderI18n.bind(status, 'textContent', () => res.scan?.reason === 'cancelled' ? DownloaderI18n.t('m_5d78f733a7') : res.scan?.reason === 'timeout' ? DownloaderI18n.t('m_e3b51810c5') : DownloaderI18n.t('m_7505bf6d88'));
    // The "no video found" hint already lives with the video capture helper below, and a
    // stopped or timed-out scan is already said by the status line above.
    const said = ['m_7242d0dfaa', 'm_943d6d7522', 'm_8d1b875e78'].map(DownloaderI18n.canonical);
    const pageWarnings = (res.scan?.warnings || []).filter(text => !said.includes(text));
    showScanWarnings(pageWarnings, layoutWarnings);
    offerLayoutReport(scannedProduct, layoutWarnings, res.scan?.layoutClasses);
    if (['cancelled', 'timeout'].includes(res.scan?.reason)) window.DownloaderRecoveryUI?.show([() => DownloaderI18n.t('m_cef588473d')]);
    updateDownloadBtn();
    updateUIState();
    // Measure after the panel has laid out the new tools and pictures.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(revealFirstImages));
  });
}
// Layout warnings: one short line each, the full advice one click away, and the capture
// button the advice talks about right inside the box (it also lives in the fold below).
function showScanWarnings(pageWarnings, layoutWarnings) {
  const note = document.getElementById('scanNote');
  DownloaderI18n.clear(note, 'textContent');
  for (const text of pageWarnings) {
    const line = document.createElement('p'); line.className = 'warn-line';
    DownloaderI18n.bind(line, 'textContent', () => DownloaderI18n.legacy(text)); note.appendChild(line);
  }
  for (const code of layoutWarnings) {
    const item = document.createElement('details'); item.className = 'warn-item';
    const summary = document.createElement('summary');
    DownloaderI18n.bind(summary, 'textContent', () => DownloaderI18n.t('warn_' + code));
    const detail = document.createElement('p');
    DownloaderI18n.bind(detail, 'textContent', () => DownloaderI18n.t('crawl_' + code));
    item.appendChild(summary); item.appendChild(detail); note.appendChild(item);
  }
  document.getElementById('warnSupplementBtn').hidden = !layoutWarnings.some(code => ['sku_missing', 'detail_missing', 'video_missing'].includes(code));
  document.getElementById('scanWarning').hidden = !pageWarnings.length && !layoutWarnings.length;
}
document.getElementById('warnSupplementBtn')?.addEventListener('click', () => document.getElementById('supplementBtn').click());
// Ask once whether to tell the developer anonymously that this page was not read well.
function offerLayoutReport(product, codes, classes) {
  if (!codes.length || !window.DownloaderLayoutReportUI) return;
  window.DownloaderLayoutReportUI.offer({ productKey: product.productKey, platform: product.key, codes, classes: classes || [],
    version: chrome.runtime.getManifest?.()?.version || '' });
}

function renderVideoGrid(containerId, items, { append = false, offset = 0, selected = true } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!append) container.innerHTML = '';
  items.forEach((item, index) => {
    const div = document.createElement('div');
    div.className = 'image-item img-box video-box' + (selected ? ' selected' : '');
    div.dataset.type = 'video';
    div.dataset.url = item.src;
    div.dataset.sequence = String(offset + index + 1);
    const img = document.createElement('img');
    img.src = item.poster || item.src || '';
    img.alt = '';
    img.loading = 'eager';
    img.onerror = () => { img.style.display = 'none'; };
    div.appendChild(img);
    const label = document.createElement('span');
    label.className = 'video-label';
    DownloaderI18n.bind(label, 'textContent', () => DownloaderI18n.t('item_video'));
    div.appendChild(label);
    div.addEventListener('click', () => {
      if (downloadInProgress || scanInProgress || isQueueRunning() || isAssetInspectionRunning()) return;
      div.classList.toggle('selected');
      selectionTouched = true;
      updateDownloadBtn();
      updateUIState();
    });
    container.appendChild(div);
  });
}

function renderGrid(containerId, images, { append = false, offset = 0, selected = true } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!append) container.innerHTML = '';
  images.forEach((imgData, index) => {
    const div = document.createElement('div');
    // A description poster linking to another product is shown but not selected.
    const otherProduct = imgData.type === 'detail' && imgData.otherProduct === true;
    div.className = 'image-item img-box' + (selected && !otherProduct ? ' selected' : '') + (imgData.type === 'sku' ? ' sku-box' : '');
    if (otherProduct) div.dataset.otherProduct = '1';
    div.dataset.type = imgData.type;
    div.dataset.url = imgData.url;
    div.dataset.sequence = String(offset + index + 1);
    div.dataset.labels = JSON.stringify(imgData.labels || []);
    div.dataset.variants = JSON.stringify(imgData.variants || []);
    div.dataset.fallbackUrls = JSON.stringify(imgData.fallbackUrls || []);
    window.DownloaderAssetsUI?.register(div);
    const img = document.createElement('img');
    img.src = imgData.url;
    img.alt = '';
    img.loading = 'eager';
    // The panel already shows the full-size file, so its real size is free to read. It goes
    // into the tile's one size label, which the size filter later completes with the format.
    img.onload = () => {
      // A picture under 50 px on a side (e.g. a deleted picture that now answers with a 1×1
      // transparent pixel) is never product material: it leaves the list instead of being labelled.
      if (imgData.type !== 'sku' && (img.naturalWidth < 50 || img.naturalHeight < 50)) { dropTile(div); return; }
      if (img.naturalWidth > 1) window.DownloaderAssetsUI?.showSize(div, img.naturalWidth, img.naturalHeight);
      // Checked on the picture the panel already shows: no extra download.
      if (imgData.type !== 'sku' && DownloaderAssets.looksBlank({ width: img.naturalWidth, height: img.naturalHeight, pixels: samplePixels(img) })) markMaybeBlank(div);
    };
    let previewFallback = 0;
    img.onerror = () => {
      const alternative = JSON.parse(div.dataset.fallbackUrls || '[]')[previewFallback++];
      if (alternative) img.src = alternative;
      // The panel could not show it, but the download fetches it again: it stays selected, labelled so the tile is not a mystery.
      else { img.style.display = 'none'; labelTile(div, 'preview_missing', 'm_758c10fd76'); }
    };
    div.appendChild(img);
    if (otherProduct) {
      const label = document.createElement('span');
      label.className = 'sku-label other-product-label';
      DownloaderI18n.bind(label, 'textContent', () => DownloaderI18n.t('crawl_otherProduct'));
      DownloaderI18n.bind(div, 'title', () => DownloaderI18n.t('crawl_otherProductHint'));
      div.appendChild(label);
    }
    if (imgData.type === 'sku') {
      const label = document.createElement('span');
      label.className = 'sku-label';
      DownloaderI18n.bind(label, 'textContent', () => imgData.labels?.length ? imgData.labels.join('／') : DownloaderI18n.t('m_49e9e40a8c', [offset + index + 1]));
      DownloaderI18n.bind(div, 'title', () => label.textContent);
      div.appendChild(label);
    }
    div.addEventListener('click', () => {
      if (downloadInProgress || scanInProgress || isQueueRunning() || isAssetInspectionRunning()) return;
      div.classList.toggle('selected');
      div.dataset.userPicked = '1';
      selectionTouched = true;
      updateDownloadBtn();
      updateUIState();
    });
    container.appendChild(div);
  });
}
function dropTile(div) {
  if (div.dataset.dropped) return;
  div.dataset.dropped = '1';
  div.classList.remove('selected');
  const type = div.dataset.type;
  (div.parentElement?.classList?.contains('media-tile') ? div.parentElement : div).remove();
  const index = currentImages.findIndex(item => item.type === type && (item.url || item.src) === div.dataset.url);
  if (index >= 0) currentImages.splice(index, 1);
  // Keep file numbers continuous (主圖_001, 002, …) for the pictures that remain.
  let sequence = 0;
  for (const node of document.querySelectorAll('.image-item')) if (node.dataset.type === type && !node.dataset.dropped) node.dataset.sequence = String(++sequence);
  DownloaderI18n.bind(document.getElementById(type + 'Count'), 'textContent', () => currentImages.filter(item => item.type === type).length);
  window.DownloaderAssetsUI?.refreshFilter();
  updateDownloadBtn();
  updateUIState();
}
// A small downscaled copy of the shown picture; null when the browser refuses to let it be read.
function samplePixels(img) {
  try {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 24;
    const context = canvas.getContext?.('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(img, 0, 0, 24, 24);
    return context.getImageData(0, 0, 24, 24).data;
  } catch (_) { return null; }
}
// A picture that looks blank (or shows nothing at all) is listed but not selected, with a short
// label saying why; the customer can still select it. A pick the customer made stays as it is.
function markMaybeBlank(div) {
  if (div.dataset.maybeBlank) return;
  div.dataset.maybeBlank = '1';
  if (!div.dataset.userPicked) div.classList.remove('selected');
  labelTile(div, 'blank_label', 'blank_hint');
  updateDownloadBtn();
  updateUIState();
}
function labelTile(div, labelKey, hintKey) {
  if (!div.dataset.otherProduct && !div.classList.contains('sku-box') && !div.dataset.tileNote) {
    div.dataset.tileNote = labelKey;
    const label = document.createElement('span');
    label.className = 'sku-label blank-label';
    DownloaderI18n.bind(label, 'textContent', () => DownloaderI18n.t(labelKey));
    div.appendChild(label);
  }
  DownloaderI18n.bind(div, 'title', () => DownloaderI18n.t(hintKey));
}

function updateDownloadBtn() {
  window.DownloaderAssetsUI?.syncBusy();
  window.DownloaderWorkspaceUI?.syncBusy();
  window.DownloaderFlowUI?.sync();
  const count = selectedVisible().length;
  const zipBtn = document.getElementById('zipBtn');
  if (!zipBtn) return;
  zipBtn.disabled = downloadInProgress || scanInProgress || isQueueRunning() || isAssetInspectionRunning() || count === 0;
  const retry = document.getElementById('retryDownloadBtn');
  retry.hidden = failedTargets.length === 0;
  retry.disabled = downloadInProgress || scanInProgress || isQueueRunning() || isAssetInspectionRunning();
  DownloaderI18n.bind(retry, 'textContent', () => DownloaderI18n.t('m_f527c05438', [failedTargets.length]));
  if (downloadInProgress) DownloaderI18n.bind(zipBtn, 'textContent', () => DownloaderI18n.t('m_669e0296c2'));
  else DownloaderI18n.bind(zipBtn, 'textContent', () => count ? DownloaderI18n.t('m_faad9b50e4', [count]) : DownloaderI18n.t('m_eda8de77be'));
}

// One item at a time ("Main image 2"), so the names are singular; the reasons are the
// shared plain words (recovery.js), and the support report keeps the exact codes.
const ITEM_KEYS = { main: 'item_main', sku: 'item_sku', detail: 'item_detail', video: 'item_video' };

async function downloadProductAssets({ targets, source, title, scanInfo, retry = false, output = {}, onProgress }) {
  const result = await DownloaderDownload.run({
      output, convertImage: DownloaderAssets.createProcessor().convert,
      targets,
      context: { title, pageUrl: source.pageUrl, ...scanInfo, retry,
        extensionVersion: chrome.runtime.getManifest?.()?.version || '' },
      fetchMedia: (url, kind) => DownloaderMedia.fetchMedia(url, kind),
      // The page fetches the blob itself (idle timeout 45 s), so allow longer
      // than a plain message; a frozen tab fails this item instead of hanging.
      downloadBlob: target => DownloaderQueueWorker.askTab(chrome, source.tabId, {
        action: 'downloadBlobMedia', url: target.url, index: target.index, sequence: target.sequence,
        documentToken: source.documentToken, pageUrl: source.pageUrl
      }, 60000),
      makeZip: () => new JSZip(),
      saveZip: content => {
        const objectUrl = URL.createObjectURL(content);
        try {
          const a = document.createElement('a');
          a.href = objectUrl;
          a.download = DownloaderArchive.archiveName(title, source.pageUrl, retry);
          document.body.appendChild(a);
          a.click();
          a.remove();
        } finally { setTimeout(() => URL.revokeObjectURL(objectUrl), 60000); }
      },
      onProgress
    });
  window.DownloaderAssetsUI?.recordDownload(result, source.pageUrl, output);
  return result;
}

async function runSelectedDownload(targets, retry = false) {
  if (window.DownloaderQueueUI) {
    try {
      const locked = await window.DownloaderQueueUI.exclusive(() => performSelectedDownload(targets, retry));
      if (!locked.acquired) DownloaderI18n.bind(document.getElementById('status'), 'textContent', () => DownloaderI18n.t('m_8b0df53c66'));
    } catch (error) { DownloaderI18n.bind(document.getElementById('status'), 'textContent', () => DownloaderI18n.plain(error.message, 'm_56f241063d') || DownloaderI18n.t('m_56f241063d')); }
    return;
  }
  return performSelectedDownload(targets, retry);
}

async function performSelectedDownload(targets, retry = false) {
  await window.DownloaderPreferencesUI?.ready;
  if (downloadInProgress || scanInProgress || isQueueRunning() || isAssetInspectionRunning() || targets.length === 0) return;
  const status = document.getElementById('status');
  // A page problem is one red box under the scan button: what happened and the one thing to do.
  const pageProblem = key => {
    setStatusTone('error'); DownloaderI18n.bind(status, 'textContent', () => DownloaderI18n.t(key));
    // A closed or changed page cannot be retried either, so the old result and its retry
    // button go away instead of contradicting the "rescan" advice. A slow page keeps them.
    if (key !== 'm_404a057f84') { failedTargets = []; window.DownloaderWorkspaceUI?.clearResult(); updateDownloadBtn(); }
  };
  if (currentScanTabId == null || !currentScanContext) { pageProblem('dl_pageChanged'); return; }
  downloadInProgress = true;
  setStatusTone(null);
  updateDownloadBtn(); window.DownloaderQueueUI?.refresh();
  const source = { ...currentScanContext, tabId: currentScanTabId };
  const title = pageTitle;
  const output = retry ? failedOutput : window.DownloaderAssetsUI?.getOutput() || {};
  try {
    // A closed, frozen or discarded tab must neither hold this download nor show Chrome's own error text.
    let latest;
    try { latest = await DownloaderQueueWorker.askTab(chrome, source.tabId, { action: 'mediaContext' }, PAGE_CHECK_TIMEOUT_MS); }
    catch (error) { pageProblem(error?.code === 'TAB_TIMEOUT' ? 'm_404a057f84' : 'dl_pageGone'); return; }
    // Same loaded page and same product; choosing a style only adds &skuId=… to the address.
    if (!latest?.ok || !DownloaderPlatforms.samePage(latest, source)) { pageProblem('dl_pageChanged'); return; }
    window.DownloaderWorkspaceUI?.clearResult();
    window.DownloaderRecoveryUI?.show([]);
    const result = await downloadProductAssets({ targets, source, title, scanInfo, retry, output,
      onProgress: (done, total) => { DownloaderI18n.bind(status, 'textContent', () => DownloaderI18n.t('m_f04727c351', [done, total])); } });
    failedTargets = result.failed.map(item => item.target);
    failedOutput = output;
    // The receipt in the download area says what happened; the top line does not repeat it.
    DownloaderI18n.clear(status, 'textContent');
    const issues = [...result.failed.map(item => ({ ...item, kind: 'failed' })), ...result.unconfirmed.map(item => ({ ...item, kind: 'unconfirmed' })),
      ...(result.fallbacks || []).map(item => ({ ...item, kind: 'fallback' })), ...(result.conversionWarnings || []).map(item => ({ ...item, kind: 'copy' }))];
    const reasons = issues.map(item => () => DownloaderI18n.t('dl_issueItem', [DownloaderI18n.t(ITEM_KEYS[item.target.type] || 'item_detail'),
      item.target.sequence || item.target.index + 1, DownloaderI18n.t(DownloaderRecovery.reasonKey(item))]));
    // The receipt already gives the retry-first advice; only advice that differs is kept.
    const advice = DownloaderRecovery.forResult(result).filter(step => step !== DownloaderRecovery.RETRY_FIRST);
    if (result.unconfirmed.length) advice.push(() => DownloaderI18n.t('m_17f8a47fe3'));
    window.DownloaderWorkspaceUI?.showResult?.(result, reasons, advice);
  } catch (error) {
    setStatusTone('error');
    // An empty message still gets the plain sentence, never an empty red box.
    DownloaderI18n.bind(status, 'textContent', () => DownloaderI18n.plain(error?.message, 'dl_unexpected') || DownloaderI18n.t('dl_unexpected'));
  } finally {
    downloadInProgress = false;
    updateUIState(); window.DownloaderQueueUI?.refresh();
  }
}

document.getElementById('zipBtn').addEventListener('click', () => {
  const selected = selectedVisible();
  const targets = Array.from(selected, (el, index) => ({
    url: el.dataset.url,
    fallbackUrls: JSON.parse(el.dataset.fallbackUrls || '[]'),
    sequence: Number(el.dataset.sequence),
    labels: JSON.parse(el.dataset.labels || '[]'),
    variants: JSON.parse(el.dataset.variants || '[]'),
    type: el.dataset.type || (el.parentElement?.id === 'mainGrid' ? 'main' : 'detail'),
    index
  }));
  return runSelectedDownload(targets);
});
document.getElementById('retryDownloadBtn').addEventListener('click', () => runSelectedDownload([...failedTargets], true));

// Re-render download controls when the interface language changes.
DownloaderI18n.subscribe(() => updateUIState());
