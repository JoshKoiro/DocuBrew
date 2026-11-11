# Decisions Log

Short records of decisions that shape DocuBrew. Newest first. Each entry: context, decision, consequences.

---

## D-030 · DocuBrew writes YAML without line folding
**Date:** 2026-11-11
**Context:** The YAML library folds lines at 80 characters by default, so recording the Blend in brew.yaml re-wrapped long titles.
**Decision:** Every YAML write uses `lineWidth: 0`. Files keep the line breaks their author chose.

## D-029 · Variable precedence: Blend defaults < brew.yaml fields < brew.yaml variables
**Date:** 2026-11-11
**Context:** A Blend default `author: ""` was overriding `author:` in brew.yaml.
**Decision:** Blend `variables` are defaults only; brew.yaml's own fields (title, author …) and `variables` always win; CLI `--set`/`--data` win over all.

## D-028 · AI support is files and checks, not a built-in model
**Date:** 2026-11-11
**Context:** GitHub issue #1. Options were AI-ready files, an MCP server, or a chat panel calling an API.
**Decision:** Ship what works with any assistant and needs no API key: the AI guide (docs/AI-GUIDE.md, written into each workspace as AGENTS.md + CLAUDE.md and kept current unless edited), `docubrew check` (static + `--render` overflow, `--json`), and `docubrew context` / **Copy AI context**. The MCP server is issue #3.
**Consequences:** An assistant can learn the formats, write files, and verify its own work with one command. Blend introspection (classes, tokens, presets, template fields) is shared by check and context.

## D-027 · Lead-ins instead of ::first-line
**Date:** 2026-11-11
**Context:** Paged.js drops `::first-line` rules, so books couldn't set the opening line in small capitals.
**Decision:** The renderer gives each chapter's first paragraph class `chapter-first`; `markdown.leadIn: N` in a Blend wraps the first N words in `.lead-in`.

## D-026 · Script markup is opt-in per Blend
**Date:** 2026-11-11
**Decision:** Fountain-style dialogue (NAME IN CAPITALS paragraphs → `.dialogue`, parenthesised lines → `.parenthetical`, parenthesised paragraphs → `.stage-direction`) only applies when a Blend sets `markdown: { script: true }` (Stage Play does). brew.yaml's `markdown:` can override.
**Consequences:** Ordinary documents never have capitalised lines turned into dialogue.

## D-025 · Titles may use variables
**Date:** 2026-11-11
**Decision:** `title` and `subtitle` in brew.yaml may contain `{{ variable }}` placeholders, filled after any CLI overrides.
**Consequences:** One care-sheet Brew can title each batch PDF after its machine; the sidebar shows the title filled from brew.yaml's own variables.

## D-024 · Batch builds merge records over brew.yaml variables
**Date:** 2026-11-11
**Decision:** `docubrew build` takes `--data` (CSV with a header row, YAML or JSON list) for one PDF per record, `--set key=value` for overrides, `--name` for file-name patterns and `--out-dir`. Dotted CSV headers become nested variables; YAML-looking values (`[a, b]`, numbers) are parsed. File names use raw values and drop characters Windows doesn't allow.
**Consequences:** Generating many documents needs no code. Kept in the CLI for now; the app previews brew.yaml's own values.

## D-023 · .brew format and safe import
**Date:** 2026-11-11
**Decision:** A `.brew` is a zip with `manifest.json` (`format: docubrew-brew`, `formatVersion: 1`, name, title, Blend, DocuBrew version) and the Brew's files, minus `dist/`, `.git` and tool folders. Import checks everything before writing: no absolute, drive-letter or `..` paths; at most 5,000 files and 1 GB unpacked; refuses newer format versions. It always creates a new folder (`name-2` on a clash) and never overwrites. A Brew whose Blend isn't in the Library renders from its copy and can add it to the Library ("adopt").
**Consequences:** A received .brew can't write outside the workspace or replace existing work. Export goes to the Brew's `dist/`, which is excluded from packing, so exports never nest.

## D-022 · Bundled Blends are never overwritten automatically; `blend reset` restores them
**Date:** 2026-11-11
**Decision:** New DocuBrew releases don't change a workspace's Library. `docubrew blend reset <id>` replaces a Library Blend with the bundled version; Brews then see the normal update prompt.
**Consequences:** Library edits are safe from upgrades. Picking up improvements to bundled Blends is an explicit step.

