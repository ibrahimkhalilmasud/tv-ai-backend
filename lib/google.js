// Google auth + Drive helpers.
//
// Auth flow used by the app:
//  1. TV app opens a Google Sign-In popup (expo-auth-session) and gets an
//     access token + basic profile directly from Google on the device.
//  2. The app sends that access token to this backend in the
//     `Authorization: Bearer <token>` header on every request.
//  3. This module verifies the token with Google and uses it to read Drive
//     *as that user*. The backend never stores the user's password and only
//     ever sees a short-lived access token.

import { google } from "googleapis";

const TOKENINFO_URL = "https://www.googleapis.com/oauth2/v3/tokeninfo";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

// Verify a Google access token and return the user's profile.
// Throws if the token is invalid or expired.
export async function verifyGoogleToken(accessToken) {
  if (!accessToken) throw new Error("No access token provided");

  const infoRes = await fetch(`${TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`);
  if (!infoRes.ok) {
    throw new Error("Invalid or expired Google token");
  }
  const info = await infoRes.json();

  const profRes = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const profile = profRes.ok ? await profRes.json() : {};

  return {
    userId: info.sub || profile.sub || "unknown",
    email: profile.email || info.email || "",
    name: profile.name || "",
    picture: profile.picture || "",
    scopes: (info.scope || "").split(" ").filter(Boolean),
    expiresIn: Number(info.expires_in || 0),
  };
}

// Build a Drive API client authenticated as the signed-in user.
export function driveClientFor(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.drive({ version: "v3", auth });
}

// List the user's documents we can index (Docs, PDFs, text, sheets).
export async function listDriveDocuments(accessToken, { pageSize = 50 } = {}) {
  const drive = driveClientFor(accessToken);
  const q = [
    "trashed = false",
    " and (mimeType = 'application/vnd.google-apps.document'",
    " or mimeType = 'application/pdf'",
    " or mimeType = 'text/plain'",
    " or mimeType = 'application/vnd.google-apps.spreadsheet')",
  ].join("");

  const res = await drive.files.list({
    q,
    pageSize,
    fields: "files(id, name, mimeType, modifiedTime)",
    orderBy: "modifiedTime desc",
  });
  return res.data.files || [];
}

// Download a single Drive file as plain text.
export async function fetchDriveFileText(accessToken, file) {
  const drive = driveClientFor(accessToken);

  if (file.mimeType === "application/vnd.google-apps.document") {
    const r = await drive.files.export(
      { fileId: file.id, mimeType: "text/plain" },
      { responseType: "text" }
    );
    return r.data;
  }
  if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
    const r = await drive.files.export(
      { fileId: file.id, mimeType: "text/csv" },
      { responseType: "text" }
    );
    return r.data;
  }
  if (file.mimeType === "text/plain") {
    const r = await drive.files.get(
      { fileId: file.id, alt: "media" },
      { responseType: "text" }
    );
    return r.data;
  }
  if (file.mimeType === "application/pdf") {
    const r = await drive.files.get(
      { fileId: file.id, alt: "media" },
      { responseType: "arraybuffer" }
    );
    return { __pdf: true, bytes: Buffer.from(r.data) };
  }
  return "";
}
