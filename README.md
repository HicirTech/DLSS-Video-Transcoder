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
1.0 (0.0 = original).</sub>

> **Status.** Runs on the project's RTX 5090. The **web UI** covers the whole pipeline — SR
> upscaling, Neural Rendering, Frame Generation, DLSS version selection and browser upload — and the
> **command line** offers the same features for scripting. See [Feature status](#feature-status) below.

---

## Requirements

- **Windows 11**, an **NVIDIA RTX GPU** (developed on an RTX 5090) with a current driver.
- **[Bun](https://bun.sh)** (project uses `@types/bun` ^1.4).
- **NVIDIA DLSS runtime DLLs** placed under `runtime/` (see [Runtime folder](#runtime-folder)).
  These are **not** redistributed — you supply your own licensed copies.
- **ffmpeg / ffprobe** for video (bundled under `runtime/ffmpeg/bin`, on `PATH`, or via env vars).

## Install & run

```bash
bun install
bun run dev              # start server at http://localhost:4080
bun run typecheck        # tsc --noEmit
bun test                 # unit suite (pure logic, no GPU)
bun run cli <command>    # see CLI reference below
```

Server env vars: `PORT` (default **4080**), `NR_HOST` (default **127.0.0.1**, loopback only),
`NR_RUNTIME_DIR`, `NR_APPDATA`, `NODE_ENV=production`.

---

## Command line

| Command | What it does |
| --- | --- |
| `probe` | Inspect GPU / driver / NGX core / `runtime/`; exits 0 only when neural rendering is ready. |
| `sr <in.png> [out.png]` | **DLSS Super Resolution (feature 1)** — real PNG upscaling. |
| `nr <in.png> [out.png]` | **DLSS Neural Rendering (feature 18)** — enhance a PNG at the same size. |
| `fg <in.mp4> [out.mp4]` | **DLSS Frame Generation (feature 11)** — interpolate to higher frame rate. |
| `versions` | List every installed DLSS runtime DLL per feature. |
| `forwarder` | (Re)generate the `nvngx.dll` shim NGX requires. |
| `help [command]` | Overview or per-command help. |

### Key options

- **`sr`** — `--factor N` (2; DLSS ratio), `--preset NAME` (L; model preset), `--dlss-version VER`, `--adapter N`
- **`nr`** — `--intensity F` (1, 0–2), `--style N` (0; Default / Natural / Cinematic), `--local-tone F` (1),
  `--local-structure F` (1), `--auto-mask`, `--adapter N`
- **`fg`** — `--fps RATE`, `--multiplier N` (2), `--engine auto|native|cascade`, `--codec NAME` (NVENC default),
  `--quality N` (0–51, lower = better, 20)

Shared: `--adapter N` (GPU index from a prior `probe` output), `--runtime DIR`. Every command rejects
unknown flags; per-command `--help` lists all options with defaults.

---

## Web UI

At **http://localhost:4080/** — no separate build step (Bun serves `web/index.html`).
For front-end-only work: `bun run web/mock-server.ts` on port 3080, or append `?mock=1`.

**Image tab** — SR upscale / Neural Rendering / bypass engine, DLSS version, output size, NR look controls.  
**Video tab** — Frame Generation (240+ fps target list), NVENC encoding, neural-rendering controls.  
**Probe tab** — hardware/runtime check (adapters, CUDA device, optical-flow limits, DLLs, shim).

### Caveats

- A **CUDA device is required**; non-NVIDIA or duplicate DXGI entries are rejected.
- Alternate DLSS DLLs may fail to initialise on newer drivers; the job reports a clear error.
- NR style, intensity (effective to 1), local tone/structure, and auto mask apply; model preset
  and skin structure are shown disabled (the installed runtime ignores them).

## HTTP API

All JSON, same-origin base:

| Method & path | Returns |
| --- | --- |
| `GET /api/probe` | ProbeReport (hardware/runtime probe) |
| `GET /api/runtime` | Runtime report |
| `GET /api/tools` | ffmpeg / ffprobe / NVENC availability |
| `GET /api/catalog` | DLL version catalog |
| `GET /api/settings/defaults` | defaults |
| `GET|POST /api/jobs` | list / submit job |
| `GET /api/jobs/:id` · `POST /api/jobs/:id/cancel` | status / cancel |
| `GET /api/file?path=<abs>` | raw bytes (previews; absolute path only) |
| `POST /api/upload` | multipart upload → `{ path, name, size }` |
| `WS /ws` | server→client `WsEvent` stream (`hello` / `job` / `log`) |

Full request/response shapes in [`src/server/api-types.ts`](src/server/api-types.ts).

---

## Runtime folder

`runtime/` is git-ignored (except its `README.md`):

```
runtime/
  caller/nvngx.dll        generated x64 shim (auto-built)
  dlss/nvngx_dlss.dll     DLSS Super Resolution   (feature 1)   [required]
  dlssg/nvngx_dlssg.dll   DLSS Frame Generation   (feature 11)  [required]
  dlssg/dlssg-worker.exe  frame-gen worker process
  dlssnr/nvngx_dlssnr.dll DLSS Neural Rendering   (feature 18)  [required]
  ffmpeg/bin/{ffmpeg,ffprobe}.exe
```

The driver's NGX core `_nvngx.dll` is loaded from the installed driver. The shim exists because NGX
rejects calls whose return address is not inside a module named `nvngx.dll`. Feature 11 runs
out-of-process; features 1 and 18 run in-process.

## Tests

`bun test` — pure logic suite: PNG codec, rational arithmetic, ffprobe parsing, encoder selection,
frame-gen planning, optical-flow math, version catalog, forwarder shim, request validation.
Manual GPU harnesses live in `tests/diag-*.ts` / `tests/run-*.ts`.

## Feature status

| Capability | CLI | Web UI |
| --- | --- | --- |
| DLSS SR upscaling (feature 1) | ✅ `sr` | ✅ (`sr`) |
| DLSS Neural Rendering (feature 18) | ✅ `nr` (PNG) | ✅ (`nr`, image & video) |
| DLSS Frame Generation (feature 11) | ✅ `fg` | ✅ (video tab) |
| DLSS version enumeration / selection | ✅ `versions` + `--dlss-version` | ✅ (picker) |
| Browser file upload | — | ✅ (POST /api/upload) |
| NR look controls | ✅ (`nr`) | ✅ |
| NVENC GPU encode | ✅ if requested | ✅ if selected |
| GPU optical flow (NVOFA) | ✅ (video/fg motion) | ✅ |
| RTX Video Super Resolution / TrueHDR | ❌ | ❌ (DLLs present, unused code path) |

## License

This project's own code is provided as-is. NVIDIA DLSS DLLs, ffmpeg, and ReShade are **not**
included — subject to their own licenses; obtain and place them yourself.
