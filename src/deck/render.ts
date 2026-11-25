import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Review } from '../types.ts';
import { fill, labelsFor, localeOf, type Labels } from './i18n.ts';
import { palette } from './colors.ts';
import { themeIcon, valueIcon } from './icons.ts';
import { imageSize } from './images.ts';
import { change, trendPoints } from './numbers.ts';
import { coverPicture, isWide, numbers, planDeck } from './plan.ts';
import type { DeckConfig } from '../config.ts';
import { fontFaceCss, type FontFace } from '../brand/fonts.ts';
type PlannedSlide = ReturnType<typeof planDeck>[number];

const CSS = readFileSync(fileURLToPath(new URL('../../assets/deck.css', import.meta.url)), 'utf8');
const DARK_CSS = readFileSync(fileURLToPath(new URL('../../assets/deck-dark.css', import.meta.url)), 'utf8');

export interface RenderOptions {
  /** #rrggbb */
  color?: string | null;
  /** A data URI. */
  logo?: string | null;
  labels?: Record<string, string>;
  goal?: string | null;
  /** light (default) or dark. */
  theme?: 'dark' | 'light';
  /** Font families as CSS would take them. Fonts must be installed where the deck is shown. */
  fonts?: { heading?: string | null; body?: string | null };
  /** Which slides show and how dense they are; the config's deck section. */
  deck?: DeckConfig;
  /** Font files inside the deck, so the brand fonts show on any laptop. */
  fontFaces?: FontFace[];
}

/** A font name from a config or a .pptx, quoted, with the theme's own fonts behind it. Anything odd is dropped. */
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function fontStack(name: string): string {
  const clean = name.replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  // A fixed fallback: --font-body set to a stack that names var(--font-body) points at itself, and
  // the browser then drops it and shows its default serif.
  return clean ? `"${clean}", ${SANS}` : 'inherit';
}

