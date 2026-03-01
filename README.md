# kununu-watcher

Polls a Kununu company reviews page and sends a Discord notification whenever a new review appears.

## How it works

1. Scrapes the configured Kununu reviews page on a fixed interval
2. Compares the latest review against the last seen ID (stored in `db.json`)
3. If a new review is found, posts a Discord embed via webhook

## Setup

```bash
pnpm install
```

Edit the `CONFIG` block at the top of `index.js`:

| Field | Description |
|---|---|
| `name` | Company display name |
| `url` | Full URL to the Kununu reviews page |
| `webhook` | Discord webhook URL |
| `userId` | Discord user ID to ping (optional) |
| `interval` | Check frequency in ms (default: 5 min) |

## Run

```bash
pnpm start
```

The script runs indefinitely. On error it waits `retry` ms before trying again.

## Requirements

- Node.js >= 18
