# Contributing to PDF Coordinate Viewer

Thanks for your interest in improving this project.

## Development Setup

1. Clone the repository.
2. Start a local static server from the repo root:

```bash
python3 -m http.server 8000
```

3. Open `http://localhost:8000/`.
4. Use `data/doors-response.json` or paste your own detection response in the UI.

## Contribution Guidelines

- Keep the app standalone (no mandatory build step).
- Favor small, focused pull requests.
- Keep code readable and avoid over-abstraction.
- Preserve compatibility with modern evergreen browsers.
- Do not commit local PDFs or other large binary test files.

## Code Style

- Use plain JavaScript with clear function boundaries.
- Keep CSS simple and scoped to existing UI sections.
- Add comments only when logic is non-obvious.
- Keep user-facing text concise and action-oriented.

## Testing Checklist

Before opening a PR, verify:

- App loads with sample JSON.
- Local PDF file picker flow works.
- Path-based PDF loading works.
- Overlay alignment is reasonable for at least one known sample.
- Ctrl/Cmd + wheel zoom works.
- Hover/click synchronization works between list and canvas.
- Cursor coordinate readout updates while moving on the page.

## Pull Request Notes

In your PR description, include:

- What changed
- Why it changed
- How you validated it
- Screenshots or short GIFs for UI changes (if applicable)
