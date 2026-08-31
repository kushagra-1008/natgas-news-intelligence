import { getStore } from "@netlify/blobs";
import * as cheerio from "cheerio";

const FEED_URL = process.env.MARKETSCREENER_URL || "https://in.marketscreener.com/news/commodities/";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const GROQ_KEYS = [
  process.env.GROQ_KEY_1,
  process.env.GROQ_KEY_2,
  process.env.GROQ_KEY_3,
  process.env.GROQ_KEY_4,
  process.env.GROQ_KEY_5,
].filter(Boolean);

const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const MAX_LISTING_ARTICLES = 80;
const MAX_NEW_ARTICLES_PER_RUN = Number(process.env.MAX_NEW_ARTICLES_PER_RUN || 30);
const CLASSIFIER_PREVIEW_CHARS = Number(process.env.CLASSIFIER_PREVIEW_CHARS || 600);
const MAX_CONCURRENT_ARTICLES = Number(process.env.MAX_CONCURRENT_ARTICLES || 5);
const MAX_CONCURRENT_LLM = Number(process.env.MAX_CONCURRENT_LLM || 5);
const SEEN_LIMIT = Number(process.env.SEEN_LIMIT || 3000);
const SEED_ON_FIRST_RUN = (process.env.SEED_ON_FIRST_RUN || "true").toLowerCase() === "true";

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
You are the relevance classifier for a US natural-gas and energy-market alert system.

TASK:
Read the article TITLE, SOURCE and short ARTICLE PREVIEW. Decide whether the article is worth sending as a Telegram alert because it could materially matter to US natural gas, LNG, energy markets, or the macro/geopolitical environment that can move those markets.

Return ONLY:
YES
or
NO

IMPORTANT:
- Evaluate EVERY article the same way. Do not give Reuters, Dow Jones, MT Newswires, Alliance News, or any other source special treatment.
- Use the title and preview together.
- The preview is intentionally short; do not require the full article.
- Favor useful alerts over extreme filtering. If an article clearly belongs to one of the high-value categories below, return YES even when the US natural-gas impact is indirect.
- Do NOT require the words "natural gas" or "natgas" to appear.

RETURN YES for clear or strongly relevant developments involving:

US NATURAL GAS / LNG:
- US natural-gas prices, Henry Hub, regional gas prices
- US gas production, associated gas, drilling, rigs, producer guidance, curtailments, shut-ins or major gas basins
- Permian, Haynesville, Marcellus, Utica and other major US gas-producing regions
- US gas pipelines, processing plants, compressors, constraints, outages, maintenance or expansions
- EIA natural-gas storage, storage expectations, injections, withdrawals or major revisions
- US LNG exports, feedgas, LNG terminals, outages, maintenance, commissioning, ramp-ups or expansions
- Freeport LNG, Sabine Pass, Corpus Christi, Cameron, Calcasieu Pass, Plaquemines and other major US LNG facilities
- LNG vessel flows or disruptions that can materially affect US LNG exports
- Canada-US or Mexico-US gas flows and major US gas import/export changes
- major changes in US gas demand, power burn, industrial demand or residential/commercial demand

WEATHER / POWER:
- Major US heat waves, cold waves, hurricanes, tropical systems, freeze-offs or weather forecast changes that can materially affect gas demand or supply
- US electricity demand, gas-fired generation, coal-to-gas switching
- Large nuclear, coal or power-plant outages that can materially change gas power burn

GLOBAL LNG / ENERGY FLOWS:
- Major LNG supply outages, startups, shutdowns, maintenance or capacity changes anywhere in the world
- Qatar LNG production/export disruptions or threats
- Middle East energy infrastructure disruptions
- Strait of Hormuz closures, reopening, attacks, threats, military escalation or major shipping disruption
- Red Sea, Suez Canal, Panama Canal or other major energy/LNG shipping-route disruptions
- Global LNG shipping disruptions that can materially alter LNG availability or pricing
- European natural gas, TTF or major European storage developments when they can affect global LNG demand/pricing or US LNG economics
- Russia-Ukraine developments affecting natural gas, LNG, pipelines or European energy supply

MIDDLE EAST / IRAN / GEOPOLITICS:
- Iran-US war, military escalation, negotiations, ceasefire, peace deals, sanctions or major diplomatic developments
- Israel/Iran or other Middle East conflict developments involving destruction, attacks, blockades, energy infrastructure, shipping or major escalation
- Any major Middle East destruction or disruption that can affect oil, LNG, shipping, global energy prices or energy security
- Major sanctions, embargoes, tariffs or government policies affecting energy trade

