import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDetail, inspectPage} from '../extension/lib/extract.js';

const item = {itemId: '123456', title: '棉质 T 恤', images: ['//img.alicdn.com/example.jpg']};
const seller = {shopId: '789', userId: '456', shopName: '示例店铺'};
const skuBase = {props: [{pid: '1', name: '颜色', values: [{vid: '11', name: '白色'}, {vid: '12', name: '黑色'}]}, {pid: '2', name: '尺码', values: [{vid: '21', name: 'M'}]}], skus: [{skuId: '1001', propPath: '1:11;2:21'}, {skuId: '1002', propPath: '1:12;2:21'}]};
const context = {url: 'https://detail.tmall.com/item.htm?id=123456'};

test('merges modern SKU metadata with apiStack prices, preserving SKU-specific final prices', async () => {
  const result = await parseDetail([{data: {item, seller, skuBase, apiStack: [{value: JSON.stringify({skuCore: {sku2info: {'0': {price: {priceText: '9.9'}}, '1001': {price: {priceText: '49.90'}, subPrice: {priceTitle: '券后价', priceText: '39.90', priceDesc: '需领 10 元券'}, quantity: 4}, '1002': {price: {priceText: '59.90'}, quantity: 0}}}})}]}}], context);
  assert.equal(result.itemId, '123456');
  assert.equal(result.shopName, '示例店铺');
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].specs, '颜色: 白色 / 尺码: M');
  assert.equal(result.rows[0].price, 49.9);
  assert.equal(result.rows[0].finalPrice, 39.9);
  assert.match(result.rows[0].promotion, /10 元券/);
  assert.equal(result.rows[1].finalPrice, null);
  assert.equal(result.rows[1].price, 59.9);
  assert.equal(result.rows[1].availability, '无库存');
  assert.equal(result.skuComplete, true);
});

test('does not apply aggregate minimum or price ranges to SKU values', async () => {
  const result = await parseDetail([{item, skuBase, price: {price: {priceText: '1.00'}}, skuCore: {sku2info: {'0': {subPrice: {priceTitle: '券后价', priceText: '1.00'}}, '1001': {price: {priceText: '10-20'}}, '1002': {price: {priceText: '¥ 1,299.00'}}}}}], context);
  assert.equal(result.rows[0].price, null);
  assert.equal(result.rows[0].finalPrice, null);
  assert.equal(result.rows[1].price, 1299);
  assert.equal(result.rows[1].finalPrice, null);
});

test('ignores captured payloads for other items and recommendations', async () => {
  const result = await parseDetail([{itemId: '222222', data: {skuBase, skuCore: {sku2info: {'1001': {price: '0.01'}}}}}, {item, skuBase, skuCore: {sku2info: {'1001': {price: '15'}}}, recommend: {item: {itemId: '333333'}, skuCore: {sku2info: {'1001': {price: '0.02'}}}}}], context);
  assert.equal(result.rows[0].price, 15);
  assert.equal(result.rows[1].price, null);
});

test('supports modern ICE context and preserves missing stock as unknown', async () => {
  const result = await parseDetail([{loaderData: {home: {data: {res: {item, seller, skuBase, skuCore: {sku2info: {'1001': {price: {priceText: '20.00', priceTitle: '活动价'}, finalPrice: {priceText: '18'}}}}}}}}}], context);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].price, 20);
  assert.equal(result.rows[0].finalPrice, null, 'unlabeled finalPrice field is not confirmed');
  assert.equal(result.rows[0].stock, null);
  assert.equal(result.rows[0].availability, '未知');
});

test('parses old skuMap; does not synthesize Cartesian-product SKU combinations', async () => {
  const result = await parseDetail([{itemDO: item, valItemInfo: {skuMap: {';1:11;2:21;': {skuId: '1001', price: '88', stock: '3'}}}}], context);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].skuId, '1001');
  assert.equal(result.rows[0].stock, 3);
  assert.equal(result.rows[0].price, 88);
  assert.equal(result.rows[0].finalPrice, null);
});

test('retains price-map SKU IDs when labels did not arrive', async () => {
  const result = await parseDetail([{item, skuCore: {sku2info: {'0': {price: '1'}, '1001': {price: '9'}}}}], context);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].skuId, '1001');
  assert.equal(result.rows[0].specs, '规格未解析');
  assert.equal(result.skuComplete, false);
});

