// POST /api/auth
// The TV app calls this right after the Google Sign-In popup succeeds, sending
// the Google access token. We verify it and return the user's profile so the
// app can show "Signed in as ...". This confirms the token is valid before the
// user starts asking questions.

import { withCors, getBearerToken } from "../lib/config.js";
import { verifyGoogleToken } from "../lib/google.js";

export default async function handler(req, res) {
  withCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const token = getBearerToken(req) || (req.body && req.body.accessToken);
    const profile = await verifyGoogleToken(token);
    return res.status(200).json({ ok: true, user: profile });
  } catch (e) {
    return res.status(401).json({ ok: false, error: e.message });
  }
}
