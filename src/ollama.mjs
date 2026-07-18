// Ollama embedding client (new /api/embed with legacy /api/embeddings fallback) + cosine.
export async function embed(texts, { ollamaUrl, model }) {
  const arr = Array.isArray(texts) ? texts : [texts];
  if (arr.length === 0) return [];

  // Modern batch API
  try {
    const r = await fetch(`${ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: arr }),
    });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.embeddings) && j.embeddings.length === arr.length) return j.embeddings;
    } else if (r.status === 404) {
      // fall through to legacy endpoint
    } else {
      throw new Error(`ollama /api/embed ${r.status}: ${await safeText(r)}`);
    }
  } catch (e) {
    if (!isConnRefused(e)) {
      // real API error or legacy-needed: try legacy below only on 404-ish paths
      if (!(e instanceof TypeError)) throw e;
    } else {
      throw new Error(`Cannot reach Ollama at ${ollamaUrl} — is it running? (${e.cause?.code ?? e.message})`);
    }
  }

  // Legacy single-prompt API
  const out = [];
  for (const t of arr) {
    const r = await fetch(`${ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: t }),
    });
    if (!r.ok) throw new Error(`ollama /api/embeddings ${r.status}: ${await safeText(r)}`);
    out.push((await r.json()).embedding);
  }
  return out;
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

function isConnRefused(e) {
  const code = e?.cause?.code ?? e?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "UND_ERR_CONNECT_TIMEOUT";
}

async function safeText(r) {
  try { return (await r.text()).slice(0, 300); } catch { return ""; }
}
