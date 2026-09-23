// paperstamp lifecycle manager.
// One embed() per host element. Host elements live on Billing and Settings
// pages; router moves the SINGLETON host between pages (never destroys it)
// so preview state survives navigation. Recreate = call reset() explicitly.
//
// Class shape: the PaperStamp handle, the current host, ready flag, queued
// jobs and pending callbacks all live on the instance. External code uses the
// default instance (`import ps from './ps.js'; ps.print(...)`).

import { defaultLayoutDef } from './defaultLayout.js';

const LS_SELECTED = 'tokenBook.selectedLayoutId';

class Paperstamp {
  constructor() {
    this._lp = null; // current PaperStamp instance
    this._currentHost = null; // element the iframe lives in
    this._ready = false;
    this._layoutDefs = {}; // name -> layoutDef, from listLayoutDefs()
    this._activeLayoutId = localStorage.getItem(LS_SELECTED) || '';
    this._pending = []; // queued jobs while !ready
    this._printDoneCbs = []; // one-shot callbacks fired after each print completes
  }

  _statusEl() {
    return document.getElementById('ps-status');
  }

  _setStatus(text) {
    const el = this._statusEl();
    if (el) el.textContent = 'paperstamp: ' + text;
  }

  activeLayoutDef() {
    return this._layoutDefs[this._activeLayoutId] || null;
  }

  selectedLayoutId() {
    return this._activeLayoutId;
  }

  setSelectedLayoutId(id) {
    this._activeLayoutId = id || '';
    localStorage.setItem(LS_SELECTED, this._activeLayoutId);
  }

  // Ask the plugin for its saved layouts. cb(map) where map = {name: layoutDef}.
  listLayouts(cb) {
    if (!this._lp) {
      if (cb) cb({});
      return;
    }
    if (!this._ready) {
      this._pending.push({ kind: 'listLayouts', cb });
      return;
    }
    this._lp.listLayoutDefs((map) => {
      this._layoutDefs = map || {};
      if (this._activeLayoutId && !this._layoutDefs[this._activeLayoutId]) {
        this._activeLayoutId = '';
      }
      if (cb) cb(this._layoutDefs);
    });
  }

  // If the plugin has no saved layouts, register the default and select it.
  // register() persists a NAMED layout (and re-emits `ready`); import() would
  // only set in-memory state, so it would never show up in the layout list.
  seedDefaultIfEmpty(cb) {
    if (!this._lp || !this._ready) {
      if (cb) cb(false);
      return;
    }
    const syncActive = () => {
      if (this._activeLayoutId && this._layoutDefs[this._activeLayoutId]) return;
      const first = Object.keys(this._layoutDefs)[0];
      if (first) this.setSelectedLayoutId(first);
    };
    if (Object.keys(this._layoutDefs).length === 0) {
      // register() persists a NAMED layout and re-emits `ready`. import()
      // only sets in-memory state (not saved), so it wouldn't appear.
      this._lp.register(defaultLayoutDef());
      this._lp.listLayoutDefs((map) => {
        this._layoutDefs = map || {};
        syncActive();
        if (cb) cb(true);
      });
      return;
    }
    syncActive();
    if (cb) cb(false);
  }

