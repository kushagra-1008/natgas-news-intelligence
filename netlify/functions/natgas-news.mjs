import { getStore } from "@netlify/blobs";
import * as cheerio from "cheerio";

const FEED_URL = process.env.MARKETSCREENER_URL || "https://in.marketscreener.com/news/commodities/";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_GROUP_ID;

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
const CLASSIFIER_PREVIEW_CHARS = Number(process.env.CLASSIFIER_PREVIEW_CHARS || 700);
const MAX_CONCURRENT_ARTICLES = Number(process.env.MAX_CONCURRENT_ARTICLES || 5);
const MAX_CONCURRENT_LLM = Number(process.env.MAX_CONCURRENT_LLM || 5);
const SEEN_LIMIT = Number(process.env.SEEN_LIMIT || 3000);
const SEED_ON_FIRST_RUN = (process.env.SEED_ON_FIRST_RUN || "true").toLowerCase() === "true";
const BACKFILL_ONCE = (process.env.BACKFILL_ONCE || "true").toLowerCase() === "true";
const BACKFILL_KEY = "high-recall-backfill-v1";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36";
const SOURCE_CODES = { RE: "Reuters", DJ: "Dow Jones", AN: "Alliance News", MT: "MT Newswires" };

const CLASSIFIER_PROMPT = `
You are a HIGH-RECALL, SOURCE-NEUTRAL classifier for a US natural-gas market alert system.

Your job is to avoid missing useful market-moving information. Read the TITLE, SOURCE and ARTICLE PREVIEW. Return YES when there is a credible, specific pathway by which the article could matter to US natural gas, Henry Hub, US LNG, gas-fired power demand, US energy supply/demand, or a major macro/geopolitical driver of those markets. Return NO only when the article is clearly unrelated, purely generic, or lacks a plausible market mechanism.

CORE RULES:
- HIGH RECALL IS MORE IMPORTANT THAN EXTREME PRECISION. When genuinely uncertain between YES and NO, choose YES.
- ALL SOURCES ARE EQUAL. Reuters is NOT inherently more relevant than Dow Jones, Alliance News, MT Newswires, or another source.
- Never use the SOURCE itself as the reason for YES or NO.
- Use TITLE and PREVIEW together.
- The article does NOT need to explicitly say "natural gas" or "natgas" to be relevant.
- Direct natural-gas/LNG developments should usually be YES, including routine factual updates, if they are useful to a trader monitoring the market.
- Indirect stories need a plausible mechanism to US gas/LNG, but the connection can be second-order when it is economically credible.
- Do not require the impact to be certain or immediate. A credible effect on supply, demand, flows, LNG economics, commodity pricing, or market expectations is enough.
- Avoid NO merely because an article is about a broader energy or macro topic.

YES — DIRECT US NATURAL GAS / LNG:
- Henry Hub, US natural-gas prices, futures, basis, regional gas prices, volatility or major price moves
- US gas production, associated gas, drilling, rigs, producer guidance, curtailments, shut-ins and major gas basins
- Permian, Haynesville, Marcellus, Utica and other significant US gas-producing regions
- US gas pipelines, gathering, processing, compressors, constraints, outages, maintenance, expansions or new projects
- EIA natural-gas storage, injections, withdrawals, forecasts, revisions and storage expectations
- US LNG exports, feedgas, terminal outages, maintenance, commissioning, ramp-ups, expansions and capacity changes
- Freeport LNG, Sabine Pass, Corpus Christi, Cameron, Calcasieu Pass, Plaquemines and other major US LNG facilities
- Canada-US and Mexico-US gas flows, imports/exports and cross-border infrastructure
- gas-fired power generation, power burn, major electricity-demand shifts and major power-plant outages affecting gas consumption
- severe weather, hurricanes, freeze-offs, heat/cold waves and forecast shifts with plausible gas supply or demand effects

YES — GLOBAL LNG / ENERGY THAT CAN MATTER:
- major global LNG outages, startups, shutdowns, maintenance, shipping disruptions or capacity changes
- Qatar LNG disruptions or material threats to exports
- European gas / TTF developments affecting LNG demand, US export economics, storage or global gas balances
- Russia-Ukraine developments affecting gas, LNG, pipelines or European energy supply
- Strait of Hormuz, Iran, Middle East or shipping developments that can materially change LNG/oil flows, freight, supply risk or energy pricing
- major sanctions, tariffs, export controls, regulations or government policy affecting energy trade or LNG
- OPEC / major oil developments when they can materially affect associated gas, US energy economics, LNG competition or broad commodity risk pricing

YES — MACRO / FINANCIAL DRIVERS WHEN MATERIAL:
- Fed decisions, rate expectations, CPI, PCE, payrolls/jobs, GDP, recession signals, Treasury yields, DXY/dollar moves or other macro events when they can plausibly affect commodity prices, LNG economics, US industrial/power demand, or energy risk sentiment
- major changes in the US dollar or rates regime that can materially affect dollar-priced natural gas/commodities

NO:
- clearly unrelated consumer, retail, healthcare, technology, telecom, software, agriculture or corporate stories with no energy mechanism
- generic stock/index moves with no meaningful energy connection
- broad market wraps that only mention gas or oil in passing and provide no specific development
- opinion/commentary with no concrete event, data point, policy change or actionable market information
- geopolitics with no plausible pathway to energy supply, demand, flows, pricing or expectations

IMPORTANT EDGE CASES:
- A story about electricity demand, data centers, industrial projects, LNG infrastructure, pipeline construction, weather, shipping, sanctions or geopolitics can be YES even if "natural gas" never appears, when the market mechanism is credible.
- A story about oil can be YES when it affects associated gas production, LNG economics, energy risk premia or US gas-market expectations.
- A story about Iran, Qatar, Russia, Europe or the Middle East can be YES when it changes global gas/LNG availability, shipping, oil/gas pricing or US LNG competitiveness.
- Do not reject a story simply because the impact is indirect.
- Do reject stories that only mention energy terms incidentally.

FINAL DECISION:
Choose YES whenever there is a credible, specific connection to US natural gas/LNG/energy-market supply, demand, flows, pricing, infrastructure, exports, storage, or a material macro/geopolitical driver. If uncertain but the connection is plausible, choose YES.
Return exactly one word: YES or NO.
`;

