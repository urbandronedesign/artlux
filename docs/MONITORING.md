# Monitoring (Prometheus + Grafana)

ArtLux exposes a Prometheus metrics endpoint from its main process. The model is
**pull**: ArtLux only serializes a few numbers when a collector scrapes it
(default every 15s). Nothing is pushed, no extra thread or native code runs, and
Prometheus/Grafana live wherever you point them — for testing, on the same
machine (localhost).

## What's exposed

`GET http://127.0.0.1:9464/metrics`

| Metric | Type | Meaning |
| --- | --- | --- |
| `artlux_output_fps` | gauge | Output frames/sec from the native engine pacer |
| `artlux_output_pps` | gauge | Output packets/sec across all universes |
| `artlux_output_universes` | gauge | Active output universes |
| `artlux_output_up` | gauge | 1 when the engine is emitting, else 0 |
| `artlux_process_cpu_seconds_total` | counter | Process CPU time (rate it for %) |
| `artlux_process_resident_memory_bytes` | gauge | RSS memory |
| `artlux_nodejs_heap_size_used_bytes` | gauge | V8 heap used |
| `artlux_nodejs_eventloop_lag_*_seconds` | gauge | Event-loop lag (mean/p50/p99/…) |
| `artlux_nodejs_*`, `artlux_process_*` | various | Standard `prom-client` defaults |

All series carry `app="artlux"`, `version=`, and `mode="editor|broadcast|headless"`.

## Config (env vars)

| Var | Default | Notes |
| --- | --- | --- |
| `ARTLUX_METRICS` | (on) | Set to `0` to disable the endpoint entirely |
| `ARTLUX_METRICS_HOST` | `127.0.0.1` | Use `0.0.0.0` to allow scraping from Docker / another machine |
| `ARTLUX_METRICS_PORT` | `9464` | |

Loopback default means it is invisible on the network until you opt in.

## Quick local test (Docker — recommended)

Prometheus in a container reaches the host via `host.docker.internal`, so the
endpoint must be bound to all interfaces:

```powershell
# 1. Launch ArtLux with the endpoint reachable from the containers
$env:ARTLUX_METRICS_HOST = "0.0.0.0"; npm run dev
```

```powershell
# 2. In another terminal, bring up Prometheus + Grafana
cd monitoring
docker compose up -d
```

- Grafana: <http://localhost:3001>  (login `admin` / `admin`) → dashboard **ArtLux** is pre-loaded.
- Prometheus: <http://localhost:9090> → Status ▸ Targets should show `artlux` **UP**.

Tear down with `docker compose down` (add `-v` to also drop stored data).

## Quick local test (native binaries — no Docker)

Keeps everything on loopback; no `0.0.0.0` needed.

1. Launch ArtLux normally (`npm run dev`). Verify: open <http://127.0.0.1:9464/metrics>.
2. Download Prometheus, set its `prometheus.yml` target to `localhost:9464`
   (instead of `host.docker.internal:9464`), run it → <http://localhost:9090>.
3. Download Grafana, add a Prometheus datasource (`http://localhost:9090`),
   then import `monitoring/grafana/dashboards/artlux.json`.

## Viewing from another machine

Same as above but launch ArtLux with `ARTLUX_METRICS_HOST=0.0.0.0`, then point
Prometheus' scrape target at this machine's LAN IP (`<ip>:9464`). The collector
machine must be able to reach that IP:port. The output machine still runs nothing
but the lightweight endpoint.

## Cost

The endpoint does work only on scrape (serialize ~25 numbers → a few KB of text).
The one always-on cost is `prom-client`'s event-loop lag monitor (`perf_hooks`),
which is negligible. No change to the render/output hot paths.
