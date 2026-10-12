'use strict';
(function (root) {
  const catalog = root.DownloaderI18nCatalog || (typeof require === 'function' ? require('./i18n-catalog.js') : null);
  const STORAGE_KEY = 'productDownloaderLanguageV1';
  const CHOICES = ['auto', 'zh_TW', 'zh_CN', 'en'];
  function resolve(value) {
    const tag = String(value || '').toLowerCase().replace(/_/g, '-');
    if (!/^zh(?:-|$)/.test(tag)) return 'en';
    if (tag.includes('-hant')) return 'zh_TW';
    if (tag.includes('-hans')) return 'zh_CN';
    return /-(tw|hk|mo)(?:-|$)/.test(tag) ? 'zh_TW' : 'zh_CN';
  }
  function systemLanguage() {
    return root.chrome?.i18n?.getUILanguage?.() || root.navigator?.language || 'zh-TW';
  }
  let locale = resolve(systemLanguage());
  const bindings = new WeakMap(), references = new Set(), listeners = new Set();
  const domLocale = () => ({zh_TW:'zh-TW',zh_CN:'zh-CN',en:'en'})[locale];
  function t(key, values = []) {
    const message = catalog.locales[locale]?.[key] ?? catalog.locales.en[key] ?? catalog.locales.zh_TW[key];
    if (typeof message !== 'string') return `[${key}]`;
    // Message-only syntax, resolved before values are inserted:
    //   {?1:text}        keep "text" only when value 1 is a non-zero number (zero counts are not said);
    //   [[0|item|items]] English singular/plural chosen by value 0.
    const number = index => Number(values[Number(index)]);
    const shaped = message
      .replace(/\{\?(\d+):((?:[^{}]|\{\d+\})*)\}/g, (_, index, text) => number(index) ? text : '')
      .replace(/\[\[(\d+)\|([^|\]]*)\|([^\]]*)\]\]/g, (_, index, one, many) => number(index) === 1 ? one : many);
    // A callback replacement keeps dollar signs and braces in user data literal.
    return shaped.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? `{${index}}`));
  }
  function bind(node, property, render) {
    if (!node || !['textContent','title','placeholder','aria-label'].includes(property)) return;
    let record = bindings.get(node);
    if (!record) { record = new Map(); bindings.set(node, record); references.add(new WeakRef(node)); }
    record.set(property, render);
    const value = render();
    if (property === 'aria-label') node.setAttribute(property, value); else node[property] = value;
    return value;
  }
  function clear(node, property) {
    bindings.get(node)?.delete(property);
    node[property] = '';
  }
  function append(node, property, render) {
    const previous = bindings.get(node)?.get(property) || (() => '');
    return bind(node, property, () => String(previous()) + String(render()));
  }
  function applyStatic(document = root.document) {
    if (!document) return;
    if (document.documentElement) document.documentElement.lang = domLocale();
    for (const node of document.querySelectorAll('[data-i18n], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label]')) {
      if (!node.getAttribute) continue;
      for (const [attribute, property] of [['data-i18n','textContent'],['data-i18n-title','title'],['data-i18n-placeholder','placeholder'],['data-i18n-aria-label','aria-label']]) {
        const key = node.getAttribute(attribute);
        // Dynamic state owns a field once it has rendered (e.g. download progress).
        if (key && !bindings.get(node)?.has(property)) bind(node, property, () => t(key));
      }
    }
  }
  function refresh() {
    if (root.document?.documentElement) root.document.documentElement.lang = domLocale();
    for (const ref of references) {
      const node = ref.deref();
      if (!node || node.isConnected === false) { references.delete(ref); if (node) bindings.delete(node); continue; }
      for (const [property, render] of bindings.get(node) || []) {
        if (property === 'aria-label') node.setAttribute(property, render()); else node[property] = render();
      }
    }
    for (const listener of listeners) listener();
  }
  function setLocale(value) { locale = resolve(value); refresh(); return locale; }
  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  // Existing workers store canonical internal messages. Translate only at explicit
  // message boundaries, never arbitrary page titles, SKU names, URLs or DOM text.
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const legacyEntries = catalog.legacyKeys.map(key => {
    const source = catalog.locales.zh_TW[key];
    const indexes = [...source.matchAll(/\{(\d+)\}/g)].map(m => Number(m[1]));
    if (!indexes.length) return {key,source,pattern:escape(source),indexes};
    // Worker placeholders contain counts only. Rich output descriptions are
    // rendered with their own keys in the UI, not parsed as arbitrary strings.
    if (['副本 {0}','尺寸上限 {0} px{1}'].includes(source)) return null;
    return {key,source,indexes,pattern:source.split(/\{\d+\}/).map(escape).join('([0-9]+)')};
  }).filter(Boolean).sort((a,b) => b.source.length-a.source.length);
  const legacyLiteral = new Map(legacyEntries.filter(e => !e.indexes.length).map(e => [e.source,e.key]));
  const legacyPatterns = legacyEntries.filter(e => e.indexes.length).map(e => ({...e, regex:new RegExp('^'+e.pattern)}));
  const legacyMatcher = new RegExp(legacyEntries.map(e => '(?:'+e.pattern+')').join('|'), 'g');
  // Chinese sentences sit next to each other without a space; English keeps one.
  const tidy = text => locale === 'en' ? text : text.replace(/([。！？；）」”])[ 　]+(?=\S)/g, '$1');
  function sentences(parts) { return parts.filter(Boolean).join(locale === 'en' ? ' ' : ''); }
  // Chrome and system errors arrive in English (e.g. "Could not establish connection…");
  // a customer never sees them raw: anything without Chinese becomes the given plain message.
  function plain(value, fallbackKey) {
    const text = String(value ?? '').trim();
    if (!text) return '';
    return /[㐀-鿿]/.test(text) ? legacy(text) : t(fallbackKey);
  }
  function legacy(value) {
    const text = String(value ?? '');
    if (locale === 'zh_TW') return tidy(text);
    return tidy(text.replace(legacyMatcher, match => {
      const literal = legacyLiteral.get(match); if (literal) return t(literal);
      for (const entry of legacyPatterns) {
        const parsed = entry.regex.exec(match);
        if (parsed?.[0] === match) { const values=[];entry.indexes.forEach((index,i)=>{values[index]=parsed[i+1];});return t(entry.key,values); }
      }
      return match;
    }));
  }
  function createController({storage, getSystemLanguage = systemLanguage, onChange = setLocale, timeoutMs = 3000} = {}) {
    let choice = 'auto', revision = 0, writes = Promise.resolve();
    const apply = () => onChange(choice === 'auto' ? getSystemLanguage() : choice);
    apply();
    const ready = (async () => {
      let timer;
      try {
        const data = await Promise.race([Promise.resolve().then(()=>storage.get(STORAGE_KEY)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('language read timeout')),timeoutMs);})]);
        if (!revision) { choice = CHOICES.includes(data?.[STORAGE_KEY]) ? data[STORAGE_KEY] : 'auto'; apply(); }
        return {ok:true};
      } catch (_) { return {ok:false}; }
      finally { clearTimeout(timer); }
    })();
    function choose(value) {
      if (!CHOICES.includes(value)) return Promise.resolve({ok:false,invalid:true});
      choice = value; const current = ++revision; apply();
      const task = writes.catch(()=>{}).then(()=>storage.set({[STORAGE_KEY]:value}));
      writes = task;
      return task.then(()=>({ok:true,current:current===revision}),()=>({ok:false,current:current===revision}));
    }
    return {ready,choose,get choice(){return choice;}};
  }
  const canonical = key => catalog.locales.zh_TW[key] || `[${key}]`;
  const api = {t,canonical,bind,clear,append,legacy,plain,sentences,applyStatic,refresh,setLocale,subscribe,resolve,systemLanguage,domLocale,createController,STORAGE_KEY,CHOICES,get locale(){return locale;}};
  root.DownloaderI18n = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
