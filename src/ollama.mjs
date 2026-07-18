// Ollama embedding client (new /api/embed with legacy /api/embeddings fallback) + cosine.
export async function embed(texts, { ollamaUrl, model }) {
  const arr = Array.isArray(texts) ? texts : [texts];
  if (arr.length === 0) return [];

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
    if (Array.isArray(j.embeddings) && j.embeddings.length === arr.length) return j.embeddings;
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
  return out;
}

function connError(e, ollamaUrl) {
  const code = e?.cause?.code ?? e?.code ?? e?.message;
  return new Error(`Cannot reach Ollama at ${ollamaUrl} — is it running? (${code})`);
}

export async function ollamaUp(ollamaUrl) {
  try {
    const r = await fetch(`${ollamaUrl}/api/version`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false;
  }
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
