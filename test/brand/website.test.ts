import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { brandFromWebsite, toHex, withWebsiteBrand } from '../../src/brand/website.ts';
import { normalize } from '../../src/config.ts';
import { resolvedBrand } from '../../src/review/generate.ts';

const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#123456' } }).png().toBuffer();

/** A .ico with one PNG inside, as most sites serve their favicon today. */
function ico(image: Buffer): Buffer {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head.writeUInt32LE(image.length, 6 + 8);
  head.writeUInt32LE(22, 6 + 12);
  return Buffer.concat([head, image]);
}

function site(files: Record<string, string | Buffer>) {
  const asked: string[] = [];
  const impl = (async (url: string) => {
    asked.push(String(url));
    const body = files[new URL(String(url)).pathname];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof body === 'string' ? body : new Uint8Array(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, asked };
}

test('a website gives its brand color, fonts and favicon as the logo', async () => {
  const s = site({
    '/': '<html><head><meta name="theme-color" content="#ffffff"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><link rel="stylesheet" href="/assets/app.css"><link rel="icon" href="/favicon.ico"></head><body><a href="/"><span class="font-logo">acme</span></a></body></html>',
    '/assets/app.css': ':root{--primary:#171717;--font-sans:"Inter", system-ui, sans-serif;--font-display:"Space Grotesk", "Inter", sans-serif}.x{--accent:#0e2459}',
    '/favicon.ico': ico(png),
  });
  const brand = await brandFromWebsite('https://acme.test/', s.impl);
  assert.equal(brand.color, '#0e2459', 'white theme-color and gray primary are passed over');
  assert.deepEqual(brand.fonts, { heading: 'Space Grotesk', body: 'Inter' });
  assert.equal(brand.logo, `data:image/png;base64,${png.toString('base64')}`);
  assert.deepEqual(brand.fontFaces, [], 'a font stylesheet that lists no files gives no files');
});

test('a logo image on the page wins over icons, and shadcn colors are read', async () => {
  const s = site({
    '/': '<html><head><style>:root{--primary: 221.2 83.2% 53.3%}</style><link rel="apple-touch-icon" href="/apple.png"></head><body><img class="h-8" src="/brand/logo.png" alt="Acme logo"></body></html>',
    '/brand/logo.png': png,
  });
  const brand = await brandFromWebsite('https://acme.test', s.impl);
  assert.equal(brand.color, '#2563eb');
  assert.ok(brand.logo?.startsWith('data:image/png;base64,'));
  assert.ok(!s.asked.some((u) => u.endsWith('/apple.png')));
});

test('an inline SVG marked as the logo is used as it is', async () => {
  const s = site({ '/': '<header><svg class="logo" viewBox="0 0 10 10"><circle r="4"/></svg></header>' });
  const brand = await brandFromWebsite('https://acme.test', s.impl);
  const svg = Buffer.from(brand.logo!.split(',')[1]!, 'base64').toString('utf8');
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" class="logo"/);
});

test('colors in every common notation become hex', () => {
  assert.equal(toHex('#AbC'), '#aabbcc');
  assert.equal(toHex('rgb(14, 36, 89)'), '#0e2459');
  assert.equal(toHex('hsl(0 100% 50%)'), '#ff0000');
  assert.equal(toHex('lab(15% 9 -35)'), null);
});

test('what the config sets itself wins over the website', async () => {
  const s = site({ '/': '<style>:root{--brand:#ea580c;--font-sans:Inter}</style>', '/favicon.ico': ico(png) });
  const config = normalize({ brand: { from: 'https://acme.test', color: '#4f46e5' } }, '/tmp');
  const branded = await withWebsiteBrand(config, s.impl);
  assert.equal(branded.brand.color, '#4f46e5');
  assert.equal(branded.brand.fonts.body, 'Inter');
  assert.ok(branded.brand.logo?.startsWith('data:image/png'));
  assert.equal(branded.brand.from, null);
  assert.equal(resolvedBrand(branded).color, '#4f46e5');
  assert.throws(() => resolvedBrand(config), /withWebsiteBrand/);
});

test('a website that cannot be read is a clear error', async () => {
  await assert.rejects(brandFromWebsite('https://down.test', site({}).impl), /could not read the website https:\/\/down.test/);
});

test('a hostile site can neither fill memory nor stall the parser', async () => {
  let pulled = 0;
  const huge = (async () => new Response(new ReadableStream({
    pull(c) { pulled += 1_000_000; c.enqueue(new Uint8Array(1_000_000)); if (pulled > 50_000_000) c.close(); },
  }))) as unknown as typeof fetch;
  await assert.rejects(brandFromWebsite('https://huge.test', huge), /could not read/);
  assert.ok(pulled <= 5_000_000, `stopped reading early (read ${pulled} bytes)`);

  const slow = site({ '/': '<svg logo'.repeat(330_000) });
  const t = Date.now();
  await brandFromWebsite('https://slow.test', slow.impl);
  assert.ok(Date.now() - t < 3000, `parsed in ${Date.now() - t} ms`);
});

test('the logo in the header wins over a wall of client logos further down', async () => {
  // As on essentium.nl: the own logo is an inline SVG in the header, the clients are <img> logos.
  const clients = ['abnamro', 'alliander', 'bam', 'stedin']
    .map((c) => `<img class="grayscale" src="/assets/logo/merken-waarvoor-wij-werken/${c}.png" alt="logo ${c} zwartwit">`)
    .join('');
  const s = site({
    '/': `<html><body><header class="header"><a href="/"><svg class="text-white logo-svg" viewBox="0 0 182 28"><path d="M0 0h10v10z"/></svg></a></header><main><h2>Merken waarvoor wij werken</h2>${clients}</main></body></html>`,
    '/assets/logo/merken-waarvoor-wij-werken/abnamro.png': png,
  });
  const brand = await brandFromWebsite('https://www.essentium.nl', s.impl);
  assert.ok(brand.logo?.startsWith('data:image/svg+xml'), `got ${brand.logo?.slice(0, 40)}`);
  assert.ok(!s.asked.some((u) => u.includes('abnamro')));
});

test('a wall of client logos is never the logo, even without a header logo', async () => {
  const clients = ['abnamro', 'bam', 'ns'].map((c) => `<img src="/clients/${c}-logo.png" alt="logo ${c}">`).join('');
  const s = site({ '/': `<body><main>${clients}</main></body>`, '/clients/abnamro-logo.png': png, '/favicon.ico': ico(png) });
  const brand = await brandFromWebsite('https://www.example.com', s.impl);
  assert.ok(!s.asked.some((u) => u.includes('/clients/')), s.asked.join(' '));
  assert.ok(brand.logo?.startsWith('data:image/png'));
});

test('among logo images, the one with the site\'s own name wins', async () => {
  const s = site({
    '/': '<body><img src="/img/partner-logo.png" alt="Partner logo"><img src="/img/acme-logo.png" alt="Acme"></body>',
    '/img/partner-logo.png': png,
    '/img/acme-logo.png': png,
  });
  await brandFromWebsite('https://www.acme.com', s.impl);
  assert.ok(s.asked.some((u) => u.endsWith('/img/acme-logo.png')));
  assert.ok(!s.asked.some((u) => u.endsWith('/img/partner-logo.png')));
});

const woff2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(12)]);
const googleCss = (family: string, file: string) => [300, 400, 700].map((w) => `/* cyrillic */
@font-face { font-family: '${family}'; font-style: normal; font-weight: ${w}; src: url(https://fonts.gstatic.com/s/${file}-cyr.woff2) format('woff2'); unicode-range: U+0301, U+0400-045F; }
/* latin */
@font-face { font-family: '${family}'; font-style: normal; font-weight: ${w}; src: url(https://fonts.gstatic.com/s/${file}.woff2) format('woff2'); unicode-range: U+0000-00FF, U+0131; }`).join('\n');

