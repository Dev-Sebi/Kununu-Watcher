# kununu-watcher

Polls a Kununu company reviews page and sends a Discord notification whenever a
review is **posted** or **edited**. Runs as a single Docker container.

## How it works

1. Opens the configured Kununu reviews page in headless Chromium (Playwright) to
   clear the AWS WAF JS challenge, then reads reviews from Kununu's own JSON
   `reviews` middleware using the WAF cookie. A real browser is required — a
   plain HTTP fetch is blocked by the WAF.
2. Each review is keyed by its Kununu `uuid`, with the server's `updatedAt`
   timestamp stored in a small JSON file (`data/db.json`).
3. **First run seeds silently**: it pages through *all* reviews and records them
   without notifying, so you don't get spammed about existing reviews.
4. **Every later check reads only page 1.** New and recently-edited reviews
   always surface at the top, so page 1 is enough:
   - **uuid never seen** → new post → blue Discord embed.
   - **uuid seen but `updatedAt` changed** → edit → orange Discord embed.

## Quick start

```bash
git clone <repo>
cd kununu-watcher
cp .env.example .env   # then edit .env
docker compose up -d
```

That's it. Logs: `docker compose logs -f`. Stop: `docker compose down`.

The JSON db is persisted to `./data/` on the host via a volume, so it survives
restarts and rebuilds.

## Configuration (`.env`)

| Var | Description |
|---|---|
| `KUNUNU_NAME` | Company display name |
| `KUNUNU_URL` | **Required.** Full URL to the Kununu reviews page |
| `KUNUNU_BASE_URL` | Base for relative links (default `https://www.kununu.com`) |
| `DISCORD_WEBHOOK` | **Required.** Discord webhook URL |
| `DISCORD_USER_ID` | Discord user ID to ping (optional) |
| `EMBED_COLOR_NEW` | Embed color for new posts (hex) |
| `EMBED_COLOR_UPDATE` | Embed color for edits (hex) |
| `DB_PATH` | JSON db path (forced to the volume in Docker) |
| `CHECK_INTERVAL_MS` | Check frequency (default 300000 = 5 min) |
| `RETRY_MS` | Wait after an error (default 60000 = 1 min) |
| `PAGE_TIMEOUT_MS` | Max wait for page incl. WAF challenge + render (default 45000) |

## Run without Docker

```bash
pnpm install
pnpm exec playwright install --with-deps chromium
cp .env.example .env   # edit it
pnpm start
```

Requires Node.js >= 18. Docker is the easier path — the image already bundles
Chromium and its system libraries.
