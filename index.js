import "dotenv/config";
import axios from "axios";
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import dayjs from "dayjs";

// ── Required env guard ──────────────────────────────────────────────────────────
for (const name of ["KUNUNU_URL", "DISCORD_WEBHOOK"]) {
  if (!process.env[name]) {
    console.error(`❌ Missing required env var: ${name}`);
    process.exit(1);
  }
}

const BASE_URL = process.env.KUNUNU_BASE_URL || "https://www.kununu.com";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
};

// Only used to confirm the AWS WAF challenge has cleared and to read the
// profile UUID out of a rendered review permalink. All review data itself
// comes from the JSON middleware, not the HTML.
const REVIEW_CARD = "article[data-testid^='review-']";
const STATEMENTS_LINK = "a[href*='/statements/']";

// ── Database (lowdb-style JSON file) ────────────────────────────────────────────
//
// Shape: { seeded: boolean, reviews: { [uuid]: { updatedAt, createdAt, title, score, url } } }
//   - seeded  : true once the first run has recorded every existing review silently
//   - reviews : every review ever seen, keyed by its Kununu uuid. updatedAt is the
//               server's own edit timestamp, so a changed updatedAt = the review
//               was edited; an unknown uuid = a brand-new review.

const DEFAULT_DB = { seeded: false, reviews: {} };

function dbPath() {
  return process.env.DB_PATH || "./data/db.json";
}

async function loadDB() {
  try {
    const parsed = JSON.parse(await fs.readFile(dbPath(), "utf-8"));
    return { ...DEFAULT_DB, ...parsed, reviews: parsed.reviews || {} };
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(`📁 No database found — creating ${dbPath()}`);
      return { ...DEFAULT_DB };
    }
    console.error("Error loading database:", error.message);
    return { ...DEFAULT_DB };
  }
}

