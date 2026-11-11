// Open Brew and New Brew dialogs.
import { api } from './api.js';

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

// ─── Open Brew: DocuBrew's own folder browser (browsers can't see real paths) ───

export function createOpenDialog({ workspace, onOpen, onImport }) {
  const dlg = $('#dlg-open');
  const list = $('#fs-list');
  const input = $('#fs-path');
  const openBtn = $('#fs-open');
  let listing = null;
  let selected = null;

  async function go(path) {
    try {
      listing = await api.browse(path);
    } catch (err) {
      list.replaceChildren(el('li', { class: 'fs-empty' }, err.message));
      return;
    }
    input.value = listing.path;
    select(listing.isBrew ? { path: listing.path, isBrew: true, self: true } : null);
    const actOn = (e) => (e.type === 'brewfile' ? finishImport(e.path) : e.isBrew ? finish(e.path) : go(e.path));
    list.replaceChildren(
      ...(listing.entries.length
        ? listing.entries
            .map((e) =>
              el(
                'li',
                {
                  tabindex: 0,
                  role: 'option',
                  onclick: (ev) => { select(e); markSelected(ev.currentTarget); },
                  ondblclick: () => actOn(e),
                  onkeydown: (ev) => {
                    if (ev.key === 'Enter') actOn(e);
                  },
                },
                el('span', { class: `fs-name ${e.type === 'brewfile' ? 'is-file' : ''}` }, e.name),
                e.isBrew ? el('span', { class: 'tag' }, 'Brew') : e.type === 'brewfile' ? el('span', { class: 'tag tag-quiet' }, '.brew file') : null
              )
            )
        : [el('li', { class: 'fs-empty' }, 'No folders here.')])
    );
  }

  function markSelected(li) {
    list.querySelectorAll('.is-selected').forEach((n) => n.classList.remove('is-selected'));
    li.classList.add('is-selected');
  }

  function select(entry) {
    selected = entry;
    const isFile = entry?.type === 'brewfile';
    openBtn.disabled = !(entry && (entry.isBrew || isFile));
    openBtn.textContent = isFile ? 'Import' : entry && !entry.isBrew ? 'Not a Brew' : 'Open';
  }

  async function finishImport(path) {
    try {
      openBtn.disabled = true;
      openBtn.textContent = 'Importing…';
      await onImport(path);
      dlg.close();
    } catch (err) {
      $('#fs-hint').textContent = err.message;
      select(selected);
    }
  }

  async function finish(path) {
    try {
      await onOpen(path);
      dlg.close();
    } catch (err) {
      $('#fs-hint').textContent = err.message;
    }
  }

  $('#fs-up').onclick = () => listing?.parent && go(listing.parent);
  $('#fs-home').onclick = () => go(workspace());
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(input.value.trim()); } };
  openBtn.onclick = () => {
    if (selected?.type === 'brewfile') finishImport(selected.path);
    else if (selected?.isBrew) finish(selected.path);
  };

  return {
    show() {
      $('#fs-hint').textContent = 'Double-click a Brew to open it, or a .brew file to import it into your workspace.';
      dlg.showModal();
      go(workspace());
    },
  };
}

// ─── New Brew ───

export function createNewDialog({ onCreate }) {
  const dlg = $('#dlg-new');
  const form = $('#new-form');
  const error = $('#new-error');
  const picks = $('#blend-picks');
  // form.title is the form's own title attribute, so reach inputs through form.elements.
  const fields = { title: form.elements.namedItem('title'), folder: form.elements.namedItem('folder') };
  const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  fields.title.addEventListener('input', () => { fields.folder.placeholder = slug(fields.title.value) || 'escapement-adjustment'; });
  dlg.querySelector('[data-close]').onclick = () => dlg.close();

  form.onsubmit = async (e) => {
    e.preventDefault();
    error.hidden = true;
    const blend = form.querySelector('input[name="blend"]:checked')?.value;
    try {
      await onCreate({ title: fields.title.value, folder: fields.folder.value.trim() || undefined, blend });
      dlg.close();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  };

  return {
    async show() {
      form.reset();
      error.hidden = true;
      const blends = await api.blends();
      picks.replaceChildren(
        ...blends.map((b, i) =>
          el(
            'label',
            { class: 'blend-pick' },
            el('input', { type: 'radio', name: 'blend', value: b.id, checked: i === 0 }),
            el('span', { class: 'blend-pick-name' }, `${b.name} `, el('span', { class: 'list-sub', style: 'display:inline' }, b.version || '')),
            el('span', { class: 'blend-pick-desc' }, b.description || '')
          )
        )
      );
      dlg.showModal();
      fields.title.focus();
    },
  };
}

export { el };
