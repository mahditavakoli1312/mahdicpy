# Changelog

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
