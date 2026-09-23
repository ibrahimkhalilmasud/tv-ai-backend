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

// Search the user's Drive for files matching a query (name OR full-text).
// Returns candidate files, most relevant first. Used to "open" a named file.
export async function searchDriveFiles(accessToken, query, { pageSize = 10 } = {}) {
  const drive = driveClientFor(accessToken);
  const safe = String(query || "").replace(/'/g, "\\'").trim();
  if (!safe) return [];

  const fields = "files(id, name, mimeType, modifiedTime, webViewLink, thumbnailLink, iconLink)";
  const fileMimes =
    "mimeType != 'application/vnd.google-apps.folder'";

  // 1) FILE NAME matches first — best for files literally named "passport".
  const byName = await drive.files.list({
    q: `trashed = false and ${fileMimes} and name contains '${safe}'`,
    pageSize, fields, orderBy: "modifiedTime desc",
  });
  const nameHits = byName.data.files || [];
  if (nameHits.length) return nameHits;

  // 2) FOLDER match — e.g. "01. Passport Copies". If a folder name matches,
  //    return the files inside it (passport scans often sit in such folders).
  const folderRes = await drive.files.list({
    q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and name contains '${safe}'`,
    pageSize: 3,
    fields: "files(id, name)",
    orderBy: "modifiedTime desc",
  });
  const folders = folderRes.data.files || [];
  for (const folder of folders) {
    const inside = await drive.files.list({
      q: `trashed = false and ${fileMimes} and '${folder.id}' in parents`,
      pageSize, fields, orderBy: "modifiedTime desc",
    });
    if ((inside.data.files || []).length) return inside.data.files;
  }

  // 3) Fall back to full-text (content) search only if nothing else matched.
  const byContent = await drive.files.list({
    q: `trashed = false and ${fileMimes} and fullText contains '${safe}'`,
    pageSize, fields, orderBy: "modifiedTime desc",
  });
  return byContent.data.files || [];
}

// Find a folder by (partial) name and return its id.
export async function findFolderIdByName(accessToken, folderName) {
  const drive = driveClientFor(accessToken);
  const safe = String(folderName || "").replace(/'/g, "\\'").trim();
  const res = await drive.files.list({
    q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and name contains '${safe}'`,
    pageSize: 5,
    fields: "files(id, name)",
    orderBy: "modifiedTime desc",
  });
  const folders = res.data.files || [];
  return folders.length ? folders[0].id : null;
}

// Collect a folder's id plus all descendant folder ids (recursively, capped).
async function collectFolderTree(drive, rootId, maxFolders = 60) {
  const all = [rootId];
  const queue = [rootId];
  while (queue.length && all.length < maxFolders) {
    const parent = queue.shift();
    const res = await drive.files.list({
      q: `trashed = false and mimeType = 'application/vnd.google-apps.folder' and '${parent}' in parents`,
      pageSize: 100,
      fields: "files(id, name)",
    });
    for (const f of res.data.files || []) {
      if (!all.includes(f.id)) { all.push(f.id); queue.push(f.id); }
    }
  }
  return all;
}

// Search for a query but ONLY within a named section folder (and its subfolders).
// This scopes results to e.g. "MR MIKE PERSONAL" or "Office stock".
export async function searchWithinSection(accessToken, sectionFolderName, query, { pageSize = 10 } = {}) {
  const drive = driveClientFor(accessToken);
  const rootId = await findFolderIdByName(accessToken, sectionFolderName);
  if (!rootId) return { scoped: false, files: [] };

  const folderIds = await collectFolderTree(drive, rootId);
  const parentsClause = "(" + folderIds.map((id) => `'${id}' in parents`).join(" or ") + ")";
  const fields = "files(id, name, mimeType, modifiedTime, webViewLink, thumbnailLink, iconLink)";
  const fileMimes = "mimeType != 'application/vnd.google-apps.folder'";
  const safe = String(query || "").replace(/'/g, "\\'").trim();

  // Name match within the section first.
  if (safe) {
    const byName = await drive.files.list({
      q: `trashed = false and ${fileMimes} and ${parentsClause} and name contains '${safe}'`,
      pageSize, fields, orderBy: "modifiedTime desc",
    });
    if ((byName.data.files || []).length) return { scoped: true, files: byName.data.files };

    // Then content match within the section.
    const byContent = await drive.files.list({
      q: `trashed = false and ${fileMimes} and ${parentsClause} and fullText contains '${safe}'`,
      pageSize, fields, orderBy: "modifiedTime desc",
    });
    if ((byContent.data.files || []).length) return { scoped: true, files: byContent.data.files };
  }

  // No query match — just list recent files in the section so the user sees something.
  const anyFiles = await drive.files.list({
    q: `trashed = false and ${fileMimes} and ${parentsClause}`,
    pageSize, fields, orderBy: "modifiedTime desc",
  });
  return { scoped: true, files: anyFiles.data.files || [] };
}

// Get file metadata (including a viewable webViewLink) by id.
export async function getDriveFileMeta(accessToken, fileId) {
  const drive = driveClientFor(accessToken);
  const r = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, webViewLink, thumbnailLink, iconLink, size",
  });
  return r.data;
}

// Stream a file's raw bytes (for the app's in-app viewer proxy).
// Google-native docs are exported to PDF so they can be viewed.
export async function downloadDriveFileBytes(accessToken, fileId) {
  const drive = driveClientFor(accessToken);
  const meta = await drive.files.get({ fileId, fields: "id, name, mimeType" });
  const mime = meta.data.mimeType;

  if (mime === "application/vnd.google-apps.document" ||
      mime === "application/vnd.google-apps.spreadsheet" ||
      mime === "application/vnd.google-apps.presentation") {
    const r = await drive.files.export(
      { fileId, mimeType: "application/pdf" },
      { responseType: "arraybuffer" }
    );
    return { name: meta.data.name, contentType: "application/pdf", bytes: Buffer.from(r.data) };
  }

  const r = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return { name: meta.data.name, contentType: mime, bytes: Buffer.from(r.data) };
}