test('a website gives the files of its heading and body fonts, so the deck carries them', async () => {
  const s = site({
    '/': '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;700&amp;display=swap"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=MuseoModerno"><link rel="stylesheet" href="/app.css">',
    '/app.css': ':root{--font-display:"Space Grotesk",sans-serif;--font-sans:"Acme Sans",sans-serif}@font-face{font-family:"Acme Sans";font-weight:400;src:url(/fonts/acme.woff2) format("woff2")}@font-face{font-family:"Acme Sans";font-style:italic;src:url(/fonts/acme-italic.woff2)}',
    '/css2': googleCss('Space Grotesk', 'spacegrotesk'),
    '/s/spacegrotesk.woff2': woff2,
    '/fonts/acme.woff2': woff2,
  });
  const brand = await brandFromWebsite('https://acme.test/', s.impl);
  assert.deepEqual(brand.fonts, { heading: 'Space Grotesk', body: 'Acme Sans' });
  assert.deepEqual(brand.fontFaces?.map((f) => [f.family, f.weight, f.maxWeight ?? null, f.style]), [['Acme Sans', 400, null, 'normal'], ['Space Grotesk', 300, 700, 'normal']], 'one face per file, latin only, no italics');
  assert.ok(brand.fontFaces?.every((f) => f.data.startsWith('data:font/woff2;base64,')));
  assert.equal(s.asked.filter((u) => u.includes('fonts.googleapis.com')).length, 1, 'only the stylesheets of fonts the deck uses');
  assert.ok(!s.asked.some((u) => u.includes('-cyr')), 'other scripts are not downloaded');
});

test('font files the config sets itself win over the website for that family', async () => {
  const s = site({
    '/': '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><style>:root{--font-sans:Inter;--font-heading:Inter}</style>',
    '/css2': googleCss('Inter', 'inter'),
    '/s/inter.woff2': woff2,
  });
  const site_ = await withWebsiteBrand(normalize({ brand: { from: 'https://acme.test' } }, '/tmp'), s.impl);
  assert.equal(site_.brand.fontFaces?.length, 1);
  const own = await withWebsiteBrand(normalize({ brand: { from: 'https://acme.test', fontFiles: { Inter: ['inter.woff2'] } } }, '/tmp'), s.impl);
  assert.deepEqual(own.brand.fontFaces, []);
});
