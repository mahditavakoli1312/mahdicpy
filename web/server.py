#!/usr/bin/env python3
"""mahdicpy web panel — browser-based Android mirroring & developer toolkit.

Talks to scrcpy-server directly (H.264 over a WebSocket, decoded in the
browser with WebCodecs) and exposes adb-powered developer tools over a small
JSON API. Standard library only.
"""

import argparse
import base64
import hashlib
import json
import os
import queue
import re
import secrets
import shlex
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

WEB = Path(__file__).resolve().parent
ROOT = WEB.parent


def find_tool(name):
    for d in (ROOT, ROOT / "vendor"):
        if (d / name).is_file():
            return str(d / name)
    return shutil.which(name) or name


ADB = find_tool("adb")
SCRCPY = find_tool("scrcpy")


def find_server_jar():
    candidates = [os.environ.get("SCRCPY_SERVER_PATH"), ROOT / "scrcpy-server", ROOT / "vendor" / "scrcpy-server",
                  Path(os.path.realpath(SCRCPY)).parent / "scrcpy-server"]
    candidates += [Path(p) / "share/scrcpy/scrcpy-server" for p in ("/opt/homebrew", "/usr/local", "/usr")]
    for c in candidates:
        if c and Path(c).is_file():
            return Path(c)
    return ROOT / "scrcpy-server"


SERVER_JAR = find_server_jar()
CLI = ROOT / "mahdicpy"
CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "mahdicpy"
DEVICE_JAR = "/data/local/tmp/mahdicpy-server.jar"
VERSION = "1.0.0"

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/icon.png": ("../mahdicpy.png", "image/png"),
}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def scrcpy_version():
    try:
        out = subprocess.run([SCRCPY, "--version"], capture_output=True, text=True,
                             timeout=10).stdout
        m = re.search(r"scrcpy (\d+\.\d+(?:\.\d+)?)", out)
        if m:
            return m.group(1)
    except (OSError, subprocess.TimeoutExpired):
        pass
    return "3.3.4"


SERVER_VERSION = scrcpy_version()


# ─────────────────────────────── adb helpers ────────────────────────────

def adb(args, serial=None, timeout=30, binary=False, input=None):
    cmd = [ADB] + (["-s", serial] if serial else []) + list(args)
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=timeout, input=input)
    except subprocess.TimeoutExpired:
        return 124, (b"" if binary else "timed out")
    out = p.stdout if binary else (p.stdout + p.stderr).decode("utf-8", "replace")
    return p.returncode, out


def sh(serial, command, timeout=30):
    return adb(["shell", command], serial, timeout)[1]


def q(s):
    return shlex.quote(str(s))


_dev_cache = {}


def list_devices():
    rc, out = adb(["devices", "-l"], timeout=10)
    devs = []
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 2:
            continue
        d = {"serial": parts[0], "state": parts[1]}
        for p in parts[2:]:
            if ":" in p:
                k, v = p.split(":", 1)
                d[k] = v.replace("_", " ")
        d["wifi"] = bool(re.match(r"^[\d.]+:\d+$", d["serial"])) or d["serial"].startswith("adb-")
        if d["state"] == "device":
            d.update(device_summary(d["serial"]))
        s = SESSIONS.get(d["serial"])
        d["viewers"] = len(s.viewers) if s else 0
        devs.append(d)
    return devs


def device_summary(serial):
    c = _dev_cache.get(serial)
    if c and time.time() - c[0] < 15:
        return c[1]
    out = sh(serial, "getprop ro.product.manufacturer; getprop ro.product.model; "
                     "getprop ro.build.version.release; getprop ro.build.version.sdk; "
                     "dumpsys battery | grep -m1 level", timeout=10).splitlines()
    out += [""] * 5
    level = re.search(r"(\d+)", out[4])
    info = {"brand": out[0].strip(), "name": out[1].strip(), "android": out[2].strip(),
            "sdk": int(out[3]) if out[3].strip().isdigit() else 0,
            "battery": int(level.group(1)) if level else None}
    _dev_cache[serial] = (time.time(), info)
    return info


def device_info(serial):
    marker = "@@MCPY@@"
    cmds = [
        "getprop ro.product.manufacturer", "getprop ro.product.model",
        "getprop ro.build.version.release", "getprop ro.build.version.sdk",
        "getprop ro.soc.model; getprop ro.board.platform", "getprop ro.product.cpu.abi",
        "wm size", "wm density", "dumpsys battery", "cat /proc/meminfo | head -3",
        "df -h /data | tail -1", "ip -f inet addr show wlan0",
        "getprop ro.build.fingerprint", "getprop persist.sys.locale; getprop ro.product.locale",
        "cat /proc/uptime", "getprop ro.build.version.security_patch",
        "getprop ro.kernel.qemu",
    ]
    out = sh(serial, f"; echo {marker}; ".join(cmds), timeout=20).split(marker)
    out = [o.strip() for o in out] + [""] * len(cmds)
    batt = out[8]
    g = lambda pat, s, d="": (re.search(pat, s) or [None, d])[1]
    mem_total = int(g(r"MemTotal:\s+(\d+)", out[9], "0"))
    mem_avail = int(g(r"MemAvailable:\s+(\d+)", out[9], "0"))
    df = out[10].split()
    up = float((out[14].split() or ["0"])[0])
    return {
        "brand": out[0], "model": out[1], "android": out[2], "sdk": out[3],
        "chip": (out[4].splitlines() or [""])[0] or "—", "abi": out[5],
        "screen": g(r"Override size: (\S+)", out[6]) or g(r"(\d+x\d+)", out[6], "?"),
        "density": g(r"Override density: (\d+)", out[7]) or g(r"(\d+)", out[7], "?"),
        "battery": int(g(r"level: (\d+)", batt, "0")),
        "temperature": int(g(r"temperature: (\d+)", batt, "0")) / 10,
        "charging": g(r"status: (\d+)", batt) == "2",
        "ram_total": mem_total * 1024, "ram_avail": mem_avail * 1024,
        "storage": {"size": df[1], "used": df[2], "avail": df[3], "pct": df[4]} if len(df) >= 5 else None,
        "ip": g(r"inet ([\d.]+)/", out[11]) or None,
        "fingerprint": out[12], "locale": (out[13].splitlines() or [""])[0],
        "uptime": int(up), "patch": out[15], "emulator": out[16] == "1",
        "serial": serial,
    }


