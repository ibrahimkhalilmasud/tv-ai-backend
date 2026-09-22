# tv-ai-backend

Cloud backend for the TV AI assistant, built with Vercel serverless functions.

It provides:
- Google token verification
- Google Drive indexing for user documents
- RAG retrieval from Upstash Vector
- Answer generation with Claude or Gemini

## Tech stack

- Node.js (ES modules)
- Vercel Functions
- Google APIs (OAuth + Drive)
- Upstash Vector
- Anthropic SDK
- Google Generative AI SDK

## Project structure

```
api/
  auth.js         # Verify Google token and return user profile
  index-drive.js  # Index signed-in user's Drive files
  ask.js          # Retrieve context and generate grounded answer
  health.js       # Health check endpoint
lib/
  config.js       # Env + shared helpers (CORS, bearer token parsing)
  google.js       # Google token verification + Drive file access
  rag.js          # Chunking, embeddings, indexing, retrieval
  ai.js           # Claude/Gemini answer generation
```

## Prerequisites

- Node.js 18+ (or current LTS)
- A Vercel project
- Google OAuth client credentials
- Upstash Vector database
- Anthropic API key
- Gemini API key

## Environment variables

Copy `.env.example` values into Vercel project environment variables.

Required:
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `UPSTASH_VECTOR_REST_URL`
- `UPSTASH_VECTOR_REST_TOKEN`

Optional:
- `CLAUDE_MODEL` (default: `claude-sonnet-5`)
- `GEMINI_MODEL` (default: `gemini-2.0-flash`)
- `EMBEDDING_MODEL` (default: `text-embedding-004`)
- `RAG_TOP_K` (default: `6`)
- `APP_SHARED_SECRET` (currently optional and not enforced in handlers)

## Install and run locally

```bash
npm install
npm run dev
```

This runs `vercel dev` and serves API routes locally.

## API endpoints

### `GET /api/health`
Returns service status and server time.

### `POST /api/auth`
Validates Google access token from:
- `Authorization: ****** header, or
- `accessToken` in JSON body

Returns authenticated user profile.

### `POST /api/index-drive`
Requires `Authorization: ******

Indexes the signed-in user’s supported Google Drive files (Docs, Sheets, txt; PDFs are currently skipped) into Upstash Vector namespace scoped to that user.

### `POST /api/ask`
Requires `Authorization: ******

Body:
```json
{
  "question": "string",
  "model": "claude | gemini"
}
```

Retrieves relevant document chunks and returns a grounded answer plus source file names.

## Deploy

```bash
npm run deploy
```

Make sure all required environment variables are configured in Vercel before deploying.

## Notes

- CORS is currently open (`*`) for ease of integration with TV/web clients.
- Document vectors are isolated per user using namespace and metadata user IDs.
- Keep credentials only in environment variables. Do not commit real secrets.
