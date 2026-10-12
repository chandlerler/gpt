// ============================================================
// 锚点/规则注册表（v1.1.172 建，v1.2.258 扩展为「全平台可远程配置」）
// 目标：站点 DOM 改版时只改远程 anchor-rules.json（推 JSON），不发版扩展。
// 三层结构：
//   1. 内置默认（本文件 DEFAULTS，随扩展发布）
//   2. 远程覆盖（worker 的 aisAnchorRules 通道拉取 anchor-rules.json，24h 缓存）
//   3. 采集代码统一经 AisAnchors.sel/get/arr/num/norm 取值，禁止散落硬编码
// 取值器：
//   sel(path, fallback)  字符串选择器
//   get(path)            字符串（旧接口，非字符串返回 null）
//   raw(path)            任意类型原值
//   arr(path, fallback)  数组（选择器列表等）
//   num(path, fallback)  数字（尺寸门槛等）
//   norm(path, fbPairs)  URL 清洗链 -> [[RegExp, 替换串], ...]；远程正则非法时整体回落内置
// 远程值类型：字符串 / 数字 / 布尔 / 数组（数组整体替换，不逐项合并）/ null（禁用该键）
// 注意：normalize 类键默认为空数组 []，表示「不覆盖、用代码内置链」；远程给非空数组才生效。
// ============================================================
(function () {
  'use strict';
  if (window.AisAnchors) return;

  var DEFAULTS = {
    v: 2,
    common: {
      // 主图 DOM 兜底选择器列表（domFallbackMain）
      mainBox: ['#J_UlThumb img', '.PicGallery--thumbs img', '[class*="thumbnail"] img', '[class*="Thumb"] img', '[class*="gallery"] img', 'img[src*="alicdn.com/img/ibank"]'],
      // 背景图（CSS background-image）候选框 + 尺寸门槛
      bgBox: ['[class*="gallery"]', '[class*="Gallery"]', '[class*="media-view"]', '[class*="head-figure"]', '[class*="main-img"]', '[class*="preview-wrap"]'],
      bgMinPx: 200,
      // 详情图 DOM 兜底容器（domDescFallback）
      descBox: '#imageTextInfo-content, .desc-root, .descV8-container, .desc-v8wrap, #J_DivItemDesc, #desc-lazyload-area, [class*="detail-desc"], [class*="detailDesc"], [class*="offer-desc"], [class*="offerDesc"]',
      // 详情图 DOM 兜底：只收这些图床 + 噪声图排除
      descHosts: 'alicdn|imgextra|taobaocdn|tbcdn',
      // ---- v1.2.267 SKU 规格规则（可远程覆盖；API 字段路径属天花板，仍在代码）----
      skuGroupAny: '.sku-item-wrapper, .sku-item, .tm-sale-prop, .tb-prop, [class*=skuItem], [class*=sale-prop]',
      skuTitleAny: '[class*=title], .tb-property-type, .tm-propTit',
      skuValueAny: 'li, span[class*=value], a',
      skuValueMaxLen: 30,
      skuGroupMax: 4,
      skuNameFallback: '规格',
      skuNameSep: '-',
      skuSizeRe: '尺码|尺寸|码数',
      skuLdJson: 'script[type="application/ld+json"]',
      skuLdMinValues: 2,
      // v1.2.263：详情图未出来前的常驻提示文案（可远程覆盖）
      descLoadingText: '详情图正在加载中…',
      descMissingText: '暂未采集到详情图，可点「重新读取」',
      // v1.2.314：详情图自适应兜底阈值（远程可调，不发版）
      descAdaptiveMinEdge: 300,
      descAdaptiveTopRatio: 0.45,
      // v1.2.313：销量提取（远程可覆盖，数组整体替换）——选择器与文案正则均可不发版更新
      salesSelectors: [
        '[class*="month-sale"]', '[class*="realSales"]', '[class*="salesCount"]', '[class*="soldQuantity"]', '[class*="Sales--"]',
        '[class*="sale-quantity"]', '[class*="deal-count"]', '[class*="sold-count"]', '[class*="saleInfo"]', '[class*="sale-info"]', '[class*="transaction"]',
        '[class*="_commit"] strong', '.p-commit strong', '[class*="salesTip"]', '[class*="sales-tip"]',
        '#comment-count', '.J-sale-num', '[class*="sale-num"]', '[class*="sales-num"]', '[class*="sales"]', '[class*="sold"]'
      ],
      salesPatterns: [
        '月销\\s*([0-9][0-9.,]*\\s*[万千百]?\\+?)',
        '已售\\s*([0-9][0-9.,]*\\s*[万千百]?\\+?)',
        '([0-9][0-9.,]*\\s*[万千百]?\\+?)\\s*人付款',
        '([0-9][0-9.,]*\\s*[万千百]?\\+?)\\s*人已购',
        '累计销量\\s*[:：]?\\s*([0-9][0-9.,]*\\s*[万千百]?\\+?)',
        '近\\s*30\\s*天成交\\s*[:：]?\\s*([0-9][0-9.,]*\\s*[万千百]?\\+?)',
        '成交\\s*[:：]?\\s*([0-9][0-9.,]*\\s*[万千百]?\\+?)',
        '([0-9][0-9.,]*\\s*[万千百]?\\+?)\\s*(?:笔|件)?成交',
        '已拼\\s*([0-9][0-9.,]*\\s*[万千百]?\\+?)',
        '销量\\s*[:：]?\\s*([0-9][0-9.,]*\\s*[万千百]?\\+?)'
      ],
      // v1.2.274：上架包「导入说明」文案（可远程覆盖；数组整体替换）
      listingHelp: [
        'Sheet 说明：商品信息 = 单商品主档；SKU明细 = 多规格行（规格名与规格值成对）；图片清单 = 与「素材包」ZIP 内文件名完全一致。',
        '必填但本工具采不到的字段：叶子类目（请按目标平台自行选择）、物流模板、宝贝描述模板 —— 需在 ERP / 平台内补齐。',
        '图片：清单里的「文件名」对应素材包 ZIP 内的相对路径；要直接填 URL 就用「图片URL」列（部分平台要求图片先上传到自有图片空间）。',
        '数据来自公开商品页，请遵守目标平台服务条款，仅用于个人研究或合法经营用途。'
      ],
      // v1.2.275 全远程文案（纯数据，商店合规）：三个键都用「数组存对」——数组整体替换，
      // 绕开 deepMerge 对未声明子键的忽略，因此新增条目无需再改代码。
      //   texts      : [[原文, 新文案], ...]      固定文案（toast / 状态 / 说明等）整体替换
      //   textRules  : [[正则, 替换串], ...]      含变量的动态文案（$1 取捕获组）
      //   labelTexts : [[元素id, 新文案], ...]    面板静态标签（只替换首个文本节点，计数 span 不受影响）
      texts: [],
      textRules: [],
      labelTexts: [],
      // v1.2.276 行为参数层（同样「数组存对」，新增条目无需改代码）：
      //   fieldAliases : [[组名, [额外别名...]], ...]  接口字段别名追加（平台改字段名不用发版）
      //   timings      : [[名称, 数字], ...]           节奏/超时/步长等数值参数
      //   flags        : [[名称, true/false], ...]     功能开关（灰度/紧急关闭）
      fieldAliases: [],
      timings: [],
      // v1.2.298 平台白名单（可远程改；不在名单内的平台【完全不注入面板、不采集】）
      flags: [
        ['plat.taobao', true], ['plat.tmall', true], ['plat.1688', true], ['plat.pdd', true],
        ['plat.jd', false], ['plat.amazon', false], ['plat.alibabaIntl', false]
      ],
      //   textPrefixes : [[旧前缀, 新前缀], ...]      动态文案前缀替换（零正则开销，如「规则更新失败：」+原因）
      //   colTitles    : [[原表头, 新表头], ...]      导出表格列名替换（改列名不用发版）
      textPrefixes: [],
      colTitles: [],
      // v1.2.280 以图搜货地址模板：[['1688','https://…{url}']]；{url}=已编码图片地址，{raw}=原样地址
      imgSearchUrls: [['1688', 'https://s.1688.com/youyuan/index.htm?tab=imageSearch&imageAddress={url}']],
      // v1.2.281 快捷键默认值（用户可在「更多 → 快捷键设置」里本地改；远程可改默认）：[['动作','组合键']]
      shortcuts: [['togglePanel', 'Alt+S'], ['scan', 'Alt+A'], ['manual', 'Alt+M'], ['start', 'Alt+Enter'], ['close', 'Escape']],
      // v1.2.281 帮助中心内容（数组存对：[[标题,[行...]], ...]，可远程更新；支持 {平台} 之类无需替换，纯文本）
      helpSections: [
        ['快速上手（3 步）', ['1) 打开商品详情页 → 点右下角悬浮球展开面板', '2) 面板自动读取：主图 / SKU图 / 详情图 / 视频 / SKU规格 / 商品参数', '3) 勾选要的图 → 底部「下载」；或用「复制」拿到结构化链接（主图 / SKU图规格配对 / 详情图）']],
        ['采集不到图片 / 数量变少', ['· 先点面板底部「立即更新规则」——平台改版后我们通常已远程推好新规则，不用等扩展升级', '· 再点「重新读取」；仍不行请刷新页面重试一次', '· 京东详情图是滚动懒加载，面板会自动滚到底再收图，请勿中途关页']],
        ['SKU 图是空的', ['· 部分商品本身没有 SKU 图（只有文字规格），此时为空属正常', '· 确保停留在「SKU采集」页并等采集完成（进度条走完）', '· 天猫/淘宝的 SKU 图来自接口，若平台改动接口字段名，我们会远程加别名修复']],
        ['评论采集失败 / 条数少', ['· 未登录时平台只放少量评论，建议先登录账号', '· 评论按所选页数采集，实际数量受平台可访问范围影响', '· 「问大家」与全部回答走独立通道，勾选后才采集']],
        ['下载没反应 / 找不到文件', ['· 浏览器默认下载目录里找（可点面板「打开下载目录」按钮）', '· 勾了「下载为 ZIP」会得到压缩包，取消勾选则直接下原图', '· 若浏览器提示拦截弹窗/下载，请允许本站']],
        ['格式与画质', ['· 支持输出 JPG / PNG / WEBP / AVIF / JFIF，可设质量与缩放比例', '· 选「原始格式」即直接下平台原图，不压缩']],
        ['以图搜货（找同款货源）', ['· 在图片页勾选一张图（不勾选则用第一张主图）→ 点「以图搜货」', '· 会用该图打开 1688 以图搜索，方便找同款与货源']],
        ['联系与反馈', ['· 面板内「更多」里有反馈入口；也可在上架页留言', '· 反馈请附商品链接 + 截图，我们能直接复现']]
      ],
      noiseUrl: 'thumbnail|avatar|logo|icon|sprite',
      normalize: []
    },
    jd: {
      // SKU 规格选项（新版 .specification-item-sku；旧版兜底见调用点）
      skuItem: '.specification-item-sku',
      skuItemAny: '[class*="specification-item-sku"]',
      specGroup: '.page-right-spec, [class*="page-right-spec"]',
      // 商品标题
      title: '.itemInfo .sku-name, .product-intro .sku-name, [class*=sku-name], [class*="skuname"], [class*="sku-title"]',
      // 详情容器正选集（v1.2.249 并入搞图宝实测容器；v1.2.251 确认真容器为 #detail-main）
      descBox: 'img.shop-editor-floor, #detail-main img, .ssd-module-wrap img, .ssd-module img, #detail .content img, .detail-content img, #J-detail-content img, #shadowHost img, .wdis-content img',
      // 父级判定（closest 用，必须与 descBox 同步）
      descBoxParent: '#detail-main, .ssd-module-wrap, .ssd-module, #detail .content, .detail-content, #J-detail-content, #shadowHost, .wdis-content',
      // 详情图「背景图」候选框（v1.2.254：JD 新版详情模块用 CSS background-image 而非 <img>）
      descBgBox: '#detail-main *, .ssd-module-wrap *, [class*="ssd-module"] *, [id*="detail-main"] *, #J-detail-content *, #shadowHost *, .wdis-content *',
      // 主锚点（v1.2.251 纠正：原值 jdmccBagWrap 实为福袋营销组件）
      descBag: '#detail-main img, [id*="detail-main"] img',
      // 命名族兜底（v1.2.251：去掉 elevator 族——那是楼层导航/魔方装修）
      descFloor: '[id*="detail"] img, [class*="detail"] img',
      // 排除区（装修/福袋/连续推荐/搭配/榜单）
      descExclude: '[class*="jdmcc"], [class*="continuous-product"], [class*="recommend"], [class*="Recommend"], [class*="similar"], [class*="expert-selection"], #waist-root, [class*="waist"], [class*="elevator"], [class*="Elevator"]',
      // 详情 tab（新版详情内容在「商品详情」tab 内懒挂载，采集前先激活）
      descTab: '[class*="left-tabs-item"], [class*="tab-item"], [role="tab"]',
      descTabText: '商品详情',
      // SKU 规格色卡图
      specImg: '.page-right-spec img, [class*="specification"] img, [class*="specification-item-sku"] img',
      // v1.2.267：规格组标题 / 规格项容器（detail-collector 的 JD SKU 提取用）
      skuTitle: '[class*="title"], [class*="Title"]',
      specGroupItem: '.specification-group',
      // ===== v1.2.460/461 京东 SKU 取值通道 =====
      // 【重要】注册表是「未知键直接忽略」，所以新增远程键**必须在这里声明**，只写 anchor-rules.json 是无效的。
      // ① pageConfig 通道（v1.2.460 移植电商宝 panel.js:2926）：部分京东页面 product 里带 colorSize/skus
      pcSku: 'on',
      pcObj: 'pageConfig',
      pcProduct: 'product',
      pcColorSize: 'colorSize',
      pcSkus: 'skus',
      // ② DOM 规格区通道（v1.2.461）：真机实测 item.jd.com/10193206821242 上 pageConfig.product 只有
      //    colorApiDomain/chooseLOCShop（无 SKU），27 条接口响应里也没有 SKU —— 规格数据只在 DOM：
      //    .specification-item-sku ×16，父容器 .specification-group-content。
      domSku: 'on',
      skuGroupTitle: '[class*="group-label"], [class*="Label"], [class*="label"], [class*="title"], [class*="Title"], [class*="name"]',
      skuMinPx: 32,
      // 主图画廊
      gallery: '.image-carousel.vertical.thumbnails img, .preview-wrap .main-img img, img#spec-img',
      galleryAlt: '.preview-wrap img.image',
      // 排除域/容器（推荐卡、图标）
      excludeBox: '[class*="recommend"]',
      excludeAnchor: 'a[href*="item.jd.com"], a[href*="//item.jd"], a[href*="npcitem.jd"], [class*="recommend"]',
      iconDomain: '/imagetools/',
      // 尺寸门槛（v1.2.258：由字符串改数字，可远程覆盖）
      minW: 300, minH: 200, bagMinPx: 250, bgMinW: 300, bgMinH: 200,
      // v1.2.259：SKU 色卡最小尺寸——规格容器里常混入 avif 超小图（占位/图标），低于此值不采集
      skuMinPx: 32,
      // 详情容器扫描上限（防超长页面退化）
      bgScanMax: 400,
      // URL 清洗链（空 = 用代码内置链；远程给 [[正则,替换,flags?],...] 才生效）
      normalize: [],
      // 价格
      price: '.price, .J-p-{itemId}, [class*=price]'
    },
    tb: {
      skuGroup: '.sku-item-wrapper, .sku-item, .tm-sale-prop, .tb-prop',
      propVal: '[data-value-id]',
      title: '[class*=ItemHeader--title], .tb-detail-hd h1, [class*=mainTitle]',
      price: '[class*=Price]:not([class*=PriceInt]), .tb-rmb, .tm-price, [class*=price]',
      desc: '#J_DivItemDesc, #description, [class*="descV8"], [class*="Description--"], [class*="detail--"]'
    },
    ali: {
      // 1688 / 阿里巴巴 / alicdn 系（TB 共用同一套原图还原链）。
      // 值取自 a1688DomFallback 真实使用的选择器/域名过滤。
      gallery: '.ant-image-img.preview-img',
      skuImg: '.module-od-sku-selection img.ant-image-img',
      mainHost: 'ibank|cbu01',
      normalize: []
    },
    review: {
      // ===== v1.2.259 评论风控规则：数据与阈值可远程覆盖；扫描/豁免/分层算法仍在 lib/review-stats.js =====
      pos: ["推荐","回购","满意","喜欢","舒服","不错","很好","好评","值得","性价比","合适","好看","物美价廉","划算","显瘦","质量好","质量不错","质量很好","非常满意","挺满意","物超所值","很值","没问题"],
      hardNeg: ["差评","不满意","很差","太差","失望","不推荐","垃圾","退款","退货","别买","慎入","踩雷","劝退","被骗","后悔","避坑","质量差","质量问题","质量不行","货不对板","假货","破损","坏了","无法使用","售后不处理","拒绝退款","虚假宣传"],
      cats: [{"key":"quality","name":"质量/做工","words":["掉色","褪色","染色","脱色","脱线","开线","跳线","开裂","开叉","破损","破洞","瑕疵","起球","缩水","缩小","变形","勾丝","抽丝","断裂","断带","脱胶","开胶","掉毛","粘毛","勾破","松垮","发黄","污渍","脏污","异味","臭味","霉味","粗糙","线头","线迹差","做工差","做工粗","面料差","材质差","质量一般","质量差","廉价感","穿几次就坏","用几天就坏","不耐穿","不结实","容易坏","一洗就坏","洗一次就坏"],"base":2},{"key":"size","name":"尺码/版型","words":["偏大","偏小","太大","太小","太紧","太松","太长","太短","不合身","版型差","版型不好","显胖","显臃肿","肥大","偏肥","偏瘦","勒","卡裆","裆部不舒服","腰围小","腰围大","领口紧","袖子短","裤长短","肩宽","往下滑","穿不上","穿不下","宽了","挺宽","松垮","塌肩","肩膀窄","胸围小","胸围大","长度不够","长度太长"],"base":1},{"key":"transparency","name":"透肤/防晒","words":["透肤","透光","太透","透内搭","透出来","太薄","薄透","太厚","厚重","闷","闷热","不透气","粘身","扎皮肤","扎人","刺痒","不亲肤","掉渣","起静电","防晒效果差","不防晒","保暖差","不挡风"],"base":2},{"key":"color","name":"颜色/色差","words":["色差","颜色不对","颜色奇怪","偏色","颜色不一样","颜色深","颜色浅","偏黄","偏红","偏绿","偏暗","偏亮","发白","色不正","色号偏白","色号偏深","实物颜色差","显旧","颜色失真","染色严重","串色"],"base":2},{"key":"function","name":"功能/安全","words":["无法使用","不能使用","不能开机","开不了机","死机","闪退","断连","连接不上","充不上电","充电异常","耗电快","续航短","续航虚标","发烫","发热严重","漏电","漏水","漏液","烫手","失灵","卡住","卡顿","噪音大","异响","不工作","无法安装","安装失败","灵敏度差","影响使用","虚标","没电","自动关机","反应慢","功能失效","按键失灵","屏幕异常","信号差","网络不稳"],"base":4},{"key":"health","name":"健康/食品安全","words":["过敏","刺痛","发红","红肿","瘙痒","刺痒","掉渣","异物","虫","虫子","变质","发霉","临期","变味","异味","刺激","刺激性气味","不卫生","肚子疼","腹泻","恶心","膨包","漏气","生虫","有毛发","有杂质","吃坏肚子"],"base":5},{"key":"logistics","name":"物流/售后","words":["发货慢","发货太慢","延迟发货","物流慢","物流很慢","物流太慢","物流停滞","物流不动","快递慢","快递太慢","等了一个星期","等了很久","快递丢失","延误","漏发","少发","少件","缺件","发错","包裹破损","包装破损","客服态度差","客服不处理","客服不回复","客服不理","不回复","售后不处理","售后拖延","拒绝售后","拒绝退款","拒绝补发","价保纠纷","推诿","推卸责任","无人处理","不解决","踢皮球","敷衍","态度恶劣"],"base":3},{"key":"description","name":"描述不符","words":["描述不符","与描述不符","图片不符","实物不符","实物与图片","和图片不一样","严重不符","货不对版","货不对样","参数不符","规格不符","颜色与图片","图片美化","与实物差距大","虚假宣传","虚标容量","尺寸不符","材质不符","功能与描述不符","宣传不实"],"base":4}],
      // ---- 计分与分级阈值 ----
      ratingScore: [0, 6, 5, 1, 0, 0],
      hardPen: 4, hardPenWeak: 3, repeatBonus: 3, uncertainPen: 1,
      dampen: [[3, 9], [2, 5], [1, 3]],
      levelHigh: 7, levelMedium: 4, levelLow: 2,
      negCut: 4, tipCut: 1, evidenceMax: 4, tipsMax: 20,
      alertHigh: 5, alertMed: 3,
      // ---- 正则覆盖（空串=用代码内置正则字面量；给字符串则编译覆盖，非法则回落）----
      acceptRe: '', tipRe: '', uncertainRe: '', quoteRe: '', histRe: '', praiseAfterRe: '',
      positiveCtxRe: '', sizeHardRe: '', complainRe: '', negateRe: '', repeatRe: '',
      concessRe: '', negPraiseRe: '', hnDenyRe: '', hnAfterRe: '', hnWeakRe: '',
      negAfterRe: '', advisoryRe: '', selfAffirmRe: '', histKeepRe: ''
    },
    amazon: {
      // v1.2.284 亚马逊：图片优先读官方载荷（ImageBlockATF/BTF，由 lib/amazon.js 解析），以下为 DOM 兜底与过滤
      enabled: true,
      gallery: '#imageBlock, #imageBlock_feature_div, #main-image-container, #imgTagWrapperId',
      aplus: '#aplus, #aplus_feature_div, .aplus-v2, #aplus3p_feature_div',
      imgHostRe: 'media-amazon\\.com|ssl-images-amazon\\.com|images-amazon\\.com',
      videoHosts: 'media-amazon\\.com|images-amazon\\.com',
      noiseUrl: 'sprite|icon|logo|loading|grey-pixel|transparent-pixel|play-icon|badge|star',
      minPx: 200,
      directVideoOnly: true,   // 只收可直接下载的视频（亚马逊有 HLS .m3u8 播放列表，当 mp4 存会得到 699 字节文本）
      detailMinEdge: 500       // v1.2.288 详情图(A+)判据阈值：URL 声明宽与渲染长边取大者需 ≥ 此值（可远程调）
    },
    pdd: {
      // 拼多多：class 无关的特征探测，代码实际只读尺寸门槛（文字分界仍是硬编码，待接线）
      minW: 200, minH: 160
    }
  };

  var cur = JSON.parse(JSON.stringify(DEFAULTS));

  // 深合并远程规则。三条安全约束（远程推错也不会炸）：
  //   1) 未知键直接忽略（防拼错、防注入新键）
  //   2) 类型必须与默认值一致（字符串/数字/布尔/数组），否则忽略
  //   3) null 表示显式禁用该键
  function deepMerge(dst, src) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) return dst;
    Object.keys(src).forEach(function (k) {
      var v = src[k];
      // v1.2.358：允许远程【新增键】——原实现 `if (!(k in dst)) return;` 会把远端新增的规则键**静默丢弃**，
      // 这正是「远端改了却不生效」的根源（sizeFilterExempt / harvestMode / noiseUrl / platformHosts / wdj* 等全被丢）。
      // 安全性：远端只能下发**纯数据**（MV3 禁远程代码），新增键为惰性数据，无执行风险。
      if (!(k in dst)) {
        if (v === null) return;
        if (Array.isArray(v)) { dst[k] = v.slice(); return; }
        if (v && typeof v === 'object') { dst[k] = {}; deepMerge(dst[k], v); return; }
        dst[k] = v;                                                  // string / number / boolean
        return;
      }
      var d = dst[k];
      if (v === null) { delete dst[k]; return; }                    // 显式禁用
      if (Array.isArray(v)) { if (Array.isArray(d)) dst[k] = v.slice(); return; }  // 数组整体替换
      if (v && typeof v === 'object') { if (d && typeof d === 'object' && !Array.isArray(d)) deepMerge(d, v); return; }
      if (typeof v !== typeof d) return;                            // 类型不符：忽略
      if (typeof v === 'string') { if (v.length) dst[k] = v; return; }
      dst[k] = v;                                                   // number / boolean
    });
    return dst;
  }

  function rawAt(path) {
    try {
      var parts = String(path || '').split('.');
      var node = cur;
      for (var i = 0; i < parts.length; i++) {
        node = node[parts[i]];
        if (node === undefined || node === null) return null;
      }
      return node;
    } catch (e) { return null; }
  }

  // 把 [[pattern, replacement, flags?], ...] 编译成 [[RegExp, 替换串], ...]；任一非法则返回 null（调用方回落内置）
  function compilePairs(pairs) {
    if (!Array.isArray(pairs)) return null;
    var out = [];
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      if (!p || p.length < 2) return null;
      try { out.push([(p[0] instanceof RegExp) ? p[0] : new RegExp(String(p[0]), String(p[2] || '')), String(p[1])]); }
      catch (e) { return null; }
    }
    return out;
  }

  var api = {
    source: 'bundled',
    /** 取选择器：注册表命中用注册表，否则用调用点内置字面量兜底 */
    sel: function (path, fallback) {
      var v = rawAt(path);
      return (typeof v === 'string' && v.length) ? v : (fallback || '');
    },
    /** 旧接口：只取字符串 */
    get: function (path) { var v = rawAt(path); return typeof v === 'string' ? v : null; },
    /** 任意类型原值 */
    raw: function (path) { return rawAt(path); },
    /** 数组规则（如选择器列表）；非数组时用兜底 */
    arr: function (path, fallback) { var v = rawAt(path); return Array.isArray(v) ? v.slice() : (Array.isArray(fallback) ? fallback.slice() : []); },
    /** 数字规则（尺寸门槛等）；非数字时用兜底 */
    num: function (path, fallback) { var v = rawAt(path); if (typeof v === 'number' && isFinite(v)) return v; return (typeof fallback === 'number' && isFinite(fallback)) ? fallback : 0; },
    /** 布尔规则 */
    bool: function (path, fallback) { var v = rawAt(path); return typeof v === 'boolean' ? v : !!fallback; },
    // ---- v1.2.276 行为参数层取值器（数组存对 → 按名称查；取不到回落内置）----
    alias: function (group, fallback) {
      var out = [];
      try {
        var list = rawAt('common.fieldAliases');
        if (Array.isArray(list)) list.forEach(function (p) { if (p && p[0] === group && Array.isArray(p[1])) out = p[1].slice(); });
      } catch (e) {}
      if (out.length) return out;
      return Array.isArray(fallback) ? fallback.slice() : [];
    },
    tune: function (name, fallback) {
      try {
        var list = rawAt('common.timings');
        if (Array.isArray(list)) { var hit = null; list.forEach(function (p) { if (p && p[0] === name) hit = p[1]; }); if (typeof hit === 'number' && isFinite(hit)) return hit; }
      } catch (e) {}
      return typeof fallback === 'number' ? fallback : 0;
    },
    flag: function (name, fallback) {
      try {
        var list = rawAt('common.flags');
        if (Array.isArray(list)) { var hit = null; list.forEach(function (p) { if (p && p[0] === name) hit = p[1]; }); if (typeof hit === 'boolean') return hit; }
      } catch (e) {}
      return !!fallback;
    },
    /** URL 清洗链：远程给了合法数组就用远程，否则用调用方内置链 */
    norm: function (path, fallbackPairs) {
      var remote = null;
      try { remote = compilePairs(rawAt(path)); } catch (e) { remote = null; }
      if (remote && remote.length) return remote;
      var fb = null;
      try { fb = compilePairs(fallbackPairs); } catch (e) { fb = null; }
      return fb || [];
    },
    /** v1.2.264：立即检查规则更新（force 默认 true → 绕过 worker 侧 24h 缓存）。
     *  返回 Promise<{ok, v, source, error}>；成功时已就地 merge。 */
    refresh: function (force) {
      return new Promise(function (resolve) {
        try {
          if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) { resolve({ ok: false, error: '无扩展环境' }); return; }
          chrome.runtime.sendMessage({ type: 'aisAnchorRules', action: 'aisAnchorRules', force: (force === undefined ? true : !!force) }, function (resp) {
            try { void chrome.runtime.lastError; } catch (eLE) {}
            try {
              if (resp && resp.ok && resp.rules) {
                api.merge(resp.rules);
                try { document.dispatchEvent(new CustomEvent('cfg:sync')); } catch (e2) {}
                resolve({ ok: true, v: resp.v || (resp.rules && resp.rules.v) || 0, source: resp.source || '', error: resp.error || '', errors: resp.errors || [], stale: !!resp.stale });
              } else {
                resolve({ ok: false, error: (resp && resp.error) || '未取到远程规则（沿用内置默认）' });
              }
            } catch (e) { resolve({ ok: false, error: (e && e.message) || String(e) }); }
          });
        } catch (e) { resolve({ ok: false, error: (e && e.message) || String(e) }); }
      });
    },
    /** 应用远程规则覆盖 */
    merge: function (rules) {
      try {
        if (!rules || typeof rules !== 'object') return false;
        deepMerge(cur, rules);
        api.source = (rules.v ? 'remote v' + rules.v : 'remote');
        return true;
      } catch (e) { return false; }
    },
    reset: function () { cur = JSON.parse(JSON.stringify(DEFAULTS)); api.source = 'bundled'; },
    snapshot: function () { return JSON.parse(JSON.stringify(cur)); },
    // 供测试/诊断：暴露当前版本的键类型清单
    types: function () {
      var t = {};
      ['common', 'jd', 'tb', 'ali', 'pdd', 'dy'].forEach(function (p) {
        if (!cur[p]) return;
        Object.keys(cur[p]).forEach(function (k) {
          var v = cur[p][k];
          t[p + '.' + k] = Array.isArray(v) ? 'array' : typeof v;
        });
      });
      return t;
    }
  };

  window.AisAnchors = api;

  // ===== v1.2.298 平台白名单（纯数据判定，主开关走远程 common.flags）=====
  // 设计要点：manifest 的 matches 保持宽（覆盖全部平台），判定放在运行时 ——
  // 这样「隐藏/放开某平台」只需改 anchor-rules.json 并点面板「立即更新规则」，无需发版。
  // v1.2.299 平台基线（代码内，不会被远端空数组抹掉）：只保留阿里系 + 拼多多
  // v1.2.324：加入 plat.jd —— 用户反馈京东商品页不出按钮图标，根因即基线+远端 flags 双双排除京东。
  var PLAT_KEEP = { 'plat.taobao': 1, 'plat.tmall': 1, 'plat.1688': 1, 'plat.pdd': 1, 'plat.jd': 1, 'plat.amazon': 1 };   // v1.2.346：放开亚马逊（规则 amazon 段配置齐全；基线优先，远端 false 不再覆盖）
  var PLAT_RULES = [
    { key: 'plat.taobao',      hosts: ['taobao.com', 'tmall.com'] },
    { key: 'plat.1688',        hosts: ['1688.com'] },
    { key: 'plat.alibabaIntl', hosts: ['alibaba.com'] },
    { key: 'plat.pdd',         hosts: ['pinduoduo.com', 'yangkeduo.com'] },
    { key: 'plat.jd',          hosts: ['jd.com', '3.cn', 'jdcloud.com'] },
    { key: 'plat.amazon',      hosts: ['amazon.*'] }
  ];
  function hostHit(host, pat) {
    host = String(host || '').toLowerCase(); if (!host) return false;
    if (pat === 'amazon.*') return /(^|\.)amazon\.[a-z.]{2,}$/.test(host) || /(^|\.)amzn\.com$/.test(host);
    if (pat === '3.cn') return host === '3.cn' || host.slice(-5) === '.3.cn';
    return host === pat || host.slice(-(pat.length + 1)) === '.' + pat;
  }
  api.platformOf = function (host) {
    try {
      for (var i = 0; i < PLAT_RULES.length; i++) {
        for (var j = 0; j < PLAT_RULES[i].hosts.length; j++) if (hostHit(host, PLAT_RULES[i].hosts[j])) return PLAT_RULES[i].key;
      }
    } catch (e) {}
    return '';
  };
  api.platAllowed = function (host) {
    try {
      var key = api.platformOf(host);
      if (!key) return true;                  // 不在名单规则里的站点：保持原有行为（不误伤）
      // v1.2.299 关键修正：基线【写在代码里】，不用 DEFAULTS.common.flags ——
      // deepMerge 对数组是整体替换，旧版远端 JSON 里的 flags:[] 会把默认值抹成空；
      // 若此处再 fail-closed，保留的平台（淘宝/1688/拼多多）会被一起误封 → 全量用户丢面板。
      //
      // v1.2.325 关键修正：**基线内平台直接放行，不受远端 flags 影响**。
      //   旧逻辑 var base=!!PLAT_KEEP[key]; var v=api.flag(key,base); return v!==false;
      //   有一个致命顺序问题：远端【显式 false】会覆盖基线 true，而 worker 的规则缓存 TTL 是 24h，
      //   于是「基线已把京东打开」但用户端仍缓存着旧规则（v19 里 plat.jd=false）→ 京东整站不注入面板、
      //   不出悬浮按钮，且用户无从自救（面板本身没出来，点不到「立即更新规则」）。
      //   现在：基线保留的平台（淘宝/天猫/1688/拼多多/京东）恒为 true，远端只能影响名单外平台。
      if (PLAT_KEEP[key]) return true;
      var base = false;                         // 名单外平台默认关闭，可由远端显式打开
      var v = api.flag(key, base);              // 远端可显式覆盖；缺省回落基线
      return v !== false;                       // 只有【显式 false】才拦（fail-open）
    } catch (e) { return true; }
  };
  window.AisPlatforms = { of: api.platformOf, allowed: api.platAllowed, rules: PLAT_RULES };

  // v1.2.338：接收 worker 广播的规则更新——已打开页面即时 merge 并派发 cfg:sync（无需刷新页面/更新插件）
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg) {
        try {
          if (!msg || !msg.rules || (msg.action !== 'aisRulesUpdated' && msg.type !== 'aisRulesUpdated')) return;
          api.merge(msg.rules);
          try { document.dispatchEvent(new CustomEvent('cfg:sync')); } catch (e2) {}
        } catch (e1) {}
      });
    }
  } catch (e0) {}

  // v1.2.349：消除启动竞态——扩展刚重载/worker 未就绪时，上面的 sendMessage 会失败并静默退回【内置默认】，
  // 于是远程规则（选择器/阈值）整层失效（真机实测：线上已下发 v26，但页面拿到的 mainBox 仍是 6 条内置默认值）。
  // 内容脚本本身就能读 chrome.storage，这里直接取缓存并合并；版本更高/相等才覆盖，避免降级。
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['aisAnchorRulesCache'], function (o) {
        try {
          var c = o && o.aisAnchorRulesCache;
          if (!c || !c.rules || !Number(c.rules.v)) return;
          var cur = api.snapshot ? api.snapshot() : null;
          var curV = cur && Number(cur.v) || 0;
          if (Number(c.rules.v) >= curV) {
            api.merge(c.rules);
            try { document.dispatchEvent(new CustomEvent('cfg:sync')); } catch (e2) {}
            console.log('[电商采集大师] 规则从本地缓存直读并合并 v' + c.rules.v);
          }
        } catch (e1) {}
      });
    }
  } catch (e0) {}

  // v1.2.404：启动自愈——首次没拿到远程规则（仍 bundled）时定时重试，最多 6 次 / 每次 60s。
  // 场景：扩展刚重载或浏览器冷启动，worker 还没把规则写进 storage，此前会一直沿用内置默认直到下次刷新。
  // 这样「服务器改了规则」不需要用户做任何操作：worker 自动拉 → 本页自动合并 → 界面就地更新。
  try {
    if (api.source === 'bundled') {
      var __aisRulesTry = 0;
      var __aisRulesTimer = setInterval(function () {
        __aisRulesTry++;
        if (api.source !== 'bundled' || __aisRulesTry > 6) { try { clearInterval(__aisRulesTimer); } catch (eC) {} return; }
        try { api.refresh(false); } catch (eR) {}
      }, 60000);
    }
  } catch (eRT) {}

  // 向 worker 请求远程规则覆盖（缓存优先，worker 侧 24h TTL；失败静默用内置默认）
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'aisAnchorRules', action: 'aisAnchorRules' }, function (resp) {
        try {
          if (resp && resp.ok && resp.rules) {
            api.merge(resp.rules);
            try { document.dispatchEvent(new CustomEvent('cfg:sync')); } catch (e2) {}
          }
        } catch (e) {}
      });
    }
  } catch (e) {}
})();
