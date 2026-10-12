'use strict';
(function () {
  const el = id => document.getElementById(id), registered = new WeakSet();
  const dialog = el('imagePreview'), image = el('previewImage');
  let opener = null;
  function close() { if (dialog.open) dialog.close(); }
  dialog.addEventListener('close', () => {
    image.removeAttribute('src');
    if (opener?.isConnected) opener.focus();
    opener = null;
  });
  el('closeImagePreview').addEventListener('click', close);
  image.addEventListener('error', () => { el('previewImageError').hidden = false; });
  image.addEventListener('load', () => { el('previewImageError').hidden = true; });
  function sync() {
    if (dialog.open && !opener?.isConnected) close();
    for (const card of document.querySelectorAll('.image-item')) {
      if (card.dataset.type === 'video' || registered.has(card)) continue;
      registered.add(card);
      // Siblings keep preview and checkbox semantics independent.
      const tile = document.createElement('div'); tile.className = 'media-tile';
      card.parentElement.insertBefore(tile, card); tile.appendChild(card);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'image-preview-button';
      DownloaderI18n.bind(button, 'textContent', () => DownloaderI18n.t('ux_previewImage'));
      // Named like the tile it opens, e.g. “放大款式圖 1 霧白”.
      DownloaderI18n.bind(button, 'aria-label', () => {
        const key = { main: 'item_main', sku: 'item_sku', detail: 'item_detail' }[card.dataset.type] || 'item_detail';
        const labels = JSON.parse(card.dataset.labels || '[]');
        return DownloaderI18n.t('ux_previewImageLabel', [DownloaderI18n.t(key) + ' ' + card.dataset.sequence + (labels.length ? ' ' + labels.join(' / ') : '')]);
      });
      button.addEventListener('click', () => {
        const thumbnail = card.querySelector('img');
        const source = thumbnail?.currentSrc || thumbnail?.src;
        if (!source) return;
        opener = button;
        el('previewImageError').hidden = true;
        image.alt = card.getAttribute('aria-label') || '';
        image.src = source;
        dialog.showModal();
      });
      tile.appendChild(button);
    }
    for (const card of document.querySelectorAll('.image-item')) {
      if (card.parentElement?.className === 'media-tile') card.parentElement.hidden = card.hidden;
    }
  }
  window.DownloaderImagePreview = { sync };
  sync();
})();
