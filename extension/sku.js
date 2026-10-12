'use strict';
(function (root) {
  // Selectors live only in platforms.js (DownloaderPlatforms.TAOBAO).
  const platforms = root.DownloaderPlatforms || (typeof require === 'function' ? require('./platforms.js') : null);
  function text(value) {
    return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  }
  function backgroundUrls(value) {
    const values = [];
    const pattern = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)/g;
    for (const match of String(value || '').matchAll(pattern)) {
      values.push((match[1] ?? match[2] ?? match[3]).trim().replace(/\\([\\"'() ])/g, '$1'));
    }
    return values;
  }
  // The option's dedicated name element: its title holds the full name even when
  // the visible text is truncated.
  function dedicatedLabel(option, selector) {
    const el = selector && option?.querySelector?.(selector);
    return el ? text(el.getAttribute?.('title') || el.textContent) : '';
  }
  function collect({ document, sourcesOf, normalizeUrl, isJunk, adapter = platforms.TAOBAO, mapVariantId = id => id,
    styleOf = element => root.getComputedStyle(element) }) {
    const items = new Map(), elements = new Set(), visited = new Set();
    const containers = new Set();
    const attributes = adapter.variantAttributes || ['data-value', 'data-sku-id'];
    for (const selector of adapter.sku || []) document.querySelectorAll(selector).forEach(el => containers.add(el));
    for (const container of containers) {
      const nodes = [container, ...container.querySelectorAll(adapter.skuNodes || 'img, [style]')];
      for (const node of nodes) {
        if (visited.has(node) || isJunk(node)) continue;
        visited.add(node);
        const isImage = node.tagName?.toLowerCase() === 'img';
        if (isImage && node.naturalWidth > 0 && node.naturalWidth < 24) continue;
        let background = '';
        if (!isImage) {
          try { background = styleOf(node)?.backgroundImage || ''; } catch (_) { /* Detached node. */ }
        }
        const sources = isImage ? sourcesOf(node) : backgroundUrls(background);
        const normalized = sources.map(source => normalizeUrl(source)).filter(Boolean);
        if (!normalized.length) continue;
        const url = normalized[0];
        if (/\.svg(?:[?#]|$)/i.test(url)) continue;
        let option = node.closest?.(adapter.options);
        if (option && option !== container && !container.contains(option)) option = null;
        const parent = node.parentElement;
        const nearby = [option, node, parent && container.contains(parent) ? parent : null].filter(Boolean);
        let label = dedicatedLabel(option, adapter.label);
        for (const el of nearby) {
          if (label) break;
          label = text(el.getAttribute?.('data-value-title') || el.getAttribute?.('title') || el.getAttribute?.('aria-label') || el.getAttribute?.('alt'));
          if (label) break;
        }
        // Never use a whole option-list's text as a single color/size label.
        if (!label && option && (option !== container || container.matches?.(adapter.optionRoots))) label = text(option.textContent);
        const rawId = text(attributes.map(name => option?.getAttribute?.(name)).find(Boolean) || '');
        const variantId = rawId ? text(mapVariantId(rawId)) : '';
        const fallbackUrls = [...new Set(sources.map(value => {
          try { return new URL(value, document.baseURI).href; } catch (_) { return null; }
        }).filter(value => value && /^https?:/.test(value) && value !== url))].slice(0, 3);
        elements.add(node);
        const item = items.get(url) || { url, type: 'sku', labels: [], variantIds: [], variants: [], fallbackUrls: [] };
        if (label && !item.labels.includes(label)) item.labels.push(label);
        if (variantId && !item.variantIds.includes(variantId)) item.variantIds.push(variantId);
        if ((variantId || label) && !item.variants.some(v => v.id === variantId && v.label === label)) item.variants.push({ id: variantId, label });
        item.fallbackUrls = [...new Set([...item.fallbackUrls, ...fallbackUrls])].slice(0, 3);
        items.set(url, item);
      }
    }
    return { items: [...items.values()], elements };
  }
  root.DownloaderSku = { backgroundUrls, collect };
  if (typeof module !== 'undefined') module.exports = root.DownloaderSku;
})(globalThis);
