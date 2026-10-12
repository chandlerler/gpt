'use strict';
(function (root) {
  const media = root.DownloaderMedia || (typeof require === 'function' ? require('./media.js') : null);
  const FORMATS = ['jpg', 'png', 'gif', 'webp', 'avif'];
  const MAX_PARTS = 40;
  function outputOptions(value = {}) {
    const format = ['jpg', 'png'].includes(value?.format) ? value.format : 'original';
    const limit = Number(value?.maxEdge);
    const result = { format, maxEdge: format !== 'original' && [0, 800, 1200, 1600, 2400].includes(limit) ? limit : 0 };
    // Omit inactive fields so old preferences and queue snapshots retain their meaning.
    if (format !== 'original') {
      if (value?.square === true) result.square = true;
      if ([800, 1200, 1600, 2400].includes(Number(value?.splitHeight))) result.splitHeight = Number(value.splitHeight);
      if ([200, 500, 1000, 2000].includes(Number(value?.maxKB))) result.maxKB = Number(value.maxKB);
    }
    return result;
  }
  function filterOptions(value = {}) {
    const size = n => Number.isFinite(Number(n)) ? Math.max(0, Math.min(50000, Math.floor(Number(n)))) : 0;
    return { minWidth: size(value.minWidth), minHeight: size(value.minHeight),
      format: FORMATS.includes(value.format) ? value.format : 'all', includeUnknown: value.includeUnknown !== false };
  }
  function matches(metadata, options, type = 'main') {
    if (type === 'video') return true;
    const f = filterOptions(options);
    if (f.format !== 'all' && (metadata?.ext ? metadata.ext !== f.format : !f.includeUnknown)) return false;
    for (const [key, min] of [['width', f.minWidth], ['height', f.minHeight]]) {
      if (min && (metadata?.[key] > 0 ? metadata[key] < min : !f.includeUnknown)) return false;
    }
    return true;
  }
  function fault(code, message) { const error = new Error(message); error.code = code; return error; }
  function dimensions(width, height, maxEdge = 0) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw fault('DECODE_FAILED', '無法讀取圖片尺寸');
    const scale = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(width, height)) : 1;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }
  function layoutPlans(width, height, requested, type = 'main') {
    dimensions(width, height);
    const options = outputOptions(requested);
    if (options.splitHeight && type === 'detail') {
      const outWidth = options.maxEdge ? Math.min(width, options.maxEdge) : width;
      const scale = outWidth / width;
      const rows = Math.max(1, Math.floor(options.splitHeight / scale));
      const count = Math.ceil(height / rows);
      if (count > MAX_PARTS) throw fault('TOO_MANY_PARTS', `單張詳情圖需切成 ${count} 段，超過 ${MAX_PARTS} 段上限；請增加每段高度或縮小寬度`);
      return Array.from({ length: count }, (_, index) => {
        const sourceY = index * rows, sourceHeight = Math.min(rows, height - sourceY);
        return { layout: 'slice', width: outWidth, height: Math.max(1, Math.round(sourceHeight * scale)),
          sourceX: 0, sourceY, sourceWidth: width, sourceHeight, segment: index + 1, segments: count };
      });
    }
    const size = dimensions(width, height, options.maxEdge);
    const square = options.square && ['main', 'sku'].includes(type);
    const side = Math.max(size.width, size.height);
    return [{ layout: square ? 'square' : 'fit', width: square ? side : size.width, height: square ? side : size.height,
      sourceX: 0, sourceY: 0, sourceWidth: width, sourceHeight: height }];
  }
  function outputDescription(requested) {
    const options = outputOptions(requested);
    if (options.format === 'original') return '僅原檔';
    return [`副本 ${options.format.toUpperCase()}`, options.maxEdge ? `尺寸上限 ${options.maxEdge} px${options.splitHeight ? '（切割時為寬度）' : ''}` : '不限制尺寸',
      options.square ? '主圖／款式白底方形' : '', options.splitHeight ? `詳情每段高 ≤ ${options.splitHeight} px` : '',
      options.maxKB ? `每張 ≤ ${options.maxKB} KB` : ''].filter(Boolean).join('，');
  }
  function createProcessor({ decode = blob => root.createImageBitmap(blob, { imageOrientation: 'from-image' }),
    makeCanvas = () => root.document.createElement('canvas'), timeoutMs = 15000, conversionTimeoutMs = 30000, now = () => Date.now() } = {}) {
    async function bitmap(blob) {
      if (blob.size > 40 * 1024 * 1024) throw fault('IMAGE_TOO_LARGE', '圖片超過 40 MB，保留原檔，略過尺寸解碼與副本');
      let timer, expired = false;
      const pending = Promise.resolve().then(() => decode(blob));
      pending.then(value => { if (expired) value.close?.(); }, () => {});
      try {
        return await Promise.race([pending, new Promise((_, reject) => {
          timer = setTimeout(() => { expired = true; reject(fault('IMAGE_TIMEOUT', '圖片解碼逾時')); }, timeoutMs);
        })]);
      } catch (error) { throw error.code ? error : fault('DECODE_FAILED', '瀏覽器無法解碼這張圖片'); }
      finally { clearTimeout(timer); }
    }
    async function inspect({ blob, ext }) {
      const image = await bitmap(blob);
      try { return { ...dimensions(image.width, image.height), ext, bytes: blob.size }; }
      finally { image.close?.(); }
    }
    async function convert(source, requested, target = {}) {
      const options = outputOptions(requested);
      if (options.format === 'original') return null;
      const image = await bitmap(source.blob);
      let canvas;
      try {
        const original = dimensions(image.width, image.height);
        if (original.width * original.height > 40000000) throw fault('IMAGE_TOO_LARGE', '圖片超過 4,000 萬像素，僅保留原檔');
        const mime = options.format === 'jpg' ? 'image/jpeg' : 'image/png';
        const plans = layoutPlans(original.width, original.height, options, target.type || 'main');
        const deadline = now() + conversionTimeoutMs;
        const limit = (options.maxKB || 0) * 1024, parts = [];
        let totalBytes = 0;
        async function encode(quality) {
          const remaining = Math.min(timeoutMs, deadline - now());
          if (remaining <= 0) throw fault('IMAGE_TIMEOUT', '圖片整理已達時間上限，僅保留原檔');
          let timer;
          try {
            const blob = await Promise.race([new Promise((resolve, reject) => {
              try { canvas.toBlob(resolve, mime, quality); } catch (_) { reject(fault('ENCODE_FAILED', '圖片副本轉檔失敗')); }
            }), new Promise((_, reject) => { timer = setTimeout(() => reject(fault('IMAGE_TIMEOUT', '圖片轉檔逾時')), remaining); })]);
            if (!blob?.size) throw fault('ENCODE_FAILED', '瀏覽器未產生圖片副本');
            const actual = media.detectFormat(new Uint8Array(await blob.slice(0, 64).arrayBuffer()));
            if (actual?.ext !== options.format) throw fault('OUTPUT_FORMAT', '瀏覽器輸出格式與選擇不符，未加入錯誤格式的副本');
            if (now() >= deadline) throw fault('IMAGE_TIMEOUT', '圖片整理已達時間上限，僅保留原檔');
            return blob;
          } finally { clearTimeout(timer); }
        }
        for (const plan of plans) {
          if (plan.width > 16384 || plan.height > 16384 || plan.width * plan.height > 40000000) throw fault('IMAGE_TOO_LARGE', '副本畫布過大，請選擇較小的尺寸上限');
          canvas = makeCanvas();
          let size = { width: plan.width, height: plan.height }, result;
          const minimum = Math.min(320, Math.max(plan.width, plan.height));
          try {
            for (let attempt = 0; attempt < (limit ? 5 : 1); attempt++) {
              if (now() >= deadline) throw fault('IMAGE_TIMEOUT', '圖片整理已達時間上限，僅保留原檔');
              canvas.width = size.width; canvas.height = size.height;
              const ctx = canvas.getContext('2d');
              if (!ctx) throw fault('ENCODE_FAILED', '無法建立圖片轉檔畫布');
              if (options.format === 'jpg' || plan.layout === 'square') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, size.width, size.height); }
              ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
              if (plan.layout === 'fit') ctx.drawImage(image, 0, 0, size.width, size.height);
              else if (plan.layout === 'square') {
                const inside = dimensions(original.width, original.height, size.width);
                ctx.drawImage(image, Math.floor((size.width - inside.width) / 2), Math.floor((size.height - inside.height) / 2), inside.width, inside.height);
              } else ctx.drawImage(image, plan.sourceX, plan.sourceY, plan.sourceWidth, plan.sourceHeight, 0, 0, size.width, size.height);
              let blob;
              for (const quality of limit && options.format === 'jpg' ? [0.92, 0.82, 0.70, 0.58] : [0.92]) {
                blob = await encode(quality);
                if (!limit || blob.size <= limit) {
                  result = { blob, ext: options.format, ...size, bytes: blob.size, layout: plan.layout,
                    quality: options.format === 'jpg' ? quality : null, resizedForLimit: attempt > 0,
                    originalWidth: original.width, originalHeight: original.height,
                    ...(plan.segment ? { segment: plan.segment, segments: plan.segments,
                      sourceRect: { x: plan.sourceX, y: plan.sourceY, width: plan.sourceWidth, height: plan.sourceHeight } } : {}),
                    note: '靜態副本；動畫僅取首幀，原檔另行保留。' };
                  break;
                }
              }
              if (result) break;
              const longest = Math.max(size.width, size.height);
              if (longest <= minimum) break;
              const nextEdge = Math.max(minimum, Math.floor(longest * Math.min(0.85, Math.max(0.25, Math.sqrt(limit / blob.size) * 0.9))));
              // Re-render from source at every step; do not repeatedly resample a copy.
              size = dimensions(plan.width, plan.height, nextEdge);
            }
            if (!result) throw fault('COPY_SIZE_LIMIT', `無法在處理上限內達到每張 ${options.maxKB} KB；僅保留原檔，請提高容量上限或改用 JPG`);
            totalBytes += result.blob.size;
            if (totalBytes > 64 * 1024 * 1024) throw fault('IMAGE_TOO_LARGE', '單張來源的副本合計超過 64 MB，僅保留原檔');
            parts.push(result);
          } finally { canvas.width = 0; canvas.height = 0; canvas = null; }
        }
        return plans[0].layout === 'slice' ? { parts } : parts[0];
      } catch (error) { throw error.code ? error : fault('ENCODE_FAILED', '圖片整理失敗，僅保留原檔'); }
      finally { image.close?.(); if (canvas) { canvas.width = 0; canvas.height = 0; } }
    }
    return { inspect, convert };
  }
  // A picture that shows nothing: tiny (a loading stand-in), or almost every sampled
  // pixel transparent or white, or one flat colour. pixels: RGBA bytes of a small
  // downscaled copy, or null when the browser does not allow reading them.
  function looksBlank({ width = 0, height = 0, pixels = null } = {}) {
    if (!(width > 0 && height > 0) || Math.min(width, height) < 60) return true;
    if (!pixels || pixels.length < 4) return false;
    const count = pixels.length / 4;
    let empty = 0, min = [255, 255, 255], max = [0, 0, 0], opaque = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b, a] = [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
      if (a < 16 || (a > 240 && r > 245 && g > 245 && b > 245)) empty++;
      if (a > 240) { opaque++; [r, g, b].forEach((v, c) => { min[c] = Math.min(min[c], v); max[c] = Math.max(max[c], v); }); }
    }
    if (empty / count >= 0.99) return true;
    return opaque === count && [0, 1, 2].every(c => max[c] - min[c] <= 6);
  }
  root.DownloaderAssets = { looksBlank, outputOptions, outputDescription, filterOptions, matches, dimensions, layoutPlans, MAX_PARTS, createProcessor };
  if (typeof module !== 'undefined') module.exports = root.DownloaderAssets;
})(globalThis);
