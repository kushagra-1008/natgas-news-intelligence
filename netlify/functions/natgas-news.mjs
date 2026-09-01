import { getStore } from "@netlify/blobs";
import * as cheerio from "cheerio";

const FEED_URL = process.env.MARKETSCREENER_URL || "https://in.marketscreener.com/news/commodities/";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_GROUP_ID;

const GROQ_KEYS = [process.env.GROQ_KEY_1,process.env.GROQ_KEY_2,process.env.GROQ_KEY_3,process.env.GROQ_KEY_4,process.env.GROQ_KEY_5].filter(Boolean);
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const MAX_LISTING_ARTICLES = 80;
const MAX_NEW_ARTICLES_PER_RUN = Number(process.env.MAX_NEW_ARTICLES_PER_RUN || 30);
const CLASSIFIER_PREVIEW_CHARS = Number(process.env.CLASSIFIER_PREVIEW_CHARS || 600);
const MAX_CONCURRENT_ARTICLES = Number(process.env.MAX_CONCURRENT_ARTICLES || 5);
const MAX_CONCURRENT_LLM = Number(process.env.MAX_CONCURRENT_LLM || 5);
const SEEN_LIMIT = Number(process.env.SEEN_LIMIT || 3000);
const SEED_ON_FIRST_RUN = (process.env.SEED_ON_FIRST_RUN || "true").toLowerCase() === "true";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36";
const SOURCE_CODES = { RE:"Reuters", DJ:"Dow Jones", AN:"Alliance News", MT:"MT Newswires" };

const CLASSIFIER_PROMPT = `
You are the relevance classifier for a US natural-gas and energy-market alert system.

Read the article TITLE, SOURCE and short ARTICLE PREVIEW. Return YES only when the article is worth a Telegram alert because it contains a specific development that could materially affect US natural gas, LNG, energy markets, or a major macro/geopolitical driver of those markets.

Return ONLY YES or NO.

IMPORTANT:
- Evaluate every source equally.
- Use title and preview together.
- Do not require the words natural gas or natgas.
- Do not classify a story as relevant merely because it mentions gas, oil, Europe, Iran, the Middle East, commodities or markets.
- Require a plausible MATERIAL market-impact mechanism.
- Generic market wraps, morning bids, outlooks and commentary are NO unless the title/preview contains a specific material event.

YES for specific developments involving:
- US natural-gas prices, Henry Hub, regional gas prices
- US gas production, associated gas, drilling, rigs, producer guidance, curtailments, shut-ins and major gas basins
- Permian, Haynesville, Marcellus, Utica and other major US gas-producing regions
- US gas pipelines, processing plants, compressors, constraints, outages, maintenance or expansions
- EIA natural-gas storage, storage expectations, injections, withdrawals or major revisions
- US LNG exports, feedgas, terminals, outages, maintenance, commissioning, ramp-ups or expansions
- Freeport LNG, Sabine Pass, Corpus Christi, Cameron, Calcasieu Pass, Plaquemines and other major US LNG facilities
- major global LNG supply outages, startups, shutdowns, maintenance, capacity changes or shipping disruptions
- Qatar LNG production/export disruptions or threats
- major US heat/cold waves, hurricanes, freeze-offs or forecast changes affecting gas demand/supply
- US electricity demand, gas-fired generation, coal-to-gas switching and large power-plant outages affecting gas burn
- Canada-US or Mexico-US gas flows and major US gas import/export changes
- Iran-US war, military escalation, negotiations, ceasefires, sanctions or peace deals when they can materially affect energy markets
- Strait of Hormuz disruption, closure, reopening, military activity or major shipping risks
- major Middle East conflicts or energy-infrastructure disruptions affecting oil, LNG or shipping
- Russia-Ukraine developments affecting natural gas, LNG, pipelines or European energy supply
- European natural gas/TTF developments ONLY when there is a specific material event affecting LNG demand, supply, storage, pipelines or US LNG economics
- major sanctions, tariffs, regulations or government policies affecting energy trade
- major Fed/rates/CPI/PCE/jobs/GDP/DXY/Treasury/macro developments when clearly market-moving for commodities or energy
- major oil/OPEC developments ONLY when there is a plausible material connection to US associated gas, LNG economics or US natural-gas conditions

Do NOT return YES for ordinary unrelated company, consumer, agriculture, rubber, retail, technology, generic stock, generic index or generic market-commentary stories.

Return exactly one word: YES or NO.
`;

