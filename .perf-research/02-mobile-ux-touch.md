# Mobile-first UX & touch/viewport engineering — 2025/2026 field guide

Research date: **August 2026**. Every claim below is backed by a source URL in
§13. Snippets are copy-pasteable (CSS + React/TSX). A StageStack-specific audit
(what this repo already does right, what is still missing) is in §12.

---

## 0. The 60-second foundation

Two blocks. If you ship nothing else from this document, ship these.

```html
<!-- document <head> -->
<meta name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover" />
```

Notes on that one line:
- `width=device-width, initial-scale=1` is what makes the browser treat the page
  as "mobile-optimized", which is *also* what removes the historical 300–350 ms
  tap delay (Chrome 32+, Firefox, Edge, iOS 9.3+). No JS, no FastClick.
- `viewport-fit=cover` opts you into the full display (behind notch / Dynamic
  Island / home indicator). It is **only safe if you then honour
  `env(safe-area-inset-*)`** — see §1.3.
- **Never** add `user-scalable=no`, `maximum-scale=1`, or `minimum-scale=1`.
  MDN/WCAG: disabling zoom breaks low-vision users; WCAG requires ≥2× scaling
  (5× is best practice). iOS 10+ ignores these anyway, so they only hurt Android.
- `interactive-widget=...` is optional and Chromium/Firefox-Android-only. Read
  §1.2 before adding it — it is *not* a cross-browser keyboard fix.

```css
/* Mobile foundation — safe to drop into any design system's base layer */
*, *::before, *::after { box-sizing: border-box; }

html {
  /* Stop Android/iOS "text inflation" from resizing your type independently
     of layout. 100% (not `none`) keeps user zoom working. */
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

body {
  /* A single long token (URL, session id, email) is the #1 cause of a page
     that pans sideways on a 360px screen. */
  overflow-wrap: break-word;
}

/* Never let the document scroll sideways; make the *wide thing* scroll. */
html, body { overflow-x: clip; }        /* `clip` not `hidden`: keeps position:sticky working */

/* Kill the grey tap flash; components draw their own :active state. */
a, button, summary, label, input, select, textarea, [role="button"] {
  -webkit-tap-highlight-color: transparent;
}

/* Touch targets: WCAG 2.2 SC 2.5.8 floor is 24x24 CSS px for ALL pointers.
   Platform guidance is bigger: 44x44pt (Apple HIG) / 48x48dp (Material 3). */
@media (pointer: coarse) {
  button, [role="button"], a, input, select, textarea, summary {
    min-height: 44px;
  }
}

/* Hover styles latch on after a tap on touchscreens. Opt IN, never opt out. */
@media (hover: hover) and (pointer: fine) {
  .card:hover { background: var(--surface-hover); }
}

/* Honour the OS motion preference globally. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

## 1. Viewport meta, `interactive-widget`, safe areas

### 1.1 Two viewports, not one

Every mobile browser has a **layout viewport** (what `position: fixed` and the
initial containing block are laid out against) and a **visual viewport** (the
currently-visible slice; shrinks when you pinch-zoom). Confusing them is the
root cause of nearly every "my sticky footer is under the keyboard" bug.
(Chrome for Developers, *Prepare for viewport resize behavior changes*.)

Read the visual viewport from JS:

```ts
const vv = window.visualViewport; // .width .height .offsetTop .offsetLeft .scale
vv?.addEventListener('resize', onChange);
vv?.addEventListener('scroll', onChange);
```

### 1.2 On-screen keyboard behaviour, and why `interactive-widget` is not a fix

When the OSK opens, browsers do one of three things (Interop 2022 viewport
investigation classification):

| Behaviour | Browsers | Effect |
|---|---|---|
| Resize **visual** viewport only (layout untouched) | Safari iOS/iPadOS, Chrome iOS/CrOS, Edge iOS — **and Chrome Android since 108** | `vh/dvh` values unchanged; `position: fixed` stays put and gets **covered by the keyboard** |
| Resize **both** viewports | Firefox iOS; Chrome/Firefox/Edge Android **pre-108** | viewport units shrink; `position: fixed` moves |
| Resize **neither** (overlay) | opt-in only, via the VirtualKeyboard API | you own all occlusion handling |

`<meta name="viewport" content="... interactive-widget=resizes-visual | resizes-content | overlays-content">`
lets you pick. **Support (caniuse, Aug 2026): Chrome for Android, Firefox for
Android 153+, Samsung Internet 21+, Opera Mobile, Android Browser. NOT
supported in Safari or Safari on iOS (through 26.5), and not in desktop
Chrome/Edge/Firefox.** Global ~49% of users.

Consequences you must design for:

- `interactive-widget=resizes-content` gives you "keyboard shrinks `dvh`,
  sticky footers ride above the keyboard" **on Chromium Android only**. On iOS
  the attribute is inert, so you need the JS fallback below for parity.
- `resizes-content` also means the layout viewport reflows on every keyboard
  open/close on Android → visible relayout and potential CLS in long lists.
  `resizes-visual` (the default) is jank-free but requires you to move critical
  fixed UI yourself.
- The OSK is **not** part of "UA UI", so it never affects `svh/lvh/dvh` unless
  the layout viewport itself is resized (i.e. `resizes-content` or Chrome's
  pre-108 behaviour).

**Cross-browser keyboard-inset shim** (works on iOS Safari, which has no
`interactive-widget` and no VirtualKeyboard API):

```ts
// Publishes --kb (keyboard height in px) and --vvh (visual viewport height).
// Use in CSS: bottom: calc(var(--kb, 0px) + env(safe-area-inset-bottom));
export function trackKeyboardInset() {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const root = document.documentElement;
  let raf = 0;
  const sync = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      // layoutHeight - (visualHeight + how far the visual vp is offset down)
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--kb', `${Math.round(kb)}px`);
      root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    });
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
  return () => {
    vv.removeEventListener('resize', sync);
    vv.removeEventListener('scroll', sync);
    cancelAnimationFrame(raf);
  };
}
```

Chromium-only, if you want *full* control (Chromium 94+):

```js
if ('virtualKeyboard' in navigator) navigator.virtualKeyboard.overlaysContent = true;
```
```css
.composer { padding-bottom: env(keyboard-inset-height, 0px); }
```
`keyboard-inset-{top,right,bottom,left,width,height}` only become non-zero once
you set `overlaysContent = true`.

### 1.3 Safe-area insets (notch / Dynamic Island / home indicator)

`viewport-fit=cover` + `env(safe-area-inset-*)` is **Baseline: widely
available**. Rules that actually matter in practice:

```css
:root {
  /* max(0px, …) guards engines that report the env var as an empty string. */
  --safe-top:    max(0px, env(safe-area-inset-top));
  --safe-right:  max(0px, env(safe-area-inset-right));
  --safe-bottom: max(0px, env(safe-area-inset-bottom));
  --safe-left:   max(0px, env(safe-area-inset-left));
}

