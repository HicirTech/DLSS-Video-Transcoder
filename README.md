# Neural Render (neural-render-ts)

Apply NVIDIA DLSS to **images and video** on Windows — DLSS Super Resolution (upscaling),
DLSS Frame Generation (higher frame rate) and DLSS Neural Rendering ("DLSS 5", NGX feature 18) —
driven in-process from **Bun + TypeScript** through `bun:ffi` over Direct3D 12 and NVIDIA NGX,
with a **React + Material UI** web front end. DLSS runtimes are version-switchable
(DLSS-Swapper style).

![DLSS Neural Rendering styles — Original vs. Natural vs. Cinematic (100% crop)](docs/images/nr-style.png)

<sub>DLSS Neural Rendering (NGX feature 18) on a real photo — 100% crop: Original vs. the Natural and Cinematic styles.</sub>

![DLSS Neural Rendering parameter matrix — style vs. intensity](docs/images/nr-matrix.png)

<sub>Rows top→bottom: style Default / Natural / Cinematic. Columns left→right: intensity 0.0 / 0.5 /
1.0 (0.0 = original). NR model preset (0–3) is also adjustable, but it is an experimental,
content-dependent hint (per the reference) — Default is recommended and it showed no visible change on
this photo.</sub>

> **Status (2026-09-09).** Runs on the project's RTX 5090. The **web UI** covers the whole pipeline —
> SR upscaling, Neural Rendering, Frame Generation, DLSS version selection and browser upload — and the
> **command line** offers the same features for scripting. GPU-resident pipelining and RTX Video SR
> remain open; the [Feature status](#feature-status) table says what is verified vs. still gated. DLL
> presence alone is not proof a feature works — everything below was exercised on real hardware.

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
bun test            # the unit suite (pure logic, no GPU needed)
bun run cli <command> [options]   # the DLSS command line (see below)
```

Server environment variables: `PORT` (default **4080**), `NR_HOST` (default **127.0.0.1** — the API
has no authentication, so it binds loopback until you opt out), `NR_RUNTIME_DIR` (default
`<repo>/runtime`), `NR_APPDATA` (default `<repo>/logs`), `NODE_ENV=production` (disables Bun dev
bundling).

---

## Command line

`bun run cli <command> [args] [options]` (or `bun run src/cli.ts …`). Run `bun run cli help` for the
overview, or `bun run cli help <command>` / `<command> --help` for details — the in-code `COMMANDS`
spec is the source of truth for that help.

| Command | What it does |
| --- | --- |
| `probe` | Inspect GPU / driver / NGX core / `runtime/` and report which DLSS features are ready. Exits 0 only when neural rendering is ready, so a script can gate on it. |
| `sr <in.png> [out.png]` | **DLSS Super Resolution (feature 1)** — real upscaling of a PNG. The only true upscaler. |
| `nr <in.png> [out.png]` | **DLSS Neural Rendering (feature 18)** — enhance a PNG at the same size (no upscale). |
| `fg <in.mp4> [out.mp4]` | **DLSS Frame Generation (feature 11)** — interpolate a video to a higher frame rate. |
| `versions` | List every installed DLSS runtime DLL per feature (version / source / folder). |
| `forwarder` | (Re)generate the `nvngx.dll` shim NGX requires (auto-built by `sr`/`nr` when missing). |
| `help [command]` | Overview, or per-command help. |

Shared options, and which commands take them:

- `--adapter N` (GPU index from `probe`, default auto) — `probe`, `sr`, `nr`. Frame generation has
  no adapter selection: it runs in NVIDIA's `dlssg-worker.exe`, which always takes the default device.
- `--runtime DIR` (default `<repo>/runtime`) — `probe`, `sr`, `nr`, `fg`, `versions`. `forwarder`
  writes where `--out` points instead.

Every command rejects an option it does not declare, single dash included, and prints that
command's help. A declared flag whose value is missing, empty or another flag is a usage error too,
rather than a silent fall back to the default.

Key per-command options (defaults in parentheses):

- **`sr`** — `--factor N` (2; snapped to the nearest fixed DLSS mode, named as the NGX enum does:
  `1.00`=DLAA, `1.30`=UltraQuality, `1.50`=MaxQuality, `1.72`=Balanced, `2.00`=MaxPerf,
  `3.00`=UltraPerf — `sr` prints the mode and ratio it chose), `--preset NAME` (L;
  `Default`, `A`–`F`, `J`–`O` — which model each one selects belongs to the installed
  `nvngx_dlss.dll`, not to this tool), `--dlss-version VER` (bundled DLL; prefix match against
  `versions`).
- **`nr`** — `--intensity F` (1; overall strength 0–2, 1 = default, the effect tends to plateau past ~1),
  `--style N` (0; 0 = Default, 1 = Natural, 2 = Cinematic — strong, visible effect), `--local-tone F`
  (1; 0–2, 1 = neutral), `--local-structure F` (1; 0–2, 1 = neutral), `--skin-structure F` (-1;
  -1 = runtime default, otherwise 0–2, skin regions only), `--preset ID` (0; 0–3, experimental and
  content-dependent — Default recommended), `--auto-mask` / `--ui-correction` (both off).
- **`fg`** — `--fps RATE` (output frame rate: 23.976, 25, 29.97, 30, 50, 59.94, 60, 90, 119.88, 120,
  144, 165, 180, 240, 360, 480, or an exact `num/den`; default: source fps × `--multiplier`),
  `--multiplier N` (2; used when `--fps` is absent), `--engine MODE` (auto; `auto` = one native
  multi-frame DLSSG session when output ÷ source is an exact integer the runtime supports **and HAGS is
  on** (2× native needs no HAGS), otherwise a cascade of 2× stages chained in memory — 1 stage for 2×,
  2 for 4×, else 3 on an 8× grid — placing the nearest frame on each instant of the exact target clock;
  `native` / `cascade` force a path; the bundled dlssg-worker synthesises only 1 frame per interval, so
  3× and above run as a cascade and `auto` falls back to it automatically when a native multi-frame
  session is refused, HAGS or not), `--codec NAME` (default: GPU NVENC when available, else libx264),
  `--quality N` (encoder quality, CRF for CPU / CQ for NVENC, 0–51, lower = better, 20). The output
  always keeps the source duration (frame count = ⌈duration × rate⌉) and the original audio, and is
  verified after muxing.

## Web UI

Served by the Bun server at `/` (Bun bundles `web/index.html` directly — no separate build step).
For front-end-only work, `bun run web/mock-server.ts` serves the UI with mock data on
http://127.0.0.1:3080/, and appending `?mock=1` uses an in-browser mock client.

**What the UI does today:** run **image** and **video** jobs with three engines — `sr` (DLSS Super
Resolution upscaling to the chosen output size), `nr` (DLSS Neural Rendering enhancement), and
`bypass` (a plain GPU passthrough copy, for A/B comparison); **DLSS Frame Generation** for video
(pick any output rate from the 23.976–480 list and the path: auto / native / cascade); **DLSS DLL
version selection** per feature; **browser file upload** for the input; a live job queue with
WebSocket progress; a before/after compare view; a hardware/runtime **probe** panel; and encode
settings for video (codec incl. NVENC, quality 0–51 with 18 as default, container mp4/mkv/mov, audio).
Optical-flow motion can be enabled for video.

**Image tab** — choose an engine (SR upscale / Neural Rendering / bypass), a DLSS version, the output
size and the look controls:

![Neural Render — image job](docs/images/ui-image.png)

**Video tab** — DLSS Frame Generation, engine/motion, NVENC encoding and the neural-rendering controls:

![Neural Render — video job with frame generation](docs/images/ui-video.png)

**Probe tab** — hardware/runtime check (adapters, driver, NGX core, runtime DLLs, caller-shim self-test):

![Neural Render — hardware and runtime probe](docs/images/ui-probe.png)

**Notes / honest caveats:**

- The `nr` engine exposes the reference project's controls — **model preset**, **style**, **intensity**
  (0–2), **local tone** (0–2), **local structure** (0–2) and **skin structure** (-1–2, -1 = runtime
  default, skin only). Style and the strength sliders have a strong, visible effect; **model preset**
  (0–3) is an experimental, content-dependent hint (Default recommended); **global tone** is not
  applied by the current runtime.
- **DLSS version selection**: the picker defaults to the bundled DLL. Loading an alternate (not
  driver-matched) DLSS DLL can intermittently fail to initialise on newer drivers (a known
  DLSS-Swapper behaviour); the job then reports a clear error and you can retry or pick another.
- Uploaded files are stored server-side under `logs/uploads/`; the browser sends the file to the
  server, which runs entirely on your machine.

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
| `GET /api/file?path=<abs>` | raw bytes of a local file (previews; absolute path only). Unauthenticated: reachable only from loopback unless you set `NR_HOST` |
| `POST /api/upload` | multipart `file` upload → `{ path, name, size }` (201); `path` is the saved absolute path to use as job input |
| `WS /ws` | server→client `WsEvent` stream (`hello` / `job` / `log`) |

`JobRequest`: `{ kind: "image"|"video", input, output?, engine: "sr"|"nr"|"bypass",
motion: "none"|"flow", settings, scale, encode?, frameGen?: { targetFps?, multiplier?, engine? },
dllDir? }`. A submitted `output` must be absolute and inside the app-data folder, the runtime folder
or the input's own directory. Payload shapes are defined in
[`src/server/api-types.ts`](src/server/api-types.ts).

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

- The driver's NGX core `_nvngx.dll` is loaded from the installed driver, never from here.
- The shim exists because NGX rejects calls whose return address is not inside a module named
  `nvngx.dll`; every NGX call is routed through it.
- Feature 11 runs out-of-process in NVIDIA's `dlssg-worker.exe`; features 1 and 18 run in-process.

## Tests

`bun test` runs the whole suite — all pure logic, **no GPU required**: the PNG codec,
exact rational arithmetic, ffprobe interpretation (frame rates, rotation), encoder selection,
frame-generation planning and the nearest-timestamp writer, optical-flow math, the version catalog,
the forwarder shim, request validation, and the NGX parameter object. The `tests/diag-*.ts` and
`tests/run-*.ts` scripts are manual GPU harnesses (run individually with `bun run tests/<file>.ts`),
not part of the suite.

## Feature status

Verified against the source on 2026-09-10.

| Capability | CLI | Web UI | Notes |
| --- | --- | --- | --- |
| DLSS SR upscaling (feature 1) | ✅ `sr` | ✅ (`sr` engine) | real render/output split in image & video |
| DLSS Neural Rendering (feature 18) | ✅ `nr` (PNG) | ✅ (`nr` engine, image & video) | wired into the pipeline |
| DLSS Frame Generation (feature 11) | ✅ `fg` | ✅ (video tab) | native 2× per session; 3×/4× run as a cascade of 2× stages |
| DLSS version enumeration | ✅ `versions` | ✅ (`/api/catalog`) | shown in the version picker |
| DLSS version selection | ✅ SR (`sr --dlss-version`) | ✅ (sr/nr) | alternate DLLs may fail to init on newer drivers |
| Browser file upload | n/a | ✅ | POST /api/upload; stored under logs/uploads/ |
| NR look controls | ✅ (`nr`) | ✅ | style / intensity(0–2) / tone / structure apply strongly; preset exposed (experimental); global tone not applied |
| NVENC (GPU) video encode | ✅ if requested | ✅ if selected | frame-gen GPU-encodes by default |
| GPU optical flow (NVOFA) | ✅ (video/fg motion) | ✅ | hardware flow engine, ~5.7× faster than CPU, auto CPU fallback |
| RTX Video Super Resolution / TrueHDR | ❌ | ❌ | DLLs present but no code path uses them |

### Known limitations

- **Throughput.** Decode, DLSS and NVENC each run on their own thread, and video is encoded in-process
  on the GPU (ffmpeg only muxes the elementary stream with `-c:v copy`). For Neural Rendering the
  output additionally stays GPU-resident: DLSS renders into a D3D12 buffer shared with CUDA and NVENC
  encodes from that pointer, so no readback happens. _Measured on an RTX 5090 at 1080p, h264_nvenc:_
  neural rendering 79 fps single-thread → 163 fps threaded → **213 fps** GPU-resident; bypass
  transcode 108 → **228 fps**. The path is chosen automatically: NR + NVENC at even, in-cap dimensions
  takes the GPU-resident path (NVENC limits: H.264 ≤ 4096, HEVC ≤ 8192); other engines, CPU codecs and
  AV1 use the threaded or single-thread rawvideo path.
- **Input-side zero-copy is not done** — decoding still goes through an ffmpeg rawvideo pipe, which is
  now the ceiling. In-process NVDEC → CUDA would remove it.
- **RTX Video Super Resolution / TrueHDR** are not implemented (the DLLs under `runtime/rtx_video` are
  unused).
- Feature 18 does not consume motion vectors, so `nr` ignores the motion setting.

## License

This project's own code is provided as-is. NVIDIA DLSS runtime DLLs, ffmpeg, and ReShade are
**not** included and are subject to their own licenses; you must obtain and place them yourself.
