# QC Photo Organizer

> 中文文档见 [README_CN.md](./README_CN.md)

A tiny, zero-build web app for **product quality-inspection photo archiving**. Inspectors fill in a product model + unit number, attach up to **11 photos** (one per fixed surface) with optional **defect notes**, plus any number of **defect close-up photos**, then export a neatly named, ready-to-archive folder (delivered as a ZIP). Everything runs **in the browser** — no backend, no build step.

The UI is in Simplified Chinese (the target users are QC/factory staff).

## Features

- 📸 **11 fixed surface slots**, grouped into *外部 5 面* (external) and *内部 6 面* (internal). Photos are **optional** per slot.
- 🔎 **Defect close-up photos** — add any number of extra photos, each with an optional note; exported into a `瑕疵` sub-folder.
- 🏷️ **Standardized naming** for traceability (see contract below).
- 📝 **Per-slot defect notes**, exported to a `质检备注.csv` manifest (UTF-8 + BOM, opens cleanly in Excel / WPS / Numbers).
- 📦 **One-click export** — packs one top-level folder, split into `外部` / `内部` / `瑕疵` sub-folders, into a ZIP and downloads it (uses [JSZip](https://stuk.github.io/jszip/)).
- ➡️ **"下一台" (next unit)** — keeps the model, auto-increments the unit number (`01 → 02`), clears photos so you can shoot the next unit immediately.
- 🗂️ **Session history** — review every unit generated this session (thumbnails + notes) and re-download any of them.
- 📱 **Mobile + desktop friendly** — responsive grid, large touch targets, direct camera capture on phones, drag-and-drop on desktop, smooth animations, and `prefers-reduced-motion` support.

## The 11 surfaces

| 外部 5 面 (External) | 内部 6 面 (Internal) |
| --- | --- |
| 正面 / 背面 / 左侧板 / 右侧板 / 顶板 | 内侧板（左）/ 内侧板（右）/ 内背板 / 坐板 / 坐前板 / 脚板 |

## Naming contract

For a model `ABC` and unit `01`, the export is `ABC-01.zip`, which unzips to:

```
ABC-01/                        ← folder = {model}-{unit}
├── 外部/                       ← external surfaces
│   ├── ABC-01-正面.jpg         ← photo = {model}-{unit}-{part}.{ext}
│   └── …
├── 内部/                       ← internal surfaces
│   └── …
├── 瑕疵/                       ← defect close-ups (variable count)
│   ├── ABC-01-瑕疵-01.jpg      ← {model}-{unit}-瑕疵-NN.{ext}
│   └── …
└── 质检备注.csv                ← manifest (always included)
```

Only sub-folders that contain at least one photo are created.

`质检备注.csv` columns: `类别, 部位/序号, 是否有照片, 文件名, 备注`, preceded by a header block with 型号 / 编号 / 生成时间 / 部位照片 / 瑕疵照片. The `文件名` column holds the path inside the unit folder (e.g. `外部/ABC-01-正面.jpg`).

Model/unit text is sanitized for filesystem safety (illegal characters `/ \ : * ? " < > |` etc. become `_`); **Chinese characters are preserved** (UTF-8 ZIP entry names).

## Run locally

It's a static site — no install, no build.

- **Simplest:** open `index.html` directly in a browser.
- **Recommended (avoids any `file://` quirks):** serve the folder, e.g.

  ```bash
  cd qc-photo-organizer
  python3 -m http.server 8000
  # then open http://localhost:8000
  ```

## Deploy to Vercel

This folder ships a zero-build `vercel.json` (no build command; serves static files; adds cache/security headers).

**Option A — Vercel CLI** (from this folder):

```bash
cd qc-photo-organizer
npx vercel          # preview deploy
npx vercel --prod   # production deploy
```

**Option B — Git import:** push the repo to GitHub, "Add New Project" in the Vercel dashboard, set **Root Directory = `qc-photo-organizer`** (or the repo root if it's a standalone repo), Framework Preset = **Other**, and leave the build command empty.

## Tech & dependencies

- Vanilla HTML / CSS / JavaScript. No framework, no bundler.
- [JSZip](https://stuk.github.io/jszip/) **v3.10.1**, vendored at `lib/jszip.min.js` (so it works offline, e.g. on a factory network). MIT / GPLv3 dual-licensed.
  - Source: `https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js`
  - To upgrade: replace that file and update the version here.

## File structure

```
qc-photo-organizer/
├── index.html        # page skeleton (inputs, group containers, defect area, action bar, modal)
├── styles.css        # layout, responsive grid, animations, reduced-motion
├── app.js            # state, rendering, file handling, sanitize, ZIP + CSV, history
├── lib/jszip.min.js  # vendored JSZip 3.10.1
├── vercel.json       # zero-build static deploy config
├── README.md         # this file
└── README_CN.md      # 中文文档
```

## Known caveats

- **iOS Safari downloads:** older iOS may ignore the ZIP filename and open the file in a new tab / the share sheet instead of saving it directly. If a file doesn't save automatically, use the browser's download/share action.
- **HEIC photos:** iPhones in "High Efficiency" mode produce HEIC, which most desktop browsers can't render — those slots show a "无法预览" placeholder, **but the original file is still included** in the ZIP with a `.heic` extension. No HEIC decoding library is bundled (kept intentionally simple). To get previews, set the phone camera to "Most Compatible"/JPEG.
- **History is session-only:** the records panel lives in memory and is cleared on page refresh. (Cross-refresh persistence via IndexedDB could be added later.)
- **Chinese filenames in legacy unzip tools:** entry names are correct UTF-8 and display fine in macOS Finder/Archive Utility, Windows 10+ Explorer, 7-Zip, and WPS. The old Info-ZIP `unzip` CLI (and Windows 7 Explorer) ignore the UTF-8 flag and may show garbled names — extract with a modern tool instead.
