// src/app.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const http = require("http");
const { Server } = require("socket.io");

const chatRoutes = require("./routes/chat");
const sessionRoutes = require("./routes/sessions");
const {
  initializeServices,
  sessionUtils,
  vectorUtils,
} = require("./config/database");
const logger = require("./utils/logger");

const app = express();
const PORT = process.env.PORT || 3001;

// ----------------------------
// Middleware
// ----------------------------
app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(morgan("combined"));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ----------------------------
// REST API Routes
// ----------------------------
app.use("/api/chat", chatRoutes);
app.use("/api/sessions", sessionRoutes);

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error("Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Something went wrong",
  });
});

// ----------------------------
// HTTP Server & Socket.IO
// ----------------------------
const server = http.createServer(app);
const io = new Server(server, {
  path: "/ws",
  cors: {
    origin: process.env.FRONTEND_URL || "https://intellinews.onrender.com",
    methods: ["GET", "POST"],
  },
});

// Handle WebSocket connections
io.on("connection", (socket) => {
  logger.info(`User connected via WebSocket: ${socket.id}`);

  socket.on("chatMessage", async (data) => {
    try {
      // Example: store session message in Redis
      if (data.sessionId && data.message) {
        await sessionUtils.addMessage(data.sessionId, {
          sender: "user",
          text: data.message,
        });
      }

      // Example: generate bot response
      const botReply = { sender: "bot", text: "Processing..." };
      socket.emit("chatResponse", botReply);

      // TODO: call RAG pipeline, Qdrant search, Gemini API, etc.
      // Once response is ready, emit back to frontend:
      // socket.emit("chatResponse", { sender: "bot", text: finalAnswer });
    } catch (error) {
      logger.error("WebSocket chat error:", error);
      socket.emit("chatResponse", { sender: "bot", text: "Error occurred." });
    }
  });

  socket.on("disconnect", () => {
    logger.info(`User disconnected: ${socket.id}`);
  });
});

// ----------------------------
// Start server after initializing services
// ----------------------------
async function startServer() {
  try {
    await initializeServices();
    logger.info("Services initialized successfully");

    server.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV}`);
    });
  } catch (error) {
    logger.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("Shutting down gracefully...");
  process.exit(0);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Run server
if (require.main === module) {
  startServer();
}

module.exports = app;