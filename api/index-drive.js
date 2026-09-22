// POST /api/index-drive
// Reads the signed-in user's Google Drive documents, chunks + embeds them, and
// stores them in the vector DB under that user's namespace. The app calls this
// once after sign-in (and whenever the user taps "Re-sync my documents").

import { withCors, getBearerToken } from "../lib/config.js";
import { verifyGoogleToken } from "../lib/google.js";
import { indexUserDrive } from "../lib/rag.js";

export default async function handler(req, res) {
  withCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const token = getBearerToken(req);
    const profile = await verifyGoogleToken(token);
    const summary = await indexUserDrive(token, profile.userId);
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
