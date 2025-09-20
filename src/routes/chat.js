// src/routes/chat.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const LLMService = require("../services/llmService");
const { vectorUtils } = require("../config/database");
const fetch = require("node-fetch");
const logger = require("../utils/logger");

const router = express.Router();

// Initialize LLM service
const llmService = new LLMService();

// Rate limiting
const chatRateLimit = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  message: { error: "Too many chat requests, slow down.", retryAfter: 60 },
});

// Generate embeddings helper
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
        model: "jina-embeddings-v2-base-en",
      }),
    });
    if (!response.ok) throw new Error(`Jina API error: ${response.status}`);
    const data = await response.json();
    return data.data[0].embedding;
  } catch (err) {
    logger.error(`Error generating embedding: ${err.message}`);
    return null;
  }
}

// POST /api/chat/message
router.post("/message", chatRateLimit, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message is required" });

  try {
    const queryEmbedding = await generateEmbedding(message);
    if (!queryEmbedding)
      return res.status(500).json({ error: "Failed to generate embedding" });

    const relevantArticles = await vectorUtils.searchSimilar(queryEmbedding, 3);

    const aiResponse = await llmService.generateResponse(
      message,
      relevantArticles
    );

    res.json({
      response: aiResponse,
      sources: relevantArticles.map((a) => ({
        title: a.metadata.title,
        link: a.metadata.link,
        score: a.score,
      })),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Error sending message:", error);
    res.status(500).json({ error: "Failed to process message" });
  }
});

// Health endpoint
router.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

module.exports = router;
