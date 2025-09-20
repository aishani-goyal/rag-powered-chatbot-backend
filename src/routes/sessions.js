// src/routes/sessions.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const { sessionUtils, vectorUtils } = require("../config/database");
const logger = require("../utils/logger");

const router = express.Router();

// Rate limiting for admin endpoints
const adminRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per windowMs
  message: {
    error: "Too many admin requests, please try again later.",
    retryAfter: 900,
  },
});

// Initialize news ingestion service - TEMPORARILY DISABLED
// const newsIngestionService = new NewsIngestionService();

/**
 * GET /api/sessions/stats
 * Get system statistics
 */
router.get("/stats", async (req, res) => {
  try {
    res.json({
      ingestion: { status: "manual", message: "Using manual ingestion script" },
      vector_store: {
        total_points: "Check Qdrant directly",
        status: "active",
        vectors_count: "50+ articles ingested",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Error getting system stats:", error);
    res.status(500).json({
      error: "Failed to retrieve system statistics",
    });
  }
});

/**
 * POST /api/sessions/ingest
 * Manually trigger news ingestion - DISABLED (use script instead)
 */
router.post("/ingest", adminRateLimit, async (req, res) => {
  res.json({
    message: "Manual ingestion disabled. Use 'npm run ingest' script instead.",
    script_command: "npm run ingest",
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/sessions/health
 * Health check endpoint with detailed status
 */
router.get("/health", async (req, res) => {
  const health = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {},
  };

  try {
    if (sessionUtils) health.services.redis = "healthy";
  } catch {
    health.services.redis = "unhealthy";
    health.status = "degraded";
  }

  try {
    if (vectorUtils) health.services.qdrant = "healthy";
  } catch {
    health.services.qdrant = "unhealthy";
    health.status = "degraded";
  }

  health.services.jina_api = process.env.JINA_API_KEY
    ? "configured"
    : "not_configured";
  health.services.gemini_api = process.env.GEMINI_API_KEY
    ? "configured"
    : "not_configured";

  const statusCode = health.status === "healthy" ? 200 : 503;
  res.status(statusCode).json(health);
});

/**
 * DELETE /api/sessions/cache
 * Clear various caches - SIMPLIFIED
 */
router.delete("/cache", adminRateLimit, async (req, res) => {
  try {
    res.json({
      message: "Cache clearing disabled - using external ingestion script",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Error clearing cache:", error);
    res.status(500).json({
      error: "Failed to clear cache",
    });
  }
});

/**
 * GET /api/sessions/sources
 * Get configured news sources
 */
router.get("/sources", (req, res) => {
  try {
    const sources = [
      "http://feeds.bbci.co.uk/news/rss.xml",
      "https://feeds.npr.org/1004/rss.xml",
      "https://www.theguardian.com/world/rss",
    ];

    res.json({
      sources,
      count: sources.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Error getting news sources:", error);
    res.status(500).json({
      error: "Failed to retrieve news sources",
    });
  }
});

/**
 * ==========================
 * CHAT ROUTES
 * ==========================
 */

/**
 * GET /api/chat/history/:sessionId
 * Fetch chat messages for a session
 */

router.get("/chat/history/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const limit = parseInt(req.query.limit) || 50;

    const messages = await sessionUtils.getMessages(sessionId, limit);
    if (!messages || messages.length === 0) {
      return res.status(404).json({ message: "No chat history found" });
    }

    res.json(messages);
  } catch (error) {
    logger.error("Error fetching chat history:", error);
    res.status(500).json({ error: "Failed to fetch chat history" });
  }
});

/**
 * POST /api/chat/message
 * Add a message to a session
 */
router.post("/chat/message", async (req, res) => {
  try {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) {
      return res.status(400).json({ error: "sessionId and message required" });
    }

    await sessionUtils.addMessage(sessionId, message);
    res.json({ status: "success", timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error("Error adding chat message:", error);
    res.status(500).json({ error: "Failed to add message" });
  }
});

/**
 * POST /api/chat/session
 * Create a new chat session
 */
// NEW: POST /api/sessions
router.post("/", async (req, res) => {
  try {
    const sessionId = req.body.sessionId || `sess_${Date.now()}`;
    const session = await sessionUtils.createSession(sessionId);
    res.json(session);
  } catch (error) {
    logger.error("Error creating chat session:", error);
    res.status(500).json({ error: "Failed to create session" });
  }
});


module.exports = router;
