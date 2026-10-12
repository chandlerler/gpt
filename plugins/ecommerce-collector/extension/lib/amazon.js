// ============================================================
// 亚马逊支持（ASIN / 多站点 / 官方图片载荷读取）
// 移植自同作者项目 hires-extension（v0.23.x）的 src/lib/asin.js + src/lib/amazonPayload.js，
// 逻辑原样保留：amazonPayload 那一份本身又是从竞品「电小商 v1.2.5」逆向移植的成熟实现。
// 为什么读载荷而不是扒 <img>：实测 amazon.com/dp/B01GJOMWVA 的 DOM 只给 8 张（6 张是缩略图），
// 而 ImageBlockATF 里直接写着 14 张 hiRes 原图地址 —— 后缀改写永远拿不到那一批。
// ============================================================
(function () {
'use strict';
/**
 * Amazon URL parsing — ASIN, marketplace, page type.
 *
 * Hardened against the shapes real Amazon URLs take:
 *   /dp/B08N5WRWNW            /gp/product/B08N5WRWNW        /product/B08N5WRWNW
 *   /Some-Title/dp/B08N5WRWNW /dp/B08N5WRWNW/ref=...        ?asin=B08N5WRWNW
 *   /gp/aw/d/B08N5WRWNW       /gp/offer-listing/B08N5WRWNW  /dp/B08N5WRWNW?th=1&psc=1
 *
 * Deliberately does NOT trust `location.pathname` alone: Amazon rewrites history
 * constantly, so the caller re-parses on every navigation settle.
 */

/** Marketplace suffixes we support. Order matters: longer suffixes first. */
const MARKETPLACES = [
  "amazon.com.au", "amazon.com.br", "amazon.com.mx", "amazon.com.tr", "amazon.com.be",
  "amazon.co.uk", "amazon.co.jp", "amazon.com.sg", "amazon.com.sa", "amazon.com.eg",
  "amazon.com", "amazon.ca", "amazon.de", "amazon.fr", "amazon.it", "amazon.es",
  "amazon.nl", "amazon.se", "amazon.pl", "amazon.in", "amazon.ae", "amazon.sa",
  "amazon.sg", "amazon.cn", "amazon.jp", "amazon.mx", "amazon.br", "amazon.tr",
  "amazon.eu", "amazon.ie", "amazon.at", "amazon.ch", "amazon.dk", "amazon.no",
  "amazon.fi", "amazon.cz", "amazon.gr", "amazon.hu", "amazon.ro", "amazon.sk",
  "amazon.bg", "amazon.hr", "amazon.lt", "amazon.lv", "amazon.ee", "amazon.si",
  "amazon.pt", "amazon.cl", "amazon.co", "amazon.pe", "amazon.ar", "amazon.com.co",
  "amazon.com.ar", "amazon.com.pe", "amazon.co.za", "amazon.eg", "amazon.ma",
  "amazon.com.ng", "amazon.co.il"
];

const ASIN_RE = /^[A-Z0-9]{10}$/;

/** Page shapes we can do different amounts of work on. */
const PAGE_TYPE = {
  PRODUCT: "product",
  SEARCH: "search",
  STORE: "store",
  VINE: "vine",
  UNKNOWN: "unknown"
};

function hostMatchesAmazon(host) {
  return /(^|\.)amazon\.[a-z.]{2,}$/i.test(host) || /(^|\.)amzn\.com$/i.test(host);
}

/** Longest-suffix marketplace match, so `amazon.com.au` beats `amazon.com`. */
function marketplaceOf(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^www\./, "");
  for (const m of MARKETPLACES) if (h === m || h.endsWith("." + m)) return m;
  return null;
}

/** First ASIN-looking token in the path, in priority order. */
function asinFromUrl(href) {
  let url;
  try { url = new URL(href); } catch { return null; }

  const path = url.pathname;

  // order matters — most specific patterns first
  const patterns = [
    /\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing|product|ASIN)\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/([A-Z0-9]{10})(?:[/?]|$)/,
  ];
  for (const re of patterns) {
    const m = path.match(re);
    if (m && ASIN_RE.test(m[1].toUpperCase())) return m[1].toUpperCase();
  }

  // query fallbacks Amazon still uses on some marketplaces
  for (const key of ["asin", "ASIN", "asins", "asinList"]) {
    const v = url.searchParams.get(key);
    if (v) {
      const first = v.split(/[,\s]/)[0];
      if (ASIN_RE.test(first.toUpperCase())) return first.toUpperCase();
    }
  }
  return null;
}

