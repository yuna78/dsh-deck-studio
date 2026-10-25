# Design styles (Designs) and custom styles

A Deckline "style" (design) is a first-class entity: one description plus a set of sample images.
Register it once and reuse it on any deck; when the agent renders, the description becomes the visual
language for the images.

## 1. Use preset styles (recommended starting point)

Designs page → **＋ Import preset styles** imports the 8 styles below in one click (each ships with
3 real baseline samples: cover / info page / data page). It is idempotent — existing abbreviations are
skipped, never duplicated.

| Abbr | Name | Visual language | Best for |
|---|---|---|---|
| BIZ | Business consulting (blue-grey) | White base + deep navy + warm orange accents, thin-line tables / three-column frames / data cards | Proposals, reviews, data pages |
| FYI | Premium dark (glass) | Near-black charcoal base + glass panels + violet-cyan aurora + champagne gold | Launches, keynotes, premium brands |
| JPN | Japanese minimal (paper) | Cream paper base + low-saturation navy/vermilion + thin frames + generous whitespace | Culture, training, quiet narratives |
| EDT | Magazine editorial (serif headlines) | Cream white + bold serif headlines + strict grid + vermilion accents | Brand stories, long-form info pages |
| TEC | Tech blueprint (isometric) | Deep navy grid + cyan-white technical lines + isometric system diagrams | Architecture, technical proposals |
| SKT | Hand-drawn whiteboard (workshop) | Whiteboard + markers + sticky notes + handwritten headings | Workshops, co-creation, training |
| SWS | Swiss minimal (black/white/red) | Pure white + oversized black type + true red + generous whitespace | Minimal manifestos, big-type posters |
| GRD | Aurora gradient (modern SaaS) | Violet-cyan aurora gradients + glow + 3D abstraction + glass cards | Product launches, internet style |

Definitions: `plugin/deck-studio/seeds/styles/<ABBR>.json`; samples:
`plugin/deck-studio/seeds/samples/<ABBR>-0{1,2,3}.jpg` (3 baseline samples, 1280-wide previews).
Importing is idempotent: clicking again only skips styles that already exist.

## 2. Add your own style

### Way 1: in the UI (supports pasting images)

1. Designs page → **＋ Add style**;
2. Fill in: name, abbreviation (2–6 letters, e.g. `INK`), visual description (paper feel / strokes /
   colors / layout / information density), and what to avoid (negative constraints);
3. "Sample images" area: **⌘V paste / drag and drop / pick files** (png / jpg / webp, multiple, ≤12 MB each);
4. Create: this creates the style directory, a 0-page canvas deck and a design conversation; samples
   appear immediately on the card and in the preview.

To add samples to an existing style: click the **eye** icon on the style card → "＋ Add sample" at the
bottom of the preview (paste / pick files work the same way).

### Way 2: drop files directly

Put images under `designs/<ABBR>/` (canvas directory
`<dataRoot>/projects/<canvasDeckId>/source/designs/<ABBR>/`). Existing `designs/<ABBR>/` directories in managed sources are also scanned read-only.
Prefer uploading new samples through the canvas rather than modifying managed sources. png / jpg / webp are supported; refresh the page afterwards.

Fields of `style.json` (the plugin also writes one automatically):

```json
{
  "abbr": "INK",
  "name": "Ink-wash info page",
  "description": "Visual language: paper texture, ink wash gradations, whitespace, brush strokes…",
  "constraints": "no 3D, no cartoon, no photos",
  "reference": "reference sources / brand elements (optional)",
  "styleBrief": "full visual prompt attached automatically when rendering samples (colors / strokes / layout / type hierarchy / prohibitions)",
  "baselineBriefs": [
    { "title": "Cover", "brief": "What this sample should try: …" },
    { "title": "Info page", "brief": "…" },
    { "title": "Data page", "brief": "…" }
  ]
}
```

- `styleBrief`: **the style prompt itself**. It is attached automatically when the agent renders samples
  (`composeSamplePrompt`); you only supply "what this sample should try" (brief). All 8 preset styles have
  been completed against real samples; change styles via `deck_style_update` / the UI "duplicate" flow.
  Note: `reference` is for humans only and never goes into image prompts — agency / client brand names
  trigger the image adapter's content filter (manifesting as a 180 s timeout).
- `baselineBriefs`: the layout briefs for the 3 baseline samples shipped with a preset (cover / info page /
  data page), used by the regeneration script and "import presets".

## 3. Writing a good visual description

- State the **base / primary / accent colors** (hex values are welcome);
- State the **strokes and texture** (paper grain, markers, gradients, blueprint lines);
- State the **layout** (title position, columns, cards, tables, whitespace);
- State the **information density** and **what to avoid** (negative constraints matter);
- For text-heavy pages: image models garble text; prefer "little text, English" or overlay text afterwards.

## 4. Contributing preset styles (PR flow)

1. Add `plugin/deck-studio/seeds/styles/<ABBR>.json` (fields as above; `abbr` 2–6 uppercase letters, unique);
2. Put 3 baseline samples in `plugin/deck-studio/seeds/samples/` as `<ABBR>-01.jpg` / `<ABBR>-02.jpg` /
   `<ABBR>-03.jpg` (16:9, 1280 wide, ≤600 KB each, no client information / real logos) and write
   `styleBrief` + `baselineBriefs` in the JSON;
3. Run `node plugin/deck-studio/verify/smoke.mjs` locally (presets are verified together with fixtures);
4. Open a PR describing where the style fits and the key points of the sample prompts.

> Samples illustrate the style, not guarantee reproduction of their text content. Please never submit real
> client material, brand logos or unlicensed assets.

## 5. Preset baseline samples (3 per style) and regeneration

Each of the 8 presets has 3 baseline samples (cover / info page / data page): they show at a glance what
the style can produce, and give the agent a "same style, different layout" reference. Regeneration:

```bash
# 8 presets × 3 samples (render at 1920×1080 → downscale to 1280-wide JPEG back into seeds/samples)
node scripts/f74-regenerate-presets.mjs
# Regenerate one style / try one sample only
node scripts/f74-regenerate-presets.mjs --only=BIZ --limit=1
```

What the script does: sync `styleBrief` from `seeds/styles/<ABBR>.json` into the online design's
`style.json` → back up old samples to `<dataRoot>/tmp/f74-old-samples/<ABBR>/` → render one image per
`baselineBriefs` entry (prompt recorded in `samples.jsonl`) → downscale and write back into `seeds/samples/`.
Refresh the Designs page afterwards; no service restart needed.

> Text inside samples is illustrative (image models garble text); it is not guaranteed verbatim. Never put
> real client material or brand logos into sample images.
