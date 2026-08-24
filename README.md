# 牛熊风向标成交额图叠加市场指数

这是一个 Tampermonkey（油猴）用户脚本，用于在东方财富“牛熊风向标”的成交额图中叠加市场指数分时线。

当前支持：

- 东方财富全A指数（`47.800000`）；
- A股平均股价（`47.800005`）；
- 图内按钮切换指数；
- 独立的涨跌幅右轴；
- 鼠标悬停显示所指分钟的点位和涨跌幅；
- 交易时段自动刷新；
- 页面异步渲染或重新创建图表后自动挂载。

## 文件

- [`outputs/eastmoney-all-a-intraday.user.js`](outputs/eastmoney-all-a-intraday.user.js)：可安装的油猴脚本；
- [`outputs/安装说明.md`](outputs/安装说明.md)：安装方法、数据口径和接口说明；
- [`outputs/代码逻辑说明.md`](outputs/代码逻辑说明.md)：启动、请求、时间映射、Canvas 绘图、切换、悬停和刷新机制的详细说明；
- [`work/test-page.html`](work/test-page.html)：带模拟行情的本地测试页。

## 快速使用

1. 在浏览器中安装 Tampermonkey。
2. 在 Tampermonkey 中导入并安装 `outputs/eastmoney-all-a-intraday.user.js`。
3. 打开 <https://emrnweb.eastmoney.com/nxfxb/home>。
4. 滚动到“成交分析”，在成交额图顶部选择“全A”或“平均股价”。

脚本只读取东方财富行情接口，不读取账号信息，也不执行交易。