async function saveDB(data) {
  try {
    await fs.mkdir(path.dirname(dbPath()), { recursive: true });
    await fs.writeFile(dbPath(), JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Error saving database:", error.message);
  }
}

// What we persist per review
const snapshot = (r) => ({
  updatedAt: r.updatedAt,
  createdAt: r.createdAt,
  title: r.title,
  score: r.score,
  url: r.url,
});

// ── Kununu access ───────────────────────────────────────────────────────────────

// Pull country + company slug out of the configured reviews URL,
// e.g. https://www.kununu.com/de/stortrec/kommentare -> { country: "de", slug: "stortrec" }
function parseTarget(url) {
  const seg = new URL(url).pathname.split("/").filter(Boolean);
  return { country: seg[0] || "de", slug: seg[1] || "" };
}

// JSON middleware that backs the "load more reviews" button — page 1..pagesCount
function reviewsApiUrl(country, slug, uuid, page) {
  return `${BASE_URL}/middlewares/profiles/${country}/${slug}/${uuid}/reviews?fetchFactorScores=0&reviewType=employees&urlParams=&page=${page}`;
}

// Normalize a raw API review object
function mapReview(raw, country, profileUuid) {
  return {
    id: raw.uuid,
    title: raw.title || "Untitled",
    score: typeof raw.score === "number" ? raw.score.toFixed(1) : "N/A",
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt || raw.createdAt,
    url: `${BASE_URL}/${country}/statements/${profileUuid}/review/${raw.uuid}`,
  };
}

// Open a browser, clear the WAF challenge, and return a JSON page fetcher that
// reuses the WAF cookies. Caller must close the returned browser.
async function openSession() {
  const { country, slug } = parseTarget(process.env.KUNUNU_URL);
  const pageTimeout = Number.parseInt(process.env.PAGE_TIMEOUT_MS || "45000");

  const browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  let context, page, profileUuid;
  try {
    context = await browser.newContext({
      userAgent: HEADERS["User-Agent"],
      locale: "de-DE",
      extraHTTPHeaders: { "Accept-Language": HEADERS["Accept-Language"] },
    });
    page = await context.newPage();

    await page.goto(process.env.KUNUNU_URL, {
      waitUntil: "domcontentloaded",
      timeout: pageTimeout,
    });
    // Review cards rendering = WAF challenge cleared + cookies set.
    await page.waitForSelector(REVIEW_CARD, { timeout: pageTimeout });

    const href = await page
      .$eval(STATEMENTS_LINK, (el) => el.getAttribute("href"))
      .catch(() => null);
    const match = href && href.match(/\/statements\/([0-9a-f-]{36})\//i);
    if (!match)
      throw new Error("Could not determine profile UUID from the page");
    profileUuid = match[1];

    // WAF cleared, cookies live on `context`, UUID extracted. The tab is done —
    // every review fetch from here uses context.request, not a page. Close it so
    // we don't keep a renderer process alive for the session's whole lifetime.
    await page.close();
    page = null;
  } catch (error) {
    // Setup failed after launch — close the browser so it doesn't leak.
    await browser.close().catch(() => {});
    throw error;
  }

  async function fetchPage(n) {
    const res = await context.request.get(
      reviewsApiUrl(country, slug, profileUuid, n),
      { headers: { accept: "application/json" } },
    );
    if (res.status() !== 200) {
      throw new Error(`reviews API page ${n} returned HTTP ${res.status()}`);
    }
    const json = await res.json();
    return {
      reviews: (json.reviews || []).map((r) =>
        mapReview(r, country, profileUuid),
      ),
      pagesCount: json.pagesCount || 1,
      totalReviews: json.totalReviews ?? null,
    };
  }

  return { browser, fetchPage };
}

// Walk every page of reviews (used once, for seeding)
async function fetchAllReviews(fetchPage) {
  const first = await fetchPage(1);
  const all = [...first.reviews];
  for (let n = 2; n <= first.pagesCount; n++) {
    const { reviews } = await fetchPage(n);
    if (!reviews.length) break;
    all.push(...reviews);
  }
  return all;
}

// ── Discord ───────────────────────────────────────────────────────────────────

// kind: "new" | "update"
async function sendDiscordNotification(review, kind) {
  const isUpdate = kind === "update";
  const label = isUpdate ? "Updated" : "New";
  const pingVerb = isUpdate
    ? "A Kununu review was updated"
    : "New review on Kununu";
  const stamp = isUpdate ? review.updatedAt : review.createdAt;

  try {
    await axios.post(process.env.DISCORD_WEBHOOK, {
      content: process.env.DISCORD_USER_ID
        ? `<@${process.env.DISCORD_USER_ID}> ${pingVerb}!`
        : undefined,
      embeds: [
        {
          title: `${label} Kununu Rating for ${process.env.KUNUNU_NAME || "Unknown Company"}`,
          url: review.url,
          color: isUpdate
            ? Number.parseInt(process.env.EMBED_COLOR_UPDATE || "0xf9a826")
            : Number.parseInt(process.env.EMBED_COLOR_NEW || "0x00b4d8"),
          fields: [
            {
              name: "⭐ Rating",
              value: `**${review.score}** / 5`,
              inline: true,
            },
            {
              name: "🗓 Date",
              value: dayjs(stamp).isValid()
                ? dayjs(stamp).format("DD.MM.YYYY")
                : String(stamp),
              inline: true,
            },
            { name: "📌 Title", value: review.title, inline: false },
          ],
          footer: {
            text: `${process.env.KUNUNU_NAME || "Unknown Company"} • ${isUpdate ? "edited" : "new post"}`,
          },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  } catch (error) {
    console.error("Error sending Discord notification:", error.message);
  }
}

// ── One check cycle ─────────────────────────────────────────────────────────────

async function runCycle(fetchPage) {
  const db = await loadDB();

  // First run: record every review across all pages silently, so we don't
  // spam every existing review. From then on we only watch page 1, where the
  // newest and most-recently-edited reviews always surface.
  if (!db.seeded) {
    console.log(
      `🌱 Seeding existing review(s) across all pages — please wait...`,
    );
    const all = await fetchAllReviews(fetchPage);
    for (const r of all) db.reviews[r.id] = snapshot(r);
    db.seeded = true;
    await saveDB(db);
    console.log(
      `🌱 Seeded ${all.length} existing review(s) across all pages — watching page 1 from now on`,
    );
    return;
  }

  const { reviews } = await fetchPage(1);
  if (!reviews.length) {
    console.log("⚠️  Page 1 returned no reviews — skipping this cycle");
    return;
  }

  let changes = 0;
  // Oldest first so notifications arrive in chronological order.
  for (const r of [...reviews].reverse()) {
    const known = db.reviews[r.id];

    if (!known) {
      console.log(`✨ New review: "${r.title}"`);
      await sendDiscordNotification(r, "new");
      changes++;
    } else if (known.updatedAt !== r.updatedAt) {
      console.log(`📝 Updated review: "${r.title}"`);
      await sendDiscordNotification(r, "update");
      changes++;
    }

    db.reviews[r.id] = snapshot(r);
  }

  if (changes === 0) console.log("✅ No new or updated reviews");
  await saveDB(db);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

(async () => {
  const interval = Number.parseInt(process.env.CHECK_INTERVAL_MS || "300000");
  const retry = Number.parseInt(process.env.RETRY_MS || "60000");

  console.log(
    `⭐ Kununu Watcher — ${process.env.KUNUNU_NAME || "Unknown Company"}`,
  );
  console.log(
    `Polling ${process.env.KUNUNU_URL} every ${interval / 60000} min\n`,
  );

  // Reused across cycles. A failed cycle tears it down so the next one
  // relaunches with a fresh WAF challenge; a healthy session keeps its cookies.
  let session = null;
  const closeSession = async () => {
    if (session) {
      await session.browser.close().catch(() => {});
      session = null;
    }
  };

  // Close the browser on shutdown so we don't orphan a chromium process.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
      await closeSession();
      process.exit(0);
    });
  }

  while (true) {
    try {
      console.log(`[${new Date().toLocaleTimeString()}] Checking...`);
      if (!session) session = await openSession();
      await runCycle(session.fetchPage);
      console.log(`Waiting ${interval / 60000} minutes...\n`);
      await new Promise((r) => setTimeout(r, interval));
    } catch (error) {
      console.error("Error during check:", error.message);
      // Drop the session so the next attempt starts clean.
      await closeSession();
      console.log(`Retrying in ${retry / 1000} seconds...\n`);
      await new Promise((r) => setTimeout(r, retry));
    }
  }
})();
