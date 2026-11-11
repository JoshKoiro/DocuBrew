# DocuBrew

![DocuBrew](img/logo-256.png)

Markdown + reusable CSS styles → print-ready PDFs, with a live, paginated preview in your browser.

Write in Markdown (in any editor), style with layered CSS **Blends**, and see the printed pages update every time you save. Export to PDF with page numbers, running headers and footers handled by standard CSS Paged Media.

Status: **Phase 4** (core loop, editing, visual styling, templates and the Blend Editor). See [PLAN.md](PLAN.md) for the roadmap and [docs/DECISIONS.md](docs/DECISIONS.md) for why things are the way they are.

## Quick start

Requires Node.js 20 or newer.

```bash
npm install          # also downloads the headless Chrome used for PDF export
npm start            # starts DocuBrew and opens your browser
```

On first run DocuBrew creates its workspace at `~/Documents/DocuBrew/` with the Blend Library and a sample Brew. Open the sample, then edit any file in it with your editor — the preview refreshes on save.

## Working in the app

- **Edit anywhere.** Use the built-in editor or your own (VS Code etc.) — any save refreshes the preview. The **Folder** and **VS Code** buttons open the Brew folder.
- **Editor.** Pick a file under *Files* in the sidebar. Changes autosave after a short pause (or press Ctrl+S). The Blend copy opens read-only.
- **Two editors at once.** If a file changes on disk while you have unsaved edits in the browser, DocuBrew asks: *Keep mine* or *Use disk version*. With no unsaved edits it just reloads.
- **Scroll sync.** With **Sync** on, the preview follows the editor. Double-click anything in the preview to jump to its line in the source.
- **Images.** Drag image files onto a page in the preview — a red line shows where they'll go — or into the editor. They're saved to `images/` (same file twice isn't duplicated) and linked as `![Alt](../images/name.png)`.
- **Chapters.** *+ Chapter* adds the next numbered file in `content/`.
- **Inspect (visual styling).** Turn on **Inspect** (or press I), hover the preview and click an element. The inspector shows:
  - **Blend style** — the Blend's named styles for that element (e.g. figure: Right, text wraps). Picking one adds the class to the Markdown, `{.fig-right}`. This is the consistent choice: no new CSS.
  - **Properties** — width, text size, weight, alignment, color, space above/below, start on a new page, keep with next.
  - **Applies to** — *This element* (DocuBrew gives it a readable id in the Markdown, e.g. `{#fig-type-basket}`, and styles `#fig-type-basket`) or *All figures / All paragraphs / …* (styles every element of that kind in this Brew). Each new selection starts at *This element*.
  - Changes show instantly, then the pages re-flow. Rules are written to a marked **DocuBrew visual edits** section in `overrides.css` — the rest of that file is yours and is never touched. Esc stops inspecting.
- **Zoom.** **Fit** keeps the page fitted to the preview as you resize; − / + / 100% switch to a fixed zoom.

- **Blend Editor.** Click a Blend in the *Blend Library* to edit it. The preview shows the **specimen** — a built-in document with every element and template — or any of your Brews (*Preview with*). Every stylesheet layer is listed; ones the Blend doesn't have yet show *empty* and are created when you first save. The inspector works here too, writing *All …* rules to the layer you pick. **Release version…** bumps the version and records a changelog entry in `blend.yaml`. **+ New Blend** starts one that builds on another. **← Back to document** returns to your Brew.
- **Blend updates.** When a Brew's Blend copy differs from the Library, a banner offers **Review changes** (a file-by-file diff) and **Update**. Updating never touches your content or `overrides.css`. If the copy was edited by hand, the banner says so first.
- **Samples.** *+ Add sample Brews* (or `docubrew sample`) puts back any bundled sample you've deleted.

Shortcuts: I inspect · Esc stop inspecting · Ctrl+S save · Ctrl+E export PDF · Ctrl+O open Brew · Ctrl+\ toggle editor · Ctrl+Alt+N new Brew.

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
toc: true             # or: toc: { depth: 3, title: Contents }
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

### Table of contents

`toc: true` in `brew.yaml` adds a contents page after the title page, listing chapter titles and their `##` headings with page numbers. `toc: { depth: 3 }` adds `###` too; `toc: false` in a chapter's front matter leaves it out. Every heading gets an id automatically, so links like `[see Procedure](#chapter-2)` work.

### Markdown extras

| Write | Get |
|---|---|
| `![Alt](images/x.jpg "Caption")` | A numbered figure with a caption |
| `![Alt](images/x.jpg){.fig-right}` | Figure preset: `fig-full`, `fig-half`, `fig-small`, `fig-right`, `fig-left` |
| `::: warning Title` … `:::` | Callout: `note`, `tip`, `important`, `warning`, `caution`, `danger` |
| `::: steps` (around a numbered list) | Large numbered steps |
| `::: tools Tools & materials` (around a list) | Two-column tools box |
| A blank line, then `{.spec}` on its own line after a table | Spec-sheet table style (same form works for lists) |
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
    toc.html              optional: contents page (DocuBrew has a default)
```

Write plain CSS in each file — DocuBrew wraps it in its cascade layer. The order is:

```css
@layer tokens, base, components, page, templates, document;
```

so `overrides.css` (the `document` layer) always wins without `!important`.

A Blend can `extends:` another. When a Brew is created, the whole chain is flattened and copied into the Brew's `blend/` folder, so the document always renders the same way even if the Library changes.

Templates use `{{ value }}`, `{{{ raw html }}}`, `{{#if x}}…{{else}}…{{/if}}` and `{{#each list}}…{{ this.field }}…{{/each}}`. Inside a chapter opener, `chapter.title`, `chapter.number`, `chapter.numberPadded` and any front-matter field are available.

Bundled Blends: **Typewriter Base** (abstract foundation), **Typewriter SOP**, and **Typewriter Care Sheet** (a short record that ships with a machine: machine details, work performed, care tips — sections flow without page breaks).

**Writing page margins (Paged.js quirk):** if a Blend redefines a margin box another Blend already set (e.g. `@bottom-left`), repeat all of its declarations, not just `content` — the earlier ones are dropped. And give headings that carry a rule `break-inside: avoid`, or a sliver of them can be left at the foot of a page.

## Command line

```bash
docubrew                          # start the app (or: npm start)
docubrew path/to/brew             # start with a specific Brew open
docubrew build path/to/brew       # export a PDF to path/to/brew/dist/
docubrew build --all              # export every Brew in the workspace
docubrew new "Escapement Adjustment" --blend typewriter-sop
docubrew list                     # Brews and Blends in the workspace
docubrew sample                   # add back any deleted sample Brews
docubrew blend status             # which Brews' Blend copies differ from the Library
docubrew blend update path/to/brew
docubrew blend reset typewriter-sop   # replace a Library Blend with the version bundled with DocuBrew
```

Options: `--workspace <dir>` (or `DOCUBREW_WORKSPACE`), `--port <n>` (default 4747), `--no-open`, `-o out.pdf`.

To use `docubrew` from anywhere, run `npm link` once in this folder.

## How it works

- A local Node server (bound to `127.0.0.1`) renders the open Brew: Markdown → HTML with markdown-it, templates filled from YAML, Blend layers linked in cascade order.
- [Paged.js](https://pagedjs.org) paginates the HTML in the browser. The preview renders into a hidden frame and swaps in when done, keeping your scroll position.
- chokidar watches the Brew folder; any change pushes a WebSocket message and the preview refreshes.
- PDF export loads the same page in headless Chrome (Puppeteer) and prints it — the preview is the print.
- Every block element carries `data-source-line` / `data-source-end` and its chapter section carries `data-source-file`. That mapping drives scroll sync, jump-to-source and image drops, and will drive the Phase 3 inspector.
- The editor is CodeMirror 6, pre-bundled into `app/vendor/codemirror.js` so running DocuBrew needs no build step. After upgrading CodeMirror, run `npm run build:vendor`.

## License

GPL-3.0-or-later. Bundled fonts (Inter, Inter Tight, Courier Prime) are under the SIL Open Font License; see `blends/typewriter-base/fonts/`.