/** A picture for an img src: only an image data URI passes (review.json can be edited by hand). */
/** A clip for a video src: only an mp4 or webm data URI passes. */
export const VIDEO_DATA_URI = /^data:video\/(mp4|webm);base64,[A-Za-z0-9+/=]+$/;
export const IMAGE_DATA_URI = /^data:image\/(png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
/**
 * A before or after picture in a box with the after picture's shape, so both show the same size
 * and a frame around the change sits exactly on it at any size. A phone shows one screen around
 * the change; a full-page phone picture from an older review shows its top, without a frame.
 */
function shot(uri: string, alt: string, s: Review['screens'][number], frame: boolean): string {
  const img = `<img src="${picture(uri)}" alt="${esc(alt)}">`;
  const size = imageSize(s.after);
  if (!size || (s.device === 'phone' && size.h / size.w > PHONE_SCREEN * 1.05)) return img;
  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
  const f = frame && s.focus ? `<i class="focus" style="left: ${pct(s.focus.x)}; top: ${pct(s.focus.y)}; width: ${pct(s.focus.w)}; height: ${pct(s.focus.h)}"></i>` : '';
  // Zooming in (one press of →) scales the picture around the change's center, enough to fill most of the box.
  const zs = zoomScale(s);
  // Scaled around the change's center, then moved toward the middle, but never so far that an edge of the box shows empty.
  const shift = (c: number, k: number) => Math.min(c * (k - 1), Math.max((1 - c) * (1 - k), 0.5 - c));
  // A change wider than the zoomed view (a whole row on a phone) is shown from its start, where it begins.
  const cx = s.focus && zs ? s.focus.x + Math.min(s.focus.w, 0.9 / zs) / 2 : 0;
  const zoom =
    frame && s.focus && zs
      ? ` --zx: ${pct(cx)}; --zy: ${pct(s.focus.y + s.focus.h / 2)}; --zs: ${zs}; --tx: ${pct(shift(cx, zs))}; --ty: ${pct(shift(s.focus.y + s.focus.h / 2, zs))};`
      : '';
  return `<span class="shot" style="--r: ${Math.round((size.w / size.h) * 1000) / 1000};${zoom}">${img}${f}</span>`;
}
/** How far to zoom into the change: enough for it to fill most of the picture, at most 2.5 times. Null when it would hardly grow. */
function zoomScale(s: Review['screens'][number]): number | null {
  if (!s.focus) return null;
  const size = imageSize(s.after);
  if (s.device === 'phone' && (!size || size.h / size.w > PHONE_SCREEN * 1.05)) return null;
  // A phone is small on the slide: a change across the whole row still zooms, to the row's start.
  const width = s.device === 'phone' ? Math.min(s.focus.w, PHONE_ZOOM_WIDTH) : s.focus.w;
  const scale = Math.min(2.5, 0.85 / Math.max(width, s.focus.h));
  return scale >= 1.4 ? Math.round(scale * 100) / 100 : null;
}
/** A phone screen's height over its width. */
const PHONE_SCREEN = 844 / 390;
/** On a phone, the share of the screen's width a zoom keeps in view at least. */
const PHONE_ZOOM_WIDTH = 0.4;
const picture = (uri: unknown) => (typeof uri === 'string' && IMAGE_DATA_URI.test(uri) ? uri : '');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The deck: one self-contained HTML page. No outside fonts, scripts or images, so it opens
 * anywhere, works offline and keeps working. Pictures are data URIs. The model wrote none of this.
 */
export function renderDeck(review: Review, options: RenderOptions = {}): string {
  const t = labelsFor(review.language, options.labels);
  const org = review.organization;
  const color = options.color && /^#[0-9a-fA-F]{6}$/.test(options.color) ? options.color : null;
  const logo = options.logo && /^data:image\/(png|jpeg|svg\+xml|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(options.logo) ? options.logo : null;
  const goal = options.goal ?? null;
  const rise = (i: number) => (i ? ` style="--i: ${i}"` : '');
  const nf = new Intl.NumberFormat(localeOf(review.language));
  const head = (eyebrow: string, title: string, extra = '') => `<header class="head">
    <p class="eyebrow rise">${eyebrow}${extra}</p>
    <h2 class="rise"${rise(1)}>${esc(title)}</h2>
  </header>`;
  const points = (items: string[], from: number) => `<ul class="points">${items.map((p, j) => `\n      <li class="rise"${rise(j + from)}>${esc(p)}</li>`).join('')}
    </ul>`;
  const logoImg = logo ? `<img class="brand-logo plate" src="${logo}" alt="${esc(org)}">` : '';

  const slide = (p: PlannedSlide): string => {
    switch (p.kind) {
      case 'cover': {
        // The product on the cover: the sprint's first desktop screenshot, large, bleeding off the edge.
        const heroImage = coverPicture(review);
        return `<section class="slide cover${heroImage ? ' with-product' : ''}" data-ref="cover">
  ${heroImage ? `<img class="product rise" style="--i: 2" src="${picture(heroImage)}" alt="">` : '<div class="rings" aria-hidden="true"></div>'}
  ${logoImg}
  ${org ? `<p class="eyebrow rise">${esc(org)}</p>` : ''}
  <h1 class="rise"${rise(1)}>${esc(review.title)}</h1>
  <p class="rise"${rise(2)}>${esc(review.period)}</p>
  ${goal ? `<p class="goal rise"${rise(3)}><b>${esc(t.goalLabel)}</b><span>${esc(goal)}</span></p>` : ''}
</section>`;
      }
      case 'headline':
        return `<section class="slide statement" data-ref="headline">
  <p class="eyebrow rise">${esc(t.summaryTitle)}</p>
  <h1 class="rise"${rise(1)}>${esc(review.headline ?? '')}</h1>
  <ul class="theme-map">${review.themes.map((th, i) => `\n    <li class="rise"${rise(i + 2)}>${themeIcon(th.icon)}<span>${esc(th.title)}</span></li>`).join('')}
  </ul>
  ${review.summaryNotes ? `<aside class="notes">${esc(review.summaryNotes)}</aside>` : ''}
</section>`;
      case 'answered':
        return `<section class="slide" data-ref="answered">
  ${head(esc(t.answeredLabel), t.answeredTitle)}
  <ul class="answered">${review.answered!.map((a, i) => `\n    <li class="rise"${rise(i + 2)}><q>${esc(a.ask)}</q><span>${esc(a.did)}</span></li>`).join('')}
  </ul>
</section>`;
      case 'lastTime': {
        const said = review.lastTime!;
        const done = said.items.filter((m) => m.done).length;
        return `<section class="slide" data-ref="lastTime">
  ${head(esc(t.lastTimeLabel), fill(t.lastTimeTitle, { n: done, total: said.items.length }))}
  <ul class="promises">${said.items.map((m, i) => `\n    <li class="rise ${m.done ? 'done' : ''}"${rise(i + 2)}><span class="tag">${esc(m.done ? t.statusDone : t.statusOpen)}</span><span>${esc(m.text)}</span></li>`).join('')}
  </ul>
</section>`;
      }
      case 'theme': {
        const th = review.themes[p.index]!;
        const chip = th.value ? ` <span class="chip">${valueIcon(th.value)}${esc(t[`value_${th.value}` as keyof Labels] ?? th.value)}</span>` : '';
        const alt = th.screen ? (p.layout === 'phone' ? fill(t.onPhone, { name: th.screen.name }) : th.screen.name) : '';
        // A clip plays muted in a loop while its slide is open; the picture is its poster, and what prints.
        const media = !th.screen
          ? ''
          : th.screen.video && VIDEO_DATA_URI.test(th.screen.video)
            ? `<video src="${th.screen.video}" poster="${picture(th.screen.image)}" muted loop playsinline preload="auto" aria-label="${esc(alt)}"></video>`
            : `<img src="${picture(th.screen.image)}" alt="${esc(alt)}">`;
        const shot = th.screen ? `<figure class="screen ${p.layout === 'phone' ? 'phone ' : ''}rise"${rise(3)}>${media}</figure>` : '';
        const body =
          p.layout === 'icon'
            ? `<div class="tile rise"${rise(2)}>${themeIcon(th.icon)}</div>\n    ${points(th.points, 3)}`
            : p.layout === 'full'
              ? `${shot}\n    ${points(th.points, 4)}`
              : `${points(th.points, 2)}\n    ${shot}`;
        // A strip (a row of cards) keeps its points right under it instead of at the foot of the slide.
        const strip = p.layout === 'full' && th.screen && isWide(th.screen.image) ? ' strip' : '';
        return `<section class="slide theme layout-${p.layout}${p.flip ? ' flip' : ''}${strip}" data-ref="theme-${p.index}">
  ${head(esc(th.title), th.effect ?? th.title, chip)}
  <div class="body">
    ${body}
  </div>
  ${th.notes ? `<aside class="notes">${esc(th.notes)}</aside>` : ''}
</section>`;
      }
      case 'cards': {
        const themes = p.indexes.map((i) => review.themes[i]!);
        // The points of a theme on a card go to the notes: the card has room for its message only.
        const notes = themes.map((th) => [th.title, ...th.points].join(': ')).join('\n');
        return `<section class="slide" data-ref="cards">
  ${head(esc(t.moreLabel), t.moreTitle)}
  <div class="cards${themes.length === 2 ? ' two' : ''}">${themes
    .map(
      (th, i) => `
    <div class="card rise"${rise(i + 2)} data-ref="theme-${p.indexes[i]}">
      <span class="card-icon">${themeIcon(th.icon)}</span>
      <h3>${esc(th.title)}</h3>
      ${th.effect ? `<p>${esc(th.effect)}</p>` : ''}
    </div>`,
    )
    .join('')}
  </div>
  <aside class="notes">${esc(notes)}</aside>
</section>`;
      }
      case 'screen': {
        const s = review.screens[p.index]!;
        const steps = zoomScale(s) ? ' data-steps="1"' : '';
        return `<section class="slide" data-ref="screen-${p.index}"${steps}>
  ${head(esc(s.name), s.caption ?? s.name)}
  <div class="compare ${s.device === 'phone' ? 'phone' : ''}">
    <figure class="rise"${rise(2)}>
      <figcaption>${esc(t.before)}</figcaption>
      ${shot(s.before, fill(t.beforeAlt, { name: s.name }), s, false)}
    </figure>
    <figure class="after rise"${rise(3)}>
      <figcaption>${esc(t.after)}</figcaption>
      ${shot(s.after, fill(t.afterAlt, { name: s.name }), s, true)}
    </figure>
  </div>
</section>`;
      }
      case 'hood':
        return `<section class="slide hood" data-ref="hood">
  ${head(esc(t.hoodLabel), t.hoodTitle)}
  <ul class="hood-list">${review.underTheHood.map((x, i) => `\n    <li class="rise"${rise(i + 2)}><span class="tag">${esc(t[`kind_${x.kind}` as keyof Labels] ?? x.kind)}</span><span>${esc(x.text)}</span></li>`).join('')}
  </ul>
</section>`;
      case 'roadmap': {
        if (p.milestones.some((m) => m.stage)) {
          // A Now / Next roadmap: two columns, no percentage, since such a roadmap counts nothing done.
          const column = (stage: 'now' | 'next', label: string, i0: number) => {
            const items = p.milestones.filter((m) => m.stage === stage);
            return items.length ? `<div class="stage ${stage} rise"${rise(i0)}><b>${esc(label)}</b><ul>${items.map((m) => `<li>${esc(m.text)}</li>`).join('')}</ul></div>` : '';
          };
          return `<section class="slide" data-ref="roadmap">
  ${head(esc(t.roadmapLabel), t.roadmapPlanTitle)}
  <div class="stages">${column('now', t.roadmapNow, 2)}${column('next', t.roadmapNext, 3)}</div>
</section>`;
        }
        const reached = review.milestones.filter((m) => m.done).length;
        const next = p.milestones.findIndex((m) => !m.done);
        return `<section class="slide" data-ref="roadmap">
  ${head(esc(t.roadmapLabel), fill(t.roadmapReached, { n: reached, total: review.milestones.length }))}
  <ol class="timeline" style="--n: ${p.milestones.length}">${p.milestones.map((m, i) => `\n    <li class="rise ${m.done ? 'done' : i === next ? 'next' : ''}"${rise(i + 2)}>${i === next ? `<b>${esc(t.roadmapNext)}</b>` : ''}<span>${esc(m.text)}</span></li>`).join('')}
  </ol>
</section>`;
      }
      case 'usage': {
        const tiles = numbers(review);
        const delta = (u: (typeof tiles)[number]) => {
          const c = change(u, localeOf(review.language));
          const before = u.previous ?? u.history?.at(-1);
          const line = trendPoints(u);
          const svgLine = line
            ? `<svg class="trend" viewBox="0 0 120 30" aria-hidden="true"><polyline points="${line.map((p) => `${p.x},${p.y}`).join(' ')}"/><circle cx="${line.at(-1)!.x}" cy="${line.at(-1)!.y}" r="3"/></svg>`
            : '';
          return `${c && before !== undefined ? `<small class="${c.good ? 'good' : 'bad'}"><b>${esc(c.text)}</b> · ${esc(t.previous)}: ${nf.format(before)}</small>` : ''}${svgLine}`;
        };
        return `<section class="slide" data-ref="usage">
  ${head(esc(t.usageLabel), fill(t.usageTitle, { product: review.product }))}
  <div class="tiles${tiles.length === 1 ? ' one' : ''}">${tiles
    .map(
      (u, i) => `
    <div class="tile-number rise"${rise(i + 2)}>
      <b data-count="${u.value}">${nf.format(u.value)}</b>
      <p>${esc(u.label)}</p>
      ${delta(u)}
    </div>`,
    )
    .join('')}
  </div>
</section>`;
      }
      case 'closing':
        return review.questions.length
          ? `<section class="slide cover closing" data-ref="closing">
  <div class="rings" aria-hidden="true"></div>
  ${logoImg}
  <p class="eyebrow rise">${esc(t.questions)}</p>
  <h2 class="rise"${rise(1)}>${esc(t.feedbackTitle)}</h2>
  <ol class="questions">${review.questions.map((q, i) => `\n    <li class="rise"${rise(i + 2)}>${esc(q)}</li>`).join('')}
  </ol>
</section>`
          : `<section class="slide cover closing" data-ref="closing">
  <div class="rings" aria-hidden="true"></div>
  ${logoImg}
  <h1 class="rise">${esc(t.questions)}</h1>
  <p class="rise"${rise(1)}>${esc(review.headline ?? review.title)}</p>
</section>`;
    }
  };
  const slides = planDeck(review, options.deck).map(slide);
  slides[0] = slides[0]!.replace(/class="slide cover/, 'class="slide active cover');

  const hasNotes = slides.some((x) => x.includes('<aside class="notes">'));
  const theme = options.theme === 'dark' ? 'dark' : 'light';
  // Every color comes from the brand color (or the theme's own accent), measured against the background.
  const p = palette(color ?? (theme === 'dark' ? '#d6b36a' : '#4f46e5'), theme);
  const scope = theme === 'dark' ? 'html[data-theme="dark"]' : ':root';
  const brandCss = `${scope} { --accent: ${p.accent}; --accent-deep: ${p.accentDeep}; --accent-soft: ${p.accentSoft}; --ink: ${p.ink}; --ink-soft: ${p.inkSoft}; --ink-faint: ${p.inkFaint}; --line: ${p.line}; --surface-soft: ${p.surfaceSoft};${theme === 'dark' ? ` --accent-glow: color-mix(in srgb, ${p.accent} 24%, transparent);` : ''} }`;
  const fontCss = [
    options.fonts?.heading ? `--font-heading: ${fontStack(options.fonts.heading)};` : '',
    options.fonts?.body ? `--font-body: ${fontStack(options.fonts.body)};` : '',
  ].join(' ').trim();
  const lang = localeOf(review.language);

  return `<!doctype html>
<html lang="${esc(lang)}" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="sprint-review">
<title>${esc(review.title)}${org ? ` · ${esc(org)}` : ''}</title>
<meta name="description" content="${esc(review.period)}${org ? `, ${esc(org)}` : ''}">
<meta property="og:title" content="${esc(review.title)}${org ? ` · ${esc(org)}` : ''}">
<meta property="og:description" content="${esc(review.period)}">
<script>document.documentElement.classList.add('js')</script>
<style>
${fontFaceCss(options.fontFaces ?? [])}
${CSS}
${theme === 'dark' ? DARK_CSS : ''}
  ${brandCss}
  ${fontCss ? `html[data-theme] { ${fontCss} }` : ''}
  :root { --notes-label: "${t.notesLabel.replace(/["\\<>\r\n]/g, '')}"; }
</style>
</head>
<body>

${slides.join('\n\n')}

<div class="progress" aria-hidden="true"></div>
<div class="counter" aria-live="polite"></div>
<button class="edit-button" type="button" hidden>${esc(t.edit)}</button>
<div class="edit-panel" role="dialog" hidden><p>${esc(t.editStart)}</p><code></code><button type="button">${esc(t.copy)}</button></div>
<button class="download-button" type="button" aria-haspopup="menu" hidden>${esc(t.download)}</button>
<div class="download-menu" role="menu" hidden><button type="button" role="menuitem" data-get="pdf">${esc(t.downloadPdf)}</button><a role="menuitem" data-get="html" download>${esc(t.downloadHtml)}</a><a role="menuitem" data-get="pptx" download hidden>${esc(t.downloadPptx)}</a></div>
<div class="hint" aria-hidden="true"><kbd>←</kbd> <kbd>→</kbd> ${esc(t.hintBrowse)} · <kbd>F</kbd> ${esc(t.hintFullscreen)} · <kbd>P</kbd> ${esc(t.hintPresenter)}${hasNotes ? ` · <kbd>N</kbd> ${esc(t.hintNotes)}` : ''}</div>

<script>
${script(t, lang)}
</script>
</body>
</html>
`;
}

/** Navigation, the count-up of numbers, the self-drawing icons and the presenter window. */
function script(t: Labels, lang: string): string {
  const L = JSON.stringify({
    presenter: t.presenter,
    prev: t.previousSlide,
    next: t.nextSlide,
    slideOf: t.slideOf,
    noNotes: t.noNotes,
    upNext: t.upNext,
    last: t.lastSlide,
    copy: t.copy,
    copied: t.copied,
    lang,
  }).replace(/</g, '\\u003c');
  return `(function () {
  var L = ${L};
  // The page as it was served, before this script changed anything: what HTML saves on a deck opened from disk.
  var source = '<!doctype html>\\n' + document.documentElement.outerHTML;
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var progress = document.querySelector('.progress');
  var counter = document.querySelector('.counter');
  var current = 0;
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var nf = new Intl.NumberFormat(L.lang);

  // A number counts up from zero when its slide opens.
  function countUp(slide) {
    if (reducedMotion) return;
    Array.prototype.forEach.call(slide.querySelectorAll('[data-count]'), function (el) {
      var target = parseInt(el.getAttribute('data-count'), 10) || 0;
      var startAt = null;
      function step(now) {
        if (startAt === null) startAt = now;
        var k = Math.min(1, (now - startAt) / 600);
        el.textContent = nf.format(Math.round(target * (1 - Math.pow(1 - k, 3))));
        if (k < 1) requestAnimationFrame(step);
      }
      el.textContent = '0';
      requestAnimationFrame(step);
    });
  }

  // A slide with steps (a zoom into the change) takes them before moving on.
  var step = 0;
  function forward() {
    var steps = parseInt(slides[current].getAttribute('data-steps') || '0', 10);
    if (step < steps) { step++; slides[current].classList.add('zoomed'); return; }
    show(current + 1);
  }
  function back() {
    if (step > 0) { step--; slides[current].classList.remove('zoomed'); return; }
    show(current - 1);
  }
  function show(n) {
    n = Math.max(0, Math.min(slides.length - 1, n));
    slides[current].classList.remove('zoomed');
    step = 0;
    slides[current].classList.remove('active');
    current = n;
    slides[current].classList.add('active');
    progress.style.width = ((current + 1) / slides.length * 100) + '%';
    counter.textContent = (current + 1) + ' / ' + slides.length;
    try { if (history.replaceState) history.replaceState(null, '', '#' + (current + 1)); } catch (e) { /* not allowed in an embedded preview */ }
    countUp(slides[current]);
    // Only the open slide's clips play, and none with reduced motion: the poster stays.
    Array.prototype.forEach.call(document.querySelectorAll('video'), function (v) {
      if (!reducedMotion && slides[current].contains(v)) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
      else v.pause();
    });
    tellPresenter();
    // Embedded (the editor's preview, a landing page): tell the page around it where we are.
    if (window.parent !== window) window.parent.postMessage({ type: 'sprint-review:slide', n: current + 1, total: slides.length }, '*');
  }
  // ...and let it move the deck: { type: 'sprint-review:go', to: 3 | 'next' | 'prev' | 'theme-2' }.
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (window.parent === window || e.source !== window.parent || !d || d.type !== 'sprint-review:go') return;
    if (d.to === 'next') forward();
    else if (d.to === 'prev') back();
    else if (typeof d.to === 'number') show(d.to - 1);
    else if (typeof d.to === 'string') {
      // A part of the review, such as theme-2: the slide that shows it (a card counts).
      var at = slides.findIndex(function (s) { return s.getAttribute('data-ref') === d.to || !!s.querySelector('[data-ref="' + d.to.replace(/[^\\w-]/g, '') + '"]'); });
      if (at !== -1) show(at);
    }
  });
  // Edit: only on the deck opened from your own disk, never in a published deck or a preview.
  // A file can't start the editor, so the button opens it when it runs and else shows how to start it.
  var editButton = document.querySelector('.edit-button');
  var editPanel = document.querySelector('.edit-panel');
  var EDITOR = 'http://127.0.0.1:4321/';
  if (location.protocol === 'file:' && window.parent === window && editButton && editPanel) {
    var path = decodeURIComponent(location.pathname).replace(/^\\/([A-Za-z]:)/, '$1').replace(/[^\\/]*$/, 'review.json');
    var command = 'npx @guuskeunen/sprint-review edit "' + path + '"';
    editPanel.querySelector('code').textContent = command;
    editButton.hidden = false;
    editButton.addEventListener('click', function () {
      fetch(EDITOR, { mode: 'no-cors', signal: AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined })
        .then(function () { editPanel.hidden = true; window.open(EDITOR, 'sprint-review-editor'); })
        .catch(function () { editPanel.hidden = !editPanel.hidden; });
    });
    var copyButton = editPanel.querySelector('button');
    copyButton.addEventListener('click', function () {
      navigator.clipboard.writeText(command).then(function () { copyButton.textContent = L.copied; setTimeout(function () { copyButton.textContent = L.copy; }, 1500); });
    });
  }

  // Download: on a deck opened from a website, and on one opened from disk so it can be passed on.
  // Never inside another page. PDF prints every slide as a page; HTML is this deck as one file, which
  // works offline; PowerPoint when a deck.pptx sits beside it on a website.
  var downloadButton = document.querySelector('.download-button');
  var downloadMenu = document.querySelector('.download-menu');
  var fromSite = /^https?:$/.test(location.protocol);
  if ((fromSite || location.protocol === 'file:') && window.parent === window && downloadButton && downloadMenu) {
    var here = location.href.split('#')[0];
    var name = (document.title || 'sprint-review').toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]+/g, '-').replace(/^-+|-+$/g, '') || 'sprint-review';
    var htmlLink = downloadMenu.querySelector('[data-get="html"]');
    // A file can't link to itself as a download, so a deck from disk saves the page as it was opened.
    htmlLink.href = fromSite ? here : URL.createObjectURL(new Blob([source], { type: 'text/html' }));
    htmlLink.setAttribute('download', name + '.html');
    // Opened from disk, Edit has the corner: Download sits just left of it.
    if (editButton && !editButton.hidden) {
      var right = Math.round(window.innerWidth - editButton.getBoundingClientRect().left + 8) + 'px';
      downloadButton.style.right = right;
      downloadMenu.style.right = right;
    }
    var pptxLink = downloadMenu.querySelector('[data-get="pptx"]');
    var pptxUrl = new URL('deck.pptx', here).href;
    if (fromSite) fetch(pptxUrl, { method: 'HEAD' }).then(function (r) {
      if (!r.ok) return;
      pptxLink.href = pptxUrl;
      pptxLink.setAttribute('download', name + '.pptx');
      pptxLink.hidden = false;
    }).catch(function () {});
    var setOpen = function (open) { downloadMenu.hidden = !open; downloadButton.setAttribute('aria-expanded', String(open)); };
    downloadButton.hidden = false;
    downloadButton.setAttribute('aria-expanded', 'false');
    downloadButton.addEventListener('click', function () { setOpen(downloadMenu.hidden); });
    downloadMenu.querySelector('[data-get="pdf"]').addEventListener('click', function () { setOpen(false); window.print(); });
    downloadMenu.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('click', function (e) { if (!e.target.closest('.download-button, .download-menu')) setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
  }

  window.addEventListener('hashchange', function () {
    var n = parseInt((location.hash || '').slice(1), 10);
    if (n > 0 && n - 1 !== current) show(n - 1);
  });

  document.addEventListener('keydown', function (e) {
    if (e.target && e.target.closest && e.target.closest('.edit-button, .edit-panel, .download-button, .download-menu')) return;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].indexOf(e.key) !== -1) { e.preventDefault(); forward(); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].indexOf(e.key) !== -1) { e.preventDefault(); back(); }
    else if (e.key === 'Home') show(0);
    else if (e.key === 'End') show(slides.length - 1);
    else if (e.key === 'n' || e.key === 'N') document.body.classList.toggle('show-notes');
    else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    else if (e.key === 'p' || e.key === 'P') openPresenter();
  });

  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(function () {});
    } catch (e) {}
  }

  var hint = document.querySelector('.hint');
  var hintTimer = null;
  function wakeHint() {
    hint.classList.remove('quiet');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { hint.classList.add('quiet'); }, 4000);
  }
  document.addEventListener('mousemove', wakeHint);

  // The presenter window: notes, the next slide and a timer, for the presenter's own screen.
  var presenter = null;
  var startedAt = null;
  function slideTitle(slide) {
    var h = slide && slide.querySelector('h1, h2');
    return h ? h.textContent.trim() : '';
  }
  function fmt(s, v) { return s.replace(/\\{(\\w+)\\}/g, function (m, k) { return k in v ? v[k] : m; }); }
  function tellPresenter() {
    if (!presenter || presenter.closed) return;
    var notes = slides[current].querySelector('.notes');
    presenter.postMessage({
      type: 'state',
      place: fmt(L.slideOf, { n: current + 1, total: slides.length }),
      title: slideTitle(slides[current]),
      next: current + 1 < slides.length ? fmt(L.upNext, { title: slideTitle(slides[current + 1]) }) : L.last,
      notes: notes ? notes.textContent.trim() : '',
      startedAt: startedAt
    }, '*');
  }
  function openPresenter() {
    if (presenter && !presenter.closed) { presenter.focus(); return; }
    // Labels come from the config: escaped before they go into the presenter window's HTML.
    var h = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
    var page = '<!doctype html><html><head><meta charset="utf-8"><title>' + h(L.presenter) + '</title><style>'
      + 'body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;grid-template-rows:auto 1fr auto;height:100vh}'
      + 'header,footer{display:flex;justify-content:space-between;align-items:center;padding:16px 24px;font-size:14px;color:#94a3b8}'
      + 'main{padding:8px 24px;overflow:auto}h1{font-size:28px;margin:0 0 16px;color:#fff}#notes{font-size:22px;line-height:1.5;white-space:pre-line}'
      + '.empty{color:#64748b}#time{font-variant-numeric:tabular-nums;font-size:22px;color:#fff}'
      + 'button{font:inherit;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:8px;padding:8px 16px;cursor:pointer}button:hover{background:#334155}'
      + '</style></head><body><header><span id="place"></span><span id="time">0:00</span></header>'
      + '<main><h1 id="title"></h1><p id="notes"></p></main>'
      + '<footer><button id="prev">' + h(L.prev) + '</button><span id="next"></span><button id="forward">' + h(L.next) + '</button></footer>'
      + '<script>var since=null,empty=' + JSON.stringify(L.noNotes) + ';'
      + 'function go(to){opener&&opener.postMessage({type:"go",to:to},"*")}'
      + 'document.getElementById("prev").onclick=function(){go("prev")};document.getElementById("forward").onclick=function(){go("next")};'
      + 'addEventListener("keydown",function(e){if(["ArrowRight","ArrowDown","PageDown"," ","Enter"].indexOf(e.key)>-1){e.preventDefault();go("next")}else if(["ArrowLeft","ArrowUp","PageUp","Backspace"].indexOf(e.key)>-1){e.preventDefault();go("prev")}});'
      + 'addEventListener("message",function(e){var s=e.data;if(!s||s.type!=="state")return;since=s.startedAt;'
      + 'document.getElementById("place").textContent=s.place;document.getElementById("title").textContent=s.title;'
      + 'var n=document.getElementById("notes");n.textContent=s.notes||empty;n.className=s.notes?"":"empty";'
      + 'document.getElementById("next").textContent=s.next});'
      + 'setInterval(function(){if(!since)return;var t=Math.floor((Date.now()-since)/1000);document.getElementById("time").textContent=Math.floor(t/60)+":"+String(t%60).padStart(2,"0")},1000);'
      + 'opener&&opener.postMessage({type:"ready"},"*");<\\/script></body></html>';
    var url = URL.createObjectURL(new Blob([page], { type: 'text/html' }));
    presenter = window.open(url, 'sprint-review-presenter', 'popup,width=900,height=560');
    if (!presenter) document.body.classList.add('show-notes');
  }
  window.addEventListener('message', function (e) {
    if (!presenter || e.source !== presenter || !e.data) return;
    if (e.data.type === 'ready') { if (startedAt === null) startedAt = Date.now(); tellPresenter(); }
    else if (e.data.type === 'go') { if (e.data.to === 'prev') back(); else forward(); }
  });
  function onEdit(e) { return e.target && e.target.closest && e.target.closest('.edit-button, .edit-panel, .download-button, .download-menu'); }
  document.addEventListener('click', function (e) {
    if (onEdit(e)) return;
    if (e.clientX < window.innerWidth / 3) back(); else forward();
  });
  var touchX = null;
  document.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
  document.addEventListener('touchend', function (e) {
    if (touchX === null) return;
    var dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 40) { if (dx < 0) forward(); else back(); }
    touchX = null;
  });

  // The icons draw themselves: every shape gets a length of 1.
  Array.prototype.forEach.call(document.querySelectorAll('.tile .icon, .card-icon .icon'), function (icon) {
    Array.prototype.forEach.call(icon.querySelectorAll('path, circle, rect, line, polyline, polygon, ellipse'), function (shape) {
      shape.setAttribute('pathLength', '1');
    });
    icon.classList.add('draw');
  });

  var start = parseInt((location.hash || '').slice(1), 10);
  show(start > 0 ? start - 1 : 0);
  wakeHint();
})();`;
}
