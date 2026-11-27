import { ICONS, VALUE_ICONS, HOOD_ICON, BUTTON_ICONS } from './icons-data.ts';

/** What a theme brings the business. A fixed list, so the model names one and never puts a number on it. */
export const VALUE_KEYS = ['faster', 'quality', 'less_manual_work', 'less_risk', 'insight'] as const;
export type ValueKey = (typeof VALUE_KEYS)[number];

export function iconKeys(): string[] {
  return Object.keys(ICONS);
}

export function isIcon(key: unknown): key is string {
  return typeof key === 'string' && key in ICONS;
}

/** Every icon as "key (what it suits)", for the model to pick from by meaning. */
export function iconList(): string {
  return Object.entries(ICONS)
    .map(([k, v]) => `${k} (${v.label.toLowerCase()})`)
    .join(', ');
}

export function svg(paths: string, cls = 'icon'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

export function themeIcon(key: string): string {
  return svg((ICONS[key] ?? ICONS.other!).paths);
}

export function buttonIcon(key: keyof typeof BUTTON_ICONS): string {
  return svg(BUTTON_ICONS[key]);
}

export function valueIcon(key: string): string {
  return svg(VALUE_ICONS[key] ?? ICONS.other!.paths);
}

export function hoodIcon(): string {
  return svg(HOOD_ICON);
}
