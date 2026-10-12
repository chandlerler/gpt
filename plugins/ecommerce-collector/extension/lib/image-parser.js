// 电商采集大师 - 图片快采解析器（v1.1.36）
// 职责：把拦截到的 detail/sku 响应解析为 主图/SKU图/详情图/视频/SKU规格表
// 设计参考：电商宝 taobao-parser（字段别名表 + 形状识别双保险，平台改版只需追加别名）
(function(){
'use strict';

function nUrl(u){
  if (!u) return '';
  if (u.indexOf('//') === 0) u = 'https:' + u;
  if (!/^https?:/.test(u)) return '';
  return u;
}

// ===== 字段别名注册表 =====
var FIELD_ALIASES = {
  mainImages: ['images', 'imagePaths', 'itemImgs', 'mainImgs', 'picUrl', 'picUrls', 'itemImages', 'topImages', 'imageList', 'mainPics'],
  skuBase: ['skuBase', 'skuModel', 'skuInfo', 'sku', 'skuBaseModel', 'skuData', 'specModel'],
  skuProps: ['props', 'skuProps', 'attrList', 'productFeatureList', 'specProps', 'propList', 'attributes'],
  propVals: ['values', 'valueList', 'vals', 'value', 'list', 'items'],
  propName: ['name', 'propName', 'key', 'propertyName', 'prop', 'fid'],
  valName: ['name', 'text', 'valueName', 'value', 'specName', 'attrName'],
  skuList: ['skus', 'skuList', 'list', 'skuRows'],
  skuMap: ['skuMap', 'skuMaps', 'map', 'skuInfoMap', 'skuCompositeMap', 'ppathIdvalueIdToSkuId', 'sku2info', 'skuInfoMap2']
};
// v1.2.276 远程别名合并：远程 common.fieldAliases 追加的别名直接生效（平台改字段名无需发版）
function mergeRemoteAliases(){
  try {
    if (typeof window === 'undefined' || !window.AisAnchors || !window.AisAnchors.alias) return;
    Object.keys(FIELD_ALIASES).forEach(function (g) {
      var ex = window.AisAnchors.alias(g, null);
      if (ex && ex.length) ex.forEach(function (k) { if (k && FIELD_ALIASES[g].indexOf(k) < 0) FIELD_ALIASES[g].push(k); });
    });
  } catch (e) {}
}
mergeRemoteAliases();
try { document.addEventListener('cfg:sync', function () { mergeRemoteAliases(); }); } catch (e) {}
var __fieldHits = {};
function hitField(group, key){ try { if (!__fieldHits[group]) __fieldHits[group] = {}; __fieldHits[group][key] = (__fieldHits[group][key] || 0) + 1; } catch(e){} }

function obj(v){ if (typeof v === 'string') { try { var q = JSON.parse(v); return q && typeof q === 'object' ? q : v; } catch(e){} } return v; }

// 深度解包：优先取 data/item/offer 容器
function findData(root, depth){
  depth = depth || 0;
  var v = obj(root);
  if (!v || typeof v !== 'object' || depth > 4) return v;
  if (v.data && typeof v.data === 'object' && !Array.isArray(v.data)) return findData(v.data, depth + 1);
  if (v.item && typeof v.item === 'object') return v.item;
  if (v.offer && typeof v.offer === 'object') return v.offer;
  return v;
}

// 深度收集图片 URL（字符串值看起来是图片链接就收）
function deepCollectImages(root, out, depth){
  depth = depth || 0;
  out = out || [];
  if (depth > 9 || root == null || out.length >= 200) return out;
  if (Array.isArray(root)) { for (var i = 0; i < root.length; i++) deepCollectImages(root[i], out, depth + 1); return out; }
  if (typeof root === 'object') {
    var keys = Object.keys(root);
    for (var j = 0; j < keys.length; j++) {
      var v = root[keys[j]];
      if (typeof v === 'string') {
        var x = nUrl(v);
        if (x && /\.(jpg|jpeg|jfif|png|webp|avif|bmp)(\?|$)/i.test(x) && !/(?:logo|icon|sprite|avatar|loading|blank|spacer)/i.test(x) && out.indexOf(x) < 0) out.push(x);
      } else if (v && typeof v === 'object') deepCollectImages(v, out, depth + 1);
    }
  }
  return out;
}

// 主图提取：字段别名 → 图片容器深度扫描
function extractMainImages(data){
  data = findData(data) || {};
  var cand = [];
  function collectImgField(node){
    if (!node || typeof node !== 'object' || cand.length > 60) return;
    for (var mi = 0; mi < FIELD_ALIASES.mainImages.length; mi++){
      var mik = FIELD_ALIASES.mainImages[mi];
      if (node[mik] != null) {
        var v = node[mik];
        if (Array.isArray(v)) { v.forEach(function(u){ var x = nUrl(typeof u === 'string' ? u : (u && (u.src || u.url || u.imgUrl || u.full || u.image)) || ''); if (x && cand.indexOf(x) < 0) { cand.push(x); hitField('mainImages', mik); } }); }
        else if (typeof v === 'string') { var x2 = nUrl(v); if (x2 && cand.indexOf(x2) < 0) { cand.push(x2); hitField('mainImages', mik); } }
        else if (v && typeof v === 'object') collectImgField(v);
      }
    }
    if (node.item && typeof node.item === 'object') collectImgField(node.item);
    if (node.offer && typeof node.offer === 'object') collectImgField(node.offer);
  }
  collectImgField(data);
  if (!cand.length) cand = deepCollectImages(data).slice(0, 30);
  return cand;
}

function deepFindUrl(data, key){
  var out = '';
  try {
    if (Array.isArray(data)) { for (var i = 0; i < data.length; i++) { out = deepFindUrl(data[i], key); if (out) return out; } return ''; }
    if (data && typeof data === 'object') {
      if (key in data) { var v = data[key]; if (typeof v === 'string') { var x = nUrl(v); if (x) return x; } if (v && typeof v === 'object') { var x2 = nUrl(v.url || v.src || v.href); if (x2) return x2; } }
      var keys = Object.keys(data);
      for (var j = 0; j < keys.length; j++) { out = deepFindUrl(data[keys[j]], key); if (out) return out; }
    }
  } catch(e){}
  return '';
}

function extractDescUrl(data){
  data = data || {};
  var it0 = data.item || {}, of0 = data.offer || {};
  var v = (it0 && (it0.pcADescUrl || it0.descUrl)) || data.descUrl ||
    (it0 && it0.desc) || (of0 && (of0.pcADescUrl || of0.descUrl || of0.desc)) ||
    (data.description && data.description.fields && (data.description.fields.detailUrl || data.description.fields.pcDescUrl));
  if (v && typeof v === 'string') { var x = nUrl(v); if (x) return x; }
  return deepFindUrl(data, 'pcADescUrl') || deepFindUrl(data, 'descUrl') || deepFindUrl(data, 'detailUrl');
}

function extractVideo(data){
  if (!data) return '';
  function pickUrl(o){ return nUrl(o.url || o.src || o.videoUrl || o.video || o.playUrl || o.mp4Url || o.previewUrl || ''); }
  var v = data.video || data.videoUrl || data.videoInfo || data.mainVideo || data.videoData || '';
  if (typeof v === 'object') v = v.url || v.src || v.videoUrl || v.video || v.previewUrl || '';
  if (!v && data.item) { v = data.item.video || data.item.videoUrl || data.item.videoInfo || data.item.mainVideo || ''; if (typeof v === 'object') v = v.url || v.src || v.videoUrl || v.video || v.previewUrl || ''; }
  if (!v && data.offer) { v = data.offer.video || data.offer.videoUrl || data.offer.videoInfo || ''; if (typeof v === 'object') v = v.url || v.src || v.videoUrl || v.video || ''; }
  if (!v) v = deepFindUrl(data, 'video') || deepFindUrl(data, 'videoUrl') || deepFindUrl(data, 'mainVideo');
  if (typeof v === 'string' && /\.(mp4|mov|m3u8)/i.test(v)) return nUrl(v);
  return '';
}

// ===== 形状识别（不认字段名，认结构） =====
function isSkuBaseShape(v){
  if (!v || typeof v !== 'object') return false;
  var p = v.props || v.skuProps || v.propList || v.attrList;
  if (!Array.isArray(p) || !p.length) return false;
  var first = p[0] && typeof p[0] === 'object' ? p[0] : null;
  if (!first || (!Array.isArray(first.values) && !Array.isArray(first.valueList) && !Array.isArray(first.value))) return false;
  return Array.isArray(v.skus) || Array.isArray(v.skuList) || (v.skuMap && typeof v.skuMap === 'object') || (v.skuInfoMap && typeof v.skuInfoMap === 'object') || (v.map && typeof v.map === 'object');
}
function findSkuBaseByShape(root, depth){
  depth = depth || 0;
  if (depth > 8 || root == null) return null;
  if (Array.isArray(root)) { for (var i = 0; i < root.length; i++) { var h = findSkuBaseByShape(root[i], depth + 1); if (h) return h; } return null; }
  if (typeof root === 'object') {
    if (isSkuBaseShape(root)) return root;
    var keys = Object.keys(root);
    for (var j = 0; j < keys.length; j++) { var h2 = findSkuBaseByShape(root[keys[j]], depth + 1); if (h2) return h2; }
  }
  return null;
}

// 解析 SKU 基座 → {props, skus}
function parseSkuBase(data){
  data = data || {};
  function findBase(v, depth){
    v = obj(v); if (!v || typeof v !== 'object' || depth > 8) return null;
    var baseKeys = FIELD_ALIASES.skuBase;
    for (var bi = 0; bi < baseKeys.length; bi++) { var bk = baseKeys[bi]; if (v[bk] && typeof v[bk] === 'object') { hitField('skuBase', bk); return obj(v[bk]); } }
    var shaped = findSkuBaseByShape(v, 0);
    if (shaped) return shaped;
    var keys = Object.keys(v);
    for (var i = 0; i < keys.length; i++) { var k = keys[i]; if (k === 'ret' || k === 'traceId') continue; var hit = findBase(v[k], depth + 1); if (hit) return hit; }
    return null;
  }
  var sb = findBase(data, 0) || {};
  var props = [], skus = [];
  var rawProps = [];
  for (var rpi = 0; rpi < FIELD_ALIASES.skuProps.length; rpi++){ var rpk = FIELD_ALIASES.skuProps[rpi]; if (sb[rpk] && Array.isArray(sb[rpk])) { rawProps = sb[rpk]; hitField('skuProps', rpk); break; } }
  if (Array.isArray(rawProps)) rawProps.forEach(function(p){
    p = obj(p) || {};
    var vals = [];
    for (var pvi = 0; pvi < FIELD_ALIASES.propVals.length; pvi++){ var pvk = FIELD_ALIASES.propVals[pvi]; if (p[pvk] && Array.isArray(p[pvk])) { vals = p[pvk]; hitField('propVals', pvk); break; } }
    var values = (Array.isArray(vals) ? vals : []).map(function(v){ v = obj(v) || {}; return { vid: v.vid || v.id || v.valueId || v.specId || '', name: v.name || v.text || v.valueName || v.value || v.specName || '', image: nUrl(v.image || v.img || v.pic || v.imgUrl || '') }; });
    props.push({ pid: p.pid || p.propId || p.propertyId || '', name: p.name || p.propName || p.key || p.propertyName || '', values: values });
  });
  var rawSkus = [];
  for (var sri = 0; sri < FIELD_ALIASES.skuList.length; sri++){ var srk = FIELD_ALIASES.skuList[sri]; if (sb[srk] && Array.isArray(sb[srk])) { rawSkus = sb[srk]; hitField('skuList', srk); break; } }
  var sm = null;
  for (var smi = 0; smi < FIELD_ALIASES.skuMap.length; smi++){ var smk = FIELD_ALIASES.skuMap[smi]; if (sb[smk] && typeof sb[smk] === 'object' && !Array.isArray(sb[smk])) { sm = obj(sb[smk]); hitField('skuMap', smk); break; } }
  if (!sm) sm = obj(sb.skuMap || sb.skuMaps || sb.map);
  if (sm && typeof sm === 'object' && !Array.isArray(sm)) {
    rawSkus = [];
    Object.keys(sm).forEach(function(key){ var v = obj(sm[key]) || {}; rawSkus.push({ skuId: String(v.skuId || v.id || v.sku_id || (key.match(/\d{8,}/) || [])[0] || ''), outerId: v.outerId || v.outer_id || '', propPath: key, price: v.price || v.priceText || v.salePrice || (v.priceInfo && v.priceInfo.price) || '', quantity: v.quantity != null ? v.quantity : (v.stock != null ? v.stock : 0), image: v.image || v.img || v.picUrl || v.imgUrl || '' }); });
  }
  if (Array.isArray(rawSkus)) rawSkus.forEach(function(s){
    s = obj(s) || {};
    var pr = s.price; if (pr && typeof pr === 'object') pr = pr.price || pr.priceText || pr.salePrice || pr.amount || '';
    skus.push({ skuId: s.skuId || s.id || s.sku_id || '', outerId: s.outerId || s.outer_id || '', propPath: s.propPath || s.propMap || s.skuProp || s.properties || s.name || '', price: pr || s.salePrice || s.priceString || '', quantity: s.quantity != null ? s.quantity : (s.stock != null ? s.stock : 0), image: nUrl(s.image || s.img || s.picUrl || s.imgUrl || '') });  });
  // v1.1.36 真实接口：pcdetail/getdetail 的 skuCore.sku2info（skuId 为键）合并价格/库存/图片
  var core = null;
  (function findCore(v, depth){ v = obj(v); if (!v || depth > 8 || core) return; if (v.sku2info && typeof v.sku2info === "object" && !Array.isArray(v.sku2info)) { core = obj(v.sku2info); return; } var ks = Object.keys(v); for (var i = 0; i < ks.length; i++){ if (ks[i] === "ret" || ks[i] === "traceId") continue; findCore(v[ks[i]], depth + 1); } })(data, 0);
  if (core) {
    Object.keys(core).forEach(function(skuId){
      var v = obj(core[skuId]) || {};
      var pr = v.price;
      if (pr && typeof pr === "object") pr = pr.price || pr.priceText || pr.salePrice || pr.amount || "";
      var qty = v.quantity != null ? v.quantity : (v.stock != null ? v.stock : "");
      var img = nUrl(v.image || v.img || v.picUrl || v.imgUrl || "");
      var found = null;
      for (var i = 0; i < skus.length; i++) { if (String(skus[i].skuId) === String(skuId)) { found = skus[i]; break; } }
      if (found) { if (!found.price && pr) found.price = pr; if (!found.quantity && qty !== "") found.quantity = qty; if (!found.image && img) found.image = img; }
      else skus.push({ skuId: String(skuId), propPath: v.propPath || "", price: pr, quantity: qty, image: img });
    });
  }
  return { props: props, skus: skus };
}

// v1.1.36 商品参数（props/attributes 列表）提取
function parseItemProps(data){
  data = data || {};
  var out = [], seen = {};
  function addP(n, val){
    n = String(n || "").trim();
    if (val && typeof val === "object") { val = Array.isArray(val) ? val.map(function(x){ var o = obj(x); return (o && (o.name || o.value || o.text)) || ""; }).join(" ") : ""; }
    val = String(val || "").trim();
    if (!n || !val || n.length > 30 || val.length > 120) return;
    var k = n + "|" + val;
    if (seen[k]) return;
    seen[k] = 1;
    out.push({ name: n, value: val });
  }
  function addList(arr){
    if (!Array.isArray(arr)) return;
    arr.forEach(function(p){
      var o = obj(p) || {};
      if (typeof p === "string") { var m = p.match(/^(.{1,20}?)[：:]\s*(.+)$/); if (m) addP(m[1], m[2]); return; }
      addP(o.name || o.propName || o.attrName || o.key || o.title || "", o.value || o.val || o.propValue || o.attrValue || o.content || "");
    });
  }
  (function walk(v, depth){
    v = obj(v);
    if (!v || typeof v !== "object" || depth > 8 || out.length > 80) return;
    addList(v.props); addList(v.attributes); addList(v.propList); addList(v.params); addList(v.featureList); addList(v.soldParams); addList(v.attrs); addList(v.properties); addList(v.specParams);
    if (v.props2) addList(v.props2);
    var ks = Object.keys(v);
    for (var i = 0; i < ks.length; i++) { if (ks[i] === "ret" || ks[i] === "traceId") continue; walk(v[ks[i]], depth + 1); }
  })(data, 0);
  return out;
}
// 构建 SKU 规格表行（供导出）
function buildSkuTable(data, itemInfo){
  var sb = parseSkuBase(data);
  var propNames = sb.props.map(function(p){ return p.name; }).filter(Boolean);
  var lookup = {};
  // v1.2.413【根治】：淘宝/天猫的 SKU 图片**不在** skus[] 里，而在 props[].values[].image。
  //   真机抓包实证（item 812107626975）：skus[] 只有 {propPath, skuId}，图片挂在值上：
  //     props[0].values[0] = {vid:-9, name:"枪灰30带5钩…", image:"https://gw.alicdn.com/…"}
  //   原实现只读 s.image（永远为空）→ 行有了、规格有了，图恒为空。
  //   值上的字段名是固定的（vid/name/image），**不随改版的随机类名变化**，故优先用它。
  var imgLookup = {};
  sb.props.forEach(function(p){
    lookup[String(p.pid) + ':name'] = p.name;
    (p.values || []).forEach(function(v){
      var key = String(p.pid) + ':' + String(v.vid);
      lookup[key] = v.name;
      if (v.image) imgLookup[key] = v.image;
    });
  });
  var info = itemInfo || {};
  // v1.2.432【用户要求】序号按【分类】标：第一个有值的维度（通常「颜色分类」）的顺序即序号 ——
  //   同一分类值（KF6750 / KF6751 …）下的所有规格行共用同一个序号，顺序 = 面板里分类值的显示顺序。
  //   逐行序号保留在【行号】列，信息不丢（ERP 里唯一键仍用 SKU_ID / 规格）。
  // v1.2.436【用户要求】序号按【指定维度】标，并按该维度的值顺序【排序】：
  //   维度默认 = 第一个有值的维度；可用规则键 common.skuSerialProp 指定（如「规格2」）——
  //   同一个维度值共用一个序号（KF6750/S/… 各自一个号），不再按规格1 排。
  // v1.2.437【用户要求】把「排序维度」与「序号维度」拆开（此前共用一个键，改一个会带歪另一个 ✗）：
  //   common.skuSortProp   = 行序按哪个维度排（默认空 = 不重排，保持接口原顺序 ✓）
  //   common.skuSerialProp = 序号按哪个维度给（默认空 = 第一个有值的维度，通常就是「机身颜色」✓）
  function pickProp(wantName) {
    try {
      if (wantName) {
        for (var a1 = 0; a1 < sb.props.length; a1++) { var q1 = sb.props[a1]; if (q1 && (q1.values || []).length && String(q1.name) === wantName) return q1; }
      }
      for (var a2 = 0; a2 < sb.props.length; a2++) { var q2 = sb.props[a2]; if (q2 && (q2.values || []).length) return q2; }
    } catch (eP) {}
    return null;
  }
  var wantSerial = '', wantSort = '';
  try { wantSerial = (typeof aisSel === 'function') ? String(aisSel('common.skuSerialProp', '') || '') : ''; } catch (eW1) {}
  try { wantSort = (typeof aisSel === 'function') ? String(aisSel('common.skuSortProp', '') || '') : ''; } catch (eW2) {}
  var serProp = pickProp(wantSerial);          // 序号维度（默认第一个 = 机身颜色）
  // v1.2.437：排序支持复合维度 "A|B"（先按 A 聚合、A 内再按 B）—— 用于「先按机身颜色聚在一起、色内按规格2」✓
  var sortNames = [];
  if (wantSort) { wantSort.split('|').forEach(function (nm) { nm = String(nm || '').trim(); if (nm) { var q = pickProp(nm); if (q && String(q.name) === nm && sortNames.indexOf(nm) < 0) sortNames.push(nm); } }); }
  var clsPid = serProp ? String(serProp.pid) : '', clsOrd = {};
  var clsOrdName = {};
  if (serProp) { (serProp.values || []).forEach(function (v, vi) { clsOrd[String(v.vid)] = vi + 1; clsOrdName[String(v.name)] = vi + 1; }); }
  var serName = serProp ? String(serProp.name) : '';
  var sortName = sortNames[0] || '';
  var sortOrd = {};
  sortNames.forEach(function (nm) {
    var q = pickProp(nm); if (!q) return;
    (q.values || []).forEach(function (v, vi) { sortOrd[nm + '\u0001' + String(v.name)] = vi + 1; });
  });
  var rows = sb.skus.map(function(s, idx){
    var row = { 序号: idx + 1, 行号: idx + 1, 商品标题: String(info.title || ''), 商品ID: String(info.itemId || ''), 商品链接: String(info.url || ''), SKU_ID: s.skuId, 商家编码: s.outerId || '', 规格: s.propPath, 价格: s.price, 库存: s.quantity };
    var shown = [];
    String(s.propPath || '').split(/[;,]/).forEach(function(part){
      var seg = part.split(':'); if (seg.length < 2) return;
      var pk = seg[0].trim(), pv = seg.slice(1).join(':').trim();
      var name = lookup[pk + ':name'] || pk, val = lookup[pk + ':' + pv] || pv;
      if (name) { row[name] = val; shown.push(name + ':' + val); }
    });
    if (shown.length) row.规格 = shown.join(';');
    // v1.2.413：图片优先取【值】上的图（接口稳定字段），skus[] 上的 image 仅作兜底
    var rowImg = s.image || '';
    if (!rowImg) {
      String(s.propPath || '').split(/[;,]/).forEach(function(part){
        if (rowImg) return;
        var seg = part.split(':'); if (seg.length < 2) return;
        var u = imgLookup[seg[0].trim() + ':' + seg.slice(1).join(':').trim()];
        if (u) rowImg = u;
      });
    }
    if (rowImg) row['SKU图'] = rowImg;
    // v1.2.432：按分类值定序号（找不到就退回逐行序号）
    try {
      if (clsPid) {
        var ord = 0, pc = String(s.propPath || '').split(/[;,]/);
        for (var ci = 0; ci < pc.length; ci++) {
          var sc = pc[ci].split(':'); if (sc.length < 2) continue;
          if (sc[0].trim() === clsPid) { ord = clsOrd[sc.slice(1).join(':').trim()] || 0; break; }
        }
        if (ord) row['序号'] = ord;
      }
    } catch (eOrd) {}
    return row;
  });
  // v1.2.436：按【指定维度】的值顺序重排行序并给序号（同值同号），行号=重排后的位置
  try {
    // ① 行序：按 skuSortProp（未配置则不重排 ✓）
    if (sortNames.length) {
      rows.forEach(function (r) { r.__so = sortNames.map(function (nm) { return sortOrd[nm + '\u0001' + String(r[nm] || '')] || 9999; }); });
      rows.sort(function (a, b) {
        for (var si = 0; si < sortNames.length; si++) { var d1 = (a.__so[si] || 9999) - (b.__so[si] || 9999); if (d1) return d1; }
        return 0;   // v1.2.437 复合排序：逐级比较，全等则保持原顺序
      });
      rows.forEach(function (r) { delete r.__so; });
    }
    // ② 序号：按 skuSerialProp（默认第一个维度）—— 同值共用同一个序号 ✓
    rows.forEach(function (r, i) {
      var o = serName ? (clsOrdName[String(r[serName] || '')] || 0) : 0;
      if (o) r['序号'] = o;
      r['行号'] = i + 1;
    });
  } catch (eSort) {}
  return { rows: rows, propNames: propNames };
}

// 汇总图片分类
function collectImages(detailData, skuData){
  var raw = obj(detailData) || {};
  var d = findData(detailData), s = findData(skuData);
  // v1.1.36 修复：skuBase/video/descUrl 常挂在 item 同级（而非 item 内），先从原始根找
  var sbD = parseSkuBase(raw), sbS = parseSkuBase(s);
  if (!sbD.props.length && !sbD.skus.length) sbD = parseSkuBase(d);
  var skuImages = [], valueImgs = [];
  [sbD, sbS].forEach(function(sb){
    sb.props.forEach(function(p){ (p.values || []).forEach(function(v){ if (v.image){ skuImages.push(v.image); valueImgs.push({ name: p.name || '', value: v.name || '', image: v.image }); } }); });
    (sb.skus || []).forEach(function(sk){ if (sk.image){ skuImages.push(sk.image); valueImgs.push({ name: '', value: String(sk.propPath || ''), image: sk.image }); } });
  });
  skuImages = skuImages.filter(function(u, i, a){ return u && a.indexOf(u) === i; });
  var mainImgs = extractMainImages(d);
  if (!mainImgs.length) mainImgs = extractMainImages(detailData);
  var vid = extractVideo(detailData) || extractVideo(d);
  var du = extractDescUrl(detailData) || extractDescUrl(d);
  return {
    main: mainImgs,
    sku: skuImages,
    desc: [],
    valueImgs: valueImgs,
    video: vid || extractVideo(raw) || extractVideo(d),
    descUrl: du || extractDescUrl(raw) || extractDescUrl(d)
  };
}

// 解析详情描述接口响应 → 图片 URL 列表
function parseDescImages(data){
  data = data || {};
  var d = data.data || data;
  if (d && d.components && d.components.componentData) {
    var cd = d.components.componentData, seen = {}, out = [];
    Object.keys(cd).forEach(function(k){
      var v = cd[k];
      var u = v && (v.picUrl || (v.model && v.model.picUrl) || (v.model && v.model.imageUrl) || (v.img && v.img.src)) || '';
      u = nUrl(u);
      if (u && !seen[u]) { seen[u] = 1; out.push(u); }
    });
    if (out.length) return out.slice(0, 200);
  }
  var html = '';
  if (typeof d === 'string') html = d;
  else if (d && typeof d.desc === 'string') html = d.desc;
  else if (d && typeof d.data === 'string') html = d.data;
  else if (d && d.item && typeof d.item.desc === 'string') html = d.item.desc;
  if (!html) {
    try {
      var s = JSON.stringify(data);
      var m = s.match(/"desc"\s*:\s*"([^"]{100,})"/);
      if (m) html = m[1].replace(/\\u003C/g, '<').replace(/\\u003E/g, '>');
    } catch(e){}
  }
  if (!html) return [];
  html = html.split(String.fromCharCode(92) + '/').join('/');
  var seen2 = {}, out2 = [];
  function push(u){ u = nUrl(u); if (u && !seen2[u]) { seen2[u] = 1; out2.push(u); } }
  var re = /(?:data-ks-lazyload|data-lazyload|data-lazy|data-original|data-src|src)=["']([^"']+[.](?:jpg|jpeg|jfif|png|webp|avif|bmp|gif)(?:[?][^"']*)?)/gi;
  var mm;
  while ((mm = re.exec(html)) !== null) push(mm[1]);
  var re2 = /(?:https?:)?\/\/[^"'<>]+[.](?:jpg|jpeg|jfif|png|webp|avif|bmp|gif)(?:[?][^"'<>]*)?/gi;
  while ((mm = re2.exec(html)) !== null) push(mm[0]);
  var __r2 = out2.slice(0, 200);
  if (__r2.length) return __r2;
  return parseDescImagesDeep(data);
}


  // v1.1.36 deep fallback: scan whole response JSON for image URLs
  // (covers new Taobao pages where desc HTML is embedded inside the detail response)
  function parseDescImagesDeep(data){
    if (!data) return [];
    var s = '';
    try { s = (typeof data === 'string') ? data : JSON.stringify(data); } catch(e){ return []; }
    var seen = {}, out = [];
    var re = /(?:https?:)?\/\/[^"'<>\s\\]+[.](?:jpg|jpeg|jfif|png|webp|avif|bmp)(?:\?[^"'<>\s\\]*)?/gi;
    var m;
    while ((m = re.exec(s)) !== null) {
      var u = m[0];
      if (u.indexOf('//') === 0) u = 'https:' + u;
      if (!/^https?:/.test(u)) continue;
      if (seen[u]) continue;
      seen[u] = 1;
      if (/(?:logo|icon|sprite|avatar|spacer|blank|_60x60|\/60x60)/i.test(u)) continue;
      out.push(u);
    }
    return out.slice(0, 200);
  }

function parseReviews(data){
  data = data || {};
  function unwrap(v){
    if(typeof v==='string'){ try{ var q=JSON.parse(v); return q&&typeof q==='object'?q:v; }catch(e){} }
    return v;
  }
  var root=unwrap(data);
  if(root&&root.data!=null) root=unwrap(root.data);
  if(root&&root.result!=null && !Array.isArray(root.result)) root=unwrap(root.result);
  if(root&&root.data!=null && typeof root.data==='object') root=unwrap(root.data);
  var list = root.commentInfoList || root.commentInfo || root.rateList || root.rateItems || root.comments || root.reviews || root.reviewList || root.rateListArray || root.list || root.rateItemList || root.reviewItems || root.dataList || root.model || (root.item && (root.item.rateList||root.item.comments||root.item.reviewList)) || (root.offer && (root.offer.rateList||root.offer.comments||root.offer.reviewList)) || []; // v1.1.89：补 1688 data.model
  var revs = [];
  if (Array.isArray(list)) {
    list.forEach(function(r){
      if (!r) return;
      var imgs = [];
      var ri = r.feedPicPathList || r.feedPicList || r.imageList || r.posterImgList || r.images || r.picUrls || r.photos || r.media || r.medias || (r.rateContent && (typeof r.rateContent==='object' && r.rateContent.images)) || []; // v1.1.89：补 1688 imageList/posterImgList
      if (Array.isArray(ri)) ri.forEach(function(x){ if(typeof x==='string'){var u=nUrl(x); if(u)imgs.push(u);} else if(x){ var u=nUrl(x.url||x.src||x.imgUrl||x.pic||''); if(u)imgs.push(u); } });
      var content = r.feedback || r.commentData || r.content || r.rateContent || r.comment || r.text || r.tagCommentContent || (r.rateContent && r.rateContent.text) || '';
      if (typeof content === 'object') content = content.text || '';
      revs.push({
        reviewId: r.id || r.rateId || r.commentId || r.reviewId || r.guid || '',
        content: String(content).trim(),
        rating: normalizeRating(r),
        username: r.raterUserNick || r.ratedUserNick || r.userNickName || r.userNick || r.nickname || r.userNnick || r.userName || r.nick || (r.user && (r.user.nick||r.user.userNick)) || (r.rateUser && r.rateUser.userNick) || '', // v1.1.89：补 1688 raterUserNick
        skuInfo: (function(){ var sv = r.skuInfo || r.specInfo || r.skuValueStr || r.property || r.skuProp || (r.auction && r.auction.sku) || (r.rateItem && r.rateItem.sku) || (r.sku && (r.sku.skuName || r.sku.name || r.sku.spec || r.sku.skuInfo)) || (r.spec && r.spec.specName) || (r.attr && r.attr.attrName) || ''; if (sv && typeof sv === 'object') sv = sv.skuName || sv.name || sv.text || sv.spec || sv.value || sv.skuInfo || ''; if (sv && typeof sv === 'string' && sv.indexOf('{') === 0) { try { var svj = JSON.parse(sv); sv = svj.skuName || svj.name || svj.text || svj.spec || svj.skuInfo || ''; } catch (e) {} } return String(sv || '').trim(); })(),
        time: r.commentDate || r.createTime || r.rateDate || r.creationTime || r.referenceTime || r.gmtCreate || r.date || r.time || '',
        hasImage: imgs.length > 0,
        images: imgs,
        isAppend: !!(r.isAppend || r.append || (r.appendContent||'')),
        appendContent: r.appendContent || r.append || ''
      });
    });
  }
  return revs;
}

// 从内嵌 SSR rateVO JSON 提取评论（淘宝新版详情页HTML内嵌的数据）
// 搜索 "rateVO":{ 并用平衡括号提取 JSON，解析 group.items
function parseReviewsFromSsr(html){
  if(!html) return [];
  try{
    var keyIdx = html.indexOf('"rateVO":{');
    if(keyIdx < 0) return [];
    var depth=0, end=-1, inStr=false, esc=false, c;
    for(var i=keyIdx+9; i<html.length; i++){
      c=html[i];
      if(esc){ esc=false; continue; }
      if(c==='\\'){ esc=true; continue; }
      if(inStr){ if(c==='"') inStr=false; continue; }
      if(c==='"'){ inStr=true; continue; }
      if(c==='{') depth++;
      else if(c==='}'){ depth--; if(depth===0){ end=i; break; } }
    }
    if(end<0) return [];
    var rateVO = JSON.parse(html.substring(keyIdx+9, end+1));
    var items = (rateVO.group && rateVO.group.items) || rateVO.items || [];
    var reviews = [];
    items.forEach(function(it){
      if(!it) return;
      var content = it.content || it.comment || it.reviewContent || '';
      if(!content) return;
      reviews.push({
        reviewId: it.feedId || it.id || it.reviewId || '',
        content: typeof content==='string'?content:JSON.stringify(content),
        rating: normalizeRating(it),
        username: it.userNickName || it.nickname || it.userNnick || it.userName || it.nick || '',
        skuInfo: it.productColor || it.productSize || it.skuInfo || it.sku || '',
        time: it.dateTime || it.createTime || it.commentDate || it.rateDate || it.creationTime || it.referenceTime || it.gmtCreate || it.date || it.time || '',
        hasImage: !!(it.feedPicPathList && it.feedPicPathList.length) || !!(it.feedPicList && it.feedPicList.length) || !!(it.images && it.images.length) || !!(it.picUrls && it.picUrls.length) || !!(it.media && it.media.length), // v1.1.119：补 feedPicPathList（SSR rateVO 与 mtop 同字段）
        // v1.1.119：图片别名链与 parseReviews 对齐（feedPicPathList 缺失曾导致 SSR 来源实时明细全无图）+ nUrl 协议相对补全
        images: (function(){ var ri = it.feedPicPathList || it.feedPicList || it.imageList || it.posterImgList || it.images || it.picUrls || it.photos || it.media || []; var imgs = []; if (Array.isArray(ri)) ri.forEach(function (x) { var u = (typeof x === 'string') ? x : ((x && (x.url || x.src || x.imgUrl || x.pic)) || ''); u = nUrl(String(u || '').trim()); if (u) imgs.push(u); }); return imgs.slice(0, 6); })(),
        isAppend: !!(it.isAppend || it.commentType==='2'),
        appendContent: it.appendContent || it.addFeedback || ''
      });
    });
    return reviews;
  }catch(e){ return []; }
}

function normalizeRating(r){
  // V2.0.1 兼容：字段优先级对齐 mtop 评论接口（含 displayRate/grade/sellerRate/value，SSR rateVO 用 displayRate）
  var s = r.displayRate != null ? r.displayRate : (r.commentScore != null ? r.commentScore :
        (r.score != null ? r.score : (r.rating != null ? r.rating : (r.star != null ? r.star :
        (r.userStar != null ? r.userStar : (r.starLevel != null ? r.starLevel : (r.rate != null ? r.rate :
        (r.grade != null ? r.grade : (r.sellerRate != null ? r.sellerRate : (r.value != null ? r.value : null))))))))));
  if (s == null) { s = (r.user && r.user.star) != null ? r.user.star : null; }
  // detaillist 6.0: rateType 1=好评5星 3=中评3星 5=差评1星
  if (s == null && r.rateType != null) { var rt = parseInt(r.rateType, 10); if (rt === 1) s = 5; else if (rt === 3) s = 3; else if (rt === 5) s = 1; }
  if (s == null) return 0;
  var text = String(s).trim();
  var num = Number(text);
  if (isFinite(num) && num >= 1 && num <= 5) return Math.round(num);
  var m = text.match(/([1-5](?:\.\d)?)\s*(?:星|star|分)/i);
  if (m) return Math.min(5, Math.max(1, Math.round(parseFloat(m[1]))));
  if (/差评|负|不满|bad|negative/i.test(text)) return 1;
  if (/中评|一般|neutral/i.test(text)) return 3;
  if (/好评|满意|positive|good/i.test(text)) return 5;
  var rt = r.rateType != null ? String(r.rateType).toLowerCase() : '';
  if (rt === '-1' || /bad|负|差评/.test(rt)) return 1;
  if (rt === '0' || /neutral|中评/.test(rt)) return 3;
  if (rt === '1' || /positive|好评/.test(rt)) return 5;
  return 0;
}

// 汇总当前商品下载分类：主图/SKU图/详情图/视频

// v1.2.460【移植自电商宝 content/panel.js:2926「京东 SKU 兜底：MAIN world pageConfig.product」】
//   京东买家页的 window.pageConfig.product 里有 colorSize（规格维度定义）+ skus（skuId → 各维度值），
//   **不依赖接口拦截、不依赖 DOM 类名、不依赖登录** —— 电商宝靠这一路长期稳定取到京东 SKU（用户实证）。
//   形状：colorSize: [ { 维度名: [ { 值名: 图片URL } | { 值名: '' }, ... ] }, ... ]
//         skus:      { "值1;值2": { 维度名: 值名, ... }, ... }
//   输出：{ props: [{pid,name,values:[{vid,name,image}]}], skus: [{skuId,propPath,price,quantity,image}] }
function jdPageConfigToSkuBase(jdp) {
  var out = { props: [], skus: [] };
  try {
    jdp = jdp || {};
    var colorSize = jdp.colorSize || [];
    var props = [];
    for (var ci = 0; ci < colorSize.length; ci++) {
      var dim = colorSize[ci] || {};
      var dKeys = Object.keys(dim);
      if (!dKeys.length) continue;
      var dimName = dKeys[0];
      var rawVals = dim[dimName] || [];
      var values = [];
      for (var vi = 0; vi < rawVals.length; vi++) {
        var v = jdPickSpecValue(rawVals[vi]);
        if (v.name) values.push({ vid: v.name, name: v.name, image: v.image });
      }
      if (values.length) props.push({ pid: dimName, name: dimName, values: values });
    }
    var skuMap = jdp.skus || {};
    var sIds = Object.keys(skuMap);
    // 与电商宝一致：没有维度定义或没有组合表时不出 SKU（避免造出「规格1:xxx」这种假列名）
    if (!props.length || !sIds.length) return out;
    var dimNames = props.map(function (x) { return x.name; });
    var vid2img = {};
    props.forEach(function (pp) { (pp.values || []).forEach(function (vv) { if (vv.image) vid2img[vv.name] = vv.image; }); });
    var skus = [];
    for (var si = 0; si < sIds.length; si++) {
      var sid = sIds[si];
      var combo = skuMap[sid] || {};
      var parts = String(sid).split(';');
      var propPath = [], imgs = [];
      for (var di = 0; di < parts.length; di++) {
        var vname = String(combo[dimNames[di]] != null ? combo[dimNames[di]] : parts[di]).trim();
        var pname = dimNames[di] || ('规格' + (di + 1));
        if (vname) propPath.push(pname + ':' + vname);
        if (vid2img[vname]) imgs.push(vid2img[vname]);
      }
      if (propPath.length) skus.push({ skuId: sid, propPath: propPath.join(';'), price: '', quantity: 0, image: imgs[0] || '' });
    }
    out.props = props; out.skus = skus;
  } catch (e) {}
  return out;
}

// v1.2.460 京东规格「值」的三种真实形状都要吃得下（单测实测抓到的坑）：
//   A. { "深海蓝": "//img14…/blue.jpg" }  ← 京东实测形状：**单键**，键=值名、值=图片 URL（或空串=无图）
//   B. { "value": "深海蓝", "image": "//…" } / { "name": …, "url": … } ← 电商宝代码口径（两个键：第1个=名、第2个=图）
//   C. { "M": "" } ← 单键但值是空串：此时**键就是值名**（照抄电商宝会把整个尺码维度丢掉 → 列名退化成「规格2」）
function jdPickSpecValue(rv) {
  var res = { name: '', image: '' };
  try {
    if (rv == null) return res;
    if (typeof rv === 'string' || typeof rv === 'number') return { name: String(rv), image: '' };
    var ks = Object.keys(rv);
    if (!ks.length) return res;
    var isImg = function (s) { s = String(s == null ? '' : s); return /^(https?:)?\/\//.test(s) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(s); };
    if (ks.length === 1) {
      var k0 = ks[0], v0 = rv[k0];
      if (isImg(v0)) { res.name = k0; res.image = String(v0); }                    // 形状 A
      else { res.name = (v0 != null && v0 !== '') ? String(v0) : k0; res.image = ''; }  // 形状 C（键=值名）
    } else {
      var name = rv[ks[0]] != null ? String(rv[ks[0]]) : '';                       // 形状 B（电商宝口径）
      var img = rv[ks[1]] != null ? String(rv[ks[1]]) : '';
      ks.forEach(function (k) {
        var vv = rv[k]; if (vv == null) return;
        if (!name && /name|value|text|label|规格|值/i.test(k)) name = String(vv);
        if (!img && /img|image|pic|photo|url|thumb/i.test(k)) img = String(vv);
      });
      if (!name) {
        for (var i = 0; i < ks.length; i++) { var v2 = rv[ks[i]]; if (v2 != null && v2 !== '' && !isImg(v2)) { name = String(v2); break; } }
      }
      res.name = name; res.image = img;
    }
    // 出口统一归一化：京东色卡图常是协议相对（//img14.360buyimg.com/…）→ 补 https
    if (res.image && res.image.indexOf('//') === 0) res.image = 'https:' + res.image;
  } catch (e) {}
  return res;
}

// v1.2.461【移植自电商宝 content/panel.js:390-412 domJdSku 收尾】把「规格维度」交叉成 skuBase：
//   前 2 维交叉、上限 100（京东规格项数量不定，防爆炸）；每行 propPath = 「维度名:值;维度名:值」；
//   任一维度值带 lack（无货/缺货/售罄）⇒ 该行 quantity=0；图片取该行各维度值里第一张可用色卡图。
//   真机实测：京东 item.jd.com 的规格数据只在 DOM（pageConfig.product 无 colorSize、接口响应里也没有），
//   所以这条是京东 SKU 的主通道。
function jdDimsToSkuBase(dims) {
  var out = { props: [], skus: [] };
  try {
    var ds = (dims || []).filter(function (d) { return d && d.name && (d.values || []).length; });
    if (!ds.length) return out;
    var props = ds.map(function (d) {
      return { pid: d.name, name: d.name, values: d.values.map(function (v) { return { vid: v.name, name: v.name, image: v.image || '' }; }) };
    });
    var names = ds.map(function (d) { return d.name; });
    var combos = [{ vals: [], imgs: [], lacks: [] }];
    ds.slice(0, 2).forEach(function (d) {
      var next = [];
      combos.forEach(function (c) {
        for (var k = 0; k < d.values.length && next.length < 100; k++) {
          next.push({ vals: c.vals.concat([d.values[k].name]), imgs: c.imgs.concat([d.values[k].image]), lacks: c.lacks.concat([!!d.values[k].lack]) });
        }
      });
      combos = next;
    });
    var skus = combos.map(function (c) {
      var img = '';
      c.imgs.forEach(function (u) { if (u) img = u; });
      return {
        skuId: '',
        propPath: names.slice(0, c.vals.length).map(function (pn, k) { return pn + ':' + c.vals[k]; }).join(';'),
        price: '', quantity: c.lacks.some(function (x) { return x; }) ? 0 : 1, image: img
      };
    }).filter(function (s) { return s.propPath; });
    out.props = props; out.skus = skus;
  } catch (e) {}
  return out;
}

// v1.2.463【用户要求：历史打包的导出内容要和整合包一样——详情图一个文件夹、SKU 一个文件夹】
//   老记录没有 imgSplit（v1.2.458 才开始存）→ 用「URL 归属」反推分类，保证导出目录与整合包一致：
//     ① 第 1 张恒为主图（历史记录里的 thumb）  ② 视频（扩展名/关键字）→ 视频/
//     ③ 出现在 skuRows 的「SKU图」列 → SKU图/   ④ 首个 SKU 图之前 → 主图/，其余 → 详情图/
function classifyHistoryImages(images, skuRows) {
  var skuSet = {};
  (skuRows || []).forEach(function (r) { var u = r && (r['SKU图'] || r['SKU图URL']); if (u) skuSet[String(u)] = 1; });
  var firstSkuAt = -1;
  (images || []).forEach(function (u, i) { if (i > 0 && firstSkuAt < 0 && skuSet[String(u)]) firstSkuAt = i; });
  return (images || []).map(function (u, i) {
    var s = String(u || '');
    if (i === 0) return 'main';
    if (/\.(mp4|m3u8|mov|webm)(\?|$)/i.test(s) || /video/i.test(s)) return 'video';
    if (skuSet[s]) return 'sku';
    if (firstSkuAt < 0) return i === 0 ? 'main' : 'desc';   // 完全没有 SKU 信息时：首张主图、其余详情图
    return i < firstSkuAt ? 'main' : 'desc';
  });
}

window.__AIS_IMG_PARSER__ = {
  nUrl: nUrl, findData: findData, parseSkuBase: parseSkuBase, buildSkuTable: buildSkuTable, parseItemProps: parseItemProps,
  jdPageConfigToSkuBase: jdPageConfigToSkuBase,
  jdDimsToSkuBase: jdDimsToSkuBase,
  classifyHistoryImages: classifyHistoryImages,
  collectImages: collectImages, parseDescImages: parseDescImages, parseDescImagesDeep: parseDescImagesDeep,
  parseReviews: parseReviews, parseReviewsFromSsr: parseReviewsFromSsr, normalizeRating: normalizeRating,
  extractMainImages: extractMainImages, extractDescUrl: extractDescUrl, extractVideo: extractVideo,
  findSkuBaseByShape: findSkuBaseByShape, FIELD_ALIASES: FIELD_ALIASES,
  fieldHits: function(){ try { return JSON.parse(JSON.stringify(__fieldHits)); } catch(e){ return {}; } }
};
})();
