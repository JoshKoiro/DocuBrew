// The file open in the editor: loading, autosave, external changes and conflicts.
//
// Saving sends the modification time we loaded. If the file changed on disk since (VS Code saved it),
// the server refuses and we ask: keep mine or use the disk version.
import { api } from './api.js';

const AUTOSAVE_MS = 600;

export function createSession(editor, ui) {
  let file = null;      // { path, mtime, readOnly }
  let dirty = false;
  let conflict = null;  // { content, mtime } from disk
  let timer = null;
  let saving = null;    // in-flight save promise

  function status(text, kind = '') { ui.status(text, kind); }

  async function open(path, { line } = {}) {
    if (file?.path === path) {
      if (line) editor.goToLine(line);
      return;
    }
    await flush();
    const data = await api.file(path);
    file = { path: data.path, mtime: data.mtime, readOnly: data.readOnly };
    dirty = false;
    conflict = null;
    ui.conflict(null);
    editor.load(data);
    status(data.readOnly ? data.readOnlyReason || 'Read-only · edit the Library Blend' : 'Saved', data.readOnly ? 'is-readonly' : '');
    ui.opened(file);
    if (line) editor.goToLine(line);
  }

  function changed() {
    if (!file || file.readOnly) return;
    dirty = true;
    ui.dirty(file.path, true);
    if (conflict) return; // wait for the user's decision
    status('Unsaved', 'is-dirty');
    clearTimeout(timer);
    timer = setTimeout(save, AUTOSAVE_MS);
  }

  async function save({ force = false } = {}) {
    clearTimeout(timer);
    if (!file || file.readOnly || (!dirty && !force)) return;
    if (conflict && !force) return;
    if (saving) { await saving; if (!dirty) return; }
    const content = editor.value();
    const target = file;
    status('Saving…', 'is-dirty');
    saving = api
      .saveFile(target.path, content, force ? null : target.mtime)
      .then((r) => {
        if (file !== target) return;
        file.mtime = r.mtime;
        conflict = null;
        ui.conflict(null);
        if (editor.value() === content) {
          dirty = false;
          ui.dirty(target.path, false);
          status('Saved');
        } else {
          timer = setTimeout(save, AUTOSAVE_MS); // typed while saving
        }
      })
      .catch((err) => {
        if (file !== target) return;
        if (err.data?.conflict) {
          conflict = { content: err.data.content, mtime: err.data.mtime };
          ui.conflict(target.path);
          status('Conflict', 'is-error');
        } else {
          status('Not saved', 'is-error');
          ui.error(err.message);
        }
      })
      .finally(() => { saving = null; });
    await saving;
  }

  /** Save now if there are pending edits (before switching files, exporting, etc.). */
  async function flush() {
    if (dirty && !conflict) await save();
    else if (saving) await saving;
  }

  /** Something changed this file on disk (our own save, or another editor). */
  async function externalChange(path) {
    if (!file || path !== file.path) return;
    if (saving) await saving;
    let data;
    try { data = await api.file(path); } catch { status('Deleted on disk', 'is-error'); return; }
    if (data.content === editor.value()) { file.mtime = data.mtime; return; }
    if (!dirty) {
      editor.replace(data.content);
      file.mtime = data.mtime;
      status('Reloaded from disk');
    } else {
      clearTimeout(timer);
      conflict = { content: data.content, mtime: data.mtime };
      ui.conflict(path);
      status('Conflict', 'is-error');
    }
  }

  async function resolve(choice) {
    if (!conflict || !file) return;
    if (choice === 'disk') {
      editor.replace(conflict.content);
      file.mtime = conflict.mtime;
      conflict = null;
      dirty = false;
      ui.dirty(file.path, false);
      ui.conflict(null);
      status('Using disk version');
    } else {
      conflict = null;
      ui.conflict(null);
      await save({ force: true });
    }
  }

  return {
    open,
    changed,
    save: () => save({ force: false }),
    flush,
    externalChange,
    resolve,
    close() { clearTimeout(timer); file = null; dirty = false; conflict = null; ui.conflict(null); },
    /** Load the open file again (e.g. it became editable or read-only). */
    async reload() {
      const p = file?.path;
      if (!p) return;
      clearTimeout(timer);
      file = null; dirty = false; conflict = null; ui.conflict(null);
      await open(p);
    },
    get file() { return file; },
    get dirty() { return dirty; },
  };
}
