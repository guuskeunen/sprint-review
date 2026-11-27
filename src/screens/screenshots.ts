import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { ScreenshotConfig } from '../config.ts';
import type { ChangedScreen, Device } from '../types.ts';
import type { History, Range } from '../git/history.ts';
import { compareScreens } from './compare.ts';

/** Reading more changed screens than get a slide: a menu change rewrites every picture, and the model picks the ones worth showing. */
const MAX_SCREENS = 16;

export interface ScreenLabels {
  phone: string;
  desktop: string;
}

export interface Screens {
  /** Screens whose picture changed between the start and the end, cropped to the change on desktop. */
  changed(): Promise<ChangedScreen[]>;
  /** Every picture at the end, by the label the model chooses from: "Customer page (desktop)". */
  available(): Map<string, { key: string; device: Device }>;
  /** A picture at the end. */
  picture(key: string, device: Device): Buffer | null;
  /** The readable name of a screen key. */
  name(key: string): string;
  /** Why pictures that exist were left out, when the run would otherwise just say there are none. */
  note?: string;
}

/**
 * `customer-page-desktop.png`, `customer-page-phone.png`, Playwright's `-chromium-linux` suffix,
 * and `-dark` for the same screen in the app's dark mode (`customer-page-desktop-dark.png`).
 */
export function parseFile(file: string): { key: string; device: Device; dark: boolean } | null {
  if (!file.toLowerCase().endsWith('.png')) return null;
  let stem = basename(file, '.png').replace(/-(chromium|firefox|webkit|chrome|msedge)(-(linux|darwin|win32))?$/i, '');
  const dark = /-dark$/i.test(stem) || /-dark-(desktop|phone|mobile)$/i.test(stem);
  stem = stem.replace(/-dark$/i, '').replace(/-dark(-(desktop|phone|mobile))$/i, '$1');
  let device: Device = 'desktop';
  const m = /-(desktop|phone|mobile)$/i.exec(stem);
  if (m) {
    device = m[1]!.toLowerCase() === 'desktop' ? 'desktop' : 'phone';
    stem = stem.slice(0, m.index);
  }
  return stem ? { key: stem, device, dark } : null;
}

/** A picture's id in the maps below: `key|device`, with `|dark` for its dark-mode version. */
const idOf = (p: { key: string; device: Device; dark: boolean }) => `${p.key}|${p.device}${p.dark ? '|dark' : ''}`;

