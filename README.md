# H2S Housing Search Assistant

[![Tests](https://github.com/Legendary747/H2S/actions/workflows/tests.yml/badge.svg)](https://github.com/Legendary747/H2S/actions/workflows/tests.yml)
[![Version](https://img.shields.io/badge/version-1.4.0-0ea5e9)](https://github.com/Legendary747/H2S/releases/tag/v1.4.0)
[![JavaScript](https://img.shields.io/badge/JavaScript-userscript-F7DF1E?logo=javascript&logoColor=black)](h2s-monitor.user.js)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520.19-339933?logo=nodedotjs&logoColor=white)](CONTRIBUTING.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A little help with the housing search, so you can spend less time watching a screen.**

[中文说明](docs/README.zh-CN.md) · [Configuration](docs/configuration.md) · [Contributing](CONTRIBUTING.md)

Finding housing in the Netherlands can mean checking the same listings again and again. H2S helps international students and other housing seekers follow Holland2Stay listings in a browser they keep open. After you enable it, the script refreshes the page, checks the visible listings against your city and rent preferences, and can send Telegram alerts while you study, rest, or step away from your desk.

This is an independent, unofficial assistance tool. It does not guarantee a notification, availability, eligibility, or a successful booking. Your computer must stay awake, online, and running the browser tab. It is not a hosted or cloud monitoring service.

> **Start with the script disabled.** Open Holland2Stay first and complete any Cloudflare or login checks yourself. Only then enable this script in Tampermonkey and refresh the page. Enabling it on the initial visit may contribute to a Cloudflare challenge. This sequence is a precaution, not a guarantee that challenges will not occur. When you finish, disable the script before your next fresh visit.

## What it does

- Watches one or more cities, with a configurable monthly **base rent** limit; the default is **€1,000**.
- Runs during configurable hours; the default is **07:00–23:00, Europe/Amsterdam**.
- Refreshes after a completed scan at a random interval within your configured range; the default is **5–10 minutes**.
- Reads the visible listing cards, selects **Price** when needed, and follows visible pagination. It stops early only when ascending prices and the budget cutoff can be verified.
- Alerts on eligible listings and keeps notification history to avoid repeatedly sending the same successful alert. Failed deliveries remain pending for retry.
- Pauses on detected challenges or access failures, respects observed retry delays, and requires manual handling of verification.

**Automation boundary:** the page refreshes, sorting, pagination, and notifications above are automated browser assistance. The script does **not** provide a standalone crawler, direct H2S API harvesting, automatic bookings, applications, payments, CAPTCHA solving, or Cloudflare bypass. It does not visit listing detail or booking pages. It passively observes the page's own relevant network responses to detect failures; it does not initiate H2S API requests.

Read and follow [Holland2Stay's terms](https://www.holland2stay.com/terms-and-conditions). An assistance purpose or this project's license does not grant permission from the website operator. There is no universally safe refresh frequency: use a conservative interval, increase it if necessary, and stop if access is restricted. Do not use the script to evade a restriction.

## Install and start

1. Install [Tampermonkey](https://www.tampermonkey.net/) in a supported desktop browser. Node.js and Python are **not** required to use the script.
2. Create a userscript, replace its entire contents with [`h2s-monitor.user.js`](h2s-monitor.user.js), and save. **Immediately disable it in Tampermonkey before visiting H2S.**
3. Open [Holland2Stay residences](https://www.holland2stay.com/residences) normally, keep the website in **English**, and manually complete any verification or login.
4. Enable the script in Tampermonkey, then refresh the page. Confirm the panel shows **v1.4.0**.
5. Use the panel's target-city link to open your configured cities with **Available to book** selected. You may also select a subset of those cities yourself; leaving City empty is supported, with local city filtering. Extra site filters are deliberately rejected when the scan cannot verify their scope.
6. Set up Telegram below, and import your settings if you want to change the defaults. Keep just one monitoring tab on the same site origin.

The script starts checking when enabled, the page is ready, and the configured active window permits it. It does not turn itself on in Tampermonkey. Outside the active window, use **立即检查（允许在夜间手动执行）** for a manual check.

**Upgrading an existing installation:** replace the contents of the existing script rather than creating a second copy. Its original userscript name, namespace, storage prefix, Telegram credentials, saved rent budget, and notification history are retained. Do not clear history or force a resend for a normal update. The installed name remains “H2S — Den Haag housing monitor” for compatibility, even when you configure other cities.

## Configure your search

Copy [`config.example.json`](config.example.json), edit it locally, and use **导入配置 JSON / Import settings JSON** in the Tampermonkey menu to paste the complete JSON file contents. Import it while the script is idle; a valid import saves the settings locally and reloads the page. **导出配置 JSON / Export settings JSON** exports your current search settings without Telegram credentials or notification history.

| Setting | Default | Meaning |
| --- | --- | --- |
| `cities` | The Hague, Rijswijk, Rotterdam, Leiden, Zoetermeer | Official city names and filter IDs; add or remove entries |
| `maxRent` | `1000` | Monthly base rent in euros, excluding service costs and other charges |
| `activeHours` | `07:00`–`23:00`, `Europe/Amsterdam` | Local start/end times and IANA time zone; overnight windows supported |
| `refreshMinutes` | `[5, 10]` | Minimum/maximum interval after a completed scan |

See the [configuration guide](docs/configuration.md) for the full format, how to get another city's ID, validation, and migration. Settings are stored in Tampermonkey on your device; the script does not fetch a remote configuration file. Budget does not mean all-in housing cost, and the script does not assess rent allowance, income, student status, or rental eligibility.

## Telegram setup

1. Create a bot with the official [@BotFather](https://t.me/BotFather) and copy its token.
2. Open a private chat with your bot and send `/start`.
3. On the H2S page, open Tampermonkey's menu and choose **配置 Telegram Token**.
4. Choose **自动获取 Chat ID（配对）**. Send the exact `h2s-...` pairing text to your bot, then confirm the prompt. Alternatively, enter the Chat ID manually.
5. Choose **测试 Telegram** and confirm you receive the test message.

The interface currently uses Chinese labels; these are the main controls:

| Menu label | Action |
| --- | --- |
| 打开配置城市可订房源 / Open configured cities | Open your configured city filters |
| 配置 Telegram Token | Save your bot token locally |
| 自动获取 Chat ID（配对） | Pair your private Telegram chat |
| 手动配置 Chat ID | Enter a chat ID manually |
| 测试 Telegram | Send a test message |
| 设置预算（主租金上限） | Change the saved base-rent limit |
| 立即检查（允许在夜间手动执行） | Check now, including outside active hours |
| 暂停 / 恢复 | Pause or resume monitoring |
| 恢复故障暂停并立即检查 | Retry after addressing a repeated scan failure |
| 恢复接口暂停（验证完成后） | Resume after manually resolving verification/access trouble; still observes cooldowns |
| 查看历史 | View recent local listing/notification history |

Tokens and chat IDs are stored in Tampermonkey, not in this repository or exported search settings. Notifications send matching listing details to Telegram. Do not post credentials, private configuration, account pages, or unsanitized browser exports in issues. See [security and privacy](SECURITY.md).

## Limits and troubleshooting

- **Cloudflare or access denied:** stop, disable the script, and resolve the website's prompt yourself. Only re-enable after normal access works. Use the recovery menu when a saved network hold remains. No control bypasses a server cooldown or challenge.
- **No alerts:** verify Telegram with its test menu, confirm the active hours, and inspect the panel for filter, budget, sorting, or pause messages. No match is different from an incomplete scan.
- **Website changed or loaded too slowly:** the script can decline to mark a scan complete rather than silently treat an unreadable page as empty. Repeated scan failures pause monitoring.
- **Background tabs and sleep:** browser throttling, suspension, lost connectivity, or a sleeping computer can delay or prevent checks. Listings may disappear between checks. A Telegram response lost in transit can also cause a duplicate on retry.
- **Eligibility and totals:** only the displayed base rent and direct-booking status are checked. Review the actual listing, fees, eligibility, and availability yourself.

## Development and verification

Use Node.js **20.19+**; CI runs the offline suite on **Node.js 22 and 24**:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

The status badge links to actual GitHub Actions runs; it is not a manually maintained “tests passed” claim. Tests simulate H2S pages, time, navigation, locks, and Telegram. They check parsing, price/city scope, history, retries, pauses, and configuration without accessing the live website or sending real messages. Passing them is **not** live H2S/Tampermonkey end-to-end verification.

Historical release notes and the old v1.3.5 Chromium report are under [`docs/archive/`](docs/archive/). That report does not validate the current version; the legacy Python browser runner is not part of CI. See [CONTRIBUTING.md](CONTRIBUTING.md) before changing behavior.

## License and attribution

Project-authored code and documentation are provided under the [MIT License](LICENSE). Holland2Stay and Telegram names belong to their respective owners; this project is not affiliated with or endorsed by them. Current fixtures use minimal synthetic markup and invented listing data; see [fixture provenance](docs/fixture-provenance.md) for their scope and historical context. The project license does not relicense third-party website content or override website terms.
