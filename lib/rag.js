// Retrieval-Augmented Generation over the user's Google Drive.
//
// Pipeline:
//   index:  Drive text -> split into chunks -> embed each -> store in Upstash Vector
//           (each vector tagged with the userId so users only ever see their own docs)
//   ask:    question -> embed -> nearest chunks for this user -> feed to the AI as context

import { GoogleGenerativeAI } from "@google/generative-ai";
import { Index } from "@upstash/vector";
import { config } from "./config.js";
import { listDriveDocuments, fetchDriveFileText } from "./google.js";

function vectorIndex() {
  return new Index({
    url: config.upstashVectorUrl(),
    token: config.upstashVectorToken(),
  });
}

function embedder() {
  const genai = new GoogleGenerativeAI(config.geminiApiKey());
  return genai.getGenerativeModel({ model: config.embeddingModel });
}

// Split text into overlapping chunks (~1000 chars, 150 overlap).
export function chunkText(text, size = 1000, overlap = 150) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const chunks = [];
  let i = 0;
  while (i < clean.length) {
    chunks.push(clean.slice(i, i + size));
    i += size - overlap;
  }
  return chunks;
}

async function embed(text, attempt = 0) {
  const model = embedder();
  try {
    // Request 768 dimensions so vectors match the Upstash index (dim=768).
    const r = await model.embedContent({
      content: { parts: [{ text }] },
      outputDimensionality: 768,
    });
    return r.embedding.values;
  } catch (e) {
    // Free-tier rate limit (429): wait and retry a few times with backoff.
    const isRateLimit = /429|quota|rate/i.test(e.message || "");
    if (isRateLimit && attempt < 5) {
      const waitMs = 2000 * (attempt + 1); // 2s, 4s, 6s, 8s, 10s
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return embed(text, attempt + 1);
    }
    throw e;
  }
}

// Index (or re-index) all of a user's Drive documents.
export async function indexUserDrive(accessToken, userId) {
  const index = vectorIndex();
  const files = await listDriveDocuments(accessToken, { pageSize: 40 });

  let indexedFiles = 0;
  let indexedChunks = 0;
  const skipped = [];

  // Stay within Vercel's function limit: stop cleanly at ~50s and return what
  // we have, so the app gets JSON instead of a timeout/HTML error page.
  const startedAt = Date.now();
  const TIME_BUDGET_MS = 50000;
  let timedOut = false;

  for (const file of files) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { timedOut = true; break; }
    let text;
    try {
      const raw = await fetchDriveFileText(accessToken, file);
      if (raw && raw.__pdf) {
        // Extract text from the PDF bytes using unpdf (serverless-friendly).
        const { extractText, getDocumentProxy } = await import("unpdf");
        const pdf = await getDocumentProxy(new Uint8Array(raw.bytes));
        const out = await extractText(pdf, { mergePages: true });
        text = Array.isArray(out.text) ? out.text.join("\n") : out.text;
      } else {
        text = raw;
      }
    } catch (e) {
      skipped.push(`${file.name} (${e.message})`);
      continue;
    }

    const chunks = chunkText(text);
    if (!chunks.length) continue;

    const vectors = [];
    for (let c = 0; c < chunks.length; c++) {
      const values = await embed(chunks[c]);
      vectors.push({
        id: `${userId}:${file.id}:${c}`,
        vector: values,
        metadata: {
          userId,
          fileId: file.id,
          fileName: file.name,
          mimeType: file.mimeType,
          chunkText: chunks[c],
        },
      });
    }
    await index.upsert(vectors, { namespace: userId });
    indexedFiles++;
    indexedChunks += chunks.length;
  }

  return { indexedFiles, indexedChunks, totalFilesSeen: files.length, skipped, timedOut };
}

// Retrieve the most relevant chunks for a question, scoped to this user.
export async function retrieveContext(question, userId) {
  const index = vectorIndex();
  const qVec = await embed(question);
  const results = await index.query(
    { vector: qVec, topK: config.ragTopK, includeMetadata: true },
    { namespace: userId }
  );
  return (results || []).map((r) => ({
    fileName: r.metadata?.fileName || "document",
    text: r.metadata?.chunkText || "",
    score: r.score,
  }));
}
