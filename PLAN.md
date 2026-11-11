# DocuBrew — Project Plan

> Markdown + CSS in, print-ready PDF out. A local, browser-based workbench for
> producing consistently styled SOPs, manuals and books without Word or InDesign.

Status: **Phase 3 built** · Last updated: 2026-11-10 · Decisions log: [docs/DECISIONS.md](docs/DECISIONS.md)

---

## 1. Goals

- Write content in Markdown (in the browser or any external editor).
- Style it with reusable, layered CSS stylesheets ("Blends").
- See a paginated, print-accurate live preview that refreshes on every save of any file.
- Drag images into the document and style them visually, without hunting through CSS.
- Export a print-ready PDF with automatic page numbers, running headers and footers.
- Keep everything as plain files so it works with git and external tools.
- Batch and automate through a CLI.

### Initial use cases

- Typewriter repair SOPs (internal procedures).
- Documentation shipped with a repaired typewriter (customer care sheets).
- Long-form documents and books.

### Out of scope (for now)

- Magazines, brochures, complex multi-frame layouts.
- Commercial/offset print (CMYK, ink limits). Target is a home/office printer.
- Multi-user / network server deployment (architecture keeps the door open; see §8).

---

## 2. Guiding principles

1. **Files are the source of truth.** The app is a window onto folders on disk. No hidden database.
2. **Content is separate from design.** Content = Markdown + images. Design = a Blend.
3. **The preview is the print.** Preview and PDF use the same rendering pipeline (Paged.js in Chromium).
4. **Web standards first.** CSS Paged Media (`@page`, margin boxes, `counter(page)`, `counter(pages)`, `string-set`, `target-counter`) does the print work, so stylesheets stay portable.
5. **Consistency by default.** The visual editor favors choosing Blend-defined presets over one-off pixel tweaks.
6. **Documents and design are edited in different places.** The Document Editor never changes a Blend; the Blend Editor never changes a document.
7. **Brews are self-contained.** A Brew carries its own copy of its Blend, so it always renders the same way.

---

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **Brew** | A document project: a folder containing `brew.yaml`, content, images, its copy of a Blend, and overrides. |
| **Blend** | A reusable style: a set of layered stylesheets, HTML templates, fonts, presets and default variables. |
| **Blend Library** | The collection of master Blends the user picks from when creating a Brew. |
| **`.brew` file** | A Brew folder zipped into a single file for sending or archiving. |
| **Import / Export** | Unzip a `.brew` file into the workspace as a new Brew / zip a Brew into a `.brew` file. |

---

## 4. Workspace layout on disk

