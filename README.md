# Discord RPC Relay

Mirrors Discord Rich Presence (RPC) activity to every running Discord
instance (stable, PTB, Canary, ...), so apps that only connect to the
primary `discord-ipc-0` socket show their presence everywhere.

It works by taking over `discord-ipc-0`, passing all traffic through to the
real primary instance unchanged, and forwarding the handshake and
`SET_ACTIVITY` frames to the other detected instances.

Linux and macOS (untested) only.

## Development

```bash
pnpm install
pnpm dev
```

## Build

```bash
pnpm build:linux
pnpm build:mac
pnpm build:win
```
