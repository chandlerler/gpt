import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as core from '../extension/lib/core.js';

const source=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
function harness(initial) {
  let stored=structuredClone(initial || core.newTask());
  let result={kind:'detail',itemId:'12345',rows:[]};
  let tab={id:7,status:'complete',url:'https://detail.tmall.com/item.htm?id=12345',windowId:1};
  let removed=false, creates=0, updates=0;
  const handlers={};
  const event=name=>({addListener(fn){handlers[name]=fn;}});
  const chrome={
    runtime:{id:'test-id',getURL:path=>'chrome-extension://test-id/'+path,onMessage:event('message'),onStartup:event('startup')},
    storage:{local:{async get(){return {task:structuredClone(stored)};},async set(value){stored=structuredClone(value.task);}}},
    tabs:{async get(){if(removed) throw new Error('No tab');return {...tab};},async update(id,value){updates++;tab={...tab,...value};return tab;},async create(value){creates++;removed=false;tab={...tab,...value};return tab;},async query(){return [tab];},onUpdated:event('updated'),onRemoved:event('removed')},
    windows:{async update(){}},
    scripting:{async executeScript(options){
      if(options.args?.[0]==='detail' || options.args?.[0]==='shop') return [{frameId:0,result:structuredClone(result)}];
      if(options.args?.length) return [{frameId:0,result:true}];
      return [{frameId:0,result:{moved:false,atBottom:true}}];
    }},
    action:{onClicked:event('action')},alarms:{create(){},onAlarm:event('alarm')}
  };
  const names=Object.keys(core);
  const worker=new Function('chrome','inspectPage',...names,'setTimeout','clearTimeout',source+'\nreturn {command,tick,read};')(chrome,()=>{},...names.map(k=>core[k]),()=>1,()=>{});
  return {...worker,handlers,get state(){return stored;},set state(value){stored=structuredClone(value);},set result(value){result=value;},set tab(value){tab={...tab,...value};},set removed(value){removed=value;},get creates(){return creates;},get updates(){return updates;},async tickReady(){if(stored.cursor)stored.cursor.readyAt=0;await worker.tick();}};
}
function detailTask(){
  const task=core.newTask('https://foo.tmall.com/category.htm');
  core.addLinks(task,['https://detail.tmall.com/item.htm?id=12345']);
  Object.assign(task,{status:'running',phase:'detail',workerTabId:7,sellerId:'99',cursor:{url:task.queue[0].url,kind:'detail',stage:'loading',started:Date.now(),readyAt:0,attempts:0}});
  return task;
}
function detailResult(extra={}){return {kind:'detail',itemId:'12345',sellerId:'99',title:'商品',skuComplete:true,rows:[{skuId:'9007199254740993123',specs:'红色',price:10,finalPrice:null}],...extra};}

test('dashboard messages work when sender has tab; merchant messages are rejected',async()=>{
  const h=harness();
  const reply=await new Promise(resolve=>assert.equal(h.handlers.message({type:'GET_STATE'},{id:'test-id',url:'chrome-extension://test-id/dashboard.html',tab:{id:1}},resolve),true));
  assert.equal(reply.ok,true);
  assert.equal(h.handlers.message({type:'RESET'},{id:'test-id',url:'https://detail.tmall.com/item.htm',tab:{id:7}},()=>{}),false);
});

test('imports remain paused, preserve IDs, then resume navigates a worker tab',async()=>{
  const h=harness();
  await h.command({type:'IMPORT_URLS',urls:'https://detail.tmall.com/item.htm?id=9007199254740993123\nhttps://detail.tmall.com/item.htm?id=9007199254740993123'});
  assert.equal(h.state.queue.length,1);assert.equal(h.state.status,'paused');
  await h.command({type:'RESUME'});await h.tickReady();
  assert.equal(h.creates,1);assert.equal(h.state.cursor.stage,'loading');
  assert.equal(h.state.queue[0].itemId,'9007199254740993123');
});

test('valid SKU result records unknown final price as null and finishes queue',async()=>{
  const h=harness(detailTask());h.result=detailResult();await h.tickReady();
  assert.equal(h.state.queue[0].status,'done');assert.equal(h.state.rows[0].finalPrice,null);
  assert.equal(h.state.rows[0].skuId,'9007199254740993123');
  await h.tickReady();assert.equal(h.state.status,'completed');
});

test('partial SKU data is retried then retained as failed; later retry replaces rows',async()=>{
  const h=harness(detailTask());h.result=detailResult({skuComplete:false});
  await h.tickReady();await h.tickReady();assert.equal(h.state.rows.length,0);
  await h.tickReady();assert.equal(h.state.queue[0].status,'failed');assert.equal(h.state.rows.length,1);
  assert.match(h.state.rows[0].note,/不完整/);
  await h.tickReady();await h.command({type:'RETRY_FAILED'});await h.tickReady();
  h.result=detailResult({rows:[{skuId:'a',price:11,finalPrice:9},{skuId:'b',price:12,finalPrice:null}]});await h.tickReady();
  assert.equal(h.state.queue[0].status,'done');assert.equal(h.state.rows.length,2);
});

