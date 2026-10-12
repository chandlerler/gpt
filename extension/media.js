'use strict';
(function (root) {
  function failure(code, message) { return Object.assign(new Error(message), { code }); }
  function detectFormat(bytes) {
    const ascii = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { kind: 'image', ext: 'jpg' };
    if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) return { kind: 'image', ext: 'png' };
    if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return { kind: 'image', ext: 'gif' };
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { kind: 'image', ext: 'webp' };
    if (ascii(4, 4) === 'ftyp') {
      const brands = [ascii(8, 4)];
      for (let offset = 16; offset + 4 <= bytes.length; offset += 4) brands.push(ascii(offset, 4));
      if (brands.some(b => ['avif', 'avis'].includes(b))) return { kind: 'image', ext: 'avif' };
      if (brands.some(b => ['isom','iso2','iso4','iso5','iso6','iso8','iso9','mp41','mp42','avc1','M4V ','dash','cmfc','cmfs'].includes(b))) return { kind: 'video', ext: 'mp4' };
      if (brands.includes('qt  ')) return { kind: 'video', ext: 'mov' };
    }
    if (bytes.length >= 4 && [26,69,223,163].every((v, i) => bytes[i] === v) && ascii(4, 60).includes('webm')) return { kind: 'video', ext: 'webm' };
    return null;
  }
  async function readResponse(response, kind) {
    if (!response.ok) throw failure(`HTTP_${response.status}`, `HTTP ${response.status}，伺服器未提供檔案`);
    const blob = await response.blob();
    if (blob.size === 0) throw failure('EMPTY_MEDIA', '伺服器回傳空檔案');
    const format = detectFormat(new Uint8Array(await blob.slice(0, 64).arrayBuffer()));
    if (!format || format.kind !== kind) throw failure(kind === 'video' ? 'INVALID_VIDEO' : 'INVALID_IMAGE', kind === 'video' ? '不是可辨識的影片檔，可能為串流或錯誤頁面' : '不是可辨識的圖片檔，可能為錯誤頁面');
    return { blob, ext: format.ext };
  }
  // Idle timeout: a large video on a slow line keeps downloading as long as
  // bytes keep arriving; only a stalled connection is aborted.
  const IDLE_MS = 45000;
  // Overall cap: a line that trickles data forever must still end. 30 minutes
  // lets a 500 MB video finish at about 280 KB/s; product videos are far smaller.
  const TOTAL_MS = 30 * 60 * 1000;
  function streamed(response, signal, onData) {
    if (!response?.ok || typeof response.body?.getReader !== 'function') return response;
    return { ok: response.ok, status: response.status, async blob() {
      const reader = response.body.getReader(), parts = [];
      const stalled = new Promise((_, reject) => {
        const stop = () => { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); reader.cancel().catch(() => {}); };
        if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
      });
      stalled.catch(() => {});
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), stalled]);
        // A cancelled reader reports "done"; never hand back a truncated file.
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (done) break;
        parts.push(value); onData();
      }
      return new Blob(parts, { type: response.headers?.get?.('content-type') || '' });
    } };
  }
  async function fetchMedia(url, kind, fetchFn = fetch, allowBlob = false, idleMs = IDLE_MS, totalMs = TOTAL_MS) {
    let protocol;
    try { protocol = new URL(url).protocol; } catch (_) { throw failure('UNSUPPORTED_SOURCE', '不支援此媒體網址'); }
    if (!['https:', 'http:'].includes(protocol) && !(allowBlob && protocol === 'blob:')) throw failure('UNSUPPORTED_SOURCE', '不支援此媒體網址');
    const controller = new AbortController();
    let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), idleMs); };
    arm();
    const deadline = setTimeout(() => controller.abort(), totalMs);
    try {
      const response = await fetchFn(url, { signal: controller.signal });
      arm();
      return await readResponse(streamed(response, controller.signal, arm), kind);
    } catch (error) {
      if (error.name === 'AbortError') throw failure('FETCH_TIMEOUT', '下載逾時，請重試');
      throw error;
    } finally { clearTimeout(timer); clearTimeout(deadline); }
  }
  root.DownloaderMedia = { detectFormat, readResponse, fetchMedia, IDLE_MS, TOTAL_MS };
  if (typeof module !== 'undefined') module.exports = root.DownloaderMedia;
})(globalThis);
