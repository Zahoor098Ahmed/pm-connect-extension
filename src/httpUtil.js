const fetch = require("node-fetch");

/**
 * Fetch with exponential backoff on network errors and 429/5xx responses.
 * @param {string} url
 * @param {import('node-fetch').RequestInit} init
 * @param {{retries?: number, baseDelayMs?: number}} [opts]
 */
async function fetchWithRetry(url, init, opts = {}) {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 300;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        if (attempt === retries) return res;
        await delay(baseDelayMs * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt === retries) throw err;
      await delay(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { fetchWithRetry };
