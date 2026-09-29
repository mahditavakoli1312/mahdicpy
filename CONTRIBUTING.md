# Contributing to mahdicpy

Thanks for helping! mahdicpy is intentionally small and dependency-free — please keep it that way.

## Project layout

| Path | What |
|---|---|
| `mahdicpy` | The CLI (single-file Python, stdlib only) |
| `web/server.py` | Web panel backend: scrcpy-server protocol, WebSocket, JSON API |
| `web/app.js` | Web panel frontend: WebCodecs decoder, input, tools (vanilla JS) |
| `web/style.css`, `web/index.html` | UI |
| `install.sh` | Downloads & verifies the official scrcpy release into `vendor/` |

## Getting started

```bash
git clone https://github.com/mahditavakoli1312/mahdicpy.git && cd mahdicpy
./install.sh --no-link
./mahdicpy doctor
python3 web/server.py --open     # static files are re-read on every request — just refresh
```

## Guidelines

- **No new dependencies** — Python standard library and vanilla JS only.
- Keep the CLI backwards compatible: unknown options must still be forwarded to scrcpy.
- Anything that runs on the device should degrade gracefully on older Android versions.
- Never interpolate user input into shell commands without `shlex.quote` / validation.
- Before opening a PR: `python3 -m py_compile mahdicpy web/server.py && node --check web/app.js && bash -n install.sh`
- Include a screenshot or GIF for UI changes.

## Good first issues

Look for the [`good first issue`](https://github.com/mahditavakoli1312/mahdicpy/labels/good%20first%20issue) label, or pick something from the roadmap in the README.
