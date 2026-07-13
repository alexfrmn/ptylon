import { isAllowedPtyClient } from '../server/pty-network-policy.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
  assert(isAllowedPtyClient(address, false), `expected loopback ${address} to be allowed`);
}

assert(!isAllowedPtyClient('172.30.0.4', false), 'expected non-loopback client to be denied by default');
assert(isAllowedPtyClient('172.30.0.4', true), 'expected explicit private-network opt-in to allow Compose peer');

console.log('PTY network policy test passed');
