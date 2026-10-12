# 来源与第三方组件

此仓库基于用户提供的「淘宝／天猫－商品图片与视频下载」3.8.7 客户端修改。

- 原扩展 ID：`amajhcihapocjmencaehfanmjibfgihh`。
- 原始压缩包 SHA-256：`da5466cfb31d4c09003a7788609c7b2b086859944b2f34047218003b3c9841dc`。
- 本副本版本：3.8.7.1；原版本署名与组件版权归原权利人，本仓库不冒充官方版本，也不为原代码另行声明开源许可证。
- 修改内容包括商业校验移除、独立扩展标识、帮助入口、测试和打包工具。

`extension/zip.js` 保留了上游文件头：JSZip v3.10.1，Copyright 2009–2016 Stuart Knightley，MIT 或 GPLv3 双重许可；其中使用的 pako 为 MIT 许可。其原始版权说明已随文件保留。

上游许可资料：

- https://github.com/Stuk/jszip/blob/v3.10.1/LICENSE.markdown
- https://github.com/nodeca/pako/blob/master/LICENSE
