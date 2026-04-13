# PDF BBox Viewer

Offline PDF bounding-box viewer for detection JSON and CSV.
<img width="2994" height="1702" alt="CleanShot 2026-04-13 at 23 57 27@2x" src="https://github.com/user-attachments/assets/af0977f8-05ee-4a74-bc30-f612f05aed8f" />

## Run

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/`.

## What it does

- Load PDF from local path or file picker
- Paste full JSON response into textarea
- Load CSV detections (`x0,y0,x1,y1`) from file picker
- Draw bbox overlays on top of PDF (`pdf.js`)
- Zoom with `Ctrl/Cmd + wheel`
- Switch pages, inspect object list, hover/click highlight sync
- Inspector: saved point and bbox in top-left page units (pt), same mapper for JSON and CSV after parsing

## CSV shape

CSV should include:

- `x0,y0,x1,y1`
- page column (`Document page number` or `page`) (optional, defaults to 1)
- optional class/label columns (used as object type when present)

## JSON shape

Any array item with:

- `bbox: { x1, y1, x2, y2 }`
- `page` or `page_number`
- optional `id`

Works for payloads like `result.doors`, `result.toilets`, etc.

## Notes

- Sample package (PDF + CSV): `sample_data/`
- Local PDFs should go in `test-data/` (gitignored)
- Optional: `npm run dev` (same as Python static server)

## License

MIT (`LICENSE`)
