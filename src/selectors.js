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
      const url = found.kind === 'video' ? videoUrl(found.el) : found.el.src;
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

    // Closing must be verified, not assumed: synthetic KeyboardEvents carry
    // isTrusted:false and some handlers ignore them. Escalate until the
    // viewer is actually gone, because a stuck viewer swallows every
    // subsequent tile click.
    async close() {
      const nap = (ms) => new Promise((r) => setTimeout(r, ms));
      const attempt = async (fn) => {
        try { fn(); } catch (e) { /* keep escalating */ }
        await nap(350);
        return !viewer.isOpen();
      };

      if (!viewer.isOpen()) return true;
      if (await attempt(() => sendKey('Escape'))) return true;
      if (await attempt(() => {
        const init = { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true };
        window.dispatchEvent(new KeyboardEvent('keydown', init));
      })) return true;

      const btn = document.querySelector(
        '#MediaViewer button[aria-label*="Close" i], #MediaViewer button[title*="Close" i]');
      if (btn && await attempt(() => btn.click())) return true;

      // Web A pushes a history entry for the viewer.
      if (await attempt(() => history.back())) return true;

      return !viewer.isOpen();
    }
  };

  // A <video> that has not begun loading has empty currentSrc AND src; Web A
  // sometimes carries the URL on a child <source> instead.
  function videoUrl(v) {
    if (!v) return '';
    if (v.currentSrc) return v.currentSrc;
    if (v.src) return v.src;
    const source = v.querySelector && v.querySelector('source');
    return (source && source.src) || '';
  }

  // Explains *why* no descriptor is available, so a timeout does not get
  // misreported as "the viewer did not open".
  function mediaState() {
    const slide = viewer.activeSlide();
    if (!q(S.VIEWER)) return { stage: 'viewer-closed' };
    if (!slide) return { stage: 'viewer-open-no-active-slide' };
    const v = q(S.VIDEO, slide);
    if (v) {
      return {
        stage: videoUrl(v) ? 'ready' : 'video-present-no-url',
        readyState: v.readyState,
        networkState: v.networkState,
        hasSourceChild: !!(v.querySelector && v.querySelector('source')),
        currentSrc: (v.currentSrc || '').slice(0, 60),
        src: (v.src || '').slice(0, 60)
      };
    }
    const imgs = qa(S.IMAGE, slide).filter((i) => i.src && !i.src.startsWith('data:'));
    if (!imgs.length) return { stage: 'slide-present-no-media' };
    return { stage: 'ready', imgCount: imgs.length };
  }

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

    // One tile per media element. Walking up from the media element and
    // stopping before any ancestor that holds a second one prevents several
    // thumbnails collapsing onto a shared wrapper — closest() would pick the
    // nearest matching ancestor and silently merge them into one tile.
    tiles() {
      const c = grid.container();
      if (!c) return [];
      const out = [];
      const seenMedia = new Set();

      for (const media of qa('img, video', c)) {
        if (seenMedia.has(media)) continue;
        seenMedia.add(media);

        let el = media;
        for (let hop = 0; hop < 4; hop++) {
          const parent = el.parentElement;
          if (!parent || parent === c) break;
          if (parent.querySelectorAll('img, video').length > 1) break;
          el = parent;
        }
        out.push(el);
      }
      return out;
    },

    // Identity for a tile. The grid is virtualised, so element references go
    // stale across scrolling — this string does not.
    tileKey(tile) {
      if (!tile) return null;
      if (tile.tagName === 'IMG' && tile.src) return tile.src;
      const img = tile.querySelector && tile.querySelector('img');
      if (img && img.src) return img.src;
      const vid = tile.querySelector && tile.querySelector('video');
      if (vid && (vid.poster || vid.src)) return vid.poster || vid.src;
      try {
        const bg = getComputedStyle(tile).backgroundImage;
        if (bg && bg !== 'none') return bg;
      } catch (e) { /* detached node */ }
      return null;
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
  root.TGMD.selectors = { viewer: viewer, grid: grid, chat: chat, probe: probe,
                          mediaState: mediaState, S: S };
})(typeof globalThis !== 'undefined' ? globalThis : self);
