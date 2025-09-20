const Parser = require("rss-parser");
const fetch = require("node-fetch");
const xml2js = require("xml2js");
const logger = require("../utils/logger");

const parser = new Parser();

// ✅ Primary RSS feeds
const RSS_FEEDS = [
  "http://feeds.bbci.co.uk/news/rss.xml",
  "https://feeds.npr.org/1004/rss.xml",
  "https://www.theguardian.com/world/rss",
];

// ✅ Reuters sitemap (fallback)
const REUTERS_SITEMAP =
  "https://www.reuters.com/arc/outboundfeeds/sitemap-index/?outputType=xml";

// Helper: fetch and parse Reuters sitemap
async function fetchReutersArticles(limit = 30) {
  try {
    logger.info("Fetching Reuters sitemap...");

    const res = await fetch(REUTERS_SITEMAP);
    if (!res.ok) {
      throw new Error(`Reuters sitemap fetch failed: ${res.status}`);
    }

    const xml = await res.text();
    const result = await xml2js.parseStringPromise(xml);

    // Get all <loc> URLs
    const urls = result.sitemapindex.sitemap.map((s) => s.loc[0]).slice(0, 5); // first 5 sub-sitemaps

    let articles = [];
    for (const url of urls) {
      try {
        const subRes = await fetch(url);
        const subXml = await subRes.text();
        const subResult = await xml2js.parseStringPromise(subXml);

        const items = subResult.urlset.url
          .map((u) => ({
            title: u["news:news"]?.[0]?.["news:title"]?.[0] || "Untitled",
            link: u.loc?.[0],
            content:
              u["news:news"]?.[0]?.["news:keywords"]?.[0] ||
              u["news:news"]?.[0]?.["news:publication"]?.[0] ||
              "",
          }))
          .filter((a) => a.link);

        articles.push(...items);
      } catch (err) {
        logger.error(
          `Failed parsing Reuters sub-sitemap ${url}: ${err.message}`
        );
      }
    }

    return articles.slice(0, limit);
  } catch (err) {
    logger.error(`Reuters sitemap error: ${err.message}`);
    return [];
  }
}

// Main ingestion function
async function fetchNewsArticles(minArticles = 50) {
  let articles = [];

  // Step 1: Try RSS feeds
  for (const url of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(url);
      if (!feed.items?.length) {
        logger.warn(`No items in RSS: ${url}`);
        continue;
      }

      const feedArticles = feed.items.map((item) => ({
        title: item.title,
        link: item.link,
        content: item.contentSnippet || item.content || "",
      }));

      articles.push(...feedArticles);
      logger.info(`Fetched ${feedArticles.length} articles from ${url}`);
    } catch (err) {
      logger.error(`Failed to parse RSS ${url}: ${err.message}`);
    }
  }

  // Step 2: Fallback → Reuters sitemap if too few
  if (articles.length < minArticles) {
    logger.warn(
      `Only got ${articles.length} articles from RSS. Fetching Reuters sitemap...`
    );
    const reutersArticles = await fetchReutersArticles(minArticles);
    articles.push(...reutersArticles);
  }

  // Deduplicate by link
  const unique = [];
  const seen = new Set();
  for (const a of articles) {
    if (!seen.has(a.link)) {
      seen.add(a.link);
      unique.push(a);
    }
  }

  logger.info(`Total unique articles collected: ${unique.length}`);
  return unique.slice(0, minArticles); // cap at minArticles
}

module.exports = { fetchNewsArticles };
