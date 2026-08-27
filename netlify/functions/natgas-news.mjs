import { getStore } from "@netlify/blobs";
import * as cheerio from "cheerio";

const FEED_URL =
  process.env.MARKETSCREENER_URL ||
  "https://in.marketscreener.com/news/commodities/?cf=TkJRQzErSmNuWEVjbXI5RVVYWUtmUGxveklpbWtWaUxDV1pSWUlOMlpVND0";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const GROQ_KEYS = [
  process.env.GROQ_KEY_1,
  process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3,
  process.env.GROQ_KEY_4,
  process.env.GROQ_KEY_5,
].filter(Boolean);

const GROQ_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const MAX_LISTING_ARTICLES =
  Number(process.env.MAX_LISTING_ARTICLES || 80);

const MAX_NEW_ARTICLES_PER_RUN =
  Number(process.env.MAX_NEW_ARTICLES_PER_RUN || 25);

const MAX_CONCURRENT_ARTICLES =
  Number(process.env.MAX_CONCURRENT_ARTICLES || 5);

const MAX_CONCURRENT_LLM =
  Number(process.env.MAX_CONCURRENT_LLM || 5);

const ARTICLE_MAX_CHARS =
  Number(process.env.ARTICLE_MAX_CHARS || 12000);

const SEEN_LIMIT =
  Number(process.env.SEEN_LIMIT || 3000);

const SEED_ON_FIRST_RUN =
  (process.env.SEED_ON_FIRST_RUN || "true").toLowerCase() === "true";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/151.0 Safari/537.36";

const SOURCE_CODES = {
  RE: "Reuters",
  DJ: "Dow Jones",
  AN: "Alliance News",
  MT: "MT Newswires",
};

const CLASSIFIER_PROMPT = `
You classify financial news for a US natural-gas market alert system.

Question:
Could this article contain information that is materially relevant
to US natural gas markets, directly OR indirectly?

Consider:

- US natural-gas production
- associated gas
- Henry Hub
- US gas prices
- LNG exports
- LNG feedgas
- LNG terminals
- LNG outages and maintenance
- pipelines
- processing plants
- compressor issues
- EIA storage
- US weather affecting gas demand
- power burn
- electricity demand
- industrial gas demand
- residential/commercial gas demand
- US gas imports and exports
- hurricanes
- Gulf Coast energy infrastructure
- major US energy developments
- oil developments that can materially affect associated gas supply

Do NOT require the words "natural gas" or "natgas" to appear.

Return exactly one word:

YES

or

NO

Do not explain your answer.
`;

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
  return new URL(href, FEED_URL).href;
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

    return /^\/news\/[^?#]+/i.test(u.pathname);
  } catch {
    return false;
  }
}

function detectSourceFromNearbyText($, anchor) {
  let node = anchor;

  for (let depth = 0; depth < 6 && node.length; depth++) {
    const text = cleanText(node.text());

    if (/\bReuters\b/i.test(text)) {
      return "Reuters";
    }

    if (/\bDow Jones\b/i.test(text)) {
      return "Dow Jones";
    }

    if (/\bAlliance News\b/i.test(text)) {
      return "Alliance News";
    }

    if (/\bMT Newswires\b/i.test(text)) {
      return "MT Newswires";
    }

    for (const [code, name] of Object.entries(SOURCE_CODES)) {
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

function extractArticleBody(html) {
  const $ = cheerio.load(html);

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

  for (const candidate of candidates) {
    if (!candidate.length) {
      continue;
    }

    const text = cleanText(candidate.first().text());

    if (text.length >= 300) {
      return text.slice(0, ARTICLE_MAX_CHARS);
    }
  }

  const fallback = cleanText($("body").text());

  return fallback.slice(0, ARTICLE_MAX_CHARS);
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} from ${url}`
    );
  }

  return response.text();
}

async function scrapeListing() {
  const html = await fetchHtml(FEED_URL);

  const $ = cheerio.load(html);

  const articles = [];
  const seen = new Set();

  $("a[href]").each((_, element) => {
    if (articles.length >= MAX_LISTING_ARTICLES) {
      return false;
    }

    const href = $(element).attr("href");

    if (!href) {
      return;
    }

    let url;

    try {
      url = absoluteUrl(href);
    } catch {
      return;
    }

    if (!isMarketScreenerUrl(url)) {
      return;
    }

    if (!isArticleUrl(url)) {
      return;
    }

    if (seen.has(url)) {
      return;
    }

    const title = cleanText($(element).text());

    if (title.length < 8) {
      return;
    }

    seen.add(url);

    articles.push({
      title,
      url,
      source: detectSourceFromNearbyText(
        $,
        $(element)
      ),
    });
  });

  return articles;
}

async function enrichArticle(article) {
  try {
    const html = await fetchHtml(article.url);

    const body = extractArticleBody(html);

    let source = article.source;

    if (source === "Unknown") {
      if (/\bReuters\b/i.test(html)) {
        source = "Reuters";
      } else if (/\bDow Jones\b/i.test(html)) {
        source = "Dow Jones";
      } else if (/\bAlliance News\b/i.test(html)) {
        source = "Alliance News";
      } else if (/\bMT Newswires\b/i.test(html)) {
        source = "MT Newswires";
      }
    }

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

async function mapWithConcurrency(
  items,
  limit,
  worker
) {
  const results = new Array(items.length);

  let next = 0;

  async function runner() {
    while (true) {
      const index = next++;

      if (index >= items.length) {
        return;
      }

      try {
        results[index] = await worker(
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

  const workers = Math.min(
    limit,
    items.length
  );

  await Promise.all(
    Array.from(
      { length: workers },
      runner
    )
  );

  return results;
}

/*
 * Groq API key rotation.
 *
 * Keys are stored in environment variables.
 * Only configure credentials you are authorized
 * to use. Rotation is for normal credential
 * distribution/failover, not quota circumvention.
 */

let keyCursor = 0;

function nextGroqKey() {
  if (!GROQ_KEYS.length) {
    throw new Error(
      "No GROQ_KEY_1...GROQ_KEY_5 environment variables configured."
    );
  }

  const key =
    GROQ_KEYS[
      keyCursor % GROQ_KEYS.length
    ];

  keyCursor++;

  return key;
}

async function classifyWithGroq(article) {
  const apiKey = nextGroqKey();

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        model: GROQ_MODEL,

        temperature: 0,

        reasoning_effort: "low",

        include_reasoning: false,

        max_completion_tokens: 256,

        response_format: {
          type: "json_schema",
          json_schema: {
            name: "natgas_relevance",
            strict: true,
            schema: {
              type: "object",
              properties: {
                relevant: {
                  type: "boolean"
                }
              },
              required: ["relevant"],
              additionalProperties: false
            }
          }
        },

        messages: [
          {
            role: "system",
            content: CLASSIFIER_PROMPT
          },
          {
            role: "user",
            content:
              `TITLE:\n${article.title}\n\n` +
              `SOURCE:\n${article.source}\n\n` +
              `ARTICLE:\n${article.body}`
          }
        ]
      })
    }
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Groq HTTP ${response.status}: ${body.slice(0, 500)}`
    );
  }

  const data = await response.json();

  const content =
    data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(
      `Groq returned empty content. ` +
      `finish_reason=${JSON.stringify(
        data?.choices?.[0]?.finish_reason
      )}`
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      `Invalid Groq JSON: ${content}`
    );
  }

  if (
    typeof parsed.relevant !== "boolean"
  ) {
    throw new Error(
      `Invalid classifier response: ${content}`
    );
  }

  return parsed.relevant;
}

