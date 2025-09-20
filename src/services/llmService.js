// src/services/llmService.js
const fetch = require("node-fetch");
const logger = require("../utils/logger");

class LLMService {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
    this.modelName = "gemini-2.0-flash";
    this.baseUrl = "https://generativelanguage.googleapis.com/v1beta";

    if (!this.apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
  }

  async generateResponse(prompt, context = []) {
    try {
      // Prepare context text from retrieved articles
      const contextText =
        context.length > 0
          ? `Based on these recent news articles:\n\n${context
              .map(
                (item) =>
                  `Title: ${item.metadata.title}\nContent: ${item.metadata.content}`
              )
              .join("\n\n")}\n\nUser Question: ${prompt}`
          : prompt;

      const response = await fetch(
        `${this.baseUrl}/models/${this.modelName}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-goog-api-key": this.apiKey, // Correct header
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: contextText,
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.7,
              topK: 40,
              topP: 0.95,
              maxOutputTokens: 1024,
            },
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      if (
        !data.candidates ||
        !data.candidates[0] ||
        !data.candidates[0].content
      ) {
        throw new Error("Invalid response format from Gemini API");
      }

      return data.candidates[0].content.parts[0].text;
    } catch (error) {
      logger.error("Error generating LLM response:", error);
      throw error;
    }
  }

  async generateStreamResponse(prompt, context = []) {
    try {
      // For now, return regular response - streaming can be implemented later
      return await this.generateResponse(prompt, context);
    } catch (error) {
      logger.error("Error generating streaming LLM response:", error);
      throw error;
    }
  }
}

module.exports = LLMService;