/** All ASINs we can see in a URL (search result pages can carry several). */
function asinsFromUrl(href) {
  const out = new Set();
  const single = asinFromUrl(href);
  if (single) out.add(single);
  try {
    const u = new URL(href);
    for (const v of u.searchParams.getAll("asins")) {
      for (const t of String(v).split(/[,\s]/)) if (ASIN_RE.test(t.toUpperCase())) out.add(t.toUpperCase());
    }
  } catch { /* ignore */ }
  return [...out];
}
function pageTypeOf(href) {
  let u;
  try { u = new URL(href); } catch { return PAGE_TYPE.UNKNOWN; }
  const p = u.pathname.toLowerCase();

  if (p.includes("/vine/")) return PAGE_TYPE.VINE;
  if (asinFromUrl(href)) return PAGE_TYPE.PRODUCT;
  // exact segment match: a naive p.includes("/s") also matches "/stores" and "/seller"
  if (/^\/s(\/|$)/.test(p) || p.includes("/gp/search") || p.includes("/s/ref=") || u.searchParams.has("k")) {
    return PAGE_TYPE.SEARCH;
  }
  if (p.includes("/stores/") || p.includes("/stores") || p.includes("/shops/") ||
      p.includes("/seller/") || p.startsWith("/sp") || p.includes("/sp/")) {
    return PAGE_TYPE.STORE;
  }
  return PAGE_TYPE.UNKNOWN;
}

/** Everything the collector needs about the current location, in one call. */
function describeLocation(href) {
  let url;
  try { url = new URL(href); } catch { return { ok: false }; }
  const marketplace = marketplaceOf(url.hostname);
  if (!marketplace) return { ok: false, reason: "not-amazon" };
  // 2026-09-13 真机回归补的：**亚马逊记录里原来没有 `platform` 字段**（只有 marketplace），
  // 于是 collector / 诊断页 / 面板五处都得写 `product.platform || "amazon"` 兜底，
  // 而外国平台的记录两个字段都有 —— 契约不一致，任何新消费者都会先踩一次。
  return {
    ok: true,
    platform: "amazon",
    marketplace,
    hostname: url.hostname,
    asin: asinFromUrl(href),
    asins: asinsFromUrl(href),
    pageType: pageTypeOf(href),
    locale: (url.pathname.match(/^\/([a-z]{2}(?:-[A-Z]{2})?)\//) || [])[1] || null
  };
}

/**
 * Amazon's own image payloads, read straight out of the page.
 *
 * PORTED FROM a decompiled competitor — 电小商 v1.2.5
 * (id klhdgbflmlpbhjcmfheahojajjpjekge), which is the only one of the tools we
 * took apart that reads these blocks at all. Its exact behaviour is reproduced
 * here, including all four \`A.$.parseJSON\` regex variants and the whole
 * return-value chain in its \`Ko()\` helper.
 *
 * WHY THIS BEATS SCRAPING <img>
 * Measured on amazon.com/dp/B01GJOMWVA: the DOM yielded 8 product images, of
 * which 6 were thumbnails we merely *hoped* to upgrade by rewriting the suffix.
 * The same page's ImageBlockATF block carried 14 images whose \`hiRes\` URLs are
 * named directly. And \`hiRes\` is a different asset from \`thumb\`/\`large\` —
 * 41QB48wA6UL plays the thumbnail while 61Rdl5C2AHL is the 1500px original — so
 * suffix rewriting can never reach it. The page simply tells us.
 *
 * TWO BLOCKS THAT LOOK ALIKE AND MEAN DIFFERENT THINGS
 *   <script> ... ImageBlockATF ...  'colorImages': {'initial': A.$.parseJSON('[...]')}
 *       -> the CURRENT (landing) variant's full gallery [{hiRes, large, thumb, variant}]
 *   <script> ... var obj = jQuery.parseJSON('{...}')            (ImageBlockBTF)
 *       -> { colorToAsin, colorImages, parentAsin, landingAsinColor, videos, ... }
 *          colorToAsin  : every variant's FULL label -> child ASIN
 *          colorImages  : every variant -> [ its main image ]  (hiRes)
 *
 * Everything in this module is pure string handling. Zero network requests.
 */

/**
 * Read one JS string literal starting at (or just after) `from`.
 *
 * The source product captured payloads with \`[^']*\`, which silently fails on any
 * payload containing an apostrophe — and real ones do: an \`altText\` on the very
 * first page we tested reads \u201c...Red banner below reads \\'Sneak-a-Cup Feature.\\'\u201d.
 * That is 11 apostrophes in the gallery array alone, so their reader returns
 * nothing at all for this product. We walk the literal instead, honouring
 * backslash escapes, so the terminator is found by syntax rather than by guess.
 */
function readStringLiteral(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  const quote = text[i];
  if (quote !== "'" && quote !== '"') return null;
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") { j += 2; continue; }
    if (c === quote) break;
    j++;
  }
  if (j >= text.length) return null;
  return { raw: text.slice(i + 1, j), end: j + 1 };
}

/** Undo JS string escaping, then JSON.parse. Handles \\' and \\" alike — the pair
    the source product's \`replace(/\\\\"/g,'"')\` step misses. */
function decodeJsLiteral(raw) {
  const unescaped = String(raw).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (m, c) => {
    if (c[0] === "u") return String.fromCharCode(parseInt(c.slice(1), 16));
    if (c[0] === "x") return String.fromCharCode(parseInt(c.slice(1), 16));
    const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };
    return Object.prototype.hasOwnProperty.call(simple, c) ? simple[c] : c;
  });
  try { return JSON.parse(unescaped); } catch { return null; }
}

