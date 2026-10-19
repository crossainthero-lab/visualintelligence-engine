"""Resource safety for the collector: single-instance lock, owned-process tracking, pressure guard.

Why this exists (evidence from the 2026-10-19 freezes, see docs/RESOURCES.md): the collector's visible Chromium used
GPU video decode/compositing; after 5-7 minutes the NVIDIA driver logged "dmaAllocMapping: can't alloc VA space"
followed by "RC watchdog: GPU is probably locked!" until reboot. Nothing here ever runs AI, and nothing kills a
process that this collector did not start (ownership = our private --user-data-dir, or our own child pids).
"""
from __future__ import annotations

import fcntl
import json
import os
import shutil
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .util import LOG

# ---------------------------------------------------------------------------------------------------
# Single-instance lock
# ---------------------------------------------------------------------------------------------------


class AlreadyRunning(RuntimeError):
    pass


class InstanceLock:
    """flock()-based: released by the kernel even on SIGKILL / power loss, so it can never go stale."""

    def __init__(self, state_dir: Path, name: str = "collector"):
        self.path = Path(state_dir) / f"{name}.lock"
        self.fd: int | None = None

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            holder = ""
            try:
                holder = os.read(fd, 200).decode(errors="replace").strip()
            except OSError:
                pass
            os.close(fd)
            raise AlreadyRunning(f"another collector is already running ({holder or 'pid unknown'}); "
                                 f"refusing to start a second one (lock: {self.path})")
        os.ftruncate(fd, 0)
        os.write(fd, f"pid={os.getpid()}\n".encode())
        self.fd = fd

    def release(self) -> None:
        if self.fd is not None:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_UN)
                os.close(self.fd)
            finally:
                self.fd = None

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *exc):
        self.release()


# ---------------------------------------------------------------------------------------------------
# /proc helpers (Linux). Everything degrades to "unknown" elsewhere.
# ---------------------------------------------------------------------------------------------------


def _read(path: str) -> str:
    try:
        with open(path, "rb") as f:
            return f.read().decode(errors="replace")
    except OSError:
        return ""


def list_pids() -> list[int]:
    try:
        return [int(n) for n in os.listdir("/proc") if n.isdigit()]
    except OSError:
        return []


def cmdline(pid: int) -> str:
    return _read(f"/proc/{pid}/cmdline").replace("\0", " ").strip()


def ppid(pid: int) -> int:
    st = _read(f"/proc/{pid}/stat")
    try:  # comm may contain spaces/parens: split after the last ')'
        return int(st.rsplit(")", 1)[1].split()[1])
    except (IndexError, ValueError):
        return 0


def descendants(root_pid: int) -> set[int]:
    children: dict[int, list[int]] = {}
    for p in list_pids():
        children.setdefault(ppid(p), []).append(p)
    out, stack = set(), [root_pid]
    while stack:
        for c in children.get(stack.pop(), []):
            if c not in out:
                out.add(c)
                stack.append(c)
    return out


def rss_mb(pid: int) -> float:
    for line in _read(f"/proc/{pid}/status").splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1]) / 1024
    return 0.0


def browser_pids(profile_dir: Path) -> list[int]:
    """Chromium processes launched with OUR private profile (--user-data-dir=<profile>). Nothing else matches."""
    needle = f"--user-data-dir={profile_dir}"
    me = os.getpid()
    return [p for p in list_pids() if p != me and needle in cmdline(p)]


