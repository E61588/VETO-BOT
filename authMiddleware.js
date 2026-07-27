const config = require('./config');

function requireApiKey(req, res, next) {
  const suppliedKey = req.header('x-api-key');

  if (!config.apiKey || !suppliedKey || suppliedKey !== config.apiKey) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid x-api-key header' });
  }

  next();
}

module.exports = { requireApiKey };
