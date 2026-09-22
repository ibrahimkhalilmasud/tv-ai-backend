// GET /api/health — quick check that the backend is deployed and reachable.
import { withCors } from "../lib/config.js";

export default function handler(req, res) {
  withCors(res);
  res.status(200).json({ ok: true, service: "tv-ai-backend", time: new Date().toISOString() });
}
