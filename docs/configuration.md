# Search configuration

[Back to the README](../README.md) · [中文说明](README.zh-CN.md)

Start from [`config.example.json`](../config.example.json). This is a complete settings document, not a remote URL or a partial patch. Keep your edited copy outside the repository or name it `config.local.json`, which is ignored by Git.

## Import and export

1. Edit your local JSON file in a text editor.
2. Wait until scanning and message delivery have finished.
3. Open the Tampermonkey menu on the H2S page and choose **导入配置 JSON / Import settings JSON**.
4. Paste the entire file contents and confirm. A valid import saves locally and reloads the current page. If the new cities differ from the currently selected website filters, use the panel's target-city link after reload.
5. Choose **导出配置 JSON / Export settings JSON** to download the current settings as `h2s-config.json`. Allow the download if your browser asks.

The script never fetches settings from GitHub or another server. Telegram tokens, Chat IDs, pauses, cooldowns, and listing/notification history are not exported or overwritten by a settings import. Treat search settings as personal preferences even though they contain no authentication credentials.

## Format

```json
{
  "schemaVersion": 1,
  "cities": [
    {"name": "The Hague", "id": "90"},
    {"name": "Rijswijk", "id": "6224"},
    {"name": "Zoetermeer", "id": "6088"},
    {"name": "Rotterdam", "id": "25"},
    {"name": "Leiden", "id": "6293"}
  ],
  "maxRent": 1000,
  "activeHours": {
    "start": "07:00",
    "end": "23:00",
    "timeZone": "Europe/Amsterdam"
  },
  "refreshMinutes": [5, 10]
}
```

| Field | Accepted value |
| --- | --- |
| `schemaVersion` | The number `1` |
| `cities` | 1–100 unique city entries with official `name` and positive numeric-string `id` |
| `maxRent` | A positive number up to `100000`, with at most two decimal places |
| `activeHours.start`, `activeHours.end` | `HH:MM` in 24-hour time; the two times must differ |
| `activeHours.timeZone` | A valid IANA time-zone name supported by the browser |
| `refreshMinutes` | Two numbers from `1` to `1440`, in increasing or equal order |

Use JSON numbers for rent and intervals, strings for city IDs and times, and no comments or trailing commas. Unsupported schema versions, unknown fields, duplicate cities, invalid times/time zones, and malformed JSON are rejected. Validation finishes before settings are written, so a rejected import does not partially apply.

The refresh minimum is a technical validation bound, **not a recommended interval or evidence of website permission**. The default remains 5–10 minutes. The refresh timer begins after a complete scan, so it is not a guarantee of a check at exact wall-clock intervals. Pauses and server retry delays take precedence.

## Add another city

1. With the script disabled, open H2S normally and complete any verification yourself.
2. Select the city using the website's own City filter.
3. Inspect the address bar. A decoded filter looks like `city[filter]=The Hague,90` (the URL may percent-encode punctuation and spaces).
4. Copy the official city name and ID into a `cities` entry. Do not infer or guess the ID from a city name.
5. After importing, use the generated target-city link. The script verifies that the URL and selected page filters agree before scanning.

The example IDs came from the existing project configuration; website changes can invalidate them. New cities are configurable, but they have not all been validated against the live site. “Den Haag” and “The Hague” are treated as aliases when matching listings; prefer the website's own name in the configuration.

You can select a subset of your configured cities on the website. With City empty, the script reads the available listing pages and filters matches to your configured cities locally. Mixing in an unconfigured city or an unsupported extra filter stops the scan rather than broadening your requested scope silently.

## Hours and time zones

The start is inclusive and the end is exclusive. For example, `07:00`–`23:00` runs at 07:00 and pauses at 23:00. A window such as `22:30`–`06:00` spans midnight. `Europe/Amsterdam` uses the browser's time-zone rules, including daylight-saving changes.

Equal start and end times are rejected rather than ambiguously meaning either “off” or “all day.” Manual **立即检查（允许在夜间手动执行）** remains available outside the configured window. Manual checks still respect verification/access holds and rate-limit waits.

## Existing installations

The existing userscript identity and local storage prefix remain unchanged. If you have a saved budget from an older version, it takes precedence over the default when loading settings for the first time. Importing a complete configuration deliberately replaces search preferences, including the rent budget. The existing budget menu remains available and keeps the current settings consistent.

A settings import clears old scan summaries and one-off forced-resend/silent-baseline flags so the next scan uses the new scope. It retains individual listing and successful-notification history. A normal upgrade or settings import does not clear that notification history, reset successful alerts, unpause a manual pause, or remove a network cooldown. Changes in cities or budget affect eligibility during the next complete scan. There is no need to clear history or force resend just to upgrade.

If saved settings are invalid, the script pauses rather than silently searching with defaults. If another open tab changes the settings, refresh this tab before continuing; it pauses to avoid mixing old and new preferences.
