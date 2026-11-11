# DocuBrew — guide for AI assistants

You're working in a **DocuBrew workspace**: Markdown content plus layered CSS styles ("Blends"), rendered to print-ready PDF with Paged.js. Everything is plain files. Read this before writing content or CSS here.

**Always finish by running `docubrew check <brew-folder>`** (add `--render` to catch content overflowing the page) and fix what it reports. `docubrew context <brew-folder>` prints the Brew's settings, its Blend's available classes, presets and variables, and its chapters.

## Workspace layout

```
DocuBrew/                      ← workspace (usually ~/Documents/DocuBrew)
  AGENTS.md, CLAUDE.md         ← this guide
  Blends/<id>/                 ← the Blend Library: reusable styles
  <brew-folder>/               ← a Brew (document) = any folder with brew.yaml
    brew.yaml                  ← title, author, revision, date, variables, options
    content/NN-name.md         ← chapters, one file each, rendered in filename order
    images/                    ← images (link as ../images/name.png)
    overrides.css              ← styles for this document only
    blend/                     ← COPY of the Blend — managed by DocuBrew, never edit
    dist/                      ← exported PDFs and .brew files
```

## Rules

1. **Never edit a Brew's `blend/` folder.** It's a managed copy. Document-specific styles go in `overrides.css`; reusable styles go in the Library Blend (`Blends/<id>/`).
2. **Use what the Blend defines before inventing CSS.** Prefer its presets and classes (see `docubrew context`) so documents stay consistent.
3. **Keep `overrides.css` readable.** Write your own rules above the marked `DocuBrew visual edits` section, or inside it as simple `selector { prop: value; }` rules.
4. **Chapter files start with front matter** and are named `NN-slug.md` (`01-introduction.md`, `02-procedure.md` …).
5. **Write print CSS**, not screen CSS: units in pt/in/mm, no viewport units, no hover states, no `position: fixed` layouts.

## brew.yaml

```yaml
title: "Care Record — {{ machine.model }}"   # titles may use variables
subtitle: Optional
author: Name
revision: B
date: 2026-11-11
blend: { source: typewriter-sop, version: 1.1.0, hash: …, copyHash: … }  # written by DocuBrew — don't edit
toc: true                     # or { depth: 2, title: Contents }; default false
titlePage: false              # skip the Blend's title page
page:                         # optional: override the Blend's page setup
  size: letter                # letter | A4 | A5 | half-letter | "6in 9in" | "letter landscape"
  margin: 0.8in
markdown: { script: true }    # optional: override the Blend's Markdown options
variables:                    # anything; used as {{ path.to.value }}
  machine: { make: Royal, model: Safari, serial: "0000000" }
```

Variable precedence (lowest first): Blend `variables` defaults → brew.yaml fields (title, author…) → brew.yaml `variables` → CLI `--set` / `--data`.

## Chapter files

```markdown
---
title: Procedure          # gives the chapter the Blend's opener; omit for a plain page
summary: Optional line    # used by some openers
toc: false                # optional: leave out of the contents
template: none            # optional: no opener even with a title
class: wide               # optional: class on the chapter <section>
---

## Section heading
```

## Markdown

Standard Markdown (CommonMark + tables, smart quotes, autolinks, footnotes) plus:

| Write | Result |
|---|---|
| `{{ machine.serial }}` | Variable value (`\{{` writes it literally). Unknown variables stay visible — `docubrew check` flags them. |
| `## Title {#my-id .class}` | Attributes at the **end of the last line** of a heading, paragraph or image paragraph |
| table, then **a blank line**, then `{.spec}` on its own line | Attributes on a **table or list** (directly under a table it becomes a row — wrong) |
| `![Alt](../images/x.png "Caption")` | Numbered `<figure>` with caption |
| `![Alt](../images/x.png){.fig-right}` | Figure preset class (presets are listed per Blend) |
| `::: warning Optional title` … `:::` | Callout: `note` `tip` `important` `warning` `caution` `danger` |
| `::: name Optional title` … `:::` | `<div class="name">` — only useful if the Blend styles `.name` (e.g. `steps`, `tools`, `epigraph`, `cast`) |
| `text[^1]` … `[^1]: Note` | Footnote, listed at the end of the chapter |
| `<div class="page-break"></div>` | Force a new page |
| `[See Procedure](#chapter-2)` | Links: chapters are `#chapter-N`; headings get ids automatically |