function cleanText(value){return String(value||"").replace(/\s+/g," ").trim();}
function escapeHtml(value){return String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");}
function absoluteUrl(href){return new URL(href,FEED_URL).href;}
function isMarketScreenerUrl(url){try{return new URL(url).hostname.endsWith("marketscreener.com");}catch{return false;}}
function isArticleUrl(url){try{return /^\/news\/[^/]+-ce[0-9a-f]+\/?$/i.test(new URL(url).pathname);}catch{return false;}}

function detectSourceFromNearbyText($,anchor){let node=anchor;for(let depth=0;depth<6&&node.length;depth++){const text=cleanText(node.text());if(/\bReuters\b/i.test(text))return"Reuters";if(/\bDow Jones\b/i.test(text))return"Dow Jones";if(/\bAlliance News\b/i.test(text))return"Alliance News";if(/\bMT Newswires\b/i.test(text))return"MT Newswires";for(const[code,name]of Object.entries(SOURCE_CODES)){if(new RegExp(`(?:^|[\\s|])${code}(?:$|[\\s|])`,"i").test(text))return name;}node=node.parent();}return"Unknown";}
function detectSourceFromHtml(html){if(/\bReuters\b/i.test(html))return"Reuters";if(/\bDow Jones\b/i.test(html))return"Dow Jones";if(/\bAlliance News\b/i.test(html))return"Alliance News";if(/\bMT Newswires\b/i.test(html))return"MT Newswires";return"Unknown";}

async function fetchHtml(url){const isFeed=url===FEED_URL;const target=isFeed?`${url}${url.includes("?")?"&":"?"}_=${Date.now()}`:url;const response=await fetch(target,{headers:{"User-Agent":USER_AGENT,"Accept-Language":"en-US,en;q=0.9",Accept:"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8","Cache-Control":"no-cache",Pragma:"no-cache"},redirect:"follow"});if(!response.ok)throw new Error(`HTTP ${response.status} from ${url}`);return response.text();}

async function scrapeListing(){const html=await fetchHtml(FEED_URL);const $=cheerio.load(html);const articles=[];const seen=new Set();$("a[href]").each((_,element)=>{if(articles.length>=MAX_LISTING_ARTICLES)return false;const href=$(element).attr("href");if(!href)return;let url;try{url=absoluteUrl(href);}catch{return;}if(!isMarketScreenerUrl(url)||!isArticleUrl(url)||seen.has(url))return;const title=cleanText($(element).text());if(title.length<8)return;seen.add(url);articles.push({title,url,source:detectSourceFromNearbyText($,$(element))});});console.log(`Article URLs extracted: ${articles.length}`);console.log("===== ARTICLE SAMPLE =====");articles.slice(0,20).forEach((article,index)=>{console.log(`${index+1}. [${article.source}] ${article.title}`);console.log(`   ${article.url}`);});console.log("==========================");return articles;}

function normalizeTitle(title){return cleanText(title).toLowerCase().replace(/^(reuters|dow jones|alliance news|mt newswires)\s*[-:|]+\s*/i,"").replace(/^(morning bid(?:\s+[a-z]+)*|market wrap|morning call|market update|european markets?)\s*[-:|–—]+\s*/i,"").replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();}

const HIGH_VALUE_TITLE_TERMS = /\b(natural gas|natgas|henry hub|lng|feedgas|freeport|sabine pass|corpus christi|cameron lng|calcasieu|plaquemines|eia|storage|pipeline|gas production|gas output|gas demand|power burn|freeze[- ]off|hurricane|qatar|hormuz|strait of hormuz|ttf|european gas|gas prices|gas price|oil price|opec|iran|sanctions|ceasefire|peace deal|war|conflict|fed|federal reserve|cpi|pce|payroll|jobs report|dollar index|dxy|treasury yield|recession|inflation)\b/i;
const GENERIC_WRAP_TERMS = /\b(morning bid|market wrap|morning call|market update|daily markets|weekly markets|markets today|day ahead|look ahead)\b/i;
const OBVIOUS_UNRELATED_TERMS = /\b(rubber|nestle|fashion|retail sales|consumer products|video game|gaming|smartphone|semiconductor|software|telecom|pharmaceutical|maize|corn crop|wheat|coffee|cocoa)\b/i;

function cheapTitleFilter(article){
  const title=cleanText(article.title);
  if(OBVIOUS_UNRELATED_TERMS.test(title)&&!HIGH_VALUE_TITLE_TERMS.test(title))return true;
  if(GENERIC_WRAP_TERMS.test(title)&&!HIGH_VALUE_TITLE_TERMS.test(title))return true;
  return false;
}

function extractArticleBody(html){const $=cheerio.load(html);$("script, style, nav, header, footer, form, noscript, svg").remove();const candidates=[$("article"),$("main"),$('[class*="article"]'),$('[class*="Article"]'),$('[class*="story"]')];for(const candidate of candidates){if(!candidate.length)continue;const text=cleanText(candidate.first().text());if(text.length>=300)return text;}return cleanText($("body").text());}
async function enrichArticle(article){try{const html=await fetchHtml(article.url);let source=article.source;if(source==="Unknown")source=detectSourceFromHtml(html);return{...article,source,body:extractArticleBody(html)};}catch(error){console.warn(`Article fetch failed: ${article.url} — ${error.message}`);return{...article,body:article.title,fetchFailed:true};}}
async function mapWithConcurrency(items,limit,worker){const results=new Array(items.length);let next=0;async function runner(){while(true){const index=next++;if(index>=items.length)return;try{results[index]=await worker(items[index],index);}catch(error){results[index]={error};}}}const workers=Math.min(limit,items.length);await Promise.all(Array.from({length:workers},runner));return results;}
let keyCursor=0;
function nextGroqKey(){if(!GROQ_KEYS.length)throw new Error("No GROQ_KEY_1...GROQ_KEY_5 environment variables configured.");const key=GROQ_KEYS[keyCursor%GROQ_KEYS.length];keyCursor++;return key;}

async function classifyWithGroq(article){const apiKey=nextGroqKey();const preview=cleanText(article.body).slice(0,CLASSIFIER_PREVIEW_CHARS);const response=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json"},body:JSON.stringify({model:GROQ_MODEL,temperature:0,reasoning_effort:"low",include_reasoning:false,max_completion_tokens:256,response_format:{type:"json_schema",json_schema:{name:"natgas_relevance",strict:true,schema:{type:"object",properties:{relevant:{type:"boolean"}},required:["relevant"],additionalProperties:false}}},messages:[{role:"system",content:CLASSIFIER_PROMPT},{role:"user",content:`TITLE:\n${article.title}\n\nSOURCE:\n${article.source}\n\nARTICLE PREVIEW:\n${preview}`}]})});if(!response.ok){const body=await response.text();throw new Error(`Groq HTTP ${response.status}: ${body.slice(0,500)}`);}const data=await response.json();const content=data?.choices?.[0]?.message?.content;if(!content)throw new Error(`Groq returned empty content. finish_reason=${JSON.stringify(data?.choices?.[0]?.finish_reason)}`);let parsed;try{parsed=JSON.parse(content);}catch{throw new Error(`Invalid Groq JSON: ${content}`);}if(typeof parsed.relevant!=="boolean")throw new Error(`Invalid classifier response: ${content}`);return parsed.relevant;}

async function sendTelegram(article){const text=["🚨 <b>NATGAS / ENERGY MARKET ALERT</b>","",`<b>${escapeHtml(article.title)}</b>`,"",`Source: ${escapeHtml(article.source)}`,`<a href="${escapeHtml(article.url)}">Open article on MarketScreener</a>`].join("\n");const response=await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,parse_mode:"HTML",disable_web_page_preview:false})});if(!response.ok){const body=await response.text();throw new Error(`Telegram HTTP ${response.status}: ${body}`);}}
async function getSeen(store){const value=await store.get("seen-urls",{type:"json"});return Array.isArray(value)?value:[];}
async function saveSeen(store,urls){await store.setJSON("seen-urls",urls.slice(-SEEN_LIMIT));}

