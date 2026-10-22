> Historical notes for this version only. For current installation and behavior, see the [English README](../../README.md) or [中文说明](../README.zh-CN.md). Test results below are historical, not validation of the current script.

# H2S monitor v1.3.5 — Price 升序修复版

## 安装

用 h2s-monitor.user.js 的全部内容，完整覆盖 Tampermonkey 中原有的 H2S — Den Haag housing monitor 脚本并保存，然后刷新 Holland2Stay 页面。
不要删除原脚本后新建，不要同时启用两份脚本，不要点“清除历史”或“强制重发”。

保持网页 Availability = Available to book，City 不选。脚本会选择 Price，再从第一页扫描。
也可以手动选择一个目标城市；脚本不会自动切城市或点击 Reset。

## 本次修改

- 按用户明确指定的站点规则，把 Price 解释为价格从低到高，把 Available start date 解释为日期从早到晚。后者不能用于预算截断。
- 不再等待页面中不存在的 Low to High / Ascending 文字。这里只采用用户指定的规则，不声称通过网站后端代码独立核实了排序含义。
- 点击内部 SortItem 按钮；如果点击后菜单消失而标题仍为 Sort ...，重新展开读取实际选中项。不把“点击过”误当成“选中成功”。
- 把已确认的选择暂存在本页内存；菜单收起不丢失。选中其他排序、切换筛选、排序控件被替换或页面刷新后不沿用旧确认。
- 翻页时 aria-busy=true 是加载状态，不再立即误报成排序改变；等待加载结束后再检查。
- 多页从第一页开始，按卡片主租金（不含 servicekosten）匹配。€1500 包含；在价格升序条件下，读完出现 >€1500 房源的当前页后停止翻页。
- 仍检查页内/跨页顺序、总数、重复链接、筛选范围和验证页。失败不记录为完整扫描。
- 状态面板显示版本，原“允许扫描”改为“筛选条件”，避免把筛选通过混同扫描已可完成。

## 保留的行为与存储

原 @name、@namespace、GM 权限、存储前缀 h2s_single_city_den_haag、历史格式版本和 Telegram 配置键保持不变。
五城：The Hague / Den Haag、Rijswijk、Rotterdam、Leiden、Zoetermeer。
荷兰时间 07:00–23:00 自动运行；完成后一轮随机 5–15 分钟刷新；夜间可菜单立即检查。
保留旧版本的成功通知去重、失败待发、旧历史迁移、重新出现/降价/转为可订的通知语义。
遇到验证暂停，不绕过验证，不自动预订或付款。

## 验证

推送前重新运行本地 Chromium 回归：35 项全部通过，node --check 语法检查通过。
测试包含两个上传网页的精简 DOM；海牙快照整段脚本回放读取 9 套、模拟发送 3 条。
主流程测试模拟菜单关闭、已选 Price、菜单保持打开、异步加载、从第 3 页回到第 1 页、价格边界、异常停止、Telegram 失败续发、夜间手动运行和累计 9 的旧记录迁移。

这些是本地测试：DOM 在 Chromium 中运行，H2S 点击事件、页面数据更新、导航、Web Locks、Telegram 和时钟由测试模拟。没有访问真实 H2S 或发送真实 Telegram 消息。不是官网端到端验收。

仓库原有的 53 项 Node/linkedom 测试本次保持不变，未全量重跑；其中把普通 Price 断言为“方向未知”的旧预期与新需求不一致，仍需更新。不要将本次 35 项通过描述为全部仓库测试通过。

运行本轮测试：

```sh
python -m pip install playwright
python -m playwright install chromium
python tests/browser_regression.py
node --check h2s-monitor.user.js
```

已有系统 Chromium 时，可用 --chromium 指定可执行文件路径。
结果见 [历史 v1.3.5 测试报告](browser-test-results-v1.3.5.json)。

## 提交范围

本修复基于 PR #1 的 codex/h2s-monitor-20261003 分支，基线提交为 e89366014cc8ac2a08d1a3f91d8e08b860c44a98。
userscript、浏览器测试和两份精简 DOM 与本次对话提供的 v1.3.5 下载包逐字节一致；只调整本说明中的提交状态及测试报告的本地路径。
本次只更新 PR #1 的现有分支；保留草稿状态，不合并 main。
