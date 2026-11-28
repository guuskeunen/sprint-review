# How the deck is designed

The deck follows rules from presentation research: Apple's keynotes and Human Interface Guidelines, Nancy Duarte's *slide:ology* and glance test, Garr Reynolds' *Presentation Zen*, Michael Alley's assertion-evidence slides, and sprint review practice (the Scrum Guide, Roman Pichler, Mountain Goat, Linear's changelog). A test measures most of these rules in a real browser (`test/deck/layout.test.ts`), so a change that breaks one fails CI.

## Rules the deck keeps

| Rule | Where it comes from | How the deck keeps it |
|---|---|---|
| One message per slide, stated in the title as a full sentence | Alley, Duarte | A theme's title is what a user can do now, in 12 words at most; the theme's name sits small above it. A title that joins two messages with a semicolon gets a warning. |
| Readable at a glance: about 40 words besides the title | Duarte's glance test | The writer is asked for two to four points (depending on `deck.density`). A slide over the budget gets a warning in the check log. The text is never shrunk to fit. |
| Four text sizes for the whole deck | Butterick, Apple | 120, 64, 36 and 24 px at 1920 x 1080. They scale with the window. |
| Nothing under 24 px; body text 36 px | Apple tvOS, Alley | The smallest text is 24 px: labels, captions, the cards' sentences. |
| Margins of at least 96 px | Apple, Duarte | 154 px left and right, 97 px top. |
| Evidence over text | Alley, Reynolds | A screenshot takes most of a theme slide, but only one that shows the theme's change: a picture of something nearby is worse than the icon, which is then shown at hero size. Close-ups of one card or panel are preferred over whole pages, whose text is too small on a slide. |
| Screenshots cropped, with no device frame unless the device is the point | Reynolds, documentation style guides | Rounded corners of 10 px and a soft shadow (a hairline border and slight dimming in the dark theme). A phone frame appears only for a theme about the phone. |
| Before and after: the same crop and size, labeled | Alley | Both pictures share one size and crop. The title says what changed. |
| One brand color becomes the whole palette, every color measured | Radix, Material, WCAG | Grays and lines take a little of the brand's hue; body text is at least 4.5:1, labels and the accent at least 3:1, in both themes (`src/deck/colors.ts`). |
| Motion only to show what arrives or changed | NN/g, Tversky et al. | Every animation runs once, in 400 ms or less. The frame around a change appears after the after picture is in. |
| No logo or chrome on every slide | Reynolds | The logo appears on the cover and the closing slide only. |
| The same slide type looks the same every time; the deck still has rhythm | Duarte, Pitch, Keynote masters | The title always sits in the same place. A screenshot layout used twice in a row is mirrored the second time. |

## The story

1. **Cover**: the product's name, "Sprint review" and the period (the date isn't repeated in the title), the sprint goal when `goal` is set, and the sprint's strongest screenshot running off the right edge.
2. **The sprint headline**: what the sprint as a whole changed for a user, in at most ten plain words (never one commit standing in for a sprint of several themes, never a list of the themes, never how it works), and a row with the theme names. A sprint goal is set before the sprint and can't be read from git, so the headline describes what was done.
3. **Last sprint**: what the previous review showed as next on the roadmap, and whether it is done now. Only when there is a previous review in the output folder and a roadmap; the audience checks promises before hearing new ones (GitLab publishes its kickoff and retrospective as a pair for the same reason).
4. **You asked**: requests from `FEEDBACK.md` that this sprint answered, each with what was done, backed by a commit.
5. **Theme slides**: the biggest themes, one slide each. `deck.density` sets how many: 2, 3 or 4.
6. **More changes**: the remaining themes as cards, one message each, across the slide's width. Their points go into the speaker notes.
7. **Before and after**: one slide per changed screen, the change framed. When it is small, one press of → zooms into it (Tversky et al.: animation helps most for moving from overview to detail) and the next moves on.
8. **Also shipped**: work behind the scenes, with a label per line (security, reliability, speed, maintenance).
9. **Roadmap**: how many milestones are reached, as a line through the last ones reached and the next ones.
10. **Numbers**: one big number per idea, at most four.
11. **Questions**: two or three specific questions for the audience, in place of a bare "Questions?" slide.

The audience sets the defaults: executives get a brief deck with the numbers right after the headline and no slide about work behind the scenes, the team gets a detailed deck, everyone else a standard one. `deck.density`, `deck.order` and `deck.sections` change that.

## Theme layouts

The deck picks a layout from what a theme has. You can override it per theme in the editor or in `review.json` (`"layout"`):

| Layout | When | |
|---|---|---|
| `split` | The theme has a desktop screenshot | Points beside the picture. |
| `full` | The screenshot is at least 2.4 times as wide as it is tall (a row of cards), or chosen by hand | The screenshot fills the slide's width, with the points in a row below it. Beside the points a strip would shrink to a thin band. |
| `phone` | The screenshot is a phone screen | Points beside an upright phone. |
| `icon` | No screenshot | The icon at hero size beside the points. |
| `card` | Chosen by hand | The theme goes on the shared *More changes* slide. |
| `auto` | The default | The deck decides. |

The HTML deck, the PowerPoint file and the editor all follow one plan (`src/deck/plan.ts`), so they show the same slides in the same order.
