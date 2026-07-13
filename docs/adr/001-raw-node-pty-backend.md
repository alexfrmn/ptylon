# ADR-001: Keep raw node-pty as the terminal backend

- **Status:** Accepted
- **Date:** 2026-04-25

## Context

Ptylon needs to preserve direct terminal semantics for interactive tools such
as Claude Code. A terminal multiplexer could offer its own persistence model,
but would introduce another session layer with different signal, lifecycle, and
scrollback behavior.

## Decision

Ptylon uses raw `node-pty` processes. It does not use tmux or zellij as a
backend or default backend.

## Consequences

- PTY process ownership and signals remain predictable.
- The daemon can expose process/session metadata without hidden multiplexer
  state.
- Restarting the PTY owner still terminates live shells; persistence across a
  PTY-daemon restart is deliberately out of scope until a separate backend is
  designed.
