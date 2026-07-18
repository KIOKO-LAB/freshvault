// Embedding client + cosine.
// Providers: "ollama" (default; /api/embed with legacy /api/embeddings fallback)
// and "openai" (any OpenAI-compatible /v1/embeddings — LM Studio, LiteLLM, OpenAI).
export async function embed(texts, cfg) {
  const arr = Array.isArray(texts) ? texts : [texts];
  if (arr.length === 0) return [];
  if (cfg.embedApi === "openai") return embedOpenAI(arr, cfg);
  return embedOllama(arr, cfg);
}

async function embedOpenAI(arr, { embedUrl, embedKey, model }) {
  const url = `${embedUrl.replace(/\/+$/, "")}/v1/embeddings`;
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(embedKey ? { Authorization: `Bearer ${embedKey}` } : {}),
      },
      body: JSON.stringify({ model, input: arr }),
    });
  } catch (e) {
    throw connError(e, url);
  }
  if (!r.ok) throw new Error(`embeddings endpoint ${r.status}: ${await safeText(r)}`);
  const j = await r.json();
  if (!Array.isArray(j.data) || j.data.length !== arr.length) {
    throw new Error("embeddings endpoint returned a malformed response");
  }
  // OpenAI-compatible servers may return out of order — sort by index.
  const vecs = j.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
  assertEmbeddings(vecs, arr.length, "embeddings endpoint");
  return vecs;
}

// A 200 response with garbage inside must never poison the index: every vector
// must be a non-empty numeric array of consistent dimension, all values finite.
function assertEmbeddings(vecs, n, source) {
  if (!Array.isArray(vecs) || vecs.length !== n) throw new Error(`${source} returned a malformed response`);
  const dim = Array.isArray(vecs[0]) ? vecs[0].length : 0;
  if (dim === 0) throw new Error(`${source} returned empty embeddings`);
  for (const v of vecs) {
    if (!Array.isArray(v) || v.length !== dim) throw new Error(`${source} returned inconsistent embedding dimensions`);
    for (const x of v) if (!Number.isFinite(x)) throw new Error(`${source} returned non-finite embedding values`);
  }
}

async function embedOllama(arr, { ollamaUrl, model }) {

  // Modern batch API
  let resp;
  try {
    resp = await fetch(`${ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: arr }),
    });
  } catch (e) {
    throw connError(e, ollamaUrl); // fetch throws = network-level failure
  }
  if (resp.ok) {
    const j = await resp.json();
    if (Array.isArray(j.embeddings) && j.embeddings.length === arr.length) {
      assertEmbeddings(j.embeddings, arr.length, "ollama /api/embed");
      return j.embeddings;
    }
    throw new Error("ollama /api/embed returned a malformed response");
  }
  if (resp.status !== 404) {
    throw new Error(`ollama /api/embed ${resp.status}: ${await safeText(resp)}`);
  }

  // 404 → either an old Ollama without /api/embed, or an unknown model.
  // The legacy endpoint disambiguates: old Ollama serves it; unknown model
  // fails there too with Ollama's own "try pulling it" message.
  const out = [];
  for (const t of arr) {
    let r;
    try {
      r = await fetch(`${ollamaUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: t }),
      });
    } catch (e) {
      throw connError(e, ollamaUrl);
    }
    if (!r.ok) throw new Error(`ollama /api/embeddings ${r.status}: ${await safeText(r)}`);
    const j = await r.json();
    if (!Array.isArray(j.embedding)) throw new Error("ollama /api/embeddings returned a malformed response");
    out.push(j.embedding);
  }
  assertEmbeddings(out, arr.length, "ollama /api/embeddings");
  return out;
}

function connError(e, url) {
  const code = e?.cause?.code ?? e?.code ?? e?.message;
  return new Error(`Cannot reach the embedding endpoint at ${url} — is it running? (${code})`);
}

export async function ollamaUp(ollamaUrl) {
  try {
    const r = await fetch(`${ollamaUrl}/api/version`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Provider-aware reachability check for index_status. */
export async function embedEndpointUp(cfg) {
  if (cfg.embedApi === "openai") {
    try {
      const r = await fetch(`${cfg.embedUrl}/v1/models`, {
        headers: cfg.embedKey ? { Authorization: `Bearer ${cfg.embedKey}` } : {},
        signal: AbortSignal.timeout(3000),
      });
      return r.ok;
    } catch {
      return false;
    }
  }
  return ollamaUp(cfg.ollamaUrl);
}

export async function hasModel(ollamaUrl, model) {
  try {
    const r = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const j = await r.json();
    const want = model.includes(":") ? model : `${model}:`;
    return (j.models ?? []).some(m => m.name === model || m.name.startsWith(want));
  } catch {
    return false;
  }
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

async function safeText(r) {
  try { return (await r.text()).slice(0, 300); } catch { return ""; }
}