/* 1. Insets are NOT margins — they are exactly the obscured space. Always add
      your own breathing room with calc(). */
.bottom-bar { padding-bottom: calc(var(--safe-bottom) + 12px); }

/* 2. Sticky/fixed top chrome must grow by the top inset, not just pad. */
.topbar {
  position: sticky; top: 0;
  height: calc(var(--topbar-height) + var(--safe-top));
  padding-top: var(--safe-top);
}

/* 3. Landscape matters: left/right insets are non-zero when rotated. */
.page { padding-inline: calc(var(--gutter) + var(--safe-left)) calc(var(--gutter) + var(--safe-right)); }

/* 4. env() has a built-in fallback slot for non-supporting engines. */
.legacy { padding-top: env(safe-area-inset-top, 1rem); }
```

- Values are **0 on every desktop browser and in Chrome's device-emulation
  responsive view** — safe-area bugs are invisible in normal dev and only show
  up on real hardware. Test on a device (or Polypane, which emulates insets).
- `safe-area-max-inset-*` (Chromium only, no Safari/Firefox) returns the
  *maximum* inset for an edge so a reserved zone does not jump when browser
  chrome collapses. Use for cookie banners / persistent bars; use the plain
  `safe-area-inset-*` for elements that should track the live state:
  ```css
  .persistent-bar {
    padding-bottom: 1rem;                                                            /* no env() */
    padding-bottom: calc(env(safe-area-inset-bottom) + 1rem);                        /* all modern */
    padding-bottom: calc(env(safe-area-max-inset-bottom, env(safe-area-inset-bottom)) + 1rem);
  }
  ```
- Legacy `constant(safe-area-inset-*)` (iOS 11.0–11.1) is dead; do not ship it.

---

## 2. `dvh` / `svh` / `lvh` — and the real fix for the iOS `100vh` bug

Definitions (CSS Values 4; shipped in Safari 15.4, Firefox 101, Chrome 108 —
Baseline in all three engines):

| Unit family | Meaning | Stable? |
|---|---|---|
| `lvh` / `lvw` / `lvmin` / `lvmax` / `lvi` / `lvb` | **Large** viewport: assumes retractable UA chrome is *retracted* | yes |
| `svh` / `svw` / … | **Small** viewport: assumes chrome is *expanded* | yes |
| `dvh` / `dvw` / … | **Dynamic**: tracks the live state, clamped between `sv*` and `lv*` | no (changes while scrolling) |
| `vh` / `vw` | legacy; on mobile Safari `vh` ≈ `lvh` | yes, but wrong on load |

**The `100vh` bug**: `vh` is pinned to the *large* viewport, so a `100vh` hero
is taller than what you can see while the URL bar is showing — its bottom
(usually the primary CTA) sits under browser chrome.

Decision rules:

```css
/* Element MUST be fully visible in the worst case (toolbars showing):
   forms, dialogs, sheets, anything with a footer/CTA at its bottom edge. */
.sheet { max-block-size: 92svh; }

/* Full-bleed shell where you want edge-to-edge fill and accept a resize as the
   toolbar collapses (app shells, map canvases, media viewers). */
.app-shell { min-height: 100dvh; }

/* Decorative bleed where being partially hidden behind chrome is fine. */
.hero-bg { block-size: 100lvh; }

/* Progressive enhancement for very old engines. */
.shell { min-height: 100vh; min-height: 100dvh; }
```

Caveats (web.dev):
- **No viewport unit accounts for classic scrollbars** — `100vw` overflows by
  the scrollbar width on desktop Windows/Linux. Prefer `width: 100%` or
  `100cqw`; if you must use `100vw`, add `scrollbar-gutter: stable` on `html`.
- **`dvh` does not update at 60 fps.** All engines throttle, some debounce
  depending on gesture. Animating layout off `dvh` will look choppy — do not
  size animated things with `dvh`; size the container once and animate transforms.
- Use logical units (`svb`/`dvb`/`lvb`, `svi`/`dvi`) if the app is
  internationalised into vertical writing modes.
- `100dvh` still does **not** account for the on-screen keyboard (§1.2).

---

## 3. Touch targets, `touch-action`, tap highlight, double-tap zoom

### 3.1 Sizes — three overlapping standards

| Source | Number | Nature |
|---|---|---|
| WCAG 2.2 **SC 2.5.8 Target Size (Minimum)**, AA | **24×24 CSS px** for pointer targets | normative, applies to *all* pointers, not just touch |
| WCAG 2.2 SC 2.5.5 Target Size (Enhanced), AAA | 44×44 CSS px | normative |
| Apple HIG (Accessibility → Mobility) | iOS/iPadOS **default 44×44 pt**, absolute minimum 28×28 pt; ~12 pt padding between bezelled controls, ~24 pt for unbezelled | guidance |
| Material 3 | **48×48 dp** touch targets (≈9 mm), 44 dp pointer targets, ≥8 dp spacing | guidance |

WCAG 2.5.8 exceptions worth knowing: **spacing** (undersized targets pass if a
24 px-diameter circle centred on each bounding box does not intersect another
target's circle), **inline** targets in text, **equivalent** control elsewhere,
**user-agent-controlled** widgets (e.g. unstyled `<input type="date">`), and
targets that are *obscured* by other content. Zooming does **not** count as
mitigation — CSS px are zoom-invariant.

Grow the *hit* area without disturbing layout:

```css
/* Preferred: real padding + negative margin (keeps flow, no pseudo-element). */
.icon-btn { padding: 10px; margin: -10px; }

