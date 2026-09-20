// paperstamp lifecycle manager.
// One embed() per host element. Host elements live on Billing and Settings
// pages; router moves the SINGLETON host between pages (never destroys it)
// so preview state survives navigation. Recreate = call reset() explicitly.

import { defaultLayoutDef } from './defaultLayout.js';

const LS_SELECTED = 'aptList.selectedLayoutId';

let lp = null; // current PaperStamp instance
let currentHost = null; // element the iframe lives in
let ready = false;
let layoutDefs = {}; // name -> layoutDef, from listLayoutDefs()
let activeLayoutId = localStorage.getItem(LS_SELECTED) || '';
const pending = []; // queued jobs while !ready
const printDoneCbs = []; // one-shot callbacks fired after each print completes

function statusEl() {
  return document.getElementById('ps-status');
}

function setStatus(text) {
  const el = statusEl();
  if (el) el.textContent = 'paperstamp: ' + text;
}

function activeLayoutDef() {
  return layoutDefs[activeLayoutId] || null;
}

function selectedLayoutId() {
  return activeLayoutId;
}
function setSelectedLayoutId(id) {
  activeLayoutId = id || '';
  localStorage.setItem(LS_SELECTED, activeLayoutId);
}

// Ask the plugin for its saved layouts. cb(map) where map = {name: layoutDef}.
function listLayouts(cb) {
  if (!lp) {
    if (cb) cb({});
    return;
  }
  if (!ready) {
    pending.push({ kind: 'listLayouts', cb });
    return;
  }
  lp.listLayoutDefs((map) => {
    layoutDefs = map || {};
    if (activeLayoutId && !layoutDefs[activeLayoutId]) activeLayoutId = '';
    if (cb) cb(layoutDefs);
  });
}

// Push the default layout into the plugin if it has none saved.
function seedDefaultIfEmpty(cb) {
  if (!lp || !ready) {
    if (cb) cb(false);
    return;
  }
  const syncActive = () => {
    if (activeLayoutId && layoutDefs[activeLayoutId]) return;
    const first = Object.keys(layoutDefs)[0];
    if (first) setSelectedLayoutId(first);
  };
  lp.listLayoutDefs((map) => {
    layoutDefs = map || {};
    if (Object.keys(layoutDefs).length === 0) {
      lp.import(defaultLayoutDef());
      lp.listLayoutDefs((map2) => {
        layoutDefs = map2 || {};
        syncActive();
        if (cb) cb(true);
      });
      return;
    }
    syncActive();
    if (cb) cb(false);
  });
}

// Mount (or remount) the paperstamp iframe into hostEl.
function mount(
  hostEl,
  { force = false, autoShow = true, openDesignerOnReady = false, seedDefaultOnReady = false } = {}
) {
  if (!hostEl) return;
  if (typeof window.PaperStamp === 'undefined') {
    setStatus('SDK not loaded');
    return;
  }
  if (lp && currentHost === hostEl && !force) return;

  if (lp) {
    try {
      lp.destroy();
    } catch {}
    lp = null;
    ready = false;
  }

  document.querySelectorAll('.ps-host').forEach((h) => {
    if (h !== hostEl) h.replaceChildren();
  });

  currentHost = hostEl;
  hostEl.replaceChildren();
  lp = window.PaperStamp.embed({
    container: hostEl,
    origin: location.origin,
    width: '100%',
    height: '100%',
    autoShow,
    onReady: () => {
      ready = true;
      setStatus('ready');
      listLayouts(() => {
        const after = () => {
          flush();
          if (openDesignerOnReady && activeLayoutId && layoutDefs[activeLayoutId]) {
            lp.setDesignerLayout(activeLayoutId);
            return;
          }
          if (openDesignerOnReady) lp.openDesigner();
        };
        if (seedDefaultOnReady) {
          seedDefaultIfEmpty(after);
          return;
        }
        after();
      });
    },
    onDone: () => {
      setStatus('print done');
      const cbs = printDoneCbs.splice(0);
      for (const cb of cbs) {
        try {
          cb();
        } catch (e) {
          console.error('ps print done cb', e);
        }
      }
    },
    onError: (err) => {
      setStatus('error: ' + err.code);
      console.error('paperstamp', err);
    },
  });
  lp.on('error', (err) => {
    setStatus('error: ' + err.code);
    console.error('paperstamp', err);
  });
}

function flush() {
  while (pending.length) {
    const job = pending.shift();
    try {
      if (job.kind === 'print') lp.print(job.payload);
      else if (job.kind === 'preview') lp.preview(job.payload);
      else if (job.kind === 'previewById') lp.previewById(job.layoutId, job.fieldValues);
      else if (job.kind === 'printById') lp.printById(job.layoutId, job.fieldValues, job.options);
      else if (job.kind === 'designer') lp.openDesigner();
      else if (job.kind === 'closeDesigner') lp.closeDesigner();
      else if (job.kind === 'listLayouts') listLayouts(job.cb);
    } catch (e) {
      console.error('ps.flush', e);
    }
  }
}

function preview(fieldValues) {
  if (!lp) return;
  if (!activeLayoutId || !layoutDefs[activeLayoutId]) return;
  if (!ready) {
    pending.push({ kind: 'previewById', layoutId: activeLayoutId, fieldValues });
    return;
  }
  lp.previewById(activeLayoutId, fieldValues);
}

function print(fieldValues, onPrinted) {
  if (!lp) {
    setStatus('iframe not mounted');
    return;
  }
  if (!activeLayoutId || !layoutDefs[activeLayoutId]) {
    setStatus('no layout selected');
    return;
  }
  if (typeof onPrinted === 'function') printDoneCbs.push(onPrinted);
  const options = { silent: false };
  if (!ready) {
    pending.push({ kind: 'printById', layoutId: activeLayoutId, fieldValues, options });
    return;
  }
  lp.printById(activeLayoutId, fieldValues, options);
}

function openDesigner() {
  if (!lp) {
    setStatus('iframe not mounted');
    return;
  }
  if (!ready) {
    pending.push({ kind: 'designer' });
    setStatus('designer pending');
    return;
  }
  lp.openDesigner();
  setStatus('designer open');
}

function closeDesigner() {
  if (!lp) return;
  if (!ready) {
    pending.push({ kind: 'closeDesigner' });
    return;
  }
  lp.closeDesigner();
  setStatus('ready');
}

// Destroy current embed. Next mount() will create a fresh iframe.
function reset() {
  if (lp) {
    try {
      lp.destroy();
    } catch {}
    lp = null;
  }
  currentHost = null;
  ready = false;
  pending.length = 0;
  setStatus('idle');
}

export const PS = {
  mount,
  reset,
  preview,
  print,
  openDesigner,
  closeDesigner,
  listLayouts,
  seedDefaultIfEmpty,
  selectedLayoutId,
  setSelectedLayoutId,
  activeLayoutDef,
};
