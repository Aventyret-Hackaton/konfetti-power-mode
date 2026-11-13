/*
 * Konfetti – Power Mode for claude.ai
 *
 * Every character typed into a prompt (the ProseMirror composer, or any
 * textarea such as the "edit message" box) is copied onto a full-screen
 * canvas, thrown into the air together with a burst of confetti, and falls
 * to the bottom of the screen. The confetti piles up higher and higher for as
 * long as you keep typing (blow it away, or reload the tab to sweep).
 *
 * "Super konfetti mode" (opt-in: a checkbox on the extension's options page)
 * adds three things:
 *  - The explosion happens a moment after the character was typed: a random
 *    delay between EXPLODE_DELAY_MIN and EXPLODE_DELAY_MAX, drawn for each
 *    character, but always in the order the characters were typed.
 *  - The typed character itself turns transparent in the prompt, so it really
 *    looks as if it exploded (the text is still there and is sent as usual).
 *  - Claude's answers get the mirror image while they stream in: each new
 *    character is invisible at first and appears in a burst of confetti.
 *
 * Blowing into the microphone blows the whole pile away (opt-in: click the
 * extension's toolbar button). The sound is only measured for loudness, on
 * this page; it is never recorded, stored or sent anywhere.
 *
 * Every keystroke also gives the prompt box a discreet shake and a short
 * haptic pulse (on devices that have a vibration motor).
 *
 * The page's own DOM is never modified: the only elements this script adds
 * are one click-through <canvas> and (lazily) one hidden measuring <div>,
 * and the shake is a Web Animation, which leaves styles and classes alone.
 */
