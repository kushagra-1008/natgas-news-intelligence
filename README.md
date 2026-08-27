# NATGAS News Intelligence Bot — Netlify

## What it does

Every 4 minutes:

1. Scrapes the MarketScreener Commodities News feed.
2. Collects the broad article universe instead of using a NATGAS keyword filter.
3. Detects the publisher (Reuters, Dow Jones, etc.) when possible.
4. Finds only article URLs that have not been processed before.
5. Fetches each new article.
6. Sends the title + article text to a Groq model.
7. The model answers only YES/NO:
   "Could this materially affect US natural gas markets?"
8. Relevant articles are sent to Telegram.
9. Reuters + relevant gets a special 🚨 header.
10. Seen URLs are persisted in Netlify Blobs.

There is NO buy/sell system and NO detailed LLM market analysis in this version.

## Project structure

- `netlify/functions/natgas-news.mjs` — the complete scheduled bot.
- `netlify.toml` — Netlify configuration.
- `package.json` — dependencies.
- `README.md` — setup guide.

## 1. Create a GitHub repository

Create a new repository, for example:

`natgas-news-intelligence`

Upload all files from this project.

Do NOT upload `.env` files or API keys.

## 2. Connect the repo to Netlify

Netlify:
- Add new project
- Import an existing project
- Select GitHub
- Select your repository
- Deploy

No build command is required.

The function is scheduled by the `config` in `natgas-news.mjs`:

`*/4 * * * *`

That means every 4 minutes, using UTC.

Scheduled Functions run only for the published production deploy, not branch previews.

## 3. Add environment variables

Netlify:
Project configuration -> Environment variables

Add:

`TELEGRAM_BOT_TOKEN`
Your BotFather token.

`TELEGRAM_CHAT_ID`
Your Telegram chat ID.

`GROQ_KEY_1`
Your first Groq API key.

Optionally:
`GROQ_KEY_2`
`GROQ_KEY_3`
`GROQ_KEY_4`
`GROQ_KEY_5`

The code rotates through configured keys. Only configure credentials you are authorized to use; do not use key rotation to bypass provider quotas or account restrictions.

Optional:
`GROQ_MODEL`
Default: `openai/gpt-oss-20b`

`SEED_ON_FIRST_RUN`
Default: `true`

`MAX_NEW_ARTICLES_PER_RUN`
Default: `25`

`MAX_CONCURRENT_ARTICLES`
Default: `5`

`MAX_CONCURRENT_LLM`
Default: `5`

## 4. First deployment

Keep:

`SEED_ON_FIRST_RUN=true`

The first successful run records the currently visible article URLs and sends nothing.

This prevents a fresh deployment from dumping the existing feed into Telegram.

After that, only newly discovered URLs are processed.

## 5. Test

After deployment, open:

Netlify -> Functions -> `natgas-news`

Use Netlify's Run now control to trigger a test invocation.

Then inspect the function logs.

You want to see messages similar to:

`Listing contains 40 article links.`

`3 new article(s) to classify.`

`Complete: 3 classified, 1 relevant.`

If an article is relevant, Telegram should receive it.

## Telegram output

Relevant Reuters:

🚨 REUTERS — NATGAS RELEVANT

Title

Source: Reuters
Open article on MarketScreener

Other relevant source:

🟢 NATGAS RELEVANT

Title

Source: Dow Jones
Open article on MarketScreener

## How the LLM decides

The model is NOT asked for a market opinion.

It only checks whether the article could materially affect US natural gas through things such as:
- production / associated gas
- LNG exports / feedgas
- pipelines / processing
- storage
- weather / power burn
- US demand
- US energy infrastructure
- hurricanes
- related oil developments that can affect gas supply

The output must be exactly YES or NO.

## Important limitations

### MarketScreener
The scraper is based on the article links exposed by the commodities feed. If MarketScreener changes its HTML or only exposes some articles through another client-side request, the scraper may need to be adapted.

### Netlify
Scheduled Functions have a 30-second execution limit. This implementation uses concurrency and caps the amount of work per run for that reason.

### Groq
Groq enforces rate limits at the organization level. Do not assume multiple API keys automatically create additional legitimate quota. Check the limits shown for your own account/project.

### Persistent state
Netlify Blobs is used to store the processed URL list. It survives new deploys.

## Future upgrades

Once this works reliably, possible additions are:
- better article extraction
- better source detection
- Reuters-only priority channel
- LLM confidence/importance
- duplicate-story detection
- EIA/weather context
- daily digest
- historical news database

Do not add those until Version 1 is reliably delivering the correct articles.
