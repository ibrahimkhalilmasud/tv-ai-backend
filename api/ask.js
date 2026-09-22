// POST /api/ask
// The heart of the app. Body: { question: string, model: "claude" | "gemini" }
// 1. Verify the user (Google token in Authorization header).
// 2. Retrieve the most relevant chunks from their indexed Drive docs.
// 3. Ask Claude or Gemini to answer using only that context.
// Returns: { ok, answer, model, sources: [{ fileName, score }] }

import { withCors, getBearerToken } from "../lib/config.js";
import { verifyGoogleToken } from "../lib/google.js";
import { retrieveContext } from "../lib/rag.js";
import { generateAnswer } from "../lib/ai.js";

export default async function handler(req, res) {
  withCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const token = getBearerToken(req);
    const profile = await verifyGoogleToken(token);

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const question = (body.question || "").trim();
    const model = body.model === "gemini" ? "gemini" : "claude";
    if (!question) return res.status(400).json({ ok: false, error: "Missing question" });

    const chunks = await retrieveContext(question, profile.userId);
    const answer = await generateAnswer(model, question, chunks);

    const seen = new Set();
    const sources = [];
    for (const c of chunks) {
      if (!seen.has(c.fileName)) {
        seen.add(c.fileName);
        sources.push({ fileName: c.fileName, score: c.score });
      }
    }

    return res.status(200).json({ ok: true, answer, model, sources });
  } catch (e) {
    const code = /token/i.test(e.message) ? 401 : 500;
    return res.status(code).json({ ok: false, error: e.message });
  }
}