Default workspace: `~/Documents/DocuBrew/` (Windows: `%USERPROFILE%\Documents\DocuBrew\`).
The user can relocate it in settings.

```
DocuBrew/                              ← workspace
  docubrew.config.yaml                 ← workspace settings
  Blends/                              ← Blend Library (reserved folder name)
    typewriter-base/
    typewriter-sop/
  royal-mercury-escapement/            ← a Brew (any folder containing brew.yaml)
  olivetti-care-sheet/                 ← another Brew
```

A folder is recognized as a Brew by the presence of `brew.yaml`, so Brews and the
`Blends/` folder can live side by side without conflicts.

### Brew folder

```
royal-mercury-escapement/
  brew.yaml          ← title, revision, variables, blend provenance (see §5.3)
  content/
    01-overview.md
    02-procedure.md
  images/
  blend/             ← COPY of the Blend (flattened, including anything it extends)
  overrides.css      ← this Brew's own style edits (visual editor writes here)
  dist/              ← exported PDFs (git-ignorable)
```

### Blend folder

```
Blends/typewriter-sop/
  blend.yaml         ← name, version, extends, layer files, presets, default variables
  tokens.css         ← @layer tokens     — colors, fonts, type scale, spacing variables
  base.css           ← @layer base       — plain elements: headings, paragraphs, lists, tables
  components.css     ← @layer components — callouts, warnings, figure styles, step lists
  page.css           ← @layer page       — page size, margins, headers/footers, page numbers, named pages
  templates.css      ← @layer templates  — title page, chapter openers
  templates/
    title-page.html
    chapter-opener.html
  fonts/
```

### Cascade layer order

```css
@layer tokens, base, components, page, templates, document;
```

`overrides.css` is wrapped in `@layer document`, so a document's own edits always beat the
Blend without needing `!important`.

---

## 5. Core features

### 5.1 Live preview

- Node server watches the open Brew (chokidar), including its copy of the Blend.
- Any file change sends a WebSocket message to the browser.
- The preview re-renders in a hidden container and swaps it in when done (no flicker), keeping the scroll position.
- Edits are debounced so rapid saves don't stack up re-renders.

### 5.2 Rendering pipeline

```
brew.yaml + content/*.md
  → variable substitution ({{machine.serial}})
  → markdown-it (+ attrs, containers, footnotes) with data-source-line on block elements
  → HTML templates (title page, chapter openers) filled from YAML
  → Blend CSS layers + overrides.css
  → Paged.js pagination
  → on screen: preview  |  in headless Chrome (Puppeteer): PDF
```

Paged.js is wrapped behind a small renderer adapter so it can be upgraded to 2.0, or replaced, without touching the rest of the app.

### 5.3 Blend lifecycle (copy-in, never live-linked)

- Creating a Brew: pick a Blend from the Library → it is **copied** into `brew/blend/`, with any `extends` chain flattened into the copy.
- `brew.yaml` records where the copy came from:

  ```yaml
  blend:
    source: typewriter-sop
    version: 1.3.0
    hash: 9f2c…        # content hash of the Library Blend at copy time
  ```

- On open, DocuBrew compares that against the Library. If the Library Blend has changed, it shows: *"This Brew's Blend is out of date with the Library. Update?"*
- If the Brew's own copy was edited locally since it was copied (its hash no longer matches), the prompt warns that updating will replace those edits and offers a diff first.
- Rule: in the Document Editor, per-document changes only ever go to `overrides.css`. The Brew's Blend copy is treated as read-only there, so a Library update never wipes out document edits.
- Library Blends are edited only in the **Blend Editor** (§5.11). Saving there bumps the Blend's version, and Brews using it get the update prompt next time they're opened.
- The update prompt shows a diff of what changed in the Blend, so it's always clear why a document looks different after an update.

### 5.4 Open / Import / Export

Separate commands:

| Command | Does |
|---|---|
| **New Brew** | Pick a Blend, name it → creates a folder in the workspace. |
| **Open Brew…** | Browse to a Brew folder. Starts in the workspace; can navigate anywhere. |
| **Import .brew…** | Pick a `.brew` file → unzips into the workspace as a new Brew folder. Name clash → prompts for a new name. |
| **Export .brew…** | Zips the Brew (excluding `dist/` by default) into a single `.brew` file. |
| **Export PDF** | Renders to `dist/<name>.pdf`. |

Because the app runs in a browser, the file pickers are DocuBrew's own browser UI backed by the local server's file-system API, not native OS dialogs (browsers can't see real file paths).

A `.brew` file is a standard zip containing a `manifest.json` (DocuBrew format version and Brew name) alongside the folder contents.

### 5.5 Editing

- In-browser editor: CodeMirror 6 for Markdown, CSS and YAML.
- External editors are first-class: saving in VS Code etc. triggers a refresh.
- If a file open in the browser editor has unsaved changes and changes on disk, prompt: keep mine / take disk version / show diff.
- Scroll sync between editor and preview via `data-source-line`.

### 5.6 Images (drag and drop)

- Drop an image onto the preview or the editor → uploaded to the server → saved to `images/` (deduplicated by name).
- The server inserts `![](images/name.jpg)` at the Markdown line matching the drop point (from `data-source-line`).
- Preview refreshes immediately.

### 5.7 Visual style editor

- Hover in the preview highlights the element; click selects it.
- A panel shows the most useful properties for that element type (width, float/alignment, margins, captions, font size, etc.) and the Blend's **presets** for it (e.g. `fig-right`, `fig-full`, `fig-half`).
- In the Document Editor, every edit asks for a scope:
  1. **This element:** adds a class or id to the Markdown via attributes (`{.fig-right}`) and writes the rule to `overrides.css`.
  2. **All like this in this Brew:** writes an element rule to `overrides.css`.
- In the Blend Editor, the same panel writes to the Blend's layer files instead (see §5.11).

### 5.8 Print features (Paged Media)

- Page size and margins from `brew.yaml` / Blend (Letter, A4, A5, half-letter).
- Automatic page numbers and total pages; Blend controls visibility and position.
- Running headers/footers (e.g. chapter title via `string-set`).
- Named pages: first page, chapter start, blank left pages.
- Table of contents with page numbers (`target-counter`).
- Footnotes, widow/orphan control, page-break controls.

### 5.9 Variables

Defined in `blend.yaml` (defaults) and `brew.yaml` (per document). Available in three places:

- Markdown: `{{machine.model}}`, `{{machine.serial}}`
- HTML templates: chapter title, chapter number, revision, date
- CSS: exposed as custom properties (e.g. `--accent-color`)

### 5.10 Chapters

- One Markdown file per chapter in `content/`, rendered in filename order (`01-…`, `02-…`).
- Each chapter file can carry front matter that feeds the chapter-opener template:

  ```markdown
  ---
  title: Escapement Adjustment
  number: 3
  template: chapter-opener   # optional; falls back to the Blend default
  ---
  ```

- Each file starts on a new page using the Blend's chapter named page.

### 5.11 Blend Editor (separate mode)

The app has two modes that share the same preview, inspector and editors but point at different files:

| | **Document Editor** | **Blend Editor** |
|---|---|---|
| Opens | A Brew | A Blend in the Library |
| Edits | Markdown, images, `brew.yaml`, `overrides.css` | Layer files, templates, `blend.yaml`, presets, fonts |
| Preview content | The Brew's own content | A **specimen** Brew (bundled sample with every element type) or any real Brew chosen as sample content |
| Inspector writes to | `overrides.css` | The Blend layer the user picks (tokens, base, components, page, templates) |
| Extra tools | Image drop | Token editor (colors, fonts, type scale), preset manager, page setup, version + changelog on save |

"Preview with a real Brew" covers the case where you discover a style while working on a document: open the Blend Editor, preview it with that document's content, make the change there.

The **specimen** is a built-in Brew that shows headings 1–6, body text, lists, tables, code, callouts, figures in every preset, footnotes, a chapter opener and a title page, so a Blend can be judged without a real document.

### 5.12 CLI

```
docubrew                          # start the app and open the browser
docubrew build <brew>             # export PDF
docubrew build <dir> --all        # batch export every Brew in a folder
docubrew pack <brew>              # export .brew
docubrew unpack <file.brew>       # import .brew
docubrew blend update <brew>      # pull the latest Library Blend into a Brew
```

---

## 6. Technology stack

| Concern | Choice |
|---|---|
| Runtime | Node.js (LTS) |
| Server | Fastify (or Express) — serves UI, file API, uploads |
| Live updates | chokidar + WebSocket (`ws`) |
| Markdown | markdown-it + markdown-it-attrs, -container, -footnote |
| Templates | Lightweight (Eta or Handlebars), filled from YAML |
| YAML | `yaml` package |
| Pagination | Paged.js (behind a renderer adapter) |
| PDF | Puppeteer (headless Chrome) loading the same preview page in print mode |
| Editor | CodeMirror 6 |
| Zip | `yazl`/`yauzl` or `archiver`/`extract-zip` |
| Front end | Vanilla JS (ES modules), no framework; Vite only as dev server and bundler (CodeMirror 6 needs one) |
| UI fonts | Inter Tight + Inter, self-hosted (`@fontsource`) so the app works offline |

Cross-platform from day one: all paths via Node's `path`/`os` modules, no shell commands, so it works on Windows and Linux.

Front-end structure without a framework: one small event-bus/store module for app state (open Brew, mode, selection, theme), and each panel (file tree, editor, preview, inspector) is a plain module with `mount()` and `update()` functions. Revisit only if the inspector's state handling gets painful.

---

## 6a. UI design

Same design language as joshkoiro.github.io: flat, grid-based, hairline rules, no shadows, almost no rounding, Swiss typography.

- **Type:** Inter Tight (600–700) for headings and the app title; Inter for UI and body. Tight negative tracking on large text; small uppercase letter-spaced labels for panel headings.
- **Color:** warm neutrals plus one signal color, used sparingly (selection highlight, active state, primary action).

  | Token | Light | Dark |
  |---|---|---|
  | `--bg` | `#f8f7f4` | `#151515` |
  | `--surface` | `#f1f0ec` | `#1e1e1d` |
  | `--ink` | `#111111` | `#ededeb` |
  | `--ink-soft` | `#5f5e5a` | `#a3a29d` |
  | `--rule` | `#dddcd6` | `#2f2f2d` |
  | `--accent` | `#e2231a` | `#ff4b40` |

- **Themes:** light and dark, following the OS by default with a manual toggle (`data-theme` on `<html>`, as on the site).
- **Layout:** a strict column grid — file tree │ editor │ preview │ inspector — with hairline dividers, panels collapsible so the preview can take the full width.
- **Preview canvas:** pages sit on the neutral `--bg-deep` background in both themes and always render in their real print colors (dark mode never inverts the document).
- **Restraint:** icons only where a label would be cluttered; text labels preferred.

---

## 7. Roadmap

| Phase | Delivers | Done when |
|---|---|---|
| **1. Core loop** | Workspace + Brew folders, Blend copy-in, layered CSS, markdown pipeline with chapter files, Paged.js preview, live refresh on any save, page numbers + headers/footers, PDF export, app shell in the UI design language, `typewriter-base` + `typewriter-sop` Blends | An SOP edited in VS Code refreshes in the browser and exports a clean PDF |
| **2. Editing** | CodeMirror editors, source-line mapping, scroll sync, image drag and drop, conflict prompts | A Brew can be built start to finish without leaving the browser |
| **3. Visual editor** | Hover/select, property panel, presets, two edit scopes (Document Editor) | Images can be placed and sized without opening CSS |
| **4. Templates, variables, Blend Editor** | Title page, chapter openers, TOC with page numbers, `{{variables}}`, Blend `extends`, out-of-date prompt with diff, Blend Editor mode with specimen, `typewriter-care` Blend | A care sheet for a new machine takes only a new `brew.yaml` |
| **5. Packaging & CLI** | `.brew` import/export, full CLI, batch builds | A `.brew` file round-trips to another machine and renders identically |

---

## 8. Deployment model

- **Now:** local only. `docubrew` starts a server bound to `127.0.0.1` and opens the default browser.
- **Later (optional):** server mode. Because all file access already goes through the server's API, network mode mainly adds a bind-address setting and authentication.

---

## 9. First documents (drive Phases 1–4)

1. **Repair SOP** (e.g. escapement adjustment) on the `typewriter-sop` Blend — multi-chapter, step lists, warnings, figures.
2. **Customer care sheet** shipped with a machine, on the `typewriter-care` Blend — short, variable-driven (model, serial, year, work done).

Both Blends extend a shared `typewriter-base` (brand tokens, fonts, base elements).

## 10. Open questions

1. **License for a public release.** Repo is currently GPL-3.0. Decide before any public or paid release (compatible with Paged.js, which is MIT).
