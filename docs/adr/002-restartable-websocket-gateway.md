# ADR-002: Separate the PTY owner from the WebSocket gateway

- **Status:** Accepted
- **Date:** 2026-05-01

## Context

The original single-process gateway coupled browser connection churn and
gateway deploys to terminal lifetime. Restarting it destroyed live shells.

## Decision

Run three services:

1. the Next.js application;
2. an authenticated WebSocket gateway that only proxies terminal I/O; and
3. a long-lived PTY daemon that owns `node-pty` sessions and scrollback.

The gateway must not import the PTY manager directly.

## Consequences

- A gateway restart can preserve shells and reconnect clients.
- A PTY-daemon restart still terminates live shells by design.
- Docker Compose uses an explicit private network opt-in for gateway-to-daemon
  traffic; the daemon is not published to the host network.