test('wrong store is skipped and wrong product is not associated with queued item',async()=>{
  const h=harness(detailTask());h.result=detailResult({sellerId:'100'});await h.tickReady();
  assert.equal(h.state.queue[0].status,'skipped');assert.equal(h.state.rows.length,0);
  const other=harness(detailTask());other.result=detailResult({itemId:'23456'});
  await other.tickReady();await other.tickReady();await other.tickReady();
  assert.equal(other.state.queue[0].status,'failed');assert.equal(other.state.rows.length,0);
});

test('challenge pauses without consuming pending item; closed worker can be recreated',async()=>{
  const h=harness(detailTask());h.result={blocked:'请完成验证'};await h.tickReady();
  assert.equal(h.state.status,'paused');assert.equal(h.state.queue[0].status,'pending');
  h.removed=true;await h.command({type:'RESUME'});await h.tickReady();assert.equal(h.state.status,'paused');
  assert.equal(h.state.workerTabId,null);await h.command({type:'RESUME'});await h.tickReady();
  assert.equal(h.creates,1);assert.equal(h.state.status,'running');
});

test('durable navigation intent replays after suspension before navigation',async()=>{
  const task=detailTask();task.cursor.stage='navigate';const h=harness(task);
  h.tab={url:'https://foo.tmall.com/category.htm'};await h.tickReady();
  assert.equal(h.updates,1);assert.equal(h.state.cursor.stage,'loading');assert.equal(h.state.rows.length,0);
});

test('two-page shop crawl deduplicates and records detected end only after final page',async()=>{
  const task=core.newTask('https://foo.tmall.com/category.htm');task.status='running';
  const h=harness(task);await h.tickReady();
  h.result={kind:'shop',url:task.shopUrl,itemLinks:['https://detail.tmall.com/item.htm?id=12345'],nextUrl:'https://foo.tmall.com/category.htm?pageNo=2',hasMore:true,expectedTotal:2};
  await h.tickReady();await h.tickReady();await h.tickReady();
  assert.equal(h.state.discovery.pages,1);assert.equal(h.state.cursor.fromNext,true);
  h.result={kind:'shop',url:'https://foo.tmall.com/category.htm?pageNo=2',itemLinks:['https://detail.tmall.com/item.htm?id=23456'],hasMore:false,expectedTotal:2};
  await h.tickReady();await h.tickReady();await h.tickReady();
  assert.equal(h.state.queue.length,2);assert.equal(h.state.discovery.pages,2);assert.equal(h.state.phase,'detail');assert.equal(h.state.discovery.complete,true);
});

test('empty later shop page cannot falsely mark discovery complete',async()=>{
  const task=core.newTask('https://foo.tmall.com/category.htm');core.addLinks(task,['https://detail.tmall.com/item.htm?id=12345']);
  Object.assign(task,{status:'running',workerTabId:7,cursor:{url:task.shopUrl,stage:'loading',kind:'shop',started:Date.now(),attempts:0,scrolls:0}});
  const h=harness(task);h.tab={url:task.shopUrl};h.result={kind:'shop',itemLinks:[],hasMore:false};
  for(let i=0;i<5;i++)await h.tickReady();
  assert.equal(h.state.phase,'detail');assert.equal(h.state.discovery.complete,false);assert.equal(h.state.queue.length,1);
});

test('empty category page follows its observed same-shop catalog link only once',async()=>{
  const task=core.newTask('https://foo.tmall.com/category.htm');task.status='running';
  const h=harness(task);await h.tickReady();
  h.result={kind:'shop',itemLinks:[],catalogUrl:'https://foo.tmall.com/search.htm?search=y',diagnostics:{anchors:10,listingContainers:0,recognizedLinks:0,visibility:'hidden'}};
  await h.tickReady();await h.tickReady();
  assert.equal(h.state.cursor.url,'https://foo.tmall.com/search.htm?search=y');
  assert.equal(h.state.discovery.catalogFollowed,true);
  for(let i=0;i<5;i++)await h.tickReady();
  assert.equal(h.state.status,'paused');assert.equal(h.updates,1);
  assert.match(h.state.pauseReason,/后台/);
  assert.equal(h.state.discovery.lastScan.anchors,10);
});

test('empty visible page reports an adapter limitation instead of asserting no products',async()=>{
  const task=core.newTask('https://foo.tmall.com/category.htm');task.status='running';
  const h=harness(task);await h.tickReady();
  h.result={kind:'shop',itemLinks:[],catalogUrl:'https://another.tmall.com/search.htm',diagnostics:{anchors:25,listingContainers:4,recognizedLinks:0,visibility:'visible'}};
  for(let i=0;i<5;i++)await h.tickReady();
  assert.equal(h.state.status,'paused');assert.equal(h.updates,0);
  assert.match(h.state.pauseReason,/页面结构仍需适配/);
  assert.equal(h.state.discovery.lastScan.listingContainers,4);
});
