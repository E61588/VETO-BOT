const metropark = require('../adapters/metropark');
// The real Metropark adapter, pointed at the local mock portal.
const mockMetropark = { ...metropark, id: 'metropark-mock', hosts: ['127.0.0.1'] };
module.exports = [mockMetropark];
