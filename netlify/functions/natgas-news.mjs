import { getStore } from "@netlify/blobs";
import * as cheerio from "cheerio";

const FEED_URL =
  process.env.MARKETSCREENER_URL ||
  "https://in.marketscreener.com/news/commodities/";

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const TELEGRAM_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
  process.env.TELEGRAM_CHAT_ID;

const GROQ_KEYS = [
  process.env.GROQ_KEY_1,
  process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3,
  process.env.GROQ_KEY_4,
  process.env.GROQ_KEY_5,
].filter(Boolean);

const GROQ_MODEL =
  process.env.GROQ_MODEL ||
  "openai/gpt-oss-20b";

// Only inspect the newest 20 articles
const MAX_LISTING_ARTICLES = 20;

// Maximum number of genuinely new articles
// processed in one run
const MAX_NEW_ARTICLES_PER_RUN =
  Number(
    process.env.MAX_NEW_ARTICLES_PER_RUN || 20
  );

// Only this much article text is sent to Groq
const CLASSIFIER_PREVIEW_CHARS =
  Number(
    process.env.CLASSIFIER_PREVIEW_CHARS || 600
  );

// Concurrent article-page requests
const MAX_CONCURRENT_ARTICLES =
  Number(
    process.env.MAX_CONCURRENT_ARTICLES || 5
  );

// Concurrent Groq requests
const MAX_CONCURRENT_LLM =
  Number(
    process.env.MAX_CONCURRENT_LLM || 5
  );

// Number of URLs remembered
const SEEN_LIMIT =
  Number(
    process.env.SEEN_LIMIT || 3000
  );

const SEED_ON_FIRST_RUN =
  (
    process.env.SEED_ON_FIRST_RUN ||
    "true"
  ).toLowerCase() === "true";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/151.0 Safari/537.36";

// ─────────────────────────────────────────────
// SOURCE DETECTION
// ─────────────────────────────────────────────

const SOURCE_CODES = {
  RE: "Reuters",
  DJ: "Dow Jones",
  AN: "Alliance News",
  MT: "MT Newswires",
};

// ─────────────────────────────────────────────
// LLM PROMPT
// ─────────────────────────────────────────────

const CLASSIFIER_PROMPT = `
You are a high-precision classifier for a US natural-gas market news alert system.

TASK:

Determine whether this article contains information that could plausibly have a MATERIAL impact on US natural-gas supply, demand, storage, flows, LNG, power burn, or pricing.

Return ONLY:

YES

or

NO

Mark YES when the article concerns a material development involving any of these areas:

1. US GAS SUPPLY
- US natural-gas production, forecasts, drilling, rigs, curtailments, shut-ins or producer guidance
- Major gas basins such as Permian, Haynesville, Marcellus and Utica
- Associated gas from US oil production
- Freeze-offs or other supply disruptions
- US gas pipelines, processing plants, compressors, constraints, outages or expansions

2. LNG
- US LNG exports, feedgas, terminals, outages, maintenance, commissioning, ramp-ups or expansions
- Major US LNG facilities
- Global LNG supply disruptions or major new capacity
- LNG shipping, vessel availability or major shipping-route disruptions
- Panama Canal, Suez Canal or other chokepoint disruptions affecting LNG
- Qatar or other major LNG suppliers when the event could materially affect global LNG flows or US LNG economics

3. US GAS DEMAND
- Weather events or forecasts that materially affect heating/cooling demand
- Power burn and gas-fired generation
- Major electricity-demand changes
- Coal-to-gas switching
- Large nuclear or coal plant outages
- Major industrial, residential or commercial gas-demand changes
- Large data-center or AI electricity-demand developments when relevant to gas-fired generation

4. STORAGE & FLOWS
- EIA storage reports, forecasts, revisions, injections or withdrawals
- Canada-US or Mexico-US gas flows
- Mexico demand for US pipeline gas
- Material changes in US gas imports/exports

5. GLOBAL / GEOPOLITICAL EVENTS
- Iran-US war, negotiations, sanctions or peace-deal developments when they could affect energy markets
- Strait of Hormuz disruptions, closures, reopening, military activity or shipping risks
- Middle East conflicts that could materially disrupt LNG, oil or global energy flows
- Russia-Ukraine developments affecting natural gas, LNG, pipelines or European energy supply
- European gas/TTF developments that could materially affect US LNG demand or global LNG pricing
- Major sanctions, tariffs, regulations or government policies affecting natural gas, LNG or energy trade

6. OIL
- OPEC+ or major oil-price developments ONLY when they could materially change US associated-gas production or US gas-market conditions

IMPORTANT:

The article does NOT need to mention "natural gas", "natgas" or LNG explicitly.

Indirect relevance must have a clear and plausible transmission mechanism to the US natural-gas market.

Do NOT mark YES merely because an article is about:
- oil
- geopolitics
- Iran
- Russia
- the Middle East
- Europe
- commodities
- electricity

unless there is a plausible MATERIAL connection to US natural gas.

Prefer precision over recall.

Return exactly one word:

YES

or

NO
`;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function absoluteUrl(href) {
  return new URL(
    href,
    FEED_URL
  ).href;
}

