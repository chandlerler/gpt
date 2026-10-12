// 电商采集大师 - 离屏文档（v1.1.36 图片快采下载引擎）
// 在 Window 里完成抓图/转格式/打包 ZIP → 生成 blob URL；真正下载由 SW 的 chrome.downloads 执行（离屏页无 chrome.downloads）
function normUrl(u){ if(!u) return ''; if(u.indexOf('//')===0) u='https:'+u; if(/^data:/i.test(u)) return u; if(!/^https?:/.test(u)) return ''; return u; }
function extForFormat(f, url){ if(f==='image/png') return 'png'; if(f==='image/webp') return 'webp'; if(f==='image/avif') return 'avif'; if(f==='image/jfif') return 'jfif'; if(f==='image/jpeg') return 'jpg'; if(f==='original' && url){ var m=String(url).match(/\.(png|jpe?g|webp|gif|mp4|mov|avi|webm|bmp)(?:\?|$)/i); if(m) return m[1].toLowerCase()==='jpeg'?'jpg':m[1].toLowerCase(); } return 'jpg'; }
function sanitize(n){ return String(n||'').replace(/[\\/:*?"<>|]/g,'_').replace(/\s+/g,' ').trim().slice(0,60)||'product'; }
// v1.2.419【用户要求：下载不改名，用原图名称】取图片 URL 的原始文件名主干（去扩展名/查询串）。
// 与 content/panel.js 的同名函数保持同一规则，保证「清单文件名 = 落盘文件名」。
function origNameOf(u){
  try{
    var s = String(u||'').split('#')[0].split('?')[0];
    var m = s.match(/\/([^\/]+)$/); var b = m ? m[1] : '';
    if(!b) return '';
    try{ b = decodeURIComponent(b); }catch(e){}
    var dot = b.lastIndexOf('.'); if(dot > 0) b = b.slice(0, dot);
    return String(b).replace(/[\\/:*?"<>|]/g,'_').replace(/\s+/g,' ').trim().slice(0,60);
  }catch(e){ return ''; }
}
async function fetchBlob(url, timeoutMs){ timeoutMs=timeoutMs||30000; const ctrl=new AbortController(); const t=setTimeout(function(){ctrl.abort();},timeoutMs); try{ const r=await fetch(url,{credentials:'include',signal:ctrl.signal}); if(!r.ok) throw new Error('HTTP '+r.status); return await r.blob(); } finally{ clearTimeout(t); } }
async function convertBlob(blob, format, quality, scale){
  const bmp = await createImageBitmap(blob);
  let w=bmp.width, h=bmp.height;
  if(scale && scale!==1 && scale>0 && scale<=4){ w=Math.max(1,Math.round(w*scale)); h=Math.max(1,Math.round(h*scale)); }
  // 超大图保护（画布面积上限 6400 万像素，超出回退原尺寸）
  if(w*h > 64000000){ w = bmp.width; h = bmp.height; }
  const canvas = new OffscreenCanvas(w,h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp,0,0,w,h);
  let mime=format, q=quality;
  if(mime==='image/jfif') mime='image/jpeg';   // v1.2.279 JFIF 输出即 JPEG 字节（扩展名 .jfif）
  if(mime==='image/jpeg'||mime==='image/webp'||mime==='image/avif'){ if(q==null||q==='') q=0.92; q=parseFloat(q); if(isNaN(q)) q=0.92; if(q>1) q=parseFloat((q/100).toFixed(2)); if(q>1) q=1; if(q<0.01) q=0.01; }
  try{ return await canvas.convertToBlob({type:mime, quality:q}); } finally{ try{ bmp.close && bmp.close(); } catch(e){} }
}
// v1.2.234：缩放不再只在「格式≠原始」时生效。
// 之前 convertBlob 只在 fmt!=='original' 时被调用 → 「原始格式 + 50%」实际下的是原图（缩放被忽略）。
// 现在：格式≠原始 → 按目标格式重编码；格式=原始但缩放≠100% → 按「源图格式」重编码缩放（仅 jpeg/png/webp，gif/svg 等不做缩放，仍下原图）。
// 目标类型取 fetch 到的 blob.type（真实类型），不靠 URL 后缀猜——
// URL 无扩展名时 extForFormat 会兜底成 jpg，若据此把 PNG 转成 JPEG 会丢透明通道。
function scaleTargetMime(srcType){
  var t = String(srcType || '').toLowerCase();
  if (t === 'image/jpeg' || t === 'image/jpg' || t === 'image/jfif') return 'image/jpeg';   // v1.2.279 jfif 本质是 JPEG
  if (t === 'image/avif') return 'image/avif';
  if (t === 'image/png') return 'image/png';
  if (t === 'image/webp') return 'image/webp';
  return '';
}
function needReencode(fmt, scale, isVideo){
  if (isVideo) return false;
  if (fmt && fmt !== 'original') return true;
  var s = Number(scale);
  return !!(s && s !== 1);
}
function pad(n){ return String(n).padStart(3,'0'); }
// v1.2.179：散图/打包文件名（SKU 图带规格属性名 + 可选「按商品分文件夹」）
function rawNameOf(it, i, mode){
  // v1.2.419 三种模式（common.imgNameMode）：
  //   orig          = 一律原图名（下载不改名）
  //   origExceptSku = SKU 图保留规格名，其余用原图名（折中档，无需再发版即可切换）
  //   legacy/其它    = 商店基线
  var isSku = String((it && it.type) || '').toLowerCase() === 'sku';
  // v1.2.438：未传 mode / mode 为空 也按【原图名】（原来会落到 legacy 的 001_main ✗）
  if (!mode || mode === 'orig' || (mode === 'origExceptSku' && !isSku)) { var o = origNameOf(it && it.url); if (o) return o; }
  return (it.name && String(it.name).trim()) ? sanitize(it.name) : (pad(i+1)+'_'+String(it.type||'img').replace(/[^a-z]/gi,''));
}
// v1.2.291：文件名分类前缀（用户要求；对标评论事实：电商信息导出助手用户「图片不带前缀了，之前前缀都会加上详情页/橱窗等描述」）
var __PREFIX_LABEL = { main:'主图', sku:'SKU图', desc:'详情图', video:'视频' };
function prefixLabel(d, it){
  var custom = String((d && d.prefixText) || '').trim();
  if (custom) return sanitize(custom);
  var t = String((it && it.type) || '').toLowerCase();
  return __PREFIX_LABEL[t] || '';
}
function imgFileName(d, it, i, ext, used){
  const base = sanitize(d.base);
  const folder = String(it.folder||'').replace(/[\\/:*?"<>|]/g,'_');
  let dir = '';
  if (folder) dir = (d.nest && base ? base+'/' : '') + folder + '/';
  else if (base) dir = base + '/';
  let raw = rawNameOf(it, i, d && d.nameMode);
  // v1.2.419：原图名模式（nameMode==='orig'）不加分类前缀 —— 用户要求「下载不改名」
  if (d && d.prefix && (!d.nameMode || d.nameMode !== 'orig')) { const pl = prefixLabel(d, it); if (pl && raw.indexOf(pl + '-') !== 0) raw = pl + '-' + raw; }
  let full = dir + raw + '.' + ext, k = 2;
  while (used[full]) { full = dir + raw + '-' + (k++) + '.' + ext; }
  used[full] = 1;
  return full;
}
// v1.2.180：进度上报（offscreen → SW → 发起下载的标签页面板）
function reportProgress(p){ try{ chrome.runtime.sendMessage(Object.assign({ action:'aisDlProgress' }, p)); }catch(e){} }
// v1.2.180：详情长图重写——流式处理（抓一张画一张、即时释放 bitmap，内存可控）
//   · 单图高于单卷上限时按源矩形切片跨卷绘制（修「长图不完整」）
//   · 每图 3 次重试 + 30s 超时；失败图跳过并回传样例 URL
//   · 宽度取自前 5 张的最大值（800~2400），保证整卷等比一致
async function doLongImage(d){
  const list = (d.images||[]).map(function(x){ return normUrl((x && (x.url||x)) || ''); }).filter(Boolean);
  if(!list.length) return { ok:false, error:'没有可用的详情图' };
  const base = sanitize(d.base) || 'product';
  const MAX_H = 16000;
  const failedSet = {}; const failedUrls = []; let okCount = 0, done = 0;
  const markFail = function(u){ if(!failedSet[u]){ failedSet[u] = 1; if(failedUrls.length < 8) failedUrls.push(u); } };
  const failCount = function(){ return Object.keys(failedSet).length; };
  const fetchOne = async function(u){
    let lastErr = null;
    for(let t=0;t<3;t++){
      try{ return await fetchBlob(u, 30000); }
      catch(e){ lastErr = e; await new Promise(function(r){ setTimeout(r, 500 + t*700); }); }
    }
    throw lastErr || new Error('fetch failed');
  };
  // 阶段一：探测宽度（缓存前 5 张 bitmap 复用，避免二次抓取）
  const probe = [], probeN = Math.min(5, list.length);
  let targetW = 800;
  for(let i=0;i<probeN;i++){
    try{
      const blob = await fetchOne(list[i]);
      const bmp = await createImageBitmap(blob);
      probe.push({ i: i, bmp: bmp });
      if(bmp.width > targetW) targetW = bmp.width;
    }catch(e){ /* 探针失败不计入最终统计，主循环会重试并统计一次 */ }
  }
  targetW = Math.max(800, Math.min(2400, targetW));
  reportProgress({ phase:'fetch', kind:'longimage', done: done, total: list.length, failed: failCount() });
  // 阶段二：流式拼接
  let canvas = null, ctx = null, usedH = 0, idx = 0;
  const files = [];
  const ensure = function(){
    if(!canvas){ canvas = new OffscreenCanvas(targetW, MAX_H); ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,targetW,MAX_H); usedH = 0; }
  };
  const flush = async function(){
    if(!canvas || !usedH) return;
    const h = Math.max(1, Math.round(usedH));
    const out = new OffscreenCanvas(targetW, h);
    const octx = out.getContext('2d');
    octx.drawImage(canvas, 0, 0, targetW, h, 0, 0, targetW, h);
    idx++;
    const blob = await out.convertToBlob({ type:'image/png' });
    const u = URL.createObjectURL(blob);
    setTimeout(function(){ try{ URL.revokeObjectURL(u); }catch(e){} }, 300000);
    files.push({ url: u, filename: base + '/详情长图/详情长图-' + idx + '.png' });
    canvas = null; ctx = null; usedH = 0;
    reportProgress({ phase:'render', kind:'longimage', done: done, total: list.length, failed: failCount(), files: idx });
  };
  const drawBmp = async function(bmp){
    const scale = targetW / bmp.width;
    const destH = Math.max(1, Math.round(bmp.height * scale));
    let drawn = 0;
    while(drawn < destH){
      ensure();
      const room = MAX_H - usedH;
      if(room < 2){ await flush(); continue; }
      const dh = Math.min(destH - drawn, room);
      const sh = Math.max(1, Math.min(bmp.height, Math.round(dh / scale)));
      const sy = Math.max(0, Math.min(bmp.height - sh, Math.round(drawn / scale)));
      ctx.drawImage(bmp, 0, sy, bmp.width, sh, 0, usedH, targetW, dh);
      usedH += dh; drawn += dh;
      if(usedH >= MAX_H - 2) await flush();
    }
  };
  const probeMap = {};
  probe.forEach(function(p){ probeMap[p.i] = p.bmp; });
  for(let i=0;i<list.length && i<200;i++){
    let bmp = probeMap[i];
    try{
      if(!bmp){ const blob = await fetchOne(list[i]); bmp = await createImageBitmap(blob); }
      await drawBmp(bmp);
      if(bmp){ try{ bmp.close && bmp.close(); }catch(e){} }
      okCount++;
    }catch(e){ markFail(list[i]); }
    done++;
    if(done % 2 === 0 || done === list.length) reportProgress({ phase:'fetch', kind:'longimage', done: done, total: list.length, failed: failCount() });
  }
  await flush();
  return { ok: files.length > 0, mode:'longimage', files: files, count: list.length, down: okCount, failed: failCount(), failedUrls: failedUrls, error: files.length ? '' : '详情图全部抓取失败' };
}
async function doRun(d){
  const base = sanitize(d.base);
  const images = d.images || [];
  if(!images.length) return { ok:false, error:'没有可下载的图片' };
  // v1.2.176 防盗链：先让后台注册 DNR 会话规则（Referer=商品页 origin），再开始抓图
  if (d.pageOrigin && /^https?:\/\//.test(d.pageOrigin)) {
    try {
      const hosts = {};
      // v1.2.180：DNR requestDomains 只接受域名（不含端口），此前用 .host 导致带端口图床规则被过滤 → 防盗链失效
      images.forEach(function (it) { const u = normUrl(it.url); if (/^https?:\/\//.test(u)) { try { hosts[new URL(u).hostname] = 1; } catch (e9) {} } });
      const dms = Object.keys(hosts).slice(0, 100);
      if (dms.length) {
        await new Promise(function (res) {
          try { chrome.runtime.sendMessage({ action: 'fixImageReferer', domains: dms, referer: d.pageOrigin }, function () { void chrome.runtime.lastError; res(); }); } catch (e8) { res(); }
        });
      }
    } catch (e7) { /* 规则失败不阻断下载，退化为原行为 */ }
  }
  if(d.longImage) return doLongImage(d); // v1.2.180：放在 DNR Referer 规则注册之后（修复防盗链导致的长图缺图）
  if(d.asZip && typeof JSZip !== 'undefined'){
    const zip = new JSZip();
    let failed=0;
    const usedNames = {};
    for(let i=0;i<images.length;i++){
      const it=images[i], url=normUrl(it.url), isVideo=/video/i.test(it.type||''), fmt=isVideo?'original':it.format;
      // v1.2.465：支持**多级目录**（批量打包「每个商品一个文件夹」）——按段清洗、保留 /，并丢弃 . / .. 防路径穿越
      const folderKey = String(it.folder||'').split('/').map(function(seg){ return seg.replace(/[\\:*?"<>|]/g,'_'); }).filter(function(seg){ return seg && seg !== '.' && seg !== '..'; }).join('/') || base || 'images';
      const folder = zip.folder(folderKey);
      const rawName = rawNameOf(it, i, d.nameMode);   // v1.2.419 支持原图名模式
      let ext = extForFormat(fmt, url);
      try{
        const blob = await fetchBlob(url);
        let out = blob;
        if (needReencode(fmt, it.scale, isVideo)) { // v1.2.234：原始格式 + 缩放≠100% 也要重编码
          const tgt = (fmt && fmt !== 'original') ? fmt : scaleTargetMime(blob.type);
          if (tgt) {
            if (fmt === 'original') { const e2 = extForFormat(tgt, ''); if (e2) ext = e2; } // 扩展名以真实目标类型为准
            try { out = await convertBlob(blob, tgt, it.quality, it.scale); } catch(ce){ out = blob; }
          }
        }
        let name = rawName+'.'+ext, k = 2;
        while(usedNames[folderKey+'/'+name]){ name = rawName+'-'+(k++)+'.'+ext; }
        usedNames[folderKey+'/'+name]=1;
        folder.file(name, out);
      }catch(e){ failed++; }
      if((i+1) % 2 === 0 || i === images.length-1) reportProgress({ phase:'fetch', kind:'zip', done: i+1, total: images.length, failed: failed });
    }
    try{
      if(d.summaryCsvBase64){ try{ const bin = atob(d.summaryCsvBase64); const bytes = new Uint8Array(bin.length); for(let i2=0;i2<bin.length;i2++) bytes[i2]=bin.charCodeAt(i2); zip.file('图片清单.csv', bytes); }catch(e){} }
      // v1.2.268：整合包 —— 额外文件（上架数据包.xlsx / 各 CSV / JSON / 说明）直接放进同一个 ZIP
      if(Array.isArray(d.extraFiles)){
        for(let ei=0; ei<d.extraFiles.length; ei++){
          try{
            const ef = d.extraFiles[ei];
            if(!ef || !ef.name || !ef.base64) continue;
            const bin2 = atob(ef.base64);
            const bytes2 = new Uint8Array(bin2.length);
            for(let i4=0; i4<bin2.length; i4++) bytes2[i4] = bin2.charCodeAt(i4);
            // v1.2.465：额外文件同样支持多级路径（批量打包时放进各商品文件夹），按段清洗、丢弃 . / ..
            var _efn = String(ef.name).split('/').map(function(seg){ return seg.replace(/[\\:*?"<>|]/g,'_'); }).filter(function(seg){ return seg && seg !== '.' && seg !== '..'; }).join('/');
            if (!_efn) continue;
            var _efC = /\.(csv|json|txt)$/i.test(_efn) ? { compression: 'DEFLATE' } : { compression: 'STORE' };
            zip.file(_efn, bytes2, _efC);
          }catch(eEF){}
        }
      }
      // v1.2.434【用户反馈：一直卡在「正在压缩 ZIP…」】根因 = 对已经是压缩格式的 JPEG/PNG 再做 DEFLATE ✗，
      //   100+ 张图要几分钟，表现就是卡死。改为 STORE（不二次压缩）→ 秒级完成；文本类额外文件仍单独 DEFLATE ✓。
      const zipBlob = await zip.generateAsync({type:'blob', compression:'STORE'}, function(meta){ reportProgress({ phase:'zip', kind:'zip', percent: Math.round(meta && meta.percent || 0) }); });
      // v1.2.464【用户反馈：一直卡在 100%「正在压缩 ZIP…」】压缩完成后**必须换阶段文案**，
      //   否则面板会一直显示「正在压缩 ZIP…」（压缩早已结束，实际在写文件/等下载）⇒ 看起来像卡死。
      try { reportProgress({ phase:'save', kind:'zip', percent:100, done: images.length, total: images.length, size: zipBlob.size }); } catch (ePg) {}
      const u = URL.createObjectURL(zipBlob);
      setTimeout(function(){ try{ URL.revokeObjectURL(u); }catch(e){} }, 120000);
      return { ok:true, mode:'zip', url:u, filename: base+'.zip', count:images.length, down:images.length-failed, failed:failed };
    }catch(e){ return { ok:false, error:'ZIP 生成失败: '+(e&&e.message||e), failed:failed }; }
  } else {
    let down=0, failed=0, items=[]; const usedFiles={};
    for(let i=0;i<images.length;i++){
      const it=images[i], url=normUrl(it.url), isVideo=/video/i.test(it.type||''), fmt=isVideo?'original':it.format;
      let ext = extForFormat(fmt, url), finalUrl = url;
      try{
        if(needReencode(fmt, it.scale, isVideo)){ // v1.2.234：原始格式 + 缩放≠100% 也要重编码
          const blob = await fetchBlob(url);
          const tgt = (fmt && fmt !== 'original') ? fmt : scaleTargetMime(blob.type);
          if (tgt) {
            if (fmt === 'original') { const e2 = extForFormat(tgt, ''); if (e2) ext = e2; } // 扩展名以真实目标类型为准
            let out = null;
            try { out = await convertBlob(blob, tgt, it.quality, it.scale); } catch(ce){ out = null; }
            if (out) {
              const u = URL.createObjectURL(out);
              setTimeout(function(){ try{ URL.revokeObjectURL(u); }catch(e){} }, 120000);
              finalUrl = u;
            }
          }
        }
        items.push({ url: finalUrl, filename: imgFileName(d, it, i, ext, usedFiles) });
        down++;
      }catch(e){ failed++; items.push({ ok:false, error:String(e&&e.message||e) }); }
      if((i+1) % 2 === 0 || i === images.length-1) reportProgress({ phase:'fetch', kind:'files', done: i+1, total: images.length, failed: failed });
    }
    return { ok:true, mode:'files', items:items, count:images.length, down:down, failed:failed };
  }
}
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse){
  if(msg && msg.type === 'download'){
    if (msg.data && msg.data.ping) { sendResponse({ ok: true, pong: true }); return false; }
    doRun(msg.data).then(function(r){ sendResponse(r); }).catch(function(e){ sendResponse({ok:false, error: String(e&&e.message||e)}); });
    return true;
  }
  return false;
});