US MACROECONOMY / FINANCIAL CONDITIONS:
- Federal Reserve decisions, rate changes, major Fed guidance or major changes in rate expectations
- US CPI, PCE, PPI, jobs/payrolls, unemployment, GDP, ISM/PMI or other major US macroeconomic releases
- US Treasury yields, major yield moves or changes in the US rate curve when market-moving
- US Dollar Index (DXY), major dollar moves or major USD developments when market-moving
- US recession/growth/inflation developments with meaningful implications for commodity or energy demand
- major US fiscal, tariff, trade or economic-policy changes that can materially move the dollar, rates, growth or energy markets
- major risk-on/risk-off or financial-market shocks when they can materially affect commodities, energy demand or LNG economics

OIL / OPEC:
- Major oil-price shocks, OPEC/OPEC+ decisions or major oil-market disruptions ONLY when they have a plausible material connection to US natural gas, associated gas, LNG economics or broader energy pricing

IMPORTANT BORDERLINE RULE:
If an article is strongly about one of these high-value themes, especially US macroeconomics, DXY, Fed/rates, Iran-US conflict/peace, major Middle East destruction, Hormuz, Qatar LNG, global LNG disruption, US weather, US power demand or US energy infrastructure, choose YES even if the article does not explicitly mention natural gas.

Do NOT return YES for ordinary unrelated company earnings, consumer news, local politics, generic stock moves, agriculture, rubber, retail, technology or other stories with no meaningful energy/macro/geopolitical connection.

The goal is a useful market-alert feed, NOT a tiny feed containing only articles that explicitly say "natural gas".

Return exactly one word: YES or NO.
`;

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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
    return new URL(url).hostname.endsWith("marketscreener.com");
  } catch {
    return false;
  }
}

function isArticleUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return /^\/news\/[^/]+-ce[0-9a-f]+\/?$/i.test(pathname);
  } catch {
    return false;
  }
}

function detectSourceFromNearbyText($, anchor) {
  let node = anchor;

  for (let depth = 0; depth < 6 && node.length; depth++) {
    const text = cleanText(node.text());

    if (/\bReuters\b/i.test(text)) return "Reuters";
    if (/\bDow Jones\b/i.test(text)) return "Dow Jones";
    if (/\bAlliance News\b/i.test(text)) return "Alliance News";
    if (/\bMT Newswires\b/i.test(text)) return "MT Newswires";

    for (const [code, name] of Object.entries(SOURCE_CODES)) {
      const regex = new RegExp(`(?:^|[\\s|])${code}(?:$|[\\s|])`, "i");
      if (regex.test(text)) return name;
    }

    node = node.parent();
  }

  return "Unknown";
}

function detectSourceFromHtml(html) {
  if (/\bReuters\b/i.test(html)) return "Reuters";
  if (/\bDow Jones\b/i.test(html)) return "Dow Jones";
  if (/\bAlliance News\b/i.test(html)) return "Alliance News";
  if (/\bMT Newswires\b/i.test(html)) return "MT Newswires";
  return "Unknown";
}

async function fetchHtml(url) {
  const isFeed = url === FEED_URL;
  const target = isFeed
    ? `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`
    : url;

  const response = await fetch(target, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }

  return response.text();
}

async function scrapeListing() {
  const html = await fetchHtml(FEED_URL);
  const $ = cheerio.load(html);
  const articles = [];
  const seen = new Set();

  $("a[href]").each((_, element) => {
    if (articles.length >= MAX_LISTING_ARTICLES) return false;

    const href = $(element).attr("href");
    if (!href) return;

    let url;
    try {
      url = absoluteUrl(href);
    } catch {
      return;
    }

    if (!isMarketScreenerUrl(url) || !isArticleUrl(url)) return;
    if (seen.has(url)) return;

    const title = cleanText($(element).text());
    if (title.length < 8) return;

    seen.add(url);
    articles.push({
      title,
      url,
      source: detectSourceFromNearbyText($, $(element)),
    });
  });

  console.log(`Article URLs extracted: ${articles.length}`);
  console.log("===== ARTICLE SAMPLE =====");
  articles.slice(0, 20).forEach((article, index) => {
    console.log(`${index + 1}. [${article.source}] ${article.title}`);
    console.log(`   ${article.url}`);
  });
  console.log("==========================");

  return articles;
}

function extractArticleBody(html) {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer, form, noscript, svg").remove();

  const candidates = [
    $("article"),
    $("main"),
    $('[class*="article"]'),
    $('[class*="Article"]'),
    $('[class*="story"]'),
  ];

  for (const candidate of candidates) {
    if (!candidate.length) continue;
    const text = cleanText(candidate.first().text());
    if (text.length >= 300) return text;
  }

  return cleanText($("body").text());
}

async function enrichArticle(article) {
  try {
    const html = await fetchHtml(article.url);
    let source = article.source;

    if (source === "Unknown") {
      source = detectSourceFromHtml(html);
    }

    return { ...article, source, body: extractArticleBody(html) };
  } catch (error) {
    console.warn(`Article fetch failed: ${article.url} — ${error.message}`);
    return { ...article, body: article.title, fetchFailed: true };
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function runner() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { error };
      }
    }
  }

  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, runner));
  return results;
}

let keyCursor = 0;

function nextGroqKey() {
  if (!GROQ_KEYS.length) {
    throw new Error("No GROQ_KEY_1...GROQ_KEY_5 environment variables configured.");
  }
  const key = GROQ_KEYS[keyCursor % GROQ_KEYS.length];
  keyCursor++;
  return key;
}

async function classifyWithGroq(article) {
  const apiKey = nextGroqKey();
  const preview = cleanText(article.body).slice(0, CLASSIFIER_PREVIEW_CHARS);

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
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
            properties: { relevant: { type: "boolean" } },
            required: ["relevant"],
            additionalProperties: false,
          },
        },
      },
      messages: [
        { role: "system", content: CLASSIFIER_PROMPT },
        {
          role: "user",
          content:
            `TITLE:\n${article.title}\n\n` +
            `SOURCE:\n${article.source}\n\n` +
            `ARTICLE PREVIEW:\n${preview}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq HTTP ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(`Groq returned empty content. finish_reason=${JSON.stringify(data?.choices?.[0]?.finish_reason)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Invalid Groq JSON: ${content}`);
  }

  if (typeof parsed.relevant !== "boolean") {
    throw new Error(`Invalid classifier response: ${content}`);
  }

  return parsed.relevant;
}