async function run(){if(!TELEGRAM_TOKEN||!TELEGRAM_CHAT_ID)throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_GROUP_ID.");if(!GROQ_KEYS.length)throw new Error("Missing GROQ_KEY_1...GROQ_KEY_5.");const store=getStore("natgas-intel");const seen=await getSeen(store);const seenSet=new Set(seen);console.log(`Scraping: ${FEED_URL}`);const listing=await scrapeListing();if(seen.length===0&&SEED_ON_FIRST_RUN){await saveSeen(store,listing.map(article=>article.url));console.log(`Seeded ${listing.length} existing URLs. No Telegram alerts sent.`);return;}

  const newArticles=listing.filter(article=>!seenSet.has(article.url));
  const uniqueArticles=[];
  const titleSeen=new Set();
  let cheapSkipped=0;
  for(const article of newArticles){
    const fingerprint=normalizeTitle(article.title);
    if(titleSeen.has(fingerprint)){
      console.log(`Duplicate title skipped: ${article.title}`);
      continue;
    }
    titleSeen.add(fingerprint);
    if(cheapTitleFilter(article)){
      cheapSkipped++;
      seenSet.add(article.url);
      console.log(`Cheap filter skipped: ${article.title}`);
      continue;
    }
    uniqueArticles.push(article);
    if(uniqueArticles.length>=MAX_NEW_ARTICLES_PER_RUN)break;
  }

  if(!uniqueArticles.length){
    console.log(`No new articles. Cheap-filtered: ${cheapSkipped}.`);
    await saveSeen(store,[...seenSet]);
    return;
  }

  console.log(`${uniqueArticles.length} new article(s) sent to enrichment. Cheap-filtered: ${cheapSkipped}.`);
  const enriched=await mapWithConcurrency(uniqueArticles,MAX_CONCURRENT_ARTICLES,enrichArticle);
  const validArticles=enriched.filter(article=>article&&!article.error);
  console.log(`Article pages fetched: ${validArticles.length}`);
  const classified=await mapWithConcurrency(validArticles,MAX_CONCURRENT_LLM,async article=>({...article,relevant:await classifyWithGroq(article)}));
  const successful=classified.filter(result=>result&&!result.error);
  const relevant=successful.filter(article=>article.relevant);
  console.log(`LLM classified: ${successful.length}`);
  console.log(`NATGAS relevant: ${relevant.length}`);
  const sentUrls=[];
  for(const article of[...relevant].reverse()){try{await sendTelegram(article);sentUrls.push(article.url);console.log(`🚨 Sent to group: ${article.title}`);}catch(error){console.error(`Telegram failed for ${article.url}: ${error.message}`);}}
  for(const article of successful)seenSet.add(article.url);
  for(const url of sentUrls)seenSet.add(url);
  await saveSeen(store,[...seenSet]);
  console.log(`Complete: ${successful.length} classified, ${relevant.length} relevant, ${sentUrls.length} Telegram alerts sent, ${cheapSkipped} cheap-filtered.`);
}

export default async()=>{await run();};
export const config={schedule:"*/4 * * * *"};
