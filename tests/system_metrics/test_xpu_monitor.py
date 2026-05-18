"""Tests for XPUMonitor."""

import subprocess
from collections import defaultdict
from unittest import mock

import pytest

from mlflow.system_metrics.metrics.xpu_monitor import XPUMonitor, _avg, _parse_dump_line


# ── pure-function unit tests (no hardware) ───────────────────────────────────

class TestParseDumpLine:
    def test_aggregated_tile(self):
        row = _parse_dump_line("0, -1, 42.5, 95000, 8192, 32768, 2024-01-01", 0)
        assert row["tile"] == -1
        assert row["util_pct"] == 42.5
        assert row["power_mw"] == 95000.0
        assert row["mem_used_mib"] == 8192.0
        assert row["mem_total_mib"] == 32768.0

    def test_wrong_device_filtered(self):
        assert _parse_dump_line("1, -1, 50.0, 80000, 4096, 32768, 2024-01-01", 0) == {}

    def test_header_line_filtered(self):
        assert _parse_dump_line("Device, Tile, GPU Util (%),Power (mW)", 0) == {}

    def test_missing_fields_return_none(self):
        # Only 3 columns — power/mem missing
        row = _parse_dump_line("0, -1, 55.0", 0)
        assert row["util_pct"] == 55.0
        assert row["power_mw"] is None
        assert row["mem_used_mib"] is None

    def test_non_numeric_value_returns_none(self):
        row = _parse_dump_line("0, -1, N/A, 90000, 8192, 32768, ts", 0)
        assert row["util_pct"] is None
        assert row["power_mw"] == 90000.0


class TestAvg:
    def test_basic(self):
        assert _avg([1.0, 3.0]) == 2.0

    def test_ignores_none(self):
        assert _avg([1.0, None, 3.0]) == 2.0

    def test_all_none(self):
        assert _avg([None, None]) is None

    def test_empty(self):
        assert _avg([]) is None


# ── XPUMonitor with mocked xpu-smi ───────────────────────────────────────────

_DISCOVERY_OUTPUT = """\
+-----------+--------------------------------------------------------------------------------------+
| Device ID | Device Information                                                                   |
+-----------+--------------------------------------------------------------------------------------+
| 0         | Device Name: Intel(R) Data Center GPU Max 1550                                       |
|           | Vendor Name: Intel(R) Corporation                                                    |
+-----------+--------------------------------------------------------------------------------------+
| 1         | Device Name: Intel(R) Data Center GPU Max 1550                                       |
|           | Vendor Name: Intel(R) Corporation                                                    |
+-----------+--------------------------------------------------------------------------------------+
"""

_DUMP_DEV0 = """\
Device, Tile, GPU Utilization (%), Power (mW), Memory Used (MiB), Memory Physical Size (MiB), Timestamp
0, -1, 35.0, 120000, 10240, 32768, 2024-01-01T00:00:00.000
"""

_DUMP_DEV1 = """\
Device, Tile, GPU Utilization (%), Power (mW), Memory Used (MiB), Memory Physical Size (MiB), Timestamp
1, -1, 60.0, 200000, 16384, 32768, 2024-01-01T00:00:00.000
"""


def _make_run(stdout: str, returncode: int = 0):
    r = mock.MagicMock()
    r.stdout = stdout
    r.returncode = returncode
    r.stderr = ""
    return r


@pytest.fixture()
def mock_xpu_smi(monkeypatch):
    """Patch subprocess.run so xpu-smi calls return canned output."""
    monkeypatch.setattr("shutil.which", lambda name: "/usr/bin/xpu-smi" if name == "xpu-smi" else None)

    def _fake_run(cmd, **kwargs):
        if "discovery" in cmd:
            return _make_run(_DISCOVERY_OUTPUT)
        # dump -d N ...
        d_idx = cmd.index("-d") + 1
        dev = int(cmd[d_idx])
        return _make_run(_DUMP_DEV0 if dev == 0 else _DUMP_DEV1)

    monkeypatch.setattr(subprocess, "run", _fake_run)
    return None


class TestXPUMonitorWithMock:
    def test_init_detects_two_devices(self, mock_xpu_smi):
        m = XPUMonitor()
        assert m._backend == "xpu-smi"
        assert m._num_gpus == 2

    def test_collect_metrics_device0(self, mock_xpu_smi):
        m = XPUMonitor()
        m.collect_metrics()
        assert m._metrics["gpu_0_utilization_percentage"] == [35.0]
        assert m._metrics["gpu_0_power_usage_watts"] == [120.0]
        assert m._metrics["gpu_0_memory_usage_megabytes"] == [10240.0]
        assert pytest.approx(m._metrics["gpu_0_memory_usage_percentage"][0], abs=0.2) == 31.3

    def test_collect_metrics_device1(self, mock_xpu_smi):
        m = XPUMonitor()
        m.collect_metrics()
        assert m._metrics["gpu_1_utilization_percentage"] == [60.0]
        assert m._metrics["gpu_1_power_usage_watts"] == [200.0]

    def test_aggregate_averages_samples(self, mock_xpu_smi):
        m = XPUMonitor()
        m.collect_metrics()
        m.collect_metrics()
        agg = m.aggregate_metrics()
        assert agg["gpu_0_utilization_percentage"] == 35.0
        assert agg["gpu_1_utilization_percentage"] == 60.0

    def test_clear_metrics(self, mock_xpu_smi):
        m = XPUMonitor()
        m.collect_metrics()
        m.clear_metrics()
        assert len(m._metrics) == 0


# ── Integration: XPUMonitor plugs into SystemMetricsMonitor ──────────────────

def test_system_metrics_monitor_wires_xpu(mock_xpu_smi, monkeypatch):
    """XPUMonitor is picked up by SystemMetricsMonitor when NVIDIA/AMD are absent."""
    # Make GPUMonitor and ROCMMonitor always fail
    monkeypatch.setattr(
        "mlflow.system_metrics.system_metrics_monitor.GPUMonitor",
        mock.MagicMock(side_effect=RuntimeError("no nvidia")),
    )
    monkeypatch.setattr(
        "mlflow.system_metrics.system_metrics_monitor.ROCMMonitor",
        mock.MagicMock(side_effect=RuntimeError("no amd")),
    )

    from mlflow.system_metrics.system_metrics_monitor import SystemMetricsMonitor

    monitor_types = [type(m).__name__ for m in SystemMetricsMonitor.__new__(SystemMetricsMonitor).monitors
                     ] if False else None  # can't call __init__ without run_id

    # Verify the _initialize_gpu_monitor path reaches XPUMonitor
    with mock.patch("mlflow.tracking.get_tracking_uri", return_value="http://localhost"):
        with mock.patch("mlflow.utils.autologging_utils.BatchMetricsLogger"):
            sm = SystemMetricsMonitor.__new__(SystemMetricsMonitor)
            gpu_mon = sm._initialize_gpu_monitor()

    assert isinstance(gpu_mon, XPUMonitor)
