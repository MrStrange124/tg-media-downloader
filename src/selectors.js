(function (root) {
  'use strict';

  // Every selector below is taken from the Telegram Web A source
  // (github.com/Ajaxy/telegram-tt), not inferred from a rendered page:
  //   src/components/common/Media.tsx          -> grid tile
  //   src/components/right/Profile.tsx         -> tile id scheme
  //   src/components/mediaViewer/MediaViewer*  -> viewer, slides, video
  const S = {
    VIEWER:        '#MediaViewer',
    ACTIVE_SLIDE:  '#MediaViewer .MediaViewerSlide--active',
    ACTIONS:       '#MediaViewer .MediaViewerActions',
    // VideoPlayer.tsx gives the real player this id and sets src= directly.
    VIEWER_VIDEO:  '#media-viewer-video',
    CONTENT:       '.MediaViewerContent',
    IMAGE:         '.MediaViewerContent img',
    // Media.tsx: <div id={`shared-media${getMessageHtmlId(id)}`}
    //                 className="Media scroll-item">
    TILE:          '.Media.scroll-item',
    SCROLLER:      '.custom-scroll',
    RIGHT_COLUMN:  '#RightColumn',
    MIDDLE_HEADER: '#MiddleColumn .ChatInfo, #MiddleColumn .chat-info, #MiddleHeader'
  };

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

      // A real player always carries the id; the poster placeholder that
      // MediaViewerContent.renderVideoPreview() paints while the URL is still
      // resolving is a bare <video> with only a background-image.
      const video = q(S.VIEWER_VIDEO, slide) || q('video', slide);
      if (video) return { el: video, kind: 'video' };

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

      if (await attempt(() => history.back())) return true;
      return !viewer.isOpen();
    }
  };

  // VideoPlayer.tsx sets src= on the element. renderVideoPreview()'s
  // placeholder has none, which is a "still loading", not a failure.
  function videoUrl(v) {
    if (!v) return '';
    return v.currentSrc || v.src || '';
  }

  // Explains *why* no descriptor is available yet, so a timeout is not
  // misreported as "the viewer did not open".
  function mediaState() {
    if (!q(S.VIEWER)) return { stage: 'viewer-closed' };
    const slide = viewer.activeSlide();
    if (!slide) return { stage: 'viewer-open-no-active-slide' };

    const real = q(S.VIEWER_VIDEO, slide);
    const anyVideo = real || q('video', slide);
    if (anyVideo) {
      return {
        stage: videoUrl(anyVideo) ? 'ready'
             : real ? 'video-player-mounted-no-url'   // URL still resolving
                    : 'video-poster-only',            // slide not active yet
        isRealPlayer: !!real,
        readyState: anyVideo.readyState,
        networkState: anyVideo.networkState,
        spinner: !!q('.spinner-wrapper, .ProgressSpinner', slide),
        src: (anyVideo.currentSrc || anyVideo.src || '').slice(0, 80)
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
    // Tiles are matched directly. offsetParent filters out the inactive
    // Transition slides (other shared-media tabs stay mounted but hidden).
    tiles() {
      return qa(S.TILE).filter((el) => el.offsetParent !== null);
    },

    container() {
      const t = grid.tiles()[0];
      return t ? t.parentElement : null;
    },

    scroller() {
      const t = grid.tiles()[0];
      return t ? t.closest(S.SCROLLER) : null;
    },

    // The tile's own id — `shared-media` + `message-<messageId>`. Unique,
    // stable, and unaffected by virtualisation recycling the node, which is
    // exactly what a thumbnail URL was not.
    tileKey(tile) {
      return tile && tile.id ? tile.id : null;
    },

    byKey(key) {
      if (!key) return null;
      const el = document.getElementById(key);
      return el && el.offsetParent !== null ? el : null;
    },

    // Media.tsx renders <span class="video-duration"> only for videos, with
    // the literal text "GIF" for animations.
    tileKind(tile) {
      const d = tile && tile.querySelector('.video-duration');
      if (!d) return 'image';
      return (d.textContent || '').trim() === 'GIF' ? 'gif' : 'video';
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
    const container = grid.container();
    const scroller = grid.scroller();
    const tiles = grid.tiles();
    const media = viewer.mediaEl();
    return {
      viewerOpen:      viewer.isOpen(),
      activeSlide:     !!viewer.activeSlide(),
      actionsBar:      !!q(S.ACTIONS),
      mediaEl:         media ? media.kind : null,
      descriptor:      viewer.descriptor(),
      mediaState:      mediaState(),
      gridContainer:   container ? describe(container) : null,
      gridScroller:    scroller ? describe(scroller) : null,
      gridTileCount:   tiles.length,
      sampleTiles:     tiles.slice(0, 5).map((t) => ({ id: t.id, kind: grid.tileKind(t) })),
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
