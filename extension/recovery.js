'use strict';
(function (root) {
  const diagnostics = root.DownloaderDiagnostics || (typeof require === 'function' ? require('./diagnostics.js') : null);
  // One piece of advice for a failed download, the same in the receipt and the batch list.
  const RETRY_FIRST = '先按「重試失敗項目」；還是失敗，再到商品頁確認圖片看得到，然後重新掃描。';
  // Plain reason for one item; the support report keeps the exact code. The text is the
  // zh_TW canonical form of the dl_reason* messages, so stored batch messages translate.
  const REASONS = {
    dl_reasonUnconfirmed: '已開始下載，請到 Chrome 下載清單確認', dl_reasonFallback: '原圖沒抓到，改存頁面上的版本，請確認清晰度',
    dl_reasonCopy: '原檔已存好，只是 JPG／PNG 副本沒做出來', dl_reasonDenied: '網站不讓下載這個檔案',
    dl_reasonGone: '檔案連結已失效，重新整理商品頁再掃描', dl_reasonBusy: '網站暫時限制下載次數，稍等再重試',
    dl_reasonTimeout: '等太久沒有回應', dl_reasonStream: '這支影片是串流播放，無法存成檔案',
    dl_reasonInvalid: '拿到的不是正常的圖片或影片', dl_reasonZip: 'ZIP 沒有成功產生', dl_reasonOther: '沒有下載成功'
  };
  function reasonKey(item) {
    if (item.kind === 'unconfirmed') return 'dl_reasonUnconfirmed';
    if (item.kind === 'fallback') return 'dl_reasonFallback';
    if (item.kind === 'copy') return 'dl_reasonCopy';
    const code = diagnostics.errorCode(item);
    if (['HTTP_401', 'HTTP_403'].includes(code)) return 'dl_reasonDenied';
    if (['HTTP_404', 'HTTP_410'].includes(code)) return 'dl_reasonGone';
    if (code === 'HTTP_429') return 'dl_reasonBusy';
    if (code === 'FETCH_TIMEOUT') return 'dl_reasonTimeout';
    if (code === 'STREAM_VIDEO') return 'dl_reasonStream';
    if (['INVALID_IMAGE', 'INVALID_VIDEO', 'EMPTY_MEDIA', 'UNSUPPORTED_SOURCE'].includes(code)) return 'dl_reasonInvalid';
    if (code === 'ZIP_FAILED') return 'dl_reasonZip';
    return 'dl_reasonOther';
  }
  function guidance(entry) {
    const code = diagnostics.errorCode(entry);
    if (code === 'COPY_SIZE_LIMIT') return '原檔已保留，副本無法達到容量上限。請提高容量上限、改用 JPG 或縮小尺寸後重做副本；會重新取得原檔。';
    if (code === 'TOO_MANY_PARTS') return '原檔已保留，詳情圖需要太多分段。請增加每段高度或降低切割寬度後重新下載。';
    if (code === 'HTTP_429') return '網站限制請求頻率。先暫停一段時間，再重試失敗項目；仍受限時改成少量下載。';
    if (['HTTP_401', 'HTTP_403'].includes(code)) return RETRY_FIRST;
    if (['HTTP_404', 'HTTP_410'].includes(code)) return '素材連結可能已失效。重新整理商品頁，再重新掃描取得新連結。';
    if (code === 'INVALID_VIDEO') return '取得的內容不是可辨識影片。若商品有影片，先在原頁播放後重新掃描；特殊串流可能無法保存。';
    if (['INVALID_IMAGE', 'EMPTY_MEDIA'].includes(code)) return '拿到的不是正常的圖片或影片。確認商品頁上看得到這些素材，再重新掃描。';
    if (code === 'STREAM_VIDEO') return '這支影片是串流播放，無法存成檔案；其他素材不受影響。';
    if (code === 'UNSUPPORTED_SOURCE') return '素材連結無法直接下載。回原商品頁載入圖片或播放影片後重新掃描。';
    if (code === 'ZIP_FAILED') return 'ZIP 沒有成功產生。先看 Chrome 下載清單，再少選一些素材後重新下載。';
    if (['DECODE_FAILED','IMAGE_TOO_LARGE','ENCODE_FAILED','OUTPUT_FORMAT','IMAGE_TIMEOUT'].includes(code)) return '原檔已保留，圖片副本未完成。可改用原檔；要重做副本可降低尺寸並重新選取下載，也會重抓原檔。';
    if (code === 'FETCH_TIMEOUT') return '取得檔案逾時。確認網路與原商品頁正常，再重試失敗項目。';
    return '確認網路與原商品頁仍可查看，再重試失敗項目；仍失敗請聯絡客服。';
  }
  function forResult(result) {
    return [...new Set([...(result.failed || []), ...(result.conversionWarnings || [])].map(guidance))].slice(0, 4);
  }
  // A batch message stores whole sentences (q_reason* in the catalog) so each one translates.
  const sentence = item => '原因：' + REASONS[reasonKey(item)] + '。';
  root.DownloaderRecovery = { guidance, forResult, reasonKey, reason: item => REASONS[reasonKey(item)], sentence, REASONS, RETRY_FIRST };
  if (typeof module !== 'undefined') module.exports = root.DownloaderRecovery;
})(globalThis);