/* When the visual box must stay small (checkbox, 16px tag ✕): */
.tiny-target { position: relative; }
.tiny-target::after {
  content: ""; position: absolute; inset: 50% auto auto 50%;
  translate: -50% -50%; width: 44px; height: 44px;
}
```

### 3.2 `touch-action`

`touch-action` is Baseline (Safari 13+, Chrome 36+). The browser intersects the
values of the touched element and its ancestors up to the first scroll
container.

```css
.draggable  { touch-action: none; }        /* pointer-events drag: only reliable way to stop scroll */
.custom-btn { touch-action: manipulation; }/* keep pan + pinch-zoom, drop double-tap-to-zoom */
.carousel   { touch-action: pan-x; }       /* horizontal swipe only (pan-* is Chromium-only) */
```

- `manipulation` === `pan-x pan-y pinch-zoom`. Removing double-tap-to-zoom is
  exactly what lets the browser fire `click` without waiting.
- `pan-left/right/up/down` are **Chromium-only** (no Safari, no Firefox).
- Changing `touch-action` *after* a gesture has begun has no effect.
- `touch-action: none` on a large scrollable region makes that region
  unscrollable by finger — a classic self-inflicted bug (see §10).

### 3.3 The 300 ms tap delay

Fixed by the viewport tag, not by JS. Chrome 32 (2014), Firefox/IE shortly
after, iOS 9.3 (March 2016) drop the 300–350 ms `touchend`→`click` delay for
mobile-optimized pages, *without* disabling pinch-zoom:

```html
<meta name="viewport" content="width=device-width" />
```
Fallback for a page you cannot re-viewport: `html { touch-action: manipulation; }`
(historically unsupported in Safari; the meta tag is strongly preferred).
FastClick is obsolete — delete it if you find it.

### 3.4 Tap highlight & long-press artefacts

```css
a, button, [role="button"], summary { -webkit-tap-highlight-color: transparent; }

/* Only on elements the user drags/long-presses — NOT globally: killing
   user-select breaks copy/paste of real content. */
.drag-handle, .agenda-block {
  -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none;   /* suppresses iOS's link/image action sheet */
}
```
If you remove the tap highlight you **must** supply a visible `:active`
(and `:focus-visible`) state, otherwise taps feel dead.

---

## 4. Inputs: the 16px rule, keyboards, autofill

### 4.1 iOS zoom-on-focus

Mobile Safari zooms the page when a focused form control's computed
`font-size` is **< 16px**, and it does not zoom back out — you are left scaled
and panned. There is no `user-scalable` workaround worth having (it breaks a11y
and iOS ignores it). The fix is font size:

```css
/* Applies where it matters (touch) and keeps dense desktop UI intact.
   `pointer: coarse`, not a width query, so a narrow laptop window is unaffected. */
@media (pointer: coarse) {
  input:not([type="checkbox"]):not([type="radio"]), select, textarea {
    font-size: 16px;   /* == 1rem at default root size */
  }
}
```
Watch for: `font-size: 1rem` is fine at a 16px root, but a design system with a
14px control scale (`--text-md: 14px`) **will** trigger zoom. Also affects
`<select>` and any `contenteditable`. Bumping the font means bumping control
heights too, which conveniently lands you on 44px targets.

### 4.2 Keyboard-shaping attributes

```tsx
// Email
<input type="email" inputMode="email" enterKeyHint="next"
       autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} />

// Search-in-page
<input type="search" inputMode="search" enterKeyHint="search" autoComplete="off" />

// Quantity / integer (type=number has spinner + validation baggage)
<input type="text" inputMode="numeric" pattern="[0-9]*" enterKeyHint="done" />

// Money
<input type="text" inputMode="decimal" enterKeyHint="done" />

// Phone
<input type="tel" inputMode="tel" autoComplete="tel" enterKeyHint="done" />

// One-time code (iOS + Android autofill from SMS)
<input inputMode="numeric" autoComplete="one-time-code" enterKeyHint="done" />

