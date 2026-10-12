'use strict';
(function (root) {
  const archive = root.DownloaderArchive || (typeof require === 'function' ? require('./archive.js') : null);
  const assets = root.DownloaderAssets || (typeof require === 'function' ? require('./assets.js') : null);
  const diagnostics = root.DownloaderDiagnostics || (typeof require === 'function' ? require('./diagnostics.js') : null);
  async function run({ output = {}, convertImage, targets, fetchMedia, downloadBlob, makeZip, saveZip, context = {}, onProgress = () => {} }) {
    const zip = makeZip();
    // Folders are made when their first file arrives, so a product without description
    // images gets no empty 詳情圖 folder.
    const made = {};
    const folderFor = type => made[type] ||= zip.folder(archive.CATEGORIES[type]);
    const packed = [], dispatched = [], unconfirmed = [], failed = [], fallbacks = [], converted = [], copyFiles = [], conversionWarnings = [];
    const options = assets.outputOptions(output);
    const entries = [], paths = new Set();
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      onProgress(index + 1, targets.length);
      try {
        if (target.type === 'video' && target.url.startsWith('blob:')) {
          const result = await downloadBlob(target);
          // Keep the page's own reason code (e.g. STREAM_VIDEO) for the report instead of a generic FETCH_FAILED.
          if (!result?.ok) throw Object.assign(new Error(result?.error || '影片未能交由瀏覽器下載'), result?.code ? { code: result.code } : {});
          if (result.verified === false) unconfirmed.push({ target, message: result.warning || '已嘗試原版影片下載，請確認瀏覽器下載清單' });
          else dispatched.push(target);
          entries.push({ target, status: result.verified === false ? 'unconfirmed' : 'dispatched' });
        } else {
          const candidates = [...new Set([target.url, ...(target.type === 'video' ? [] : target.fallbackUrls || [])])].slice(0, 4);
          let media, lastError, usedUrl;
          for (const url of candidates) {
            try { media = await fetchMedia(url, target.type === 'video' ? 'video' : 'image'); usedUrl = url; break; }
            catch (error) { lastError = error; }
          }
          if (!media) throw lastError || new Error('沒有可用的媒體網址');
          const { blob, ext } = media;
          const folder = folderFor(Object.hasOwn(archive.CATEGORIES, target.type) ? target.type : 'detail');
          const directory = archive.CATEGORIES[target.type] || archive.CATEGORIES.detail;
          const baseName = archive.fileName(target, ext);
          let name = baseName, suffix = 2;
          while (paths.has((directory + '/' + name).toLowerCase())) name = baseName.slice(0, -(ext.length + 1)) + '_' + suffix++ + '.' + ext;
          paths.add((directory + '/' + name).toLowerCase());
          folder.file(name, blob);
          packed.push(target);
          const entry = { target, status: 'packed', path: directory + '/' + name, usedUrl };
          entries.push(entry);
          if (target.type !== 'video' && options.format !== 'original') {
            const stagedPaths = [];
            try {
              if (!convertImage) throw new Error('圖片轉檔元件尚未就緒');
              const generated = await convertImage(media, options, target);
              const copies = Array.isArray(generated?.parts) ? generated.parts : generated ? [generated] : [];
              if (!copies.length || copies.length > assets.MAX_PARTS) throw new Error('圖片副本數量不符');
              const copyDir = '上架副本/' + directory;
              const staged = copies.map((copy, index) => {
                const bytes = copy?.blob?.size ?? copy?.blob?.byteLength;
                if (!copy || copy.ext !== options.format || !(bytes > 0)) throw new Error('圖片副本未產生或格式不符');
                if (options.maxKB && bytes > options.maxKB * 1024) throw Object.assign(new Error('副本容量超過所選上限'), { code: 'COPY_SIZE_LIMIT' });
                const base = archive.fileName(target, copy.ext);
                const suffix = Array.isArray(generated.parts) ? '_part' + String(index + 1).padStart(3, '0') : '';
                const copyBase = base.slice(0, -(copy.ext.length + 1)) + suffix + '.' + copy.ext;
                let copyName = copyBase, copySuffix = 2;
                while (paths.has((copyDir + '/' + copyName).toLowerCase())) copyName = copyBase.slice(0, -(copy.ext.length + 1)) + '_' + copySuffix++ + '.' + copy.ext;
                const file = copyDir + '/' + copyName;
                paths.add(file.toLowerCase()); stagedPaths.push(file);
                return { name: copyName, blob: copy.blob, meta: { file, format: copy.ext, width: copy.width, height: copy.height, bytes,
                  originalWidth: copy.originalWidth, originalHeight: copy.originalHeight, layout: copy.layout || 'fit',
                  ...(copy.segment ? { segment: copy.segment, segments: copy.segments, sourceRect: copy.sourceRect } : {}),
                  quality: copy.quality ?? null, resizedForLimit: copy.resizedForLimit === true, status: 'packed' } };
              });
              // Commit this source's complete set only after all parts validate.
              for (const copy of staged) zip.folder(copyDir).file(copy.name, copy.blob);
              entry.copies = staged.map(copy => copy.meta);
              entry.copy = entry.copies[0]; // Legacy single-copy readers still see the first file.
              copyFiles.push(...entry.copies.map(copy => ({ target, ...copy })));
              converted.push(target);
            } catch (error) {
              for (const path of stagedPaths) { zip.remove?.(path); paths.delete(path.toLowerCase()); }
              const code = diagnostics.errorCode(error);
              entry.copy = { status: 'failed', code }; entry.copies = [];
              conversionWarnings.push({ target, code, message: '原檔已保留，副本未產生：' + (error.message || '轉檔失敗') });
            }
          }
          if (usedUrl !== target.url) fallbacks.push({ target, message: '原圖連結未成功，已改存頁面提供的圖片版本，請確認解析度。' });
        }
      } catch (error) {
        failed.push({ target, code: diagnostics.errorCode(error), message: error.message || '下載失敗，請重試' });
        entries.push({ target, status: 'failed' });
      }
    }
    if (packed.length) {
      try {
        const manifest = archive.buildManifest({ ...context, output: options }, entries);
        zip.file('商品來源.txt', manifest.text);
        zip.file('素材清單.csv', manifest.csv);
        zip.file('素材清單.json', JSON.stringify(manifest.report, null, 2));
        const content = await zip.generateAsync({ type: 'blob' });
        await saveZip(content);
      } catch (error) {
        for (const target of packed) failed.push({ target, code: 'ZIP_FAILED', message: 'ZIP 未能交付：' + (error.message || '請重試') });
        packed.length = 0;
        fallbacks.length = 0; converted.length = 0; copyFiles.length = 0; conversionWarnings.length = 0;
      }
    }
    return { packed, dispatched, unconfirmed, failed, fallbacks, converted, copyFiles, conversionWarnings };
  }
  root.DownloaderDownload = { run };
  if (typeof module !== 'undefined') module.exports = root.DownloaderDownload;
})(globalThis);
