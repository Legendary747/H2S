# Security and privacy

## Local and external data

- Search preferences, Telegram credentials, notification history, and pause/cooldown state are stored in Tampermonkey's local userscript storage.
- Search-settings export excludes the Telegram bot token, Chat ID, and listing/notification history.
- When configured, Telegram receives the listing information included in alerts. The bot token is used in requests to Telegram's API.
- The script reads the open H2S listing page and passively observes relevant network responses for access/limit handling. It does not provide a background server or analytics service.

A browser profile export or Tampermonkey backup may still contain secrets. Treat it as sensitive even though a search-settings JSON export has no authentication fields. Never commit personal config files, tokens, chat IDs, cookies, full account pages, or browser storage exports.

## Reporting a vulnerability

Do not include credentials or private data in a public issue. Use GitHub's private **Report a vulnerability** flow if it is enabled for this repository. If no private channel is available, open an issue asking for a private reporting channel without disclosing exploit details or sensitive data.

If you accidentally exposed a Telegram bot token, revoke or rotate it through BotFather and update the local script configuration. Removing the latest copy does not invalidate old copies in history, logs, or caches.

## Access controls

This project does not implement CAPTCHA solving, Cloudflare bypass, automatic booking, or access-restriction evasion. On a challenge or access restriction, stop the script and resolve access manually through the website. A recovery control does not grant permission to access the site and must not be used to evade its limits.