/**
 * Their Ko() return-value chain, kept intact: the payload may be the array
 * itself, an object with an `initial` array, an object whose SOME key holds an
 * array of {hiRes}, or a single {hiRes} object. Amazon has shipped all four.
 */
function normalizeKo(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (value.initial && Array.isArray(value.initial)) return value.initial;
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (Array.isArray(v) && v[0] && v[0].hiRes) return v;
  }
  if (value.hiRes) return [value];
  return [];
}

const hasHiRes = (arr) => Array.isArray(arr) && arr.some((x) => x && x.hiRes);

/**
 * Pull the landing variant's gallery out of raw HTML.
 *
 * Walks every \`A.$.parseJSON(\` call and keeps the first one whose array carries
 * \`hiRes\`. Walking rather than pattern-matching is deliberate: the same page
 * wraps a VIDEO array in an identical call, and both the key and the payload can
 * be quoted either way. Only the content tells them apart.
 */
function readAtfFromHtml(html) {
  if (!html) return [];
  const re = /A\.\$\.parseJSON\s*\(\s*/g;
  let m;
  while ((m = re.exec(html))) {
    const lit = readStringLiteral(html, re.lastIndex);
    if (!lit) continue;
    const arr = normalizeKo(decodeJsLiteral(lit.raw));
    if (hasHiRes(arr)) return arr;
    re.lastIndex = lit.end;
  }
  return [];
}

/** Same, but walking <script> nodes — avoids serialising the whole document. */
function readAtfFromRoot(root) {
  return readAtfFromHtml(scriptTexts(root).join("\n"));
}

function scriptTexts(root) {
  const out = [];
  try {
    for (const s of root.querySelectorAll("script")) {
      const t = s.textContent || "";
      if (t.includes("A.$.parseJSON") || t.includes("ImageBlockATF")) out.push(t);
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * The ImageBlockBTF object \u2014 \`var obj = jQuery.parseJSON('{...}')\`.
 * Read with the same literal walker, so an apostrophe in a title cannot truncate it.
 */
function readBtfFromHtml(html) {
  if (!html) return null;
  const re = /jQuery\.parseJSON\s*\(\s*/g;
  let m;
  while ((m = re.exec(html))) {
    const lit = readStringLiteral(html, re.lastIndex);
    if (!lit) continue;
    const obj = decodeJsLiteral(lit.raw);
    if (obj && obj.colorToAsin) return obj;
    re.lastIndex = lit.end;
  }
  // Their fallback: a greedy per-line \`{...}\` chunk plus a quote rewrite.
  for (const chunk of chunkObjects(html)) {
    if (!chunk.includes("alwaysIncludeVideo")) continue;
    try {
      const obj = JSON.parse(chunk.replace(/'/g, '"'));
      if (obj && obj.colorToAsin) return obj;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Their \`text.match(/\\{(.*)\\}/g)\` \u2014 greedy within a line. */
function chunkObjects(text) {
  const line = String(text).match(/\{(.*)\}/g);
  return line || [];
}
function readBtfFromRoot(root) {
  const texts = [];
  try {
    for (const s of root.querySelectorAll("script")) {
      const t = s.textContent || "";
      if (t.includes("jQuery.parseJSON") || t.includes("ImageBlockATF")) texts.push(t);
    }
  } catch { /* ignore */ }
  return readBtfFromHtml(texts.join("\n"));
}

/**
 * Every variant's own main image, keyed by the FULL label Amazon uses
 * ("白色 热萃"), which already carries every dimension. That is why the twister's
 * per-dimension list is the fallback rather than the primary source.
 */
function variantsFromBtf(btf) {
  const colorToAsin = (btf && btf.colorToAsin) || {};
  const colorImages = (btf && btf.colorImages) || {};
  const out = [];
  for (const label of Object.keys(colorToAsin)) {
    const asin = colorToAsin[label] && colorToAsin[label].asin;
    if (!asin) continue;
    const set = Array.isArray(colorImages[label]) ? colorImages[label] : [];
    const main = set.find((x) => x && x.hiRes) || set[0] || null;
    out.push({
      childAsin: String(asin).toUpperCase(),
      label: String(label).trim().slice(0, 80),
      image: main ? main.hiRes || main.large || "" : "",
      variant: main ? main.variant || null : null
    });
  }
  return out;
}

// 0.23.5 删除死导出 variantGalleriesFromBtf()：全仓零引用（2026-09-13 全量扫描）。
// 深采的图集走 deepVariants.js（真机打开规格页），BTF 的 colorImages 只用来给
// variantsFromBtf() 填第一张图 —— 那个"每规格多图"版本没有任何调用点。
function videosFromBtf(btf) {
  const list = (btf && btf.videos) || [];
  return list
    .map((v) => ({
      url: v && v.url ? String(v.url) : "",
      title: String((v && v.title) || "").slice(0, 80),
      durationSeconds: (v && Number(v.durationSeconds)) || null,
      slateUrl: (v && v.slateUrl) || ""
    }))
    .filter((v) => v.url);
}

// 0.23.13 删除 relatedVideosFromDom()：它抓的是「相关视频轮播」（别人拍的相关视频），
// 用户明确要求只保留商品自己的视频后就没有调用点了（0.23.5 起就在清这类死导出）。

  // ===== v1.2.288 详情图(A+)判据：移植自 hires-extension src/lib/detailFilter.js（0.30.2 定稿，带真机证据）=====
  // 真机事实：A+ 容器 52 个 img，要留的 4 张渲染 1×1、要丢的 44 张渲染 158×181 → 渲染尺寸必然判反；
  // 判据改为 URL 里 __CR 裁切宽度（1464 留 / 362、166 丢），另用容器名排除 Brand Story 背景图。
  /**
   * 详情图（描述/A+ 图）的判据（0.30.2 定稿）。
   *
   * 真机数据（amazon.com/dp/B0D9VS4PV7，A+ 容器共 52 个 <img>，用户人工确认"详情图只有 4 张"）：
   *
   *   URL 特征                      张数   页面渲染尺寸   该不该算详情图
   *   __CR0,0,1464,600_…            4      1×1 (!)        ✅ 算（就是那 4 张）
   *   __CR0,0,1464,625_…            1      1464×625       ✅ 算
   *   __AC_SR166,182_…             44      158×181        ❌ 关联位缩略图
   *   __CR0,0,362,453_…             3      362×453        ❌ 用户点名"无关图"
   *
   * 两个结论：
   *   ① **渲染尺寸不能当判据**：要留的那 4 张懒加载没展开，渲染成 1×1；
   *      要丢的 44 张反而渲染成 158×181。按尺寸判必然判反（0.30.0/0.30.1 连续两版都错在这）。
   *   ② **URL 的 __CR 裁切宽度才是判据**：1464 vs 362 vs 166，一眼分开。
   *
   * 竞品对照（AGENTS §2.6 要求先查）：
   *   · 搞图宝：`#aplus .aplus-module img` —— 实测同样返回 52 张，**它没做过滤**，无可移植；
   *   · 电小商：全仓无 `aplus`/`productDescription`/`__CR0` 命中，**它不做亚马逊 A+**。
   * 所以这条口径是按实测自己定的，不是抄来的。
   */
  const DETAIL_MIN_EDGE = 500;

  /**
   * 从 Amazon 图片 URL 读出它**声明的**像素尺寸（读不出时 0 = 未知）。
   *   __CR<left>,<top>,<w>,<h>   裁切 → 取 w
   *   __AC_SR<w>,<h> / _SX<n> / _SY<n> / _SS<n>  缩放 → 取该值
   */
  function detailUrlWidth(url) {
    const u = String(url || "");
    if (!u) return 0;
    let m = /__CR\d+,\d+,(\d+),(\d+)/.exec(u);
    if (m) return Number(m[1]) || 0;
    m = /__AC_SR(\d+),(\d+)/.exec(u);
    if (m) return Number(m[1]) || 0;
    m = /_(?:SX|SY|SS|SL)(\d+)/.exec(u);
    if (m) return Number(m[1]) || 0;
    return 0;
  }

  /** 页面渲染尺寸（拿不到就是 0）。 */
  function sizeOf(el) {
    try {
      if (!el || typeof el.getBoundingClientRect !== "function") return { w: 0, h: 0 };
      const r = el.getBoundingClientRect();
      return { w: Math.round(Number(r.width) || 0), h: Math.round(Number(r.height) || 0) };
    } catch { return { w: 0, h: 0 }; }
  }

  /**
   * 这张图配得上当"详情图"吗？
   * 判据 = max(URL 声明的宽, 渲染长边)。两者都未知 → 保留（宁多留不误杀）。
   * @param {{url?:string, w?:number, h?:number}} img
   * @param {number} [minEdge] 默认 DETAIL_MIN_EDGE(=500)
   */
  function keepDetailImage(img, minEdge) {
    const it = img || {};
    const declared = detailUrlWidth(it.url);
    const w = Math.abs(Number(it.w) || 0);
    const h = Math.abs(Number(it.h) || 0);
    const rendered = Math.max(w, h);
    const long = Math.max(declared, rendered);
    if (long === 0) return true;                // 全未知（懒加载）→ 保留
    const min = Number(minEdge) > 0 ? Number(minEdge) : DETAIL_MIN_EDGE;
    if (long <= 2) return false;                // 占位/跟踪像素
    return long >= min;                          // 166/362 丢，1464 留
  }

  /**
   * Brand Story（"From the brand" 头部横幅）要排除。
   *
   * 0.30.4 真机证据（B0D9VS4PV7，用户确认"这张不算"）：留下的 5 张里唯一多出来的那张，
   * 祖先链是 `apm-brand-story-background-image < apm-brand-story-hero < celwidget.aplus-module
   * < apm-brand-story-carousel-container` —— 它是品牌故事轮播的**背景大图**；
   * 而真正的 4 张描述图祖先链是 `celwidget.aplus-module < aplus-content-wrapper`。
   * 两者 URL 都是 `__CR0,0,1464,…`（裁切宽一样），只有**容器名**能分开。
   */
  const DETAIL_EXCLUDE_SEL = '[class*="brand-story"], [class*="apm-brand"]';

  /** 元素版：量 DOM + 读 URL + 排 Brand Story。 */
  function keepDetailElement(el, url, minEdge) {
    try {
      if (el && typeof el.closest === "function" && el.closest(DETAIL_EXCLUDE_SEL)) return false;
    } catch { /* closest 不可用就当不在排除容器里 */ }
    const s = sizeOf(el);
    return keepDetailImage({ url: url, w: s.w, h: s.h }, minEdge);
  }

  /** 兼容旧调用（0.30.0/0.30.1 的纯尺寸版）：只在没有 URL 时用。 */
  function keepDetailSize(size, minEdge) {
    const s = size || {};
    return keepDetailImage({ w: s.w, h: s.h }, minEdge);
  }
  // ===== v1.2.290 视频：移植自 hires-extension src/lib/mediaExt.js + src/lib/extract.js（同一出处）=====
  // 为什么需要：旧写法把视频名硬编码 .mp4，而亚马逊有些视频位给的是 HLS 主播放列表 → 会写出 699 字节的
  // 文本文件还显示"下载成功"；同一段视频又有 mp4/m3u8 两种封装 → 需按视频 GUID 去重并优先渐进式 mp4。
  /**
   * Media file extensions, derived from the URL instead of assumed.
   *
   * WHY IT EXISTS
   * planExport used to hard-code ".mp4" for every video entry. Some Amazon video
   * slots hand back an HLS master playlist instead of a media file, so a 699-byte
   * text file (#EXTM3U …) was written as video/07.mp4 and still counted as a
   * successful download — the panel said "8 videos" and the user got 6 playable
   * files plus 2 broken ones.
   *
   * Measured 2026-09-12 on dp/B01GJOMWVA: 6 of 8 video URLs were real media files,
   * 2 were .m3u8 master playlists (699 B each).
   *
   * We do NOT resolve HLS into segments: that is transcoding, not asset download.
   * We name the file for what it actually is, so nothing is misrepresented.
   */

  const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|m3u8|mpd)(?=[?#]|$)/i;

  /** @returns {string} dotted lower-case extension; ".mp4" when the URL says nothing. */
  function videoExtOf(url) {
    const m = String(url == null ? "" : url).match(VIDEO_EXT);
    return m ? "." + m[1].toLowerCase() : ".mp4";
  }

  /** HLS/DASH manifests are playlists, not media files. */
  function isPlaylistUrl(url) {
    const ext = videoExtOf(url);
    return ext === ".m3u8" || ext === ".mpd";
  }

  /** 视频身份：两种编码（h264/h265）共用一个 /video_target/<id>。 */
  function videoIdentity(url) {
    const s = String(url || "");
    const m = s.match(/\/video_target\/([^/?#]+)/i);
    if (m) return "target:" + m[1].toLowerCase();
    // 通用兜底：去掉查询串（auth_key 每次不同）与 hash 后按路径
    return s.split("?")[0].split("#")[0].toLowerCase();
  }

  /** 编码优先级：h264（兼容性最好）→ 未知 → h265/hevc。 */
  function codecRank(url) {
    const s = String(url || "").toLowerCase();
    if (/h264|avc/.test(s)) return 0;
    if (/h265|hevc/.test(s)) return 2;
    return 1;
  }

  /**
   * 视频去重：**同一段视频的多种编码只保留一个，优先 h264**（0.22.2）。
   *
   * WHY（真机实测，商品 3256807520897212）：速卖通一段视频会从三个来源各来一条
   * （主世界 `videoUrl`、DOM 的 video 节点、内联 JSON 的 `productVideo.webUrl`），
   * 而且同一段视频同时给 **h264 与 h265 两种编码**（h265 那条还会重复一次）——
   * 实测 **3 条条目 / 2 个 URL / 1 段视频**，不去重就会下两份同样的 5.4 MB 文件。
   * 竞品直接把页面给的列表全返回，所以这个重复是竞品也有的；我们按身份去重。
   *
   * 去重在**探活之前**做：既少下文件，也少发 HEAD 请求。
   *
   * @param {Array<string|{url:string}>} list
   * @returns {Array<string|{url:string}>} 保持原形状（字符串进、字符串出）
   */
  function dedupeVideos(list) {
    const out = [];
    const seen = new Map();                     // identity -> { index, rank }
    for (const v of (Array.isArray(list) ? list : [])) {
      const url = typeof v === "string" ? v : (v && v.url ? String(v.url) : "");
      if (!url) continue;
      const key = videoIdentity(url);
      const rank = codecRank(url);
      const hit = seen.get(key);
      if (hit) {
        if (rank < hit.rank) { out[hit.index] = v; hit.rank = rank; }   // 换成更优编码
        continue;
      }
      seen.set(key, { index: out.length, rank: rank });
      out.push(v);
    }
    return out;
  }

  /** Amazon 视频 URL 里的视频 GUID（同一视频的不同封装共用它）。 */
  function amzVideoGuid(url) {
    const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(String(url || ""));
    return m ? m[1].toLowerCase() : null;
  }
  function collectVideos(root, btf = null) {
    const out = new Map();
    const push = (url, label) => {
      if (!url || !/^https?:\/\//.test(url)) return;
      if (!/(\.mp4|\.m3u8|video)/i.test(url)) return;
      if (!out.has(url)) out.set(url, { url, label: (label || "").trim().slice(0, 80) });
    };
    /** 这个节点是不是落在「相关视频」轮播（VSE 组件）里 —— 是的话就不是商品自己的素材。 */
    const inVse = (el) => {
      try { return !!(el && el.closest && el.closest("[class*=vse], [id*=vse]")); } catch { return false; }
    };
    for (const el of root.querySelectorAll("video[src], video source[src]")) {
      if (inVse(el)) continue;
      push(el.getAttribute("src"), el.getAttribute("title"));
    }
    for (const el of root.querySelectorAll("[data-video-url], [data-video-src]")) {
      if (inVse(el)) continue;
      push(el.getAttribute("data-video-url") || el.getAttribute("data-video-src"), el.getAttribute("aria-label"));
    }
    for (const s of root.querySelectorAll("script")) {
      const text = s.textContent || "";
      // 只认站点自己的负载脚本；其它脚本里的 mp4 可能属于轮播/广告位（0.23.13）
      if (!/ImageBlockATF|ImageBlockBTF|parseJSON/.test(text)) continue;
      const m = text.match(/"(?:videoUrl|videoURL|url)"\s*:\s*"(https:[^"]+?\.(?:mp4|m3u8)[^"]*)"/i);
      if (m) push(m[1].replace(/\\u002F/g, "/"), "script");
    }
    for (const v of videosFromBtf(btf)) push(v.url, v.title);
    // 同一个视频在亚马逊会有多种封装：真机实测 BTF 的那条同时给了
    //   …/3c093e747c9a/default.jobtemplate.mp4.480.mp4（渐进式）与
    //   …/3c093e747c9a/default.jobtemplate.hls.m3u8（HLS）
    // 两段**同一个 GUID** —— 按 GUID 去重，优先留可直接播放的渐进式 mp4（m3u8 要 ffmpeg 才能下）。
    const byId = new Map();
    for (const v of out.values()) {
      const id = amzVideoGuid(v.url) || v.url;
      const prev = byId.get(id);
      if (!prev) { byId.set(id, v); continue; }
      if (/\.m3u8/i.test(prev.url) && !/\.m3u8/i.test(v.url)) byId.set(id, v);
    }
    return [...byId.values()].slice(0, 20);
  }
  function hasAplus(root) {
    if (root.querySelector("#aplus, #aplus_feature_div, .aplus-v2, [data-aplus]")) return true;
    // fallback: a tall block of images between description and reviews
    const imgs = root.querySelectorAll("#productDescription img, .aplus img");
    return imgs.length >= 3;
  }
  function hasVideo(root) {
    return root.querySelector("video, .vse-player, [data-video-url]") !== null;
  }
  // 对外暴露（与 lib/image-parser.js 同风格）
  window.__AIS_AMAZON__ = {
    MARKETPLACES: MARKETPLACES,
    PAGE_TYPE: PAGE_TYPE,
    hostMatchesAmazon: hostMatchesAmazon,
    marketplaceOf: marketplaceOf,
    asinFromUrl: asinFromUrl,
    readAtfFromHtml: readAtfFromHtml,
    readAtfFromRoot: readAtfFromRoot,
    readBtfFromHtml: readBtfFromHtml,
    readBtfFromRoot: readBtfFromRoot,
    variantsFromBtf: variantsFromBtf,
    videosFromBtf: videosFromBtf,
    DETAIL_MIN_EDGE: DETAIL_MIN_EDGE,
    DETAIL_EXCLUDE_SEL: DETAIL_EXCLUDE_SEL,
    detailUrlWidth: detailUrlWidth,
    keepDetailImage: keepDetailImage,
    keepDetailElement: keepDetailElement,
    videoExtOf: videoExtOf,
    isPlaylistUrl: isPlaylistUrl,
    dedupeVideos: dedupeVideos,
    amzVideoGuid: amzVideoGuid,
    collectVideos: collectVideos,
    hasVideo: hasVideo
  };
})();
