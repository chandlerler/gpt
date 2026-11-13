import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedUrl,itemUrl,shopUrl,settingsOf,newTask,addLinks,sameShop,productBelongs} from '../extension/lib/core.js';

test('URL validation preserves numeric IDs and rejects lookalikes / non-product paths',()=>{
  assert.equal(allowedUrl('https://shop.taobao.com.evil.test/'),false);
  assert.equal(allowedUrl('javascript:alert(1)'),false);
  assert.equal(allowedUrl('http://shop.taobao.com/'),false);
  assert.equal(allowedUrl('https://user@shop.taobao.com/'),false);
  assert.deepEqual(itemUrl('http://detail.tmall.com/item.htm?id=9007199254740993123&spm=abc'),{itemId:'9007199254740993123',url:'https://detail.tmall.com/item.htm?id=9007199254740993123'});
  assert.equal(itemUrl('https://detail.tmall.com/login?id=12345'),null);
  assert.equal(itemUrl('https://user@detail.tmall.com/item.htm?id=12345'),null);
  assert.equal(shopUrl('https://tongxincwyp.tmall.com/category.htm?spm=abc&topIds=12345'), 'https://tongxincwyp.tmall.com/category.htm');
  assert.throws(()=>shopUrl('https://detail.tmall.com/item.htm?id=12345'));
});

test('queue deduplicates across platforms and honors the item cap',()=>{
  const task=newTask('',{maxItems:2});
  assert.equal(addLinks(task,['https://item.taobao.com/item.htm?id=12345','https://detail.tmall.com/item.htm?id=12345','https://detail.tmall.com/item.htm?id=23456','https://detail.tmall.com/item.htm?id=34567']),2);
  assert.deepEqual(task.queue.map(x=>x.itemId),['12345','23456']);
  assert.equal(task.queue[0].status,'pending');
});

test('scope checks reject known different stores including shared hosts',()=>{
  assert.equal(sameShop('https://foo.tmall.com/category.htm','https://bar.tmall.com/category.htm'),false);
  assert.equal(sameShop('https://shop.taobao.com/search.htm?shop_id=1','https://shop.taobao.com/search.htm?shop_id=2'),false);
  assert.equal(sameShop('https://foo.tmall.com/category.htm','https://foo.tmall.com/category.htm?pageNo=2'),true);
  assert.equal(productBelongs({sellerId:'10'},{sellerId:'11'}),false);
  assert.equal(productBelongs({shopId:'10'},{shopId:'11'}),false);
  assert.equal(productBelongs({shopId:'10'},{}),true); // unknown is labeled by worker
});

test('settings have finite bounded concurrency-free crawl limits',()=>{
  assert.deepEqual(settingsOf({delayMs:-1,maxPages:9000,maxItems:'bad'}),{delayMs:3000,maxPages:1000,maxItems:5000,expectedSellerId:''});
  assert.equal(settingsOf().delayMs,5000);
});
