"""Class for monitoring Intel XPU (PVC / Arc) stats.

Backends (tried in order):
1. ``xpu-smi`` subprocess — always available on Aurora/Sunspot; gives
   utilization, memory, and power per device.
2. ``intel_extension_for_pytorch`` (IPEX) — gives memory only; used when
   xpu-smi is absent (e.g., local dev machine with Intel GPU).

Metric names match the GPUMonitor / ROCMMonitor pattern so that downstream
dashboards and XPU support can share the same chart templates:
  gpu_N_utilization_percentage
  gpu_N_memory_usage_percentage
  gpu_N_memory_usage_megabytes
  gpu_N_power_usage_watts
"""

import logging
import shutil
import subprocess
import sys
from collections import defaultdict

from mlflow.system_metrics.metrics.base_metrics_monitor import BaseMetricsMonitor

_logger = logging.getLogger(__name__)

# xpu-smi metric type IDs — validated on xpu-smi 1.2.42 (Sunspot / Aurora)
# Full list via: xpu-smi dump --help
# Dump CSV format: Timestamp, DeviceId, <metrics in requested order>
_XSI_GPU_UTIL = 0     # GPU Utilization (%)
_XSI_POWER    = 1     # GPU Power (W)         ← NOT metric 5
_XSI_MEM_UTIL = 5     # GPU Memory Utilization (%)
_XSI_MEM_USED = 18    # GPU Memory Used (MiB)

_METRIC_IDS = f"{_XSI_GPU_UTIL},{_XSI_POWER},{_XSI_MEM_UTIL},{_XSI_MEM_USED}"
# CSV columns after Timestamp, DeviceId:
#   col2 = GPU Util (%)   col3 = Power (W)   col4 = Mem Util (%)   col5 = Mem Used (MiB)