function isMarketScreenerUrl(url) {
  try {
    return new URL(url)
      .hostname
      .endsWith("marketscreener.com");
  } catch {
    return false;
  }
}

function isArticleUrl(url) {
  try {
    const u = new URL(url);

    return /^\/news\/[^?#]+/i.test(
      u.pathname
    );
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
// SOURCE DETECTION
// ─────────────────────────────────────────────

function detectSourceFromNearbyText(
  $,
  anchor
) {
  let node = anchor;

  for (
    let depth = 0;
    depth < 6 && node.length;
    depth++
  ) {
    const text = cleanText(
      node.text()
    );

    if (/\bReuters\b/i.test(text)) {
      return "Reuters";
    }

    if (/\bDow Jones\b/i.test(text)) {
      return "Dow Jones";
    }

    if (
      /\bAlliance News\b/i.test(text)
    ) {
      return "Alliance News";
    }

    if (
      /\bMT Newswires\b/i.test(text)
    ) {
      return "MT Newswires";
    }

    for (
      const [code, name]
      of Object.entries(
        SOURCE_CODES
      )
    ) {
      const regex = new RegExp(
        `(?:^|[\\s|])${code}(?:$|[\\s|])`,
        "i"
      );

      if (regex.test(text)) {
        return name;
      }
    }

    node = node.parent();
  }

  return "Unknown";
}

function detectSourceFromHtml(html) {
  if (/\bReuters\b/i.test(html)) {
    return "Reuters";
  }

  if (/\bDow Jones\b/i.test(html)) {
    return "Dow Jones";
  }

  if (
    /\bAlliance News\b/i.test(html)
  ) {
    return "Alliance News";
  }

  if (
    /\bMT Newswires\b/i.test(html)
  ) {
    return "MT Newswires";
  }

  return "Unknown";
}

// ─────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────

async function fetchHtml(url) {
  const response = await fetch(
    url,
    {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language":
          "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    }
  );

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} from ${url}`
    );
  }

  return response.text();
}

// ─────────────────────────────────────────────
// MARKETSCREENER LISTING SCRAPER
// ─────────────────────────────────────────────

async function scrapeListing() {
  const html =
    await fetchHtml(
      FEED_URL
    );

  const $ = cheerio.load(html);

  const articles = [];
  const seen = new Set();

  $("a[href]").each(
    (_, element) => {

      if (
        articles.length >=
        MAX_LISTING_ARTICLES
      ) {
        return false;
      }

      const href =
        $(element).attr("href");

      if (!href) {
        return;
      }

      let url;

      try {
        url =
          absoluteUrl(href);
      } catch {
        return;
      }

      if (
        !isMarketScreenerUrl(
          url
        )
      ) {
        return;
      }

      if (
        !isArticleUrl(url)
      ) {
        return;
      }

      if (
        seen.has(url)
      ) {
        return;
      }

      const title =
        cleanText(
          $(element).text()
        );

      if (
        title.length < 8
      ) {
        return;
      }

      seen.add(url);

      articles.push({
        title,
        url,
        source:
          detectSourceFromNearbyText(
            $,
            $(element)
          ),
      });
    }
  );

  console.log(
    "===== ARTICLES SCRAPED ====="
  );

  articles.forEach(
    (article, index) => {
      console.log(
        `${index + 1}. [${article.source}] ${article.title}`
      );

      console.log(
        `   ${article.url}`
      );
    }
  );

  console.log(
    "============================"
  );

  return articles;
}

// ─────────────────────────────────────────────
// ARTICLE EXTRACTION
// ─────────────────────────────────────────────

function extractArticleBody(
  html
) {
  const $ =
    cheerio.load(html);

  $(
    "script, style, nav, header, footer, form, noscript, svg"
  ).remove();

  const candidates = [
    $("article"),
    $("main"),
    $('[class*="article"]'),
    $('[class*="Article"]'),
    $('[class*="story"]'),
  ];

  for (
    const candidate
    of candidates
  ) {
    if (
      !candidate.length
    ) {
      continue;
    }

    const text =
      cleanText(
        candidate
          .first()
          .text()
      );

    if (
      text.length >= 300
    ) {
      return text;
    }
  }

  return cleanText(
    $("body").text()
  );
}

async function enrichArticle(
  article
) {
  try {
    const html =
      await fetchHtml(
        article.url
      );

    let source =
      article.source;

    if (
      source === "Unknown"
    ) {
      source =
        detectSourceFromHtml(
          html
        );
    }

    const body =
      extractArticleBody(
        html
      );

    return {
      ...article,
      source,
      body,
    };
  } catch (error) {
    console.warn(
      `Could not fetch article: ${article.url} — ${error.message}`
    );

    return {
      ...article,
      body: article.title,
      fetchFailed: true,
    };
  }
}

// ─────────────────────────────────────────────
// CONCURRENCY
// ─────────────────────────────────────────────

async function mapWithConcurrency(
  items,
  limit,
  worker
) {
  const results =
    new Array(
      items.length
    );

  let next = 0;

  async function runner() {
    while (true) {
      const index =
        next++;

      if (
        index >=
        items.length
      ) {
        return;
      }

      try {
        results[index] =
          await worker(
            items[index],
            index
          );
      } catch (error) {
        results[index] = {
          error,
        };
      }
    }
  }

  const workers =
    Math.min(
      limit,
      items.length
    );

  await Promise.all(
    Array.from(
      {
        length: workers,
      },
      runner
    )
  );

  return results;
}

// ─────────────────────────────────────────────
// GROQ KEY ROTATION
// ─────────────────────────────────────────────

let keyCursor = 0;

function nextGroqKey() {
  if (
    !GROQ_KEYS.length
  ) {
    throw new Error(
      "No GROQ_KEY_1...GROQ_KEY_5 environment variables configured."
    );
  }

  const key =
    GROQ_KEYS[
      keyCursor %
        GROQ_KEYS.length
    ];

  keyCursor++;

  return key;
}

// ─────────────────────────────────────────────
// GROQ CLASSIFICATION
// ─────────────────────────────────────────────

async function classifyWithGroq(
  article
) {
  const apiKey =
    nextGroqKey();

  // Only send the first 600 characters
  // of the article body.
  const preview =
    cleanText(
      article.body
    ).slice(
      0,
      CLASSIFIER_PREVIEW_CHARS
    );

  const response =
    await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${apiKey}`,
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          model:
            GROQ_MODEL,

          temperature: 0,

          reasoning_effort:
            "low",

          include_reasoning:
            false,

          max_completion_tokens:
            256,

          response_format: {
            type: "json_schema",

            json_schema: {
              name:
                "natgas_relevance",

              strict: true,

              schema: {
                type: "object",

                properties: {
                  relevant: {
                    type: "boolean",
                  },
                },

                required: [
                  "relevant",
                ],

                additionalProperties:
                  false,
              },
            },
          },

          messages: [
            {
              role: "system",
              content:
                CLASSIFIER_PROMPT,
            },

            {
              role: "user",

              content:
                `TITLE:\n${article.title}\n\n` +
                `SOURCE:\n${article.source}\n\n` +
                `ARTICLE PREVIEW:\n${preview}`,
            },
          ],
        }),
      }
    );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `Groq HTTP ${response.status}: ${body.slice(
        0,
        500
      )}`
    );
  }

  const data =
    await response.json();

  const content =
    data?.choices?.[0]
      ?.message?.content;

  if (!content) {
    throw new Error(
      `Groq returned empty content. ` +
      `finish_reason=${JSON.stringify(
        data?.choices?.[0]
          ?.finish_reason
      )}`
    );
  }

  let parsed;

  try {
    parsed =
      JSON.parse(content);
  } catch {
    throw new Error(
      `Invalid Groq JSON: ${content}`
    );
  }

  if (
    typeof parsed.relevant !==
    "boolean"
  ) {
    throw new Error(
      `Invalid classifier response: ${content}`
    );
  }

  return parsed.relevant;
}

