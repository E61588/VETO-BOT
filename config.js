require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  apiKey: process.env.BOT_API_KEY || '',
  otpSessionTimeoutMs: parseInt(process.env.OTP_SESSION_TIMEOUT_MS || '120000', 10), // 2 minutes
  webhookTimeoutMs: parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10),
};

if (!config.apiKey) {
  // Fail loudly at boot rather than silently accepting unauthenticated requests.
  // eslint-disable-next-line no-console
  console.warn(
    '[config] WARNING: BOT_API_KEY is not set. All requests to protected routes will be rejected.'
  );
}

module.exports = config;
