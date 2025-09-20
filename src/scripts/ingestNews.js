require("dotenv").config();
const logger = require("../utils/logger");
const { initializeServices, vectorUtils } = require("../config/database");
const { fetchNewsArticles } = require("../services/newsIngestion");
const fetch = require("node-fetch");

const COLLECTION_NAME = "news_embeddings";

// --- Helper: generate embeddings using Jina API ---
async function generateEmbedding(text) {
  try {
    const response = await fetch("https://api.jina.ai/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.JINA_API_KEY}`,
      },
      body: JSON.stringify({
        input: text,
        model: "jina-embeddings-v2-base-en", // free tier model
      }),
    });

    if (!response.ok) {
      throw new Error(`Jina API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data[0].embedding;
  } catch (err) {
    logger.error(`Error generating embedding: ${err.message}`);
    return null;
  }
}

// --- Main ingestion script ---
async function run() {
  try {
    logger.info("=== Starting news ingestion script ===");

    // Step 1: initialize services (Redis + Qdrant)
    await initializeServices();
    logger.info("Services initialized successfully");

    // Step 2: fetch news articles (~50 minimum)
    const articles = await fetchNewsArticles(50);
    logger.info(`Fetched ${articles.length} articles`);

    if (articles.length === 0) {
      logger.error("No articles found, aborting ingestion.");
      return;
    }

    // Step 3: process each article → embed → store in Qdrant
    let successCount = 0;

    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      if (!article.content) continue;

      logger.info(
        `Processing article ${i + 1}/${
          articles.length
        }: ${article.title?.substring(0, 50)}...`
      );

      const embedding = await generateEmbedding(article.content);
      if (!embedding) {
        logger.warn(`Skipping article ${i + 1}: No embedding generated`);
        continue;
      }

      try {
        // Use numeric ID instead of string with underscore
        const numericId = Date.now() + i; // This ensures unique numeric IDs

        await vectorUtils.addEmbedding(numericId, embedding, {
          title: article.title || "Untitled",
          link: article.link || "",
          content: article.content.substring(0, 1000), // Limit content length
          source: "news_ingestion",
          timestamp: new Date().toISOString(),
        });

        successCount++;
        logger.info(
          `✅ Successfully added embedding ${successCount}/${articles.length}`
        );
      } catch (err) {
        logger.error(
          `Failed to add embedding for article ${i + 1}: ${err.message}`
        );
      }
    }

    // Step 4: Summary
    logger.info("=== Ingestion Finished ===");
    logger.info(`✅ Articles fetched: ${articles.length}`);
    logger.info(`✅ Embeddings stored in Qdrant: ${successCount}`);
  } catch (err) {
    logger.error("Error running ingestion:", err);
  }
}

// Run the script
run();
