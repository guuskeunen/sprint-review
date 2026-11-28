# Editing and presenting

## Most of the time: just present it

The deck is a draft, but it's written to be presented as it is. Read it through once, glance at `checks.md`, and go.

## Changing the content

### In the editor

Making a review in a terminal opens the deck in your browser right away, with **Download** to share it as a PDF or PowerPoint and **Edit** to change it. The editor keeps running in the terminal for that button until Ctrl+C. Later, or for an older review:

```bash
npx @guuskeunen/sprint-review edit sprint-reviews/2026-11-16/review.json
```

`--no-edit` opens nothing and starts no editor; neither happens in CI or without a terminal. The editor is a local page in your browser: the content on the left, the live deck on the right. Every change shows in the deck as you type, before you save. Click into a theme and the preview jumps to its slide. Word counts show the same limits the checks use. **Save and rebuild** (or Ctrl/⌘ + S) writes `review.json` and rebuilds `deck.html` next to it (and `deck.pptx`, see [PowerPoint](#powerpoint)). Ctrl+C in the terminal stops the editor.

**Open live view** shows the deck on its own in a new window, for a second screen or a call: it follows every edit as you type and the slide you're working on.

**From the deck:** a deck opened from your disk has an **Edit** button in the top right corner. It opens the editor when it's running; when it isn't, it shows the command that starts it for this deck, ready to copy. Next to it, **Download** gives a PDF (every slide a page, through the print dialog), a copy of the deck to pass on, and the PowerPoint when one was written with the deck (by default, when `pptxgenjs` is installed). Published and shared decks don't show Edit; they show **Download** in its place, with the PDF, the deck as one HTML file that works offline, and the PowerPoint when a published `deck.pptx` sits next to the deck.

**Downloading from the editor:** **Download** in the editor's top bar gives a PDF, a PowerPoint and the deck as one HTML file. It saves your edits first, so you get what you see. Every download is named after the product, the review and its dates, such as `excalidraw-sprint-review-2026-11-09-to-2026-11-27.pdf`, so it still says what it is in a colleague's inbox. The PowerPoint is made on the spot, also when the review was written without `--pptx` (it needs `pptxgenjs`, see [PowerPoint](#powerpoint)).

The editor only listens on `127.0.0.1`, and only the page it opened can talk to it. `--port` picks another port (default 4321).

### By hand

Everything on the slides is in `review.json`, next to the deck:

```json
{
  "version": 1,
  "title": "Sprint review November 16, 2026",
  "period": "November 3 to November 16, 2026",
  "headline": "The front desk sees a whole customer on one page",
  "themes": [
    {
      "title": "Customer profile",
      "icon": "users",
      "value": "quality",
      "effect": "Front desk staff see everything a customer bought or had repaired on one page.",
      "layout": "auto",
      "points": ["Purchases, repairs and services sit in one list with their source"],
      "notes": "Open the customer page for Sarah Mitchell and point at the source labels.",
      "screen": null
    }
  ],
  "underTheHood": [{ "text": "Vite is up to date", "kind": "maintenance" }],
  "questions": ["Which repairs would you still type in by hand?"],
  "screens": [],
  "milestones": [{ "text": "Book a repair online", "done": true }],
  "usage": [{ "label": "repairs booked", "value": 312, "previous": 268 }]
}
```

What you can change:

| To… | Edit |
|---|---|
| Fix a word | Any `headline`, `text`, `title`, `effect` (the slide's title), `points`, `notes` or `questions`. |
| Reorder themes | Move items in `themes`. |
| Drop a slide | Remove the theme, the screen from `screens`, or empty `underTheHood`. |
| Change an icon | `icon`, see `sprint-review icons`. |
| Change what a theme brings | `value`: `faster`, `quality`, `less_manual_work`, `less_risk`, `insight`, or `null`. |
| Remove a theme's picture | Set `screen` to `null`. |
| Change a slide's layout | `layout`: `auto`, `split`, `full`, `icon` or `card` (see [design](design.md#theme-layouts)). |
| Label a line under the hood | `kind`: `security`, `reliability`, `speed` or `maintenance`. |
| Fix a number | `usage`. |

Then rebuild:

```bash
npx @guuskeunen/sprint-review render sprint-reviews/2026-11-16/review.json
```

`render` also picks up config changes: a new logo, color, goal or labels show up in old reviews when you render them again.

## PowerPoint

Some teams present from PowerPoint or Keynote, or want to add a slide by hand. When `pptxgenjs` is installed (`npm i -D pptxgenjs`), `deck.pptx` is written next to the deck with every review: the same slides, editable, with the speaker notes in the notes pane. That's `output.pptx: auto`, the default; `false` turns it off, `true` makes a missing `pptxgenjs` an error, and `--pptx` asks for it for one run. `render` and the editor rebuild it too.

`npm audit` may then report `image-size`: `pptxgenjs` lists it as a dependency but never calls it, so the advisory doesn't reach sprint-review, and only a `pptxgenjs` release can remove it. To clear the report, add this to your `package.json`:

```json
"overrides": { "image-size": "^2.1.0" }
```

The HTML deck stays the richer one: animations, the presenter window and before-and-after wipes don't exist in PowerPoint.

## Presenting

Open `deck.html` in any browser. It has no outside dependencies, so it also works offline and from a USB stick.

| Key | Does |
|---|---|
| → ↓ Space Enter PageDown | Next slide |
| ← ↑ Backspace PageUp | Previous slide |
| Home / End | First / last slide |
| F | Full screen |
| P | Presenter window: speaker notes, the next slide's title and a timer, for your own screen |
| N | Show the speaker notes at the bottom of this window |

Click the right two thirds of the screen to go forward, the left third to go back. Swipe on a phone or tablet. The address ends in `#3` on slide 3, so a link can open on a specific slide.

The animations respect your system's *reduce motion* setting.

## Exporting to PDF

Print the deck (Cmd/Ctrl + P) and choose **Save as PDF**. Every slide becomes one 16:9 page, without animations or controls. Turn on **Background graphics** in the print dialog to keep the colors.

## Sharing

- **Send the file.** `deck.html` is one file, usually a few hundred kilobytes with screenshots.
- **Host it.** Any static host works: GitHub Pages (see [the GitHub Action guide](github-action.md#a-shareable-link-with-github-pages)), Netlify, S3, an intranet.
- **Paste the summary.** `review.md` is ready for a pull request, Slack or an email.