_cpu_prev = {}


def device_stats(serial, pkg=None):
    marker = "@@MCPY@@"
    cmd = ("head -1 /proc/stat; echo " + marker + "; grep -E 'MemTotal|MemAvailable' /proc/meminfo;"
           " echo " + marker + "; dumpsys battery | grep -E 'level|temperature'")
    if pkg:
        cmd += (f"; echo {marker}; dumpsys meminfo {q(pkg)} | grep -m1 -E 'TOTAL'; echo {marker};"
                f" dumpsys gfxinfo {q(pkg)} | grep -E 'Total frames|Janky'; echo {marker}; pidof {q(pkg)}")
    parts = sh(serial, cmd, timeout=10).split(marker)
    parts += [""] * 6
    nums = [int(x) for x in parts[0].split()[1:]]
    cpu = None
    if nums:
        idle, total = nums[3] + (nums[4] if len(nums) > 4 else 0), sum(nums)
        prev = _cpu_prev.get(serial)
        if prev and total > prev[1]:
            cpu = round(100 * (1 - (idle - prev[0]) / (total - prev[1])), 1)
        _cpu_prev[serial] = (idle, total)
    g = lambda pat, s: int((re.search(pat, s) or [0, 0])[1])
    total, avail = g(r"MemTotal:\s+(\d+)", parts[1]), g(r"MemAvailable:\s+(\d+)", parts[1])
    res = {"t": time.time(), "cpu": cpu,
           "mem_used": (total - avail) * 1024, "mem_total": total * 1024,
           "battery": g(r"level: (\d+)", parts[2]),
           "temp": g(r"temperature: (\d+)", parts[2]) / 10}
    if pkg:
        m = re.search(r"TOTAL\s*(?:PSS:)?\s+(\d+)", parts[3])
        res["app_pss"] = int(m.group(1)) * 1024 if m else None
        res["frames"] = g(r"Total frames rendered: (\d+)", parts[4])
        jm = re.search(r"Janky frames: (\d+) \(([\d.]+)%\)", parts[4])
        res["janky"] = int(jm.group(1)) if jm else 0
        res["jank_pct"] = float(jm.group(2)) if jm else 0.0
        res["pid"] = parts[5].strip() or None
    return res


# ─────────────────────────────── H.264 SPS parsing ──────────────────────

class _Bits:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def u(self, n):
        v = 0
        for _ in range(n):
            byte = self.data[self.pos >> 3] if (self.pos >> 3) < len(self.data) else 0
            v = (v << 1) | ((byte >> (7 - (self.pos & 7))) & 1)
            self.pos += 1
        return v

    def ue(self):
        zeros = 0
        while self.u(1) == 0 and zeros < 32:
            zeros += 1
        return (1 << zeros) - 1 + self.u(zeros)

    def se(self):
        k = self.ue()
        return (k + 1) // 2 if k & 1 else -(k // 2)


