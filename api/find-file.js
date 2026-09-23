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
import { verifyGoogleToken, searchWithinSection, searchDriveFiles } from "../lib/google.js";
import { GoogleGenerativeAI } from "@google/generative-ai";

// The two priority sections in Drive (override via env if folder names change).
const PERSONAL_FOLDER = process.env.PERSONAL_FOLDER || "MR MIKE PERSONAL";
const OFFICE_FOLDER = process.env.OFFICE_FOLDER || "Office stock";

// Ask the model to (a) route personal vs office and (b) give a search keyword.
async function routeRequest(request) {
  try {
    const genai = new GoogleGenerativeAI(config.geminiApiKey());
    const model = genai.getGenerativeModel({ model: config.geminiModel });
    const prompt =
      "You route a request to open a file in Google Drive. There are two sections:\n" +
      "- personal: passports, visas, IDs, personal documents, tickets, family, personal.\n" +
      "- office: stock, inventory, office, business, products, sales, reports.\n" +
      'Output STRICT JSON only: {"section":"personal"|"office","keyword":"<short search words>"}.\n' +
      'Examples: "show me my passport" -> {"section":"personal","keyword":"passport"}; ' +
      '"open the stock overview" -> {"section":"office","keyword":"stock overview"}.\n\n' +
      `Request: ${request}\nJSON:`;
    const r = await model.generateContent(prompt);
    const txt = r.response.text().trim().replace(/```json|```/g, "");
    const parsed = JSON.parse(txt);
    return {
      section: parsed.section === "office" ? "office" : "personal",
      keyword: (parsed.keyword || "").trim(),
    };
  } catch {
    // Fallback: keyword heuristics.
    const t = String(request || "").toLowerCase();
    const office = /\b(stock|inventory|office|business|product|sales|report)\b/.test(t);
    const keyword = t.replace(/\b(show|open|display|pull up|find|get|me|my|the|please|can you)\b/gi, "").trim();
    return { section: office ? "office" : "personal", keyword };
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

    // Route to a section (personal/office) and get a search keyword.
    const { section, keyword } = await routeRequest(request);
    const sectionFolder = section === "office" ? OFFICE_FOLDER : PERSONAL_FOLDER;

    // Search ONLY inside that section's folder tree.
    let result = await searchWithinSection(token, sectionFolder, keyword, { pageSize: 8 });
    let files = result.files;

    // If the section folder wasn't found at all, fall back to a global search
    // so the user still gets something (and we can tell them the folder is missing).
    let note = "";
    if (!result.scoped) {
      note = ` (section folder "${sectionFolder}" not found; searched all of Drive)`;
      files = await searchDriveFiles(token, keyword || request, { pageSize: 8 });
    }

    if (!files.length) {
      return res.status(200).json({
        ok: true, file: null, section, searchTerm: keyword,
        message: `No file found for "${keyword}" in ${section}${note}.`,
      });
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
      section,
      searchTerm: keyword,
      user: profile.name || profile.email,
      file: toResult(files[0]),
      alternatives: files.slice(1, 5).map(toResult),
    });
  } catch (e) {
    const code = /token/i.test(e.message) ? 401 : 500;
    return res.status(code).json({ ok: false, error: e.message });
  }
}
