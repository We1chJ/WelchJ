# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a minimal static portfolio website hosted on GitHub Pages. It displays a PDF resume (assets/ResumeOfficial.pdf) embedded in index.html, with a visitor counter badge.

**Key Files:**
- `index.html` — The only page; contains the PDF embed and styling
- `assets/ResumeOfficial.pdf` — The resume document to display
- `README.md` — Minimal project description

## Development

Since this is a static HTML site with no build process or dependencies:

1. **Edit the HTML directly** — Changes to `index.html` are immediately reflected
2. **Test locally** — Open `index.html` in a browser to preview
3. **Deploy** — Push to GitHub; changes appear at `https://we1chj.github.io/WelchJ/`

## Common Tasks

### Update the Resume
Replace `assets/ResumeOfficial.pdf` with a new PDF file. The HTML embed will automatically display the updated file.

### Modify the Page
Edit `index.html` directly. The page is minimal: it embeds the PDF and displays a visitor counter badge.

### Fix Links or URLs
The counter badge uses a hardcoded URL (`https://we1chj.github.io/WelchJ/`). If the hosting URL changes, update the counter URL in the `<img src>` tag.

## Architecture Notes

- **No framework or build system** — This is pure HTML
- **No dependencies** — No npm, no build step, no configuration
- **Direct PDF embedding** — Uses the `<embed>` tag with full viewport width/height
- **Visitor tracking** — Uses seeyoufarm.com badge (external service)

## Deployment

The site is deployed to GitHub Pages. After pushing commits to the `main` branch, changes are live within seconds at the GitHub Pages URL.