Every heading gets an id. A chapter's first paragraph gets class `chapter-first`; Blends with `markdown.leadIn: N` wrap its first N words in `<span class="lead-in">`.

### Script markup (Blends with `markdown: { script: true }`, e.g. Stage Play)

```
HAMLET                       ← a paragraph whose first line is a NAME IN CAPITALS → dialogue
(aside)                      ← a line in parentheses inside dialogue → parenthetical
To be, or not to be.

(He draws his dagger.)       ← a paragraph entirely in parentheses → stage direction
```

Rendered as `.dialogue > .character, .parenthetical, .line` and `p.stage-direction`.

## Blends

```
Blends/<id>/
  blend.yaml        name, version, extends, description, page, variables, presets, markdown, toc, changelog
  fonts.css         @font-face only (not layered); font files in fonts/
  tokens.css        custom properties (colors, fonts, sizes) — change these first
  base.css          plain elements
  components.css    named pieces: callouts, figure presets, step lists …
  page.css          @page rules: margins, headers/footers, page numbers, named pages
  templates.css     title page, contents, chapter openers
  templates/        title-page.html, chapter-opener.html, toc.html, running.html (all optional)
```

- Write **plain CSS** in each layer file — DocuBrew wraps it in `@layer`. Order: `tokens, base, components, page, templates, document` (`overrides.css` is `document`, so it always wins without `!important`).
- `extends: <id>` builds on another Blend: each layer file is appended after the parent's, templates replace the parent's.
- Bump `version` and add a `changelog` entry when you change a Library Blend (the app's *Release version…* does this); Brews then offer an update.

### Templates

`{{ value }}` (escaped), `{{{ html }}}` (raw), `{{#if x}} … {{else}} … {{/if}}`, `{{#each list}} … {{ this.field }} … {{/each}}`. Available: every variable, plus `chapter.title`, `chapter.number`, `chapter.numberPadded` and any front-matter field in chapter openers, and `toc.title`, `toc.entries[] { text, href, level, levelClass, number }` in toc.html.

### Page CSS (Paged.js)

```css
@page { @bottom-right { content: counter(page) " / " counter(pages); } }
@page :left { margin-left: 0.6in; }  @page :right { margin-right: 0.6in; }
.chapter { page: chapter; break-before: page; }      /* or break-before: right for books */
@page chapter:first { @top-right { content: none; } }
.co-title { string-set: chapter-title content(text); }   /* then content: string(chapter-title) */
.toc-entry a::after { content: target-counter(attr(href), page); }
```

Header/footer values from variables: put elements in `templates/running.html` and `string-set` them.

**Paged.js pitfalls:**
- `::first-line` rules are dropped — use `.chapter-first` / `.lead-in` instead.
- Redefining a margin box another rule already set (`@bottom-left`) drops that rule's declarations — repeat font, size, color, alignment.
- Give headings with borders `break-inside: avoid`, or a sliver can be left at the foot of a page.
- `@media screen` rules don't apply; only print styles matter.
- Custom properties work inside margin boxes (`font-family: var(--font-body)`).

## Commands

```bash
docubrew check <brew> [--render] [--json]    # validate; --render also checks overflow in a real render
docubrew context <brew> [--content]          # settings + Blend reference (+ full chapter text) for an AI
docubrew build <brew>                        # PDF to <brew>/dist/
docubrew build <brew> --data list.csv --out-dir out --name "{{machine.serial}}"   # one PDF per record
docubrew new "Title" --blend <id>            # new Brew
docubrew list                                # Brews and Blends
```
