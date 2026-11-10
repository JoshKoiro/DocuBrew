# Decisions Log

Short records of decisions that shape DocuBrew. Newest first. Each entry: context, decision, consequences.

---

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