## D-021 · Releases are explicit; out-of-date detection is by content hash
**Date:** 2026-11-11
**Context:** With autosave, bumping a version on every save would be noise.
**Decision:** Brews compare content hashes (`blend.hash`, and `blend.copyHash` for hand edits to the copy), so any Library change is detected. **Release version…** is how a change gets a version number and a changelog entry (patch / minor / major).
**Consequences:** The update banner can say "changed since 1.0.0" before a release, and "1.1.0 is available" after.

## D-020 · Blend Editor previews a live flattened copy
**Date:** 2026-11-11
**Decision:** In the Blend Editor the server flattens the Blend (and everything it extends) into a temp folder on every change, and renders the specimen or a chosen Brew's content with it. Every layer is listed; missing layers are created on first save. The inspector writes "All …" rules to a chosen layer's managed section — there's no "this element" in a Blend.
**Consequences:** Editing a base Blend live-updates every Blend built on it in the preview.

## D-019 · Table of contents from headings, page numbers from CSS
**Date:** 2026-11-11
**Decision:** `toc:` in brew.yaml (or blend.yaml) renders a contents section from chapter titles and headings; every heading gets an id. Page numbers come from `target-counter(attr(href), page)` in the Blend's CSS. A Blend may supply `templates/toc.html`.

## D-018 · Attributes on lists and tables go on their own line after a blank line
**Date:** 2026-11-10
**Context:** markdown-it-attrs reads `{.spec}` directly under a table as an extra table row.
**Decision:** For lists and tables, DocuBrew writes a blank line, then `{#id .class}` on its own line. Headings, paragraphs and figures get attributes at the end of their last line.
**Consequences:** The sample SOP's spec table was fixed to this form. Workspaces seeded before this change still have the old sample.

## D-017 · Inspector: presets in Markdown, properties in a managed section of overrides.css
**Date:** 2026-11-10
**Decision:**
- Blend presets are applied as classes in the Markdown (`{.fig-right}`), so the consistent choice adds no CSS.
- Property edits go to a marked section of `overrides.css`; everything outside it is the author's and is never rewritten.
- "This element" adds a readable id to the Markdown on first edit (`{#fig-type-basket}`, `{#h-definitions}`) and styles that id; "All …" styles an element selector (`figure`, `p`, `h2`, `.callout-warning`, `.co-title`).
- Template elements (title page, chapter openers) can only be styled by class.
- Each new selection starts at "This element".
**Consequences:** Every visual edit is visible and editable as plain text. Carrying "All …" between selections was tried and rejected — it silently restyled every element of the next kind clicked.

## D-016 · Dropped images are linked relative to content/
**Date:** 2026-11-10
**Decision:** Images dropped into the app are saved to `images/` and written as `![Alt](../images/name.png)`. The renderer accepts both content-relative and Brew-relative paths.
**Consequences:** The same Markdown previews correctly in VS Code and other editors. Identical re-drops reuse the existing file; a different file with the same name becomes `name-2.png`.

## D-015 · Autosave with modification-time conflict check
**Date:** 2026-11-10
**Context:** Files are edited both in the browser and in external editors.
**Decision:** The browser editor autosaves 600 ms after typing stops. Each save sends the file's modification time as loaded; if the file changed on disk since, the server refuses (409) and the app asks *Keep mine* / *Use disk version*. Unchanged buffers reload silently on external saves.
**Consequences:** No lost edits from either side, and no save button to forget. The conflict window is small because of autosave.

## D-014 · esbuild pre-bundle instead of Vite (revises D-010)
**Date:** 2026-11-10
**Decision:** CodeMirror 6 is bundled once with esbuild into `app/vendor/codemirror.js`, which is committed. No dev server.
**Consequences:** `npm start` runs the app straight from source files; esbuild and CodeMirror are dev dependencies only needed to rebuild the bundle (`npm run build:vendor`).

## D-013 · Running values come from a hidden element in the first section
**Date:** 2026-11-10
**Context:** Page headers/footers need document values (title, SOP number, revision), but CSS margin boxes can't read variables. Paged.js supports `string-set`.
**Decision:** The renderer places a visually hidden `.db-running` element inside the first section: the document title plus the Blend's optional `templates/running.html`. Blend CSS uses `string-set` on its children; margin boxes use `string(name)`.
**Consequences:** Any variable can reach a header or footer through the template. The element must sit inside a section; outside one it creates a blank page when the title page uses a named page.

## D-012 · Tiny built-in template engine
**Date:** 2026-11-10
**Decision:** Blend templates use a ~70-line engine (`{{ }}`, `{{{ }}}`, `#if/else`, `#each`) instead of Eta or Handlebars.
**Consequences:** No dependency and nothing to learn beyond the four tags. Swap for a real engine if templates outgrow it; the syntax is Handlebars-compatible for these cases.

