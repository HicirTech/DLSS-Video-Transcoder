# Neural Render (neural-render-ts)

Apply NVIDIA DLSS to **images and video** on Windows — DLSS Super Resolution (upscaling),
DLSS Frame Generation (higher frame rate) and DLSS Neural Rendering ("DLSS 5", NGX feature 18) —
driven in-process from **Bun + TypeScript** through `bun:ffi` over Direct3D 12 and NVIDIA NGX,
with a **React + Material UI** web front end. DLSS runtimes are version-switchable
(DLSS-Swapper style).

> **Status (2026-09-09).** The **command line** is the full-capability surface and is the
> recommended way to use every DLSS feature today. The **web UI** currently runs a useful subset
> (see [Web UI](#web-ui) for exactly what it does and does not do). Several capabilities are
> CLI-only, and some UI controls are not yet wired to the engine — this is documented honestly in
> [Feature status](#feature-status) rather than hidden. Anything marked "needs an RTX GPU to
> verify" has been exercised on the project's RTX 5090 where noted; DLL presence alone is not proof
> a feature works.

---

## Requirements

- **Windows 11**, an **NVIDIA RTX GPU** (developed and tested on an RTX 5090) with a current driver
  (NGX core `_nvngx.dll` is loaded from the driver; not shipped here).
- **[Bun](https://bun.sh)** (project uses `@types/bun` ^1.4). Native access is via `bun:ffi`.
- **NVIDIA DLSS runtime DLLs** placed under `runtime/` (see [Runtime folder](#runtime-folder)).
  These are **not** redistributed in this repo — you supply your own licensed copies.
- **ffmpeg / ffprobe** for video (bundled under `runtime/ffmpeg/bin`, or on `PATH`, or via
  `FFMPEG_PATH` / `FFPROBE_PATH`).

## Install & run

```bash
bun install
```

Place the required DLSS DLLs under `runtime/` (see below), then start the server (web UI + API):

```bash
bun run dev
```

Open **http://localhost:4080/**. Other scripts:

```bash
bun run typecheck   # tsc --noEmit
bun test            # 96 unit-test cases (pure logic, no GPU needed)
bun run cli <command> [options]   # the DLSS command line (see below)
```

Server environment variables: `PORT` (default **4080**), `NR_RUNTIME_DIR` (default `<repo>/runtime`),
`NR_APPDATA` (default `<repo>/logs`), `NODE_ENV=production` (disables Bun dev bundling).

---

## Command line

`bun run cli <command> [args] [options]` (or `bun run src/cli.ts …`). Run `bun run cli help` for the
overview, or `bun run cli help <command>` / `<command> --help` for details — the CLI is
self-documenting and the in-code `COMMANDS` spec is its source of truth.

| Command | What it does |
| --- | --- |
| `probe` | Inspect GPU / driver / NGX core / `runtime/` and report which DLSS features are ready. |
| `sr <in.png> [out.png]` | **DLSS Super Resolution (feature 1)** — real upscaling of a PNG. The only true upscaler. |
| `nr <in.png> [out.png]` | **DLSS Neural Rendering (feature 18)** — enhance a PNG at the same size (no upscale). |
| `fg <in.mp4> [out.mp4]` | **DLSS Frame Generation (feature 11)** — interpolate a video to a higher frame rate. |
| `versions` | List every installed DLSS runtime DLL per feature (version / source / folder). |
| `forwarder` | (Re)generate the `nvngx.dll` shim NGX requires (auto-built by `sr`/`nr` when missing). |
| `help [command]` | Overview, or per-command help. |

Common options: `--adapter N` (GPU index from `probe`, default auto), `--runtime DIR`
(default `<repo>/runtime`).

Key per-command options (defaults in parentheses):

- **`sr`** — `--factor N` (2; snapped to the nearest fixed DLSS mode: `1.0`=DLAA, `1.3`=Ultra Quality,
  `1.5`=Quality, `1.72`=Balanced, `2.0`=Performance, `3.0`=Ultra Performance), `--preset NAME` (L;
  `A`–`F` are older CNN models, `J`–`O` are transformer models), `--dlss-version VER` (bundled DLL;
  prefix match against `versions`).
- **`nr`** — `--intensity F` (1; typical 0–2, 1 = neutral), `--preset ID` (0 = runtime default, or
  `10`/`11`/`12`/`13` = transformer models J/K/L/M), `--local-tone F` (1), `--local-structure F` (1).
- **`fg`** — `--multiplier N` (2; reliable at 2×, up to the GPU/runtime maximum, e.g. 3×/4× on
  RTX 50), `--quality N` (libx264 CRF 0–51, lower = better, 20).

## Web UI

Served by the Bun server at `/` (Bun bundles `web/index.html` directly — no separate build step).
For front-end-only work, `bun run web/mock-server.ts` serves the UI with mock data on
http://127.0.0.1:3080/, and appending `?mock=1` uses an in-browser mock client.

**What the UI does today:** run **image** and **video** jobs with two engines — `bypass`
(a plain GPU passthrough copy, for A/B comparison) and `nr`; a live job queue with WebSocket
progress; a before/after compare view; a hardware/runtime **probe** panel; and encode settings
(codec, quality, container, audio) for video. Optical-flow motion can be enabled for video.

**Honest limitations (being addressed):**

- The UI `nr` engine currently runs **DLSS Super Resolution at DLAA (feature 1, same size)**, i.e.
  neural anti-aliasing — **not** feature 18 neural rendering. Feature 18 is CLI-only for now.
- Because of that, the **NR look sliders** (intensity, style, tone, structure, …) are collected but
  **not yet applied** by the running server engine (only `warmupFrames`, and only for image jobs).
- UI "output size" (factor/size) resizes with CPU/ffmpeg scaling followed by DLAA — it is **not**
  a DLSS SR upscale. Real DLSS upscaling is the `sr` command.
- **Frame Generation**, **DLSS version selection**, and **feature 18** are **CLI-only**.
- Input is a **server-side absolute path** (no browser upload yet), so the UI is effectively
  local-host only today.

## HTTP API

All JSON unless noted. Base is same-origin.

| Method & path | Returns |
| --- | --- |
| `GET /api/probe` | `ProbeReport` (runs the hardware/runtime probe; can take seconds) |
| `GET /api/runtime` | `ProbeReport["runtime"]` |
| `GET /api/tools` | `ToolsReport` (ffmpeg / ffprobe / NVENC availability) |
| `GET /api/catalog` | Runtime DLL catalog (per-feature versions) |
| `GET /api/settings/defaults` | `{ settings, scale, encode }` defaults |
| `GET /api/jobs` · `POST /api/jobs` | list jobs · submit a `JobRequest` → `JobStatus` (201) |
| `GET /api/jobs/:id` · `POST /api/jobs/:id/cancel` | one job · cancel it |
| `GET /api/file?path=<abs>` | raw bytes of a local file (previews; absolute path only) |
| `WS /ws` | server→client `WsEvent` stream (`hello` / `job` / `log`) |

`JobRequest`: `{ kind: "image"|"video", input, output?, engine: "bypass"|"nr", motion: "none"|"flow",
settings: NrSettings, scale: ScaleSettings, encode? }`. Payload shapes are defined in
[`src/server/api-types.ts`](src/server/api-types.ts).

## Architecture

- **In-process NGX via `bun:ffi`.** `src/native/` binds D3D12/DXGI/PE/Win32; `src/ngx/` drives the
  NGX API. NGX rejects calls whose return address is not inside a module named `nvngx.dll`, so the
  project generates a tiny x64 shim DLL (`runtime/caller/nvngx.dll`, `src/ngx/forwarder.ts`) and
  routes every NGX call through it.
- **Feature 1 (SR)** uses the driver core plus `nvngx_dlss.dll`; **feature 18 (NR)** loads the
  standalone `nvngx_dlssnr.dll` directly with a project-owned parameter object; **feature 11 (Frame
  Generation)** runs out-of-process via NVIDIA's `dlssg-worker.exe` over a small binary protocol.
- **Version switching** = re-init NGX with the chosen DLL on its search path
  (`src/ngx/runtime-catalog.ts`, PE version parsing in `src/native/version-info.ts`).
- **PNG codec** (`src/codec/png.ts`) is hand-written and uses `node:zlib` for (de)compression
  (Bun's built-in zlib is avoided — it produced/consumed corrupt streams).
- **Pipeline** (`src/pipeline/`): ffmpeg decode → per-frame engine → ffmpeg encode; optical-flow
  motion estimation; a job worker; the Bun server (`src/server/`) exposes it over HTTP + WebSocket.

## Runtime folder

`runtime/` is git-ignored (except its `README.md`); you place licensed NVIDIA binaries yourself.

```
runtime/
  caller/nvngx.dll        generated x64 shim (auto-built)
  dlss/nvngx_dlss.dll     DLSS Super Resolution   (feature 1)   [required]
  dlssg/nvngx_dlssg.dll   DLSS Frame Generation   (feature 11)  [required]
  dlssg/dlssg-worker.exe  frame-gen worker process
  dlssnr/nvngx_dlssnr.dll DLSS Neural Rendering   (feature 18)  [required]
  ffmpeg/bin/{ffmpeg,ffprobe}.exe
  host/, rtx_video/       out-of-process host / RTX Video assets (see status)
```

The driver's NGX core `_nvngx.dll` is loaded from the installed driver, never from here.

## Tests

`bun test` runs **96 unit-test cases** across 6 files — all pure logic, **no GPU required**: the
PNG codec, ffmpeg/NVENC/NUT planning math, optical-flow math, the version catalog, the forwarder
shim, and the NGX parameter object. The `tests/diag-*.ts` and `tests/run-*.ts` scripts are manual
GPU harnesses (run individually with `bun run tests/<file>.ts`), not part of the suite.

## Feature status

Verified against the source on 2026-09-09.

| Capability | CLI | Web UI | Notes |
| --- | --- | --- | --- |
| DLSS SR upscaling (feature 1) | ✅ `sr` | ❌ | UI resize is bilinear/lanczos + DLAA, not DLSS SR |
| DLSS SR at DLAA (same size) | ✅ (via `sr --factor 1`) | ✅ (`nr` engine) | UI `nr` is really SR-DLAA |
| DLSS Neural Rendering (feature 18) | ✅ `nr` (PNG) | ❌ | not wired into pipeline/server yet |
| DLSS Frame Generation (feature 11) | ✅ `fg` (incl. 3×/4× on RTX 50) | ❌ | no cascade needed — native multi-frame |
| DLSS version enumeration | ✅ `versions` | ❌ (`/api/catalog` exists) | UI has no picker yet |
| DLSS version selection | ✅ SR (`sr --dlss-version`) | ❌ | FG/NR selection not wired |
| NR look controls (intensity/tone/…) | ✅ (`nr`) | ⚠️ collected but ignored | server engine ignores them |
| NVENC (GPU) video encode | ⚠️ if requested | ⚠️ if selected | not auto-selected; frame-gen is CPU-only |
| RTX Video Super Resolution / TrueHDR | ❌ | ❌ | DLLs present but no code path uses them |

### Known limitations / roadmap

- **Performance (GPU under-utilized).** Frames make a synchronous CPU→GPU→CPU round trip every
  frame with no GPU residency or pipelining, optical flow is single-threaded TypeScript, and the
  default/only video-and-frame-gen encoder is CPU libx264. The NVENC + rational-PTS module
  (`src/pipeline/nut.ts`) is written but not yet wired in. Planned: auto-select NVENC with CPU
  fallback, remove per-frame pipe flushes, keep frames GPU-resident, and a native optical-flow
  backend.
- **Wire feature 18 into the pipeline/server** so the NR look controls actually take effect.
- **Expose SR upscaling, frame generation and version selection in the UI**, and add browser upload.
- **RTX Video Super Resolution** is not implemented (the DLLs under `runtime/rtx_video` are unused).

## License

This project's own code is provided as-is. NVIDIA DLSS runtime DLLs, ffmpeg, and ReShade are
**not** included and are subject to their own licenses; you must obtain and place them yourself.