  // Mount (or remount) the paperstamp iframe into hostEl.
  mount(
    hostEl,
    { force = false, autoShow = true, openDesignerOnReady = false, seedDefaultOnReady = false } = {}
  ) {
    if (!hostEl) return;
    if (typeof window.PaperStamp === 'undefined') {
      this._setStatus('SDK not loaded');
      return;
    }
    if (this._lp && this._currentHost === hostEl && !force) return;

    if (this._lp) {
      try {
        this._lp.destroy();
      } catch {}
      this._lp = null;
      this._ready = false;
    }

    document.querySelectorAll('.ps-host').forEach((h) => {
      if (h !== hostEl) h.replaceChildren();
    });

    this._currentHost = hostEl;
    hostEl.replaceChildren();
    this._lp = window.PaperStamp.embed({
      container: hostEl,
      origin: location.origin,
      width: '100%',
      height: '100%',
      autoShow,
      onReady: () => {
        this._ready = true;
        this._setStatus('ready');
        this.listLayouts(() => {
          const after = () => {
            this.flush();
            if (
              openDesignerOnReady &&
              this._activeLayoutId &&
              this._layoutDefs[this._activeLayoutId]
            ) {
              this._lp.setDesignerLayout(this._activeLayoutId);
              return;
            }
            if (openDesignerOnReady) this._lp.openDesigner();
          };
          if (seedDefaultOnReady) {
            this.seedDefaultIfEmpty(after);
            return;
          }
          after();
        });
      },
      onDone: () => {
        this._setStatus('print done');
        const cbs = this._printDoneCbs.splice(0);
        for (const cb of cbs) {
          try {
            cb();
          } catch (e) {
            console.error('ps print done cb', e);
          }
        }
      },
      onError: (err) => {
        this._setStatus('error: ' + err.code);
        console.error('paperstamp', err);
      },
    });
    this._lp.on('error', (err) => {
      this._setStatus('error: ' + err.code);
      console.error('paperstamp', err);
    });
  }

  flush() {
    while (this._pending.length) {
      const job = this._pending.shift();
      try {
        if (job.kind === 'print') this._lp.print(job.payload);
        else if (job.kind === 'preview') this._lp.preview(job.payload);
        else if (job.kind === 'previewById')
          this._lp.previewById(job.layoutId, job.fieldValues, job.options);
        else if (job.kind === 'printById')
          this._lp.printById(job.layoutId, job.fieldValues, job.options);
        else if (job.kind === 'designer') this._lp.openDesigner();
        else if (job.kind === 'closeDesigner') this._lp.closeDesigner();
        else if (job.kind === 'listLayouts') this.listLayouts(job.cb);
      } catch (e) {
        console.error('ps.flush', e);
      }
    }
  }

  // Live preview of the active layout. keepZoom preserves the plugin's
  // current zoom/pan so typing in the form doesn't reset the view to Fit.
  preview(fieldValues, opts) {
    if (!this._lp) return;
    if (!this._activeLayoutId || !this._layoutDefs[this._activeLayoutId]) return;
    const options = { keepZoom: true, ...(opts || {}) };
    if (!this._ready) {
      this._pending.push({
        kind: 'previewById',
        layoutId: this._activeLayoutId,
        fieldValues,
        options,
      });
      return;
    }
    this._lp.previewById(this._activeLayoutId, fieldValues, options);
  }

  print(fieldValues, onPrinted) {
    if (!this._lp) {
      this._setStatus('iframe not mounted');
      return;
    }
    if (!this._activeLayoutId || !this._layoutDefs[this._activeLayoutId]) {
      this._setStatus('no layout selected');
      return;
    }
    if (typeof onPrinted === 'function') this._printDoneCbs.push(onPrinted);
    const options = { silent: false };
    if (!this._ready) {
      this._pending.push({
        kind: 'printById',
        layoutId: this._activeLayoutId,
        fieldValues,
        options,
      });
      return;
    }
    this._lp.printById(this._activeLayoutId, fieldValues, options);
  }

  openDesigner() {
    if (!this._lp) {
      this._setStatus('iframe not mounted');
      return;
    }
    if (!this._ready) {
      this._pending.push({ kind: 'designer' });
      this._setStatus('designer pending');
      return;
    }
    this._lp.openDesigner();
    this._setStatus('designer open');
  }

  closeDesigner() {
    if (!this._lp) return;
    if (!this._ready) {
      this._pending.push({ kind: 'closeDesigner' });
      return;
    }
    this._lp.closeDesigner();
    this._setStatus('ready');
  }

  // Destroy current embed. Next mount() will create a fresh iframe.
  reset() {
    if (this._lp) {
      try {
        this._lp.destroy();
      } catch {}
      this._lp = null;
    }
    this._currentHost = null;
    this._ready = false;
    this._pending.length = 0;
    this._setStatus('idle');
  }
}

const ps = new Paperstamp();

export default ps;
export { Paperstamp };
