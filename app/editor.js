// CodeMirror wrapper: one editor view, reused for whichever Brew file is open.
import {
  EditorView, EditorState, Compartment, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, highlightSpecialChars, defaultKeymap, history, historyKeymap, indentWithTab,
  syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, searchKeymap, highlightSelectionMatches,
  markdown, markdownLanguage, css, yaml, yamlFrontmatter, tags as t,
} from './vendor/codemirror.js';

// Colors come from the app's CSS variables, so the editor follows light/dark automatically.
const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--ink)', backgroundColor: 'var(--bg)', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { padding: '14px 0 40vh', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 18px 0 10px' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--ink-faint)', border: 'none', borderRight: '1px solid var(--rule)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px', minWidth: '40px', fontSize: '11px' },
  '.cm-activeLine': { backgroundColor: 'var(--surface)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--surface)', color: 'var(--ink)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--selection-match)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-panels': { backgroundColor: 'var(--surface)', color: 'var(--ink)', borderColor: 'var(--rule)' },
  '.cm-panels input, .cm-panels button': { font: 'inherit', fontSize: '12px' },
  '.cm-searchMatch': { backgroundColor: 'var(--selection-match)', outline: '1px solid var(--ink-faint)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--selection)' },
  '.cm-flash': { animation: 'cm-flash 1.2s ease-out' },
  '.cm-dropCursor': { borderLeft: '2px solid var(--accent)' },
});

const highlight = HighlightStyle.define([
  { tag: [t.heading1, t.heading2], fontWeight: '700', color: 'var(--ink)' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '700', color: 'var(--ink)' },
  { tag: t.heading, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--ink-soft)', textDecoration: 'underline' },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: 'var(--ink-faint)' },
  { tag: [t.monospace], color: 'var(--accent)' },
  { tag: [t.quote], color: 'var(--ink-soft)', fontStyle: 'italic' },
  { tag: [t.keyword, t.definitionKeyword, t.modifier], color: 'var(--accent)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--ink)' },
  { tag: [t.definition(t.propertyName)], color: 'var(--ink)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--ink-soft)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color], color: 'var(--accent)' },
  { tag: [t.className, t.tagName, t.labelName], color: 'var(--ink)', fontWeight: '600' },
  { tag: [t.variableName, t.name], color: 'var(--ink)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--ink-faint)', fontStyle: 'italic' },
  { tag: [t.punctuation, t.separator, t.bracket, t.operator], color: 'var(--ink-faint)' },
  { tag: t.invalid, color: 'var(--accent)', textDecoration: 'underline wavy' },
]);

function languageFor(path) {
  if (/\.(md|markdown)$/i.test(path)) return yamlFrontmatter({ content: markdown({ base: markdownLanguage }) });
  if (/\.css$/i.test(path)) return css();
  if (/\.ya?ml$/i.test(path)) return yaml();
  return [];
}

/**
 * @param {HTMLElement} parent
 * @param {object} hooks { onChange(doc), onSave(), onScroll(topLine), onDropFiles(files, line) }
 */
export function createEditor(parent, hooks) {
  const language = new Compartment();
  const readOnly = new Compartment();
  const wrapping = new Compartment();
  let applyingExternal = false;

  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: '', extensions: base() }),
  });

  function base() {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      syntaxHighlighting(highlight),
      theme,
      language.of([]),
      readOnly.of(EditorState.readOnly.of(false)),
      wrapping.of(EditorView.lineWrapping),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { hooks.onSave?.(); return true; } },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !applyingExternal) hooks.onChange?.(u.state.doc.toString());
      }),
      EditorView.domEventHandlers({
        scroll: () => hooks.onScroll?.(topLine()),
        dragover(e) {
          if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
          return false;
        },
        drop(e, v) {
          if (!hasFiles(e)) return false;
          e.preventDefault();
          const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.doc.length;
          hooks.onDropFiles?.([...e.dataTransfer.files], v.state.doc.lineAt(pos).number);
          return true;
        },
      }),
    ];
  }

  function topLine() {
    const rect = view.scrollDOM.getBoundingClientRect();
    const pos = view.posAtCoords({ x: rect.left + rect.width / 2, y: rect.top + 8 }, false);
    return view.state.doc.lineAt(pos).number;
  }

  return {
    view,
    /** Show a file. Resets undo history so undo can't cross files. */
    load({ path, content, readOnly: ro }) {
      applyingExternal = true;
      view.setState(EditorState.create({ doc: content, extensions: base() }));
      view.dispatch({
        effects: [
          language.reconfigure(languageFor(path)),
          readOnly.reconfigure(EditorState.readOnly.of(Boolean(ro))),
          wrapping.reconfigure(/\.(md|markdown)$/i.test(path) ? EditorView.lineWrapping : []),
        ],
      });
      applyingExternal = false;
      view.scrollDOM.scrollTop = 0;
    },
    /** Replace the text (e.g. after an external save) keeping cursor and scroll as close as possible. */
    replace(content) {
      const scroll = view.scrollDOM.scrollTop;
      const head = Math.min(view.state.selection.main.head, content.length);
      applyingExternal = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, selection: { anchor: head } });
      applyingExternal = false;
      view.scrollDOM.scrollTop = scroll;
    },
    value: () => view.state.doc.toString(),
    topLine,
    /** Move the cursor to a 1-based line, scroll it near the top, and flash it. */
    goToLine(n) {
      const line = view.state.doc.line(Math.max(1, Math.min(n, view.state.doc.lines)));
      view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 60 }) });
      view.focus();
      flashLine(line.number);
    },
    /** Insert text as its own paragraph after a 1-based line (0 = top of file). Returns the line it starts on. */
    insertBlockAfter(lineNo, text) {
      const doc = view.state.doc;
      lineNo = Math.max(0, Math.min(lineNo, doc.lines));
      if (lineNo === 0) {
        view.dispatch({ changes: { from: 0, insert: `${text}\n\n` } });
        return 1;
      }
      // Exactly one blank line on each side of the new block.
      const at = doc.line(lineNo).to;
      const prevBlank = doc.line(lineNo).text.trim() === '';
      const nextLine = lineNo < doc.lines ? doc.line(lineNo + 1).text : null;
      const before = prevBlank ? '\n' : '\n\n';
      const after = nextLine === null ? '\n' : nextLine.trim() === '' ? '' : '\n';
      view.dispatch({ changes: { from: at, insert: `${before}${text}${after}` } });
      return lineNo + before.length;
    },
    focus: () => view.focus(),
  };

  function flashLine(n) {
    requestAnimationFrame(() => {
      const el = view.domAtPos(view.state.doc.line(n).from).node;
      const lineEl = (el.nodeType === 1 ? el : el.parentElement)?.closest('.cm-line');
      if (!lineEl) return;
      lineEl.classList.remove('cm-flash');
      void lineEl.offsetWidth;
      lineEl.classList.add('cm-flash');
    });
  }
}

function hasFiles(e) {
  return [...(e.dataTransfer?.types || [])].includes('Files');
}
