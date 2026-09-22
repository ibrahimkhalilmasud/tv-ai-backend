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

async function embed(text) {
  const model = embedder();
  const r = await model.embedContent(text);
  return r.embedding.values;
}

// Index (or re-index) all of a user's Drive documents.
export async function indexUserDrive(accessToken, userId) {
  const index = vectorIndex();
  const files = await listDriveDocuments(accessToken, { pageSize: 40 });

  let indexedFiles = 0;
  let indexedChunks = 0;
  const skipped = [];

  for (const file of files) {
    let text;
    try {
      const raw = await fetchDriveFileText(accessToken, file);
      if (raw && raw.__pdf) {
        // PDF text extraction is out of scope for v1 to keep the serverless
        // bundle small. Docs/Sheets/txt cover most cases; add pdf-parse later.
        skipped.push(`${file.name} (PDF — add a parser to include)`);
        continue;
      }
      text = raw;
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

  return { indexedFiles, indexedChunks, totalFilesSeen: files.length, skipped };
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
