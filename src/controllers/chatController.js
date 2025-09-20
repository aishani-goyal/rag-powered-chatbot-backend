// src/controllers/chatController.js
const { v4: uuidv4 } = require("uuid");
const { sessionUtils, vectorUtils } = require("../config/database");
const EmbeddingsService = require("../services/embeddings");
const LLMService = require("../services/llm");
const logger = require("../utils/logger");

class ChatController {
  constructor() {
    this.embeddingsService = new EmbeddingsService();
    this.llmService = new LLMService();
  }

  /**
   * Handle chat message
   * @param {Object} req
   * @param {Object} res
   */
  async sendMessage(req, res) {
    try {
      const { message, sessionId } = req.body;

      // Validate input
      if (
        !message ||
        typeof message !== "string" ||
        message.trim().length === 0
      ) {
        return res.status(400).json({
          error: "Message is required and must be a non-empty string",
        });
      }

      if (!sessionId) {
        return res.status(400).json({
          error: "Session ID is required",
        });
      }

      const userMessage = message.trim();
      logger.info("Processing chat message", {
        sessionId,
        messageLength: userMessage.length,
      });

      // Get or create session
      let session = await sessionUtils.getSession(sessionId);
      if (!session) {
        session = await sessionUtils.createSession(sessionId);
      }

      // Get conversation history
      const conversationHistory = await sessionUtils.getMessages(sessionId);

      // Add user message to history
      await sessionUtils.addMessage(sessionId, {
        role: "user",
        content: userMessage,
      });

      // Check if query is news-related
      const isNewsRelated = await this.llmService.isNewsRelated(userMessage);

      let response;
      if (isNewsRelated) {
        // Process with RAG pipeline
        response = await this.processRAGQuery(userMessage, conversationHistory);
      } else {
        // Generate general response
        response = await this.llmService.generateFallbackResponse(userMessage);
      }

      // Add assistant message to history
      await sessionUtils.addMessage(sessionId, {
        role: "assistant",
        content: response.response,
        sources: response.sources || [],
      });

      res.json({
        sessionId,
        message: response.response,
        sources: response.sources || [],
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error("Error in sendMessage:", error);
      res.status(500).json({
        error: "Failed to process message",
        message:
          process.env.NODE_ENV === "development"
            ? error.message
            : "Internal server error",
      });
    }
  }

  /**
   * Handle streaming chat message
   * @param {Object} req
   * @param {Object} res
   */
  async sendMessageStream(req, res) {
    try {
      const { message, sessionId } = req.body;

      // Validate input
      if (
        !message ||
        typeof message !== "string" ||
        message.trim().length === 0
      ) {
        return res.status(400).json({ error: "Message is required" });
      }

      if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required" });
      }

      // Set up Server-Sent Events
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Cache-Control",
      });

      const userMessage = message.trim();
      logger.info("Processing streaming chat message", { sessionId });

      // Get or create session
      let session = await sessionUtils.getSession(sessionId);
      if (!session) {
        session = await sessionUtils.createSession(sessionId);
      }

      // Get conversation history
      const conversationHistory = await sessionUtils.getMessages(sessionId);

      // Add user message to history
      await sessionUtils.addMessage(sessionId, {
        role: "user",
        content: userMessage,
      });

      // Send initial metadata
      const metadata = {
        sessionId,
        timestamp: new Date().toISOString(),
        type: "metadata",
      };
      res.write(`data: ${JSON.stringify(metadata)}\n\n`);

      // Check if query is news-related and get context
      const isNewsRelated = await this.llmService.isNewsRelated(userMessage);
      let retrievedDocuments = [];

      if (isNewsRelated) {
        // Perform RAG retrieval
        const queryEmbedding =
          await this.embeddingsService.generateEmbeddingsWithRetry(userMessage);
        retrievedDocuments = await vectorUtils.searchSimilar(queryEmbedding, 5);

        // Send sources information
        if (retrievedDocuments.length > 0) {
          const sources = retrievedDocuments.map((doc) => ({
            title: doc.metadata.title || "Untitled",
            url: doc.metadata.url,
            score: doc.score,
          }));

          res.write(
            `data: ${JSON.stringify({
              type: "sources",
              sources,
            })}\n\n`
          );
        }
      }

      // Generate streaming response
      let fullResponse = "";
      const responseGenerator = this.llmService.generateStreamingResponse(
        userMessage,
        retrievedDocuments,
        conversationHistory
      );

      for await (const chunk of responseGenerator) {
        fullResponse += chunk;
        res.write(
          `data: ${JSON.stringify({
            type: "content",
            content: chunk,
          })}\n\n`
        );
      }

      // Send completion signal
      res.write(
        `data: ${JSON.stringify({
          type: "complete",
          fullResponse,
        })}\n\n`
      );

      // Add assistant message to history
      const sources = retrievedDocuments.map((doc) => ({
        title: doc.metadata.title || "Untitled",
        url: doc.metadata.url,
        snippet: doc.metadata.chunk_text?.substring(0, 150) || "",
        score: doc.score,
      }));

      await sessionUtils.addMessage(sessionId, {
        role: "assistant",
        content: fullResponse,
        sources,
      });

      res.end();
    } catch (error) {
      logger.error("Error in sendMessageStream:", error);

      res.write(
        `data: ${JSON.stringify({
          type: "error",
          error: "Failed to process message",
        })}\n\n`
      );
      res.end();
    }
  }

  /**
   * Process query using RAG pipeline
   * @param {string} query
   * @param {Array} conversationHistory
   * @returns {Promise<{response: string, sources: Array}>}
   */
  async processRAGQuery(query, conversationHistory = []) {
    try {
      // Expand query for better retrieval
      const expandedQuery = await this.llmService.expandQuery(query);
      const searchQuery = `${query} ${expandedQuery}`.trim();

      // Generate embedding for the search query
      const queryEmbedding =
        await this.embeddingsService.generateEmbeddingsWithRetry(searchQuery);

      // Retrieve similar documents
      const retrievedDocuments = await vectorUtils.searchSimilar(
        queryEmbedding,
        5
      );

      logger.info("RAG retrieval completed", {
        documentsFound: retrievedDocuments.length,
        averageScore:
          retrievedDocuments.length > 0
            ? retrievedDocuments.reduce((sum, doc) => sum + doc.score, 0) /
              retrievedDocuments.length
            : 0,
      });

      // Generate response using LLM with retrieved context
      if (retrievedDocuments.length > 0) {
        return await this.llmService.generateRAGResponseWithRetry(
          query,
          retrievedDocuments,
          conversationHistory
        );
      } else {
        // No relevant documents found
        return await this.llmService.generateFallbackResponse(query);
      }
    } catch (error) {
      logger.error("Error in RAG processing:", error);
      throw error;
    }
  }

  /**
   * Get chat history for a session
   * @param {Object} req
   * @param {Object} res
   */
  async getChatHistory(req, res) {
    try {
      const { sessionId } = req.params;
      const { limit = 50 } = req.query;

      if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required" });
      }

      const session = await sessionUtils.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      const messages = await sessionUtils.getMessages(
        sessionId,
        parseInt(limit)
      );

      res.json({
        sessionId,
        messages,
        session,
        count: messages.length,
      });
    } catch (error) {
      logger.error("Error getting chat history:", error);
      res.status(500).json({
        error: "Failed to retrieve chat history",
        message:
          process.env.NODE_ENV === "development"
            ? error.message
            : "Internal server error",
      });
    }
  }

  /**
   * Clear chat history for a session
   * @param {Object} req
   * @param {Object} res
   */
  async clearChatHistory(req, res) {
    try {
      const { sessionId } = req.params;

      if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required" });
      }

      await sessionUtils.deleteSession(sessionId);

      res.json({
        message: "Chat history cleared successfully",
        sessionId,
      });
    } catch (error) {
      logger.error("Error clearing chat history:", error);
      res.status(500).json({
        error: "Failed to clear chat history",
        message:
          process.env.NODE_ENV === "development"
            ? error.message
            : "Internal server error",
      });
    }
  }

  /**
   * Create new session
   * @param {Object} req
   * @param {Object} res
   */
  async createSession(req, res) {
    try {
      const sessionId = uuidv4();
      const session = await sessionUtils.createSession(sessionId);

      res.json({
        sessionId,
        session,
        message: "Session created successfully",
      });
    } catch (error) {
      logger.error("Error creating session:", error);
      res.status(500).json({
        error: "Failed to create session",
        message:
          process.env.NODE_ENV === "development"
            ? error.message
            : "Internal server error",
      });
    }
  }

  /**
   * Get session info
   * @param {Object} req
   * @param {Object} res
   */
  async getSession(req, res) {
    try {
      const { sessionId } = req.params;

      if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required" });
      }

      const session = await sessionUtils.getSession(sessionId);
      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      res.json({
        sessionId,
        session,
      });
    } catch (error) {
      logger.error("Error getting session:", error);
      res.status(500).json({
        error: "Failed to retrieve session",
        message:
          process.env.NODE_ENV === "development"
            ? error.message
            : "Internal server error",
      });
    }
  }
}

module.exports = new ChatController();