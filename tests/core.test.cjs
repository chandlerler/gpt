'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..', 'extension');
const P = require('../extension/platforms.js');
const A = require('../extension/assets.js');
const M = require('../extension/media.js');
const D = require('../extension/page-data.js');
const B = require('../extension/product-book.js');
const S = require('../extension/supplement.js');
const Q = require('../extension/queue-worker.js');
const Download = require('../extension/download.js');
const Zip = require('../extension/zip.js');

test('independent manifest has all entry files and no commercial service or store identity', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '3.8.7.1');
  assert.equal(manifest.key, undefined);
  assert.equal(manifest.update_url, undefined);
  assert.ok(!JSON.stringify(manifest).includes('lemonsqueezy'));
  const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
  const files = [manifest.background.service_worker, ...manifest.content_scripts.flatMap(c => c.js), ...[...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1])];
  for (const file of files) assert.ok(fs.existsSync(path.join(root, file)), file);
  for (const oldFile of ['trial.js', 'license.js', '_metadata']) assert.ok(!fs.existsSync(path.join(root, oldFile)));
});

test('all JS parses and runtime sources contain no payment gates or endpoints', () => {
  const forbidden = /lemonsqueezy|taobao-license|taobao-trial|tbSevenDayTrial|isVerified|licenseReady|trialState|ACCESS_REQUIRED/;
  for (const name of fs.readdirSync(root).filter(f => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(root, name), 'utf8');
    new vm.Script(code, { filename: name });
    assert.ok(!forbidden.test(code), name);
  }
});

test('three locales match and every HTML translation resolves', () => {
  const catalog = require('../extension/i18n-catalog.js');
  const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(m => m[1]);
  for (const locale of ['en', 'zh_CN', 'zh_TW']) {
    const messages = JSON.parse(fs.readFileSync(path.join(root, '_locales', locale, 'messages.json')));
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(catalog.locales[locale]).sort());
    for (const key of keys) assert.equal(typeof catalog.locales[locale][key], 'string', `${locale}/${key}`);
    for (const [key, entry] of Object.entries(messages)) assert.equal(catalog.locales[locale][key], entry.message);
  }
});

test('platform boundaries and changing SKU parameter', () => {
  assert.equal(P.identify('https://detail.tmall.hk/item.htm?id=123').key, 'tmallhk');
  assert.equal(P.identify('https://detail.1688.com/offer/123.html'), null);
  assert.equal(P.identify('https://evil.example/item.htm?id=123'), null);
  assert.equal(P.sameProduct('https://item.taobao.com/item.htm?id=123', 'https://item.taobao.com/item.htm?id=123&skuId=4'), true);
});

test('embedded data chooses current gallery, preserves SKU pair and excludes review video', () => {
  const res = { item: { itemId: '123', images: ['https://img.alicdn.com/old.jpg'] },
    componentsVO: { headImageVO: { images: ['https://img.alicdn.com/new.jpg'], videos: [
      { url: 'https://cloud.video.taobao.com/play/u/null/1.mp4' }, { url: 'https://cloud.video.taobao.com/play/u/123/2.mp4' }] } },
    skuBase: { props: [{ pid: 1, values: [{ vid: 2, name: '红色', image: 'https://img.alicdn.com/red.jpg' }] }] } };
  const parsed = D.parse('window.__ICE_APP_CONTEXT__ = ' + JSON.stringify({ loaderData: { home: { data: { res } } } }));
  const result = D.extract(parsed, '123');
  assert.deepEqual(result.main, ['https://img.alicdn.com/new.jpg']);
  assert.equal(result.videos.length, 1);
  assert.equal(result.skus[0].variants[0].id, '1:2');
  assert.equal(D.extract(parsed, '999'), null);
});

test('image processing keeps aspect ratio, slices details and squares only appropriate categories', () => {
  const parts = A.layoutPlans(1000, 5000, { format: 'jpg', maxEdge: 800, splitHeight: 1600 }, 'detail');
  assert.deepEqual(parts.map(p => [p.width, p.height]), [[800, 1600], [800, 1600], [800, 800]]);
  assert.equal(parts[2].sourceY, 4000);
  assert.equal(A.layoutPlans(1000, 500, { format: 'jpg', square: true }, 'sku')[0].height, 1000);
  assert.equal(A.layoutPlans(1000, 500, { format: 'jpg', square: true }, 'detail')[0].height, 500);
});

