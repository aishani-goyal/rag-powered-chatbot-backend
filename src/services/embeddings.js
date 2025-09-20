// src/services/embeddings.js
const axios = require("axios");
const logger = require("../utils/logger");

class EmbeddingsService {
  constructor() {
    this.jinaApiKey = process.env.JINA_API_KEY;
    this.baseUrl = "https://api.jina.ai/v1/embeddings";

    if (!this.jinaApiKey) {
      throw new Error("JINA_API_KEY is required");
    }
  }

  /**
   * Generate embeddings for text using Jina AI
   * @param {string|string[]} texts - Text or array of texts to embed
   * @returns {Promise<number[]|number[][]>} Embedding vector(s)
   */
  async generateEmbeddings(texts) {
    try {
      const isArray = Array.isArray(texts);
      const inputTexts = isArray ? texts : [texts];

      // Enhanced validation
      const validTexts = inputTexts.filter((text) => {
        if (!text || typeof text !== "string") return false;
        const trimmed = text.trim();
        return trimmed.length > 0 && trimmed.length <= 8192; // Jina AI max token limit
      });

      if (validTexts.length === 0) {
        throw new Error("No valid texts provided for embedding");
      }

      if (validTexts.length !== inputTexts.length) {
        logger.warn(
          `Filtered out ${inputTexts.length - validTexts.length} invalid texts`
        );
      }

      // Clean and prepare texts for embedding
      const processedTexts = validTexts.map((text) =>
        this.prepareTextForEmbedding(text)
      );

      logger.debug(`Generating embeddings for ${processedTexts.length} texts`, {
        lengths: processedTexts.map((t) => t.length),
        previews: processedTexts.map((t) => t.substring(0, 50) + "..."),
      });

      const response = await axios.post(
        this.baseUrl,
        {
          model: "jina-embeddings-v2-base-en",
          input: processedTexts,
          encoding_format: "float",
        },
        {
          headers: {
            Authorization: `Bearer ${this.jinaApiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 60000, // Increased to 60 seconds
        }
      );

      if (!response.data || !response.data.data) {
        throw new Error("Invalid response format from Jina API");
      }

      const embeddings = response.data.data.map((item) => {
        if (!item.embedding || !Array.isArray(item.embedding)) {
          throw new Error("Invalid embedding format in response");
        }
        return item.embedding;
      });

      // Log usage for monitoring
      logger.info(`Generated embeddings for ${processedTexts.length} texts`, {
        usage: response.data.usage,
        model: response.data.model,
        embeddingDimensions: embeddings[0]?.length || 0,
      });

      return isArray ? embeddings : embeddings[0];
    } catch (error) {
      logger.error("Error generating embeddings:", {
        message: error.message,
        textsCount: Array.isArray(texts) ? texts.length : 1,
        textLengths: Array.isArray(texts)
          ? texts.map((t) => t?.length || 0)
          : [texts?.length || 0],
      });

      if (error.response) {
        logger.error("API Error Details:", {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
          headers: error.response.headers,
        });

        // Handle specific error cases
        if (error.response.status === 422) {
          throw new Error(
            `Jina API validation error: ${JSON.stringify(error.response.data)}`
          );
        } else if (error.response.status === 429) {
          throw new Error("Rate limit exceeded. Please try again later.");
        } else if (error.response.status === 401) {
          throw new Error("Invalid API key. Please check your JINA_API_KEY.");
        }
      }

      throw new Error(`Failed to generate embeddings: ${error.message}`);
    }
  }

  /**
   * Prepare text for embedding by cleaning and validating
   * @param {string} text
   * @returns {string}
   */
  prepareTextForEmbedding(text) {
    if (!text || typeof text !== "string") {
      return "";
    }

    let processed = text;

    // Remove control characters and non-printable characters
    processed = processed.replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,
      ""
    );

    // Normalize Unicode
    processed = processed.normalize("NFC");

    // Remove zero-width characters
    processed = processed.replace(/[\u200B-\u200D\uFEFF]/g, "");

    // Clean up excessive whitespace
    processed = processed.replace(/\s+/g, " ").trim();

    // Remove problematic characters that might cause API issues
    processed = processed.replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, "");

    // Ensure reasonable length (Jina AI works best with texts under 8192 characters)
    if (processed.length > 8000) {
      processed = processed.substring(0, 8000);
      // Try to break at sentence boundary
      const lastPeriod = processed.lastIndexOf(".");
      const lastExclamation = processed.lastIndexOf("!");
      const lastQuestion = processed.lastIndexOf("?");
      const lastSentenceEnd = Math.max(
        lastPeriod,
        lastExclamation,
        lastQuestion
      );

      if (lastSentenceEnd > 7000) {
        processed = processed.substring(0, lastSentenceEnd + 1);
      }
    }

    return processed;
  }

  /**
   * Generate embeddings with retry logic
   * @param {string|string[]} texts
   * @param {number} maxRetries
   * @returns {Promise<number[]|number[][]>}
   */
  async generateEmbeddingsWithRetry(texts, maxRetries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Add delay before each attempt (including first one for rate limiting)
        const baseDelay = 1000; // 1 second base delay
        const retryDelay = attempt > 1 ? Math.pow(2, attempt - 1) * 1000 : 0;
        const totalDelay = baseDelay + retryDelay;

        if (totalDelay > 0) {
          logger.debug(
            `Waiting ${totalDelay}ms before embedding attempt ${attempt}`
          );
          await new Promise((resolve) => setTimeout(resolve, totalDelay));
        }

        const result = await this.generateEmbeddings(texts);

        if (attempt > 1) {
          logger.info(`Embedding succeeded on attempt ${attempt}`);
        }

        return result;
      } catch (error) {
        lastError = error;

        logger.warn(`Embedding attempt ${attempt}/${maxRetries} failed:`, {
          error: error.message,
          status: error.response?.status,
        });

        // Don't retry on certain errors
        if (error.response) {
          const status = error.response.status;
          if (status === 401 || status === 403) {
            // Authentication errors - don't retry
            throw error;
          }
          if (status === 422 && attempt === maxRetries) {
            // Validation error on final attempt - log details and throw
            logger.error("Final validation error details:", {
              requestData: error.config?.data,
              responseData: error.response.data,
            });
            throw error;
          }
        }

        if (attempt === maxRetries) {
          logger.error(`All ${maxRetries} embedding attempts failed`);
        }
      }
    }

    throw lastError;
  }

  /**
   * Process text for embedding (cleaning, chunking)
   * @param {string} text
   * @returns {string[]} Processed text chunks
   */
  processTextForEmbedding(text) {
    if (!text || typeof text !== "string") {
      return [];
    }

    // Initial cleaning
    const cleanText = this.prepareTextForEmbedding(text);

    if (!cleanText || cleanText.length < 10) {
      return [];
    }

    // For texts under the limit, return as single chunk
    const maxLength = 7500; // Conservative limit for Jina AI

    if (cleanText.length <= maxLength) {
      return [cleanText];
    }

    // Smart sentence-based chunking for long texts
    const sentences = cleanText
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.trim().length > 0);

    const chunks = [];
    let currentChunk = "";

    for (const sentence of sentences) {
      const trimmedSentence = sentence.trim();
      if (!trimmedSentence) continue;

      // Check if adding this sentence would exceed the limit
      const potentialChunk = currentChunk
        ? `${currentChunk} ${trimmedSentence}`
        : trimmedSentence;

      if (potentialChunk.length <= maxLength) {
        currentChunk = potentialChunk;
      } else {
        // Current chunk is full, save it and start a new one
        if (currentChunk) {
          chunks.push(currentChunk);
        }

        // If single sentence is too long, truncate it
        if (trimmedSentence.length > maxLength) {
          currentChunk = trimmedSentence.substring(0, maxLength);
        } else {
          currentChunk = trimmedSentence;
        }
      }
    }

    // Add the final chunk
    if (currentChunk) {
      chunks.push(currentChunk);
    }

    // Fallback: if no chunks created, create chunks by character split
    if (chunks.length === 0) {
      for (let i = 0; i < cleanText.length; i += maxLength) {
        chunks.push(cleanText.substring(i, i + maxLength));
      }
    }

    // Filter out chunks that are too short or invalid
    const validChunks = chunks.filter(
      (chunk) =>
        chunk && chunk.trim().length >= 10 && chunk.trim().length <= 8000
    );

    logger.debug(`Processed text into ${validChunks.length} chunks`, {
      originalLength: text.length,
      cleanedLength: cleanText.length,
      chunkLengths: validChunks.map((c) => c.length),
    });

    return validChunks;
  }

  /**
   * Calculate cosine similarity between two vectors
   * @param {number[]} vectorA
   * @param {number[]} vectorB
   * @returns {number} Similarity score (0-1)
   */
  calculateSimilarity(vectorA, vectorB) {
    if (!vectorA || !vectorB || vectorA.length !== vectorB.length) {
      throw new Error("Vectors must be valid and have the same dimension");
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vectorA.length; i++) {
      dotProduct += vectorA[i] * vectorB[i];
      normA += vectorA[i] * vectorA[i];
      normB += vectorB[i] * vectorB[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Batch process embeddings with rate limiting
   * @param {string[]} texts
   * @param {number} batchSize
   * @param {number} delayMs
   * @returns {Promise<number[][]>}
   */
  async batchGenerateEmbeddings(texts, batchSize = 5, delayMs = 2000) {
    const allEmbeddings = [];

    logger.info(`Processing ${texts.length} texts in batches of ${batchSize}`);

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(texts.length / batchSize);

      logger.debug(
        `Processing batch ${batchNumber}/${totalBatches} (${batch.length} items)`
      );

      try {
        const embeddings = await this.generateEmbeddingsWithRetry(batch);
        allEmbeddings.push(
          ...(Array.isArray(embeddings[0]) ? embeddings : [embeddings])
        );

        logger.debug(`Batch ${batchNumber} completed successfully`);

        // Rate limiting delay between batches
        if (i + batchSize < texts.length) {
          logger.debug(`Waiting ${delayMs}ms before next batch`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      } catch (error) {
        logger.error(`Failed to process batch ${batchNumber}:`, error.message);

        // Try individual texts in the failed batch
        logger.info(
          `Attempting individual processing for failed batch ${batchNumber}`
        );
        for (const text of batch) {
          try {
            const embedding = await this.generateEmbeddingsWithRetry(text);
            allEmbeddings.push(embedding);
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } catch (individualError) {
            logger.error(
              "Failed to process individual text:",
              individualError.message
            );
            allEmbeddings.push(null);
          }
        }
      }
    }

    const successCount = allEmbeddings.filter((e) => e !== null).length;
    logger.info(
      `Batch processing completed: ${successCount}/${texts.length} successful`
    );

    return allEmbeddings;
  }
}

module.exports = EmbeddingsService;