async function sendTelegram(article) {
  const text = [
    "🚨 <b>NATGAS / ENERGY MARKET ALERT</b>",
    "",
    `<b>${escapeHtml(article.title)}</b>`,
    "",
    `Source: ${escapeHtml(article.source)}`,
    `<a href="${escapeHtml(article.url)}">Open article on MarketScreener</a>`,
  ].join("\n");

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram HTTP ${response.status}: ${body}`);
  }
}

async function getSeen(store) {
  const value = await store.get("seen-urls", { type: "json" });
  return Array.isArray(value) ? value : [];
}

async function saveSeen(store, urls) {
  await store.setJSON("seen-urls", urls.slice(-SEEN_LIMIT));
}

async function run() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.");
  }
  if (!GROQ_KEYS.length) {
    throw new Error("Missing GROQ_KEY_1...GROQ_KEY_5.");
  }

  const store = getStore("natgas-intel");
  const seen = await getSeen(store);
  const seenSet = new Set(seen);

  console.log(`Scraping: ${FEED_URL}`);
  const listing = await scrapeListing();

  if (seen.length === 0 && SEED_ON_FIRST_RUN) {
    await saveSeen(store, listing.map((article) => article.url));
    console.log(`Seeded ${listing.length} existing URLs. No Telegram alerts sent.`);
    return;
  }

  const newArticles = listing
    .filter((article) => !seenSet.has(article.url))
    .slice(0, MAX_NEW_ARTICLES_PER_RUN);

  if (!newArticles.length) {
    console.log("No new articles.");
    return;
  }

  console.log(`${newArticles.length} new article(s) detected.`);

  const enriched = await mapWithConcurrency(newArticles, MAX_CONCURRENT_ARTICLES, enrichArticle);
  const validArticles = enriched.filter((article) => article && !article.error);
  console.log(`Article pages fetched: ${validArticles.length}`);

  const classified = await mapWithConcurrency(
    validArticles,
    MAX_CONCURRENT_LLM,
    async (article) => ({ ...article, relevant: await classifyWithGroq(article) })
  );

  const successful = classified.filter((result) => result && !result.error);
  const relevant = successful.filter((article) => article.relevant);

  console.log(`LLM classified: ${successful.length}`);
  console.log(`NATGAS relevant: ${relevant.length}`);

  const sentUrls = [];

  for (const article of [...relevant].reverse()) {
    try {
      await sendTelegram(article);
      sentUrls.push(article.url);
      console.log(`🚨 Sent: ${article.title}`);
    } catch (error) {
      console.error(`Telegram failed for ${article.url}: ${error.message}`);
    }
  }

  for (const article of successful) {
    seenSet.add(article.url);
  }

  for (const url of sentUrls) {
    seenSet.add(url);
  }

  await saveSeen(store, [...seenSet]);

  console.log(
    `Complete: ${successful.length} classified, ${relevant.length} relevant, ${sentUrls.length} Telegram alerts sent.`
  );
}

export default async () => {
  await run();
};

export const config = {
  schedule: "*/4 * * * *",
};
