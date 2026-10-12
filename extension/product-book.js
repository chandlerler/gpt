'use strict';
(function (root) {
  const platforms = root.DownloaderPlatforms || (typeof require === 'function' ? require('./platforms.js') : null);
  const STORAGE_KEY = 'productSourcingBookV1', BACKUP_KEY = 'productSourcingBookV1Backup', WRITE_LOCK = 'product-sourcing-book-write-v1';
  const MAX_CARDS = 100, MAX_BYTES = 3000000, MAX_MEDIA = 2000, MAX_VARIANTS = 500;
  const STATUSES = ['candidate', 'contacted', 'purchased'];
  const TYPES = ['main', 'sku', 'detail', 'video'];
  const fail = code => { const e = new Error(code); e.code = code; throw e; };
  const text = (value, max = 300) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '';
  function reference(value) {
    try {
      const u = new URL(value);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port) return '';
      return (u.origin + u.pathname).length <= 4000 ? u.origin + u.pathname : '';
    } catch (_) { return ''; }
  }
  function supplierLink(value) {
    if (!value) return '';
    const ref = reference(value);
    if (!ref) fail('book_bad_supplier');
    const hostname = new URL(ref).hostname;
    if (!['taobao.com', 'tmall.com', 'tmall.hk', '1688.com'].some(h => hostname === h || hostname.endsWith('.' + h))) fail('book_bad_supplier');
    const input = new URL(value), result = new URL(ref);
    for (const key of ['user_number_id', 'shop_id', 'id']) {
      const id = input.searchParams.get(key);
      if (/^\d{1,30}$/.test(id || '')) result.searchParams.set(key, id);
    }
    return result.href;
  }
  function fromScan({ pageUrl, title, scannedAt, items }, previous = null, now = new Date().toISOString()) {
    const source = platforms.identify(pageUrl);
    if (!source || !Array.isArray(items)) fail('book_no_scan');
    if (previous && previous.productKey !== source.productKey) fail('book_wrong_product');
    if (items.length > MAX_MEDIA) fail('book_too_large');
    const counts = {}, media = [], current = new Map();
    for (const item of items) {
      if (!TYPES.includes(item?.type)) continue;
      const sequence = counts[item.type] = (counts[item.type] || 0) + 1;
      const url = reference(item.url);
      // Blob URLs are page-lifetime handles, not durable media references.
      media.push({ type: item.type, sequence, source: url, temporary: /^blob:/.test(item.url || '') });
      if (item.type !== 'sku') continue;
      const pairs = Array.isArray(item.variants) && item.variants.length ? item.variants :
        (Array.isArray(item.labels) && item.labels.length ? item.labels.map(label => ({ label })) : [{}]);
      for (const pair of pairs) {
        const sourceId = text(pair?.id, 120), sourceLabel = text(pair?.label, 120);
        // Never zip independent label/ID arrays: their original pairing may be unknown.
        const key = JSON.stringify(sourceId ? ['id', sourceId, sourceLabel] : ['image', url || String(sequence), sourceLabel]);
        const row = current.get(key) || { key, sourceId, sourceLabel, images: [], ownSku: '', ownName: '', confirmed: false, lastSeenAt: scannedAt || now };
        if (url && !row.images.includes(url)) row.images.push(url);
        current.set(key, row);
      }
    }
    const old = new Map((previous?.variants || []).map(row => [row.key, row]));
    const variants = [...current.values()].map(row => {
      const prior = old.get(row.key);
      const sameImages = prior && prior.images.length === row.images.length && row.images.every(url => prior.images.includes(url));
      return prior ? { ...row, ownSku: prior.ownSku, ownName: prior.ownName, confirmed: prior.confirmed && sameImages } : row;
    });
    // A partial scan must not erase previously saved supplier mappings.
    for (const row of old.values()) if (!current.has(row.key)) variants.push({ ...row, seenInLatest: false });
    for (const row of variants) if (current.has(row.key)) row.seenInLatest = true;
    if (variants.length > MAX_VARIANTS) fail('book_too_large');
    return {
      schemaVersion: 1, productKey: source.productKey, platform: source.key, productId: source.id,
      sourceUrl: source.url, sourceTitle: text(title), capturedAt: scannedAt || now,
      createdAt: previous?.createdAt || now, updatedAt: previous?.updatedAt || '', revision: previous?.revision || 0,
      displayName: previous?.displayName || '', supplierName: previous?.supplierName || '', supplierUrl: previous?.supplierUrl || '',
      status: previous?.status || 'candidate', notes: previous?.notes || '', media, variants
    };
  }
  function normalize(card) {
    const source = platforms.identifyStored(card?.sourceUrl);
    if (card?.schemaVersion !== 1 || !source || card.productKey !== source.productKey ||
        !Number.isSafeInteger(card.revision) || card.revision < 0 || !Array.isArray(card.media) || !Array.isArray(card.variants)) fail('book_corrupt');
    if (card.media.length > MAX_MEDIA || card.variants.length > MAX_VARIANTS) fail('book_too_large');
    const variants = card.variants.map(row => {
      if (typeof row?.key !== 'string' || !row.key || row.key.length > 4500 || !Array.isArray(row.images) || row.images.length > MAX_MEDIA) fail('book_corrupt');
      return { key: row.key, sourceId: text(row.sourceId, 120), sourceLabel: text(row.sourceLabel, 120),
        images: [...new Set(row.images.map(reference).filter(Boolean))], ownSku: text(row.ownSku, 80), ownName: text(row.ownName, 120),
        confirmed: row.confirmed === true, seenInLatest: row.seenInLatest === true, lastSeenAt: text(row.lastSeenAt, 40) };
    });
    if (new Set(variants.map(r => r.key)).size !== variants.length) fail('book_corrupt');
    return { schemaVersion: 1, productKey: source.productKey, platform: source.key, productId: source.id, sourceUrl: source.url,
      sourceTitle: text(card.sourceTitle), capturedAt: text(card.capturedAt, 40), createdAt: text(card.createdAt, 40), updatedAt: text(card.updatedAt, 40), revision: card.revision,
      displayName: text(card.displayName), supplierName: text(card.supplierName, 160), supplierUrl: supplierLink(text(card.supplierUrl, 4000)),
      status: STATUSES.includes(card.status) ? card.status : 'candidate', notes: text(card.notes, 3000), variants,
      media: card.media.map(row => {
        if (!TYPES.includes(row?.type) || !Number.isSafeInteger(row.sequence) || row.sequence < 1) fail('book_corrupt');
        return { type: row.type, sequence: row.sequence, source: reference(row.source), temporary: row.temporary === true };
      }) };
  }
  function createManager({ storage, locks, now = () => new Date().toISOString() }) {
    async function read() {
      const value = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
      if (value === undefined) return { version: 1, cards: [] };
      if (value?.version !== 1 || !Array.isArray(value.cards)) fail('book_corrupt');
      // One damaged card must not hide every other note: skip it (and any
      // duplicate), keep the rest, and save the untouched original for support.
      const cards = [], seen = new Set();
      for (const raw of value.cards) {
        let card;
        try { card = normalize(raw); } catch (_) { continue; }
        if (seen.has(card.productKey) || cards.length >= MAX_CARDS) continue;
        seen.add(card.productKey); cards.push(card);
      }
      if (cards.length !== value.cards.length) {
        try { await storage.set({ [BACKUP_KEY]: { savedAt: now(), value } }); } catch (_) { /* best effort */ }
      }
      return { version: 1, cards };
    }
    async function mutate(task) {
      if (!locks?.request) fail('book_no_lock');
      return locks.request(WRITE_LOCK, async () => {
        const state = await read(), result = task(state);
        if (new TextEncoder().encode(JSON.stringify(state)).length > MAX_BYTES) fail('book_too_large');
        await storage.set({ [STORAGE_KEY]: state });
        return { state, card: result };
      });
    }
    function save(input) {
      const draft = normalize(input);
      return mutate(state => {
        const index = state.cards.findIndex(c => c.productKey === draft.productKey), previous = state.cards[index];
        if ((previous?.revision || 0) !== draft.revision) fail('book_conflict');
        if (index < 0 && state.cards.length >= MAX_CARDS) fail('book_full');
        const card = { ...draft, revision: draft.revision + 1, createdAt: previous?.createdAt || now(), updatedAt: now() };
        if (index < 0) state.cards.push(card); else state.cards[index] = card;
        return card;
      });
    }
    function remove(productKey, revision) {
      return mutate(state => {
        const index = state.cards.findIndex(c => c.productKey === productKey);
        if (index < 0 || state.cards[index].revision !== revision) fail('book_conflict');
        state.cards.splice(index, 1);
        return null;
      });
    }
    return { read, save, remove };
  }
  function csvCell(value) {
    let valueText = String(value ?? '');
    if (/^[\s\u0000-\u001f]*[=+\-@]/.test(valueText) || /^[\t\r\n]/.test(valueText)) valueText = "'" + valueText;
    return '"' + valueText.replace(/"/g, '""') + '"';
  }
  function exportsFor(input, t = key => key) {
    const card = normalize(input);
    const header = ['book_source_id','book_source_option','book_own_sku','book_own_name','book_confirmed','book_seen','book_image_sources'];
    const rows = card.variants.map(row => [row.sourceId, row.sourceLabel, row.ownSku, row.ownName,
      t(row.confirmed ? 'book_yes' : 'book_no'), t(row.seenInLatest ? 'book_yes' : 'book_no'), row.images.join('\n')]);
    return { json: JSON.stringify(card, null, 2),
      csv: '\uFEFF' + [header.map(t), ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n',
      note: t('book_export_note') };
  }
  root.DownloaderProductBook = { STORAGE_KEY, BACKUP_KEY, WRITE_LOCK, MAX_CARDS, MAX_BYTES, fromScan, normalize, createManager, exportsFor };
  if (typeof module !== 'undefined') module.exports = root.DownloaderProductBook;
})(globalThis);
