'use strict';
(function () {
  const el = id => document.getElementById(id), I = DownloaderI18n, B = DownloaderProductBook;
  const manager = B.createManager({ storage: chrome.storage.local, locks: navigator.locks });
  const fields = { displayName: 'bookName', supplierName: 'bookSupplier', supplierUrl: 'bookSupplierUrl', status: 'bookStage', notes: 'bookNotes' };
  let state = { cards: [] }, draft = null, dirty = false, loading = true, available = false, rowInputs = [];
  const say = (key, values = []) => I.bind(el('bookStatus'), 'textContent', () => I.t(key, values));
  const translate = (node, key) => I.bind(node, 'textContent', () => I.t(key));
  const bind = (id, key, values = []) => I.bind(el(id), 'textContent', () => I.t(key, values));
  const pageBusy = () => scanInProgress || downloadInProgress || isQueueRunning() || isAssetInspectionRunning();
  function syncBusy() {
    const product = DownloaderPlatforms.identify(currentScanContext?.pageUrl);
    const canCapture = !!product && currentImages.length > 0;
    const editingCurrent = !!draft && product?.productKey === draft.productKey && draft.capturedAt === scanInfo.scannedAt;
    el('bookCurrentCard').hidden = !scanInProgress && (!canCapture || editingCurrent);
    el('bookCapture').disabled = loading || !available || pageBusy() || !canCapture;
    el('bookSelect').disabled = loading || !available;
    el('bookReload').disabled = loading;
    el('bookSave').disabled = loading || !available || !draft || !dirty;
    el('bookExport').disabled = loading || !draft?.revision || dirty;
    el('bookDelete').disabled = loading || !draft?.revision;
    for (const id of Object.values(fields)) el(id).disabled = loading || !draft;
    for (const row of rowInputs) for (const input of [row.ownSku, row.ownName, row.confirmed]) input.disabled = loading;
    el('bookLibrary').hidden = available && !loading && !state.cards.length;
    el('bookEmpty').hidden = !available || loading || !!draft || state.cards.length > 0;
    bind('bookCurrentProduct', scanInProgress ? 'flow_bookScanning' : canCapture ? 'flow_bookCurrent' : 'flow_bookNoScan', [pageTitle || product?.id || '']);
    bind('bookCapture', canCapture && state.cards.some(card => card.productKey === product.productKey) ? 'flow_bookUpdate' : 'book_capture');
    el('bookDraftState').hidden = !draft;
    el('bookDraftState').dataset.state = dirty ? 'unsaved' : 'saved';
    bind('bookDraftState', dirty ? 'flow_bookUnsaved' : 'flow_bookSaved');
    el('bookExportHelp').hidden = !draft;
    bind('bookExportHelp', dirty || !draft?.revision ? 'flow_bookExportSave' : 'flow_bookExportReady');
  }
  // "淘寶・商品編號 380001" instead of the internal "taobao 380001".
  const PLATFORM_KEYS = { taobao: 'm_bd01d8b18f', tmall: 'm_1bfaa1ef73', tmallhk: 'plat_tmallhk' };
  const productLabel = card => I.t('book_productLabel', [PLATFORM_KEYS[card.platform] ? I.t(PLATFORM_KEYS[card.platform]) : I.t('ux_retiredPlatform'), card.productId]);
  function markDirty() { dirty = true; say('book_unsaved'); syncBusy(); }
  function renderList() {
    const select = el('bookSelect'); select.innerHTML = '';
    const option = document.createElement('option'); option.value = ''; translate(option, 'book_choose'); select.appendChild(option);
    for (const card of [...state.cards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      const choice = document.createElement('option'); choice.value = card.productKey;
      I.bind(choice, 'textContent', () => `${card.displayName || card.sourceTitle || card.productId} · ${productLabel(card)}`);
      select.appendChild(choice);
    }
    select.value = draft?.revision ? draft.productKey : '';
    const count = state.cards.length;
    I.bind(el('bookCount'), 'textContent', () => I.t('book_count', [count, B.MAX_CARDS]));
  }
  function renderDraft() {
    // A question still open was about the note that is leaving the screen: treat it as Cancel.
    answer?.(false);
    el('bookEditor').hidden = !draft;
    rowInputs = [];
    el('bookVariants').innerHTML = '';
    if (!draft) { syncBusy(); return; }
    for (const [field, id] of Object.entries(fields)) el(id).value = draft[field];
    const current = draft;
    I.bind(el('bookSource'), 'textContent', () => `${productLabel(current)} · ${current.sourceTitle}`);
    el('bookSource').href = current.sourceUrl;
    I.bind(el('bookSnapshot'), 'textContent', () => I.t('book_snapshot', [new Date(current.capturedAt).toLocaleString(I.domLocale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), current.media.length, current.variants.length]));
    if (!draft.variants.length) {
      const message = document.createElement('p'); message.className = 'hint'; translate(message, 'book_no_variants'); el('bookVariants').appendChild(message);
    }
    for (const row of draft.variants) {
      const container = document.createElement('div'); container.className = 'book-variant';
      const source = document.createElement('p'); source.className = 'book-variant-source';
      source.textContent = [row.sourceLabel, row.sourceId].filter(Boolean).join(' · ');
      if (!source.textContent) translate(source, 'book_unnamed');
      container.appendChild(source);
      if (!row.seenInLatest) {
        const note = document.createElement('p'); note.className = 'hint book-stale'; translate(note, 'book_not_seen'); container.appendChild(note);
      }
      const pictures = document.createElement('div'); pictures.className = 'book-pictures';
      for (const url of row.images) {
        const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        const img = document.createElement('img'); img.src = url; img.alt = row.sourceLabel || row.sourceId; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
        a.appendChild(img); pictures.appendChild(a);
      }
      container.appendChild(pictures);
      const inputs = { row };
      for (const [name, key, limit] of [['ownSku', 'book_own_sku', 80], ['ownName', 'book_own_name', 120]]) {
        const label = document.createElement('label'), caption = document.createElement('span'), input = document.createElement('input');
        translate(caption, key); input.type = 'text'; input.maxLength = limit; input.value = row[name];
        label.appendChild(caption); label.appendChild(input); container.appendChild(label); inputs[name] = input;
        input.addEventListener('input', () => { inputs.confirmed.checked = false; markDirty(); });
      }
      const label = document.createElement('label'); label.className = 'book-confirm';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = row.confirmed;
      const caption = document.createElement('span'); translate(caption, 'book_confirm_label');
      label.appendChild(checkbox); label.appendChild(caption); container.appendChild(label);
      checkbox.addEventListener('change', markDirty); inputs.confirmed = checkbox; rowInputs.push(inputs);
      el('bookVariants').appendChild(container);
    }
    syncBusy();
  }
  // Questions are asked inside the panel, next to what was clicked, never in a browser dialog.
  // An answer goes back to the control that asked; Esc is the same as Cancel.
  let answer = null;
  function ask(anchor, textKey, yesKey, opener = anchor) {
    answer?.(false);
    const box = el('bookConfirm');
    I.bind(el('bookConfirmText'), 'textContent', () => I.t(textKey));
    I.bind(el('bookConfirmYes'), 'textContent', () => I.t(yesKey));
    anchor?.after?.(box);
    box.hidden = false;
    el('bookConfirmNo').focus?.();
    return new Promise(resolve => { answer = value => { answer = null; box.hidden = true; opener?.focus?.(); resolve(value); }; });
  }
  el('bookConfirmYes').addEventListener('click', () => answer?.(true));
  el('bookConfirmNo').addEventListener('click', () => answer?.(false));
  el('bookConfirm').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault?.(); answer?.(false); } });
  async function discardOK(anchor, opener) { return !dirty || ask(anchor, 'book_discard', 'book_discardYes', opener); }
  function currentForm() {
    return { ...draft, ...Object.fromEntries(Object.entries(fields).map(([field, id]) => [field, el(id).value])),
      variants: rowInputs.map(input => ({ ...input.row, ownSku: input.ownSku.value, ownName: input.ownName.value, confirmed: input.confirmed.checked })) };
  }
  function failure(error) {
    const key = typeof error?.code === 'string' && error.code.startsWith('book_') ? error.code : 'book_storage_error';
    say(key);
  }
  async function load({ initial = false } = {}) {
    if (!initial && (loading || !(await discardOK(el('bookReload'))))) return;
    loading = true; syncBusy();
    try {
      const next = await manager.read(); state = next; available = true;
      draft = draft ? structuredClone(state.cards.find(c => c.productKey === draft.productKey) || null) : null;
      dirty = false; renderList(); renderDraft();
      // Nothing to open yet: the empty-state card already explains what to do.
      if (state.cards.length) say('book_ready'); else I.clear(el('bookStatus'), 'textContent');
    } catch (error) { failure(error); }
    finally { loading = false; syncBusy(); }
  }
  async function capture() {
    if (el('bookCapture').disabled || !(await discardOK(el('bookCapture')))) return;
    const snapshot = { pageUrl: currentScanContext.pageUrl, title: pageTitle, scannedAt: scanInfo.scannedAt,
      items: structuredClone(currentImages) };
    loading = true; syncBusy();
    try {
      const next = await manager.read(), key = DownloaderPlatforms.identify(snapshot.pageUrl).productKey;
      const existing = next.cards.find(c => c.productKey === key);
      const captured = B.fromScan(snapshot, existing);
      state = next; draft = captured; dirty = true;
      // "Your own fields are kept" only makes sense when there was a saved note to keep them from.
      renderList(); renderDraft(); say(existing ? 'book_captured' : 'book_capturedNew');
    } catch (error) { failure(error); }
    finally { loading = false; syncBusy(); }
  }
  async function save() {
    if (loading || !draft || !dirty) return;
    const input = currentForm(); loading = true; syncBusy();
    try {
      const result = await manager.save(input); state = result.state; draft = result.card; dirty = false;
      renderList(); renderDraft(); say('book_saved');
    } catch (error) { failure(error); }
    finally { loading = false; syncBusy(); }
  }
  async function remove() {
    if (loading || !draft?.revision) return;
    // Remember which note was asked about; if another note is open by the time of the answer, delete nothing.
    const asked = { productKey: draft.productKey, revision: draft.revision };
    if (!(await ask(el('bookDelete'), 'book_delete_confirm', 'book_delete'))) return;
    if (loading || draft?.productKey !== asked.productKey || draft?.revision !== asked.revision) return;
    loading = true; syncBusy();
    try {
      const result = await manager.remove(draft.productKey, draft.revision);
      state = result.state; draft = null; dirty = false; renderList(); renderDraft(); say('book_deleted');
    } catch (error) { failure(error); }
    finally { loading = false; syncBusy(); }
  }
  async function exportCard() {
    if (loading || !draft?.revision || dirty) return;
    const card = structuredClone(draft); loading = true; syncBusy();
    try {
      const exported = B.exportsFor(card, key => I.t(key)), zip = new JSZip();
      zip.file('product-card.json', exported.json); zip.file('variant-mapping.csv', exported.csv); zip.file('README.txt', exported.note);
      const blob = await zip.generateAsync({ type: 'blob' }), url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a'); a.href = url; a.download = `product-card_${card.platform}_${card.productId}.zip`;
        document.body.appendChild(a); a.click(); a.remove(); say('book_exported');
      } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
    } catch (_) { say('book_export_error'); }
    finally { loading = false; syncBusy(); }
  }
  for (const id of Object.values(fields)) {
    el(id).addEventListener('input', markDirty); el(id).addEventListener('change', markDirty);
  }
  el('bookSelect').addEventListener('change', async () => {
    if (loading) return;
    const chosen = el('bookSelect').value;
    if (dirty) {
      el('bookSelect').value = draft?.revision ? draft.productKey : '';
      if (!(await discardOK(el('bookLibrary'), el('bookSelect')))) return;
      el('bookSelect').value = chosen;
    }
    draft = structuredClone(state.cards.find(c => c.productKey === chosen) || null);
    dirty = false; renderDraft(); say('book_ready');
  });
  el('bookCapture').addEventListener('click', capture);
  el('bookReload').addEventListener('click', () => load());
  el('bookSave').addEventListener('click', save);
  el('bookDelete').addEventListener('click', remove);
  el('bookExport').addEventListener('click', exportCard);
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.DownloaderProductBookUI = { syncBusy, ready: load({ initial: true }) };
})();