function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function absoluteUrl(href) { return new URL(href, FEED_URL).href; }
function isMarketScreenerUrl(url) {
  try { return new URL(url).hostname.endsWith("marketscreener.com"); }
  catch { return false; }
}
function isArticleUrl(url) {
  try { return /^\/news\/[^/]+-ce[0-9a-f]+\/?$/i.test(new URL(url).pathname); }
  catch { return false; }
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
      if (new RegExp(`(?:^|[\\s|])${code}(?:$|[\\s|])`, "i").test(text)) return name;
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
  const target = isFeed ? `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}` : url;
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
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
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
    try { url = absoluteUrl(href); } catch { return; }
    if (!isMarketScreenerUrl(url) || !isArticleUrl(url) || seen.has(url)) return;
    const title = cleanText($(element).text());
    if (title.length < 8) return;
    seen.add(url);
    articles.push({ title, url, source: detectSourceFromNearbyText($, $(element)) });
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

function normalizeTitle(title) {
  return cleanText(title)
    .toLowerCase()
    .replace(/^(reuters|dow jones|alliance news|mt newswires)\s*[-:|]+\s*/i, "")
    .replace(/^(morning bid(?:\s+[a-z]+)*|market wrap|morning call|market update|daily markets|markets today|look ahead)\s*[-:|–—]+\s*/i, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GENERIC_WRAP_TERMS = /\b(morning bid|market wrap|morning call|market update|daily markets|weekly markets|markets today|look ahead)\b/i;
const OBVIOUS_UNRELATED_TERMS = /\b(rubber|fashion|retail sales|consumer products|video game|gaming|smartphone|semiconductor|software|telecom|pharmaceutical|maize|corn crop|wheat|coffee|cocoa)\b/i;
const HIGH_VALUE_TITLE_TERMS = /\b(natural gas|natgas|henry hub|lng|feedgas|freeport|sabine pass|corpus christi|cameron lng|calcasieu|plaquemines|eia|storage|pipeline|gas production|gas output|gas demand|power burn|data cent(?:er|res)|power demand|gas-fired|gas fired|freeze[- ]off|hurricane|qatar|hormuz|strait of hormuz|ttf|european gas|gas prices|gas price|oil price|opec|iran|sanctions|tariff|ceasefire|peace deal|war|conflict|fed|federal reserve|cpi|pce|payroll|jobs report|dollar index|dxy|treasury yield|recession|inflation|energy|lng terminal|export terminal|drilling|rig count|production|outage|maintenance|shipping|pipeline)\b/i;

function cheapTitleFilter(article) {
  const title = cleanText(article.title);
  if (OBVIOUS_UNRELATED_TERMS.test(title)) return true;
  if (GENERIC_WRAP_TERMS.test(title) && !HIGH_VALUE_TITLE_TERMS.test(title)) return true;
  return false;
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
    if (source === "Unknown") source = detectSourceFromHtml(html);
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
      try { results[index] = await worker(items[index], index); }
      catch (error) { results[index] = { error }; }
    }
  }
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, runner));
  return results;
}

let keyCursor = 0;
function nextGroqKey() {
  if (!GROQ_KEYS.length) throw new Error("No GROQ_KEY_1...GROQ_KEY_5 environment variables configured.");
  const key = GROQ_KEYS[keyCursor % GROQ_KEYS.length];
  keyCursor++;
  return key;
}

async function classifyWithGroq(article) {
  const apiKey = nextGroqKey();
  const preview = cleanText(article.body).slice(0, CLASSIFIER_PREVIEW_CHARS);
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
          content: `TITLE:\n${article.title}\n\nSOURCE:\n${article.source}\n\nARTICLE PREVIEW:\n${preview}`,
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
  if (!content) throw new Error(`Groq returned empty content. finish_reason=${JSON.stringify(data?.choices?.[0]?.finish_reason)}`);
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw new Error(`Invalid Groq JSON: ${content}`); }
  if (typeof parsed.relevant !== "boolean") throw new Error(`Invalid classifier response: ${content}`);
  return parsed.relevant;
}