def terminate_pids(pids: list[int], grace_s: float = 4.0) -> int:
    """SIGTERM, wait, then SIGKILL stragglers. Only ever called with pids we own."""
    for p in pids:
        try:
            os.kill(p, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
    deadline = time.monotonic() + grace_s
    alive = list(pids)
    while alive and time.monotonic() < deadline:
        alive = [p for p in alive if os.path.exists(f"/proc/{p}")]
        if alive:
            time.sleep(0.2)
    for p in alive:
        try:
            os.kill(p, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    return len(pids)


def reap_orphan_browsers(profile_dir: Path) -> int:
    """Chromium left behind by a previous crashed/killed collector (same private profile). Call only while holding
    the instance lock, i.e. when no live collector can own them."""
    pids = browser_pids(profile_dir)
    if pids:
        LOG.warning("Cleaning up %d orphaned browser process(es) from an earlier run (profile %s)", len(pids), profile_dir)
        terminate_pids(pids)
    return len(pids)


# ---------------------------------------------------------------------------------------------------
# Samples: memory, swap, PSI, load, disk, GPU
# ---------------------------------------------------------------------------------------------------


@dataclass
class Sample:
    mem_available_mb: float | None = None
    mem_total_mb: float | None = None
    swap_used_pct: float | None = None
    psi_mem_some_avg10: float | None = None
    load1: float | None = None
    cpus: int = os.cpu_count() or 1
    disk_free_gb: float | None = None
    gpu_used_pct: float | None = None
    gpu_name: str | None = None
    owned_gpu_mb: float | None = None
    owned_rss_mb: float | None = None
    owned_procs: int = 0
    gpu_kernel_errors: int = 0
    t: float = field(default_factory=time.time)

    def as_dict(self) -> dict:
        return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in self.__dict__.items()}


def meminfo() -> dict[str, int]:
    out = {}
    for line in _read("/proc/meminfo").splitlines():
        k, _, v = line.partition(":")
        try:
            out[k] = int(v.split()[0])
        except (ValueError, IndexError):
            pass
    return out


def psi_memory_some_avg10() -> float | None:
    for line in _read("/proc/pressure/memory").splitlines():
        if line.startswith("some"):
            for tok in line.split():
                if tok.startswith("avg10="):
                    return float(tok[6:])
    return None


def gpu_stats(owned: set[int] | None = None, timeout: float = 4.0) -> tuple[str | None, float | None, float | None]:
    """(name, used%, MB used by `owned` pids). Works with NVIDIA's nvidia-smi when present; otherwise tries the
    amdgpu sysfs counters; otherwise (None, None, None). Never raises, never touches a GPU compute context."""
    smi = shutil.which("nvidia-smi")
    if smi:
        try:
            r = subprocess.run([smi, "--query-gpu=name,memory.used,memory.total", "--format=csv,noheader,nounits"],
                               capture_output=True, text=True, timeout=timeout)
            if r.returncode == 0 and r.stdout.strip():
                name, used, total = [x.strip() for x in r.stdout.strip().splitlines()[0].split(",")]
                used_pct = 100.0 * float(used) / float(total) if float(total) else None
                owned_mb = _graphics_apps_mb(smi, owned, timeout) if owned is not None else None
                return name, used_pct, owned_mb
        except (subprocess.TimeoutExpired, OSError, ValueError):
            return None, None, None
    for card in sorted(Path("/sys/class/drm").glob("card[0-9]/device")):
        used, total = card / "mem_info_vram_used", card / "mem_info_vram_total"
        if used.is_file() and total.is_file():
            try:
                u, t = int(used.read_text()), int(total.read_text())
                return f"amdgpu:{card.parent.name}", 100.0 * u / t if t else None, None
            except (OSError, ValueError):
                continue
    return None, None, None


def _graphics_apps_mb(smi: str, owned: set[int], timeout: float) -> float:
    """Graphics-type clients (Chromium's GPU process is G, not C) from the plain nvidia-smi process table."""
    try:
        r = subprocess.run([smi], capture_output=True, text=True, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        return 0.0
    total = 0.0
    for line in r.stdout.splitlines():
        parts = line.replace("|", " ").split()
        # "    0   N/A  N/A      8167      G   /opt/google/chrome/chrome ...   184MiB"
        if len(parts) >= 6 and parts[3].isdigit() and parts[-1].endswith("MiB"):
            try:
                if int(parts[3]) in owned:
                    total += float(parts[-1][:-3])
            except ValueError:
                pass
    return total


def gpu_kernel_errors_since(since_epoch: float, timeout: float = 5.0) -> int:
    """Count NVIDIA driver trouble lines (VA-space exhaustion / RC watchdog) in the kernel log since `since_epoch`.
    Needs journal access (adm/systemd-journal group); returns 0 when unreadable."""
    if not shutil.which("journalctl"):
        return 0
    try:
        r = subprocess.run(["journalctl", "-k", "--no-pager", "-q", "--since", f"@{int(since_epoch)}", "-g",
                            r"NVRM.*(can't alloc VA space|GPU is probably locked|Xid)|NVRM: Xid"],
                           capture_output=True, text=True, timeout=timeout)
        return len([line for line in r.stdout.splitlines() if line.strip()]) if r.returncode in (0, 1) else 0
    except (subprocess.TimeoutExpired, OSError):
        return 0


def take_sample(owned: set[int] | None, path_for_disk: Path, check_gpu: bool = True) -> Sample:
    s = Sample()
    mi = meminfo()
    if "MemAvailable" in mi:
        s.mem_available_mb, s.mem_total_mb = mi["MemAvailable"] / 1024, mi.get("MemTotal", 0) / 1024
    if mi.get("SwapTotal"):
        s.swap_used_pct = 100.0 * (mi["SwapTotal"] - mi.get("SwapFree", 0)) / mi["SwapTotal"]
    s.psi_mem_some_avg10 = psi_memory_some_avg10()
    try:
        s.load1 = os.getloadavg()[0]
    except OSError:
        pass
    try:
        s.disk_free_gb = shutil.disk_usage(path_for_disk).free / 1e9
    except OSError:
        pass
    if owned:
        s.owned_procs = len(owned)
        s.owned_rss_mb = sum(rss_mb(p) for p in owned)
    if check_gpu:
        s.gpu_name, s.gpu_used_pct, s.owned_gpu_mb = gpu_stats(owned)
    return s


# ---------------------------------------------------------------------------------------------------
# Guard
# ---------------------------------------------------------------------------------------------------

LIMIT_DEFAULTS = {
    "enabled": True,
    "check_every_s": 5,
    "gpu_check_every_s": 20,
    "kernel_log_check_every_s": 30,
    "pause_mem_available_mb": 3000,     # soft: browsing waits until memory recovers
    "stop_mem_available_mb": 1200,      # hard: save everything and stop
    "pause_swap_used_pct": 40,
    "stop_swap_used_pct": 80,
    "pause_psi_mem_some": 15.0,         # % of last 10 s with tasks stalled on memory
    "stop_psi_mem_some": 40.0,
    "pause_load_per_cpu": 1.5,
    "pause_disk_free_gb": 6,
    "stop_disk_free_gb": 2,
    "pause_gpu_used_pct": 85,
    "recycle_owned_gpu_mb": 1200,       # restart OUR browser when it holds this much GPU memory
    "recycle_owned_rss_mb": 3500,       # ... or this much RAM
    "stop_on_gpu_driver_errors": True,  # NVRM VA-space / RC-watchdog lines appearing during this run
    "max_pause_s": 600,                 # paused longer than this => stop (nothing is lost; --resume continues)
}


@dataclass
class Verdict:
    action: str = "ok"          # ok | pause | recycle | stop
    reasons: list[str] = field(default_factory=list)


def evaluate(s: Sample, lim: dict) -> Verdict:
    """Pure function: Sample + limits -> Verdict. Unknown readings never trigger anything."""
    v = Verdict()

    def bump(action: str, why: str) -> None:
        order = {"ok": 0, "pause": 1, "recycle": 2, "stop": 3}
        v.reasons.append(why)
        if order[action] > order[v.action]:
            v.action = action

    if s.mem_available_mb is not None:
        if s.mem_available_mb < lim["stop_mem_available_mb"]:
            bump("stop", f"available RAM {s.mem_available_mb:.0f} MB < {lim['stop_mem_available_mb']}")
        elif s.mem_available_mb < lim["pause_mem_available_mb"]:
            bump("pause", f"available RAM {s.mem_available_mb:.0f} MB < {lim['pause_mem_available_mb']}")
    if s.swap_used_pct is not None:
        if s.swap_used_pct > lim["stop_swap_used_pct"]:
            bump("stop", f"swap {s.swap_used_pct:.0f}% used")
        elif s.swap_used_pct > lim["pause_swap_used_pct"]:
            bump("pause", f"swap {s.swap_used_pct:.0f}% used")
    if s.psi_mem_some_avg10 is not None:
        if s.psi_mem_some_avg10 > lim["stop_psi_mem_some"]:
            bump("stop", f"memory stall {s.psi_mem_some_avg10:.0f}%")
        elif s.psi_mem_some_avg10 > lim["pause_psi_mem_some"]:
            bump("pause", f"memory stall {s.psi_mem_some_avg10:.0f}%")
    if s.load1 is not None and s.load1 / max(1, s.cpus) > lim["pause_load_per_cpu"]:
        bump("pause", f"load {s.load1:.1f} on {s.cpus} CPUs")
    if s.disk_free_gb is not None:
        if s.disk_free_gb < lim["stop_disk_free_gb"]:
            bump("stop", f"disk free {s.disk_free_gb:.1f} GB < {lim['stop_disk_free_gb']}")
        elif s.disk_free_gb < lim["pause_disk_free_gb"]:
            bump("pause", f"disk free {s.disk_free_gb:.1f} GB < {lim['pause_disk_free_gb']}")
    if s.gpu_used_pct is not None and s.gpu_used_pct > lim["pause_gpu_used_pct"]:
        bump("pause", f"GPU memory {s.gpu_used_pct:.0f}% used")
    if s.owned_gpu_mb is not None and s.owned_gpu_mb > lim["recycle_owned_gpu_mb"]:
        bump("recycle", f"collector browser holds {s.owned_gpu_mb:.0f} MB GPU memory")
    if s.owned_rss_mb is not None and s.owned_rss_mb > lim["recycle_owned_rss_mb"]:
        bump("recycle", f"collector browser uses {s.owned_rss_mb:.0f} MB RAM")
    if lim.get("stop_on_gpu_driver_errors") and s.gpu_kernel_errors > 0:
        bump("stop", f"{s.gpu_kernel_errors} NVIDIA driver error line(s) in the kernel log during this run")
    return v


class ResourceGuard:
    """Background sampler. The collector polls `verdict` between steps; it never kills anything by itself."""

    def __init__(self, limits: dict, profile_dir: Path, disk_path: Path, history_path: Path | None = None):
        self.lim = {**LIMIT_DEFAULTS, **(limits or {})}
        self.profile_dir = Path(profile_dir)
        self.disk_path = Path(disk_path)
        self.history_path = history_path
        self.verdict = Verdict()
        self.last: Sample = Sample()
        self.peak = {"owned_rss_mb": 0.0, "owned_gpu_mb": 0.0, "min_mem_available_mb": None, "max_swap_pct": 0.0,
                     "min_disk_free_gb": None, "max_load1": 0.0}
        self.samples = 0
        self._stop = threading.Event()
        self._t: threading.Thread | None = None
        self._t_start = time.time()
        self._gpu_at = 0.0
        self._klog_at = 0.0
        self._klog_errors = 0
        self._gpu_cache: tuple = (None, None, None)
        self.paused_since: float | None = None

    def start(self) -> None:
        if not self.lim["enabled"]:
            return
        self._t_start = time.time()
        self._t = threading.Thread(target=self._run, name="resource-guard", daemon=True)
        self._t.start()

    def stop(self) -> None:
        self._stop.set()
        if self._t:
            self._t.join(3)

    def owned_pids(self) -> set[int]:
        return set(browser_pids(self.profile_dir))

    def _run(self) -> None:
        while not self._stop.wait(self.lim["check_every_s"]):
            try:
                self.sample_once()
            except Exception as e:  # noqa: BLE001 - the guard must never take the collector down
                LOG.debug("resource guard error: %s", e)

    def sample_once(self) -> Verdict:
        now = time.time()
        owned = self.owned_pids()
        do_gpu = now - self._gpu_at >= self.lim["gpu_check_every_s"]
        s = take_sample(owned, self.disk_path, check_gpu=False)
        if do_gpu:
            self._gpu_at = now
            self._gpu_cache = gpu_stats(owned)
        s.gpu_name, s.gpu_used_pct, s.owned_gpu_mb = self._gpu_cache
        if now - self._klog_at >= self.lim["kernel_log_check_every_s"]:
            self._klog_at = now
            self._klog_errors = gpu_kernel_errors_since(self._t_start)
        s.gpu_kernel_errors = self._klog_errors
        self.last, self.samples = s, self.samples + 1
        self._peaks(s)
        v = evaluate(s, self.lim)
        if v.action in ("pause", "recycle", "stop") and self.verdict.action == "ok":
            LOG.warning("Resource guard: %s (%s)", v.action, "; ".join(v.reasons))
        elif v.action == "ok" and self.verdict.action != "ok":
            LOG.info("Resource guard: pressure cleared")
        self.verdict = v
        if self.history_path and self.samples % 6 == 0:
            self._append_history(s)
        return v

    def _peaks(self, s: Sample) -> None:
        p = self.peak
        if s.owned_rss_mb is not None:
            p["owned_rss_mb"] = max(p["owned_rss_mb"], s.owned_rss_mb)
        if s.owned_gpu_mb is not None:
            p["owned_gpu_mb"] = max(p["owned_gpu_mb"], s.owned_gpu_mb)
        if s.mem_available_mb is not None:
            p["min_mem_available_mb"] = s.mem_available_mb if p["min_mem_available_mb"] is None else min(
                p["min_mem_available_mb"], s.mem_available_mb)
        if s.swap_used_pct is not None:
            p["max_swap_pct"] = max(p["max_swap_pct"], s.swap_used_pct)
        if s.disk_free_gb is not None:
            p["min_disk_free_gb"] = s.disk_free_gb if p["min_disk_free_gb"] is None else min(p["min_disk_free_gb"], s.disk_free_gb)
        if s.load1 is not None:
            p["max_load1"] = max(p["max_load1"], s.load1)

    def _append_history(self, s: Sample) -> None:
        try:
            with open(self.history_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(s.as_dict()) + "\n")
        except OSError:
            pass

    # ---- used by the collector loop -----------------------------------------------------------------
    def wait_if_paused(self, stop: threading.Event) -> str:
        """Block (politely) while under pressure. Returns 'ok' | 'recycle' | 'stop'."""
        while not stop.is_set():
            v = self.verdict
            if v.action == "ok":
                self.paused_since = None
                return "ok"
            if v.action in ("recycle", "stop"):
                self.paused_since = None
                return v.action
            self.paused_since = self.paused_since or time.monotonic()
            if time.monotonic() - self.paused_since > self.lim["max_pause_s"]:
                LOG.error("Under resource pressure for > %ds; stopping safely", self.lim["max_pause_s"])
                return "stop"
            stop.wait(2)
        return "ok"

    def summary(self) -> dict:
        return {"samples": self.samples, "peak": {k: (round(v, 1) if isinstance(v, float) else v) for k, v in self.peak.items()},
                "gpu": self.last.gpu_name, "limits": {k: self.lim[k] for k in (
                    "pause_mem_available_mb", "stop_mem_available_mb", "recycle_owned_gpu_mb", "recycle_owned_rss_mb")}}