def _xpu_smi(*args, timeout=5):
    """Run xpu-smi and return stdout, or raise on failure."""
    result = subprocess.run(
        ["xpu-smi", *args],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(f"xpu-smi exited {result.returncode}: {result.stderr.strip()}")
    return result.stdout


def _discover_devices():
    """Return number of XPU devices via ``xpu-smi discovery``.

    Handles two common output formats:
    - Table rows: ``| 0         | Device Name: ... |``
    - Plain rows: ``Device  0\\n  ...``
    """
    out = _xpu_smi("discovery", timeout=10)
    count = 0
    for line in out.splitlines():
        stripped = line.strip()
        # Table format: "| 0   | Device Name: ..."
        if stripped.startswith("|"):
            cols = [c.strip() for c in stripped.split("|") if c.strip()]
            if cols and cols[0].isdigit():
                count += 1
                continue
        # Plain format: "Device  0" or "Device ID: 0"
        if stripped.lower().startswith("device") and any(c.isdigit() for c in stripped):
            parts = stripped.split()
            if len(parts) >= 2 and parts[-1].isdigit():
                count += 1
    return max(count, 1) if count else 1


def _parse_dump_line(line: str, device_id: int) -> dict:
    """
    Parse one CSV line from ``xpu-smi dump -d N -m METRICS -n 1``.

    xpu-smi 1.2.42+ (Sunspot / Aurora) format — timestamp-first:
      Timestamp, DeviceId, col0_metric, col1_metric, ...
      14:06:57.917,    0, 0.00, 78.17, ...

    Older hypothetical format — device-first (kept for compatibility):
      DeviceId, TileId, col0_metric, ..., Timestamp
      0, -1, 42.0, 8192, ..., 2024-...

    Column offsets for metrics depend on the detected format.
    Returns dict with keys matching _METRIC_IDS order:
      metrics[0] → util_pct
      metrics[1] → mem_util_pct  (xpu-smi metric 5)
      metrics[2] → mem_used_mib  (xpu-smi metric 18)
    """
    parts = [p.strip() for p in line.split(",")]
    if not parts:
        return {}

    def _float(idx):
        try:
            return float(parts[idx])
        except (IndexError, ValueError):
            return None

    col0 = parts[0]
    # New format: col0 is a timestamp containing ":" (e.g. "14:06:57.917")
    # With _METRIC_IDS = "0,1,5,18":
    #   col2 = GPU Util(%)  col3 = Power(W)  col4 = Mem Util(%)  col5 = Mem Used(MiB)
    if ":" in col0:
        if len(parts) < 3:
            return {}
        try:
            dev = int(parts[1])
        except ValueError:
            return {}  # header row — skip
        if dev != device_id:
            return {}
        return {
            "tile": -1,
            "util_pct":     _float(2),
            "power_w":      _float(3),   # watts directly (not mW)
            "mem_util_pct": _float(4),
            "mem_used_mib": _float(5),
            "power_mw":     None,
            "mem_total_mib": None,
        }

    # Old format: col0 is DeviceId (integer)
    if not col0.lstrip("-").isdigit():
        return {}
    try:
        if int(col0) != device_id:
            return {}
    except ValueError:
        return {}
    tile = int(parts[1]) if len(parts) > 1 else -1
    return {
        "tile": tile,
        "util_pct":     _float(2),
        "power_mw":     _float(3),
        "mem_used_mib": _float(4),
        "mem_total_mib": _float(5),
        "mem_util_pct": None,
    }


class XPUMonitor(BaseMetricsMonitor):
    """Monitor Intel XPU (PVC / Arc) metrics.

    Requires either ``xpu-smi`` (Aurora / Sunspot) or
    ``intel_extension_for_pytorch`` (IPEX) to be available.
    """

    def __init__(self):
        self._backend = None
        self._num_gpus = 0

        if shutil.which("xpu-smi"):
            self._init_xpu_smi()
        else:
            self._init_ipex()

        if self._backend is None:
            raise RuntimeError(
                "No Intel XPU backend found. Install xpu-smi (Aurora/Sunspot) "
                "or intel_extension_for_pytorch."
            )

        super().__init__()

    # ── backend initialisation ────────────────────────────────────────────────

    def _init_xpu_smi(self):
        try:
            self._num_gpus = _discover_devices()
            # Warm-up probe to verify metrics work
            _xpu_smi("dump", "-d", "0", "-m", _METRIC_IDS, "-n", "1", timeout=15)
            self._backend = "xpu-smi"
            _logger.debug(f"XPUMonitor: xpu-smi backend, {self._num_gpus} device(s)")
        except Exception as e:
            _logger.debug(f"XPUMonitor: xpu-smi init failed: {e}")

    def _init_ipex(self):
        try:
            import intel_extension_for_pytorch as ipex  # noqa: F401
            import torch

            if not torch.xpu.is_available():
                raise RuntimeError("torch.xpu not available")
            self._num_gpus = torch.xpu.device_count()
            self._backend = "ipex"
            _logger.debug(f"XPUMonitor: IPEX backend, {self._num_gpus} device(s)")
        except Exception as e:
            _logger.debug(f"XPUMonitor: IPEX init failed: {e}")

    # ── metric collection ─────────────────────────────────────────────────────

    def collect_metrics(self):
        if self._backend == "xpu-smi":
            self._collect_xpu_smi()
        elif self._backend == "ipex":
            self._collect_ipex()

    def _collect_xpu_smi(self):
        for dev_id in range(self._num_gpus):
            try:
                out = _xpu_smi("dump", "-d", str(dev_id), "-m", _METRIC_IDS, "-n", "1")
            except Exception as e:
                _logger.warning(f"xpu-smi dump failed for device {dev_id}: {e}")
                continue

            # Collect all parsed rows; prefer tile=-1 (device aggregate)
            rows = []
            for line in out.splitlines():
                parsed = _parse_dump_line(line, dev_id)
                if parsed:
                    rows.append(parsed)

            if not rows:
                continue

            # Use tile=-1 row when present; otherwise average across all rows
            agg_rows = [r for r in rows if r.get("tile") == -1]
            row = agg_rows[0] if agg_rows else {
                "util_pct":     _avg(r.get("util_pct")     for r in rows),
                "mem_util_pct": _avg(r.get("mem_util_pct") for r in rows),
                "mem_used_mib": _avg(r.get("mem_used_mib") for r in rows),
                "power_mw":     _avg(r.get("power_mw")     for r in rows),
                "mem_total_mib": None,
            }

            if row.get("util_pct") is not None:
                self._metrics[f"gpu_{dev_id}_utilization_percentage"].append(row["util_pct"])
            if row.get("mem_util_pct") is not None:
                self._metrics[f"gpu_{dev_id}_memory_usage_percentage"].append(row["mem_util_pct"])
            if row.get("mem_used_mib") is not None:
                self._metrics[f"gpu_{dev_id}_memory_usage_megabytes"].append(row["mem_used_mib"])
            # power_w = watts (new format); power_mw = milliwatts (old format)
            if row.get("power_w") is not None:
                self._metrics[f"gpu_{dev_id}_power_usage_watts"].append(row["power_w"])
            elif row.get("power_mw") is not None:
                self._metrics[f"gpu_{dev_id}_power_usage_watts"].append(row["power_mw"] / 1000)

    def _collect_ipex(self):
        import torch

        for dev_id in range(self._num_gpus):
            device = torch.device(f"xpu:{dev_id}")
            try:
                mem_used = torch.xpu.memory_allocated(device) / 1e6  # bytes → MiB
                mem_total = torch.xpu.get_device_properties(device).total_memory / 1e6
                self._metrics[f"gpu_{dev_id}_memory_usage_megabytes"].append(mem_used)
                if mem_total > 0:
                    self._metrics[f"gpu_{dev_id}_memory_usage_percentage"].append(
                        round(mem_used / mem_total * 100, 1)
                    )
            except Exception as e:
                _logger.warning(f"IPEX memory query failed for device {dev_id}: {e}")

    def aggregate_metrics(self):
        return {k: round(sum(v) / len(v), 1) for k, v in self._metrics.items() if v}


def _avg(iterable):
    vals = [v for v in iterable if v is not None]
    return round(sum(vals) / len(vals), 2) if vals else None
