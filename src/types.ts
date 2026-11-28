export type Device = 'desktop' | 'phone';

export interface Commit {
  hash: string;
  date: string;
  subject: string;
  body: string;
  files: string[];
  /** Whether the commit touched product code (see `productPaths` in the config). */
  product: boolean;
  /** The pull request that brought the commit in, when the GitHub API was reachable. */
  pullRequest?: { number: number; title: string; body: string };
}

export interface Screenshot {
  /** The screen's key, from its file name without the device suffix: `customer-page`. */
  key: string;
  device: Device;
  /** PNG bytes. */
  image: Buffer;
}

export interface ChangedScreen {
  /** The label the model and the slide use: "Customer page" or "Customer page (phone)". */
  name: string;
  key: string;
  device: Device;
  before: Buffer;
  after: Buffer;
  /** Where the change is on the pictures, as fractions of their size. */
  focus?: Focus;
}

/** An area of a picture as fractions of its width and height, 0 to 1. */
export interface Focus {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Milestone {
  text: string;
  done: boolean;
  /** From a roadmap written as Now and Next sections instead of a checklist. */
  stage?: 'now' | 'next';
}

export interface UsageMetric {
  label: string;
  value: number;
  previous?: number;
  /** Earlier sprints, oldest first, for the trend line. */
  history?: number[];
  /** down when less is better (errors, waiting time): the change is colored the other way. */
  better?: 'up' | 'down';
}

export type CheckKind = 'corrected' | 'moved' | 'dropped' | 'warning';

export interface Check {
  kind: CheckKind;
  text: string;
  reason: string;
}

/** What kind of work a line under the hood is, shown as a label in front of it. */
export const HOOD_KINDS = ['security', 'reliability', 'speed', 'maintenance'] as const;
export type HoodKind = (typeof HOOD_KINDS)[number];

export interface HoodItem {
  text: string;
  kind: HoodKind;
}

/** How a theme slide is laid out. auto picks from the content: a screenshot gets split, none gets icon. */
export const THEME_LAYOUTS = ['auto', 'split', 'full', 'icon', 'card'] as const;
export type ThemeLayout = (typeof THEME_LAYOUTS)[number];

export interface WrittenTheme {
  /** The name of the theme as a user would call it: one to three words. Shown above the headline. */
  title: string;
  icon: string;
  /** The label of the screenshot the model chose, or null. */
  screen: string | null;
  device: Device;
  value: string | null;
  /** The slide's title: one full sentence that says what a user can do or notices now. */
  effect: string | null;
  points: string[];
  notes: string | null;
  /** The milestone (its place in the roadmap) this theme moves forward; null when it is outside the roadmap. Absent when the roadmap wasn't asked. */
  milestone?: number | null;
}

export interface WrittenReview {
  /** The sprint in one sentence: the outcome that matters most. */
  headline: string | null;
  summaryNotes: string | null;
  themes: WrittenTheme[];
  underTheHood: HoodItem[];
  /** Two or three open questions for the audience about specific changes. */
  questions: string[];
  /** What changed per changed screen, by the screen's label. */
  screenCaptions: Record<string, string>;
  /** Roadmap items a user would notice, by their number in the roadmap, in the audience's words. */
  roadmap: { item: number; text: string }[];
  /** Requests from FEEDBACK.md this sprint answered, by number, with what was done. */
  answered: { item: number; text: string }[];
  checks: Check[];
}

/** A picture as stored in the review: a data URI, so the JSON is self-contained. */
export interface StoredPicture {
  name: string;
  device: Device;
  image: string;
  /** A short muted loop of the same screen (a data URI, mp4 or webm), played instead of the picture. */
  video?: string;
}

export interface ReviewTheme extends Omit<WrittenTheme, 'screen'> {
  screen: StoredPicture | null;
  /** The screen the theme is about, kept so the picture can be switched between devices later. */
  screenKey: string | null;
  /** Set in the editor or review.json to override the layout the deck picks. */
  layout?: ThemeLayout;
}

export interface ReviewScreen {
  name: string;
  device: Device;
  before: string;
  after: string;
  caption: string | null;
  /** The changed area, framed on the after picture while the rest dims. Remove it to show the pictures plain. */
  focus?: Focus;
}

/** Everything the deck is rendered from. Editing a review means editing this, then rendering again. */
export interface Review {
  version: 1;
  title: string;
  period: string;
  from: string;
  until: string;
  language: string;
  organization: string;
  product: string;
  /** The sprint in one sentence, on its own slide after the cover. */
  headline: string | null;
  /** Speaker notes for the headline slide. */
  summaryNotes: string | null;
  themes: ReviewTheme[];
  underTheHood: HoodItem[];
  /** Asked on the closing slide instead of a bare "Questions". */
  questions: string[];
  /** "You asked, we did": requests from the team's feedback file and what this sprint did about them. */
  answered?: { ask: string; did: string }[];
  /** What the previous review said was next, and whether it is done now. */
  lastTime?: { until: string; items: Milestone[] };
  screens: ReviewScreen[];
  milestones: Milestone[];
  usage: UsageMetric[];
  checks: Check[];
}
