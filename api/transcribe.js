// POST /api/transcribe
// Body: { audioBase64: string, mimeType: string }  (e.g. audio/m4a from expo-av)
// Uses Gemini's audio understanding to transcribe the clip to text.
// Returns: { ok, text }
//
// This lets the TV app do voice input without a separate speech-to-text service:
// record a short clip -> send here -> get the spoken words back as text -> then
// route it to /api/ask (answer) or /api/find-file (open a file).

import { withCors, getBearerToken, config } from "../lib/config.js";
import { verifyGoogleToken } from "../lib/google.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

export default async function handler(req, res) {
  withCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const token = getBearerToken(req);
    await verifyGoogleToken(token);

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const audioBase64 = body.audioBase64;
    const mimeType = body.mimeType || "audio/mp4";
    if (!audioBase64) return res.status(400).json({ ok: false, error: "Missing audioBase64" });

    const genai = new GoogleGenerativeAI(config.geminiApiKey());
    const model = genai.getGenerativeModel({ model: config.geminiModel });

    const r = await model.generateContent([
      { text: "Transcribe this audio to plain text. Output ONLY the spoken words, nothing else." },
      { inlineData: { mimeType, data: audioBase64 } },
    ]);

    const text = r.response.text().trim();
    return res.status(200).json({ ok: true, text });
  } catch (e) {
    const code = /token/i.test(e.message) ? 401 : 500;
    return res.status(code).json({ ok: false, error: e.message });
  }
}