## D-011 · UI follows the joshkoiro.github.io design language
**Date:** 2026-11-10
**Decision:** Flat, grid-based, hairline rules, no shadows; Inter Tight + Inter (self-hosted for offline use); warm neutrals plus one red signal color; light and dark themes following the OS with a manual toggle. The document preview always shows real print colors.

## D-010 · Vanilla JS front end
**Date:** 2026-11-10
**Decision:** No front-end framework. Plain ES modules with a small shared store; Vite only as dev server and bundler (needed for CodeMirror 6).
**Consequences:** Less tooling to maintain. Revisit only if the inspector's state handling becomes painful.

## D-009 · One Markdown file per chapter
**Date:** 2026-11-10
**Decision:** Chapters are files in `content/`, rendered in filename order. Front matter in each file (title, number, optional template) feeds the chapter-opener template. Each file starts on a new page.

## D-008 · Separate Blend Editor mode; no "Promote to Blend"
**Date:** 2026-11-10
**Context:** Editing Library Blends from inside a document blurs the line between document edits and shared design.
**Decision:** The app has two modes sharing the same preview, inspector and editors. The Document Editor writes only to the Brew (`overrides.css`, content, `brew.yaml`); the Brew's Blend copy is read-only there. The Blend Editor edits Library Blends, previewing them against a built-in specimen Brew or any real Brew's content. Saving bumps the Blend version and Brews get the out-of-date prompt with a diff.
**Consequences:** Library updates can never overwrite document edits. Styles discovered while writing a document are applied by opening the Blend Editor with that document as the preview content.

## D-007 · Brews are recognized by `brew.yaml`, Library lives in `Blends/`
**Date:** 2026-11-10
**Context:** Brews are saved directly inside the workspace folder, next to the Blend Library.
**Decision:** Any folder containing `brew.yaml` is a Brew. `Blends/` is a reserved folder name for the Library.
**Consequences:** No separate `Brews/` folder is needed and names can't collide in practice.

## D-006 · Separate Open and Import commands
**Date:** 2026-11-10
**Context:** Users open existing Brew folders and also receive `.brew` files from others.
**Decision:** "Open Brew…" browses folders; "Import .brew…" unzips a file into the workspace as a new Brew. Both start in the workspace but can navigate anywhere. Name clashes prompt for a new name.
**Consequences:** File browsing is DocuBrew's own UI backed by the server's file-system API, since browsers can't expose real paths.

## D-005 · Default workspace is `~/Documents/DocuBrew/`
**Date:** 2026-11-10
**Decision:** Default to the user's Documents folder (Windows `%USERPROFILE%\Documents\DocuBrew\`), relocatable in settings.

## D-004 · Blends are copied into Brews, never live-linked
**Date:** 2026-11-10
**Context:** Shared styles must not silently change existing documents.
**Decision:** Creating a Brew copies (and flattens) its Blend into `brew/blend/`. `brew.yaml` records source, version and hash. When the Library Blend changes, the user is prompted to update. If the local copy was edited, the prompt warns and offers a diff first.
**Consequences:** Brews are self-contained and render identically forever, including when sent as `.brew` files. Per-document edits belong in `overrides.css`. (Revised by D-008: "Promote to Blend" dropped.)
**Alternatives considered:** Live-linking to the Library. Rejected: a Library change could silently break a document opened months later with no record of what changed.

## D-003 · `.brew` = zip of a Brew folder
**Date:** 2026-11-10
**Decision:** Folders are the working format. A `.brew` file is a zip with a `manifest.json` (format version, name), used for sending and archiving.
**Consequences:** Git-friendly day to day; single-file portability when needed.

## D-002 · Local, single-machine first
**Date:** 2026-11-10
**Decision:** The server binds to `127.0.0.1` and runs on the same computer as the browser. All file access still goes through the server API, so a network/server mode can be added later with auth.
**Consequences:** Personal tool now; public release possible later without re-architecture.

## D-001 · Paged.js for pagination
**Date:** 2026-11-10
**Context:** Paged.js (MIT) is mid-transition to a breaking 2.0; Vivliostyle is actively released but AGPL-3.0.
**Decision:** Use Paged.js now, behind a renderer adapter, and upgrade when 2.0 stabilizes.
**Consequences:** No license friction for a future public release. The adapter limits the blast radius of the 2.0 upgrade.
