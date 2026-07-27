const config = require('./config');

/**
 * POST a status update back to Base44 (or whatever webhook URL was supplied
 * with the job). Failures are logged but never thrown, so a webhook outage
 * never crashes the automation flow.
 */
async function sendWebhook(webhookUrl, payload) {
  if (!webhookUrl) {
    console.warn('[webhook] No webhook_url provided, skipping notification:', payload);
    return { ok: false, skipped: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.webhookTimeoutMs);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        ...payload,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(
        `[webhook] Non-OK response (${response.status}) from ${webhookUrl}: ${text}`
      );
      return { ok: false, status: response.status };
    }

    return { ok: true };
  } catch (err) {
    console.error(`[webhook] Failed to notify ${webhookUrl}:`, err.message);
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { sendWebhook };
