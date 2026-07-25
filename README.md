# 🪩 Discord-Presence-Relay

Mirrors Discord Rich Presence activity to every running Discord
instance (stable, PTB, Canary, ...), so apps that only connect to the
primary `discord-ipc-0` socket show their presence everywhere.

![Screenshot](assets/screenshot.png)

It works by taking over `discord-ipc-0`, passing all traffic through to the
real primary instance unchanged, and forwarding the handshake and
`SET_ACTIVITY` frames to the other detected instances.

Linux and macOS only.

## Install

Download the latest build for your platform from the
[Releases page](https://github.com/YuzuZensai/Discord-Presence-Relay/releases).

### Linux (AppImage)

1. Download `discord-presence-relay-<version>.AppImage`.
2. Make it executable and run it:

   ```bash
   chmod +x discord-presence-relay-*.AppImage
   ./discord-presence-relay-*.AppImage
   ```

The app runs from the tray. To launch it automatically and have it appear in
your application menu, move it somewhere permanent (e.g. `~/Applications/`)
and create a desktop entry, or enable "Start on login" from the app's
settings once it's running.

### Linux (.deb)

1. Download `discord-presence-relay-<version>.deb`.
2. Install it:

   ```bash
   sudo apt install ./discord-presence-relay-*.deb
   ```

3. Launch it from your application menu ("Discord Presence Relay"), or from a
   terminal:

   ```bash
   discord-presence-relay
   ```

### macOS (Homebrew)

```bash
brew tap yuzuzensai/discord-rpc-relay https://github.com/YuzuZensai/Discord-RPC-Relay
brew trust yuzuzensai/discord-rpc-relay
brew install --cask discord-presence-relay
```

`brew trust` is required once per tap, Homebrew blocks installing from
third-party taps until you explicitly trust them.

The cask clears the Gatekeeper quarantine attribute automatically after
install, so the app opens normally right away.

### macOS (manual)

1. Download `discord-presence-relay-<version>.dmg` and open it.
2. Drag **Discord Presence Relay** into the **Applications** folder.
3. Clear the Gatekeeper quarantine attribute before first launch (see below),
   then open the app from Applications/Launchpad/Spotlight as usual.

The app runs in the menu bar. Subsequent launches don't need the Gatekeeper
step again.

#### macOS Gatekeeper

The macOS build isn't signed/notarized, so Gatekeeper will quarantine it and
refuse to open it ("app is damaged and can't be opened" / "unidentified
developer"). After installing, clear the quarantine attribute from the
Terminal:

```bash
xattr -cr /Applications/Discord\ Presence\ Relay.app
```

Then open the app normally.

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
