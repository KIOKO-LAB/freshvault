// Mock Ollama server for tests: deterministic bag-of-words embeddings so that
// texts sharing words are actually similar — real ranking assertions, no Ollama.
import { createServer } from "node:http";

const DIM = 128;

export function mockEmbed(text) {
  const v = new Array(DIM).fill(0);
  const words = String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const w of words) {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
    v[h % DIM] += 1;
  }
  return v;
}

/** Starts a mock Ollama. Returns { url, calls, close } — calls counts embed requests. */
export async function startMockOllama() {
  const stats = { embedRequests: 0, embeddedTexts: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      if (req.url === "/api/version") return json(res, { version: "mock" });
      if (req.url === "/api/tags") return json(res, { models: [{ name: "bge-m3:latest" }, { name: "mock-model:latest" }] });
      if (req.url === "/api/embed") {
        const { input } = JSON.parse(body);
        const arr = Array.isArray(input) ? input : [input];
        stats.embedRequests += 1;
        stats.embeddedTexts += arr.length;
        return json(res, { embeddings: arr.map(mockEmbed) });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    close: () => new Promise(r => server.close(r)),
  };
}

function json(res, obj) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
