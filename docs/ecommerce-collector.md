# 电商采集大师 1.2.469.1

[下载插件安装 ZIP](https://github.com/chandlerler/gpt/raw/refs/heads/main/dist/ecommerce-collector-1.2.469.1.zip)

[GitHub 文件页面](https://github.com/chandlerler/gpt/blob/main/dist/ecommerce-collector-1.2.469.1.zip)（如果直接下载链接不可用，打开文件页面，点击 **Download raw file** 下载。）

## 安装

1. 下载 `ecommerce-collector-1.2.469.1.zip`，解压到固定目录。
2. 打开 Chrome 的 `chrome://extensions` 或 Edge 的 `edge://extensions`。
3. 开启“开发者模式”，点击“加载已解压的扩展程序”。
4. 选择直接包含 `manifest.json` 的解压目录，无需编译。
5. 刷新商品页面，点击扩展图标或页面悬浮按钮。

此包独立于仓库原有 `extension/` 目录中的另一个插件。安装后不要移动或删除解压目录；建议停用同类扩展，避免重复注入。

## 功能与范围

支持商品图片、视频、SKU、参数、评论采集，本地评论分析，图片转换与长图拼接，CSV/Excel 导出、ZIP 整合包、历史记录和定时监控。平台登录、验证码、页面变化、采集限速及用户设置仍可能影响采集。

原作者的云存储、云分析和团队服务未接入此本地版本。平台数据请求、图片下载、远程规则更新、手动反馈和配置的监控 Webhook 仍保留。

基于提供的 1.2.469 发布包修改；[原插件 Chrome 商店链接](https://chromewebstore.google.com/detail/nmmdfjoabpmhoaakoiclkppaokddijle)。原插件及相关组件的版权归各自权利人所有，此版本不代表原作者发布或维护。

已通过 5 项基础检查和 7 项受控浏览器集成检查，覆盖导出、图片转码和 ZIP。浏览器检查使用模拟扩展 API 与页面样本；真实扩展安装和电商网站联调尚未验证。安装包校验值见 [SHA256SUMS](../dist/SHA256SUMS)。
