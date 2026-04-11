# PDF Coordinate Viewer

Standalone browser-based utility to inspect PDF detection bounding boxes (`bbox`) with robust coordinate mapping diagnostics.

No build step, no backend, no framework.

## Features

- Load a local PDF by path or file picker
- Paste full JSON API responses directly into the app
- Parse nested detection arrays (for example `result.doors`, `result.toilets`, and similar payloads)
- Render pixel-aligned bbox overlays over a `pdf.js` canvas render
- Zoom with `Ctrl/Cmd + wheel`
- Page switcher, object list, and hover/click sync between sidebar and overlay
- Live cursor readout in both canvas pixels and PDF coordinates
- Automatic mapping fallback selection (`pdf-origin` vs `top-left-origin`) based on page ink scoring
- On-screen debug status for scale, mapping mode, dimensions, ranges, and off-page counts

## Tech Stack

- **Language:** vanilla JavaScript (ES modules)
- **PDF renderer:** `pdf.js` via CDN
- **UI:** plain HTML + CSS
- **Architecture:** static frontend app served over HTTP

## Project Structure

- `index.html` - UI layout, controls, and coordinate notes
- `viewer.js` - PDF rendering pipeline, JSON parsing, bbox projection, and interactions
- `styles.css` - UI styling
- `data/doors-response.json` - sample JSON payload
- `test-data/.gitkeep` - placeholder for local PDFs (actual PDFs are gitignored)
- `assets/.gitkeep` - placeholder for screenshots/media

## Quick Start

1. Optional: place a local PDF in `test-data/` (for example `test-data/Doors-v1.pdf`).
2. Start a static server from the repository root:

```bash
python3 -m http.server 8000
```

3. Open [http://localhost:8000/](http://localhost:8000/).
4. Paste detection JSON into **Detection JSON input**, or click **Load sample JSON**.
5. Click **Load**.

## npm Scripts (Optional)

If you prefer starting with npm:

```bash
npm run dev
```

This runs the same static server command (`python3 -m http.server 8000`).

## Detection JSON Format

The viewer scans JSON objects for arrays of entries containing:

- `bbox: { x1, y1, x2, y2 }`
- `page` or `page_number`
- optional `id`

Array names are normalized into object types in the UI (`doors` -> `door`, `toilets` -> `toilet`, and so on).

## Coordinate Mapping Notes

- Primary projection uses `pdf.js` viewport transforms (`convertToViewportPoint`) from PDF-space coordinates.
- A fallback top-left-origin projection is evaluated automatically.
- The viewer compares both mappings using an ink-based score and keeps the best-fit mode for each rendered page.
- Debug info in the status line helps explain alignment outcomes.

## Contributing

Contributions are welcome. Please review `CONTRIBUTING.md` for workflow and style expectations.

## License

This project is licensed under the MIT License. See `LICENSE`.
