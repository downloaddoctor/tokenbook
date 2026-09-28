// Shared keyboard list/table navigation. One factory, all list pages.
//
// Key model (identical everywhere):
//   - ArrowDown/Up move the highlight; the FIRST press highlights row 0.
//   - Header (search input) and footer (pager) handoff are OPTIONAL: they are
//     used only when configured, but row navigation always works.
//       ArrowUp on the first row   -> focus the search input (if configured)
//       ArrowDown past the last row -> focus the pager Next button (if enabled)
//       ArrowUp on the pager Next   -> reselect the last row
//   - Home/End jump to first/last.
//   - Enter/Space open the highlighted row (row 0 if none highlighted yet).
//   - The highlighted row is always scrolled into view.
//
// cfg: {
//   getRows,        // () => Element[]            (required)
//   getBody,        // () => Element|null         (required; list container)
//   activeClass,    // default 'active'
//   search,         // () => Element|null         (optional header handoff)
//   pagerPrev,      // () => Element|null         (optional footer)
//   pagerNext,      // () => Element|null         (optional footer)
//   isOpen,         // () => bool                 (optional gate)
//   canNav,         // (e) => bool                (optional guard)
//   onEnter,        // (row, index) => void|bool  (optional; false declines)
//   onEscape,       // (rows, active) => bool     (optional; false declines)
// }

import { highlightRow, clearHighlight } from './dom.js';

export function createListNav(cfg) {
  const getRows = cfg.getRows;
  const activeClass = cfg.activeClass || 'active';
  let active = -1;

  const search = () => (cfg.search ? cfg.search() : null);
  const pagerNext = () => (cfg.pagerNext ? cfg.pagerNext() : null);
  const pagerPrev = () => (cfg.pagerPrev ? cfg.pagerPrev() : null);

  const rowEls = () => getRows();

  function setActive(i) {
    active = highlightRow(rowEls(), i, activeClass);
    syncTabIndex();
  }

  function clear() {
    clearHighlight(rowEls(), activeClass);
    active = -1;
    syncTabIndex();
  }

  // Keep exactly one row in the Tab order: the active row, else row 0. Lets Tab
  // from the header/footer land on the first row instead of skipping the table.
  function syncTabIndex() {
    const rows = rowEls();
    const keep = active >= 0 ? active : 0;
    for (let i = 0; i < rows.length; i++) rows[i].tabIndex = i === keep ? 0 : -1;
  }

  // Move DOM focus onto the active row (only when the key came from inside the
  // body, so search-box typing keeps focus). Rows need tabindex to be focusable.
  function focusRow() {
    const rows = rowEls();
    const tr = rows[active];
    if (!tr) return;
    if (tr.tabIndex < 0) tr.tabIndex = -1;
    tr.focus({ preventScroll: true });
    tr.scrollIntoView({ block: 'nearest' });
  }

  function focusSearch() {
    const s = search();
    if (!s) return false;
    s.focus({ preventScroll: true });
    s.scrollIntoView({ block: 'nearest' });
    return true;
  }

  function focusNext() {
    const b = pagerNext();
    if (b && !b.disabled) {
      clear();
      b.focus();
      return true;
    }
    return false;
  }

  function keydown(e) {
    if (cfg.isOpen && !cfg.isOpen()) return;
    const rows = rowEls();
    if (!rows.length) return;
    if (cfg.canNav && !cfg.canNav(e)) return;

    const t = e.target;
    const nextBtn = pagerNext();
    const prevBtn = pagerPrev();
    const onPager =
      (nextBtn && document.activeElement === nextBtn) ||
      (prevBtn && document.activeElement === prevBtn);

    // Focus on a pager button: only ArrowUp (from Next) re-enters the list.
    if (onPager) {
      if (e.key === 'ArrowUp' && nextBtn && document.activeElement === nextBtn) {
        e.preventDefault();
        setActive(rows.length - 1);
        focusRow();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') return; // let the button act
    }

    const body = cfg.getBody ? cfg.getBody() : null;
    const fromBody = !!(t && body && body.contains(t));
    const move = () => {
      if (fromBody) focusRow();
    };

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (active >= rows.length - 1) {
        focusNext();
        return;
      }
      setActive(active < 0 ? 0 : active + 1);
      move();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (active <= 0) {
        // First row (or nothing highlighted): hand off to the search input if
        // one is configured; otherwise stay put.
        if (focusSearch()) clear();
        else setActive(0);
        return;
      }
      setActive(active - 1);
      move();
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
      move();
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      setActive(rows.length - 1);
      move();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const idx = active < 0 ? 0 : active;
      const row = rows[idx];
      if (row && cfg.onEnter) cfg.onEnter(row, idx);
      return;
    }
    if (e.key === 'Escape') {
      if (cfg.onEscape) {
        const handled = cfg.onEscape(rows, active);
        if (handled === false) return;
      }
      e.preventDefault();
    }
  }

  return {
    keydown,
    setActive,
    clear,
    refresh: syncTabIndex,
    rowEls,
    getActive: () => active,
    focusRow,
    focusSearch,
  };
}
