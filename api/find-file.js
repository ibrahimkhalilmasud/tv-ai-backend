// POST /api/find-file
// Body: { request: string }  e.g. "show me my passport" / "open stock overview"
// 1. Verify the user (Google token).
// 2. Use the AI to pull the key search term out of the request.
// 3. Search the user's Drive for the best matching file.
// Returns: { ok, file: { id, name, mimeType, viewUrl }, alternatives: [...] }
//
// viewUrl points at our own /api/file proxy so the app can display the file
// without embedding Drive credentials in the viewer.

import { withCors, getBearerToken, config } from "../lib/config.js";
import { verifyGoogleToken, searchDriveFiles } from "../lib/google.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Ask the model for a short search keyword from a natural request.
async function extractSearchTerm(request) {
  try {
    const genai = new GoogleGenerativeAI(config.geminiApiKey());
    const model = genai.getGenerativeModel({ model: config.geminiModel });
    const prompt =
      "The user wants to open a file from their Google Drive on their TV. " +
      "From their request, output ONLY the best short search keyword(s) to find that file " +
      "(no punctuation, no explanation). Examples: 'show me my passport' -> passport; " +
      "'open the stock overview' -> stock overview; 'pull up mike's visa' -> visa.\n\n" +
      `Request: ${request}\nKeyword:`;
    const r = await model.generateContent(prompt);
    return r.response.text().trim().replace(/^["']|["']$/g, "");
  } catch {
    // Fallback: strip common command words.
    return String(request || "")
      .replace(/\b(show|open|display|pull up|find|get|me|my|the|please|can you)\b/gi, "")
      .trim();
  }
}

export default async function handler(req, res) {
  withCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const token = getBearerToken(req);
    const profile = await verifyGoogleToken(token);

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const request = (body.request || "").trim();
    if (!request) return res.status(400).json({ ok: false, error: "Missing request" });

    const term = await extractSearchTerm(request);
    const files = await searchDriveFiles(token, term || request, { pageSize: 8 });

    if (!files.length) {
      return res.status(200).json({ ok: true, file: null, searchTerm: term, message: `No file found for "${term}".` });
    }

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers.host;
    const toResult = (f) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      thumbnail: f.thumbnailLink || null,
      // App opens this to view the file (proxied through our backend).
      viewUrl: `${proto}://${host}/api/file?id=${encodeURIComponent(f.id)}&token=${encodeURIComponent(token)}`,
      webViewLink: f.webViewLink || null,
    });

    return res.status(200).json({
      ok: true,
      searchTerm: term,
      user: profile.name || profile.email,
      file: toResult(files[0]),
      alternatives: files.slice(1, 5).map(toResult),
    });
  } catch (e) {
    const code = /token/i.test(e.message) ? 401 : 500;
    return res.status(code).json({ ok: false, error: e.message });
  }
}
