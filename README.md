# DocuBrew

![DocuBrew](img/logo-256.png)

Markdown + reusable CSS styles → print-ready PDFs, with a live, paginated preview in your browser.

Write in Markdown (in any editor), style with layered CSS **Blends**, and see the printed pages update every time you save. Export to PDF with page numbers, running headers and footers handled by standard CSS Paged Media.

Status: **Phase 1** (core loop). See [PLAN.md](PLAN.md) for the roadmap and [docs/DECISIONS.md](docs/DECISIONS.md) for why things are the way they are.

## Quick start

Requires Node.js 20 or newer.

```bash
npm install          # also downloads the headless Chrome used for PDF export
npm start            # starts DocuBrew and opens your browser
```

On first run DocuBrew creates its workspace at `~/Documents/DocuBrew/` with the Blend Library and a sample Brew. Open the sample, then edit any file in it with your editor — the preview refreshes on save.

## Words

| Term | Meaning |
|---|---|
| **Brew** | A document: a folder with `brew.yaml`, `content/`, `images/`, its own copy of a Blend, and `overrides.css`. |
| **Blend** | A reusable style: layered stylesheets, HTML templates, fonts. Lives in the workspace's `Blends/` folder. |

## A Brew

```
my-sop/
  brew.yaml          title, revision, date, variables
  content/           one Markdown file per chapter, in filename order
    01-scope.md
    02-procedure.md
  images/
  blend/             copy of the Blend (managed by DocuBrew — don't edit here)
  overrides.css      styles for this document only (always wins over the Blend)
  dist/              exported PDFs
```

### brew.yaml

```yaml
title: Cleaning a Manual Typewriter
subtitle: Solvent cleaning of the type basket, segment and carriage.
revision: B
date: 2026-11-10
page:                 # optional: override the Blend's page setup
  size: letter        # letter | A4 | A5 | half-letter | "6in 9in" | "letter landscape"
  margin: 0.8in
variables:
  sop:
    number: SOP-001
  machine:
    example: 1964 Royal Safari
```

### Chapter files

```markdown
---
title: Procedure
summary: Flush, blow out, dry, and test.
---

Text can use variables: this applies to a {{ machine.example }}.
```

A chapter with a `title` gets the Blend's chapter-opener template. Leave `title` out (or set `template: none`) for a plain page.

### Markdown extras

| Write | Get |
|---|---|
| `![Alt](images/x.jpg "Caption")` | A numbered figure with a caption |
| `![Alt](images/x.jpg){.fig-right}` | Figure preset: `fig-full`, `fig-half`, `fig-small`, `fig-right`, `fig-left` |
| `::: warning Title` … `:::` | Callout: `note`, `tip`, `important`, `warning`, `caution`, `danger` |
| `::: steps` (around a numbered list) | Large numbered steps |
| `::: tools Tools & materials` (around a list) | Two-column tools box |
| `{.spec}` on the line after a table | Spec-sheet table style |
| `text[^1]` … `[^1]: note` | Footnotes |
| `<div class="page-break"></div>` | Force a new page |
| `{{ path.to.variable }}` | Value from `brew.yaml` variables (`\{{` to write it literally) |

Image paths can be relative to `content/` (`../images/x.jpg`, as VS Code expects) or to the Brew folder (`images/x.jpg`).

## Blends

```
Blends/typewriter-sop/
  blend.yaml          name, version, extends, page setup, default variables, presets
  fonts.css           @font-face rules (unlayered)
  tokens.css          @layer tokens      — variables: colors, fonts, type scale
  base.css            @layer base        — plain elements
  components.css      @layer components  — callouts, figures, steps
  page.css            @layer page        — margins, headers, footers, page numbers
  templates.css       @layer templates   — title page, chapter openers
  templates/
    title-page.html       optional
    chapter-opener.html   optional
    running.html          optional: values for page headers/footers via string-set
```

Write plain CSS in each file — DocuBrew wraps it in its cascade layer. The order is:

```css
@layer tokens, base, components, page, templates, document;
```

so `overrides.css` (the `document` layer) always wins without `!important`.

A Blend can `extends:` another. When a Brew is created, the whole chain is flattened and copied into the Brew's `blend/` folder, so the document always renders the same way even if the Library changes.

Templates use `{{ value }}`, `{{{ raw html }}}`, `{{#if x}}…{{else}}…{{/if}}` and `{{#each list}}…{{ this.field }}…{{/each}}`. Inside a chapter opener, `chapter.title`, `chapter.number`, `chapter.numberPadded` and any front-matter field are available.

Bundled Blends: **Typewriter Base** (abstract foundation) and **Typewriter SOP**.

## Command line

```bash
docubrew                          # start the app (or: npm start)
docubrew path/to/brew             # start with a specific Brew open
docubrew build path/to/brew       # export a PDF to path/to/brew/dist/
docubrew build --all              # export every Brew in the workspace
docubrew new "Escapement Adjustment" --blend typewriter-sop
docubrew list                     # Brews and Blends in the workspace
```

Options: `--workspace <dir>` (or `DOCUBREW_WORKSPACE`), `--port <n>` (default 4747), `--no-open`, `-o out.pdf`.

To use `docubrew` from anywhere, run `npm link` once in this folder.

## How it works

- A local Node server (bound to `127.0.0.1`) renders the open Brew: Markdown → HTML with markdown-it, templates filled from YAML, Blend layers linked in cascade order.
- [Paged.js](https://pagedjs.org) paginates the HTML in the browser. The preview renders into a hidden frame and swaps in when done, keeping your scroll position.
- chokidar watches the Brew folder; any change pushes a WebSocket message and the preview refreshes.
- PDF export loads the same page in headless Chrome (Puppeteer) and prints it — the preview is the print.
- Every block element carries `data-source-line` / `data-source-file`, ready for Phase 2 (scroll sync, drag-and-drop images) and Phase 3 (visual inspector).

## License

GPL-3.0-or-later. Bundled fonts (Inter, Inter Tight, Courier Prime) are under the SIL Open Font License; see `blends/typewriter-base/fonts/`.
