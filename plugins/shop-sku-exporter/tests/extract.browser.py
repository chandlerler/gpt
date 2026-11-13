"""Real Chromium extraction/observer checks with intercepted local fixtures only."""
import asyncio
import json
import shutil
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
EXTRACT = (ROOT / 'extension/lib/extract.js').read_text().split('/** Pure fixture entry point')[0].replace('export async function inspectPage', 'window.inspectPage = async function')
PAYLOAD = {'data': {'item': {'itemId': '123456', 'title': '浏览器测试商品'}, 'seller': {'shopName': '测试店铺', 'shopId': '789'}, 'skuBase': {'props': [{'pid': '1', 'name': '颜色', 'values': [{'vid': '11', 'name': '白色'}]}], 'skus': [{'skuId': '1001', 'propPath': '1:11'}]}, 'skuCore': {'sku2info': {'1001': {'price': {'priceText': '49.00'}, 'subPrice': {'priceTitle': '到手价', 'priceText': '39.00'}}}}}}
API = 'https://h5api.m.taobao.com/h5/mtop.taobao.pcdetail.data.get/1.0/?data=%7B%22itemId%22%3A%22123456%22%7D'

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=shutil.which('chromium'), headless=True)
        context = await browser.new_context()
        async def route(r):
            url = r.request.url
            if 'mtop.taobao.pcdetail' in url:
                if 'callback=' in url:
                    body, mime = 'jsonpCallback(' + json.dumps(PAYLOAD) + ');', 'application/javascript'
                else:
                    body, mime = json.dumps(PAYLOAD), 'application/json'
                await r.fulfill(body=body, content_type=mime, headers={'Access-Control-Allow-Origin': '*'})
            else:
                await r.fulfill(body='<html><body>商品测试页</body></html>', content_type='text/html')
        await context.route('**/*', route)
        await context.add_init_script(path=ROOT / 'extension/observer.js')
        page = await context.new_page()
        await page.goto('https://detail.tmall.com/item.htm?id=123456')
        await page.add_script_tag(content=EXTRACT)
        await page.evaluate('(url) => fetch(url).then(r=>r.json())', API)
        await page.wait_for_function('window.__SHOP_SKU_CAPTURE__.length === 1')
        result = await page.evaluate('inspectPage("detail")')
        assert result['rows'][0]['finalPrice'] == 39
        assert result['rows'][0]['specs'] == '颜色: 白色'
        await page.evaluate('''url => new Promise(resolve => { const xhr = new XMLHttpRequest(); xhr.open('GET',url); xhr.onload=resolve; xhr.send(); })''', API)
        await page.wait_for_function('window.__SHOP_SKU_CAPTURE__.length === 2')
        await page.evaluate('''url => new Promise(resolve => { window.jsonpCallback = data => {window.jsonpResult = data; resolve();}; const s = document.createElement('script'); s.src=url+'&callback=jsonpCallback'; document.head.append(s); })''', API)
        await page.wait_for_function('window.__SHOP_SKU_CAPTURE__.length === 3')
        assert await page.evaluate('window.jsonpResult.data.item.itemId') == '123456'
        assert await page.evaluate('JSON.stringify(window.__SHOP_SKU_CAPTURE__).includes("buyer")') is False
        # Initial globals remain stale while current-item API prices update.
        await page.evaluate('''payload => {
          window.__INITIAL_STATE__ = structuredClone(payload);
          window.__INITIAL_STATE__.data.skuCore.sku2info['1001'].price.priceText = '99.00';
          window.__INITIAL_STATE__.data.skuCore.sku2info['1001'].subPrice.priceText = '89.00';
          const newer = {itemId:'123456', capturedAt:200, data:{skuCore:{sku2info:{'1001':{price:{priceText:'29.00'}}}}}};
          const older = {itemId:'123456', capturedAt:100, data:{skuCore:{sku2info:{'1001':{price:{priceText:'39.00'}, subPrice:{priceTitle:'券后价',priceText:'35.00'}}}}}};
          const other = {itemId:'999999', capturedAt:300, data:{skuCore:{sku2info:{'1001':{price:{priceText:'0.01'}}}}}};
          window.__SHOP_SKU_CAPTURE__.splice(0, window.__SHOP_SKU_CAPTURE__.length, newer, older, other);
        }''', PAYLOAD)
        result = await page.evaluate('inspectPage("detail")')
        assert result['rows'][0]['price'] == 29, result
        assert result['rows'][0]['finalPrice'] is None, result
        assert result['rows'][0]['specs'] == '颜色: 白色'
        await page.goto('https://tongxincwyp.tmall.com/category.htm')
        await page.set_content('''<div class="item-list"><a href="//detail.tmall.com/item.htm?id=123456&amp;foo=1">Item A</a><a href="//detail.tmall.com/item.htm?id=123456">Duplicate</a><a href="https://evil.test/item.htm?id=1">External</a></div><div class="recommend"><a href="//detail.tmall.com/item.htm?id=888">Recommendation</a></div><div class="pagination"><button class="next" onclick="window.nextClicked=true">下一页</button></div>''')
        await page.add_script_tag(content=EXTRACT)
        result = await page.evaluate('inspectPage("shop")')
        assert result['itemLinks'] == ['https://detail.tmall.com/item.htm?id=123456']
        assert result['nextUrl'] == '', result['nextUrl']
        assert result['nextSelector'] == '[data-shop-sku-next="true"]'
        assert result['hasMore'] is True
        await page.locator(result['nextSelector']).click()
        assert await page.evaluate('window.nextClicked') is True
        await page.set_content('<div class="pagination"><a class="next disabled" href="?pageNo=2">下一页</a></div>')
        result = await page.evaluate('inspectPage("shop")')
        assert result['hasMore'] is False
        assert result['nextUrl'] == ''
        await page.set_content('<div>欢迎，请登录淘宝</div>')
        assert not (await page.evaluate('inspectPage("shop")'))['blocked']
        await page.set_content('<div id="nc_1_wrapper">请拖动滑块</div>')
        assert (await page.evaluate('inspectPage("shop")'))['blocked']
        await browser.close()
    print('PASS: Chromium fetch/XHR/JSONP capture, SKU extraction, shop deduplication, next-page button, captcha detection')

asyncio.run(main())
