# QC Photo Organizer

中文文档见 [README_CN.md](./README_CN.md).

A zero-build, client-only web app for product quality-inspection photo archiving. An inspector enters a product model and unit number, attaches one overview photo per fixed surface, optionally flags a surface as defective and attaches one or more defect photos (each with its own note), and can append supporting files (PDF / Word / image). On submit it exports a neatly named, ready-to-archive folder delivered as a ZIP. Everything runs in the browser — no backend and no build step.

The user interface is in Simplified Chinese (the target users are QC and factory staff).

## Features

- Eleven fixed surface slots, grouped into external (5) and internal (6). The overview photo is optional per slot.
- A per-surface "has defect" checkbox. When checked, a defect gallery appears where you can add multiple defect photos (multi-select or drag-and-drop), each with its own note. Defect photos export into a defect folder organized by external/internal.
- An "extra files" section that accepts multiple PDF / Word / image attachments, exported into a top-level 附件 folder.
- Standardized file and folder naming for traceability (see the naming contract below).
- A `质检备注.csv` manifest (UTF-8 with BOM) with one row per overview photo, per defect photo (with its note), and per attachment. It opens cleanly in Excel, WPS, and Numbers.
- One-click export that packs a single top-level folder into a ZIP and downloads it (using [JSZip](https://stuk.github.io/jszip/)).
- A "next unit" action that keeps the model, auto-increments the unit number (01 to 02), and clears the form for the next unit.
- An in-session history panel to review every unit generated in the session (thumbnails and notes) and re-download any of them.
- Mobile and desktop friendly: responsive grid, large touch targets, direct camera capture on phones, drag-and-drop on desktop, smooth animations, and reduced-motion support.

## The 11 surfaces

| External (5) | Internal (6) |
| --- | --- |
| 正面 / 背面 / 左侧板 / 右侧板 / 顶板 | 内侧板（左）/ 内侧板（右）/ 内背板 / 坐板 / 坐前板 / 脚板 |

## Naming contract

For a model `ABC` and unit `01`, the export is `ABC-01.zip`, which unzips to:

```
ABC-01/                          unit folder = {model}-{unit}
├── 外部/                         external overview photos
│   ├── ABC-01-正面.jpg           photo = {model}-{unit}-{surface}.{ext}
│   └── ...
├── 内部/                         internal overview photos
│   └── ...
├── 瑕疵/                         defect photos (one or more per flagged surface)
│   ├── 外部/
│   │   ├── ABC-01-正面-瑕疵1.jpg  defect photo = {model}-{unit}-{surface}-瑕疵N.{ext}
│   │   └── ABC-01-正面-瑕疵2.jpg
│   └── 内部/
│       └── ABC-01-坐板-瑕疵1.jpg
├── 附件/                         extra files (PDF / Word / image), original names
│   ├── 检验报告.pdf
│   └── 图纸.docx
└── 质检备注.csv                  manifest (always included)
```

Defect photos are independent uploads (close-ups of specific defects); the overview photo stays only in `外部`/`内部`. Only sub-folders that contain at least one file are created.

`质检备注.csv` columns: `类别, 部位, 类型, 文件名, 瑕疵备注` — one row per overview photo (`类型`=总览), per defect photo (`类型`=瑕疵, with its note), and per attachment (`类型`=附件). A header block precedes the table with the model, unit, timestamp, overview-photo count, defect-photo count, and attachment count.

Model and unit text is sanitized for filesystem safety (characters such as `/ \ : * ? " < > |` become `_`); Chinese characters are preserved as UTF-8 ZIP entry names.

## Run locally

This is a static site — no install and no build.

- Simplest: open `index.html` directly in a browser.
- Recommended (avoids any `file://` quirks): serve the folder, for example:

  ```bash
  cd qc-photo-organizer
  python3 -m http.server 8000
  # then open http://localhost:8000
  ```

## Deploy to Vercel

This folder ships a zero-build `vercel.json` (no build command; serves static files; adds cache and security headers).

Option A — Vercel CLI, from this folder:

```bash
cd qc-photo-organizer
npx vercel          # preview deploy
npx vercel --prod   # production deploy
```

Option B — Git import: in the Vercel dashboard, "Add New Project", set the framework preset to "Other", and leave the build command empty. If deploying from a monorepo, set the root directory to `qc-photo-organizer`.

## Tech and dependencies

- Vanilla HTML, CSS, and JavaScript. No framework and no bundler.
- [JSZip](https://stuk.github.io/jszip/) version 3.10.1, vendored at `lib/jszip.min.js` so it works offline (for example on a factory network). MIT / GPLv3 dual-licensed.
  - Source: `https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js`
  - To upgrade: replace that file and update the version noted here.

## File structure

```
qc-photo-organizer/
├── index.html        page skeleton (inputs, surface grids, action bar, history modal)
├── styles.css        layout, responsive grid, animations, reduced-motion
├── app.js            state, rendering, file handling, sanitize, ZIP + CSV, history
├── favicon.svg       app icon
├── lib/jszip.min.js  vendored JSZip 3.10.1
├── vercel.json       zero-build static deploy config
├── README.md         this file
└── README_CN.md      Chinese documentation
```

## Known limitations

- iOS Safari downloads: older iOS may ignore the ZIP filename and open the file in a new tab or the share sheet instead of saving it directly. If a file does not save automatically, use the browser's download or share action.
- HEIC photos: iPhones in "High Efficiency" mode produce HEIC, which most desktop browsers cannot render — those slots show a placeholder, but the original file is still included in the ZIP with a `.heic` extension. No HEIC decoding library is bundled. To get previews, set the phone camera to "Most Compatible" (JPEG).
- History is session-only: the records panel is held in memory and is cleared on page refresh.
- Chinese filenames in legacy unzip tools: entry names are valid UTF-8 and display correctly in macOS Finder/Archive Utility, Windows 10+ Explorer, 7-Zip, and WPS. The old Info-ZIP `unzip` CLI (and Windows 7 Explorer) ignore the UTF-8 flag and may show garbled names; extract with a modern tool instead.