test('reject HTML errors and recognize real image signatures', () => {
  assert.equal(M.detectFormat(Uint8Array.from([255, 216, 255])).ext, 'jpg');
  assert.equal(M.detectFormat(Buffer.from('<html>Sign in</html>')), null);
});

test('supplement merges duplicate SKU metadata', () => {
  const r = S.merge([{ type: 'sku', url: 'https://img.alicdn.com/a.jpg', labels: ['红'] }],
    [{ type: 'sku', url: 'https://img.alicdn.com/a.jpg', labels: ['蓝'] }]);
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0].labels, ['红', '蓝']);
  assert.equal(r.updated.length, 1);
});

test('product note preserves own SKU when a later scan misses a variant', () => {
  let card = B.fromScan({ pageUrl: 'https://item.taobao.com/item.htm?id=123', items: [
    { type: 'sku', url: 'https://img.alicdn.com/a.jpg?token=fixture', variants: [{ id: '1:2', label: '红' }] }] });
  card.variants[0].ownSku = 'MY-1';
  card = B.fromScan({ pageUrl: card.sourceUrl, items: [] }, card);
  assert.equal(card.variants[0].ownSku, 'MY-1');
  assert.equal(card.variants[0].seenInLatest, false);
  assert.equal(card.variants[0].images[0], 'https://img.alicdn.com/a.jpg');
});

test('queue works without an authorization provider and still validates original page', async () => {
  const context = { ok: true, documentToken: 'fixture-page', pageUrl: 'https://item.taobao.com/item.htm?id=123' };
  let downloads = 0;
  const chrome = { tabs: { sendMessage: async (_, request) => request.action === 'mediaContext' ? context :
    { success: true, title: '样例', scan: { reason: 'settled' }, data: [
      { type: 'main', url: 'https://img.alicdn.com/a.jpg' },
      { type: 'detail', url: 'https://img.alicdn.com/ad.jpg', otherProduct: true }] } } };
  const process = Q.createProcessor({ chrome, download: async ({ targets }) => {
    downloads++;
    assert.equal(targets.length, 1);
    return { packed: targets, dispatched: [], failed: [], unconfirmed: [], fallbacks: [] };
  } });
  assert.equal((await process({ id: '1', tabId: 1, productKey: 'taobao:123', url: context.pageUrl, categories: ['main', 'detail'] })).status, 'delivered');
  assert.equal(downloads, 1);
  await assert.rejects(process({ id: '2', tabId: 1, productKey: 'taobao:999', url: context.pageUrl, categories: ['main'] }));
  assert.equal(downloads, 1);
});

test('fallback downloads retain originals and create a readable ZIP when conversion fails', async () => {
  let saved;
  const result = await Download.run({
    targets: [{ type: 'main', sequence: 1, url: 'https://img.alicdn.com/original.jpg', fallbackUrls: ['https://img.alicdn.com/backup.jpg'] }],
    output: { format: 'jpg' },
    fetchMedia: async url => { if (url.includes('original')) throw new Error('HTTP 404'); return { blob: Buffer.from([255, 216, 255]), ext: 'jpg' }; },
    convertImage: async () => { throw Object.assign(new Error('fixture decode failure'), { code: 'DECODE_FAILED' }); },
    makeZip: () => new Zip(), saveZip: async blob => { saved = blob; },
    context: { title: '样例', pageUrl: 'https://item.taobao.com/item.htm?id=123' }
  });
  assert.equal(result.packed.length, 1);
  assert.equal(result.fallbacks.length, 1);
  assert.equal(result.conversionWarnings.length, 1);
  const zip = await Zip.loadAsync(await saved.arrayBuffer());
  assert.ok(zip.file('主圖/主圖_001.jpg'));
  assert.equal(JSON.parse(await zip.file('素材清單.json').async('string')).items[0].fallback, true);
});
