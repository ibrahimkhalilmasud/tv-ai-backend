// Central config. All secrets come from environment variables set in Vercel.
// Never hardcode keys here — the file is committed to git.

function required(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing environment variable ${name}. Set it in Vercel > Project > Settings > Environment Variables.`
    );
  }
  return v;
}

export const config = {
  // --- AI providers ---
  anthropicApiKey: () => required("ANTHROPIC_API_KEY"),
  geminiApiKey: () => required("GEMINI_API_KEY"),

  // Model ids (override via env if you like)
  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-5",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.6-flash",
  embeddingModel: process.env.EMBEDDING_MODEL || "gemini-embedding-001",

  // --- Google OAuth (for Sign-In + Drive access) ---
  googleClientId: () => required("GOOGLE_CLIENT_ID"),
  googleClientSecret: () => required("GOOGLE_CLIENT_SECRET"),

  // --- Vector DB (Upstash Vector, free tier) for RAG ---
  upstashVectorUrl: () => required("UPSTASH_VECTOR_REST_URL"),
  upstashVectorToken: () => required("UPSTASH_VECTOR_REST_TOKEN"),

  // How many document chunks to retrieve per question
  ragTopK: Number(process.env.RAG_TOP_K || 6),

  // Simple shared secret so only your app can call the backend
  appSharedSecret: process.env.APP_SHARED_SECRET || "",
};

// CORS headers so the TV app (and web) can call the API.
export function withCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return res;
}

// Read the Google access token the app sends in the Authorization header.
export function getBearerToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}
