# RAG-Powered News Chatbot - Backend

Node.js + Express backend for the RAG-Powered News Chatbot. Handles API requests, session management, RAG pipeline, and news ingestion.

## 🚀 Features

- REST API + Streaming support (WebSocket/SSE)
- RAG pipeline with embeddings & vector search
- Session management with Redis
- Optional persistent storage for chat transcripts
- News ingestion from RSS feeds

## 🛠 Tech Stack

- Node.js + Express
- Redis (sessions & caching)
- Qdrant (vector database)
- Jina AI (embeddings)
- Google Gemini API (LLM)

## 📋 Prerequisites

- Node.js v18+
- npm
- Redis
- Qdrant (Docker recommended)
- API keys for Google Gemini & Jina AI

## ⚡ Setup

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your API keys

# Start backend server (development)
npm run dev
```

Optional: Ingest news articles

```bash
npm run ingest
```

## 🗂 Project Structure

```
backend/
├── src/
│   ├── config/      # DB connections
│   ├── controllers/ # API handlers
│   ├── routes/      # API routes
│   ├── services/    # Business logic
│   └── scripts/     # Utilities
├── logs/
├── package.json
└── .gitignore
```

## 📡 API Endpoints

* `POST /api/chat/message` – Send message
* `POST /api/chat/message/stream` – Streaming message
* `GET /api/chat/history/:sessionId` – Retrieve chat history
* `DELETE /api/chat/history/:sessionId` – Clear chat
* `POST /api/chat/session` – Create new session

## 📄 License

MIT License
