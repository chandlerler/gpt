// 电商宝 - 评论「智能判定」接口（v1.2.306）
// 设计要点（用户 2026-09-15 指定）：
//   判定 = 权重向量 · 特征向量 -> 概率（sigmoid）；**词表只作为特征来源之一，不再是判决者**。
//   结构角色（是否本商品 / 是否已发生 / 假设 / 条件 / 引用 / 转折）由通用篇章规则产出"豁免计数"，
//   这些计数进特征向量，由权重决定其影响 —— 因此不再需要为每个新句式加白名单。
//   在线纠错：调用 feedback(review, label) 即做一步 SGD 并落盘 chrome.storage，立即生效（越用越准）。
//   离线训练：见工作区 train-judge.cjs（把人工标注样本喂进来即可，权重以本文件默认为正则化中心）。
// 接口（对外只有一个）：
//   AisReviewJudge.judge(review) -> {negative, confidence, prob, aspects, reasons, features}
//   AisReviewJudge.feedback(review, label, note) -> Promise<{ok, samples, prob}>
//   AisReviewJudge.stats() / reset() / FEATURES / version
(function () {'use strict';
var VERSION = '1.2.308';
var STORE_SAMPLES = 'aisJudgeSamples';
var STORE_WEIGHTS = 'aisJudgeWeights';

// ---- 特征表（顺序即权重顺序；名字用于面板展示"为什么"）----
var FEATURES = ['bias','starPrior','ruleScore','hardNeg','effNeg','posCount','complainCo',
 'aspQuality','aspSize','aspTransparency','aspColor','aspFunction','aspHealth','aspLogistics','aspDescription',
 'exHypoth','exContrast','exOldItem','exCond','exQuote','negated','contrastAfter','minedHit',
 'repeatIntensity','switchMark','oldItemMark','textLen','punctExcl','emoji'];
// 冷启动权重：数值使 judge 在无任何标注时近似旧算法行为（不追求最优，只求不劣化）
var W0 = [-2.6, 3.0, 3.0, 2.0, 1.5, -1.5, 1.0,
 1.2, 0.6, 1.0, 1.0, 1.5, 2.0, 1.2, 1.5,
 0, 0, 0, 0, 0, -0.2, 1.2, 0.9,
 0.8, -0.8, -1.0, 0.4, -0.2, 0];
var W = W0.slice();
var B = 0;                 // 偏置偏移（SGD 学）
var SAMPLES = [];          // 在线样本（含人工纠错）
var KNN_MIN = 8;           // 样本数达标才启用 kNN 融合
var LR = 0.35;             // 在线学习率
var store = null;
try { store = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) ? chrome.storage.local : null; } catch (eS) { store = null; }

// ---- 规则来源：复用 review-stats 的"有效规则"（含远端覆盖），词表只是特征来源 ----
function rules() {
  try { if (typeof window !== 'undefined' && window.__AIS_REVIEW_RULES__) return window.__AIS_REVIEW_RULES__(); } catch (e) {}
  return null;
}
var DEF = {
  POS: ['推荐','回购','满意','喜欢','舒服','不错','很好','好评','值得','性价比','合适','好看'],
  HARD_NEG: ['差评','不满意','很差','太差','失望','不推荐','垃圾','退款','退货','别买','慎入','踩雷','劝退','被骗','后悔','避坑','质量差','质量问题','质量不行','货不对板','假货','破损','坏了','无法使用','售后不处理','拒绝退款','虚假宣传'],
  TRANSPARENCY: ['透肤','透光','太透','透内搭','太薄','薄透','太厚','厚重','闷','闷热','不透气','粘身','扎皮肤','扎人','刺痒','不亲肤','掉渣','起静电','防晒效果差','不防晒','保暖差','不挡风'],
  HYPOTH: /(?:担心|害怕|怕是|怕|还以为|以为|恐怕|万一|如果|要是|假如|倘若)/,
  CONTRAST: /(?:但|但是|不过|然而|结果|幸好|好在)[^。！？；;]{0,24}(?:满意|喜欢|不错|很好|非常好|合身|合适|推荐|好评|值得)/,
  CONTRAST_MARK: /(?:但|但是|不过|然而|就是|可惜|唯一|只是|除了)/,
  OLDITEM: /(?:之前|原来|原本|原装|杂牌|旧的|旧款|上一根|上一个|前(?:两|一|几|面)根|几年前买|以前|上次买|别的线|自带的)/,
  SWITCH: /(?:这款|这个|本款|本次|换了|新买的|现在的)/,
  COND: /^(?:的时候|时|的话)/,
  QUOTE: /(?:别人|有人|网上|评论区|网友|朋友|听说|据说)[^。！？；;]{0,12}(?:说|评价|觉得|认为|反映)/,
  SELF: /(?:我也|我同样|确实|真的|实际|本人|亲自|同样|也遇到)/,
  NEGATE: /(?:没有|没|不|未|无|并不|不是|不太|不会|避免|防止|防|谈不上|称不上|算不上|毫无|毫不|没什么)/,
  REPEAT: /(?:严重|很大|太大|特别|非常|一直|反复|容易|总是|每次|多次|完全|根本|明显)/,
  COMPLAIN: /(?:别买|不推荐|慎入|劝退|退货|退款|换货|退了|浪费)/
};
function ruleOf(name, fallback) { var R0 = rules(); try { if (R0 && R0[name]) return R0[name]; } catch (e) {} return fallback; }
function cats() { var R0 = rules(); try { if (R0 && R0.CATS && R0.CATS.length) return R0.CATS; } catch (e) {} return null; }
function clean(v) { return String(v == null ? '' : v).replace(/<[^>]+>/g, ' ').replace(/ +/g, ' ').trim(); }
function text(r) { return clean(r && r.content) + ' ' + clean(r && r.appendContent); }
function star(r) { var n = parseInt(r && r.rating, 10); return (n >= 1 && n <= 5) ? n : 0; }
function countRe(t, re) { if (!re) return 0; var g = new RegExp(re.source, 'g'), n = 0, m; while ((m = g.exec(t)) !== null) { n++; if (n > 50) break; if (m.index === g.lastIndex) g.lastIndex++; } return n; }
function sentences(t) { return clean(t).split(/[。！？!？；;]/).filter(function (x) { return x; }); }

// 结构角色判定（通用篇章规则；返回是否应"豁免"这个词）
function exemptKind(sent, wi, wl, t) {
  var R0 = rules() || {};
  var hypoth = ruleOf('HYPOTH_RE', DEF.HYPOTH), contrast = ruleOf('CONTRAST_POS_RE', DEF.CONTRAST);
  var oldit = ruleOf('OLDITEM_RE', DEF.OLDITEM), sw = ruleOf('SWITCH_RE', DEF.SWITCH);
  var cond = ruleOf('COND_AFTER', DEF.COND), quote = ruleOf('QUOTE_RE', DEF.QUOTE), self = ruleOf('SELF_AFFIRM_RE', DEF.SELF);
  var negate = ruleOf('NEGATE_RE', DEF.NEGATE);
  var before = sent.slice(Math.max(0, wi - 8), wi);
  if (hypoth && hypoth.test(before)) { var after = sent.slice(wi + wl, wi + wl + 24); if (!/(?:结果|果然|最后)[^。！？；;]{0,8}(?:慢|差|错|坏|没|未|不)/.test(after)) return 'exHypoth'; }
  if (contrast) { var m = contrast.exec(sent); if (m && m.index > wi) return 'exContrast'; }
  if (oldit) {
    var pre14 = sent.slice(Math.max(0, wi - 14), wi);
    if (oldit.test(pre14)) return 'exOldItem';
    if (sw) { var sm = sw.exec(sent); if (sm && sm.index > wi && oldit.test(sent.slice(0, wi))) return 'exOldItem'; }
  }
  if (cond && cond.test(sent.slice(wi + wl, wi + wl + 5))) return 'exCond';
  if (quote) { var qb = sent.slice(Math.max(0, wi - 24), wi), qa = sent.slice(wi + wl, wi + wl + 32); if (quote.test(qb) && !(self && self.test(qa))) return 'exQuote'; }
  if (negate) { var nb = sent.slice(Math.max(0, wi - 3), wi); if (negate.test(nb) && !/(?:别买|不要买|不推荐)/.test(sent)) return 'negated'; }
  return '';
}
// 扫描"投诉候选词"（来自有效规则词表 + 透肤类），统计有效命中与各类豁免计数
function scan(t) {
  var cand = [];
  var hn = ruleOf('HARD_NEG', DEF.HARD_NEG); if (hn && hn.length) cand = cand.concat(hn);
  var cs = cats();
  if (cs) { for (var i = 0; i < cs.length; i++) cand = cand.concat(cs[i].words || []); }
  else cand = cand.concat(DEF.TRANSPARENCY);
  var mw = null; try { mw = rules().POS ? null : null; } catch (eM) {}
  try { var apiC = (typeof window !== 'undefined') ? window.AisAnchors : null; var mc = apiC && apiC.arr ? apiC.arr('review.mined', []) : []; if (mc.length) cand = cand.concat(mc); } catch (eM2) {}
  var ss = sentences(t), out = { effNeg: 0, hardEff: 0, contrastAfter: 0, exempt: {}, aspect: {}, terms: [] };
  var hardSet = {}; if (hn && hn.length) for (var h2 = 0; h2 < hn.length; h2++) hardSet[hn[h2]] = 1;
  var cm = ruleOf('CONTRAST_MARK', DEF.CONTRAST_MARK);
  var minedSet = {}; try { var apiM = (typeof window !== 'undefined') ? window.AisAnchors : null; var mn = apiM && apiM.arr ? apiM.arr('review.mined', []) : []; for (var m3 = 0; m3 < mn.length; m3++) if (typeof mn[m3] === 'string') minedSet[mn[m3]] = 1; } catch (eM3) {}
  var seen = {};
  for (var c = 0; c < cand.length; c++) {
    var w = cand[c]; if (!w || seen[w]) continue; seen[w] = 1;
    for (var s = 0; s < ss.length; s++) {
      var ix = ss[s].indexOf(w); if (ix < 0) continue;
      var k = exemptKind(ss[s], ix, w.length, t);
      if (k) { out.exempt[k] = (out.exempt[k] || 0) + 1; }
      else {
        out.effNeg++;
        if (hardSet[w]) out.hardEff = (out.hardEff || 0) + 1;
        if (minedSet[w]) out.minedEff = (out.minedEff || 0) + 1;
        if (cm) { var preM = ss[s].slice(0, ix); if (cm.test(preM)) out.contrastAfter = (out.contrastAfter || 0) + 1; }
        var cat = catOf(w);
        if (cat) out.aspect[cat] = (out.aspect[cat] || 0) + 1;
        if (out.terms.length < 6) out.terms.push(w);
      }
      break;
    }
  }
  return out;
}
function catOf(w) {
  var cs = cats(); if (!cs) return '';
  for (var i = 0; i < cs.length; i++) { var ws = cs[i].words || []; for (var j = 0; j < ws.length; j++) if (ws[j] === w) return cs[i].key; }
  if (w === '透肤' || w === '太透' || w === '薄透' || w === '太薄' || w === '不透气') return 'transparency';
  return '';
}
function featOf(r, ruleScore) {
  var t = text(r), R0 = rules() || {}, s = star(r), sc = scan(t);
  var pos = 0, pw = ruleOf('POS', DEF.POS) || []; for (var i = 0; i < pw.length; i++) if (t.indexOf(pw[i]) >= 0) pos++;
  var ex = sc.exempt || {}, asp = sc.aspect || {};
  var exN = function (k) { return Math.min(3, ex[k] || 0); };
  var emoji = 0; try { emoji = (t.match(/[�-�][�-�]/g) || []).length; } catch (eE) { emoji = 0; }
  var excl = (t.match(/[!！?？]/g) || []).length; if (excl > 10) excl = 10;
  var norm = function (n) { return n <= 0 ? 0 : Math.min(3, n / (1 + t.length / 60)); };
  return [
    1,                                                        // bias
    s ? (s <= 2 ? 1 : (s === 3 ? 0.4 : 0)) : 0,               // starPrior
    Math.min(2, Math.max(0, (ruleScore || 0) / 5)),            // ruleScore
    Math.min(2, sc.hardEff || 0),                              // hardNeg（结构有效命中数，v1.2.308：裸子串会误点火）
    norm(sc.effNeg),                                          // effNeg
    norm(pos),                                                // posCount
    ruleOf('COMPLAIN_CO', DEF.COMPLAIN).test(t) ? 1 : 0,       // complainCo
    norm(asp.quality || 0), norm(asp.size || 0), norm(asp.transparency || 0), norm(asp.color || 0),
    norm(asp.function || 0), norm(asp.health || 0), norm(asp.logistics || 0), norm(asp.description || 0),
    exN('exHypoth'), exN('exContrast'), exN('exOldItem'), exN('exCond'), exN('exQuote'), exN('negated'),
    Math.min(2, sc.contrastAfter || 0),                        // contrastAfter（v1.2.308）
    Math.min(2, sc.minedEff || 0),                             // minedHit（数据挖掘词有效命中，v1.2.309）
    norm(countRe(t, ruleOf('REPEAT_RE', DEF.REPEAT))),         // repeatIntensity
    ruleOf('SWITCH_RE', DEF.SWITCH).test(t) ? 1 : 0,           // switchMark（在说本品）
    ruleOf('OLDITEM_RE', DEF.OLDITEM).test(t) ? 1 : 0,         // oldItemMark（在说旧物）
    Math.min(2, t.length / 150),                               // textLen
    excl / 10, emoji > 5 ? 1 : emoji / 5                       // punctExcl, emoji
  ];
}
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function dot(x) { var z = B; for (var i = 0; i < W.length && i < x.length; i++) z += W[i] * x[i]; return z; }
// 字符 3-gram 哈希向量（用于在线 kNN；不依赖任何词表）
function vec3(t) {
  var v = new Float64Array(512), s = clean(t); if (!s) return v;
  var CH = 0x9E3779B1;
  for (var i = 0; i + 3 <= s.length; i++) {
    var h = 0; for (var j = 0; j < 3; j++) h = (h * 131 + s.charCodeAt(i + j)) | 0;
    var b = Math.abs(h % 512); v[b] += 1;
  }
  return v;
}
function cos(a, b) { var d = 0, na = 0, nb = 0; for (var i = 0; i < 512; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return (na && nb) ? d / Math.sqrt(na * nb) : 0; }
function knnProb(t) {
  if (SAMPLES.length < KNN_MIN) return null;
  var q = vec3(t), num = 0, den = 0;
  var scored = SAMPLES.slice(-800).map(function (s) { return { s: s, sim: cos(q, s.v || (s.v = vec3(s.text))) }; });
  scored.sort(function (a, b) { return b.sim - a.sim; });
  for (var i = 0; i < Math.min(7, scored.length); i++) { var o = scored[i]; if (o.sim <= 0.05) break; num += o.sim * o.s.label; den += o.sim; }
  return den ? num / den : null;
}
function judge(r, opts) {
  opts = opts || {};
  var base = 0;
  try { if (r && typeof r.__score === 'number') base = r.__score; else if (r && r.__sus && typeof r.__sus.score === 'number') base = r.__sus.score; else if (typeof r.__score === 'number') base = r.__score; } catch (e) {}
  var x = featOf(r, base);
  var z = dot(x), p = sigmoid(z);
  var kn = opts.knn === false ? null : knnProb(text(r));
  var pFinal = kn === null ? p : 0.75 * p + 0.25 * kn;
  var contrib = [];
  for (var i = 1; i < W.length; i++) if (x[i]) contrib.push({ name: FEATURES[i], x: Math.round(x[i] * 100) / 100, w: W[i], c: Math.round(W[i] * x[i] * 100) / 100 });
  contrib.sort(function (a, b) { return Math.abs(b.c) - Math.abs(a.c); });
  var asp = [];
  var nm = { aspQuality: '质量/做工', aspSize: '尺码/版型', aspTransparency: '透肤/材质', aspColor: '颜色/色差', aspFunction: '功能/安全', aspHealth: '健康/食品', aspLogistics: '物流/售后', aspDescription: '描述不符' };
  for (var k = 0; k < FEATURES.length; k++) if (nm[FEATURES[k]] && x[k] > 0) asp.push(nm[FEATURES[k]]);
  return {
    negative: pFinal >= (opts.cut == null ? 0.5 : opts.cut),
    prob: Math.round(pFinal * 1000) / 1000,
    confidence: Math.round(Math.abs(pFinal - 0.5) * 2 * 100) / 100,
    aspects: asp,
    reasons: contrib.slice(0, 5),
    features: x,
    source: kn === null ? 'model' : 'model+knn(' + SAMPLES.length + ')',
    version: VERSION
  };
}
// 在线纠错学习：一步 SGD + 落盘（面板「误判」按钮调用）
function feedback(r, label, note) {
  var x = featOf(r, (r && (r.__score || (r.__sus && r.__sus.score))) || 0);
  var y = label ? 1 : 0;
  var p = sigmoid(dot(x));
  var g = (y - p) * LR;
  for (var i = 0; i < W.length; i++) W[i] = W[i] + g * x[i];
  B = B + g;
  SAMPLES.push({ text: text(r), label: y, rating: star(r), note: String(note || '').slice(0, 80), ts: Date.now(), v: vec3(text(r)) });
  if (SAMPLES.length > 2000) SAMPLES = SAMPLES.slice(-2000);
  persist();
  return { ok: true, samples: SAMPLES.length, prob: Math.round(sigmoid(dot(x)) * 1000) / 1000, judge: judge(r) };
}
function persist() {
  try {
    if (store) {
      var o = {}; o[STORE_WEIGHTS] = { w: W, b: B, n: SAMPLES.length, v: VERSION };
      o[STORE_SAMPLES] = SAMPLES.map(function (s) { return { text: s.text, label: s.label, rating: s.rating, note: s.note, ts: s.ts }; });
      store.set(o);
    }
  } catch (e) {}
}
function load(done) {
  try {
    if (!store) { if (done) done(); return; }
    store.get([STORE_WEIGHTS, STORE_SAMPLES], function (o) {
      try {
        if (o && o[STORE_WEIGHTS] && o[STORE_WEIGHTS].w && o[STORE_WEIGHTS].w.length === W0.length) { W = o[STORE_WEIGHTS].w.slice(); B = o[STORE_WEIGHTS].b || 0; }
        if (o && o[STORE_SAMPLES] && o[STORE_SAMPLES].length) SAMPLES = o[STORE_SAMPLES];
      } catch (e) {}
      if (done) done();
    });
  } catch (e) { if (done) done(); }
}
function stats() { return { version: VERSION, samples: SAMPLES.length, knnActive: SAMPLES.length >= KNN_MIN, weights: W.slice(), bias: B }; }
function reset() { W = W0.slice(); B = 0; SAMPLES = []; try { if (store) store.remove([STORE_WEIGHTS, STORE_SAMPLES]); } catch (e) {} return stats(); }
window.AisReviewJudge = { judge: judge, feedback: feedback, stats: stats, reset: reset, load: load, features: featOf, scan: scan, FEATURES: FEATURES, weightsDefault: W0.slice(), version: VERSION };
try { load(); } catch (e) {}
})();