// ─────────────────────────────────────────────
// TELEGRAM
// ─────────────────────────────────────────────

async function sendTelegram(
  article
) {
  const isReuters =
    article.source ===
    "Reuters";

  const header =
    isReuters
      ? "🚨 <b>REUTERS — NATGAS RELEVANT</b>"
      : "🟢 <b>NATGAS RELEVANT</b>";

  const text = [
    header,
    "",
    `<b>${escapeHtml(
      article.title
    )}</b>`,
    "",
    `Source: ${escapeHtml(
      article.source
    )}`,
    `<a href="${escapeHtml(
      article.url
    )}">Open article on MarketScreener</a>`,
  ].join("\n");

  const response =
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json",
        },

        body: JSON.stringify({
          chat_id:
            TELEGRAM_CHAT_ID,

          text,

          parse_mode:
            "HTML",

          disable_web_page_preview:
            false,
        }),
      }
    );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `Telegram HTTP ${response.status}: ${body}`
    );
  }
}

// ─────────────────────────────────────────────
// NETLIFY BLOBS
// ─────────────────────────────────────────────

async function getSeen(
  store
) {
  const value =
    await store.get(
      "seen-urls",
      {
        type: "json",
      }
    );

  return Array.isArray(
    value
  )
    ? value
    : [];
}