async function sendTelegram(article) {
  const isReuters =
    article.source === "Reuters";

  const header = isReuters
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

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      method: "POST",

      headers: {
        "content-type": "application/json",
      },

      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Telegram HTTP ${response.status}: ${body}`
    );
  }
}

async function getSeen(store) {
  const value = await store.get(
    "seen-urls",
    {
      type: "json",
    }
  );

  return Array.isArray(value)
    ? value
    : [];
}

async function saveSeen(
  store,
  urls
) {
  await store.setJSON(
    "seen-urls",
    urls.slice(-SEEN_LIMIT)
  );
}

async function run() {
  if (
    !TELEGRAM_TOKEN ||
    !TELEGRAM_CHAT_ID
  ) {
    throw new Error(
      "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID."
    );
  }

  if (!GROQ_KEYS.length) {
    throw new Error(
      "Missing GROQ_KEY_1...GROQ_KEY_5."
    );
  }

  const store =
    getStore("natgas-intel");

  const seen =
    await getSeen(store);

  const seenSet =
    new Set(seen);

  console.log(
    `Scraping: ${FEED_URL}`
  );

  const listing =
    await scrapeListing();

  console.log(
    `Listing contains ${listing.length} article links.`
  );

  /*
   * First deployment:
   * remember current articles but don't
   * send a Telegram dump.
   */
  if (
    seen.length === 0 &&
    SEED_ON_FIRST_RUN
  ) {
    await saveSeen(
      store,
      listing.map(
        (article) => article.url
      )
    );

    console.log(
      `Seeded ${listing.length} existing URLs. No Telegram alerts sent.`
    );

    return;
  }

  const newArticles =
    listing
      .filter(
        (article) =>
          !seenSet.has(article.url)
      )
      .slice(
        0,
        MAX_NEW_ARTICLES_PER_RUN
      );

  if (!newArticles.length) {
    console.log(
      "No new articles."
    );

    return;
  }

  console.log(
    `${newArticles.length} new article(s) to classify.`
  );

  /*
   * Fetch article pages concurrently.
   */
  const enriched =
    await mapWithConcurrency(
      newArticles,
      MAX_CONCURRENT_ARTICLES,
      enrichArticle
    );

  const validArticles =
    enriched.filter(
      (article) =>
        article &&
        !article.error
    );

  /*
   * Classify concurrently.
   */
  const classified =
    await mapWithConcurrency(
      validArticles,
      MAX_CONCURRENT_LLM,
      async (article) => {
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

  const successful = [];
  const relevant = [];

  for (const result of classified) {
    if (
      !result ||
      result.error
    ) {
      console.error(
        "Classification failed:",
        result?.error?.message ||
          result
      );

      continue;
    }

    successful.push(result);

    if (result.relevant) {
      relevant.push(result);
    }
  }

  /*
   * Send oldest first.
   */
  for (
    const article of [...relevant].reverse()
  ) {
    try {
      await sendTelegram(
        article
      );

      console.log(
        `Sent: [${article.source}] ${article.title}`
      );
    } catch (error) {
      console.error(
        `Telegram failed for ${article.url}: ${error.message}`
      );
    }
  }

  /*
   * Remember successfully classified
   * articles so they aren't processed again.
   */
  for (
    const article of successful
  ) {
    seenSet.add(
      article.url
    );
  }

  await saveSeen(
    store,
    [...seenSet]
  );

  console.log(
    `Complete: ${successful.length} classified, ${relevant.length} relevant.`
  );
}

export default async () => {
  await run();
};

export const config = {
  schedule: "*/4 * * * *",
};