# Screenshots

Before and after pictures are what make a sprint review land. sprint-review can add two kinds of pictures:

- **Before and after slides** for screens that changed during the sprint, with one line on what to look at.
- **A screenshot on a theme slide**, when one shows what the theme is about.

There are three ways to get them: from your visual tests, from two folders, or taken by the tool from URLs you choose (best on staging with demo data, so no customer data ends up on a slide). Screenshots are always optional: without them, theme slides show an icon instead and the deck still looks complete.

Which to pick:

| | Works best when | The catch |
|---|---|---|
| `git` | You have visual tests | Only the screens your tests photograph |
| `folder` | You'd rather pick the pictures yourself, or the app is hard to reach from a script | Somebody must remember a *before* picture at the start of the sprint, with the same crop |
| `capture` | The app can be opened from your machine | It needs a login: a saved session, or a test account |

## Option 1: pictures from your visual tests (`git`)

If your project has visual regression tests (Playwright `toHaveScreenshot`, Cypress, Storybook, Chromatic exports…), the reference pictures live in the repository and change in the same commit as the UI. That makes them perfect: real screens, made-up test data, and a history.

```yaml
screenshots:
  source: git
  dir: e2e/__screenshots__/screens.spec.ts
  names:
    dashboard: Dashboard
    customer-page: Customer page
  ignore: { left: 240, top: 64 }
```

How it works:

1. It lists the PNG files under `dir` that changed during the sprint.
2. For each one it takes the version at the start and at the end of the sprint. A picture that only appeared during the sprint uses its first version as "before".
3. It compares them pixel by pixel, skipping `ignore.left` pixels on the left of desktop pictures (a side menu) and `ignore.top` pixels at the top (a top bar). So adding one menu item doesn't mark every screen as changed. Small differences (anti-aliasing, a moving background) stay under the tolerance.
4. On desktop it crops both pictures to where the change is, so the slide shows that part large.
5. The AI writes one line per changed screen on what to look at, or skips it when the change is too small. Only screens with such a line get a slide.

`dir` is a path from the repository root.

## Option 2: two folders (`folder`)

Export or take pictures any way you like, and put them in two folders:

```
screens/
  before/
    dashboard-desktop.png
    customer-page-desktop.png
    customer-page-phone.png
  after/
    dashboard-desktop.png
    customer-page-desktop.png
    customer-page-phone.png
```

```yaml
screenshots:
  source: folder
  before: screens/before
  after: screens/after
```

Pictures that are in both folders and differ are compared exactly as above. Pictures in `after` are also available for theme slides.

## Option 3: the tool takes them (`capture`)

No visual tests? Give sprint-review the pages and it photographs them with Playwright. Each run keeps the pictures in a folder per day; the next review compares the last pictures from before the sprint with the newest ones.

```bash
npm install --save-dev playwright-core   # uses the Chrome you have installed
# or: npm install --save-dev playwright && npx playwright install chromium
```

```yaml
screenshots:
  source: capture
  baseUrl: https://staging.example.com
  pages:
    customer-page: /customers/1042      # screen key: path or full URL
    planner: /planner?branch=north
    planner-progress:                   # one element: a card, a panel, a chart
      url: /planner?branch=north
      selector: "section:has(h2:text-is('Progress'))"
  devices: [desktop, phone]             # default: desktop
  mask: [".email", "[data-private]"]    # painted over before the picture is taken
  storageState: .auth/staging.json      # optional: a logged-in session (see below)
  wait: 800                             # ms after the page settles, default 500
  storage: .sprint-review/screenshots   # default
  names:
    customer-page: Customer page
```

Take today's pictures:

```bash
npx @guuskeunen/sprint-review capture
```

You rarely need to: making a review takes today's pictures first when its sprint ends today and there are none yet (`onReview: false` turns that off). Those are this review's *after* and the next review's *before*. If they can't be taken (logged out, the app is down), the review says so and goes on with the pictures there are. Keep the storage folder between runs: commit it, or cache it in CI. The first run has nothing to compare with, so its pictures only show on theme slides.

