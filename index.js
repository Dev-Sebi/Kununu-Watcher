import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import crypto from "crypto";
import dayjs from "dayjs";

// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
  name: "Test GmbH",
  url: "https://www.kununu.com/de/test/kommentare",
  baseUrl: "https://www.kununu.com",

  webhook:
    "https://discord.com/api/webhooks/1477653872775401728/YOUR_WEBHHOOK_URL",
  userId: "", // Discord user ID to ping — leave empty to disable
  color: 0x00b4d8,

  db: "./db.json",
  interval: 5 * 60 * 1000, // how often to check (ms)
  retry: 60 * 1000, // how long to wait after an error (ms)
  timeout: 15_000, // HTTP request timeout (ms)

  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Cache-Control": "no-cache",
  },

  // CSS selectors — update these if Kununu changes its layout
  selectors: {
    card: "article[data-testid^='review-']",
    title: "h3",
    score: "span[class*='score']",
    date: "time[datetime]",
    link: "a[href]",
  },
};

// ── Database ──────────────────────────────────────────────────────────────────

// Create db.json if it doesn't exist yet
async function initDB() {
  try {
    await fs.access(CONFIG.db);
  } catch {
    console.log(`📁 No database found — creating ${CONFIG.db}`);
    await saveDB({ lastRatingId: null });
  }
}

// Load the database
async function loadDB() {
  try {
    const data = await fs.readFile(CONFIG.db, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Error loading database:", error.message);
    return { lastRatingId: null };
  }
}

// Save the database
async function saveDB(data) {
  try {
    await fs.writeFile(CONFIG.db, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Error saving database:", error.message);
  }
}

// ── Scraping ──────────────────────────────────────────────────────────────────

// Build a stable ID for a rating — prefer the permalink, fall back to a hash
function buildId(href, title, date) {
  if (href) return href;
  return crypto
    .createHash("sha1")
    .update(`${title}|${date}`.toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

// Fetch the ratings page and return the newest review
async function scrapeLatestRating() {
  const { data: html } = await axios.get(CONFIG.url, {
    headers: CONFIG.headers,
    timeout: CONFIG.timeout,
    maxRedirects: 5,
  });

  const $ = cheerio.load(html);
  const sel = CONFIG.selectors;
  const card = $(sel.card).first();

  if (!card.length) {
    console.warn("⚠️  No review card found — selectors may need updating");
    return null;
  }

  const title = card.find(sel.title).first().text().trim() || "Untitled";

  const scoreRaw = card.find(sel.score).first().text().trim();
  const score = scoreRaw.replace(",", ".") || "N/A";

  const timeEl = card.find(sel.date).first();
  const date =
    timeEl.attr("datetime") || timeEl.text().trim() || "Unknown date";

  const hrefRaw = card.find(sel.link).first().attr("href") || "";
  const url = hrefRaw.startsWith("http")
    ? hrefRaw
    : hrefRaw
      ? `${CONFIG.baseUrl}${hrefRaw}`
      : CONFIG.url;

  const id = buildId(hrefRaw || null, title, date);

  return { id, title, score, date, url };
}

// ── Discord ───────────────────────────────────────────────────────────────────

// Send a Discord embed for a new rating
async function sendDiscordNotification(rating) {
  try {
    await axios.post(CONFIG.webhook, {
      content: CONFIG.userId
        ? `<@${CONFIG.userId}> New review on Kununu!`
        : undefined,
      embeds: [
        {
          title: `New Kununu Rating for ${CONFIG.name}`,
          url: rating.url,
          color: CONFIG.color,
          fields: [
            {
              name: "⭐ Rating",
              value: `**${rating.score}** / 5`,
              inline: true,
            },
            {
              name: "🗓 Date",
              value: dayjs(rating.date).format("DD.MM.YYYY"),
              inline: true,
            },
            { name: "📌 Title", value: rating.title, inline: false },
          ],
          footer: { text: CONFIG.name },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  } catch (error) {
    console.error("Error sending Discord notification:", error.message);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

(async () => {
  console.log(`⭐ Kununu Watcher — ${CONFIG.name}`);
  console.log("Starting infinite loop...\n");

  await initDB();

  while (true) {
    try {
      console.log(`[${new Date().toLocaleTimeString()}] Checking...`);

      const rating = await scrapeLatestRating();

      if (!rating) {
        console.log("⚠️  Could not extract a rating — skipping this cycle");
      } else {
        const db = await loadDB();

        if (rating.id === db.lastRatingId) {
          console.log(`✅ No new rating (last: ${rating.id})`);
        } else {
          console.log(`✨ New rating found: "${rating.title}"`);
          await sendDiscordNotification(rating);
          await saveDB({ lastRatingId: rating.id });
        }
      }

      console.log(`Waiting ${CONFIG.interval / 60000} minutes...\n`);
      await new Promise((resolve) => setTimeout(resolve, CONFIG.interval));
    } catch (error) {
      console.error("Error during scraping:", error.message);
      if (error.response) console.error(`HTTP ${error.response.status}`);
      console.log(`Retrying in ${CONFIG.retry / 1000} seconds...\n`);
      await new Promise((resolve) => setTimeout(resolve, CONFIG.retry));
    }
  }
})();
