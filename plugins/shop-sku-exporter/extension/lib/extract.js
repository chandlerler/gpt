/** Page-side extraction. Keep inspectPage self-contained: Chrome serializes it. */
export async function inspectPage(mode, fixture) {
  const doc = fixture ? null : document;
  const win = fixture ? {} : window;
  const ctx = fixture?.context || {};
  const url = ctx.url || (doc ? location.href : '');
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  const asId = value => /^\d{1,30}$/.test(String(value ?? '')) ? String(value) : '';
  const parseJSON = value => {
    if (typeof value !== 'string' || value.length > 4000000 || !/^[\s]*[\[{]/.test(value)) return value;
    try { return JSON.parse(value); } catch { return value; }
  };
  const safeURL = value => {
    if (value === undefined || value === null || !String(value).trim()) return null;
    try { const u = new URL(String(value), url); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; }
  };
  const itemURL = value => {
    const u = safeURL(value);
    if (!u || !/^(?:item\.taobao\.com|detail\.tmall\.com|detail\.tmall\.hk)$/.test(u.hostname)) return '';
    const id = asId(u.searchParams.get('id'));
    return id ? `https://${u.hostname}/item.htm?id=${id}` : '';
  };
  const pageURL = safeURL(url);
  const itemId = asId(ctx.itemId || pageURL?.searchParams.get('id'));
  const text = doc ? clean(doc.body?.innerText).slice(0, 50000) : clean(ctx.text);
  const titleText = doc ? clean(doc.title) : clean(ctx.title);
  const checkBlock = () => {
    if (/\b(login|passport)\.(taobao|tmall)\.com\b/.test(pageURL?.hostname || '')) return '请在采集标签页登录淘宝/天猫，然后继续';
    if (doc && [...doc.querySelectorAll('#nc_1_wrapper, #baxia-dialog-content, iframe[src*="baxia"], #nocaptcha')].some(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')) return '页面出现验证，请在采集标签页手动完成后继续';
    if (/滑动验证|拖动滑块|请完成安全验证|访问过于频繁|亲，小二正忙|哎哟喂,被挤爆啦/.test(text)) return '页面出现访问限制或验证，请人工处理后继续';
    if (/登录后查看|请登录后继续访问|登录后即可查看商品/.test(text)) return '需要登录后才能读取商品数据';
    return '';
  };
  const blocked = checkBlock();
  const roots = [];
  if (fixture) roots.push(...(fixture.payloads || []));
  else {
    for (const name of ['__INIT_DATA__', '__INITIAL_STATE__', '__NEXT_DATA__', '__data', '__GLOBAL_DATA__', 'g_config', 'TShop', 'Hub', 'iDetailData', '_DATA_Detail', '__ICE_APP_CONTEXT__']) {
      try { const value = win[name]; if (value && typeof value === 'object') roots.push(value); } catch {}
    }
    for (const script of doc.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__')) {
      const value = parseJSON(script.textContent || '');
      if (plain(value)) roots.push(value);
    }
    // Parse JSON object assignments only. Never execute embedded page scripts.
    for (const script of doc.querySelectorAll('script:not([src])')) {
      const source = script.textContent || '';
      if (source.length > 4000000 || !/skuBase|skuCore|valItemInfo/.test(source)) continue;
      const assignment = source.match(/(?:__INIT_DATA__|__INITIAL_STATE__|g_config|_DATA_Detail)\s*=\s*([\s\S]*?);?\s*$/);
      if (assignment) { const value = parseJSON(assignment[1].replace(/;\s*$/, '')); if (plain(value)) roots.push(value); }
    }
    // Initial globals/scripts can retain old prices after a SKU response arrives.
    // Apply observed responses last, in capture order (timestamp ties stay stable).
    const capture = win.__SHOP_SKU_CAPTURE__;
    if (Array.isArray(capture)) roots.push(...capture.slice(-80).map((entry, index) => ({entry, index})).sort((a, b) => {
      const at = Number(a.entry?.capturedAt), bt = Number(b.entry?.capturedAt);
      return (Number.isFinite(at) ? at : 0) - (Number.isFinite(bt) ? bt : 0) || a.index - b.index;
    }).map(value => value.entry));
  }
  const nodes = [];
  const seen = new WeakSet();
  const walk = (raw, inheritedId = '', depth = 0) => {
    const value = parseJSON(raw);
    if (!value || typeof value !== 'object' || depth > 16 || nodes.length > 12000 || seen.has(value)) return;
    seen.add(value);
    const ownId = asId(value.item?.itemId || value.item?.id || value.itemDO?.itemId || value.itemInfo?.itemId || value.itemId || value.numIid);
    const currentId = ownId || inheritedId;
    if (mode === 'detail' && itemId && currentId && itemId !== currentId) return;
    nodes.push({value, itemId: currentId});
    const entries = Array.isArray(value) ? value.slice(0, 2000).map((v, i) => [String(i), v]) : Object.entries(value).slice(0, 5000);
    for (const [key, child] of entries) {
      if (/recommend|related|guess|crossShop|otherItems|hotItems|ranking|reviews|rateInfo/i.test(key)) continue;
      if (mode === 'detail' && /^(?:itemList|itemsList|auctionList|auctions|shopItems|searchResult|searchResults)$/i.test(key)) continue;
      if (child && typeof child === 'object' || typeof child === 'string' && /^(?:value|data|apiStack|skuBase|skuCore)$/.test(key)) walk(child, currentId, depth + 1);
    }
  };
  for (const root of roots.slice(-80)) walk(root);
  // Prefer contexts explicitly bound to this item. An unbound recommendation or stale
  // global must never override a matched detail response's SKU prices.
  const hasBoundSkuData = mode === 'detail' && itemId && nodes.some(n => n.itemId === itemId && (n.value.skuBase || n.value.skuCore || n.value.sku2info || n.value.valItemInfo || n.value.skuMap));
  const candidates = (hasBoundSkuData ? nodes.filter(n => n.itemId === itemId) : nodes).map(n => n.value);
  const find = fn => candidates.map(fn).find(v => v !== undefined && v !== null && v !== '');
  const seller = find(v => plain(v.seller) ? v.seller : plain(v.sellerInfo) ? v.sellerInfo : undefined) || {};
  const shop = find(v => plain(v.shop) ? v.shop : plain(v.shopInfo) ? v.shopInfo : undefined) || {};
  const shopId = asId(seller.shopId || shop.shopId || ctx.shopId || find(v => v.shopId));
  const sellerId = asId(seller.userId || seller.sellerId || seller.sellerUid || shop.sellerId || ctx.sellerId || find(v => v.sellerId || v.sellerUid));
  const shopName = clean(seller.shopName || shop.shopName || shop.title || ctx.shopName || (doc && doc.querySelector('[class*="ShopHeader"] [class*="name"], [class*="shopName"], .shop-name, .tb-shop-name a')?.textContent));

  if (mode === 'shop') {
    if (doc) doc.querySelectorAll('[data-shop-sku-next]').forEach(el => el.removeAttribute('data-shop-sku-next'));
    const itemLinks = new Set();
    const recommendation = el => !!el.closest('[class*="recommend" i], [class*="related" i], [class*="guess" i], [id*="recommend" i], [data-module*="recommend" i]');
    const listingSelectors = ['.J_TItems', '.shop-hesper-bd', '.item-list', '.item4line1', '.item3line1', '.item5line1', '.shop-search-result', '.search-result', '[class*="itemList"]', '[class*="ItemList"]', '[class*="item-list"]', '[class*="searchResult"]', '[class*="SearchResult"]', '[class*="itemCard"]', '[class*="ItemCard"]', '[class*="item-card"]', '[data-module="items"]', '[data-widget-type*="items"]', '.item .detail'];
    const listingNodes = doc ? [...doc.querySelectorAll(listingSelectors.join(','))].filter(el => !recommendation(el)) : [];
    const scannedNodes = new Set();
    let usedFallback = false;
    if (doc) {
      const productAttributes = 'a[href], [data-href], [data-item-url], [data-item-id], [data-auction-id]';
      const readNode = (node, scoped) => {
        if (scannedNodes.has(node) || recommendation(node)) return;
        scannedNodes.add(node);
        const owner = node.closest('[data-shop-id], [data-seller-id]');
        if (owner && (shopId && owner.dataset.shopId && owner.dataset.shopId !== shopId || sellerId && owner.dataset.sellerId && owner.dataset.sellerId !== sellerId)) return;
        const attrs = scoped ? ['href', 'data-href', 'data-item-url'] : ['href'];
        for (const attr of attrs) {
          const canonical = itemURL(node.getAttribute(attr));
          if (canonical) { itemLinks.add(canonical); return; }
        }
        // IDs without a destination are meaningful only inside an explicit shop
        // listing/card; never mine arbitrary data IDs from the whole document.
        if (scoped) {
          const id = node.getAttribute('data-item-id') || node.getAttribute('data-auction-id');
          if (/^\d{5,30}$/.test(id || '')) itemLinks.add(`https://${pageURL?.hostname.endsWith('tmall.com') ? 'detail.tmall.com' : 'item.taobao.com'}/item.htm?id=${id}`);
        }
      };
      for (const scope of listingNodes) {
        // The card can itself be the anchor. querySelectorAll only sees children.
        if (scope.matches(productAttributes)) readNode(scope, true);
        for (const node of scope.querySelectorAll(productAttributes)) readNode(node, true);
      }
      if (!itemLinks.size) {
        // Empty placeholders must not suppress links in a differently named list.
        // This fallback stays explicitly unverified and only accepts real URLs.
        usedFallback = true;
        for (const node of doc.querySelectorAll('a[href]')) readNode(node, false);
      }
    }
    // Read item arrays only from explicitly named shop-list containers, never all itemIds on a page.
    for (const value of candidates) {
      for (const key of ['itemList', 'itemsList', 'auctionList', 'auctions', 'shopItems']) {
        if (!Array.isArray(value[key])) continue;
        for (const entry of value[key].slice(0, 2000)) {
          if (!plain(entry)) continue;
          const id = asId(entry.itemId || entry.nid || entry.auctionId);
          if (entry.shopId && shopId && String(entry.shopId) !== shopId) continue;
          const canonical = itemURL(entry.itemUrl || entry.auctionUrl || entry.url || entry.href || '');
          if (canonical) itemLinks.add(canonical);
          else if (id) itemLinks.add(`https://${pageURL?.hostname.endsWith('tmall.com') ? 'detail.tmall.com' : 'item.taobao.com'}/item.htm?id=${id}`);
        }
      }
    }
    let nextUrl = '', nextSelector = '', catalogUrl = '', hasMore = null;
    const sameShopURL = value => {
      if (!value || /^\s*#/.test(value)) return '';
      const next = safeURL(value);
      if (!next || !pageURL || next.hostname !== pageURL.hostname || next.href === pageURL.href || /\b(?:login|detail|item)\./.test(next.hostname)) return '';
      for (const key of ['shop_id', 'shopId', 'user_number_id', 'sellerId']) {
        if (pageURL.searchParams.has(key) && next.searchParams.get(key) !== pageURL.searchParams.get(key)) return '';
      }
      // Legacy shop IDs can be embedded in the URL path.
      const pathId = pageURL.pathname.match(/\/shop\/view_shop\.htm/);
      if (pathId && next.pathname !== pageURL.pathname) return '';
      return next.href;
    };
    if (doc) {
      for (const anchor of doc.querySelectorAll('a[href]')) {
        if (recommendation(anchor) || !/^(?:所有宝贝|全部宝贝|全部商品|所有商品|查看所有宝贝|查看全部商品)$/.test(clean(anchor.textContent).replace(/\s/g, ''))) continue;
        const candidate = sameShopURL(anchor.getAttribute('href'));
        const parsed = safeURL(candidate);
        if (parsed?.protocol === 'https:' && !/login|logout|trade|cart|buy\.htm/i.test(parsed.pathname) && !itemURL(candidate)) { catalogUrl = candidate; break; }
      }
      const possible = [...doc.querySelectorAll('a[rel="next"], .pagination .next, .pagination-next, .next-pagination-item.next-next, .next-pagination-item.next-pagination-next, .ui-page-next, .J_SearchAsync.next, [class*="pagination"] a, [class*="pagination"] button, [class*="Pagination"] button, [class*="Pagination"] a, .page a, .page button')];
      for (const control of possible) {
        const label = clean(control.textContent || control.getAttribute('aria-label') || control.title);
        const isNext = control.getAttribute('rel') === 'next' || /下一页|下页|^next$|^›$|^»$|^>$|向后翻页/i.test(label) || /(?:^|\s)(?:next|ui-page-next|pagination-next|next-next)(?:\s|$)/.test(control.className || '');
        if (!isNext) continue;
        const disabled = control.matches('[disabled], [aria-disabled="true"]') || /disabled|disable\b/.test(control.className || '') || control.closest('[aria-disabled="true"]');
        if (disabled) { if (hasMore === null) hasMore = false; continue; }
        hasMore = true;
        nextUrl = sameShopURL(control.getAttribute('href'));
        if (!nextUrl) {
          // An inert marker makes the click target deterministic without exposing a broad selector.
          control.setAttribute('data-shop-sku-next', 'true');
          nextSelector = '[data-shop-sku-next="true"]';
        }
        break;
      }
    }
    const expectedText = text.match(/(?:共|全部商品)[^\d]{0,5}([\d,]+)\s*(?:件|个|款|宝贝|商品)/);
    const expectedCandidate = Number((expectedText?.[1] || '').replace(/,/g, ''));
    const expectedTotal = Number.isSafeInteger(expectedCandidate) && expectedCandidate > 0 ? expectedCandidate : null;
    const warning = usedFallback ? '标准商品列表未找到有效链接，已扫描当前页链接；需核对店铺归属及商品覆盖范围' : !itemLinks.size ? '当前页面未发现商品，请打开店铺“所有宝贝”页面并完成加载' : '';
    const diagnostics = {anchors: doc ? doc.querySelectorAll('a[href]').length : 0, listingContainers: listingNodes.length, scannedNodes: scannedNodes.size, recognizedLinks: itemLinks.size, readiness: doc?.readyState || 'unknown', visibility: doc?.visibilityState || 'unknown'};
    return {kind: 'shop', url, shopName, shopId, sellerId, itemLinks: [...itemLinks], nextUrl, nextSelector, catalogUrl, hasMore, expectedTotal, blocked, warning, diagnostics};
  }

  const toMoney = value => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
    if (typeof value !== 'string') return null;
    let str = value.trim().replace(/[￥¥元\s,]/g, '');
    if (!/^\d+(?:\.\d{1,4})?$/.test(str)) return null;
    const number = Number(str);
    return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
  };
  const amount = value => {
    if (plain(value)) return toMoney(value.priceText ?? value.price ?? value.value ?? value.amount);
    return toMoney(value);
  };
  const count = value => {
    const n = typeof value === 'number' ? value : /^\d+$/.test(String(value ?? '')) ? Number(value) : NaN;
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  };
  const bases = candidates.filter(v => plain(v.skuBase)).map(v => v.skuBase);
  // Some scripts expose the SKU object itself as the root.
  for (const value of candidates) if (Array.isArray(value.props) && Array.isArray(value.skus) && !bases.includes(value)) bases.push(value);
  const infoMap = {};
  const mergeInfo = (previous, incoming) => {
    const merged = {...previous};
    // A new price observation supersedes previous price/discount observations.
    // In particular, an absent new coupon price must not leave a stale coupon price.
    if (Object.keys(incoming).some(key => /price/i.test(key))) {
      for (const key of Object.keys(merged)) if (/price|promotion|coupon/i.test(key)) delete merged[key];
    }
    return {...merged, ...incoming};
  };
  for (const v of candidates) {
    const legacy = v.valItemInfo || v;
    if (plain(legacy.skuMap)) for (const value of Object.values(legacy.skuMap)) {
      if (!plain(value)) continue;
      const id = asId(value.skuId || value.id);
      if (id && id !== '0') infoMap[id] = mergeInfo(infoMap[id], value);
    }
    const info = v.skuCore?.sku2info || (plain(v.sku2info) ? v.sku2info : null);
    if (plain(info)) for (const [key, value] of Object.entries(info)) if (plain(value)) infoMap[String(key)] = mergeInfo(infoMap[String(key)], value);
  }
  const propMap = new Map();
  for (const base of bases) for (const prop of base.props || []) {
    const pid = String(prop.pid ?? prop.id ?? '');
    for (const value of prop.values || []) propMap.set(`${pid}:${String(value.vid ?? value.id ?? '')}`, {name: clean(prop.name || prop.text), value: clean(value.name || value.text), image: value.image || value.imageUrl || ''});
  }
  const skuMap = new Map();
  const describedSkuIds = new Set();
  for (const base of bases) for (const sku of base.skus || []) {
    const id = asId(sku.skuId || sku.id);
    if (id && id !== '0') { skuMap.set(id, {...skuMap.get(id), ...sku, skuId: id}); describedSkuIds.add(id); }
  }
  for (const value of candidates) {
    const legacy = value.valItemInfo || value;
    if (Array.isArray(legacy.skuList)) for (const sku of legacy.skuList) {
      const id = asId(sku.skuId || sku.id);
      if (id && id !== '0') { skuMap.set(id, {...skuMap.get(id), ...sku, propPath: sku.propPath || sku.pvs, skuId: id}); describedSkuIds.add(id); }
    }
    if (plain(legacy.skuMap)) for (const [path, sku] of Object.entries(legacy.skuMap)) {
      if (!plain(sku)) continue;
      const id = asId(sku.skuId || sku.id);
      if (id && id !== '0') {
        describedSkuIds.add(id);
        skuMap.set(id, {...skuMap.get(id), ...sku, propPath: sku.propPath || path, skuId: id});
      }
    }
  }
  // A price map may arrive before SKU labels. Preserve SKU IDs and flag missing specifications.
  for (const id of Object.keys(infoMap)) if (id !== '0' && asId(id) && !skuMap.has(id)) skuMap.set(id, {skuId: id});
  const item = find(v => plain(v.item) ? v.item : plain(v.itemDO) ? v.itemDO : plain(v.itemInfo) ? v.itemInfo : undefined) || {};
  const title = clean(item.title || item.itemName || item.name || ctx.title || (doc && doc.querySelector('h1, [class*="ItemTitle"], .tb-main-title')?.textContent) || titleText.replace(/[-_\s]+(?:淘宝网|天猫|Tmall).*$/, ''));
  const resolvedItemId = asId(item.itemId || item.id || item.numIid) || itemId;
  const warnings = [];
  const mainImage = item.images?.[0] || item.picUrl || item.image || '';
  const imageURL = value => { const u = safeURL(value); return u ? u.href : ''; };
  const stringifyLabels = value => {
    if (typeof value === 'string') return clean(value);
    if (Array.isArray(value)) return value.map(stringifyLabels).filter(Boolean).join('；');
    if (plain(value)) return clean(value.title || value.text || value.desc || value.description || value.content || '');
    return '';
  };
  const buildRow = (sku, single = false) => {
    const id = sku.skuId;
    const info = infoMap[id] || {};
    const path = String(sku.propPath || sku.pvs || '').split(';').filter(Boolean);
    const properties = {};
    let image = '';
    for (const part of path) {
      const prop = propMap.get(part);
      if (prop) { properties[prop.name || part.split(':')[0]] = prop.value; if (!image && prop.image) image = prop.image; }
      else properties[part.split(':')[0]] = part.split(':').slice(1).join(':');
    }
    let specs = Object.entries(properties).map(([key, value]) => `${key}: ${value}`).join(' / ');
    if (sku.names || sku.name || sku.skuName) specs = clean(sku.names || sku.skuName || sku.name) || specs;
    if (!specs) specs = single ? '默认规格（页面未列出多规格）' : '规格未解析';
    let price = null, priceSource = '';
    for (const [field, value] of [['price', info.price], ['salePrice', info.salePrice], ['promotionPrice', info.promotionPrice], ['sku.price', sku.price]]) {
      const parsed = amount(value);
      if (parsed !== null) { price = parsed; priceSource = `SKU 数据 · ${field}`; break; }
    }
    let finalPrice = null;
    let finalLabel = '';
    let promotion = [info.promotionDescription, info.promotionDesc, info.couponDescription, info.priceDesc, info.promotion, info.promotions, info.price?.priceDesc].map(stringifyLabels).filter(Boolean).join('；');
    // Only SKU-keyed values with an explicit price label qualify. Aggregate item minima are excluded.
    for (const [field, value] of Object.entries(info)) {
      if (!plain(value) || !/price/i.test(field)) continue;
      const label = clean([value.priceTitle, value.title, value.label, value.priceTypeText].filter(Boolean).join(' '));
      if (!/(?:到手价|券后价|优惠后价)/.test(label)) continue;
      const parsed = amount(value);
      if (parsed === null) continue;
      finalPrice = parsed; finalLabel = label;
      priceSource += `${priceSource ? '；' : ''}SKU 数据 · ${field}（${label}）`;
      promotion = [promotion, value.priceDesc, value.desc, value.condition, value.promotionDesc].map(stringifyLabels).filter(Boolean).join('；');
      break;
    }
    let originalPrice = amount(info.originalPrice ?? info.originPrice ?? info.marketPrice ?? info.price?.originalPrice);
    const stock = count(info.quantity ?? info.stock ?? sku.stock ?? sku.quantity);
    const availability = stock === 0 || info.isSoldOut === true || info.soldOut === true ? '无库存' : stock !== null && stock > 0 ? '有库存' : '未知';
    let priceStatus = finalPrice !== null ? `页面 ${finalLabel}（未核验结算）` : price !== null ? '仅 SKU 展示价，到手价未确认' : '未获取 SKU 价格';
    if (!single && specs === '规格未解析') priceStatus += '；规格未解析';
    if (single) priceSource = priceSource.replace(/SKU 数据/g, '默认规格数据');
    return {skuId: single ? '' : id, specs, properties, price, finalPrice, originalPrice, stock, availability, priceSource, promotion, priceStatus, imageUrl: imageURL(image || sku.image || sku.imageUrl || mainImage)};
  };
  const rows = [...skuMap.values()].map(sku => buildRow(sku));
  if (!rows.length && bases.some(base => Array.isArray(base.skus) && base.skus.length === 0) && infoMap['0']) {
    rows.push(buildRow({skuId: '0'}, true));
    warnings.push('页面未列出多规格，已记录默认规格；建议人工核对');
  }
  if (!rows.length) {
    warnings.push('未获取完整 SKU 数据；请确认已登录、页面加载完成，或重新采集');
    // DOM fallbacks are observations of one selected SKU, never a full SKU enumeration.
    const selected = doc?.querySelector('[data-sku-id][aria-selected="true"], [data-sku-id].selected, [data-sku-id][data-selected="true"]');
    const selectedId = asId(selected?.getAttribute('data-sku-id') || pageURL?.searchParams.get('skuId'));
    const selectedSpecs = selected ? clean(selected.textContent) : '';
    const priceEl = doc?.querySelector('[class*="Price--priceText"], [class*="Price--price--"], .tb-rmb-num, .tm-price');
    const price = toMoney(priceEl?.textContent);
    rows.push({skuId: selectedId, specs: selectedSpecs || 'SKU 明细未获取', properties: {}, price: selectedId ? price : null, finalPrice: null, originalPrice: null, stock: null, availability: '未知', priceSource: selectedId && price !== null ? '当前页面所选规格展示价（DOM）' : '', promotion: '', priceStatus: '未完成 SKU 枚举；到手价未确认', imageUrl: imageURL(mainImage)});
  }
  if (rows.some(row => row.finalPrice === null)) warnings.push('部分或全部 SKU 未提供明确到手价；空值不代表免费，未将商品最低价套用到 SKU');
  if (rows.some(row => row.specs === '规格未解析' || /^\d+:/.test(row.specs))) warnings.push('部分规格只有属性 ID，需人工核对');
  return {kind: 'detail', itemId: resolvedItemId, title, shopName, shopId, sellerId, url, rows, blocked, warnings, skuComplete: skuMap.size > 0 && describedSkuIds.size === skuMap.size || rows.length === 1 && rows[0].specs.startsWith('默认规格')};
}

/** Pure fixture entry point, also useful to test parser changes without a browser. */
export async function parseDetail(payloads, context = {}) {
  return inspectPage('detail', {payloads, context});
}