### Logging in

Two ways, pick one:

- **A saved session** (simplest). Log in once in a browser that saves the session: `npx playwright-core codegen --channel=chrome --save-storage=.auth/staging.json https://staging.example.com/login`, log in, close the window. Point `storageState` at the file and keep it out of git. Capture saves the session back after every run, because apps often hand out a new token on each visit and the old one stops working. It lasts as long as the app keeps a session alive between reviews; when it is gone, capture stops with "Not logged in" and you log in again.
- **A test account** (for CI, or an app that logs you out often). Capture fills in the login form itself. The config names the environment variables that hold the values, never the values. Use an account that can see only demo data. It doesn't work with single sign-on or two-factor login.

```yaml
  login:
    url: /login
    fields:
      "input[type=email]": SCREENSHOT_EMAIL        # names of environment variables
      "input[type=password]": SCREENSHOT_PASSWORD
    submit: "button[type=submit]"
```

When a page sends capture to a login page (`/login`, `/signin`, `/auth`), it stops right away rather than photographing the login page ten times.

- **Components make the best slides.** A selector crops the picture to one card or panel, which reads far better on a slide than a whole page, whose text ends up a few pixels tall. The writer prefers them, and they are taken at twice the sharpness (whole pages at normal sharpness, to keep the deck small) (any Playwright selector works: CSS, `text=`, `:has()`, `xpath=`). A selector that finds nothing is skipped and named in the output.
- **Point it at staging with demo data**, never production. `mask` is a safety net, not a plan.
- **No Playwright browser download?** Set `SPRINT_REVIEW_CHROME` to a Chrome or Chromium binary.

## File names

| File name | Screen key | Device |
|---|---|---|
| `customer-page-desktop.png` | `customer-page` | desktop |
| `customer-page-phone.png` | `customer-page` | phone |
| `customer-page-mobile.png` | `customer-page` | phone |
| `customer-page.png` | `customer-page` | desktop |
| `dashboard-mobile-chromium-linux.png` | `dashboard` | phone (Playwright's browser and platform suffix is dropped) |

The screen key turns into a readable name ("customer-page" → "Customer page") unless you set one in `names`. The order of `names` is also the order of the slides.

Phone pictures are shown upright, in a phone frame: one phone screen around the change, with the change framed, and → zooms in on where it starts. A phone picture gets a before and after slide only when the desktop picture of the same screen did not change too; otherwise the desktop slide shows the change, larger.

## Short video clips

A feature you click through shows better moving. Record a few seconds of it with any screen recorder, save it as `.mp4` or `.webm` (8 MB at most, since it goes inside the deck), and name it per screen key:

```yaml
screenshots:
  source: git
  dir: e2e/__screenshots__
  videos:
    planner: docs/clips/planner.mp4
```

A theme showing that screen plays the clip muted in a loop while its slide is open, with the screenshot as its first frame. With reduced motion, in PowerPoint and on paper, the screenshot shows.

## Dark mode

With `brand.theme: dark`, a light screenshot glares on the black slides. If your app has a dark mode, give the deck dark pictures too:

- **Capture:** set `screenshots.darkMode: true` and every page is also photographed in the app's dark mode (Playwright's `colorScheme: dark`). It only works when the app follows the system setting.
- **Git or folders:** add the dark picture next to the light one with `-dark` in the name: `planner-desktop-dark.png`.

The dark deck uses a dark pair when both the before and the after picture have one, and the light pair otherwise, so a comparison never mixes the two (that would count every screen as changed). A light picture on the dark deck is dimmed a little.

## Tips

- **Use made-up data in your test fixtures.** Then the pictures are safe to show anywhere.
- **Set `ignore` to your layout's menu and top bar sizes**, in pixels at the screenshot's resolution.
- **Connect areas to screens** so a theme about an area shows its screen:

```yaml
areas:
  planner: { icon: calendar, label: Workshop planner, screen: planner }
```

