// listModels.js
const fetch = require("node-fetch");

async function listModels() {
  const apiKey = process.env.GEMINI_API_KEY;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
  );

  if (!response.ok) {
    const text = await response.text();
    console.error("Failed to list models:", response.status, text);
    return;
  }

  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

listModels();
