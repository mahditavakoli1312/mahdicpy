# Changelog

## Unreleased

- `mahdicpy shortcut [--desktop] [--remove]`: app shortcuts for the mirror and the web panel on macOS (`.app`), Linux (`.desktop`) and Windows (`.lnk`); `install.sh` creates them (opt out with `--no-shortcut`)
- Web panel: opens the browser on every OS (was macOS-only), reuses an already-running panel instead of failing on the busy port, and reports a clear error when the port is taken
- CLI finds a bundled `scrcpy.exe` / `adb.exe` on Windows

## v1.0.0 — 2026-09-29

First public release.

### Web panel (`mahdicpy web`)
- In-browser mirroring over WebSocket, decoded with WebCodecs; touch, multi-touch, scroll, keyboard, bidirectional clipboard
- Shared sessions with viewer count; full-access and view-only links; HTTPS for LAN sharing
- Developer toolkit: Overview + live charts, Logcat (regex, per-package, crash/ANR alerts), Apps (cold-start timing, permissions, APK pull), Files (preview), UI Inspector (test selectors for Espresso / UiAutomator / Compose / Appium / Maestro), Dev toggles, Network (`adb reverse`/`forward`, deep links), Shell
- Command palette (⌘K), drag & drop install/upload, WebM recording, screenshots

### CLI
- Presets: `game`, `hq`, `low`, `present`, `stealth`, `desktop`, `cam`, `audio`, `mic`, `otg`, `rec`
- `wifi`, `pair`, `all`, `app`, `shot`, `info`, `install`, `profile`, `doctor`, `--watch` auto-reconnect
- `install.sh` with pinned, checksum-verified scrcpy 3.3.4
