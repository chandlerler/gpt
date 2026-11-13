import { inspectPage } from './lib/extract.js';
import { newTask, settingsOf, shopUrl, itemUrl, allowedUrl, sameShop, addLinks, log, productBelongs } from './lib/core.js';

const KEY='task', ALARM='shop-sku-tick';
let serial=Promise.resolve(), timer;
const exclusive = fn => { const next=serial.then(fn,fn); serial=next.catch(()=>{}); return next; };
const read = async () => (await chrome.storage.local.get(KEY))[KEY] || newTask();
async function save(task) { task.updatedAt=new Date().toISOString(); await chrome.storage.local.set({[KEY]:task}); }
function schedule(ms=1000) { clearTimeout(timer); timer=setTimeout(()=>exclusive(tick).catch(reportError),ms); }
async function reportError(error) {
  const task=await read(); task.status='paused'; task.pauseReason=String(error?.message || error); log(task,task.pauseReason,'error'); await save(task);
}
async function pause(task,reason) { task.status='paused'; task.pauseReason=reason; log(task,reason,'warn'); await save(task); }
async function ensureWorker(task,url) {
  if (!allowedUrl(url)) throw new Error('采集地址必须是淘宝或天猫的 HTTPS 页面。');
  if (task.workerTabId !== null) {
    try { await chrome.tabs.get(task.workerTabId); await chrome.tabs.update(task.workerTabId,{url}); return; } catch { task.workerTabId=null; }
  }
  const tab=await chrome.tabs.create({url,active:false}); task.workerTabId=tab.id;
}
async function navigate(task,url,kind) {
  // Persist intent before navigating, so a suspended worker can safely repeat it.
  task.cursor={url,kind,stage:'navigate',started:Date.now(),attempts:0,scrolls:0};
  await save(task); await ensureWorker(task,url); task.cursor.stage='loading'; task.cursor.readyAt=Date.now()+task.settings.delayMs; await save(task); schedule(task.settings.delayMs);
}
async function inspect(task, mode) {
  // Inspect top-level and accessible store frames; keep frame IDs for pagination.
  const results=await chrome.scripting.executeScript({target:{tabId:task.workerTabId,allFrames:mode==='shop'},world:'MAIN',func:inspectPage,args:[mode]});
  return results.filter(x=>x.result).map(x=>({...x.result,frameId:x.frameId}));
}
async function startDetails(task,note,complete=false) {
  task.discovery.complete=complete; task.discovery.note=note; task.phase='detail'; task.cursor=null; log(task,note,complete?'info':'warn'); await save(task); schedule(200);
}
async function discover(task) {
  const cursor=task.cursor;
  const results=await inspect(task,'shop');
  const blocked=results.find(r=>r.blocked);
  if (blocked) return pause(task,`店铺页面需要处理：${blocked.blocked}。请打开采集页完成后继续。`);
  const pages=results.filter(r=>r.kind==='shop');
  // Keep bounded structural evidence for support without saving page HTML,
  // account text, request headers, or URL query parameters.
  const total = key => pages.reduce((sum,p)=>sum+(Number(p.diagnostics?.[key]) || 0),0);
  task.discovery.lastScan={checkedAt:new Date().toISOString(),frames:pages.length,anchors:total('anchors'),listingContainers:total('listingContainers'),recognizedLinks:total('recognizedLinks'),visibleFrames:pages.filter(p=>p.diagnostics?.visibility==='visible').length,diagnosticsAvailable:pages.some(p=>p.diagnostics)};
  const candidates=pages.flatMap(r=>r.itemLinks || []);
  const added=addLinks(task,candidates);
  const main=pages.find(r=>r.itemLinks?.length) || pages[0] || {};
  if (!task.shopName) task.shopName=main.shopName || '';
  if (!task.shopId) task.shopId=String(main.shopId || '');
  if (!task.sellerId) task.sellerId=String(main.sellerId || '');
  const expected=pages.map(p=>Number(p.expectedTotal)).filter(x=>x>0);
  if (expected.length) task.discovery.expectedTotal=Math.max(...expected);
  if (added) log(task,`发现 ${added} 个新商品，累计 ${task.queue.length} 个。`);
  cursor.scrolls++;
  cursor.stable=added ? 0 : (cursor.stable || 0)+1;
  const scrolled=await chrome.scripting.executeScript({target:{tabId:task.workerTabId,allFrames:true},func:()=>{
    const root=document.scrollingElement || document.documentElement;
    const before=root.scrollTop; window.scrollBy(0,Math.max(innerHeight*0.85,600));
    return {moved:root.scrollTop>before+3,atBottom:root.scrollTop+innerHeight>=root.scrollHeight-20};
  }});
  if (task.queue.length >= task.settings.maxItems) return startDetails(task,'已达到商品数量上限；本次店铺扫描不完整。');
  const atBottom=scrolled.every(x=>x.result?.atBottom || !x.result?.moved);
  if ((cursor.stable < 2 || !atBottom) && cursor.scrolls < 80) { cursor.readyAt=Date.now()+2000; await save(task); schedule(2000); return; }
  if (cursor.scrolls >= 80 && !atBottom) return startDetails(task,'当前列表滚动超过 80 次仍未到底；请补充商品链接或分批采集。');
  if (!candidates.length) {
    const catalog=pages.find(p=>p.catalogUrl && sameShop(task.shopUrl,p.catalogUrl));
    if(catalog && !task.discovery.catalogFollowed) {
      task.discovery.catalogFollowed=true;
      log(task,'当前页面没有商品，正在进入页面提供的「所有宝贝 / 全部商品」入口。');
      await navigate(task,catalog.catalogUrl,'shop'); return;
    }
    if (++cursor.attempts < 3) { cursor.scrolls=0; cursor.readyAt=Date.now()+5000; await save(task); schedule(5000); return; }
    if (task.queue.length) return startDetails(task,'后续列表页面未识别到商品，已保留前面发现的商品；店铺扫描尚未确认完整。');
    const scan=task.discovery.lastScan;
    if(scan.diagnosticsAvailable) log(task,`列表识别诊断：${scan.frames} 个页面区块、${scan.anchors} 个链接、${scan.listingContainers} 个候选列表容器、${scan.recognizedLinks} 个识别商品链接。`,'warn');
    const advice=scan.diagnosticsAvailable && !scan.visibleFrames
      ? '采集页目前在后台。请点击「打开采集页」，等商品显示后再继续。'
      : '请点击「打开采集页」检查内容；若商品已显示，说明当前页面结构仍需适配，并非店铺没有商品。';
    return pause(task,`多次扫描后仍未识别到商品链接。${advice}`);
  }
  const signature=[...new Set(candidates.map(x=>itemUrl(typeof x==='string'?x:x.url)?.itemId).filter(Boolean))].sort().join(',');
  const duplicate=task.discovery.signatures.includes(signature);
  if (!duplicate && signature) { task.discovery.signatures.push(signature); task.discovery.pages++; }
  if (duplicate && cursor.fromNext) return startDetails(task,'翻页后的商品列表与之前相同，已停止自动翻页；请核对店铺商品数。');
  if (task.discovery.pages >= task.settings.maxPages) return startDetails(task,'已达到列表页数上限；本次店铺扫描不完整。');
  const next=pages.find(p=>(p.nextUrl && sameShop(task.shopUrl,p.nextUrl)) || p.nextSelector);
  if (next?.nextUrl && sameShop(task.shopUrl,next.nextUrl)) {
    if (next.nextUrl === cursor.url) return startDetails(task,'下一页链接没有变化，请手动翻页后补充采集。');
    await navigate(task,next.nextUrl,'shop'); task.cursor.fromNext=true; await save(task); return;
  }
  if (next?.nextSelector) {
    const click=await chrome.scripting.executeScript({target:{tabId:task.workerTabId,frameIds:[next.frameId]},func:selector=>{
      const node=document.querySelector(selector);
      if (!node || node.matches('[disabled],[aria-disabled="true"],.disabled')) return false;
      node.click(); window.scrollTo(0,0); return true;
    },args:[next.nextSelector]});
    if (click[0]?.result) { task.cursor={...cursor,stage:'loading',started:Date.now(),readyAt:Date.now()+task.settings.delayMs,scrolls:0,stable:0,fromNext:true}; await save(task); schedule(task.settings.delayMs); return; }
  }
  const more=pages.some(p=>p.hasMore);
  const short=task.discovery.expectedTotal && task.queue.length<task.discovery.expectedTotal;
  return startDetails(task,more?'列表可能还有商品，但无法识别翻页控件。':short?'列表已结束，但发现数量少于页面商品总数；请补充检查。':'已扫描到可识别列表末尾；仅代表当前可见范围，请核对店铺商品总数。',!more&&!short);
}
async function detail(task) {
  const pending=task.queue.find(q=>q.status==='pending');
  if (!pending) { task.status='completed'; task.cursor=null; log(task,`采集结束：${task.rows.length} 条 SKU 记录。请检查失败商品与价格状态。`); await save(task); return; }
  const results=await inspect(task,'detail'); const data=results[0] || {};
  if (data.blocked) return pause(task,`商品页面需要处理：${data.blocked}。请打开采集页完成后继续。`);
  if (data.itemId && String(data.itemId)!==pending.itemId) {
    if (++task.cursor.attempts<3) { task.cursor.readyAt=Date.now()+5000; await save(task); schedule(5000); return; }
    pending.status='failed'; pending.error='商品页返回的 ID 与队列不一致，未写入价格。';
  } else if (!productBelongs(task,data)) {
    pending.status='skipped'; pending.error='商品所属店铺与任务店铺不一致，已排除。';
  } else if (!data.rows?.length || data.rows.every(r=>!r.skuId && r.price==null && r.finalPrice==null)) {
    if (++task.cursor.attempts<3) { task.cursor.readyAt=Date.now()+5000; await save(task); schedule(5000); return; }
    pending.status='failed'; pending.error=(data.warnings || []).join('；') || '页面未提供可识别的 SKU 数据。';
  } else {
    if (data.skuComplete===false && ++task.cursor.attempts<3) { task.cursor.readyAt=Date.now()+5000; await save(task); schedule(5000); return; }
    const verified=Boolean((task.sellerId && data.sellerId) || (task.shopId && data.shopId));
    const partial=data.skuComplete===false;
    const note=[...(data.warnings || []),...(partial?['SKU 列表不完整，仅保留已识别记录，请重试']:[]),...(!verified?['未核验店铺归属，请核对']:[])].join('；');
    const now=new Date().toISOString();
    const rows=data.rows.map(r=>({...r,itemId:pending.itemId,title:data.title || '',shopName:data.shopName || task.shopName,shopId:String(data.shopId || ''),sellerId:String(data.sellerId || ''),url:pending.url,capturedAt:now,note}));
    task.rows=task.rows.filter(r=>r.itemId!==pending.itemId).concat(rows);
    pending.status=partial?'failed':'done'; pending.error=partial?'SKU 数据未完整识别，已保留部分记录；请重试或手动核对。':''; log(task,`商品 ${pending.itemId}：${rows.length} 条 SKU${partial?'（部分记录）':''}。`);
  }
  if (pending.error) log(task,`${pending.itemId}：${pending.error}`,'warn');
  task.cursor=null; await save(task); schedule(task.settings.delayMs);
}
async function tick() {
  const task=await read(); if (task.status!=='running') return;
  if (!task.cursor) {
    if (task.phase==='discover') return navigate(task,task.shopUrl,'shop');
    const pending=task.queue.find(q=>q.status==='pending');
    if (!pending) { task.status='completed'; log(task,'采集结束，可导出 Excel。'); await save(task); return; }
    return navigate(task,pending.url,'detail');
  }
  if (task.cursor.stage==='navigate') return navigate(task,task.cursor.url,task.cursor.kind);
  if (!task.workerTabId) return navigate(task,task.cursor.url,task.cursor.kind);
  let tab;
  try { tab=await chrome.tabs.get(task.workerTabId); } catch { task.workerTabId=null; return pause(task,'采集标签页已关闭。点继续可重新打开。'); }
  if (Date.now() < (task.cursor.readyAt || 0)) { schedule(Math.min(10000,task.cursor.readyAt-Date.now())); return; }
  if (tab.status==='loading') {
    if (Date.now()-task.cursor.started>90000) return pause(task,'页面加载超过 90 秒，请检查采集页后继续。');
    schedule(2000); return;
  }
  if (!allowedUrl(tab.url)) return pause(task,'采集页跳转到了登录或验证页面，请完成后回到商品/店铺页再继续。');
  if (task.phase==='discover' && !sameShop(task.shopUrl,tab.url)) return pause(task,'采集页已离开任务店铺。请回到原店铺的「所有宝贝」页面再继续。');
  if (task.phase==='discover') return discover(task);
  return detail(task);
}
async function command(message) {
  let task=await read();
  switch(message.type) {
    case 'GET_STATE': return {ok:true,state:task};
    case 'START': {
      if (task.status==='running') throw new Error('已有任务正在采集，请先暂停。');
      const url=shopUrl(message.url);
      task=newTask(url,settingsOf(message.settings)); task.status='running'; log(task,'开始扫描店铺商品列表。'); await save(task); schedule(); break;
    }
    case 'PAUSE': await pause(task,'已手动暂停；当前进度已保存。'); break;
    case 'RESUME': {
      if (!task.shopUrl && !task.queue.length) throw new Error('请先填写店铺链接或导入商品链接。');
      task.status='running'; task.pauseReason='';
      if (task.cursor) { task.cursor.started=Date.now(); task.cursor.attempts=0; task.cursor.readyAt=Date.now()+1000; }
      log(task,'继续采集。'); await save(task); schedule(); break;
    }
    case 'RETRY_FAILED': {
      if (task.status==='running') throw new Error('请先暂停任务，再重试失败商品。');
      let n=0; for (const q of task.queue) if(q.status==='failed') { q.status='pending'; q.error=''; n++; }
      if (!n) throw new Error('没有需要重试的失败商品。');
      task.phase='detail'; task.status='running'; task.cursor=null; task.pauseReason=''; log(task,`重试 ${n} 个失败商品。`); await save(task); schedule(); break;
    }
    case 'IMPORT_URLS': {
      if (task.status==='running') throw new Error('请先暂停任务，再补充商品链接。');
      const added=addLinks(task,String(message.urls || '').match(/https?:\/\/[^\s<>"'，；]+/g) || []);
      if (!added) throw new Error('未发现新的有效商品链接，或已达到商品数量上限。');
      task.phase='detail'; task.cursor=null; task.status='paused'; task.discovery.complete=false; task.discovery.note='包含手动补充链接，请核对店铺归属和覆盖范围。'; log(task,`补充了 ${added} 个商品，点击继续开始采集。`); await save(task); break;
    }
    case 'SCAN_ACTIVE': {
      if (task.status==='running') throw new Error('请先暂停自动采集，再补充当前页。');
      const tabs=await chrome.tabs.query({});
      const candidates=tabs.filter(t=>allowedUrl(t.url));
      const active=candidates.filter(t=>t.active).sort((a,b)=>(b.lastAccessed || 0)-(a.lastAccessed || 0))[0] || candidates.sort((a,b)=>(b.lastAccessed || 0)-(a.lastAccessed || 0))[0];
      if (!active) throw new Error('请先在浏览器中打开淘宝/天猫店铺的「所有宝贝」页。');
      const item=itemUrl(active.url);
      if (item) { if (!addLinks(task,[item.url])) throw new Error('该商品已在队列中，或已达到商品数量上限。'); task.phase='detail'; }
      else {
        if (task.shopUrl && !sameShop(task.shopUrl,active.url)) throw new Error('最近访问的店铺与当前任务不同；请切回目标店铺。');
        const old=task.workerTabId; task.workerTabId=active.id; let results;
        try { results=await inspect(task,'shop'); } finally { task.workerTabId=old; }
        const added=addLinks(task,results.flatMap(r=>r.itemLinks || []));
        if (!added) throw new Error('当前页没有发现新的商品链接。请进入「所有宝贝」并滚动加载。');
        if (!task.shopUrl) task.shopUrl=shopUrl(active.url);
        const info=results.find(r=>r.itemLinks?.length) || {};
        task.shopName ||= info.shopName || ''; task.shopId ||= String(info.shopId || ''); task.sellerId ||= String(info.sellerId || ''); task.phase='detail';
        log(task,`从最近访问的店铺页补充 ${added} 个商品。`);
      }
      task.status='paused'; task.cursor=null; task.discovery.complete=false; task.discovery.note='手动补充页面；需要核对商品覆盖范围。'; await save(task); break;
    }
    case 'OPEN_WORKER':
      if (!task.workerTabId) throw new Error('还没有采集标签页。');
      {const t=await chrome.tabs.update(task.workerTabId,{active:true}); await chrome.windows.update(t.windowId,{focused:true});} break;
    case 'RESET':
      clearTimeout(timer); task=newTask(); await save(task); break;
    default: throw new Error('未知操作。');
  }
  return {ok:true,state:task};
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  // Extension pages opened in tabs have sender.tab as well. Check the trusted
  // dashboard URL instead, excluding messages originating from merchant pages.
  if (sender.id!==chrome.runtime.id || sender.url?.split(/[?#]/)[0]!==chrome.runtime.getURL('dashboard.html')) return false;
  exclusive(()=>command(message)).then(respond,error=>respond({ok:false,error:error.message})); return true;
});
chrome.action.onClicked.addListener(async()=>{
  const url=chrome.runtime.getURL('dashboard.html');
  const existing=(await chrome.tabs.query({url}))[0];
  if(existing) { await chrome.tabs.update(existing.id,{active:true}); await chrome.windows.update(existing.windowId,{focused:true}); }
  else await chrome.tabs.create({url});
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM) exclusive(tick).catch(reportError);});
chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status==='complete') exclusive(async()=>{const task=await read();if(task.status==='running' && task.workerTabId===id) schedule(1500);}).catch(reportError);});
chrome.tabs.onRemoved.addListener(id=>exclusive(async()=>{const task=await read(); if(task.workerTabId===id) {task.workerTabId=null;if(task.status==='running') await pause(task,'采集标签页已关闭。点继续可重新打开。');else await save(task);}}).catch(reportError));
chrome.runtime.onStartup.addListener(()=>exclusive(async()=>{const task=await read();if(task.status==='running') await pause(task,'浏览器已重启，进度已保存。点击继续恢复采集。');}).catch(reportError));
// Durable fallback when MV3 suspends the worker. Chrome may delay background timers.
chrome.alarms.create(ALARM,{periodInMinutes:0.5});
schedule(1000);
