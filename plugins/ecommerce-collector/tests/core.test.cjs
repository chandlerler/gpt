const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ext = path.resolve(__dirname, '../extension');
const read = f => fs.readFileSync(path.join(ext, f), 'utf8');

test('all scripts parse and manifest resources exist', () => {
  const walk = dir => fs.readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? walk(path.join(dir,e.name)) : [path.join(dir,e.name)]);
  for (const f of walk(ext).filter(f => f.endsWith('.js'))) new vm.Script(fs.readFileSync(f,'utf8'), {filename:f});
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.version, '1.2.469.2');
  assert.equal(m.key, undefined);
  assert.equal(m.update_url, undefined);
  for (const cs of m.content_scripts) for (const f of [...cs.js, ...(cs.css || [])]) assert.ok(fs.existsSync(path.join(ext,f)),f);
  assert.ok(!fs.existsSync(path.join(ext, '_metadata')));
});

test('capabilities work offline with expired storage and future time without reading either', async () => {
  const context = vm.createContext({ window:{}, chrome:new Proxy({}, {get(){throw Error('Unexpected chrome dependency')}}), Date:class {static now(){return 4102444800000;}} });
  vm.runInContext(read('lib/license.js'),context);
  const api = context.LicenseManager;
  assert.equal((await api.getStatusSummary()).status, 'active');
  assert.equal((await api.getCachedLicense()).code, '');
  assert.equal(await api.hasFeature('review_images'),true);
  assert.equal(await api.hasFeature('data_api'),false);
  for (let i=0;i<101;i++) assert.equal((await api.consumeQuota('monitor',999)).unlimited,true);
  assert.equal((await api.onlineRecheck()).checked,false);
});

test('inline HTML exactly matches the file used by fallback injection', () => {
  const c=vm.createContext({window:{}});
  vm.runInContext(read('content/panel-inline.js'),c);
  assert.equal(c.window.__AIS_PANEL_HTML__,read('content/panel.html'));
  assert.ok(!c.window.__AIS_PANEL_HTML__.includes('>会员</span>'));
});

function worker(fetchImpl) {
  const callbacks=[], downloads=[], requests=[];
  const event = () => ({addListener(){}});
  const storage = {get(keys,cb){ const result={aisFirstUseAt:1,ais_license_cache:{expiresAt:1,features:[]}}; if(cb)cb(result); return Promise.resolve(result); },set(v,cb){if(cb)cb();return Promise.resolve();}};
  const chrome = {
    runtime:{getManifest:()=>JSON.parse(read('manifest.json')),getURL:f=>'https://extension.test/'+f,onInstalled:event(),onStartup:event(),onMessage:{addListener:f=>callbacks.push(f)},sendMessage:(m,cb)=>{if(cb)cb({});return Promise.resolve({});}},
    storage:{local:storage,onChanged:event()},action:{onClicked:event()},
    contextMenus:{removeAll:cb=>cb(),create(){},onClicked:event()},
    alarms:{create(){},onAlarm:event()},notifications:{onClicked:event(),create(){}},
    tabs:{onRemoved:event(),query:()=>Promise.resolve([])},
    downloads:{download(o,cb){downloads.push(o);cb(42);},search(q,cb){cb([{filename:'review.png',fileSize:10}]);},onChanged:event()}
  };
  const c=vm.createContext({chrome,console:{log(){},warn(){},error(){}},URL,AbortController,TextDecoder,Date,Promise,btoa,setTimeout:f=>{queueMicrotask(f);return 1;},clearTimeout(){},setInterval(){},clearInterval(){},fetch:async (u,opts)=>{requests.push(u);if(fetchImpl)return fetchImpl(u,opts);throw Error('Unexpected network');}});
  c.self=c;
  vm.runInContext(read('background/worker.js'),c);
  const send=(req,url)=>new Promise(resolve=>{
    let answered=false;
    for(const cb of callbacks) cb(req,{tab:{id:1,url}},v=>{if(!answered){answered=true;resolve(v);}});
  });
  return {send,downloads,requests};
}
test('background permits review download without license and preserves source validation', async () => {
  const w=worker();
  const req={action:'downloadImage',type:'review',url:'https://img.alicdn.com/review.png'};
  assert.equal((await w.send(req,'https://item.taobao.com/item.htm?id=123')).success,true);
  assert.equal(w.downloads.length,1);
  assert.equal((await w.send(req,'https://unrelated.example/')).error,'invalid sender');
  assert.equal(w.downloads.length,1);
  assert.equal(w.requests.length,0);
});
test('legacy activation messages never contact the original server', async () => {
  const w=worker();
  const result=await w.send({action:'licenseFetch',url:'https://www.facailo.xyz/api/license/activate'},'https://item.taobao.com/');
  assert.equal(result.ok,false);
  assert.equal(w.requests.length,0);
});
test('Excel image transport rejects unrelated origins, credentials and hostile tab senders', async () => {
  const w=worker();
  for(const url of ['https://alicdn.com.evil.example/a.png','http://127.0.0.1/a.png','file:///tmp/pic','https://user:password@img.alicdn.com/a.png','https://img.alicdn.com:8443/a.png']) {
    assert.equal((await w.send({action:'fetchReviewImage',url},'https://item.taobao.com/')).ok,false);
  }
  assert.equal((await w.send({action:'fetchReviewImage',url:'https://img.alicdn.com/a.png'},'https://evil.example/')).error,'invalid sender');
  assert.equal(w.requests.length,0);
});
test('Excel image transport returns bytes and refuses redirects through fetch options', async () => {
  const w=worker((url,opts)=>{
    assert.equal(url,'https://img.alicdn.com/a.png');assert.equal(opts.redirect,'error');
    return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});
  });
  const r=await w.send({action:'fetchReviewImage',url:'//img.alicdn.com/a.png'},'https://item.taobao.com/');
  assert.equal(r.ok,true);assert.equal(r.base64,'AQID');assert.equal(r.mime,'image/png');
});
test('Excel image transport rejects HTML and oversized media', async () => {
  for(const headers of [{'content-type':'text/html'},{'content-type':'image/png','content-length':'9000000'}]) {
    const w=worker(()=>new Response('body',{headers}));
    assert.equal((await w.send({action:'fetchReviewImage',url:'https://img.alicdn.com/a.png'},'https://item.taobao.com/')).ok,false);
  }
});