/** scheme dark: use the dark-mode pictures where both ends have one, so a comparison never mixes the two. */
export function screens(config: ScreenshotConfig, root: string, history: History, range: Range, labels: ScreenLabels, scheme: 'light' | 'dark' = 'light'): Screens {
  if (config.source === 'none') {
    return { changed: async () => [], available: () => new Map(), picture: () => null, name: (k) => humanize(k) };
  }
  const names = config.names;
  const name = (key: string) => names[key] ?? humanize(key);
  const order = Object.keys(names);
  const sortKey = (key: string) => {
    const i = order.indexOf(key);
    return i === -1 ? order.length : i;
  };
  const label = (key: string, device: Device) => (device === 'phone' ? `${name(key)} (${labels.phone})` : name(key));

  // Where each picture lives: by "key|device", the path at the start and at the end.
  let startPics: Map<string, () => Buffer | null>;
  let endPics: Map<string, () => Buffer | null>;
  let firstInRange: (id: string) => Buffer | null = () => null;
  let note: string | undefined;
  let changedIds: string[];

  if (config.source === 'git') {
    const { start, end } = history.ends(range);
    const index = (rev: string | null) => {
      const map = new Map<string, () => Buffer | null>();
      if (!rev) return map;
      for (const path of history.listFiles(rev, config.dir)) {
        const p = parseFile(path);
        if (p) map.set(idOf(p), () => history.show(rev, path));
      }
      return map;
    };
    startPics = index(start);
    endPics = index(end);
    const pathOf = new Map<string, string>();
    changedIds = [];
    for (const path of history.changedPaths(range, config.dir)) {
      const p = parseFile(path);
      if (!p) continue;
      const id = `${p.key}|${p.device}`;
      if (p.dark) {
        if (!changedIds.includes(id)) changedIds.push(id);
        continue;
      }
      pathOf.set(id, path);
      if (!changedIds.includes(id)) changedIds.push(id);
    }
    firstInRange = (id) => (pathOf.has(id) ? history.oldestInRange(range, pathOf.get(id)!) : null);
  } else if (config.source === 'capture') {
    // One folder per day of pictures: the last one before the sprint started, and the last one by its end.
    const base = resolve(root, config.capture.dir);
    const { from, until } = rangeDays(range, history);
    const days = existsSync(base) ? readdirSync(base).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
    const beforeDay = [...days].reverse().find((d) => d < from) ?? null;
    const afterDay = [...days].reverse().find((d) => d <= until && d !== beforeDay) ?? null;
    const later = afterDay ? undefined : days.find((d) => d > until);
    // A picture taken after the sprint can show work from after it, so it isn't used; say so instead of "0 pictures".
    if (later) note = `Screenshots from ${later} are left out: they were taken after the sprint's end (${until}). Take them by its last day, or end the review on ${later} or later.`;
    startPics = beforeDay ? folderPics(join(base, beforeDay)) : new Map();
    endPics = afterDay ? folderPics(join(base, afterDay)) : new Map();
    changedIds = lightIds(endPics).filter((id) => startPics.has(id) || startPics.has(`${id}|dark`));
  } else {
    const folder = (dir: string) => {
      const abs = resolve(root, dir);
      const map = new Map<string, () => Buffer | null>();
      if (!existsSync(abs)) return map;
      for (const file of readdirSync(abs)) {
        const p = parseFile(file);
        if (p) map.set(idOf(p), () => readFileSync(join(abs, file)));
      }
      return map;
    };
    startPics = folder(config.before);
    endPics = folder(config.after);
    changedIds = lightIds(endPics).filter((id) => startPics.has(id) || startPics.has(`${id}|dark`));
  }

  // Dark mode: a dark pair where both ends have one, else the light pair; a single picture prefers dark.
  const darkPair = (id: string) => scheme === 'dark' && startPics.has(`${id}|dark`) && endPics.has(`${id}|dark`);
  const startOf = (id: string) => startPics.get(darkPair(id) ? `${id}|dark` : id);
  const endOf = (id: string) => endPics.get(darkPair(id) ? `${id}|dark` : id);
  const pictureOf = (id: string) => (scheme === 'dark' && endPics.has(`${id}|dark`) ? endPics.get(`${id}|dark`) : endPics.get(id));

  const byScreenOrder = (ids: string[]) =>
    [...ids].sort((x, y) => {
      const [kx = ''] = x.split('|');
      const [ky = ''] = y.split('|');
      return sortKey(kx) - sortKey(ky) || x.localeCompare(y);
    });

  return {
    name,
    ...(note ? { note } : {}),
    async changed() {
      const out: ChangedScreen[] = [];
      for (const id of byScreenOrder(changedIds)) {
        const [key = '', dev = 'desktop'] = id.split('|');
        const device = dev as Device;
        // A picture without an earlier version may be a new screen, or a screen that only got its first picture now: no slide.
        const before = startOf(id)?.() ?? (darkPair(id) ? null : firstInRange(id));
        const after = endOf(id)?.();
        if (!before || !after || before.equals(after)) continue;
        const cmp = await compareScreens(before, after, device, config.ignore);
        if (cmp && !cmp.changed) continue;
        out.push({ name: label(key, device), key, device, before: cmp?.before ?? before, after: cmp?.after ?? after, ...(cmp?.focus ? { focus: cmp.focus } : {}) });
        if (out.length === MAX_SCREENS) break;
      }
      return out;
    },
    available() {
      const map = new Map<string, { key: string; device: Device }>();
      for (const id of byScreenOrder(lightIds(endPics))) {
        const [key = '', dev = 'desktop'] = id.split('|');
        const device = dev as Device;
        map.set(device === 'phone' ? label(key, device) : `${name(key)} (${labels.desktop})`, { key, device });
      }
      return map;
    },
    picture(key, device) {
      return pictureOf(`${key}|${device}`)?.() ?? null;
    },
  };
}

function folderPics(abs: string): Map<string, () => Buffer | null> {
  const map = new Map<string, () => Buffer | null>();
  if (!existsSync(abs)) return map;
  for (const file of readdirSync(abs)) {
    const p = parseFile(file);
    if (p) map.set(idOf(p), () => readFileSync(join(abs, file)));
  }
  return map;
}

/** The screens in a map, once each: `key|device`, whether it has a light picture, a dark one or both. */
function lightIds(map: Map<string, unknown>): string[] {
  return [...new Set([...map.keys()].map((id) => id.replace(/\|dark$/, '')))];
}

/** The first and last day of a range; for refs, the dates of the commits at both ends. */
export function rangeDays(range: Range, history: History): { from: string; until: string } {
  if (range.kind === 'dates') return { from: range.from, until: range.until };
  const { start, end } = history.ends(range);
  const day = (rev: string | null) => (rev ? history.git(['show', '-s', '--format=%cs', rev], true).trim() : '');
  const today = new Date().toISOString().slice(0, 10);
  return { from: day(start) || today, until: day(end) || today };
}

export function humanize(key: string): string {
  const words = key.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