(() => {
  'use strict';

  if (window.__konfettiLoaded) return;
  window.__konfettiLoaded = true;

  // ---------------------------------------------------------------- config

  const COLORS = [
    '#ff3b6b', '#ff8a00', '#ffd400', '#3ddc84',
    '#00c2ff', '#5b6cff', '#b45bff', '#ff5bd1',
  ];
  const PIECES_PER_CHAR = 10;   // confetti pieces for the first character
  const PIECES_GROWTH = 1;      // extra pieces for every further character
  const MAX_PIECES_PER_CHAR = 60;
  const STREAK_TIMEOUT = 10;    // seconds without typing before the amount
                                // starts over (0 = never start over)
  const PIECES_PER_PASTE = 60;  // confetti pieces for a paste
  const MAX_GLYPHS_PER_EVENT = 24;
  const MAX_FLYING = 4000;      // airborne pieces at once (keeps frames smooth)
  const GRAVITY = 1200;         // px / s^2
  const BUCKET = 6;             // px width of one pile column
  const PILE_GROWTH = 0.4;      // px a column grows per piece landing on it
  // The next block only applies in Super konfetti mode (see setSuperMode).
  const EXPLODE_DELAY_MIN = 0.2; // seconds a typed character stays intact before
  const EXPLODE_DELAY_MAX = 1;   // it explodes and turns transparent: a random
                                 // time in this range (both 0 = at once)
  const HIDE_TYPED = true;      // the typed character itself turns transparent
  const ANSWERS = true;         // Claude's answers get confetti as they stream in
  const ANSWERS_APPEAR = true;  // ...and each character stays invisible until
                                // its confetti goes off (false = visible at once)
  const ANSWER_PIECES_PER_CHAR = 3;   // confetti pieces per answer character
  const ANSWER_CHARS_PER_SECOND = 120; // at most this many answer characters
                                // per second get confetti (the rest just appear)
  const ANSWER_BULK_CHARS = 600; // more text than this appearing in one go is
                                // a page load, not streaming: left alone
  const REAPPEAR_SECONDS = 0;   // seconds until it becomes visible again
                                // (0 = it stays transparent)
  const SHAKE_PX = 1.5;         // how far the prompt box moves per keystroke
  const SHAKE_MS = 110;         // how long one shake lasts
  const VIBRATE_MS = 8;         // haptic pulse (only felt on devices with a
                                // vibration motor; 0 = off)
  const KEY_SOUND = false;      // true = soft "tick" per keystroke, a stand-in
                                // for haptics on machines that cannot vibrate
  // Blowing into the microphone (off until switched on with the toolbar button).
  const BLOW_LEVEL = 0.08;      // how loud counts as blowing (0..1, RMS of the
                                // raw signal; lower = more sensitive)
  const BLOW_LOW_HZ = 300;      // breath on a microphone is mostly a low rumble:
  const BLOW_LOW_RATIO = 0.5;   // this share of the sound must lie below BLOW_LOW_HZ
  const BLOW_MS = 180;          // ...for this long, so a click or a word is not a blow
  const BLOWN_MAX = 2000;       // pieces animated when the pile is blown away
  const PILE_SLOPE = 2;         // px step between columns before pieces slide

  // ---------------------------------------------------------------- canvas

  let canvas = null;
  let ctx = null;
  let W = 0;
  let H = 0;
  let dpr = 1;
  let pile = new Float32Array(0);  // height of the heap, per column

  // Confetti that has landed never moves again, so it is painted once onto
  // this off-screen canvas instead of being redrawn every frame. That keeps
  // the cost constant no matter how big the heap gets.
  let heapCanvas = null;
  let heapCtx = null;
  /** Everything that has landed, in landing order (used to rebuild on resize). */
  const resting = [];

  function ensureCanvas() {
    if (canvas && canvas.isConnected) return;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.setAttribute('aria-hidden', 'true');
      canvas.setAttribute('data-konfetti', '');
      canvas.style.cssText = [
        'position:fixed', 'left:0', 'top:0', 'width:100vw', 'height:100vh',
        'margin:0', 'padding:0', 'border:0', 'background:transparent',
        'pointer-events:none', 'z-index:2147483647',
      ].map((d) => d + ' !important').join(';');
      ctx = canvas.getContext('2d');
      heapCanvas = document.createElement('canvas');
      heapCtx = heapCanvas.getContext('2d');
    }
    document.documentElement.appendChild(canvas);
    resize();
  }

  function resize() {
    if (!canvas) return;
    W = window.innerWidth;
    H = window.innerHeight;
    dpr = window.devicePixelRatio || 1;
    heapCanvas.width = canvas.width = Math.max(1, Math.round(W * dpr));
    heapCanvas.height = canvas.height = Math.max(1, Math.round(H * dpr));
    // The floor moved: re-stack the whole heap on the new floor.
    pile = new Float32Array(Math.max(1, Math.ceil(W / BUCKET)));
    for (const p of resting) {
      p.x = Math.min(Math.max(p.x, 4), Math.max(4, W - 4));
      settle(p);
      paint(heapCtx, p);
    }
    if (!running) draw();
  }

  /**
   * Put a piece to rest on top of the heap below it. Pieces slide downhill
   * when the heap is too steep, so it grows as a mound rather than a tower.
   */
  function settle(p) {
    const last = pile.length - 1;
    let b = Math.min(last, Math.max(0, (p.x / BUCKET) | 0));
    for (let i = 0; i < 200; i++) {
      const left = b > 0 ? pile[b - 1] : Infinity;
      const right = b < last ? pile[b + 1] : Infinity;
      if (pile[b] - Math.min(left, right) <= PILE_SLOPE) break;
      const dir = left === right ? (Math.random() < 0.5 ? -1 : 1) : left < right ? -1 : 1;
      b += dir;
      p.x += dir * BUCKET;
    }
    p.y = H - pile[b] - p.h * 0.5 - 1;
    // Once a column reaches the top of the screen it stops growing.
    if (pile[b] < H) pile[b] += PILE_GROWTH;
  }

  window.addEventListener('resize', resize);

  // ------------------------------------------------------------- particles

  /** @type {Array<object>} */
  const particles = [];
  let running = false;
  let lastTime = 0;

  const rand = (min, max) => min + Math.random() * (max - min);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  function launch(p, power) {
    // Mostly upwards, fanned out to both sides.
    const angle = -Math.PI / 2 + rand(-1.15, 1.15);
    const speed = rand(300, 900) * power;
    p.vx = Math.cos(angle) * speed;
    p.vy = Math.sin(angle) * speed;
    p.drag = rand(1.6, 2.6);
    p.rot = rand(0, Math.PI * 2);
    p.vr = rand(-10, 10);
    p.swayPhase = rand(0, Math.PI * 2);
    p.swayFreq = rand(2, 5);
    p.swayAmp = rand(15, 50);
    p.color = pick(COLORS);
    return p;
  }

  function addPiece(x, y, power) {
    const shape = Math.random();
    const p = launch({ kind: 'piece', x, y }, power);
    if (shape < 0.6) {            // rectangle
      p.w = rand(6, 11);
      p.h = rand(4, 7);
      p.round = false;
    } else if (shape < 0.85) {    // streamer
      p.w = rand(10, 16);
      p.h = rand(2, 3.5);
      p.round = false;
    } else {                      // dot
      p.w = p.h = rand(5, 8);
      p.round = true;
    }
    p.flip = rand(0, Math.PI * 2);
    p.vflip = rand(6, 16);
    particles.push(p);
  }

  function addGlyph(ch, x, y, font, size) {
    const p = launch({ kind: 'glyph', x, y }, 0.8);
    p.ch = ch;
    p.font = font;
    p.h = size * 0.7;
    p.vr = rand(-7, 7);
    p.rot = 0;                    // starts upright, exactly where it was typed
    particles.push(p);
  }

  function burst(x, y, count, power) {
    ensureCanvas();
    for (let i = 0; i < count && particles.length < MAX_FLYING; i++) {
      addPiece(x + rand(-3, 3), y + rand(-3, 3), power);
    }
    start();
  }

  function start() {
    if (running) return;
    running = true;
    lastTime = performance.now();
    requestAnimationFrame(frame);
    syncMic();
  }

  function frame(now) {
    const dt = Math.min(0.034, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    update(dt);
    draw();
    if (particles.length || gust) {
      requestAnimationFrame(frame);
    } else {
      running = false;
      syncMic();
    }
  }

  // The moment the pile is blown away: a snapshot of the heap that lifts off
  // and fades, while a sample of its pieces is flung off the screen.
  let gust = null;
  const GUST_SECONDS = 0.35;

  /** Blow everything off the screen. A new pile can start right away. */
  function blowAway() {
    if (!canvas || (!resting.length && !particles.length)) return false;

    for (const p of particles) if (!p.blown) blowOff(p);   // what is in the air

    if (resting.length) {
      const snapshot = document.createElement('canvas');
      snapshot.width = heapCanvas.width;
      snapshot.height = heapCanvas.height;
      snapshot.getContext('2d').drawImage(heapCanvas, 0, 0);
      gust = { snapshot, age: 0 };

      // A big heap holds far too many pieces to animate, so take an even
      // sample of it; the snapshot stands in for the rest.
      const stride = Math.max(1, resting.length / BLOWN_MAX);
      for (let i = resting.length - 1; i >= 0; i -= stride) {
        const p = resting[Math.floor(i)];
        if (p.blown) continue;
        blowOff(p);
        particles.push(p);
      }
      resting.length = 0;
      pile.fill(0);
      heapCtx.setTransform(1, 0, 0, 1, 0, 0);
      heapCtx.clearRect(0, 0, heapCanvas.width, heapCanvas.height);
    }
    start();
    return true;
  }

  /** Send one piece flying up and out to the nearest side, fading as it goes. */
  function blowOff(p) {
    let dir = p.x < W / 2 ? -1 : 1;
    if (Math.random() < 0.15) dir = -dir;
    p.blown = true;
    p.alpha = 1;
    p.fade = rand(0.7, 1.4);                 // seconds until fully faded
    p.vx = dir * rand(500, 2200);
    p.vy = -rand(200, 1300);
    p.drag = rand(0.3, 0.9);
    p.vr = rand(-14, 14);
    if (p.kind === 'piece') p.vflip = rand(8, 20);
  }

  function update(dt) {
    if (gust) {
      gust.age += dt;
      if (gust.age >= GUST_SECONDS) gust = null;
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];

      if (p.blown) {
        // Carried off by the gust: barely any gravity, no walls, no landing.
        const carry = Math.exp(-p.drag * dt);
        p.vx *= carry;
        p.vy = p.vy * carry + GRAVITY * 0.2 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        if (p.kind === 'piece') p.flip += p.vflip * dt;
        p.alpha -= dt / p.fade;
        if (p.alpha <= 0 || p.x < -40 || p.x > W + 40 || p.y < -40) particles.splice(i, 1);
        continue;
      }

      const damp = Math.exp(-p.drag * dt);
      p.vx *= damp;
      p.vy = p.vy * damp + GRAVITY * dt;
      p.swayPhase += p.swayFreq * dt;
      // Flutter sideways only while falling, like paper does.
      const sway = p.vy > 0 ? Math.sin(p.swayPhase) * p.swayAmp : 0;
      p.x += (p.vx + sway) * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.kind === 'piece') p.flip += p.vflip * dt;

      // Keep everything on screen horizontally.
      if (p.x < 4) { p.x = 4; p.vx = Math.abs(p.vx) * 0.4; }
      else if (p.x > W - 4) { p.x = W - 4; p.vx = -Math.abs(p.vx) * 0.4; }

      // Land on the floor, or on whatever confetti is already lying there,
      // and stay there for good.
      const b = Math.min(pile.length - 1, Math.max(0, (p.x / BUCKET) | 0));
      if (p.vy > 0 && p.y >= H - pile[b] - p.h * 0.5 - 1) {
        if (p.kind === 'piece') {
          // Lie mostly flat, facing the viewer.
          p.rot = rand(-0.5, 0.5);
          p.flip = rand(-0.6, 0.6);
        }
        settle(p);
        paint(heapCtx, p);
        resting.push(p);
        particles.splice(i, 1);
      }
    }
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(heapCanvas, 0, 0);
    if (gust) {
      const t = gust.age / GUST_SECONDS;
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.drawImage(gust.snapshot, 0, -t * t * 90 * dpr);
    }
    for (const p of particles) paint(ctx, p);
    ctx.globalAlpha = 1;
  }

  /** Paint one particle onto a canvas context (the live one or the heap). */
  function paint(c, p) {
    const cos = Math.cos(p.rot);
    const sin = Math.sin(p.rot);
    c.globalAlpha = p.blown ? Math.max(0, p.alpha) : 1;
    c.fillStyle = p.color;

    if (p.kind === 'glyph') {
      c.setTransform(cos * dpr, sin * dpr, -sin * dpr, cos * dpr, p.x * dpr, p.y * dpr);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = p.font;
      c.fillText(p.ch, 0, 0);
      return;
    }

    // Fake a 3D tumble by squashing the piece along its own Y axis.
    let sy = Math.cos(p.flip);
    if (Math.abs(sy) < 0.12) sy = sy < 0 ? -0.12 : 0.12;
    c.setTransform(
      cos * dpr, sin * dpr,
      -sin * sy * dpr, cos * sy * dpr,
      p.x * dpr, p.y * dpr
    );
    if (p.round) {
      c.beginPath();
      c.arc(0, 0, p.w / 2, 0, Math.PI * 2);
      c.fill();
    } else {
      c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    }
  }

  // ------------------------------------------------- locating typed text

  const segmenter =
    typeof Intl !== 'undefined' && Intl.Segmenter
      ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      : null;

  /** Split a string into user-perceived characters with UTF-16 offsets. */
  function graphemes(text) {
    const out = [];
    if (segmenter) {
      for (const s of segmenter.segment(text)) out.push({ ch: s.segment, index: s.index });
    } else {
      let index = 0;
      for (const ch of text) { out.push({ ch, index }); index += ch.length; }
    }
    return out;
  }

  const sameText = (a, b) => a.replace(/ /g, ' ') === b.replace(/ /g, ' ');
  const isBlank = (ch) => /^\s*$/.test(ch);

  function fontOf(el) {
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize) || 16;
    return {
      size,
      font: `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`,
    };
  }

  function usable(rect) {
    return rect && (rect.width > 0 || rect.height > 0);
  }

  /** Where the caret is right now, as {x, y} in viewport pixels. */
  function caretPoint(host) {
    if (host instanceof HTMLTextAreaElement) {
      const r = textareaRect(host, host.selectionEnd, host.selectionEnd);
      return { x: r.left, y: r.top + r.height / 2 };
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0).cloneRange();
      range.collapse(false);
      const rects = range.getClientRects();
      const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
      if (usable(rect)) return { x: rect.left, y: rect.top + rect.height / 2 };
      // Caret in an empty block: fall back to that block's box.
      const node = range.startContainer;
      const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (el && host.contains(el)) {
        const r = el.getBoundingClientRect();
        if (usable(r)) {
          const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
          return { x: r.left + pad, y: r.top + r.height / 2 };
        }
      }
    }
    const r = host.getBoundingClientRect();
    return { x: r.left + Math.min(24, r.width / 2), y: r.top + r.height / 2 };
  }

  // Hidden mirror used to find pixel positions inside a <textarea>.
  let mirror = null;
  const MIRROR_PROPS = [
    'direction', 'fontFamily', 'fontSize', 'fontStyle', 'fontVariant',
    'fontWeight', 'fontStretch', 'fontKerning', 'fontFeatureSettings',
    'letterSpacing', 'wordSpacing', 'lineHeight', 'textAlign', 'textIndent',
    'textTransform', 'tabSize', 'paddingTop', 'paddingRight',
    'paddingBottom', 'paddingLeft',
  ];

  /** Viewport rect of the text between two offsets of a textarea. */
  function textareaRect(ta, from, to) {
    if (!mirror) {
      mirror = document.createElement('div');
      mirror.setAttribute('aria-hidden', 'true');
      mirror.setAttribute('data-konfetti', '');
    }
    const cs = getComputedStyle(ta);
    const ms = mirror.style;
    ms.cssText =
      'position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;' +
      'box-sizing:content-box;height:auto;border:0;margin:0;overflow:hidden;' +
      'white-space:pre-wrap;overflow-wrap:break-word;word-break:normal;';
    for (const prop of MIRROR_PROPS) ms[prop] = cs[prop];
    // clientWidth excludes a vertical scrollbar, so wrapping matches exactly.
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    ms.width = Math.max(0, ta.clientWidth - padX) + 'px';

    const value = ta.value;
    mirror.textContent = value.slice(0, from);
    const span = document.createElement('span');
    // A zero-width space gives an empty span a measurable line box.
    span.textContent = value.slice(from, to) || '​';
    mirror.appendChild(span);
    mirror.appendChild(document.createTextNode(value.slice(to) + '​'));
    document.documentElement.appendChild(mirror);

    const box = ta.getBoundingClientRect();
    const left = box.left + ta.clientLeft + span.offsetLeft - ta.scrollLeft;
    const top = box.top + ta.clientTop + span.offsetTop - ta.scrollTop;
    const width = from === to ? 0 : span.offsetWidth;
    const height = span.offsetHeight;
    mirror.remove();
    return { left, top, width, height };
  }

  /**
   * Find the on-screen box of each character of `text`, assuming it is the
   * text that sits immediately before the caret. Returns null when that
   * cannot be confirmed (the caller then uses the caret position instead).
   */
  function locateTyped(host, text) {
    const parts = graphemes(text);

    if (host instanceof HTMLTextAreaElement) {
      const end = host.selectionEnd;
      const begin = end - text.length;
      if (begin < 0 || host.value.slice(begin, end) !== text) return null;
      const style = fontOf(host);
      return parts.map(({ ch, index }) => {
        const r = textareaRect(host, begin + index, begin + index + ch.length);
        return {
          ch, style, x: r.left + r.width / 2, y: r.top + r.height / 2,
          ta: host, start: begin + index, end: begin + index + ch.length,
        };
      });
    }

    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const node = range.endContainer;
    const end = range.endOffset;
    if (node.nodeType !== Node.TEXT_NODE || !node.parentElement) return null;
    const begin = end - text.length;
    if (begin < 0 || !sameText(node.data.slice(begin, end), text)) return null;

    const style = fontOf(node.parentElement);
    const probe = document.createRange();
    const out = [];
    for (const { ch, index } of parts) {
      probe.setStart(node, begin + index);
      probe.setEnd(node, begin + index + ch.length);
      const rects = probe.getClientRects();
      const rect = rects.length ? rects[rects.length - 1] : probe.getBoundingClientRect();
      if (!usable(rect)) return null;
      out.push({
        ch, style, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
        node, start: begin + index, end: begin + index + ch.length,
      });
    }
    return out;
  }

  // --------------------------------------------------------------- effects

  // The exploded character turns transparent where it stands. This uses the
  // CSS Custom Highlight API (styled by `::highlight(konfetti-exploded)` in
  // content.css), which colours a range of text without touching the DOM, so
  // the editor never notices. The ranges are live: they follow their text as
  // you keep editing around it.
  const HIGHLIGHT = 'konfetti-exploded';
  let exploded = null;

  // Super konfetti mode: off until switched on from the options page.
  let superMode = false;

  /** Transparent runs per text node, so lookups stay fast in long chats. */
  let runs = new WeakMap();
  let vanishCalls = 0;

  /** The registered highlight, or null where the browser has no support. */
  function highlight() {
    if (typeof Highlight === 'undefined' || !CSS.highlights) return null;
    if (!exploded) exploded = new Highlight();
    if (CSS.highlights.get(HIGHLIGHT) !== exploded) CSS.highlights.set(HIGHLIGHT, exploded);
    // Now and then, forget ranges whose text no longer exists.
    if (++vanishCalls % 500 === 0) {
      for (const range of [...exploded]) {
        if (!range.startContainer.isConnected) exploded.delete(range);
      }
    }
    return exploded;
  }

  function vanish(node, start, end) {
    if (!highlight()) return;

    if (REAPPEAR_SECONDS > 0) {
      const range = new Range();
      range.setStart(node, start);
      range.setEnd(node, end);
      exploded.add(range);
      setTimeout(() => exploded.delete(range), REAPPEAR_SECONDS * 1000);
      return;
    }

    // Staying transparent: keep one range per run of transparent text rather
    // than one per character. Characters explode in random order, so a new
    // one may extend the run before it, the run after it, or join the two.
    let list = runs.get(node);
    if (!list) runs.set(node, (list = []));
    let before = null;
    let after = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const range = list[i];
      if (range.collapsed || range.startContainer !== node || range.endContainer !== node) {
        if (range.collapsed) exploded.delete(range);
        list.splice(i, 1);                        // no longer a run in this node
      } else if (range.startOffset <= start && range.endOffset >= end) {
        return;                                   // already transparent
      } else if (range.endOffset === start) {
        before = range;
      } else if (range.startOffset === end) {
        after = range;
      }
    }
    if (before && after) {
      before.setEnd(node, after.endOffset);
      exploded.delete(after);
      list.splice(list.indexOf(after), 1);
    } else if (before) {
      before.setEnd(node, end);
    } else if (after) {
      after.setStart(node, start);
    } else {
      const range = new Range();
      range.setStart(node, start);
      range.setEnd(node, end);
      exploded.add(range);
      list.push(range);
    }
  }

  // Like Power Mode's combo: every character entered makes the next burst
  // bigger, until you stop typing for STREAK_TIMEOUT seconds.
  let streak = 0;
  let lastTypedAt = 0;

  /** Count one more character and return how many pieces it has earned. */
  function nextBurstSize() {
    const now = Date.now();
    if (STREAK_TIMEOUT > 0 && now - lastTypedAt > STREAK_TIMEOUT * 1000) streak = 0;
    lastTypedAt = now;
    const size = PIECES_PER_CHAR + streak * PIECES_GROWTH;
    streak++;
    return Math.min(MAX_PIECES_PER_CHAR, size);
  }

  /** Bigger bursts are also thrown a little harder, so they spread out. */
  const burstPower = (size) => 1 + Math.min(0.4, size / 150);

  // Characters explode in the order they appeared. Each one draws its own
  // random delay, but never goes off before the character ahead of it: if
  // its draw would let it overtake, it waits and goes off right behind.
  // Your typing and Claude's answer each keep their own order.
  const typedOrder = { last: 0 };
  const answerOrder = { last: 0 };

  /**
   * How long the next character waits before exploding, in milliseconds.
   * With an `order`, never earlier than the previous character in it.
   * Outside Super konfetti mode there is no delay.
   */
  function explodeDelay(order) {
    if (!superMode) return 0;
    const min = Math.max(0, Math.min(EXPLODE_DELAY_MIN, EXPLODE_DELAY_MAX));
    const max = Math.max(0, EXPLODE_DELAY_MIN, EXPLODE_DELAY_MAX);
    const now = performance.now();
    let at = now + rand(min, max) * 1000;
    if (order) {
      at = Math.max(at, order.last + 1);
      order.last = at;
    }
    return at - now;
  }

  /** Typed characters that are waiting for their moment to explode. */
  const fuses = new Set();

  /**
   * Light the fuse on freshly typed text: each character explodes into
   * confetti (and turns transparent) after its own random delay.
   */
  function explodeTyped(host, text, mustLocate) {
    if (!text || !host.isConnected) return false;

    let chars = locateTyped(host, text);
    // `mustLocate`: only celebrate if the text really ended up in the prompt.
    if (!chars && mustLocate) return false;
    if (!chars) {
      // Position of each character unknown: everything flies from the caret.
      const at = caretPoint(host);
      const style = fontOf(host);
      chars = graphemes(text).map(({ ch }) => ({ ch, style, x: at.x, y: at.y }));
    }

    // Text arriving in one go (IME, autocomplete) shares the airtime, and
    // only its last few characters fly off as glyphs.
    const share = Math.sqrt(Math.min(chars.length, MAX_GLYPHS_PER_EVENT));
    const firstShown = chars.length - MAX_GLYPHS_PER_EVENT;
    chars.forEach((c, i) => {
      const fuse = {
        ch: c.ch, style: c.style, x: c.x, y: c.y,
        shown: i >= firstShown,
        size: nextBurstSize(),
        share,
        range: null,
        ta: c.ta || null, start: c.start, end: c.end,
        cancelled: false,
      };
      if (c.node) {
        // A live range keeps pointing at this character while the text
        // around it is edited, so it explodes from wherever it is by then.
        fuse.range = new Range();
        fuse.range.setStart(c.node, c.start);
        fuse.range.setEnd(c.node, c.end);
      }
      const delay = explodeDelay(typedOrder);
      if (delay > 0) {
        fuses.add(fuse);
        setTimeout(() => safely(() => detonate(fuse)), delay);
      } else {
        detonate(fuse);
      }
    });
    return true;
  }

  /** Is the character this fuse belongs to still where it was? */
  function stillThere(fuse) {
    if (fuse.answer) {
      return fuse.node.isConnected && fuse.node.data.slice(fuse.start, fuse.end) === fuse.ch;
    }
    if (fuse.range) return !fuse.range.collapsed && fuse.range.startContainer.isConnected;
    if (fuse.ta) return fuse.ta.isConnected && fuse.ta.value.slice(fuse.start, fuse.end) === fuse.ch;
    return true;
  }

  /**
   * The user edited the prompt: characters they removed before the fuse ran
   * out do not explode. (Characters that vanish for another reason, such as
   * the message being sent, still do: from where they were typed.)
   */
  function defuseRemoved(host, isDeletion) {
    for (const fuse of fuses) {
      if (fuse.range ? host.contains(fuse.range.startContainer) : fuse.ta === host && isDeletion) {
        if (!stillThere(fuse)) fuse.cancelled = true;
      }
    }
  }

  function detonate(fuse) {
    fuses.delete(fuse);
    if (fuse.cancelled) return;
    if (fuse.answer) return detonateAnswer(fuse);

    let { x, y } = fuse;                 // where it was typed, as a fallback
    if (stillThere(fuse)) {
      if (fuse.range) {
        const rects = fuse.range.getClientRects();
        const rect = rects.length ? rects[rects.length - 1] : fuse.range.getBoundingClientRect();
        if (usable(rect)) {
          x = rect.left + rect.width / 2;
          y = rect.top + rect.height / 2;
        }
        if (HIDE_TYPED && superMode) {
          vanish(fuse.range.startContainer, fuse.range.startOffset, fuse.range.endOffset);
        }
      } else if (fuse.ta) {
        const r = textareaRect(fuse.ta, fuse.start, fuse.end);
        x = r.left + r.width / 2;
        y = r.top + r.height / 2;
      }
    }

    if (fuse.shown) {
      if (!isBlank(fuse.ch)) {
        ensureCanvas();
        addGlyph(fuse.ch, x, y, fuse.style.font, fuse.style.size);
      }
      burst(x, y, Math.max(4, Math.round(fuse.size / fuse.share)), burstPower(fuse.size));
    }
  }

  // ------------------------------------------------------ Claude's answers
  //
  // An answer is not typed, it is rendered by the page, so it is watched with
  // a MutationObserver: whenever text is appended inside an answer, each new
  // character gets a fuse like a typed one. The effect is the reverse of
  // typing, though: the character starts out transparent and APPEARS when
  // its fuse runs out, in a burst of confetti.

  // Where claude.ai renders an answer. If the page has none of these, any
  // text streaming into <main> counts (see isAnswerText).
  const ANSWER_SELECTOR = [
    '[data-is-streaming]', '.font-claude-message', '.font-claude-response',
    '[data-testid="assistant-message"]', '[data-message-author-role="assistant"]',
  ].join(',');
  // Text that never explodes: prompts, your own messages, controls, code.
  const ANSWER_EXCLUDE = [
    '[data-konfetti]', '[contenteditable]', 'textarea', 'input', 'select',
    'button', 'nav', 'aside', 'header', 'footer', 'pre', 'script', 'style',
    'noscript', 'svg', '[role="dialog"]', '[role="menu"]', '[role="listbox"]',
    '[role="tooltip"]', '[aria-hidden="true"]', '.sr-only',
    '[data-testid="user-message"]', '[data-message-author-role="user"]',
  ].join(',');
  const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,dd,dt,summary';

  let sawMarkedAnswer = false;

  function isAnswerText(node) {
    const el = node.parentElement;
    if (!el || el.closest(ANSWER_EXCLUDE)) return false;
    if (el.closest(ANSWER_SELECTOR)) {
      sawMarkedAnswer = true;
      // Only an answer that is being written right now, not an old one.
      const state = el.closest('[data-is-streaming]');
      return !state || state.getAttribute('data-is-streaming') !== 'false';
    }
    if (sawMarkedAnswer || document.querySelector(ANSWER_SELECTOR)) {
      sawMarkedAnswer = true;
      return false;                 // the page marks its answers; this is not one
    }
    return !document.querySelector('main') || !!el.closest('main');
  }

  // How much of each block of an answer has been dealt with already. Pages
  // often re-create text nodes while streaming (for instance to fade new
  // words in); this keeps the same text from exploding twice.
  const blockSeen = new WeakMap();

  // Confetti allowance, so a fast answer cannot flood the screen.
  let allowance = ANSWER_CHARS_PER_SECOND;
  let allowanceAt = 0;

  function mayExplode() {
    const now = performance.now();
    allowance = Math.min(
      ANSWER_CHARS_PER_SECOND,
      allowance + ((now - allowanceAt) / 1000) * ANSWER_CHARS_PER_SECOND
    );
    allowanceAt = now;
    if (allowance < 1) return false;
    allowance -= 1;
    return true;
  }

  /** Light a fuse on every character of `node` from offset `from` onwards. */
  function scheduleAnswerText(node, from) {
    const el = node.parentElement;
    const block = el.closest(BLOCKS) || el;
    const lead = new Range();
    lead.setStart(block, 0);
    lead.setEnd(node, 0);
    const offset = lead.toString().length;       // where this node starts in its block
    const seen = blockSeen.get(block) || 0;
    const length = node.data.length;
    const fresh = Math.max(from, Math.min(length, seen - offset));
    blockSeen.set(block, Math.max(seen, offset + length));

    // (Re-created text before `fresh` has had its turn already: it stays
    // visible.) Everything new is invisible until its fuse runs out.
    if (ANSWERS_APPEAR && fresh < length) setAnswerHidden(node, fresh, length, true);

    for (const { ch, index } of graphemes(node.data.slice(fresh))) {
      const fuse = {
        answer: true,
        ch,
        shown: !isBlank(ch) && mayExplode(),
        node, start: fresh + index, end: fresh + index + ch.length,
        cancelled: false,
      };
      const delay = explodeDelay(answerOrder);
      if (delay > 0) {
        fuses.add(fuse);
        setTimeout(() => safely(() => detonate(fuse)), delay);
      } else {
        detonate(fuse);
      }
    }
  }

  // The page streams an answer by rewriting its text nodes, and a rewrite
  // makes the browser forget every range inside that node. So for answers
  // the still-invisible stretches are remembered as plain offsets per text node
  // and put back after each rewrite (see onMutations), before the next paint.
  let answerRuns = new WeakMap();     // text node -> { spans: [[from, to]], ranges: [] }

  function applyAnswerRuns(node) {
    const state = answerRuns.get(node);
    const registry = highlight();
    if (!state || !registry) return;
    while (state.ranges.length > state.spans.length) registry.delete(state.ranges.pop());
    while (state.ranges.length < state.spans.length) {
      const range = new Range();
      state.ranges.push(range);
      registry.add(range);
    }
    const length = node.data.length;
    state.spans.forEach(([from, to], i) => {
      state.ranges[i].setStart(node, Math.min(from, length));
      state.ranges[i].setEnd(node, Math.min(to, length));
    });
  }

  /** Add or (hide = false) remove a transparent stretch of an answer. */
  function setAnswerHidden(node, start, end, hide) {
    let state = answerRuns.get(node);
    if (!state) answerRuns.set(node, (state = { spans: [], ranges: [] }));
    const spans = [];
    let from = start;
    let to = end;
    for (const [a, b] of state.spans) {
      if (b < start || a > end) {
        spans.push([a, b]);                        // not touching
      } else if (hide) {
        from = Math.min(from, a);                  // merge into one stretch
        to = Math.max(to, b);
      } else {
        if (a < start) spans.push([a, start]);     // keep what sticks out
        if (b > end) spans.push([end, b]);
      }
    }
    if (hide) spans.push([from, to]);
    state.spans = spans.sort((p, q) => p[0] - q[0]);
    applyAnswerRuns(node);
  }

  /** A text node was rewritten: keep hidden only what is still the same text. */
  function repairAnswerRuns(node, unchanged) {
    const state = answerRuns.get(node);
    if (!state) return;
    state.spans = state.spans
      .filter(([from]) => from < unchanged)
      .map(([from, to]) => [from, Math.min(to, unchanged)]);
    applyAnswerRuns(node);
  }

  function detonateAnswer(fuse) {
    const node = fuse.node;
    // First of all the character appears. This must never be skipped, or
    // part of the answer would stay invisible.
    if (ANSWERS_APPEAR && node.isConnected) {
      setAnswerHidden(node, fuse.start, Math.min(fuse.end, node.data.length), false);
    }
    if (!superMode || !fuse.shown || !stillThere(fuse)) return;

    const range = new Range();
    range.setStart(node, fuse.start);
    range.setEnd(node, fuse.end);
    const rects = range.getClientRects();
    const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!usable(rect)) return;                   // inside something collapsed
    ensureCanvas();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || x > W || y < 0 || y > H) return; // scrolled out of view
    burst(x, y, ANSWER_PIECES_PER_CHAR, 1);
  }

  function commonPrefix(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
  }

  function onMutations(records) {
    // Text node -> offset at which its new text starts.
    const fresh = new Map();
    for (const record of records) {
      if (record.type === 'characterData') {
        const node = record.target;
        if (node.nodeType !== Node.TEXT_NODE || fresh.has(node)) continue;
        const unchanged = commonPrefix(record.oldValue || '', node.data);
        fresh.set(node, unchanged);
        repairAnswerRuns(node, unchanged);
        continue;
      }
      for (const added of record.addedNodes) {
        if (!added.isConnected) continue;
        if (added.nodeType === Node.TEXT_NODE) {
          if (!fresh.has(added)) fresh.set(added, 0);
        } else if (added.nodeType === Node.ELEMENT_NODE) {
          if (added.hasAttribute('data-konfetti')) continue;
          if (added.textContent.length > ANSWER_BULK_CHARS) continue;
          const walker = document.createTreeWalker(added, NodeFilter.SHOW_TEXT);
          for (let t = walker.nextNode(); t; t = walker.nextNode()) {
            if (!fresh.has(t)) fresh.set(t, 0);
          }
        }
      }
    }

    const jobs = [];
    let total = 0;
    for (const [node, from] of fresh) {
      if (!node.isConnected || from >= node.data.length) continue;
      if (isBlank(node.data.slice(from)) || !isAnswerText(node)) continue;
      jobs.push([node, from]);
      total += node.data.length - from;
    }
    if (total > ANSWER_BULK_CHARS) return;
    for (const [node, from] of jobs) scheduleAnswerText(node, from);
  }

  const answerObserver = ANSWERS && typeof MutationObserver !== 'undefined'
    ? new MutationObserver((records) => safely(() => onMutations(records)))
    : null;

  /** Switch Super konfetti mode on or off (the options page checkbox). */
  function setSuperMode(on) {
    on = !!on;
    if (on === superMode) return;
    superMode = on;
    if (on) {
      if (answerObserver) {
        answerObserver.observe(
          document.documentElement,
          { subtree: true, childList: true, characterData: true, characterDataOldValue: true }
        );
      }
      return;
    }
    // Switched off: stop watching answers, and make everything that was
    // transparent (typed text, answer text still waiting to appear) visible
    // again. Fuses already lit still go off, without hiding anything.
    if (answerObserver) answerObserver.disconnect();
    if (exploded) exploded.clear();
    runs = new WeakMap();
    answerRuns = new WeakMap();
  }

  /** A bigger burst, with a handful of the pasted characters mixed in. */
  function explodePasted(host, text) {
    if (!host.isConnected) return;
    const at = caretPoint(host);
    const style = fontOf(host);
    const visible = graphemes(text || '').filter(({ ch }) => !isBlank(ch));
    ensureCanvas();
    for (const { ch } of visible.slice(0, MAX_GLYPHS_PER_EVENT)) {
      addGlyph(ch, at.x + rand(-6, 6), at.y + rand(-6, 6), style.font, style.size);
    }
    burst(at.x, at.y, PIECES_PER_PASTE, 1.25);
  }

  // ---------------------------------------------------- keystroke feedback

  const boxCache = new WeakMap();
  const shaking = new WeakMap();

  const isTransparent = (color) =>
    color === 'transparent' || /(,|\/)\s*0\)$/.test(color);

  /**
   * The visible "box" around a prompt: the nearest rounded ancestor that has
   * a border, shadow or background of its own. On claude.ai the editable
   * element itself is unstyled and sits inside such a box.
   */
  function promptBox(host) {
    const cached = boxCache.get(host);
    if (cached && cached.isConnected && cached.contains(host)) return cached;

    let box = host;
    const maxWidth = host.getBoundingClientRect().width * 1.6 + 120;
    let el = host;
    for (let depth = 0; depth < 8; depth++) {
      if (!el || el === document.body || el === document.documentElement) break;
      const cs = getComputedStyle(el);
      const framed =
        cs.boxShadow !== 'none' ||
        (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') ||
        !isTransparent(cs.backgroundColor);
      if (framed && parseFloat(cs.borderTopLeftRadius) >= 6 && cs.display !== 'inline') {
        // Guard against grabbing a whole page section instead of the box.
        if (el.getBoundingClientRect().width <= maxWidth) box = el;
        break;
      }
      el = el.parentElement;
    }
    boxCache.set(host, box);
    return box;
  }

  /** Nudge the prompt box a pixel or so in a random direction and back. */
  function shake(host) {
    if (SHAKE_PX <= 0 || !host.isConnected) return;
    const box = promptBox(host);
    if (typeof box.animate !== 'function') return;
    const previous = shaking.get(box);
    if (previous) previous.cancel();
    const angle = rand(0, Math.PI * 2);
    const dx = Math.cos(angle) * SHAKE_PX;
    const dy = Math.sin(angle) * SHAKE_PX;
    const at = (k) => `translate(${(dx * k).toFixed(2)}px, ${(dy * k).toFixed(2)}px)`;
    shaking.set(box, box.animate(
      [
        { transform: at(0) },
        { transform: at(1), offset: 0.25 },
        { transform: at(-0.6), offset: 0.6 },
        { transform: at(0) },
      ],
      // 'add' keeps any transform the page itself has on the box.
      { duration: SHAKE_MS, easing: 'linear', composite: 'add' }
    ));
  }

  let audio = null;

  /** A very quiet, very short tick (only used when KEY_SOUND is on). */
  function tick() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audio) audio = new AC();
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(190 + rand(-15, 15), t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.03);
    gain.gain.setValueAtTime(0.05, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.04);
  }

  /** What every keystroke in a prompt feels like. */
  function feedback(host) {
    safely(() => shake(host));
    if (VIBRATE_MS > 0 && typeof navigator.vibrate === 'function') {
      safely(() => navigator.vibrate(VIBRATE_MS));
    }
    if (KEY_SOUND) safely(tick);
  }

  // ----------------------------------------------------- blowing it away
  //
  // Opt-in: the toolbar button flips a stored switch (see background.js).
  // While it is on, the microphone is open only when it can matter: the tab
  // is visible and there is confetti to blow away. The sound is measured for
  // loudness and pitch balance right here and then discarded.

  const MIC_POLL_MS = 40;
  const extension =
    typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local ? chrome : null;
  let micEnabled = false;
  let mic = null;
  let micStarting = false;

  function micWanted() {
    return micEnabled && document.visibilityState === 'visible' &&
      (resting.length > 0 || particles.length > 0);
  }

  function syncMic() {
    if (!micEnabled && !mic) return;
    if (micWanted()) startMic(); else stopMic();
  }

  async function startMic() {
    if (mic || micStarting || document.visibilityState !== 'visible') return;
    micStarting = true;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('this page cannot use a microphone');
      }
      // The browser's voice clean-up would filter breath out as "noise".
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      const AC = window.AudioContext || window.webkitAudioContext;
      const context = new AC();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      context.createMediaStreamSource(stream).connect(analyser);   // not to the speakers
      mic = {
        stream, context, analyser,
        wave: new Float32Array(analyser.fftSize),
        spectrum: new Float32Array(analyser.frequencyBinCount),
        held: 0,
        quietUntil: 0,
        timer: setInterval(() => safely(listen), MIC_POLL_MS),
      };
      if (context.state === 'suspended') context.resume().catch(() => {});
    } catch (err) {
      // Refused, or no microphone: switch the feature off again.
      console.debug('[konfetti] microphone unavailable:', err);
      micEnabled = false;
      safely(() => extension && extension.storage.local.set({ blow: false }));
    } finally {
      micStarting = false;
    }
    if (!micWanted()) stopMic();          // e.g. it was only opened to ask permission
  }

  function stopMic() {
    if (!mic) return;
    clearInterval(mic.timer);
    for (const track of mic.stream.getTracks()) track.stop();
    mic.context.close().catch(() => {});
    mic = null;
  }

  /** Is the sound right now a blow? Loud, and mostly low rumble. */
  function soundsLikeBlowing() {
    const { analyser, wave, spectrum, context } = mic;
    analyser.getFloatTimeDomainData(wave);
    let sum = 0;
    for (let i = 0; i < wave.length; i++) sum += wave[i] * wave[i];
    if (Math.sqrt(sum / wave.length) < BLOW_LEVEL) return false;

    analyser.getFloatFrequencyData(spectrum);            // decibels per frequency bin
    const hzPerBin = context.sampleRate / analyser.fftSize;
    let low = 0;
    let all = 0;
    for (let i = 1; i < spectrum.length && i * hzPerBin < 4000; i++) {
      const power = Math.pow(10, spectrum[i] / 10);
      all += power;
      if (i * hzPerBin < BLOW_LOW_HZ) low += power;
    }
    return all > 0 && low / all >= BLOW_LOW_RATIO;
  }

  function listen() {
    if (!mic) return;
    if (mic.context.state === 'suspended') { mic.context.resume().catch(() => {}); return; }
    // It has to last a moment; brief gaps are forgiven.
    mic.held = soundsLikeBlowing() ? mic.held + MIC_POLL_MS : Math.max(0, mic.held - 2 * MIC_POLL_MS);
    if (mic.held >= BLOW_MS && Date.now() >= mic.quietUntil) {
      mic.held = 0;
      mic.quietUntil = Date.now() + 1000;
      blowAway();
    }
  }

  document.addEventListener('visibilitychange', () => safely(syncMic));

  if (extension) {
    safely(() => {
      extension.storage.local.get({ blow: false, super: false }, (stored) => {
        micEnabled = !!(stored && stored.blow);
        safely(syncMic);
        safely(() => setSuperMode(stored && stored.super));
      });
      extension.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes.super) safely(() => setSuperMode(changes.super.newValue));
        if (!changes.blow) return;
        micEnabled = !!changes.blow.newValue;
        // Switched on: open it once straight away so the browser asks for
        // permission now, not in the middle of typing.
        if (micEnabled) startMic(); else stopMic();
      });
    });
  }

  // ---------------------------------------------------------------- events

  /** The prompt being typed into, or null if the event is not for a prompt. */
  function promptHost(target) {
    if (!(target instanceof Element)) return null;
    if (target instanceof HTMLTextAreaElement) {
      return target.readOnly || target.disabled ? null : target;
    }
    // <input> elements are deliberately ignored (search boxes, passwords…).
    if (target instanceof HTMLElement && target.isContentEditable) {
      return target.closest('[contenteditable]:not([contenteditable="false"])') || target;
    }
    return null;
  }

  function safely(fn) {
    try {
      fn();
    } catch (err) {
      // Never let a cosmetic effect interfere with typing.
      console.debug('[konfetti]', err);
    }
  }

  // Normally the browser inserts the character and fires `input`. Rich-text
  // editors sometimes cancel the keypress and insert the text themselves, in
  // which case no `input` event follows; `pendingKey` covers that case.
  let pendingKey = null;
  let composing = false;

  window.addEventListener('keypress', (e) => {
    if (e.ctrlKey || e.metaKey || e.isComposing) return;
    if (!e.key || e.key.length > 2 || e.charCode < 32) return;
    const host = promptHost(e.target);
    if (!host) return;
    const mine = (pendingKey = { text: e.key });
    setTimeout(() => {
      if (pendingKey !== mine) return;
      pendingKey = null;
      safely(() => { if (explodeTyped(host, mine.text, true)) feedback(host); });
    }, 0);
  }, true);

  window.addEventListener('input', (e) => {
    pendingKey = null;
    const host = promptHost(e.target);
    if (!host) return;
    safely(() => defuseRemoved(host, /^delete/.test(e.inputType || '')));
    // Locate the character before the shake moves it. Every edit is felt,
    // deleting included; only newly typed characters turn into confetti.
    if (e.inputType === 'insertText' && e.data && !e.isComposing && !composing) {
      safely(() => explodeTyped(host, e.data));
    }
    feedback(host);
  }, true);

  // IME / dead keys: celebrate the committed text once, when composition ends.
  window.addEventListener('compositionstart', () => { composing = true; }, true);
  window.addEventListener('compositionend', (e) => {
    composing = false;
    const host = promptHost(e.target);
    const text = e.data;
    if (!host || !text) return;
    // Let the editor finish committing the text before measuring it.
    setTimeout(() => safely(() => explodeTyped(host, text)), 0);
  }, true);

  window.addEventListener('paste', (e) => {
    const host = promptHost(e.target);
    if (!host) return;
    let text = '';
    try {
      text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
    } catch (_) { /* clipboard not readable: confetti only */ }
    setTimeout(() => feedback(host), 0);
    setTimeout(() => safely(() => explodePasted(host, text)), explodeDelay());
  }, true);
})();