def sps_size(config):
    """Return (width, height) from an Annex-B config packet, or None."""
    for nal in re.split(b"\x00\x00\x00\x01|\x00\x00\x01", config):
        if nal and nal[0] & 0x1F == 7:
            break
    else:
        return None
    try:
        b = _Bits(nal[1:].replace(b"\x00\x00\x03", b"\x00\x00"))
        profile = b.u(8)
        b.u(16)
        b.ue()
        cf = 1
        if profile in (100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
            cf = b.ue()
            if cf == 3:
                b.u(1)
            b.ue(), b.ue(), b.u(1)
            if b.u(1):
                for i in range(12 if cf == 3 else 8):
                    if b.u(1):
                        last = nxt = 8
                        for _ in range(16 if i < 6 else 64):
                            if nxt:
                                nxt = (last + b.se() + 256) % 256
                            last = nxt or last
        b.ue()
        poc = b.ue()
        if poc == 0:
            b.ue()
        elif poc == 1:
            b.u(1), b.se(), b.se()
            for _ in range(b.ue()):
                b.se()
        b.ue(), b.u(1)
        w = (b.ue() + 1) * 16
        hm = b.ue() + 1
        fmo = b.u(1)
        h = (2 - fmo) * hm * 16
        if not fmo:
            b.u(1)
        b.u(1)
        if b.u(1):
            l, r, t, bt = b.ue(), b.ue(), b.ue(), b.ue()
            w -= (l + r) * 2
            h -= (t + bt) * 2 * (2 - fmo)
        return w, h
    except IndexError:
        return None


# ─────────────────────────────── scrcpy session ─────────────────────────

SESSIONS = {}
SESSIONS_LOCK = threading.Lock()
START_LOCK = threading.Lock()


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def recv_exact(sock, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("eof")
        buf += chunk
    return bytes(buf)


class Session:
    """One scrcpy-server instance per device, shared by every viewer."""

    def __init__(self, serial, opts):
        self.serial, self.opts = serial, opts
        self.scid = f"{secrets.randbits(31):08x}"
        self.viewers = set()
        self.lock = threading.Lock()
        self.ctrl_lock = threading.Lock()
        self.config = None
        self.size = None
        self.name = serial
        self.alive = False
        self.proc = self.video = self.ctrl = self.port = None
        self.last_reset = 0
        self.stop_timer = None
        self.bytes = 0

    def start(self):
        rc, out = adb(["push", str(SERVER_JAR), DEVICE_JAR], self.serial, timeout=60)
        if rc != 0:
            raise RuntimeError(f"push failed: {out.strip()}")
        self.port = free_port()
        rc, out = adb(["forward", f"tcp:{self.port}", f"localabstract:scrcpy_{self.scid}"], self.serial)
        if rc != 0:
            raise RuntimeError(f"forward failed: {out.strip()}")
        o = self.opts
        args = [f"CLASSPATH={DEVICE_JAR}", "app_process", "/", "com.genymobile.scrcpy.Server",
                SERVER_VERSION, f"scid={self.scid}", "log_level=info", "tunnel_forward=true",
                "audio=false", "control=true", "video_codec=h264",
                f"max_size={o['max_size']}", f"video_bit_rate={o['bit_rate']}",
                f"max_fps={o['max_fps']}", "clipboard_autosync=true"]
        if o.get("stay_awake"):
            args.append("stay_awake=true")
        self.proc = subprocess.Popen([ADB, "-s", self.serial, "shell", " ".join(args)],
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        threading.Thread(target=self._pipe_log, daemon=True).start()

        deadline = time.time() + 15
        while True:
            if self.proc.poll() is not None:
                raise RuntimeError("scrcpy-server exited during startup")
            try:
                s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
                if s.recv(1):
                    self.video = s
                    break
                s.close()
            except OSError:
                pass
            if time.time() > deadline:
                raise RuntimeError("scrcpy-server did not start in time")
            time.sleep(0.1)
        self.ctrl = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        self.video.settimeout(None)
        self.ctrl.settimeout(None)
        self.name = recv_exact(self.video, 64).rstrip(b"\0").decode("utf-8", "replace")
        _, w, h = struct.unpack(">III", recv_exact(self.video, 12))
        self.size = (w, h)
        self.alive = True
        threading.Thread(target=self._video_loop, daemon=True).start()
        threading.Thread(target=self._ctrl_loop, daemon=True).start()
        log(f"session {self.serial}: {self.name} {w}x{h} "
            f"({o['max_size'] or 'native'}px, {o['bit_rate'] // 1000000}Mbps, {o['max_fps']}fps)")

    def _pipe_log(self):
        for line in iter(self.proc.stdout.readline, b""):
            line = line.decode("utf-8", "replace").rstrip()
            if line and ("ERROR" in line or "WARN" in line):
                log(f"[{self.serial}] {line}")

    def _video_loop(self):
        try:
            while self.alive:
                hdr = recv_exact(self.video, 12)
                pts, size = struct.unpack(">QI", hdr)
                data = recv_exact(self.video, size)
                self.bytes += size + 12
                config, key = bool(pts >> 63), bool((pts >> 62) & 1)
                pkt = b"\x00" + hdr + data
                if config:
                    self.config = pkt
                    sz = sps_size(data)
                    if sz and sz != self.size:
                        self.size = sz
                    self.broadcast_json({"t": "size", "w": self.size[0], "h": self.size[1]})
                with self.lock:
                    viewers = list(self.viewers)
                for v in viewers:
                    v.push_video(pkt, key, config)
        except (ConnectionError, OSError):
            pass
        self.close("stream ended")

    def _ctrl_loop(self):
        try:
            while self.alive:
                t = recv_exact(self.ctrl, 1)[0]
                if t == 0:  # clipboard
                    n = struct.unpack(">I", recv_exact(self.ctrl, 4))[0]
                    text = recv_exact(self.ctrl, n).decode("utf-8", "replace")
                    self.broadcast_json({"t": "clipboard", "text": text})
                elif t == 1:  # clipboard ack
                    recv_exact(self.ctrl, 8)
                elif t == 2:  # uhid output
                    _, n = struct.unpack(">HH", recv_exact(self.ctrl, 4))
                    recv_exact(self.ctrl, n)
                else:
                    break
        except (ConnectionError, OSError):
            pass

    def send_ctrl(self, data):
        if not self.alive:
            return
        with self.ctrl_lock:
            try:
                self.ctrl.sendall(data)
            except OSError:
                pass

    def request_reset(self):
        if time.time() - self.last_reset > 1:
            self.last_reset = time.time()
            self.send_ctrl(b"\x11")

    def broadcast_json(self, obj):
        with self.lock:
            viewers = list(self.viewers)
        for v in viewers:
            v.push_json(obj)

    def add(self, viewer):
        with self.lock:
            if self.stop_timer:
                self.stop_timer.cancel()
                self.stop_timer = None
            self.viewers.add(viewer)
        viewer.push_json({"t": "meta", "name": self.name, "w": self.size[0], "h": self.size[1],
                          "opts": self.opts, "serial": self.serial})
        if self.config:
            viewer.q.put(self.config)
        self.request_reset()
        self.broadcast_json({"t": "viewers", "n": len(self.viewers)})

    def remove(self, viewer):
        with self.lock:
            self.viewers.discard(viewer)
            empty = not self.viewers
            if empty and self.alive:
                self.stop_timer = threading.Timer(8, self._stop_if_idle)
                self.stop_timer.daemon = True
                self.stop_timer.start()
        self.broadcast_json({"t": "viewers", "n": len(self.viewers)})

    def _stop_if_idle(self):
        with self.lock:
            if self.viewers:
                return
        self.close("no viewers")

    def close(self, reason=""):
        if not self.alive and self.proc is None:
            return
        self.alive = False
        for s in (self.video, self.ctrl):
            try:
                s and s.close()
            except OSError:
                pass
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
        self.proc = None
        if self.port:
            adb(["forward", "--remove", f"tcp:{self.port}"], self.serial, timeout=5)
        with SESSIONS_LOCK:
            if SESSIONS.get(self.serial) is self:
                del SESSIONS[self.serial]
        with self.lock:
            viewers = list(self.viewers)
        for v in viewers:
            v.push_json({"t": "closed", "reason": reason})
            v.q.put(None)
        log(f"session {self.serial} closed ({reason})")


def get_session(serial, opts, restart=False):
    with START_LOCK:
        with SESSIONS_LOCK:
            s = SESSIONS.get(serial)
            if s and s.alive and not restart:
                return s
        if s:
            s.close("restarted with new settings")
        s = Session(serial, opts)
        try:
            s.start()
        except Exception:
            s.close("startup failed")
            raise
        with SESSIONS_LOCK:
            SESSIONS[serial] = s
        return s


class Viewer:
    def __init__(self, session, role, video=True):
        self.session, self.role, self.video = session, role, video
        self.q = queue.Queue(maxsize=240)
        self.need_key = True

    def push_json(self, obj):
        try:
            self.q.put_nowait(json.dumps(obj))
        except queue.Full:
            pass

    def push_video(self, pkt, key, config):
        if not self.video:
            return
        if self.need_key and not (key or config):
            return
        if key:
            self.need_key = False
        try:
            self.q.put_nowait(pkt)
        except queue.Full:  # slow client: drop until the next keyframe
            self.need_key = True
            with self.q.mutex:
                self.q.queue.clear()
            self.session.request_reset()


# ─────────────────────────────── websocket ──────────────────────────────

class WebSocket:
    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    def __init__(self, handler):
        self.r, self.w = handler.rfile, handler.wfile
        self.wlock = threading.Lock()
        key = handler.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(hashlib.sha1((key + self.GUID).encode()).digest()).decode()
        handler.send_response(101, "Switching Protocols")
        handler.send_header("Upgrade", "websocket")
        handler.send_header("Connection", "Upgrade")
        handler.send_header("Sec-WebSocket-Accept", accept)
        handler.end_headers()
        handler.wfile.flush()

    def send(self, data, text=False):
        if isinstance(data, str):
            data, text = data.encode(), True
        n = len(data)
        head = bytes([0x81 if text else 0x82])
        if n < 126:
            head += bytes([n])
        elif n < 65536:
            head += bytes([126]) + struct.pack(">H", n)
        else:
            head += bytes([127]) + struct.pack(">Q", n)
        with self.wlock:
            self.w.write(head + data)
            self.w.flush()

    def recv(self):
        """Return (opcode, payload) or None when the socket closes."""
        while True:
            h = self.r.read(2)
            if len(h) < 2:
                return None
            op, n = h[0] & 0x0F, h[1] & 0x7F
            if n == 126:
                n = struct.unpack(">H", self.r.read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self.r.read(8))[0]
            mask = self.r.read(4) if h[1] & 0x80 else None
            data = self.r.read(n)
            if len(data) < n:
                return None
            if mask:
                m = (mask * (n // 4 + 1))[:n]
                data = (int.from_bytes(data, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big")
            if op == 8:
                return None
            if op == 9:
                with self.wlock:
                    self.w.write(bytes([0x8A, len(data)]) + data)
                    self.w.flush()
                continue
            if op in (1, 2):
                return op, data


# ─────────────────────────────── dev toggles ────────────────────────────

POKE = "service call activity 1599295570 >/dev/null 2>&1"

TOGGLES = [
    # key, label, kind, get-command, options/values
    ("layout_bounds", "Show layout bounds", "bool", "getprop debug.layout"),
    ("show_taps", "Show taps", "bool", "settings get system show_touches"),
    ("pointer_location", "Pointer location", "bool", "settings get system pointer_location"),
    ("gpu_overdraw", "GPU overdraw", "bool", "getprop debug.hwui.overdraw"),
    ("gpu_profile", "Profile GPU rendering", "bool", "getprop debug.hwui.profile"),
    ("dont_keep", "Don't keep activities", "bool", "settings get global always_finish_activities"),
    ("force_rtl", "Force RTL layout", "bool", "settings get global debug.force_rtl"),
    ("stay_awake", "Stay awake while charging", "bool", "settings get global stay_on_while_plugged_in"),
    ("dark_mode", "Dark mode", "bool", "cmd uimode night 2>/dev/null"),
    ("demo_mode", "Clean status bar (demo mode)", "bool", "settings get global sysui_tuner_demo_on"),
    ("animations", "Animation scale", "select", "settings get global window_animation_scale"),
    ("font_scale", "Font scale", "select", "settings get system font_scale"),
    ("density", "Screen density (dpi)", "select", "wm density"),
]

SELECT_OPTIONS = {
    "animations": ["0", "0.5", "1", "2", "5"],
    "font_scale": ["0.85", "1.0", "1.15", "1.3", "1.5", "2.0"],
    "density": ["reset", "240", "280", "320", "360", "400", "480"],
}


def get_toggles(serial):
    marker = "@@MCPY@@"
    out = sh(serial, f"; echo {marker}; ".join(t[3] for t in TOGGLES), timeout=15).split(marker)
    out = [o.strip() for o in out] + [""] * len(TOGGLES)
    res = []
    for (key, label, kind, _), raw in zip(TOGGLES, out):
        if kind == "bool":
            if key == "dark_mode":
                val = raw.endswith("yes")
            elif key == "gpu_overdraw":
                val = raw == "show"
            elif key == "gpu_profile":
                val = raw in ("visual_bars", "true")
            elif key == "stay_awake":
                val = raw not in ("0", "", "null")
            else:
                val = raw in ("1", "true")
            res.append({"key": key, "label": label, "kind": kind, "value": val})
        else:
            if key == "density":
                m = re.search(r"Override density: (\d+)", raw)
                val = m.group(1) if m else "reset"
            else:
                val = raw if raw not in ("null", "") else "1.0"
                if key == "font_scale" and val == "1":
                    val = "1.0"
            res.append({"key": key, "label": label, "kind": kind, "value": val,
                        "options": SELECT_OPTIONS[key]})
    return res


def set_toggle(serial, key, value):
    on = value in (True, "true", "1", 1)
    b = "1" if on else "0"
    cmds = {
        "layout_bounds": f"setprop debug.layout {'true' if on else 'false'}; {POKE}",
        "show_taps": f"settings put system show_touches {b}",
        "pointer_location": f"settings put system pointer_location {b}",
        "gpu_overdraw": f"setprop debug.hwui.overdraw {'show' if on else 'false'}; {POKE}",
        "gpu_profile": f"setprop debug.hwui.profile {'visual_bars' if on else 'false'}; {POKE}",
        "dont_keep": f"settings put global always_finish_activities {b}",
        "force_rtl": f"settings put global debug.force_rtl {b}; setprop persist.sys.forcertl {b}; {POKE}",
        "stay_awake": f"settings put global stay_on_while_plugged_in {'7' if on else '0'}",
        "dark_mode": f"cmd uimode night {'yes' if on else 'no'}",
        "demo_mode": (
            "settings put global sysui_demo_allowed 1; settings put global sysui_tuner_demo_on 1; "
            "B='am broadcast -a com.android.systemui.demo'; $B -e command enter; "
            "$B -e command clock -e hhmm 1200; $B -e command battery -e level 100 -e plugged false; "
            "$B -e command network -e wifi show -e level 4 -e mobile show -e datatype none -e level 4; "
            "$B -e command notifications -e visible false"
            if on else
            "am broadcast -a com.android.systemui.demo -e command exit; "
            "settings put global sysui_tuner_demo_on 0"),
    }
    if key == "animations":
        v = q(value)
        cmd = (f"settings put global window_animation_scale {v}; "
               f"settings put global transition_animation_scale {v}; "
               f"settings put global animator_duration_scale {v}")
    elif key == "font_scale":
        cmd = f"settings put system font_scale {q(value)}"
    elif key == "density":
        cmd = "wm density reset" if value == "reset" else f"wm density {int(value)}"
    elif key in cmds:
        cmd = cmds[key]
    else:
        raise ValueError(f"unknown toggle {key}")
    return sh(serial, cmd + " >/dev/null 2>&1; echo ok", timeout=20)


# ─────────────────────────────── HTTP handler ───────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = f"mahdicpy/{VERSION}"
    tokens = {}  # token -> role

    def log_message(self, fmt, *args):
        pass

    # ---- helpers ----
    def role(self):
        tok = self.headers.get("X-Token") or self.qs.get("t", [""])[0]
        return self.tokens.get(tok)

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def fail(self, msg, code=400):
        self.send_json({"error": msg}, code)

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def body_to_file(self, suffix=""):
        n = int(self.headers.get("Content-Length") or 0)
        fd, path = tempfile.mkstemp(suffix=suffix, prefix="mahdicpy-")
        with os.fdopen(fd, "wb") as f:
            while n > 0:
                chunk = self.rfile.read(min(n, 1 << 20))
                if not chunk:
                    break
                f.write(chunk)
                n -= len(chunk)
        return path

    def stream_process(self, cmd, ctype="application/octet-stream", filename=None):
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if filename:
            self.send_header("Content-Disposition",
                             f"attachment; filename*=UTF-8''{quote(filename)}")
        self.end_headers()
        self.close_connection = True
        try:
            fd = proc.stdout.fileno()
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()

    # ---- routing ----
    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def route(self, method):
        u = urlparse(self.path)
        self.qs = parse_qs(u.query)
        path = u.path
        if method == "GET" and path in STATIC:
            return self.static(*STATIC[path])
        role = self.role()
        if role is None:
            return self.fail("unauthorized — open the link printed by 'mahdicpy web'", 401)
        s = self.qs.get("s", [None])[0]
        handler = ROUTES.get((method, path))
        if not handler:
            return self.fail("not found", 404)
        if role != "admin" and (method, path) not in VIEWER_ROUTES:
            return self.fail("view-only access", 403)
        try:
            handler(self, s)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # report instead of dropping the connection
            log(f"error {method} {path}: {e!r}")
            try:
                self.fail(str(e), 500)
            except OSError:
                pass

    def static(self, name, ctype):
        p = (WEB / name).resolve()
        if not p.exists():
            return self.fail("not found", 404)
        body = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


# ─────────────────────────────── API endpoints ──────────────────────────

def api_me(h, s):
    h.send_json({"role": h.role(), "version": VERSION, "scrcpy": SERVER_VERSION,
                 "urls": h.server.share_urls if h.role() == "admin" else None})


def api_devices(h, s):
    h.send_json(list_devices())


def api_info(h, s):
    h.send_json(device_info(s))


def api_stats(h, s):
    h.send_json(device_stats(s, h.qs.get("pkg", [None])[0]))


def api_shell(h, s):
    body = h.body_json()
    t0 = time.time()
    rc, out = adb(["shell", body.get("cmd", "")], s, timeout=int(body.get("timeout", 30)))
    h.send_json({"rc": rc, "out": out, "ms": int((time.time() - t0) * 1000)})


def api_screenshot(h, s):
    rc, data = adb(["exec-out", "screencap", "-p"], s, timeout=20, binary=True)
    if not data.startswith(b"\x89PNG"):
        return h.fail("screenshot failed (secure window?)", 500)
    h.send_response(200)
    h.send_header("Content-Type", "image/png")
    h.send_header("Content-Length", str(len(data)))
    h.send_header("Cache-Control", "no-store")
    if h.qs.get("dl"):
        h.send_header("Content-Disposition",
                      f"attachment; filename=screenshot-{time.strftime('%Y%m%d-%H%M%S')}.png")
    h.end_headers()
    h.wfile.write(data)


def api_logcat(h, s):
    args = [ADB, "-s", s, "logcat", "-v", "threadtime", "-T", h.qs.get("tail", ["300"])[0]]
    pkg = h.qs.get("pkg", [""])[0]
    if pkg:
        pid = sh(s, f"pidof {q(pkg)}", timeout=5).strip().split()
        if not pid:
            h.send_response(200)
            h.send_header("Content-Type", "text/plain; charset=utf-8")
            h.end_headers()
            h.wfile.write(f"--------- {pkg} is not running — start it and reconnect\n".encode())
            return
        args.append(f"--pid={pid[0]}")
    buf = h.qs.get("buffer", [""])[0]
    if buf in ("main", "system", "crash", "events", "radio", "all"):
        args += ["-b", buf]
    h.stream_process(args, "text/plain; charset=utf-8")


def api_logcat_clear(h, s):
    adb(["logcat", "-c"], s)
    h.send_json({"ok": True})


def api_bugreport_lite(h, s):
    """Crash & ANR summary for quick triage."""
    crash = adb(["logcat", "-d", "-b", "crash", "-t", "200"], s, timeout=20)[1]
    anr = sh(s, "ls -t /data/anr 2>/dev/null | head -5", timeout=10)
    h.send_json({"crash": crash, "anr": anr})


def api_apps(h, s):
    flag = "-s" if h.qs.get("system", [""])[0] == "1" else "-3"
    out = sh(s, f"pm list packages {flag}", timeout=20)
    pkgs = sorted(l[8:].strip() for l in out.splitlines() if l.startswith("package:"))
    top = top_activity(s)
    h.send_json({"packages": pkgs, "foreground": top.split("/")[0] if top else None})


def top_activity(s):
    out = sh(s, "dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity' | head -1",
             timeout=10)
    m = re.search(r"u\d+ (\S+/\S+)", out)
    return m.group(1) if m else None


def api_app(h, s):
    pkg = h.qs.get("pkg", [""])[0]
    out = sh(s, f"dumpsys package {q(pkg)}", timeout=20)
    g = lambda pat: (re.search(pat, out) or [None, None])[1]
    perms = {}
    runtime = out.split("runtime permissions:", 1)
    if len(runtime) == 2:
        for line in runtime[1].splitlines()[1:]:
            m = re.match(r"^\s+([\w.]+): granted=(\w+)", line)
            if not m:
                break
            perms[m.group(1)] = m.group(2) == "true"
    pid = sh(s, f"pidof {q(pkg)}", timeout=5).strip()
    h.send_json({
        "package": pkg, "version": g(r"versionName=(\S+)"), "code": g(r"versionCode=(\d+)"),
        "minSdk": g(r"minSdk=(\d+)"), "targetSdk": g(r"targetSdk=(\d+)"),
        "installed": g(r"firstInstallTime=(.+)"), "updated": g(r"lastUpdateTime=(.+)"),
        "path": g(r"codePath=(\S+)"), "installer": g(r"installerPackageName=(\S+)"),
        "debuggable": "DEBUGGABLE" in (g(r"pkgFlags=\[([^\]]*)\]") or ""),
        "permissions": perms, "pid": pid or None,
    })


def api_app_action(h, s):
    b = h.body_json()
    pkg, action = b.get("pkg", ""), b.get("action")
    if not re.match(r"^[\w.]+$", pkg):
        return h.fail("bad package name")
    launch = f"monkey -p {pkg} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 && echo launched"
    cmds = {
        "launch": launch,
        "stop": f"am force-stop {pkg} && echo stopped",
        "restart": f"am force-stop {pkg}; {launch}",
        "clear": f"pm clear {pkg}",
        "uninstall": f"pm uninstall {pkg}",
        "settings": f"am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:{pkg}",
        "coldstart": (f"A=$(cmd package resolve-activity --brief {pkg} | tail -1); "
                      f"am start -W -S -n $A"),
    }
    if action in ("grant", "revoke"):
        perm = b.get("perm", "")
        if not re.match(r"^[\w.]+$", perm):
            return h.fail("bad permission")
        cmd = f"pm {action} {pkg} {perm}"
    elif action in cmds:
        cmd = cmds[action]
    else:
        return h.fail("unknown action")
    t0 = time.time()
    out = sh(s, cmd, timeout=60)
    res = {"out": out.strip(), "ms": int((time.time() - t0) * 1000)}
    m = re.search(r"TotalTime: (\d+)", out)
    if m:
        res["total_time"] = int(m.group(1))
    h.send_json(res)


def api_apk(h, s):
    pkg = h.qs.get("pkg", [""])[0]
    paths = [l[8:].strip() for l in sh(s, f"pm path {q(pkg)}").splitlines() if l.startswith("package:")]
    base = next((p for p in paths if p.endswith("base.apk")), paths[0] if paths else None)
    if not base:
        return h.fail("apk not found", 404)
    h.stream_process([ADB, "-s", s, "exec-out", "cat", base], "application/vnd.android.package-archive",
                     f"{pkg}.apk")


def api_install(h, s):
    name = unquote(h.headers.get("X-Filename", "app.apk"))
    path = h.body_to_file(".apk")
    try:
        rc, out = adb(["install", "-r", "-g", "-t", "-d", path], s, timeout=300)
    finally:
        os.unlink(path)
    h.send_json({"ok": "Success" in out, "out": out.strip(), "name": name})


def api_files(h, s):
    path = h.qs.get("path", ["/sdcard"])[0] or "/"
    out = sh(s, f"cd {q(path)} && stat -L -c '%F|%s|%Y|%n' * .* 2>/dev/null", timeout=20)
    entries = []
    for line in out.splitlines():
        parts = line.split("|", 3)
        if len(parts) != 4 or parts[3] in (".", ".."):
            continue
        ftype, size, mtime, name = parts
        entries.append({"name": name, "dir": ftype == "directory", "size": int(size or 0),
                        "mtime": int(mtime or 0), "link": False})
    entries.sort(key=lambda e: (not e["dir"], e["name"].lower()))
    h.send_json({"path": path, "entries": entries})


def api_file_get(h, s):
    path = h.qs.get("path", [""])[0]
    h.stream_process([ADB, "-s", s, "exec-out", "cat", path], "application/octet-stream",
                     os.path.basename(path))


def api_file_put(h, s):
    dest = h.qs.get("path", ["/sdcard/Download"])[0]
    name = os.path.basename(unquote(h.headers.get("X-Filename", "upload.bin")))
    tmp = h.body_to_file()
    try:
        rc, out = adb(["push", tmp, f"{dest.rstrip('/')}/{name}"], s, timeout=600)
    finally:
        os.unlink(tmp)
    h.send_json({"ok": rc == 0, "out": out.strip()})


def api_file_op(h, s):
    b = h.body_json()
    op, path = b.get("op"), b.get("path", "")
    if path.rstrip("/").count("/") < 2:
        return h.fail("refusing to touch top-level paths")
    if op == "delete":
        cmd = f"rm -rf {q(path)}"
    elif op == "mkdir":
        cmd = f"mkdir -p {q(path)}"
    elif op == "rename":
        cmd = f"mv {q(path)} {q(b.get('to', ''))}"
    else:
        return h.fail("unknown op")
    out = sh(s, cmd + " && echo ok", timeout=60)
    h.send_json({"ok": out.strip().endswith("ok"), "out": out.strip()})


def api_ui(h, s):
    out = sh(s, "uiautomator dump /sdcard/.mahdicpy-ui.xml >/dev/null 2>&1; "
                "cat /sdcard/.mahdicpy-ui.xml; rm -f /sdcard/.mahdicpy-ui.xml; echo; "
                "echo @@MCPY@@; wm size", timeout=30)
    xml, _, size = out.partition("@@MCPY@@")
    if "<hierarchy" not in xml:
        return h.fail("UI dump failed — the screen may be animating or showing a secure window", 500)
    m = re.search(r"Override size: (\d+)x(\d+)", size) or re.search(r"(\d+)x(\d+)", size)
    w, hh = (int(m.group(1)), int(m.group(2))) if m else (0, 0)
    rot = re.search(r'rotation="(\d)"', xml)
    if rot and rot.group(1) in ("1", "3"):
        w, hh = hh, w
    h.send_json({"xml": xml.strip(), "width": w, "height": hh, "activity": top_activity(s)})


def api_toggles(h, s):
    h.send_json(get_toggles(s))


def api_toggle_set(h, s):
    b = h.body_json()
    set_toggle(s, b.get("key"), b.get("value"))
    h.send_json({"ok": True})


def api_ports(h, s):
    rev = adb(["reverse", "--list"], s, timeout=10)[1]
    fwd = adb(["forward", "--list"], timeout=10)[1]
    rows = lambda txt: [l.split() for l in txt.splitlines() if len(l.split()) >= 3]
    h.send_json({
        "reverse": [{"local": p[1], "remote": p[2]} for p in rows(rev)],
        "forward": [{"local": p[1], "remote": p[2]} for p in rows(fwd)
                    if p[0] == s and "scrcpy" not in p[2] and "AndroidStudio" not in p[2]],
    })


def api_port_set(h, s):
    b = h.body_json()
    kind, local, remote = b.get("kind"), b.get("local", ""), b.get("remote", "")
    spec = re.compile(r"^(tcp:\d+|localabstract:[\w.-]+|jdwp:\d+)$")
    if kind not in ("reverse", "forward") or not spec.match(local) or \
            (not b.get("remove") and not spec.match(remote)):
        return h.fail("use specs like tcp:3000")
    args = [kind, "--remove", local] if b.get("remove") else [kind, local, remote]
    rc, out = adb(args, s, timeout=10)
    h.send_json({"ok": rc == 0, "out": out.strip()})


def api_intent(h, s):
    b = h.body_json()
    uri, pkg = b.get("uri", ""), b.get("pkg", "")
    cmd = f"am start -W -a android.intent.action.VIEW -d {q(uri)}"
    if pkg:
        cmd += f" {q(pkg)}"
    out = sh(s, cmd, timeout=30)
    m = re.search(r"TotalTime: (\d+)", out)
    h.send_json({"out": out.strip(), "total_time": int(m.group(1)) if m else None})


def api_broadcast(h, s):
    b = h.body_json()
    out = sh(s, f"am broadcast -a {q(b.get('action', ''))}", timeout=20)
    h.send_json({"out": out.strip()})


def api_input(h, s):
    b = h.body_json()
    kind = b.get("kind")
    if kind == "text":
        text = b.get("text", "").replace(" ", "%s")
        out = sh(s, f"input text {q(text)}")
    elif kind == "keyevent":
        out = sh(s, f"input keyevent {int(b.get('code', 0))}")
    else:
        return h.fail("unknown input kind")
    h.send_json({"out": out.strip()})


def api_native(h, s):
    preset = h.body_json().get("preset", "mirror")
    if not re.match(r"^[a-z]+$", preset):
        return h.fail("bad preset")
    subprocess.Popen([sys.executable, str(CLI), preset, "-s", s],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    h.send_json({"ok": True})


def api_connect(h, s):
    target = h.body_json().get("target", "")
    if not re.match(r"^[\w.-]+(:\d+)?$", target):
        return h.fail("bad address")
    rc, out = adb(["connect", target if ":" in target else target + ":5555"], timeout=15)
    h.send_json({"ok": "connected" in out and "cannot" not in out, "out": out.strip()})


def api_pair(h, s):
    b = h.body_json()
    rc, out = adb(["pair", b.get("addr", ""), b.get("code", "")], timeout=30)
    h.send_json({"ok": "Successfully paired" in out, "out": out.strip()})


def api_tcpip(h, s):
    ip = re.search(r"inet ([\d.]+)/", sh(s, "ip -f inet addr show wlan0"))
    if not ip:
        return h.fail("device is not on Wi-Fi")
    adb(["tcpip", "5555"], s)
    time.sleep(2)
    rc, out = adb(["connect", f"{ip.group(1)}:5555"], timeout=15)
    h.send_json({"ok": "connected" in out, "out": out.strip(), "serial": f"{ip.group(1)}:5555"})


def ws_screen(h, s):
    if h.headers.get("Upgrade", "").lower() != "websocket":
        return h.fail("websocket required")
    role = h.role()
    g = lambda k, d: h.qs.get(k, [d])[0]
    opts = {"max_size": int(g("max", "1024")), "bit_rate": int(float(g("bitrate", "4")) * 1_000_000),
            "max_fps": int(g("fps", "60")), "stay_awake": g("awake", "0") == "1"}
    restart = g("restart", "0") == "1" and role == "admin"
    try:
        session = get_session(s, opts, restart)
    except Exception as e:
        return h.fail(f"could not start mirroring: {e}", 500)
    ws = WebSocket(h)
    h.close_connection = True
    viewer = Viewer(session, role, video=g("video", "1") == "1")
    session.add(viewer)

    def reader():
        while True:
            frame = ws.recv()
            if frame is None:
                break
            op, data = frame
            if op == 2 and role == "admin":
                session.send_ctrl(data)
            elif op == 1:
                try:
                    msg = json.loads(data)
                except ValueError:
                    continue
                if msg.get("t") == "ping":
                    viewer.push_json({"t": "pong", "id": msg.get("id"),
                                      "bytes": session.bytes})
                elif msg.get("t") == "reset":
                    session.request_reset()
        viewer.q.put(None)

    threading.Thread(target=reader, daemon=True).start()
    try:
        while True:
            item = viewer.q.get()
            if item is None:
                break
            ws.send(item)
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        session.remove(viewer)


ROUTES = {
    ("GET", "/api/me"): api_me,
    ("GET", "/api/devices"): api_devices,
    ("GET", "/api/info"): api_info,
    ("GET", "/api/stats"): api_stats,
    ("GET", "/api/screenshot"): api_screenshot,
    ("GET", "/api/logcat"): api_logcat,
    ("POST", "/api/logcat/clear"): api_logcat_clear,
    ("GET", "/api/crashes"): api_bugreport_lite,
    ("POST", "/api/shell"): api_shell,
    ("GET", "/api/apps"): api_apps,
    ("GET", "/api/app"): api_app,
    ("POST", "/api/app/action"): api_app_action,
    ("GET", "/api/apk"): api_apk,
    ("POST", "/api/install"): api_install,
    ("GET", "/api/files"): api_files,
    ("GET", "/api/file"): api_file_get,
    ("POST", "/api/file"): api_file_put,
    ("POST", "/api/file/op"): api_file_op,
    ("GET", "/api/ui"): api_ui,
    ("GET", "/api/toggles"): api_toggles,
    ("POST", "/api/toggles"): api_toggle_set,
    ("GET", "/api/ports"): api_ports,
    ("POST", "/api/ports"): api_port_set,
    ("POST", "/api/intent"): api_intent,
    ("POST", "/api/broadcast"): api_broadcast,
    ("POST", "/api/input"): api_input,
    ("POST", "/api/native"): api_native,
    ("POST", "/api/connect"): api_connect,
    ("POST", "/api/pair"): api_pair,
    ("POST", "/api/tcpip"): api_tcpip,
    ("GET", "/ws/screen"): ws_screen,
}
VIEWER_ROUTES = {("GET", "/api/me"), ("GET", "/api/devices"), ("GET", "/api/info"),
                 ("GET", "/ws/screen")}


# ─────────────────────────────── startup ────────────────────────────────

def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def ensure_cert(ip):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    cert, key = CONFIG_DIR / "web-cert.pem", CONFIG_DIR / "web-key.pem"
    stamp = CONFIG_DIR / "web-cert.ip"
    if cert.exists() and key.exists() and stamp.exists() and stamp.read_text() == ip:
        return cert, key
    r = subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-keyout", str(key), "-out", str(cert), "-days", "825",
                        "-subj", "/CN=mahdicpy",
                        "-addext", f"subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost"],
                       capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("openssl failed: " + r.stderr.decode()[-200:])
    os.chmod(key, 0o600)
    stamp.write_text(ip)
    return cert, key


def load_tokens(fixed=None):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    f = CONFIG_DIR / "web-tokens.json"
    try:
        t = json.loads(f.read_text())
    except (OSError, ValueError):
        t = {}
    if fixed:
        t["admin"] = fixed
    t.setdefault("admin", secrets.token_urlsafe(18))
    t.setdefault("view", secrets.token_urlsafe(18))
    f.write_text(json.dumps(t))
    os.chmod(f, 0o600)
    return t


def panel_running(url):
    """True if a mahdicpy panel that accepts our admin token already listens on this port."""
    try:
        with urllib.request.urlopen(url.replace("/?t=", "/api/me?t="), timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # on Windows SO_REUSEADDR lets a second server steal a port that is in use
    allow_reuse_address = not sys.platform.startswith("win")


def main():
    ap = argparse.ArgumentParser(description="mahdicpy web panel")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--lan", action="store_true", help="share on the local network (HTTPS)")
    ap.add_argument("--http", action="store_true", help="with --lan: plain HTTP (no WebCodecs on remote)")
    ap.add_argument("--token", help="fixed admin token")
    ap.add_argument("--new-tokens", action="store_true", help="rotate access tokens")
    ap.add_argument("--open", action="store_true", help="open the browser")
    a = ap.parse_args()

    if a.new_tokens:
        (CONFIG_DIR / "web-tokens.json").unlink(missing_ok=True)
    tokens = load_tokens(a.token)
    Handler.tokens = {tokens["admin"]: "admin", tokens["view"]: "view"}

    host = "0.0.0.0" if a.lan else "127.0.0.1"
    local_url = f"http://127.0.0.1:{a.port}/?t={tokens['admin']}"
    if not a.lan and panel_running(local_url):
        # e.g. a second click on the "mahdicpy Panel" shortcut: reuse the running panel
        print(f"  mahdicpy web panel already running: {local_url}")
        if a.open:
            webbrowser.open(local_url)
        return
    try:
        httpd = Server((host, a.port), Handler)
    except OSError as e:
        sys.exit(f"  port {a.port} is busy ({e.strerror}); try: mahdicpy web --port {a.port + 1}")
    scheme = "http"
    ip = lan_ip() if a.lan else "127.0.0.1"
    if a.lan and not a.http:
        cert, key = ensure_cert(ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True, do_handshake_on_connect=False)
        scheme = "https"

    base = f"{scheme}://{ip}:{a.port}"
    local = f"{scheme}://{'127.0.0.1' if scheme == 'http' else 'localhost'}:{a.port}"
    httpd.share_urls = {"admin": f"{base}/?t={tokens['admin']}", "view": f"{base}/?t={tokens['view']}"}

    c = (lambda code: (lambda s: f"\033[{code}m{s}\033[0m")) if sys.stdout.isatty() else \
        (lambda code: (lambda s: s))
    sys.stdout.reconfigure(line_buffering=True)
    print(c("1;35")("\n  mahdicpy web panel ") + c("2")(f"v{VERSION} · scrcpy-server {SERVER_VERSION}\n"))
    print(f"  {c('36')('Open')}        {local}/?t={tokens['admin']}")
    if a.lan:
        print(f"  {c('36')('LAN (full)')}  {httpd.share_urls['admin']}")
        print(f"  {c('36')('LAN (view)')}  {httpd.share_urls['view']}  {c('2')('← view-only, safe to share')}")
        if scheme == "https":
            print(c("2")("  Self-signed certificate: browsers will warn once — choose 'Advanced › Proceed'."))
    print(c("2")("\n  Anyone with the full link can control your devices. Ctrl+C to stop.\n"))
    if a.open:
        webbrowser.open(f"{local}/?t={tokens['admin']}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        for sess in list(SESSIONS.values()):
            sess.close("server stopped")
        print("\n  bye 👋")


if __name__ == "__main__":
    main()
