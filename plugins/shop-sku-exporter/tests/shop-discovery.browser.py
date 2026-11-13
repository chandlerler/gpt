"""Regression checks for shop DOM discovery; all pages are local fixtures."""
import asyncio
import json
import shutil
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
EXTRACT = (ROOT / 'extension/lib/extract.js').read_text().split('/** Pure fixture entry point')[0].replace('export async function inspectPage', 'window.inspectPage = async function')


async def main():
    checks = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=shutil.which('chromium'), headless=True)
        context = await browser.new_context()
        await context.route('**/*', lambda r: r.fulfill(body='<html><body></body></html>', content_type='text/html'))
        page = await context.new_page()
        await page.goto('https://tongxincwyp.tmall.com/category.htm')
        await page.add_script_tag(content=EXTRACT)

        async def inspect(html):
            await page.set_content(html)
            return await page.evaluate('inspectPage("shop")')

        result = await inspect('<a class="ItemCard--abc" href="//detail.tmall.com/item.htm?id=123456">商品卡片本身就是链接</a>')
        assert result['itemLinks'] == ['https://detail.tmall.com/item.htm?id=123456'], result
        checks.append('A listing card that is itself an anchor is included.')

        result = await inspect('<div class="item-list"></div><section class="generated"><a href="//detail.tmall.com/item.htm?id=123457">其他区域已加载商品</a></section>')
        assert result['itemLinks'] == ['https://detail.tmall.com/item.htm?id=123457'], result
        assert result['warning'], result
        checks.append('An empty matched container does not suppress fallback URL discovery.')

        result = await inspect('''<div class="item-list">
          <div data-item-id="123458">商品 A</div><div data-auction-id="123459">商品 B</div>
          <div data-href="//detail.tmall.com/item.htm?id=123460">商品 C</div>
          <a data-item-url="https://detail.tmall.com/item.htm?id=123461">商品 D</a>
          <div data-item-id="bad">无效 ID</div><div data-item-id="123">非商品 ID</div>
          <div data-item-url="javascript:alert(1)">无效地址</div>
          <div data-href="https://evil.test/item.htm?id=123499">其他域名</div>
        </div><div data-item-id="123498">无列表语境</div>''')
        assert set(result['itemLinks']) == {f'https://detail.tmall.com/item.htm?id={i}' for i in range(123458, 123462)}, result
        checks.append('Explicit product attributes work only inside recognized listing/card contexts.')

        result = await inspect('''<div class="item-list"><a href="//detail.tmall.com/item.htm?id=123462">店铺商品</a>
          <div class="recommend"><a href="//detail.tmall.com/item.htm?id=888881">推荐</a><div data-item-id="888882"></div></div></div>
          <a class="ItemCard recommend" href="//detail.tmall.com/item.htm?id=888883">推荐卡片</a>
          <div class="guess"><div class="itemCard" data-item-id="888884"></div></div>''')
        assert result['itemLinks'] == ['https://detail.tmall.com/item.htm?id=123462'], result
        checks.append('Recommendation containers and cards remain excluded.')

        result = await inspect('''<div class="item-list"></div><div data-item-id="999998">无列表语境</div>
          <div class="recommend"><a href="//detail.tmall.com/item.htm?id=999997">推荐</a></div>
          <a href="https://detail.tmall.com.evil.test/item.htm?id=999996">伪装域名</a>''')
        assert result['itemLinks'] == [], result
        assert result['diagnostics']['anchors'] == 2, result
        assert result['diagnostics']['recognizedLinks'] == 0, result
        assert set(result['diagnostics']) == {'anchors','listingContainers','scannedNodes','recognizedLinks','readiness','visibility'}, result
        checks.append('Fallback does not invent product IDs or accept recommendation/lookalike links; diagnostics contain only counts/state.')

        result = await inspect('<div class="item-list"><a href="//detail.tmall.com/item.htm?id=123463">店铺商品</a></div><a href="//detail.tmall.com/item.htm?id=999995">无关区域</a>')
        assert result['itemLinks'] == ['https://detail.tmall.com/item.htm?id=123463'], result
        checks.append('A successful scoped scan does not broaden to unrelated page links.')

        result = await inspect('''<a href="https://other.tmall.com/search.htm">全部商品</a>
          <a href="/logout.htm">所有宝贝</a><a href="javascript:alert(1)">全部宝贝</a>
          <a href="/search.htm?search=y">查看全部商品</a>''')
        assert result['catalogUrl'] == 'https://tongxincwyp.tmall.com/search.htm?search=y', result
        assert result['itemLinks'] == [], result
        result = await inspect('<a href="https://other.tmall.com/search.htm">全部商品</a><a href="/category.htm">所有宝贝</a>')
        assert result['catalogUrl'] == '', result
        await page.goto('https://tongxincwyp.tmall.com/category.htm?shop_id=123')
        await page.add_script_tag(content=EXTRACT)
        result = await inspect('<a href="/search.htm?shop_id=999">全部商品</a>')
        assert result['catalogUrl'] == '', result
        checks.append('Catalog navigation uses an observed, noncurrent same-shop URL and rejects external/unsafe/conflicting identity links.')
        await browser.close()
    print(json.dumps({'scope':'Chromium local DOM fixtures; not a live-store diagnosis','passed':True,'checks':checks}, ensure_ascii=False, indent=2))


asyncio.run(main())
