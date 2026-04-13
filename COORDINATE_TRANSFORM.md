# Coordinate Transformation — How It Works

> **Current build:** the viewer uses a single mapper (`top-left-page-units`: overlay px = bbox × scale) for both JSON and CSV after parsing. See `docs.html` for the project-specific description. The sections below describe an older multi-mapping design kept for background.

This document explains how the PDF BBox Viewer converts bounding-box numbers from your data into visible rectangles drawn on top of the PDF page. It is written for both developers and non-technical managers.

---

## The Core Problem

Your detection data (JSON or CSV) contains bounding boxes as four numbers — `x1, y1, x2, y2` (or `x0, y0, x1, y1` in CSV). These numbers describe *where* an object sits on a page, but they can mean different things depending on who generated them:

- "Pixel 0,0 is the **top-left** of the page" — the most common convention in image processing.
- "Point 0,0 is the **bottom-left** of the page" — the PDF standard; y grows upward.
- "The numbers come from a custom coordinate range" — common in ML/detection pipelines.

The viewer must figure out which convention was used and transform the numbers into screen pixel positions so that the overlay rectangle lands on the right spot over the rendered PDF.

---

## Two Stacks: JSON and CSV

The viewer handles two data sources, and each goes through its own transformation pipeline.

### JSON detections (bbox with x1, y1, x2, y2)

JSON bounding boxes are assumed to come from a PDF-aware pipeline. There are **two possible origin conventions**:

| Mode | Origin | How y behaves |
|---|---|---|
| `pdf-origin` | Bottom-left corner | y increases upward (PDF standard) |
| `top-left-origin` | Top-left corner | y increases downward (screen standard) |

**`pdf-origin` transform** (`rectFromPdfOrigin`): Delegates entirely to pdf.js's built-in `viewport.convertToViewportPoint(x, y)`. That function knows the page height and applies the y-flip internally: `screenY = pageHeight - pdfY`. Both corners of the box go through this function, and the viewer takes the min/max to get a proper screen rectangle.

**`top-left-origin` transform** (`rectFromTopLeftOrigin`): No y-flip needed. Each coordinate is just multiplied by the current scale factor (`viewport.scale`):
```
screenX = bboxX × scale
screenY = bboxY × scale
```

### CSV detections (x0, y0, x1, y1)

CSV files frequently come from image-processing pipelines where coordinates are raw pixel values in a scanned image — not PDF units. This makes the mapping more ambiguous. The viewer offers **seven CSV mapping modes**:

| Mode | What it does |
|---|---|
| `csv-raw-top-left` | Multiply by scale only. Assumes pixels already match PDF page pixel size, top-left origin. |
| `csv-raw-top-left-yflip` | Same, but flips y: `y → pageHeightPts − y`. Use when y=0 is the bottom of the image. |
| `csv-raw-pdf-origin` | Treat CSV values as real PDF point coordinates and use the pdf.js transform (same as `pdf-origin`). |
| `csv-max` | Scale bbox by `viewportWidth / maxX` and `viewportHeight / maxY`. Fits all detections to the full page using the observed max coordinates. |
| `csv-fit` | Shift by the minimum observed coordinate, then scale to fill the viewport. Useful when coordinates start at a non-zero offset. |
| `csv-fit-uniform` | Like `csv-fit` but uses the same scale factor for both axes (preserves aspect ratio) and centers the result on the page. |
| `csv-fit-uniform-yflip` | Same as `csv-fit-uniform` but flips y before scaling. |

---

## Auto-Mapping: The Ink Score

When **auto mode** is active (the default), the viewer does not guess — it *measures*.

After the PDF page is rendered to the canvas, the viewer tries each candidate mapping, projects all bounding boxes onto the page using that mapping, and then samples the actual pixel brightness inside each projected rectangle. It counts how many dark pixels (ink) fall inside the boxes.

The logic is: **a correct mapping makes boxes land over content; a wrong mapping makes boxes land over white space.**

The mapping with the highest average darkness score wins and is used for that page.

```
score = (average darkness of sampled pixels inside all boxes)
      − (penalty for boxes that fall completely off the page)
```

This scoring runs in `scoreRectsByInk` and the winner is selected in `chooseBestMapping` (for JSON) and `chooseBestCsvMapping` (for CSV).

---

## Step-by-Step: What Happens When a Page Renders

1. **`renderPage(pageNum)`** — called on page load or page change.
2. pdf.js renders the PDF page to the main canvas at the current scale (with device-pixel-ratio correction for sharp rendering on HiDPI screens).
3. **`getRenderMapping(detections, viewport)`** — decides which coordinate mode to use:
   - If the user picked a mode manually, use that.
   - Otherwise, run the ink-score auto-selection.
4. **`buildRects(detections, viewport, mappingKind)`** — loops over every detection and calls the right transform function (`rectFromPdfOrigin`, `rectFromTopLeftOrigin`, or `rectFromCsvPixels`) to get a `{ x, top, width, height }` screen rectangle.
5. **`drawOverlayFromRects(screenRects, viewport)`** — draws colored stroke rectangles on the transparent overlay canvas, which sits on top of the PDF canvas.

---

## Cursor Coordinates

When you hover over the PDF, the status bar shows two numbers:

- **`cursor px`** — raw canvas pixel position (top-left origin, screen space).
- **`pdf`** — the corresponding PDF point coordinate (bottom-left origin, PDF space), computed via `viewport.convertToPdfPoint(cx, cy)`.

This is the inverse of the `pdf-origin` transform and lets you read out coordinates directly from the rendered page.

---

## Page Extents for CSV

For CSV data, the viewer tracks the minimum and maximum x/y values seen across all rows of each page (`csvExtents`). The `csv-fit` and `csv-fit-uniform` modes use these extents to normalize coordinates:

```
normalizedX = (rawX − minX) / (maxX − minX)
screenX     = normalizedX × viewportWidth
```

This means even if a pipeline outputs coordinates in an arbitrary range (e.g. 0–10 000), the boxes still land correctly relative to each other on screen.

---

## Summary Table

| Data source | Coordinate origin | Correct mapping mode |
|---|---|---|
| PDF-native detector (bottom-left) | Bottom-left | `pdf-origin` |
| Image detector (top-left) | Top-left | `top-left-origin` |
| CSV from image pipeline (pixel units, top-left) | Top-left pixels | `csv-raw-top-left` |
| CSV from image pipeline (pixel units, bottom-left) | Bottom-left pixels | `csv-raw-top-left-yflip` |
| CSV from PDF pipeline (PDF point units) | Bottom-left PDF pts | `csv-raw-pdf-origin` |
| CSV with unknown/arbitrary range | Any | `csv-fit-uniform` or auto |

When in doubt, leave the mode on **Auto** — the ink-score heuristic almost always picks the right mapping after the page renders.
