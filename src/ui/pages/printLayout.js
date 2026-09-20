// Settings page: the paperstamp designer.
// The iframe is the whole page — no picker, no close button. Leaving drops
// the embed so the next visit starts fresh.

import { PS } from '../../print/ps.js';

export function mount() {
  const host = document.getElementById('print-layout-ps-host');
  PS.mount(host, {
    autoShow: false,
    openDesignerOnReady: true,
    seedDefaultOnReady: true,
  });
}

export function unmount() {
  PS.reset();
}
