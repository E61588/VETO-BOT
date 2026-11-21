const config = require('./config');

// Reports a job status to Base44's automationWebhook function.
// The function authenticates the call with the shared x-api-key.
// Failures are logged, never thrown: a webhook outage must not crash a job.
async function report(payload) {
  if (!config.webhookUrl) {
    console.warn('[webhook] WEBHOOK_URL not set, skipping', payload.job_id, payload.status);
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.webhookTimeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[webhook] ${res.status} for job ${payload.job_id}: ${text.slice(0, 200)}`);
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    console.error(`[webhook] failed for job ${payload.job_id}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { report };
