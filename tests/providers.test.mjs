// OpenAI-compatible provider adapter + hybrid search ranking.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { embed } from "../src/ollama.mjs";
import { lexicalScores, tokenize, searchNotes } from "../src/search.mjs";
import { mockEmbed, startMockOllama } from "./helpers/mock-ollama.mjs";

let openaiMock, ollamaMock;

before(async () => {
  ollamaMock = await startMockOllama();
  // Minimal OpenAI-compatible /v1/embeddings — returns data out of order on
  // purpose to verify the client re-sorts by index.
  openaiMock = await new Promise((res) => {
    const srv = createServer((req, resp) => {
      let body = "";
      req.on("data", c => (body += c));
      req.on("end", () => {
        if (req.url === "/v1/embeddings") {
          const { input } = JSON.parse(body);
          const data = input.map((t, i) => ({ index: i, embedding: mockEmbed(t) })).reverse();
          resp.writeHead(200, { "Content-Type": "application/json" });
          resp.end(JSON.stringify({ data }));
        } else if (req.url === "/v1/models") {
          resp.writeHead(200, { "Content-Type": "application/json" });
          resp.end(JSON.stringify({ data: [] }));
        } else resp.writeHead(404).end();
      });
    });
    srv.listen(0, "127.0.0.1", () => res({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
});

after(async () => {
  await ollamaMock.close();
  openaiMock.srv.close();
});

test("openai provider: batch embed, order restored", async () => {
  const cfg = { embedApi: "openai", embedUrl: openaiMock.url, embedKey: null, model: "m" };
  const [a, b] = await embed(["alpha bravo", "charlie delta"], cfg);
  assert.deepEqual(a, mockEmbed("alpha bravo"));
  assert.deepEqual(b, mockEmbed("charlie delta"));
});

test("hybrid: lexical component rescues exact rare terms", async () => {
  const records = [
    { title: "notes-a", path: "a.md", chunk: 0, text: "general thoughts about cooking pasta and sauces", vector: mockEmbed("general thoughts about cooking pasta and sauces") },
    { title: "notes-b", path: "b.md", chunk: 0, text: "the API key for XYZZY-9000 service lives in the env file", vector: mockEmbed("the API key for XYZZY-9000 service lives in the env file") },
  ];
  const lex = lexicalScores(records, tokenize("XYZZY-9000"));
  assert.ok(lex[1] > lex[0], "exact-term note must win lexically");

  const db = { records, files: { "a.md": 1, "b.md": 1 } };
  const cfg = { embedApi: "ollama", ollamaUrl: ollamaMock.url, model: "mock-model" };
  const results = await searchNotes(db, cfg, "XYZZY-9000", 2);
  assert.equal(results[0].path, "b.md");
});