async function saveSeen(
  store,
  urls
) {
  await store.setJSON(
    "seen-urls",
    urls.slice(
      -SEEN_LIMIT
    )
  );
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function run() {
  if (
    !TELEGRAM_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    throw new Error(
      "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID."
    );
  }

  if (
    !GROQ_KEYS.length
  ) {
    throw new Error(
      "Missing GROQ_KEY_1...GROQ_KEY_5."
    );
  }

  const store =
    getStore(
      "natgas-intel"
    );

  const seen =
    await getSeen(
      store
    );

  const seenSet =
    new Set(seen);

  console.log(
    `Scraping: ${FEED_URL}`
  );

  // Only latest 20
  const listing =
    await scrapeListing();

  console.log(
    `Latest articles found: ${listing.length}`
  );

  // ───────────────────────────────────────────
  // FIRST RUN
  // ───────────────────────────────────────────

  if (
    seen.length === 0 &&
    SEED_ON_FIRST_RUN
  ) {
    await saveSeen(
      store,
      listing.map(
        article =>
          article.url
      )
    );

    console.log(
      `Seeded ${listing.length} existing URLs. No Telegram alerts sent.`
    );

    return;
  }

  // ───────────────────────────────────────────
  // FIND NEW ARTICLES
  // ───────────────────────────────────────────

  const newArticles =
    listing
      .filter(
        article =>
          !seenSet.has(
            article.url
          )
      )
      .slice(
        0,
        MAX_NEW_ARTICLES_PER_RUN
      );

  if (
    !newArticles.length
  ) {
    console.log(
      "No new articles."
    );

    return;
  }

  console.log(
    `${newArticles.length} new article(s) detected.`
  );

  // ───────────────────────────────────────────
  // FETCH ARTICLE PAGES
  // ───────────────────────────────────────────

  const enriched =
    await mapWithConcurrency(
      newArticles,
      MAX_CONCURRENT_ARTICLES,
      enrichArticle
    );

  const validArticles =
    enriched.filter(
      article =>
        article &&
        !article.error
    );

  console.log(
    `Article pages fetched: ${validArticles.length}`
  );

  // ───────────────────────────────────────────
  // EVERY SOURCE GOES THROUGH GROQ
  // ───────────────────────────────────────────

  const classified =
    await mapWithConcurrency(
      validArticles,
      MAX_CONCURRENT_LLM,

      async article => {
        const relevant =
          await classifyWithGroq(
            article
          );

        return {
          ...article,
          relevant,
        };
      }
    );

  const successful =
    classified.filter(
      result =>
        result &&
        !result.error
    );

  const relevant =
    successful.filter(
      article =>
        article.relevant
    );

  console.log(
    `LLM classified: ${successful.length}`
  );

  console.log(
    `NATGAS relevant: ${relevant.length}`
  );

  // ───────────────────────────────────────────
  // TELEGRAM
  // ───────────────────────────────────────────

  const telegramSent =
    [];

  // Oldest first
  for (
    const article of [
      ...relevant,
    ].reverse()
  ) {
    try {
      await sendTelegram(
        article
      );

      telegramSent.push(
        article.url
      );

      if (
        article.source ===
        "Reuters"
      ) {
        console.log(
          `🚨 Reuters NATGAS sent: ${article.title}`
        );
      } else {
        console.log(
          `🟢 NATGAS sent: ${article.title}`
        );
      }
    } catch (error) {
      console.error(
        `Telegram failed for ${article.url}: ${error.message}`
      );
    }
  }

  // ───────────────────────────────────────────
  // SAVE PROCESSED ARTICLES
  // ───────────────────────────────────────────

  for (
    const article of successful
  ) {
    seenSet.add(
      article.url
    );
  }

  for (
    const url of telegramSent
  ) {
    seenSet.add(url);
  }

  await saveSeen(
    store,
    [...seenSet]
  );

  console.log(
    `Complete: ${successful.length} classified, ` +
      `${relevant.length} relevant, ` +
      `${telegramSent.length} Telegram alerts sent.`
  );
}

// ─────────────────────────────────────────────
// NETLIFY SCHEDULE
// ─────────────────────────────────────────────

export default async () => {
  await run();
};

export const config = {
  schedule:
    "*/4 * * * *",
};