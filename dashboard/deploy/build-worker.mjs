// Builds a single Cloudflare Worker that serves the static dashboard with strict security headers.
// Usage: node deploy/build-worker.mjs > /tmp/leash-worker.js   (no secrets involved)
import { readFileSync } from "node:fs";
const dir = new URL("..", import.meta.url);
const types = { "index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "leash.js": "text/javascript; charset=utf-8", "style.css": "text/css; charset=utf-8" };
const files = Object.fromEntries(Object.keys(types).map((f) => [f, readFileSync(new URL(f, dir), "utf8")]));
const vercel = JSON.parse(readFileSync(new URL("vercel.json", dir), "utf8"));
const headers = Object.fromEntries(vercel.headers[0].headers.map((h) => [h.key, h.value]));
process.stdout.write(`const FILES = ${JSON.stringify(files)};
const TYPES = ${JSON.stringify(types)};
const SEC = ${JSON.stringify(headers)};
export default { async fetch(req) {
  const url = new URL(req.url);
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: SEC });
  let p = url.pathname.replace(/^\\/+/, "") || "index.html";
  if (!Object.hasOwn(FILES, p)) return new Response("not found", { status: 404, headers: { ...SEC, "content-type": "text/plain" } });
  return new Response(req.method === "HEAD" ? null : FILES[p], { headers: { ...SEC, "content-type": TYPES[p], "cache-control": "public, max-age=300" } });
} };
`);
