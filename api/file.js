// GET /api/file?id=<driveFileId>&token=<googleAccessToken>
// Streams the requested Drive file's bytes so the TV app can display it in an
// in-app viewer (PDF/image/sheet). Google-native docs are exported to PDF.
//
// The token is passed as a query param because the viewer (a WebView opening a
// URL) can't easily send an Authorization header. The token is short-lived and
// only grants read access to the user's own Drive.

import { withCors } from "../lib/config.js";
import { verifyGoogleToken, downloadDriveFileBytes } from "../lib/google.js";

export default async function handler(req, res) {
  withCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const { id, token } = req.query || {};
    if (!id || !token) return res.status(400).json({ ok: false, error: "Missing id or token" });

    await verifyGoogleToken(token); // ensure the token is valid
    const file = await downloadDriveFileBytes(token, id);

    res.setHeader("Content-Type", file.contentType || "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file.name)}"`);
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.status(200).send(file.bytes);
  } catch (e) {
    const code = /token/i.test(e.message) ? 401 : 500;
    return res.status(code).json({ ok: false, error: e.message });
  }
}
