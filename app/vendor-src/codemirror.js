// Entry point for the CodeMirror bundle. Rebuild with: npm run build:vendor
// Output: app/vendor/codemirror.js (committed, so running DocuBrew needs no build step).
export { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, placeholder } from '@codemirror/view';
export { EditorState, Compartment, StateEffect, StateField } from '@codemirror/state';
export { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
export { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
export { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
export { markdown, markdownLanguage } from '@codemirror/lang-markdown';
export { css } from '@codemirror/lang-css';
export { yaml, yamlFrontmatter } from '@codemirror/lang-yaml';
export { tags } from '@lezer/highlight';