test('does not turn missing extraction into a free SKU', async () => {
  const result = await parseDetail([], context);
  assert.equal(result.rows[0].price, null);
  assert.equal(result.rows[0].finalPrice, null);
  assert.equal(result.skuComplete, false);
  assert.match(result.rows[0].priceStatus, /未完成/);
});

test('default spec requires explicit empty sku list and a default price map', async () => {
  const result = await parseDetail([{item, skuBase: {skus: [], props: []}, skuCore: {sku2info: {'0': {price: {priceText: '12'}}}}}], context);
  assert.equal(result.rows[0].price, 12);
  assert.equal(result.rows[0].skuId, '');
  assert.equal(result.skuComplete, true);
});

test('inspectPage is serializable as a standalone Chrome injected function', async () => {
  const serialized = Function(`return (${inspectPage.toString()})`)();
  const result = await serialized('detail', {payloads: [{item, skuBase}], context});
  assert.equal(result.rows.length, 2);
});

test('recommendVO, recommendList and related data without item IDs cannot overwrite SKU prices', async () => {
  const hostile = {skuCore: {sku2info: {'1001': {price: '0.01'}, '9000': {price: '0.02'}}}};
  const result = await parseDetail([{item, skuBase, skuCore: {sku2info: {'1001': {price: '42'}}}, componentsVO: {recommendVO: hostile, recommendList: [hostile], related: hostile}}], context);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].price, 42);
});

test('item-bound detail context wins over unbound SKU globals in either order', async () => {
  const good = {item, skuBase, skuCore: {sku2info: {'1001': {price: '42'}}}};
  const unbound = {skuCore: {sku2info: {'1001': {price: '0.01'}, '9999': {price: '0.02'}}}};
  for (const inputs of [[good, unbound], [unbound, good]]) {
    const result = await parseDetail(inputs, context);
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].price, 42);
  }
});

test('promotionPrice is a final-price source only with an explicit eligible price label', async () => {
  const result = await parseDetail([{item, skuBase, skuCore: {sku2info: {'1001': {price: {priceText: '50'}, promotionPrice: {priceText: '30', priceTitle: '券后价', condition: '限本账号领取店铺券后'}}, '1002': {promotionPrice: {priceText: '25', priceTitle: '活动价'}}}}}], context);
  assert.equal(result.rows[0].finalPrice, 30);
  assert.match(result.rows[0].promotion, /本账号/);
  assert.equal(result.rows[1].finalPrice, null);
  assert.equal(result.rows[1].price, 25);
});

test('fixture payload order remains deterministic: later current-item prices supersede earlier prices', async () => {
  const initial = {item, skuBase, skuCore: {sku2info: {'1001': {price: {priceText: '50'}, subPrice: {priceText: '40', priceTitle: '券后价'}, quantity: 5}}}};
  const observed = {itemId: '123456', data: {skuCore: {sku2info: {'1001': {price: {priceText: '35'}}}}}};
  const otherItem = {itemId: '999999', data: {skuCore: {sku2info: {'1001': {price: {priceText: '0.01'}, subPrice: {priceText: '0.01', priceTitle: '券后价'}}}}}};
  const result = await parseDetail([initial, observed, otherItem], context);
  assert.equal(result.rows[0].price, 35);
  assert.equal(result.rows[0].finalPrice, null, 'old coupon price is not retained after an updated price observation');
  assert.equal(result.rows[0].stock, 5);
  const reversed = await parseDetail([observed, initial], context);
  assert.equal(reversed.rows[0].price, 50);
  assert.equal(reversed.rows[0].finalPrice, 40);
});

test('later legacy SKU price responses also supersede initial legacy SKU prices', async () => {
  const initial = {itemDO: item, valItemInfo: {skuMap: {';1:11;': {skuId: '1001', price: '88', stock: 3}}}};
  const newer = {itemDO: item, valItemInfo: {skuMap: {';1:11;': {skuId: '1001', price: '68', stock: 2}}}};
  const result = await parseDetail([initial, newer], context);
  assert.equal(result.rows[0].price, 68);
  assert.equal(result.rows[0].stock, 2);
});