// Multi-line note: enterkeyhint=enter keeps the newline key
<textarea enterKeyHint="enter" />
```

- `inputmode`: `none | text | decimal | numeric | tel | search | email | url`.
  It is a *keyboard hint only* — it enforces no validation. Prefer a correct
  `type` when one exists (`type="email"` over `inputmode="email"`).
- `enterkeyhint`: `enter | done | go | next | previous | search | send`
  (Chrome 77+, Safari 13.1+/iOS 13.4+, Firefox 94+ — effectively universal).
  Use `next` on every field but the last in a form, `done`/`send`/`go` on the last.
- `autocomplete` tokens are what unlock OS/browser autofill: `name`,
  `given-name`, `family-name`, `email`, `tel`, `organization`, `street-address`,
  `postal-code`, `country`, `username`, `current-password`, `new-password`,
  `one-time-code`, and the `shipping`/`billing` prefixes. `autocomplete="off"`
  on a login/profile field is usually a bug on mobile.
- Pair with `<label for>` (never placeholder-as-label) so the keyboard's
  next/previous traversal has something to announce.

### 4.3 Keeping the focused field visible

iOS scrolls the focused input into view against the **visual** viewport, which
often hides it behind your own sticky footer. Two mitigations:

```css
/* Reserve room so the browser's auto-scroll lands the field in the clear. */
.form-scroller { scroll-padding-block-end: calc(96px + env(safe-area-inset-bottom)); }
```
```ts
// Belt-and-braces for tall sheets on iOS.
inputEl.addEventListener('focus', () => {
  setTimeout(() => inputEl.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
});
```

---

## 5. Horizontal overflow & layout shift on small screens

Ranked by how often each is the actual culprit:

1. **A long unbreakable token.** `body { overflow-wrap: break-word }`. For code
   / IDs also `overflow-wrap: anywhere` or `word-break: break-word`; add
   `hyphens: auto` for prose.
2. **Flex/grid children refusing to shrink.** A flex item's `min-width` is
   `auto` = its content's min-content size, so one wide table or `nowrap`
   heading forces the *document* wide. Fix on the **item**, not the container:
   ```css
   .flex-child { min-width: 0; }      /* row direction  */
   .flex-child { min-height: 0; }     /* column direction */
   .grid > * { min-width: 0; }        /* grid items have the same trap */
   ```
   Ellipsis truncation only works when the truncating element (or its flex
   ancestor) has `min-width: 0`.
3. **`100vw`** (scrollbar) — use `100%`/`100cqw`, or `scrollbar-gutter: stable`.
4. **Fixed-width media/embeds** — `img, svg, video, iframe { max-width: 100%; display: block; }`
   plus intrinsic `width`/`height` attributes so the box is reserved (CLS).
5. **Tables** — see §10.
6. **Negative-margin bleeds** — bleed *inside* a `overflow-x: clip` ancestor only.

Diagnostics:

```js
// Log every element wider than the viewport.
const w = document.documentElement.clientWidth;
[...document.querySelectorAll('*')].filter(el => {
  const r = el.getBoundingClientRect();
  return r.width > w + 1 || r.right > w + 1 || r.left < -1;
}).forEach(el => console.warn(el, el.getBoundingClientRect()));
```
```css
/* Visual overflow detector — toggle in devtools. */
* { outline: 1px solid rgb(255 0 0 / .25); }
```

Layout-shift specifics on mobile: reserve space for lazily-loaded images
(`width`/`height` or `aspect-ratio`), for async banners, and remember that
`interactive-widget=resizes-content` reflows the whole layout viewport on every
keyboard open (a CLS source that only exists on Android).

---

## 6. Scrolling: overscroll, momentum, snap, and body scroll locking

### 6.1 `overscroll-behavior`

```css
/* Modal/drawer inner scroller: a flick that reaches the end must NOT scroll
   the page behind it (scroll chaining) — the #1 reason a sheet feels broken. */
.sheet__body { overflow: auto; overscroll-behavior: contain; }

/* Horizontal table scroller: stop the overscroll being read as the browser's
   swipe-back navigation gesture. */
.scroll-x { overflow-x: auto; overscroll-behavior-x: contain; }

/* App-shell root: kill pull-to-refresh where it would destroy in-progress state. */
html { overscroll-behavior-y: contain; }
```
`contain` keeps the local bounce but stops chaining **and disables pull-to-refresh
and horizontal swipe-navigation** within that element. `none` additionally kills
the bounce. Key spec detail: an element with `overflow: hidden` is *always* at
its scroll boundary, so `overscroll-behavior: contain` on it still blocks
chaining — usable as a background-scroll guard.

Known limit: `overscroll-behavior` on a `<dialog>` itself does nothing — a
dialog is not a scroll port. Put it on the dialog's inner scrolling element,
and lock the document separately (§6.3).

### 6.2 Momentum scrolling — delete `-webkit-overflow-scrolling: touch`

Since **iOS 13** WebKit applies one-finger accelerated (momentum) scrolling to
all frames and `overflow: scroll` elements. The property still *parses* (so
`CSS.supports()` lies) but has no effect, and historically it introduced its own
bugs (clipped/janky nested scrollers, lost scroll position). Modern equivalent
= nothing for momentum + `overscroll-behavior` for bounce/chaining.

### 6.3 Body scroll locking that survives iOS

`body { overflow: hidden }` alone does **not** hold on mobile Safari: the page
still rubber-bands, and the scroll position can be discarded so closing the
overlay dumps the user at the top. `-webkit-overflow-scrolling`/`touch-action`
tricks are fragile (break after pinch-zoom). The durable pattern is
`position: fixed` + restoring scroll programmatically:

```ts
let locks = 0;
let saved: { y: number; top: string; position: string; width: string; overflowY: string } | null = null;

export function lockBodyScroll() {
  if (++locks > 1) return;                       // ref-count: nested dialogs
  const body = document.body;
  const y = window.scrollY;
  saved = { y, top: body.style.top, position: body.style.position,
            width: body.style.width, overflowY: body.style.overflowY };
  body.style.position = 'fixed';
  body.style.top = `-${y}px`;
  body.style.width = '100%';        // else the out-of-flow body collapses to content width
  body.style.overflowY = 'scroll';  // keeps the desktop scrollbar gutter → no sideways jump
}

export function unlockBodyScroll() {
  if (--locks > 0 || !saved) return;
  const { y, top, position, width, overflowY } = saved; saved = null;
  Object.assign(document.body.style, { position, top, width, overflowY });
  window.scrollTo({ top: y, behavior: 'instant' as ScrollBehavior });
}
```
Alternative (Jay Freestone): keep a wrapper element and `wrapper.scroll(0, y)`
instead of a negative `top`, which survives rotation/resize without shooting
content off-screen. Either way: **ref-count the lock** and prefer restoring
scroll over faking an offset.

Also: `scrollbar-gutter: stable` on `html` avoids the classic desktop
"everything shifts 15px when the modal opens".

### 6.4 Scroll snap for mobile carousels / tab strips

```css
.snap-row {
  display: flex; gap: 12px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scroll-snap-type: x mandatory;        /* or `x proximity` for a softer feel */
  scroll-padding-inline: var(--gutter); /* so a snapped item isn't flush to the edge */
  scrollbar-width: none;
}
.snap-row > * { scroll-snap-align: start; scroll-snap-stop: always; flex: 0 0 auto; }
```
`scroll-snap-type` axes: `x | y | block | inline | both`, strictness
`mandatory | proximity`. Use `proximity` when items vary in size, `mandatory`
only when every item is a full "page" — mandatory + tall content can trap users.
`scroll-snap-stop: always` prevents a fast flick skipping items.

---

## 7. Sticky headers, keyboards, bottom nav, thumb zones

### 7.1 Sticky/fixed chrome + keyboard

Default behaviour (all iOS browsers, Chrome Android 108+): the layout viewport
does not change, so `position: fixed` bottom bars are **covered** by the
keyboard. Options, in order of preference:

1. **Don't fix the bar.** Put the primary action inside the scrolling form
   (sticky within the form's scroll container) — nothing to occlude.
2. **Track the keyboard** with the `--kb` shim from §1.2:
   ```css
   .composer { position: fixed; bottom: 0;
     transform: translateY(calc(-1 * var(--kb, 0px)));
     padding-bottom: env(safe-area-inset-bottom); }
   ```
3. **Hide** the bottom bar while a field is focused (`:focus-within` on the form,
   or a `keyboardOpen` state from `--kb > 0`). Simple and very robust.
4. Android-only shortcut: `interactive-widget=resizes-content` makes `dvh` and
   `position: fixed` respect the keyboard — but see §1.2 for the reflow cost and
   the iOS gap.

Sticky headers, mobile specifics:

```css
.topbar {
  position: sticky; top: 0;
  height: calc(var(--topbar-height) + env(safe-area-inset-top));
  padding-top: env(safe-area-inset-top);
}
/* Anchors and scroll-into-view must clear the sticky header. */
html { scroll-padding-block-start: calc(var(--topbar-height) + env(safe-area-inset-top)); }
/* A sticky ancestor with overflow:hidden silently breaks stickiness — use clip. */
```
Sticky `<thead>` inside a scroller works (`th { position: sticky; top: 0 }`) but
needs a solid background (transparent = text pile-up) and its own `z-index`.
Note also: an ancestor with `overflow: hidden` or a `transform` creates a
containing block/clip that kills `position: sticky`/`fixed` descendants —
`overflow-x: clip` is the safe choice for overflow guards.

### 7.2 Thumb zones and bottom navigation

Hoober's research: **49% of people hold a phone one-handed**; Clark: **~75% of
interactions are thumb-driven**. Map the screen into easy / in-between /
hard-to-reach arcs (hard = top corners, especially the far top corner opposite
the holding thumb).

Concrete rules:
- Primary, frequent, destructive-confirm actions → **bottom** of the screen.
  Rarely-used or dangerous-by-accident actions → top.
- Bottom nav: 3–5 items, ≥48–56px tall **plus** `env(safe-area-inset-bottom)`,
  labels under icons, one item per finger width.
- Dialogs on phones become **bottom sheets** — actions land in the thumb arc
  and the sheet animates from where it lives:
  ```css
  @media (max-width: 640px) {
    .scrim { padding: 0; align-items: flex-end; }
    .sheet { max-width: none; max-height: 92svh;
             border-radius: 16px 16px 0 0;
             padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
  }
  ```
- Don't put a swipe gesture in the same axis/region as the OS back-swipe (left
  edge on iOS) or the pull-to-refresh zone (top on Android).
- Reachability beats density: a 24px gutter on a 375px phone spends 13% of the
  viewport on whitespace; 16px is usually the better trade on data-dense screens.

---

## 8. Accessible mobile modals, drawers, sheets

**Use the native `<dialog>` + `showModal()` unless you have a reason not to.**
It gives you, for free: top-layer painting (no z-index war), `::backdrop`,
`inert`-ing the rest of the document (real focus containment, not a JS trap),
Escape / platform dismiss handling, and focus restoration to the invoker.

```tsx
function Sheet({ open, onClose, title, children }: SheetProps) {
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      // `closedby="any"` = backdrop/light dismiss + Esc + your own buttons.
      // Baseline-newer; harmless where unsupported (falls back to closerequest).
      closedby="any"
      aria-labelledby="sheet-title"
      onClose={onClose}
      onCancel={onClose}
      className="sheet"
    >
      <header><h2 id="sheet-title">{title}</h2>
        <button autoFocus onClick={onClose} aria-label="Close">✕</button>
      </header>
      <div className="sheet__body">{children}</div>
    </dialog>
  );
}
```
```css
dialog.sheet {
  margin: auto; padding: 0; border: 0;
  max-inline-size: min(92vw, 40rem);
  max-block-size: min(92svh, 100%);        /* svh: never taller than the *visible* viewport */
  overflow: hidden;                        /* the body scrolls, not the dialog */
}
dialog.sheet::backdrop { background: rgb(0 0 0 / .5); backdrop-filter: blur(4px); }
.sheet__body { overflow: auto; overscroll-behavior: contain; }

/* Native dialog does not stop the page behind from scrolling. */
html:has(dialog[open]) { overflow: hidden; }   /* + the JS lock in §6.3 for iOS */

@media (max-width: 640px) {                     /* phone → bottom sheet */
  dialog.sheet { margin-block-end: 0; max-inline-size: 100vw; width: 100vw;
                 border-radius: 16px 16px 0 0; }
}
@media (prefers-reduced-motion: reduce) { dialog.sheet { animation: none; } }
```

Rules regardless of implementation:
- `closedby` values: `any` (light dismiss + platform + JS), `closerequest`
  (Esc/back gesture + JS — the `showModal()` default), `none` (JS only; use for
  destructive confirms).
- `autofocus` goes on the **cancel/close** control, not confirm, so an
  accidental Enter never destroys data. Never `tabindex` the `<dialog>` itself.
- Always ship an explicit visible close button; backdrop tap alone is not
  discoverable and not accessible.
- If you hand-roll: `role="dialog"` + `aria-modal="true"` + `aria-labelledby`,
  a real focus trap (Tab and Shift+Tab wrap), `inert` on the rest of the tree,
  Escape handling that only the topmost dialog answers, focus restoration with
  `focus({ preventScroll: true })` (without `preventScroll`, focusing the first
  field of a bottom sheet scrolls the frozen page behind it), and a ref-counted
  scroll lock for nesting.
- Backdrop dismissal: close on **`pointerdown` on the backdrop that also ends
  there** (or compare `event.target === dialogEl` and use the dialog's own
  padding as the hit area). Closing on a bare `click` on the scrim fires when a
  drag-select started inside and released outside.
- Animating a dialog in/out loses the browser's automatic focus restoration —
  restore it yourself in the close handler.
- Do not `inert` an element that contains the focused element without moving
  focus first (focus is silently lost to `<body>`).

---

## 9. `prefers-reduced-motion` and `hover`/`pointer` media queries

```css
/* Positive form: only animate when the user hasn't opted out. */
@media (prefers-reduced-motion: no-preference) {
  .toast { animation: slide-in 220ms var(--ease-out); }
}
/* Belt-and-braces global reduction (see §0). Token-level is even better: */
@media (prefers-reduced-motion: reduce) {
  :root { --duration-fast: 0ms; --duration-normal: 0ms; --duration-slow: 0ms; }
}
```
```ts
const mq = window.matchMedia('(prefers-reduced-motion: reduce)'); // parens required!
mq.addEventListener('change', () => stopWebAnimations(mq.matches));
```
You can also gate a whole stylesheet:
`<link rel="stylesheet" href="anim.css" media="(prefers-reduced-motion: no-preference)">`,
and swap animated `<source>`s in `<picture>` on the same query. Request-time:
the `Sec-CH-Prefers-Reduced-Motion` client hint.

Hover on touch: a touchscreen "hovers" on tap and **latches** — rows and cards
accumulate stuck hover colours. Always write hover styles inside a query rather
than unwinding them later:

```css
@media (hover: hover) and (pointer: fine) {
  tbody tr:hover { background: var(--surface-hover); }
  .tooltip:hover .bubble { opacity: 1; }
}
```
- `hover: hover | none` and `pointer: coarse | fine | none` describe the
  **primary** input. `any-hover` / `any-pointer` describe *any* available input —
  use `any-pointer: coarse` when you want to enlarge targets on a hybrid
  laptop/touchscreen, and `hover: hover` when deciding whether hover-only
  affordances are allowed to exist.
- Never hide information behind hover-only UI on mobile: a tooltip that opens on
  tap covers the thing that was tapped. Give it a tap-to-toggle popover or
  inline text.
- Related: `@media (prefers-reduced-transparency)`, `(prefers-contrast)`,
  `(forced-colors)`, `(prefers-color-scheme)`, `(dynamic-range)`.

---

## 10. Data tables, complex grids, drag-and-drop on touch

### 10.1 Tables

Two viable patterns; pick per table, not per app.

**A. Scroll container (keeps tabular semantics — best for dense data):**
```tsx
<div className="scroll-x" role="region" aria-label="Sessions" tabIndex={0}>
  <table>…</table>
</div>
```
```css
.scroll-x { overflow-x: auto; overscroll-behavior-x: contain; }
.scroll-x:focus-visible { outline: 2px solid var(--focus); }
@media (max-width: 640px) {              /* bleed to the screen edges so the gutter
                                            doesn't eat scrollable width */
  .scroll-x--bleed { margin-inline: calc(var(--gutter) * -1); padding-inline: var(--gutter); }
}
thead th { position: sticky; top: 0; background: var(--surface); z-index: 1; white-space: nowrap; }
```
`role="region"` + `aria-label`/`aria-labelledby` (point it at the `<caption>`)
+ `tabIndex={0}` are **required**: a scrollable region that contains no
focusable elements is otherwise unreachable by keyboard (Roselli). Do not add
`tabindex` to a region that is already fully keyboard operable *and* not
scrollable.

**B. Stacked cards below a breakpoint** (for narrative/1-2 column tables):
```css
@media (max-width: 37em) {
  table, tr, td { display: block; }
  thead { display: none; }
  td::before { content: attr(data-label) ": "; font-weight: 600; }
}
```
Caveat: `display: block` on table parts **removes the table semantics** in some
screen readers. Prefer pattern A for anything a user needs to compare across
rows; if you use B, keep the header text in `data-label` and test with VoiceOver.

Also: right-align numbers, `white-space: nowrap` only on headers/short cells,
`font-variant-numeric: tabular-nums`, and never rely on hover-revealed row
actions on touch (put them in a visible overflow menu).

### 10.2 Drag and drop (dnd-kit) on touch

The core conflict: **PointerSensor requires `touch-action: none` on the
draggable** (with Pointer Events there is no way to `preventDefault()` the
browser's scroll from a listener), but `touch-action: none` on a large
draggable surface makes that surface unscrollable by finger.

Three correct resolutions (dnd-kit docs):

```tsx
// 1) Drag handle only: touch-action: none on the *handle*, list still scrolls.
const { attributes, listeners, setNodeRef, setActivatorNodeRef } = useSortable({ id });
<li ref={setNodeRef}>
  <span ref={setActivatorNodeRef} {...attributes} {...listeners} className="handle" />
  …
</li>
// css: .handle { touch-action: none; }

// 2) Long-press to drag with Mouse+Touch sensors instead of Pointer.
//    TouchSensor CAN preventDefault in touchmove, so `manipulation` is enough.
const sensors = useSensors(
  useSensor(MouseSensor,    { activationConstraint: { distance: 4 } }),
  useSensor(TouchSensor,    { activationConstraint: { delay: 250, tolerance: 5 } }),
  useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
);
// css: .draggable { touch-action: manipulation; }   /* scrollable until the hold fires */

// 3) Pointer sensor + distance constraint where the surface is not scrollable.
useSensor(PointerSensor, { activationConstraint: { distance: 8 } });
```
`DistanceConstraint` and `DelayConstraint` are **mutually exclusive**. For touch,
always pair a delay with a `tolerance` (~5px) — fingers drift, and
`tolerance: 0` aborts every drag.

Touch-drag hygiene:
```css
@media (pointer: coarse) {
  .draggable {
    touch-action: manipulation;
    -webkit-user-select: none; user-select: none;
    -webkit-touch-callout: none;   /* long press must not raise the iOS magnifier */
  }
}
```
- Always ship a **keyboard alternative** to the drag (dnd-kit's KeyboardSensor,
  or explicit "move up/down"/"assign to…" controls). WCAG 2.2 SC 2.5.7
  *Dragging Movements* requires a single-pointer non-dragging alternative.
- Auto-scroll while dragging near container edges (dnd-kit does this) matters far
  more on a 700px-tall phone than on desktop.
- Announce drag state via `announcements`/`aria-live` — a touch user with
  VoiceOver gets nothing from visual movement alone.

---

## 11. Verification checklist (what to actually test)

Device/emulator matrix: real iPhone with a notch **and** the URL bar visible;
iPhone in landscape (left/right insets); Android Chrome (keyboard reflow);
iPad split view; a hybrid touchscreen laptop (`any-pointer: coarse` +
`hover: hover`).

- [ ] No horizontal document scrollbar at 320px, 360px, 390px, 414px widths.
- [ ] Pinch-zoom to 5× works everywhere (no `user-scalable=no`).
- [ ] Focus each input on iOS: **no page zoom**, field stays visible above the keyboard.
- [ ] Open a bottom sheet, scroll to its end, keep flicking: the page behind must not move.
- [ ] Close the sheet: scroll position preserved, focus back on the invoker.
- [ ] Rotate the device with a sheet open: nothing off-screen.
- [ ] Tap a table row, then scroll: no stuck hover colour.
- [ ] All interactive targets ≥24×24 CSS px (WCAG 2.5.8) and ≥44px on touch.
- [ ] Bottom bar / FAB clears the home indicator (test on a notched device, not the emulator).
- [ ] `prefers-reduced-motion: reduce` (iOS: Settings → Accessibility → Motion) removes animation.
- [ ] Drag-and-drop: list still scrolls by finger; drag has a keyboard equivalent.
- [ ] Lighthouse mobile: no "tap targets too small", no CLS from keyboard open.

---

## 12. StageStack audit (`apps/web`, Aug 2026)

**Already correct — keep and don't regress** (evidence in-repo):
- `src/routes/__root.tsx`: `width=device-width, initial-scale=1, viewport-fit=cover`
  (+ `interactive-widget=resizes-content`), no `user-scalable`/`maximum-scale`. ✅
- `ds/tokens/layout.css`: `--safe-*` tokens with `max(0px, env(...))`, consumed by
  `routes/app.tsx` (topbar height + inset padding, landscape L/R), `toast.tsx`,
  `feedback.css` (sheet bottom padding). ✅
- `ds/tokens/base.css`: `-webkit-text-size-adjust: 100%`, `overflow-wrap: break-word`,
  `-webkit-tap-highlight-color: transparent`, a `pointer: coarse` block that takes
  inputs to 16px and controls to 38/44/48px, a 44px pseudo-element hit area for
  checkbox/switch, and a `hover: none` unwind block. ✅
- `styles/app.css`: `min-width: 0` on the shell main (documented), `100dvh` rail,
  `.scroll-x` with `overscroll-behavior-x: contain`, phone gutter 24→16px. ✅
- `feedback.css`: dialog `max-height: 86dvh`/`92dvh`, body `overscroll-behavior: contain`,
  phone bottom-sheet variant, reduced-motion block; `motion.css` zeroes duration tokens. ✅
- `Dialog.jsx`: ref-counted `position: fixed` scroll lock with position restore and
  `overflowY: scroll` gutter retention, `focus({ preventScroll: true })`, focus
  restore, Tab wrap, Escape with `stopPropagation` for nesting. ✅ (matches the
  Freestone-validated pattern)
- `DataTable.jsx`: `role="region"` + `aria-label` + `tabIndex={0}` on the scroller. ✅
- Agenda DnD: `.agenda-draggable { touch-action: none }` with a
  `pointer: coarse` override to `manipulation` + `user-select: none` +
  `-webkit-touch-callout: none`, and a 250 ms/5px TouchSensor. ✅ (textbook)

**Gaps / recommended changes**, highest value first:

1. **`interactive-widget=resizes-content` is Android-only.** caniuse (Aug 2026):
   not supported in Safari or Safari iOS through 26.5, nor desktop Chromium. The
   comment in `__root.tsx` implies it fixes keyboard occlusion generally — it does
   not on iPhone. Add the `--kb` visualViewport shim (§1.2) and use it for any
   fixed bottom UI, or drop the attribute to avoid Android-only reflow/CLS and
   handle both platforms with the shim.
2. **`-webkit-overflow-scrolling: touch` is dead code** (`styles/app.css` `.scroll-x`,
   `feedback.css` `.ss-dialog__body`). No-op since iOS 13 and historically
   bug-prone. Delete both.
3. **WCAG 2.5.8 on fine pointers.** `.ss-iconbtn--sm` is 28×28 and `--md` is 34×34
   with the 38/44px bumps applied only under `pointer: coarse`. 2.5.8's 24×24 floor
   applies to *all* pointer inputs — 28×28 passes, but any 24px-or-smaller control
   (e.g. `.ss-tag__x` outside coarse, custom hit areas) needs the padding/negative-margin
   trick unconditionally, or must satisfy the 24px-spacing exception.
4. **Invert the `hover: none` block** in `base.css` into `@media (hover: hover)`.
   The current unwind list must be edited every time a hover style is added
   anywhere in the DS — a silent-regression factory. Same behaviour, half the code.
5. **Consider `svh` for sheets.** `86dvh`/`92dvh` recompute (throttled) while the
   URL bar collapses, so an open sheet resizes mid-interaction. `92svh` is stable
   and guaranteed visible; keep `dvh` for the app shell only.
6. **Native `<dialog>`**: the hand-rolled trap in `Dialog.jsx` is good, but
   `showModal()` would delete ~80 lines (inert, Esc, top layer, focus restore),
   fix z-index stacking against `--z-modal`, and give `closedby="any"` backdrop
   dismissal. Also, the scrim currently closes on `onClick`, which fires when a
   text drag-select starts inside the sheet and releases on the scrim — compare
   `pointerdown` and `pointerup` targets (or migrate to `closedby`).
7. **`overflow-x: clip` guard on `html, body`** is absent; one wide element still
   pans the document. Use `clip` (not `hidden`) so `position: sticky` survives.
8. **`scrollbar-gutter: stable` on `html`** to remove the desktop shift on dialog
   open (the lock already mitigates it via `overflowY: scroll`; the modern
   property is cleaner).
9. **`scroll-padding-block-start`** on `html` equal to the sticky topbar height +
   `--safe-top`, so anchors/`scrollIntoView` don't land under the topbar; and
   `scroll-padding-block-end` on form scrollers for the keyboard (§4.3).
10. **`enterKeyHint` coverage**: `Input.jsx` maps `inputMode` per type and
    `SearchInput` sets both, but general text fields get no `enterKeyHint`.
    Add `next` for non-final fields / `done` on the last field of each form.
11. **`autoComplete="off"` is used widely in portal/CFP forms.** Correct for
    one-off event fields, wrong for person fields — `ProfileCard` already gets
    `given-name`/`family-name` right; audit the rest for `email`, `tel`,
    `organization`, `one-time-code`.
12. **Tables**: consider `overscroll-behavior-x: contain` is present ✅ but add a
    scroll-affordance (edge fade / "scroll for more" hint) and
    `font-variant-numeric: tabular-nums` for numeric columns.

---

## 13. Sources

Viewport & units
- web.dev — The large, small, and dynamic viewport units: https://web.dev/blog/viewport-units
- Chrome for Developers — Prepare for viewport resize behavior changes coming to Chrome on Android (`interactive-widget`, Interop 2022 groups): https://developer.chrome.com/blog/viewport-resize-behavior
- MDN — `<meta name="viewport">` (all keys, `interactive-widget`, `viewport-fit`, zoom warnings): https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport
- caniuse — `interactive-widget` support: https://caniuse.com/mdn-html_elements_meta_name_viewport_interactive-widget
- CSS Values 4 — viewport-relative lengths: https://www.w3.org/TR/css-values-4/#viewport-relative-lengths
- MDN — VisualViewport API: https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport
- Chrome for Developers — VirtualKeyboard API + `env(keyboard-inset-*)`: https://developer.chrome.com/docs/web-platform/virtual-keyboard

Safe areas
- WebKit — Designing Websites for iPhone X (`viewport-fit=cover`, `env()`): https://webkit.org/blog/7929/designing-websites-for-iphone-x/
- MDN — `env()`: https://developer.mozilla.org/en-US/docs/Web/CSS/env
- Polypane — Using safe-area-inset to build mobile-safe layouts (incl. `safe-area-max-inset-*`, May 2026): https://polypane.app/blog/using-safe-area-inset-to-build-mobile-safe-layouts/

Touch, targets, gestures
- W3C — Understanding SC 2.5.8 Target Size (Minimum), WCAG 2.2: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- W3C — Understanding SC 2.5.7 Dragging Movements: https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html
- Apple HIG — Accessibility (44×44 pt default, 28×28 pt minimum, spacing): https://developer.apple.com/design/human-interface-guidelines/accessibility
- Apple HIG — Layout (safe areas, full-bleed, avoid full-width buttons): https://developer.apple.com/design/human-interface-guidelines/layout
- Material 3 — Structure/accessibility (48×48 dp touch, 44 dp pointer, 8 dp spacing): https://m3.material.io/foundations/designing/structure
- MDN — `touch-action`: https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action
- MDN — `-webkit-tap-highlight-color`: https://developer.mozilla.org/en-US/docs/Web/CSS/-webkit-tap-highlight-color
- Chrome for Developers — 300ms tap delay, gone away: https://developer.chrome.com/blog/300ms-tap-delay-gone-away

Forms & keyboards
- CSS-Tricks — 16px or larger text prevents iOS form zoom: https://css-tricks.com/16px-or-larger-text-prevents-ios-form-zoom/
- MDN — `inputmode`: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inputmode
- MDN — `enterkeyhint`: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/enterkeyhint
- MDN — `text-size-adjust`: https://developer.mozilla.org/en-US/docs/Web/CSS/text-size-adjust

Scrolling & overflow
- MDN — `overscroll-behavior` (scroll chaining, `overflow:hidden` boundary note): https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior
- Jay Freestone — Locking body scroll for modals on iOS: https://www.jayfreestone.com/writing/locking-body-scroll-ios/
- Ben Frain — Preventing body scroll for modals in iOS: https://benfrain.com/preventing-body-scroll-for-modals-in-ios/
- `-webkit-overflow-scrolling` removed/no-op since iOS 13: https://www.testmuai.com/learning-hub/webkit-overflow-scrolling-browser-support/ and Jake Archibald: https://x.com/jaffathecake/status/1136246215430086657
- MDN — `scroll-snap-type`: https://developer.mozilla.org/en-US/docs/Web/CSS/scroll-snap-type
- MDN — `scrollbar-gutter`: https://developer.mozilla.org/en-US/docs/Web/CSS/scrollbar-gutter
- CSS-Tricks — Flexbox and truncated text (`min-width: 0`): https://css-tricks.com/flexbox-truncated-text/
- MDN — `overflow-wrap`: https://developer.mozilla.org/en-US/docs/Web/CSS/overflow-wrap

Dialogs, motion, hover
- MDN — `<dialog>` (`closedby`, light dismiss, `inert`, `autofocus`, `::backdrop`): https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog
- MDN — `inert`: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inert
- web.dev (Adam Argyle) — Building a dialog component: https://web.dev/articles/building/a-dialog-component
- web.dev — `prefers-reduced-motion`: Sometimes less movement is more: https://web.dev/articles/prefers-reduced-motion
- MDN — `@media (hover)`: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/hover
- MDN — `@media (pointer)`: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/pointer

Tables, DnD, ergonomics
- Adrian Roselli — A Responsive Accessible Table (`role="region"` + `tabindex="0"`): https://adrianroselli.com/2017/11/a-responsive-accessible-table.html
- Adrian Roselli — Hey, it's still OK to use tables: https://adrianroselli.com/2017/11/hey-its-still-ok-to-use-tables.html
- dnd-kit — Sensors: https://docs.dndkit.com/api-documentation/sensors
- dnd-kit — Pointer sensor (`touch-action: none` requirement, drag handles): https://dndkit.com/legacy/api-documentation/sensors/pointer
- dnd-kit — Touch sensor (delay + tolerance, `manipulation`): https://dndkit.com/legacy/api-documentation/sensors/touch
- Smashing Magazine — The Thumb Zone: Designing For Mobile Users (Hoober 49%, Clark 75%): https://www.smashingmagazine.com/2016/09/the-thumb-zone-designing-for-mobile-users/
- Smashing Magazine — The Golden Rules Of Mobile Navigation Design: https://www.smashingmagazine.com/2016/11/the-golden-rules-of-mobile-navigation-design/
