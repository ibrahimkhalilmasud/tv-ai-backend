// AI answer generation with Claude or Gemini, grounded in retrieved Drive context.

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "./config.js";

function buildPrompt(question, contextChunks) {
  const context = contextChunks
    .map((c, i) => `[${i + 1}] From "${c.fileName}":\n${c.text}`)
    .join("\n\n");

  const system =
    "You are a helpful voice assistant answering out loud on a television. " +
    "Answer the user's question using ONLY the context from their documents below. " +
    "If the answer is not in the context, say you couldn't find it in their documents. " +
    "Keep answers concise and natural to hear spoken — 2 to 4 short sentences, no markdown, no bullet lists.";

  const user =
    (context
      ? `Context from the user's Google Drive:\n\n${context}\n\n`
      : "No document context was found.\n\n") +
    `Question: ${question}`;

  return { system, user };
}

async function answerWithClaude(question, contextChunks) {
  const client = new Anthropic({ apiKey: config.anthropicApiKey() });
  const { system, user } = buildPrompt(question, contextChunks);
  const msg = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 500,
    system,
    messages: [{ role: "user", content: user }],
  });
  return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
}

async function answerWithGemini(question, contextChunks) {
  const genai = new GoogleGenerativeAI(config.geminiApiKey());
  const model = genai.getGenerativeModel({ model: config.geminiModel });
  const { system, user } = buildPrompt(question, contextChunks);
  const r = await model.generateContent(`${system}\n\n${user}`);
  return r.response.text().trim();
}

// model: "claude" | "gemini"
export async function generateAnswer(model, question, contextChunks, attempt = 0) {
  try {
    if (model === "gemini") return await answerWithGemini(question, contextChunks);
    return await answerWithClaude(question, contextChunks);
  } catch (e) {
    // Retry transient rate-limit (429) or overload (503) errors with backoff.
    const transient = /429|503|quota|rate|overload|unavailable|high demand/i.test(e.message || "");
    if (transient && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 2500 * (attempt + 1)));
      return generateAnswer(model, question, contextChunks, attempt + 1);
    }
    throw e;
  }
}