async function sendTelegram(article) {
  const header = article.source === "Reuters"
    ? "🚨 <b>REUTERS — NATGAS RELEVANT</b>"
    : "🟢 <b>NATGAS RELEVANT</b>";
  const text = [
    header,
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
async function saveSeen(store, urls) { await store.setJSON("seen-urls", urls.slice(-SEEN_LIMIT)); }
async function getBackfillDone(store) { return (await store.get(BACKFILL_KEY, { type: "text" })) === "done"; }
async function markBackfillDone(store) { await store.set(BACKFILL_KEY, "done"); }

async function run() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_GROUP_ID.");
  if (!GROQ_KEYS.length) throw new Error("Missing GROQ_KEY_1...GROQ_KEY_5.");

  const store = getStore("natgas-intel");
  const seen = await getSeen(store);
  const seenSet = new Set(seen);
  console.log(`Scraping: ${FEED_URL}`);
  const listing = await scrapeListing();

  if (seen.length === 0 && SEED_ON_FIRST_RUN && !BACKFILL_ONCE) {
    await saveSeen(store, listing.map(article => article.url));
    console.log(`Seeded ${listing.length} existing URLs. No Telegram alerts sent.`);
    return;
  }

  const backfillDone = await getBackfillDone(store);
  let pool;
  let mode;

  if (BACKFILL_ONCE && !backfillDone) {
    // One-time recovery: re-evaluate the current feed regardless of old seen state.
    // Still capped by MAX_NEW_ARTICLES_PER_RUN so Groq usage stays bounded.
    pool = listing;
    mode = "HIGH-RECALL BACKFILL";
  } else {
    pool = listing.filter(article => !seenSet.has(article.url));
    mode = "INCREMENTAL";
  }

  const uniqueArticles = [];
  const titleSeen = new Set();
  let cheapSkipped = 0;
  let duplicateSkipped = 0;

  for (const article of pool) {
    const fingerprint = normalizeTitle(article.title);
    if (titleSeen.has(fingerprint)) {
      duplicateSkipped++;
      if (mode === "INCREMENTAL") seenSet.add(article.url);
      console.log(`Duplicate title skipped: ${article.title}`);
      continue;
    }
    titleSeen.add(fingerprint);

    if (cheapTitleFilter(article)) {
      cheapSkipped++;
      if (mode === "INCREMENTAL") seenSet.add(article.url);
      console.log(`Cheap filter skipped: ${article.title}`);
      continue;
    }

    uniqueArticles.push(article);
    if (uniqueArticles.length >= MAX_NEW_ARTICLES_PER_RUN) break;
  }

  if (!uniqueArticles.length) {
    console.log(`${mode}: no candidates. Cheap-filtered: ${cheapSkipped}, duplicates: ${duplicateSkipped}.`);
    await saveSeen(store, [...seenSet]);
    if (mode === "HIGH-RECALL BACKFILL") await markBackfillDone(store);
    return;
  }

  console.log(`${mode}: ${uniqueArticles.length} article(s) sent to enrichment. Cheap-filtered: ${cheapSkipped}, duplicates: ${duplicateSkipped}.`);
  const enriched = await mapWithConcurrency(uniqueArticles, MAX_CONCURRENT_ARTICLES, enrichArticle);
  const validArticles = enriched.filter(article => article && !article.error);
  console.log(`Article pages fetched: ${validArticles.length}`);

  const classified = await mapWithConcurrency(
    validArticles,
    MAX_CONCURRENT_LLM,
    async article => ({ ...article, relevant: await classifyWithGroq(article) }),
  );
  const successful = classified.filter(result => result && !result.error);
  const relevant = successful.filter(article => article.relevant);

  const sourceStats = {};
  for (const article of successful) {
    const source = article.source || "Unknown";
    if (!sourceStats[source]) sourceStats[source] = { yes: 0, no: 0 };
    sourceStats[source][article.relevant ? "yes" : "no"]++;
  }

  console.log(`LLM classified: ${successful.length}`);
  console.log(`NATGAS relevant: ${relevant.length}`);
  console.log(`Classification by source: ${JSON.stringify(sourceStats)}`);

  const sentUrls = [];
  for (const article of [...relevant].reverse()) {
    try {
      await sendTelegram(article);
      sentUrls.push(article.url);
      console.log(`${article.source === "Reuters" ? "🚨" : "🟢"} Sent to group: ${article.title}`);
    } catch (error) {
      console.error(`Telegram failed for ${article.url}: ${error.message}`);
    }
  }

  for (const article of successful) seenSet.add(article.url);
  for (const url of sentUrls) seenSet.add(url);
  await saveSeen(store, [...seenSet]);

  if (mode === "HIGH-RECALL BACKFILL") await markBackfillDone(store);

  console.log(`Complete: ${successful.length} classified, ${relevant.length} relevant, ${sentUrls.length} Telegram alerts sent, ${cheapSkipped} cheap-filtered, ${duplicateSkipped} duplicates, mode=${mode}.`);
}

export default async () => { await run(); };
