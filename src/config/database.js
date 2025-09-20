require("dotenv").config();
const Redis = require("ioredis");
const fetch = require("node-fetch");
const logger = require("../utils/logger");

let redis;

// ----------------------------
// Redis Initialization
// ----------------------------
const initializeRedis = async () => {
  try {
    redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    redis.on("connect", () => logger.info("Redis connected"));
    redis.on("error", (err) => logger.error("Redis error:", err));

    await redis.ping();
    logger.info("Redis connection established");
    return redis;
  } catch (err) {
    logger.error("Redis initialization failed:", err);
    throw err;
  }
};

// ----------------------------
// Qdrant HTTP API Functions
// ----------------------------
const qdrantHttp = {
  baseUrl: process.env.QDRANT_URL || "http://localhost:6333",
  apiKey: process.env.QDRANT_API_KEY || "",

  // Helper to build headers with API key if present
  getHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers["api-key"] = this.apiKey;
    return headers;
  },

  async getCollection(collectionName) {
    const response = await fetch(
      `${this.baseUrl}/collections/${collectionName}`,
      { headers: this.getHeaders() }
    );
    if (response.ok) return await response.json();
    throw new Error(`Collection not found: ${response.status}`);
  },

  async createCollection(collectionName, config) {
    const response = await fetch(
      `${this.baseUrl}/collections/${collectionName}`,
      {
        method: "PUT",
        headers: this.getHeaders(),
        body: JSON.stringify(config),
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Create collection failed: ${response.status} - ${errorText}`
      );
    }
    return await response.json();
  },

  async deleteCollection(collectionName) {
    const response = await fetch(
      `${this.baseUrl}/collections/${collectionName}`,
      {
        method: "DELETE",
        headers: this.getHeaders(),
      }
    );
    if (!response.ok)
      throw new Error(`Delete collection failed: ${response.status}`);
    return true;
  },

  async upsertPoints(collectionName, points) {
    const response = await fetch(
      `${this.baseUrl}/collections/${collectionName}/points?wait=true`,
      {
        method: "PUT",
        headers: this.getHeaders(),
        body: JSON.stringify({ points }),
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    return await response.json();
  },

  async searchPoints(collectionName, searchParams) {
    const response = await fetch(
      `${this.baseUrl}/collections/${collectionName}/points/search`,
      {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify(searchParams),
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    return await response.json();
  },
};

// ----------------------------
// Qdrant Initialization (HTTP only)
// ----------------------------
const initializeQdrant = async () => {
  try {
    const collectionName = "news_embeddings";

    // Test connection first
    const healthResponse = await fetch(`${qdrantHttp.baseUrl}/`, {
      headers: qdrantHttp.getHeaders(),
    });
    if (!healthResponse.ok) {
      throw new Error(`Qdrant not accessible at ${qdrantHttp.baseUrl}`);
    }

    try {
      // Check if collection exists
      const collectionInfo = await qdrantHttp.getCollection(collectionName);
      const currentSize = collectionInfo.result?.config?.params?.vectors?.size;

      // Check if dimensions match
      if (currentSize !== 768) {
        logger.info(
          `Deleting existing collection with wrong dimensions (${currentSize})`
        );
        await qdrantHttp.deleteCollection(collectionName);
        logger.info("Collection deleted successfully");
        throw new Error("Need to recreate collection");
      }

      logger.info(
        `Qdrant collection '${collectionName}' found with correct dimensions (768)`
      );
    } catch (error) {
      // Collection doesn't exist or was deleted - create it
      logger.info(
        `Creating collection '${collectionName}' with 768 dimensions`
      );

      await qdrantHttp.createCollection(collectionName, {
        vectors: {
          size: 768, // Correct Jina v2-base-en embedding size
          distance: "Cosine",
        },
      });

      logger.info(`Qdrant collection '${collectionName}' created successfully`);
    }

    logger.info("Qdrant connection established");
    return qdrantHttp;
  } catch (err) {
    logger.error("Qdrant initialization failed:", err);
    throw err;
  }
};

// ----------------------------
// Initialize All Services
// ----------------------------
const initializeServices = async () => {
  await Promise.all([initializeRedis(), initializeQdrant()]);
};

// ----------------------------
// Session Utilities (Redis)
// ----------------------------
const sessionUtils = {
  async createSession(sessionId) {
    const sessionKey = `session:${sessionId}`;
    const sessionData = {
      id: sessionId,
      createdAt: new Date().toISOString(),
      messagesCount: 0,
    };
    await redis.hset(sessionKey, sessionData);
    await redis.expire(sessionKey, parseInt(process.env.SESSION_TTL) || 86400);
    return sessionData;
  },

  async getSession(sessionId) {
    const sessionKey = `session:${sessionId}`;
    const session = await redis.hgetall(sessionKey);
    return Object.keys(session).length ? session : null;
  },

  async deleteSession(sessionId) {
    const sessionKey = `session:${sessionId}`;
    const messagesKey = `messages:${sessionId}`;
    await Promise.all([redis.del(sessionKey), redis.del(messagesKey)]);
  },

  async addMessage(sessionId, message) {
    const messagesKey = `messages:${sessionId}`;
    const sessionKey = `session:${sessionId}`;
    await redis.lpush(
      messagesKey,
      JSON.stringify({
        ...message,
        timestamp: new Date().toISOString(),
      })
    );
    await redis.hincrby(sessionKey, "messagesCount", 1);
    await redis.expire(
      messagesKey,
      parseInt(process.env.CHAT_HISTORY_TTL) || 3600
    );
  },

  async getMessages(sessionId, limit = 50) {
    const messagesKey = `messages:${sessionId}`;
    const messages = await redis.lrange(messagesKey, 0, limit - 1);
    return messages.map((msg) => JSON.parse(msg)).reverse();
  },
};

// ----------------------------
// Vector Store Utilities (HTTP API)
// ----------------------------
const vectorUtils = {
  async addEmbedding(id, embedding, metadata) {
    const collectionName = "news_embeddings";

    try {
      const result = await qdrantHttp.upsertPoints(collectionName, [
        {
          id: parseInt(id) || Date.now(),
          vector: embedding,
          payload: metadata,
        },
      ]);

      return result;
    } catch (error) {
      logger.error(`Qdrant upsert error details:`, {
        message: error.message,
        id: id,
        embeddingLength: embedding?.length,
        metadataKeys: Object.keys(metadata || {}),
      });
      throw error;
    }
  },

  async searchSimilar(queryEmbedding, limit = 5) {
    const collectionName = "news_embeddings";

    try {
      const result = await qdrantHttp.searchPoints(collectionName, {
        vector: queryEmbedding,
        limit: limit,
        with_payload: true,
        score_threshold: 0.7,
      });

      return result.result.map((point) => ({
        id: point.id,
        score: point.score,
        metadata: point.payload,
      }));
    } catch (error) {
      logger.error(`Qdrant search error:`, error.message);
      throw error;
    }
  },
};

// ----------------------------
// Exports
// ----------------------------
module.exports = {
  initializeServices,
  get redis() {
    return redis;
  },
  get qdrant() {
    return qdrantHttp;
  },
  sessionUtils,
  vectorUtils,
};
