// Each adapter handles one portal family. An adapter exports:
//   id:     short name
//   hosts:  hostnames it serves (exact or subdomain match)
//   run(ctx): drives the form. Must call ctx.beforeSubmit() right before the
//             final submit click, and must throw ctx.NotMappedYet for any step
//             it does not know yet, rather than guess.
const adapters = [
  require('./metropark'),
];

// Local self-test only (npm test). Never enabled in production.
if (process.env.BOT_TEST_MODE === '1') {
  adapters.push(...require('../test/testAdapters'));
}

function pickAdapter(portalUrl) {
  let host;
  try { host = new URL(portalUrl).hostname.toLowerCase(); } catch { return null; }
  return adapters.find((a) => a.hosts.some((h) => host === h || host.endsWith(`.${h}`))) || null;
}

module.exports = { pickAdapter, adapters };
