(function (root) {
  'use strict';

  const S = {
    // --- verified stable across many Web A builds ---
    VIEWER:        '#MediaViewer',
    ACTIVE_SLIDE:  '#MediaViewer .MediaViewerSlide--active',
    ACTIONS:       '#MediaViewer .MediaViewerActions',
    VIDEO:         '.MediaViewerContent .VideoPlayer video',
    IMAGE:         '.MediaViewerContent img',
    // --- starting points for heuristics; not relied upon ---
    RIGHT_COLUMN:  '#RightColumn',
    MIDDLE_HEADER: '#MiddleColumn .ChatInfo, #MiddleColumn .chat-info, #MiddleHeader'
  };

  const scroll = root.TGMD.scroll;
  const parseStreamUrl = root.TGMD.streamUrl.parseStreamUrl;

  const q  = (sel, ctx) => (ctx || document).querySelector(sel);
  const qa = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  // ---------------------------------------------------------------- viewer
  const viewer = {
    isOpen: () => !!q(S.VIEWER),

    activeSlide: () => q(S.ACTIVE_SLIDE),

    mediaEl() {
      const slide = viewer.activeSlide();
      if (!slide) return null;
      const video = q(S.VIDEO, slide);
      if (video) return { el: video, kind: 'video' };
      // Exclude the blurred low-res backdrop Telegram paints behind the photo:
      // it is always the smaller of the images present.
      const imgs = qa(S.IMAGE, slide)
        .filter((i) => i.src && !i.src.startsWith('data:'))
        .sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
      return imgs.length ? { el: imgs[0], kind: 'image' } : null;
    },

    descriptor() {
      const found = viewer.mediaEl();
      if (!found) return null;
      const url = found.kind === 'video'
        ? (found.el.currentSrc || found.el.src)
        : found.el.src;
      if (!url) return null;

      const meta = parseStreamUrl(url) || {};
      return {
        url,
        kind: found.kind,
        mime: meta.mimeType || (found.kind === 'video' ? 'video/mp4' : 'image/jpeg'),
        originalName: meta.fileName || null,
        size: typeof meta.size === 'number' ? meta.size : null
      };
    },

    advance() { sendKey('ArrowRight'); },
    close()   { sendKey('Escape'); }
  };

  function sendKey(key) {
    const init = { key: key, code: key, bubbles: true, cancelable: true };
    document.dispatchEvent(new KeyboardEvent('keydown', init));
    document.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  // ------------------------------------------------------------------ grid
  const grid = {
    // The shared-media grid is the largest scrollable region inside the right
    // column. Class names are hashed, so it is identified by behaviour.
    container() {
      const rc = q(S.RIGHT_COLUMN);
      if (!rc) return null;
      const candidates = qa('*', rc).filter((el) => {
        const cs = getComputedStyle(el);
        return scroll.isScrollable({
          overflowY: cs.overflowY,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight
        });
      });
      if (!candidates.length) return null;
      return candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    },

    // Tiles are anything that renders media. Video thumbnails are kept — the
    // tile is only a click target; real bytes come from the viewer.
    tiles() {
      const c = grid.container();
      if (!c) return [];
      const seen = new Set();
      const out = [];
      for (const el of qa('img, video, [style*="background-image"]', c)) {
        const tile = el.closest('[class*="Media"], a, div') || el;
        if (seen.has(tile)) continue;
        seen.add(tile);
        out.push(tile);
      }
      return out;
    }
  };

  // ------------------------------------------------------------------ chat
  const chat = {
    id: () => root.TGMD.dedupe.chatIdFromHash(location.hash),

    title() {
      const header = q(S.MIDDLE_HEADER);
      if (header) {
        const text = (header.textContent || '').trim().split('\n')[0].trim();
        if (text) return text;
      }
      const t = (document.title || '').replace(/^\(\d+\)\s*/, '').trim();
      return t || 'Telegram';
    }
  };

  // ------------------------------------------------------------- diagnostics
  function describe(el) {
    return {
      tag: el.tagName.toLowerCase(),
      className: typeof el.className === 'string' ? el.className.slice(0, 120) : '',
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight
    };
  }

  function probe() {
    const slide = viewer.activeSlide();
    const container = grid.container();
    const media = viewer.mediaEl();
    return {
      viewerOpen:      viewer.isOpen(),
      activeSlide:     !!slide,
      actionsBar:      !!q(S.ACTIONS),
      mediaEl:         media ? media.kind : null,
      descriptor:      viewer.descriptor(),
      gridContainer:   container ? describe(container) : null,
      gridTileCount:   grid.tiles().length,
      rightColumn:     !!q(S.RIGHT_COLUMN),
      chatId:          chat.id(),
      chatTitle:       chat.title(),
      selectorsUsed:   S
    };
  }

  root.TGMD = root.TGMD || {};
  root.TGMD.selectors = { viewer: viewer, grid: grid, chat: chat, probe: probe, S: S };
})(typeof globalThis !== 'undefined' ? globalThis : self);
