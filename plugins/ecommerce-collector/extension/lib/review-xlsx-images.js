// Embed comment thumbnails as OOXML drawings, not external IMAGE() formulas.
(function () {
  'use strict';
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const DRAW = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
  const ART = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const serialize = d => new XMLSerializer().serializeToString(d);
  const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  function links(row) {
    const input = row['图片地址'];
    return [...new Set((Array.isArray(input) ? input : String(input || '').split(/\s+/)).filter(Boolean))];
  }
  function request(url) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('图片请求超时')), 20000);
      try {
        chrome.runtime.sendMessage({ action: 'fetchReviewImage', url }, r => {
          clearTimeout(timer);
          if (chrome.runtime.lastError || !r || !r.ok) reject(new Error((r && r.error) || '图片请求失败'));
          else resolve(r);
        });
      } catch (e) { clearTimeout(timer); reject(e); }
    });
  }
  async function thumbnail(url) {
    const result = await request(url);
    const bytes = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: result.mime }));
    try {
      const scale = Math.min(1, 240 / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
      const fit = Math.min(1, 112 / width, 112 / height);
      return { bytes: new Uint8Array(await blob.arrayBuffer()), width: Math.round(width * fit), height: Math.round(height * fit) };
    } finally { bitmap.close(); }
  }
  async function prepare(sheets, progress) {
    const jobs = [], urls = new Set();
    Object.entries(sheets).forEach(([name, sheet]) => {
      if (!sheet.headers.includes('图片地址')) return;
      const rows = sheet.rows.map(links);
      const count = rows.reduce((max, row) => Math.max(max, row.length), 0);
      for (let i = 0; i < count; i++) sheet.headers.push('评论图片' + (i + 1));
      rows.forEach((row, rowIndex) => row.forEach((url, imageIndex) => {
        const field = '评论图片' + (imageIndex + 1);
        sheet.rows[rowIndex][field] = '';
        jobs.push({ name, rowIndex, column: sheet.headers.indexOf(field), field, url });
        urls.add(url);
      }));
    });
    const cache = new Map(), list = [...urls];
    // Reuse the same image-CDN Referer setup as normal image/ZIP downloads.
    if (list.length) {
      const hosts = ['alicdn.com', 'taobaocdn.com', 'tbcdn.cn', '360buyimg.com', 'pddpic.com', 'pinduoduo.com', 'yangkeduo.com', 'media-amazon.com', 'ssl-images-amazon.com', 'images-amazon.com'];
      const domains = [...new Set(list.flatMap(u => {
        try { const h = new URL(u, location.href).hostname; return hosts.some(s => h === s || h.endsWith('.' + s)) ? [h] : []; }
        catch (e) { return []; }
      }))];
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 5000);
        try { chrome.runtime.sendMessage({ action: 'fixImageReferer', domains, referer: location.origin + '/' }, () => { clearTimeout(timer); void chrome.runtime.lastError; resolve(); }); }
        catch (e) { clearTimeout(timer); resolve(); }
      });
    }
    let cursor = 0, done = 0;
    await Promise.all(Array.from({ length: Math.min(3, list.length) }, async () => {
      while (cursor < list.length) {
        const url = list[cursor++];
        try { cache.set(url, await thumbnail(url)); }
        catch (e) { cache.set(url, { error: String(e.message || e) }); }
        done++; if (progress) progress(done, list.length);
      }
    }));
    let failed = 0;
    jobs.forEach(job => {
      job.image = cache.get(job.url);
      if (job.image.error) {
        failed++;
        sheets[job.name].rows[job.rowIndex][job.field] = '图片未嵌入：' + job.image.error + '（原链接见图片地址列）';
      }
    });
    return { jobs, failed, embedded: jobs.length - failed };
  }
  function relationship(doc, id, type, target) {
    const el = doc.createElementNS(REL, 'Relationship');
    el.setAttribute('Id', id); el.setAttribute('Type', OFFICE + '/' + type); el.setAttribute('Target', target);
    doc.documentElement.appendChild(el);
  }
  async function embed(buffer, sheets, prepared, styled) {
    if (!prepared.embedded) return buffer;
    const zip = await JSZip.loadAsync(buffer), names = Object.keys(sheets);
    const types = xml(await zip.file('[Content_Types].xml').async('string'));
    if (![...types.getElementsByTagNameNS(CT, 'Default')].some(e => e.getAttribute('Extension') === 'jpg')) {
      const item = types.createElementNS(CT, 'Default');
      item.setAttribute('Extension', 'jpg'); item.setAttribute('ContentType', 'image/jpeg'); types.documentElement.appendChild(item);
    }
    const media = new Map();
    for (let i = 0; i < names.length; i++) {
      const jobs = prepared.jobs.filter(j => j.name === names[i] && !j.image.error);
      if (!jobs.length) continue;
      const id = i + 1, sheetPath = 'xl/worksheets/sheet' + id + '.xml';
      const relPath = 'xl/worksheets/_rels/sheet' + id + '.xml.rels';
      const drawingName = 'reviewImages' + id;
      const sheet = xml(await zip.file(sheetPath).async('string'));
      const rels = xml(zip.file(relPath) ? await zip.file(relPath).async('string') : '<Relationships xmlns="' + REL + '"/>');
      let rid = 'rIdReviewImages';
      const ids = [...rels.documentElement.children].map(e => e.getAttribute('Id'));
      while (ids.includes(rid)) rid += '_';
      relationship(rels, rid, 'drawing', '../drawings/' + drawingName + '.xml');
      const drawing = sheet.createElementNS(NS, 'drawing'); drawing.setAttributeNS(OFFICE, 'r:id', rid);
      sheet.documentElement.appendChild(drawing);
      const dr = xml('<Relationships xmlns="' + REL + '"/>');
      let anchors = '';
      jobs.forEach((job, n) => {
        if (!media.has(job.url)) {
          const name = 'reviewImage' + (media.size + 1) + '.jpg';
          media.set(job.url, name); zip.file('xl/media/' + name, job.image.bytes);
        }
        const row = job.rowIndex + (styled && sheets[job.name].title ? 3 : 1);
        const rowEl = [...sheet.getElementsByTagNameNS(NS, 'row')].find(e => Number(e.getAttribute('r')) === row + 1);
        if (rowEl) { rowEl.setAttribute('ht', '96'); rowEl.setAttribute('customHeight', '1'); }
        const imageId = 'rIdImage' + (n + 1), cx = job.image.width * 9525, cy = job.image.height * 9525;
        relationship(dr, imageId, 'image', '../media/' + media.get(job.url));
        anchors += '<xdr:oneCellAnchor><xdr:from><xdr:col>' + job.column + '</xdr:col><xdr:colOff>38100</xdr:colOff><xdr:row>' + row + '</xdr:row><xdr:rowOff>38100</xdr:rowOff></xdr:from>' +
          '<xdr:ext cx="' + cx + '" cy="' + cy + '"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="' + (n + 1) + '" name="评论图片 ' + (n + 1) + '" descr="' + escape(job.url) + '"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
          '<xdr:blipFill><a:blip r:embed="' + imageId + '"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>';
      });
      zip.file(sheetPath, serialize(sheet)); zip.file(relPath, serialize(rels));
      zip.file('xl/drawings/' + drawingName + '.xml', '<xdr:wsDr xmlns:xdr="' + DRAW + '" xmlns:a="' + ART + '" xmlns:r="' + OFFICE + '">' + anchors + '</xdr:wsDr>');
      zip.file('xl/drawings/_rels/' + drawingName + '.xml.rels', serialize(dr));
      const type = types.createElementNS(CT, 'Override');
      type.setAttribute('PartName', '/xl/drawings/' + drawingName + '.xml');
      type.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.drawing+xml'); types.documentElement.appendChild(type);
    }
    zip.file('[Content_Types].xml', serialize(types));
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }
  window.AisReviewXlsxImages = { prepare, embed };
})();
