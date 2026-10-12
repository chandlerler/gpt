// 电商宝 - 评论问题分析模块（v6：规则可远程配置）
// v1.2.259：正面词表/强否定词表/分类词表/各条正则/计分与分级阈值 改为可远程覆盖（registry review.*）；
// 扫描、否定豁免、引用豁免、尺码软硬分层、正面主导抵消等**算法仍在本文件**，不随 JSON 改变。
(function(){'use strict';
// ---- 内置默认（注册表缺失或未覆盖时使用，与改造前逐字一致）----
var DEF_POS=['推荐','回购','满意','喜欢','舒服','不错','很好','好评','值得','性价比','合适','好看','物美价廉','划算','显瘦','质量好','质量不错','质量很好','非常满意','挺满意','物超所值','很值','没问题'];
var DEF_HARD_NEG=['差评','不满意','很差','太差','失望','不推荐','垃圾','退款','退货','别买','慎入','踩雷','劝退','被骗','后悔','避坑','质量差','质量问题','质量不行','货不对板','假货','破损','坏了','无法使用','售后不处理','拒绝退款','虚假宣传'];
var DEF_CATS=[
 {key:'quality',name:'质量/做工',words:['掉色','褪色','染色','脱色','脱线','开线','跳线','开裂','开叉','破损','破洞','瑕疵','起球','缩水','缩小','变形','勾丝','抽丝','断裂','断带','脱胶','开胶','掉毛','粘毛','勾破','松垮','发黄','污渍','脏污','异味','臭味','霉味','粗糙','线头','线迹差','做工差','做工粗','面料差','材质差','质量一般','质量差','廉价感','穿几次就坏','用几天就坏','不耐穿','不结实','容易坏','一洗就坏','洗一次就坏'],base:2},
 {key:'size',name:'尺码/版型',words:['偏大','偏小','太大','太小','太紧','太松','太长','太短','不合身','版型差','版型不好','显胖','显臃肿','肥大','偏肥','偏瘦','勒','卡裆','裆部不舒服','腰围小','腰围大','领口紧','袖子短','裤长短','肩宽','往下滑','穿不上','穿不下','宽了','挺宽','松垮','塌肩','肩膀窄','胸围小','胸围大','长度不够','长度太长'],base:1},
 {key:'transparency',name:'透肤/防晒',words:['透肤','透光','太透','透内搭','透出来','太薄','薄透','太厚','厚重','闷','闷热','不透气','粘身','扎皮肤','扎人','刺痒','不亲肤','掉渣','起静电','防晒效果差','不防晒','保暖差','不挡风'],base:2},
 {key:'color',name:'颜色/色差',words:['色差','颜色不对','颜色奇怪','偏色','颜色不一样','颜色深','颜色浅','偏黄','偏红','偏绿','偏暗','偏亮','发白','色不正','色号偏白','色号偏深','实物颜色差','显旧','颜色失真','染色严重','串色'],base:2},
 {key:'function',name:'功能/安全',words:['无法使用','不能使用','不能开机','开不了机','死机','闪退','断连','连接不上','充不上电','充电异常','耗电快','续航短','续航虚标','发烫','发热严重','漏电','漏水','漏液','烫手','失灵','卡住','卡顿','噪音大','异响','不工作','无法安装','安装失败','灵敏度差','影响使用','虚标','没电','自动关机','反应慢','功能失效','按键失灵','屏幕异常','信号差','网络不稳'],base:4},
 {key:'health',name:'健康/食品安全',words:['过敏','刺痛','发红','红肿','瘙痒','刺痒','掉渣','异物','虫','虫子','变质','发霉','临期','变味','异味','刺激','刺激性气味','不卫生','肚子疼','腹泻','恶心','膨包','漏气','生虫','有毛发','有杂质','吃坏肚子'],base:5},
 {key:'logistics',name:'物流/售后',words:['发货慢','发货太慢','延迟发货','物流慢','物流很慢','物流太慢','物流停滞','物流不动','快递慢','快递太慢','等了一个星期','等了很久','快递丢失','延误','漏发','少发','少件','缺件','发错','包裹破损','包装破损','客服态度差','客服不处理','客服不回复','客服不理','不回复','售后不处理','售后拖延','拒绝售后','拒绝退款','拒绝补发','价保纠纷','推诿','推卸责任','无人处理','不解决','踢皮球','敷衍','态度恶劣'],base:3},
 {key:'description',name:'描述不符',words:['描述不符','与描述不符','图片不符','实物不符','实物与图片','和图片不一样','严重不符','货不对版','货不对样','参数不符','规格不符','颜色与图片','图片美化','与实物差距大','虚假宣传','虚标容量','尺寸不符','材质不符','功能与描述不符','宣传不实'],base:4}
];
var DEF_RE={
 ACCEPT_RE:/(?:不多|很少|少量|不明显|能接受|可以接受|可接受|不影响|没什么|不算|洗洗|剪剪|这个价|符合这个价|物有所值|值得|不错|很好|舒服|推荐|回购|满意|好评|值得好评|问题不大|轻微|整体.{0,6}(?:不错|很好|满意)|总体.{0,6}(?:不错|很好|满意)|以外.{0,8}(?:不错|很好|满意)|不严重|还好|还行|无碍|瑕不掩瑜|无伤大雅|没什么问题)/,
 TIP_RE:/(?:建议|偏大|偏小|买大|买小|大一码|小一码|有点|略|一点|需要剪|看好尺寸|第一次使用|首次使用|色号|容量|辣度|慎拍|调节一下)/,
 UNCERTAIN_RE:/(?:可能|嫌疑|担心|会不会|不知道|估计|刚收到|以后再看|看看|希望|如果)/,
 QUOTE_RE:/(?:别人|有人|网上|评论区|网友|朋友|听说|据说)[^。！？；;]{0,12}(?:说|评价|觉得|认为|反映)/,
 HIST_RE:/(?:以前|之前|去年|前年|上次|上回|穿了一年|穿了\d*(?:年|个多月|个月|个月多)|用了\d*(?:年|个多月|个月)|旧款|旧衣|旧了|另一件|别家|他家其他|去年买|早前|老款)/,
 PRAISE_AFTER_RE:/(?:工整|平整|干净|牢固|严实|细致|均匀|完好|正常|没问题|无碍|一致|统一|精细|处理得)/,
 POSITIVE_CONTEXT_RE:/(?:售后(?:无忧|放心|有保障)|(?:物流|快递)(?:高效|很快|迅速|及时)|发货(?:快|及时)|(?:服务|客服)(?:耐心|很好|周到)|(?:没有|无|未|不存在)(?:任何)?[^。！？；;]{0,3}破损)/,
 SIZE_HARD_RE:/(?:太大|太小|大了|小了|非常\s*[大小长短紧宽松]|特别\s*[大小宽紧]|超级\s*[大小]|穿不下|穿不上|没法穿|根本穿不了|瘦子[^。]{0,6}别买|最大码?都|最小码?都|宽了|挺宽|都大|太宽)/,
 COMPLAIN_CO:/(?:别买|不推荐|慎入|劝退|退货|退款|换货|退了|浪费|当睡衣)/,
 NEGATE_RE:/(?:没有|没|不|未|无|并不|不是|不太|不会|避免|防止|防|谈不上|称不上|算不上|毫无|毫不|没什么|算不上|谈不上)/,
 REPEAT_RE:/(?:严重|很大|太大|特别|非常|一直|反复|容易|宽了|挺宽|都大|总是|每次|多次|完全|根本|明显|影响|染蓝|染色|臭|刺鼻|脱线|开裂|破损|退货|退款)/,
 CONCESS_RE:/(?:其他|别的|整体|总体|毕竟|反正|懒得|无所谓)/,
 NEG_PRAISE_RE:/(?:不|没|未|无|别)$/,
 HN_DENY:/(?:没有任何|无任何|没有|没让|不让|让我|还有|也有|有些|毫不|并不|不是|毫无|谈不上|算不上|不可能|不存在|都说|别人|没|不|未|别|无|非)$/,
 HN_AFTER:/^(?:再买|再说|也能|也没|也好|是不可能|不可能|不存在)/,
 HN_WEAK:/(?:像|好像|像是|疑似|估计|可能|看着)/,
 NEG_AFTER:/^(?:一点(?:都|也)?没有|完全(?:都)?没有|基本没有|几乎没有|都?很(?:淡|轻|轻微)|不(?:大|重|明显|浓|刺鼻|难闻|算)|都?没有(?=$|[，。！？；;,\s]|一点|什么))/,
 ADVISORY:/(?:第一次使用|首次使用).{0,12}(?:充满电|充电)|容量.{0,12}(?:小|尺寸)|辣度.{0,12}(?:高|慎拍)|色号.{0,12}(?:偏|看)|颜色.{0,8}(?:有点|略|偏).{0,6}(?:深|浅|暗|白)|(?:略透|有点透).{0,10}(?:建议|内搭)|(?:肩带|带子).{0,10}(?:长|短|调节)|买[大小].{0,12}(?:换|合适)|建议.{0,12}(?:一号|尺码)/,
 SELF_AFFIRM:/(?:我也|我同样|确实|真的|实际|本人|亲自|同样|也遇到)/,
 HIST_KEEP:/(?:现在|如今|目前|这次|本次|后来|实际|确实|真的)/,
 HYPOTH_RE:/(?:担心|害怕|怕是|怕|还以为|以为|恐怕|万一|如果|要是|假如|倘若)/,
 OLDITEM_RE:/(?:之前|原来|原本|原装|杂牌|旧的|旧款|上一根|上一个|前(?:两|一|几|面)根|几年前买|以前|上次买|别的线|自带的)/,
 SWITCH_RE:/(?:这款|这个|本款|本次|换了|新买的|现在的)/,
 COND_AFTER:/^(?:的时候|时|的话)/,
 CONTRAST_POS_RE:/(?:但|但是|不过|然而|结果|幸好|好在)[^。！？；;]{0,24}(?:满意|喜欢|不错|很好|非常好|合身|合适|推荐|好评|值得)/,
 PLACEHOLDER_RE:/(?:15天内买家未作出评价|此用户没有填写评价|默认好评|评价方未及时做出评价)/
};
var DEF_NUM={ RATING_SCORE:[0,6,5,1,0,0], HARD_PEN:4, HARD_PEN_WEAK:3, REPEAT_BONUS:3, UNCERTAIN_PEN:1,
 DAMPEN:[[3,9],[2,5],[1,3]], LEVEL_HIGH:7, LEVEL_MED:4, LEVEL_LOW:2, NEG_CUT:4, TIP_CUT:1,
 EVIDENCE_MAX:4, TIPS_MAX:20, ALERT_HIGH:5, ALERT_MED:3 };

// ---- 规则读取：按注册表来源版本缓存（远程规则异步到达，故必须惰性读取）----
var _c={src:null,R:null};
function rules(){
 var api=(typeof window!=='undefined')?window.AisAnchors:null;
 var src=api?String(api.source||''):'';
 if(_c.src===src&&_c.R)return _c.R;
 function arr(p,fb){ try{ var v=api?api.arr(p,fb):fb; return (v&&v.length)?v:fb; }catch(e){ return fb; } }
 function num(p,fb){ try{ var v=api?api.num(p,fb):fb; return (typeof v==='number'&&isFinite(v))?v:fb; }catch(e){ return fb; } }
 function re(p,fb){ try{ var s=api?api.sel(p,''):''; if(s)return new RegExp(s); }catch(e){} return fb; }
 var R={
  POS:arr('review.pos',DEF_POS), HARD_NEG:arr('review.hardNeg',DEF_HARD_NEG), CATS:arr('review.cats',DEF_CATS),
  RATING_SCORE:arr('review.ratingScore',DEF_NUM.RATING_SCORE), DAMPEN:arr('review.dampen',DEF_NUM.DAMPEN),
  HARD_PEN:num('review.hardPen',DEF_NUM.HARD_PEN), HARD_PEN_WEAK:num('review.hardPenWeak',DEF_NUM.HARD_PEN_WEAK),
  REPEAT_BONUS:num('review.repeatBonus',DEF_NUM.REPEAT_BONUS), UNCERTAIN_PEN:num('review.uncertainPen',DEF_NUM.UNCERTAIN_PEN),
  LEVEL_HIGH:num('review.levelHigh',DEF_NUM.LEVEL_HIGH), LEVEL_MED:num('review.levelMedium',DEF_NUM.LEVEL_MED), LEVEL_LOW:num('review.levelLow',DEF_NUM.LEVEL_LOW),
  NEG_CUT:num('review.negCut',DEF_NUM.NEG_CUT), TIP_CUT:num('review.tipCut',DEF_NUM.TIP_CUT),
  EVIDENCE_MAX:num('review.evidenceMax',DEF_NUM.EVIDENCE_MAX), TIPS_MAX:num('review.tipsMax',DEF_NUM.TIPS_MAX),
  ALERT_HIGH:num('review.alertHigh',DEF_NUM.ALERT_HIGH), ALERT_MED:num('review.alertMed',DEF_NUM.ALERT_MED),
  ACCEPT_RE:re('review.acceptRe',DEF_RE.ACCEPT_RE), TIP_RE:re('review.tipRe',DEF_RE.TIP_RE),
  UNCERTAIN_RE:re('review.uncertainRe',DEF_RE.UNCERTAIN_RE), QUOTE_RE:re('review.quoteRe',DEF_RE.QUOTE_RE),
  HIST_RE:re('review.histRe',DEF_RE.HIST_RE), PRAISE_AFTER_RE:re('review.praiseAfterRe',DEF_RE.PRAISE_AFTER_RE),
  POSITIVE_CONTEXT_RE:re('review.positiveCtxRe',DEF_RE.POSITIVE_CONTEXT_RE), SIZE_HARD_RE:re('review.sizeHardRe',DEF_RE.SIZE_HARD_RE),
  COMPLAIN_CO:re('review.complainRe',DEF_RE.COMPLAIN_CO), NEGATE_RE:re('review.negateRe',DEF_RE.NEGATE_RE),
  REPEAT_RE:re('review.repeatRe',DEF_RE.REPEAT_RE), CONCESS_RE:re('review.concessRe',DEF_RE.CONCESS_RE),
  NEG_PRAISE_RE:re('review.negPraiseRe',DEF_RE.NEG_PRAISE_RE), HN_DENY:re('review.hnDenyRe',DEF_RE.HN_DENY),
  HN_AFTER:re('review.hnAfterRe',DEF_RE.HN_AFTER), HN_WEAK:re('review.hnWeakRe',DEF_RE.HN_WEAK),
  NEG_AFTER:re('review.negAfterRe',DEF_RE.NEG_AFTER), ADVISORY:re('review.advisoryRe',DEF_RE.ADVISORY),
  SELF_AFFIRM:re('review.selfAffirmRe',DEF_RE.SELF_AFFIRM), HIST_KEEP:re('review.histKeepRe',DEF_RE.HIST_KEEP),
  HYPOTH_RE:re('review.hypothRe',DEF_RE.HYPOTH_RE), CONTRAST_POS_RE:re('review.contrastPosRe',DEF_RE.CONTRAST_POS_RE), PLACEHOLDER_RE:re('review.placeholderRe',DEF_RE.PLACEHOLDER_RE),
  OLDITEM_RE:re('review.oldItemRe',DEF_RE.OLDITEM_RE), SWITCH_RE:re('review.switchRe',DEF_RE.SWITCH_RE), COND_AFTER:re('review.condAfterRe',DEF_RE.COND_AFTER)
 };
 _c={src:src,R:R};
 return R;
}
window.__AIS_REVIEW_RULES__=rules; // 供测试/诊断

function hardNegScan(t){var R0=rules();for(var i=0;i<R0.HARD_NEG.length;i++){var w=R0.HARD_NEG[i],ix=t.indexOf(w);if(ix<0)continue;var before=t.slice(Math.max(0,ix-8),ix);if(R0.HN_DENY.test(before))continue;var qBefore=t.slice(Math.max(0,ix-24),ix),qAfter=t.slice(ix+w.length,ix+w.length+32);if(R0.QUOTE_RE.test(qBefore)&&!R0.SELF_AFFIRM.test(qAfter))continue;var aft=t.slice(ix+w.length,ix+w.length+4);if(R0.HN_AFTER.test(aft))continue;var _s0=Math.max(0,ix-40),_seg=t.slice(_s0,Math.min(t.length,ix+w.length+48)),_wi=ix-_s0;if(isHypothetical(_seg,_wi,w.length))continue;if(hasContrastPositiveAfter(_seg,_wi))continue;if(isOtherItem(_seg,_wi))continue;if(isConditionalAfter(_seg,_wi,w.length))continue;var scope=t.slice(Math.max(0,ix-6),ix+w.length+6);var weak=R0.HN_WEAK.test(scope.replace(w,''));return {w:w,weak:weak};}return '';}
function clean(v){return String(v||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();}
function text(r){return clean(r&&r.content)+' '+clean(r&&r.appendContent);}
function rate(r){var n=parseInt(r&&r.rating,10);return n>=1&&n<=5?n:0;}
function splitSentences(t){return clean(t).split(/[。！？!？；;\n]/).filter(Boolean);}
function hasAny(t,words){for(var i=0;i<words.length;i++)if(t.indexOf(words[i])>=0)return words[i];return '';}
function positiveCount(t){var R0=rules(),n=0;for(var i=0;i<R0.POS.length;i++)if(t.indexOf(R0.POS[i])>=0)n++;return n;}
function contextFor(sentence,word){var i=sentence.indexOf(word);if(i<0)return sentence;return sentence.slice(Math.max(0,i-14),Math.min(sentence.length,i+word.length+16));}
function isNegated(ctx,word){var R0=rules();var i=ctx.indexOf(word);if(i<0)return false;var before=ctx.slice(Math.max(0,i-8),i);if(R0.NEGATE_RE.test(before)&&!/(?:别买|不要买|不推荐)/.test(ctx))return true;var after=ctx.slice(i+word.length);if(R0.NEG_AFTER.test(after))return true;return false;}
function isPositiveContext(sent){return rules().POSITIVE_CONTEXT_RE.test(sent);}
// v1.2.302：假设性担心豁免（『特别担心发货慢…结果第二天就发货』不该判负）
function isHypothetical(sent,wi,wl){var R0=rules();var before=sent.slice(Math.max(0,wi-8),wi);if(!R0.HYPOTH_RE.test(before))return false;var after=sent.slice(wi+wl,wi+wl+24);if(/(?:结果|果然|最后)[^。！？；;]{0,8}(?:慢|差|错|坏|没|未|不)/.test(after))return false;return true;}
// v1.2.302：转折后正面豁免（『…退了很多次了，但这次…很满意』不该判负）
function hasContrastPositiveAfter(sent,wi){var m=rules().CONTRAST_POS_RE.exec(sent);return !!(m&&m.index>wi);}
// v1.2.305：旧物豁免（『之前的线发烫，但用了这款不会』『前两根弄坏了』说的是别的东西）
function isOtherItem(sent,wi){var R0=rules();var pre=sent.slice(Math.max(0,wi-14),wi);if(R0.OLDITEM_RE.test(pre))return true;var sw=R0.SWITCH_RE.exec(sent);if(sw&&sw.index>wi&&R0.OLDITEM_RE.test(sent.slice(0,wi)))return true;return false;}
// v1.2.305：条件句豁免（『没电的时候不用带充电宝』不是在说产品缺陷）
function isConditionalAfter(sent,wi,wl){return rules().COND_AFTER.test(sent.slice(wi+wl,wi+wl+5));}
function isQuotedMention(sent,word){var R0=rules();var i=sent.indexOf(word);if(i<0)return false;var before=sent.slice(Math.max(0,i-24),i),after=sent.slice(i+word.length,i+word.length+32);return R0.QUOTE_RE.test(before)&&!R0.SELF_AFFIRM.test(after);}
function classify(r){
 var R0=rules();
 var t=text(r), ss=splitSentences(t), rating=rate(r), pos=positiveCount(t), score=(R0.RATING_SCORE[rating]||0), evidence=[], topics=[], advisory=[], hh=hardNegScan(t), hard=hh?hh.w:'', hardWeak=!!(hh&&hh.weak), wordScored={};
 if(hard){score+=hardWeak?R0.HARD_PEN_WEAK:R0.HARD_PEN;evidence.push(hard);}
 for(var ci=0;ci<R0.CATS.length;ci++){
  var cat=R0.CATS[ci], catHit=false, catAccepted=true, catScore=0, catNew=false;
  var softOnly=(cat.key==='size'&&!R0.SIZE_HARD_RE.test(t)&&!R0.COMPLAIN_CO.test(t));
  for(var wi=0;wi<cat.words.length;wi++){
   var word=cat.words[wi];
   for(var si=0;si<ss.length;si++)if(ss[si].indexOf(word)>=0){
    var sent=ss[si], ctx=contextFor(sent,word), wIx=sent.indexOf(word);
    if(isQuotedMention(sent,word))continue;
    if(R0.HIST_RE.test(ctx) && !R0.HIST_KEEP.test(sent.slice(wIx+word.length)))continue;
    if(isPositiveContext(sent))continue;
    if(R0.PRAISE_AFTER_RE.test(sent.slice(wIx+word.length,wIx+word.length+8)))continue;
    if(isNegated(ctx,word))continue;
    if(isHypothetical(sent,wIx,word.length))continue;
    if(hasContrastPositiveAfter(sent,wIx))continue;
    if(isOtherItem(sent,wIx))continue;
    if(isConditionalAfter(sent,wIx,word.length))continue;
    catHit=true;
    if(word==='挺宽'&&sent.charAt(wIx+2)==='松')continue;
var accepted=softOnly||acceptAfter(sent,wIx,word.length), uncertain=R0.UNCERTAIN_RE.test(ctx), repeated=R0.REPEAT_RE.test(ctx)&&!hard;
    if(!accepted){catAccepted=false;var _dup=wordScored[word];wordScored[word]=1;if(!_dup)catNew=true;catScore=Math.max(catScore,cat.base+(_dup?-cat.base:0)+(repeated?R0.REPEAT_BONUS:0)-(uncertain?R0.UNCERTAIN_PEN:0));evidence.push(word);}
    else if(R0.TIP_RE.test(ctx)&&!/(?:很少|不多|不明显)/.test(ctx))advisory.push(cat.key==='size'?'尺码建议':cat.name);
   }
  }
  if(catHit){
   if(!catAccepted){if(catNew)topics.push(cat.name);score+=catScore;}
   else if(cat.key==='size')advisory.push('尺码建议');
  }
 }
  if(R0.ADVISORY.test(t)) advisory.push('购买建议');
 if(!hard && evidence.length===0){
  for(var di=0;di<R0.DAMPEN.length;di++){var d=R0.DAMPEN[di];if(d&&pos>=d[0]&&score<=d[1]){score=0;break;}}
 }
 var unique=function(a){return a.filter(function(v,i){return a.indexOf(v)===i;});};
 evidence=unique(evidence).slice(0,R0.EVIDENCE_MAX);topics=unique(topics);advisory=unique(advisory);
 var level=score>=R0.LEVEL_HIGH?'high':(score>=R0.LEVEL_MED?'medium':(score>=R0.LEVEL_LOW?'low':'none'));
 return {score:score,level:level,evidence:evidence,topics:topics,advisory:advisory,positive:pos,rating:rating};
}
function keywords(rs){var f={},out=[];(rs||[]).forEach(function(r){(r.topics||[]).forEach(function(x){f[x]=(f[x]||0)+1;});});Object.keys(f).forEach(function(k){out.push({word:k,count:f[k]});});return out.sort(function(a,b){return b.count-a.count;});}
function analyze(rs){
 var R0=rules();
 rs=Array.isArray(rs)?rs:[];rs=rs.filter(function(r){return !R0.PLACEHOLDER_RE.test(String(r.content||''));});var d={1:0,2:0,3:0,4:0,5:0},sum=0,rated=0,img=0,append=0,sm={},tm={},neg=[],tips=[];
 rs.forEach(function(r){
  var n=rate(r);if(n){d[n]++;sum+=n;rated++;}if(r.hasImage)img++;if(r.isAppend)append++;
  var sku=String(r.skuInfo||'').trim()||'未指定SKU';sm[sku]=(sm[sku]||0)+1;
  var m=String(r.time||'').match(/(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})/);if(m){var day=m[1]+'-'+('0'+m[2]).slice(-2)+'-'+('0'+m[3]).slice(-2);tm[day]=(tm[day]||0)+1;}
  var c=classify(r);r.__sus={score:c.score,level:c.level,signals:c.evidence,topics:c.topics,advisory:c.advisory};
  if(c.score>=R0.NEG_CUT)neg.push(r); else if(c.score>=R0.TIP_CUT||c.advisory.length)tips.push({content:String(r.content||'').slice(0,200),skuInfo:r.skuInfo||'',time:r.time||'',topics:c.topics.length?c.topics:c.advisory,reasons:c.evidence,confidence:c.level||'low'});
 });
 neg.sort(function(a,b){return b.__sus.score-a.__sus.score;});
 var rows=neg.map(function(r){return{reviewId:r.reviewId||'',rating:rate(r),content:String(r.content||'').slice(0,200),skuInfo:r.skuInfo||'',time:r.time||'',username:r.username||'匿名',confidence:r.__sus.level,reasons:r.__sus.signals,topics:r.__sus.topics};});
 var bad=rows.length,ratePct=rs.length?Math.round(bad/rs.length*100):0;
 var bySku=Object.keys(sm).map(function(k){return{sku:k,count:sm[k]};}),byTime=Object.keys(tm).sort().map(function(k){return{date:k,count:tm[k]};});
 var topicRows=keywords(rows),risk=topicRows.map(function(x){return{word:x.word,count:x.count};});
 var tipsOut=tips.slice(0,R0.TIPS_MAX);
 return {total:rs.length,rated:rated,goodRate:rated?Math.round((d[4]+d[5])/rated*100):0,badRate:ratePct,avgRating:rated?(sum/rated).toFixed(1):'0',ratingDist:d,negativeCount:bad,negativeReviews:rows,purchaseTips:tipsOut,purchaseTipCount:tips.length,keywords:topicRows,topKeywords:topicRows.slice(0,8),bySku:bySku,skuDistribution:bySku,byTime:byTime,timeTrend:byTime,withImage:img,withImageRate:rs.length?Math.round(img/rs.length*100):0,appendCount:append,negativeAlert:{level:bad>=R0.ALERT_HIGH?'high':bad>=R0.ALERT_MED?'medium':bad?'low':'none',negativeCount:bad,negativeRate:ratePct,riskKeywords:risk,recentNegatives:rows.slice(0,10)},negativeKeywords:risk,negativeTopics:topicRows,negSuspectLevels:{high:neg.filter(function(r){return r.__sus.level==='high';}).length,medium:neg.filter(function(r){return r.__sus.level==='medium';}).length,low:neg.filter(function(r){return r.__sus.level==='low';}).length}};
}
function acceptAfter(sent,wi,wl){var R0=rules();var from=wi+wl,end=wi+wl+12,p=0;while(from+p<end){var seg=sent.slice(from+p,end);var ix=seg.search(R0.ACCEPT_RE);if(ix<0)return false;var abs=from+p+ix;if(R0.NEG_PRAISE_RE.test(sent.slice(abs-1,abs))){p+=ix+1;continue;}var pre=sent.slice(abs-2,abs);if(!R0.CONCESS_RE.test(pre))return true;p+=ix+1;}return false;}
window.__AIS_REV_STATS__={analyze:analyze,analyzeReviews:analyze,classifyReview:classify};
})();
