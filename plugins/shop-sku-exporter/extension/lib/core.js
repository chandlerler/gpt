export const DEFAULT_SETTINGS = { delayMs: 5000, maxPages: 200, maxItems: 5000, expectedSellerId: '' };
export function allowedUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && /(^|\.)(taobao|tmall)\.com$/.test(u.hostname) && !u.username && !u.password; } catch { return false; }
}
export function itemUrl(value) {
  try {
    const u = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (!['item.taobao.com', 'detail.tmall.com'].includes(u.hostname) || !['http:', 'https:'].includes(u.protocol) || u.username || u.password || !/^\/item\.htm\/?$/.test(u.pathname)) return null;
    const itemId = u.searchParams.get('id');
    return /^\d{5,30}$/.test(itemId || '') ? { itemId, url: `https://${u.hostname}/item.htm?id=${itemId}` } : null;
  } catch { return null; }
}
export function shopUrl(value) {
  const text = String(value || '').trim();
  if (!allowedUrl(text)) throw new Error('请输入 https:// 开头的淘宝或天猫店铺链接。');
  if (itemUrl(text)) throw new Error('这里需要店铺的「所有宝贝」链接；商品链接请使用「补充商品链接」。');
  const u = new URL(text);
  if (/^(login|passport|buyertrade|cart|buy|trade)\./.test(u.hostname)) throw new Error('请使用店铺的「所有宝贝」页面。');
  ['spm','topIds','scm','utparam','ali_trackid'].forEach(k => u.searchParams.delete(k));
  u.hash = '';
  return u.href;
}
export function settingsOf(input = {}) {
  const clamp = (x, low, high, fallback) => Number.isFinite(Number(x)) ? Math.min(high, Math.max(low, Math.round(Number(x)))) : fallback;
  return {delayMs:clamp(input.delayMs,3000,60000,5000),maxPages:clamp(input.maxPages,1,1000,200),maxItems:clamp(input.maxItems,1,20000,5000),expectedSellerId:String(input.expectedSellerId || '').trim().slice(0,50)};
}
export function newTask(url = '', settings = DEFAULT_SETTINGS) {
  const now = new Date().toISOString();
  return {schema:1,status:'idle',phase:'discover',shopUrl:url,shopName:'',shopId:'',sellerId:settings.expectedSellerId || '',workerTabId:null,discovery:{pages:0,expectedTotal:null,complete:false,note:'尚未采集',signatures:[]},queue:[],rows:[],logs:[],settings:settingsOf(settings),startedAt:now,updatedAt:now,pauseReason:'',cursor:null};
}
export function log(task, message, level = 'info') { task.logs.push({time:new Date().toISOString(),level,message}); task.logs = task.logs.slice(-150); }
export function addLinks(task, links) {
  const known = new Set(task.queue.map(x=>x.itemId)); let count=0;
  for (const value of links) {
    const item = itemUrl(typeof value === 'string' ? value : value.url || '');
    if (!item || known.has(item.itemId) || task.queue.length >= task.settings.maxItems) continue;
    known.add(item.itemId); task.queue.push({...item,status:'pending',error:''}); count++;
  }
  return count;
}
export function sameShop(a, b) {
  try {
    const x=new URL(a), y=new URL(b);
    if (!allowedUrl(b) || x.hostname !== y.hostname || itemUrl(b) || /logout|login|cart|buy\.htm/.test(y.pathname)) return false;
    // Some shop fronts share a host and select the store by an ID parameter.
    for (const key of ['shop_id','shopId','user_number_id','sellerId','seller_id']) {
      if (x.searchParams.has(key) && y.searchParams.has(key) && x.searchParams.get(key)!==y.searchParams.get(key)) return false;
    }
    return true;
  } catch { return false; }
}
export function productBelongs(task, data) {
  if (task.sellerId && data.sellerId && String(task.sellerId) !== String(data.sellerId)) return false;
  if (task.shopId && data.shopId && String(task.shopId) !== String(data.shopId)) return false;
  return true;
}
export function summary(task) {
  return {items:task.queue.length,done:task.queue.filter(x=>x.status==='done').length,failed:task.queue.filter(x=>x.status==='failed').length,skus:task.rows.length,confirmed:task.rows.filter(x=>x.finalPrice !== null && x.finalPrice !== undefined).length};
}
