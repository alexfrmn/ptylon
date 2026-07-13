const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The PTY daemon is loopback-only by default. Compose peers are allowed only
 * when the deployment explicitly opts into its private Docker network.
 */
export function isAllowedPtyClient(remoteAddress, allowNetwork = false) {
  return allowNetwork || LOOPBACK_ADDRESSES.has(remoteAddress);
}
