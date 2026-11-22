// Client for Base44's botBridge function, used in Cloud Run job mode.
// The job never receives inbound connections: it calls out to Base44 to fetch
// its task, report status, send screenshots, and poll for the user's input.

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function makeBridge({ url, apiKey, jobId, timeoutMs = 15000, retries = 4 }) {
  if (!url || !apiKey || !jobId) throw new Error('bridge needs url, apiKey and jobId');

  async function call(action, payload = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify({ action, job_id: jobId, ...payload }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return await res.json().catch(() => ({}));
        const text = await res.text().catch(() => '');
        const err = new Error(`bridge ${action} ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status;
        if (!RETRYABLE.has(res.status)) throw err;
        lastErr = err;
      } catch (err) {
        if (err.status && !RETRYABLE.has(err.status)) throw err;
        lastErr = err;
      }
      // Network drop or a retryable status: back off and try again.
      await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)));
    }
    throw lastErr;
  }

  return { call };
}

module.exports = { makeBridge };
