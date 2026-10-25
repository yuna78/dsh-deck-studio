![Deckline](assets/logo/deckline-logo.png)

# Deckline · image deck studio for DSH

[简体中文](README.md) · English

> **Every button explained:** see the [English manual (docs/manual.en.md)](docs/manual.en.md) or the
> [Chinese manual](docs/manual.md) — screen by screen with numbered screenshots (1/2/3 drawn on the controls),
> covering fullscreen presenting, the new-deck dialog, page editor, export, image settings and deck rules.
> Screenshots are regenerated from the built-in sample deck by `npm run manual:update`, which also validates
> that manual numbering matches the UI.

![Deckline workbench](docs/assets/screenshots/00-hero.png)

**Deckline** is an image-deck workbench plugin for DeepSeek Harness (DSH): native DSH chat on the left,
the deck workspace in the middle, and the library / design styles / assets / conversations on the right.
It turns "who is this for, what do we say, how do we draw it" into a traceable pipeline, not another PPT editor.

- Conversation stays in chat; every deck change is backed by script / diff / revision / governance docs;
- Images are rendered **one slide at a time**; each slide keeps its prompt, image, revisions, QA and events;
- **Present immediately**: fullscreen playback, arrow-key navigation and Esc to exit — no export required;
- **8 built-in style templates + template management**: preview samples, create your own designs and reuse them across decks;
- The source deck directory is **read-only**; all edits land in the local `.deck/` workspace (gitignored, never committed).

> A sample deck built with Deckline itself: [docs/sample-deck.md](docs/sample-deck.md) (Chinese).

> **Docs language**: the project is Chinese-first. This README is the English entry point; the deeper
> guides under `docs/` are currently Chinese, with English translations planned.

## Install in 5 minutes

Prerequisites: Node.js `^22.19 or ≥24`, pnpm 10+, DSH `≥ 0.1.7 < 0.3`
(`npm i -g @deepseek-ai/dsh`; verified on 0.1.7-rc.2 and 0.2.1-rc.2, see [docs/compat.md](docs/compat.md)).

```sh
# 1) create a deckline profile
dsh --profile deckline --from-default-profile web

# 2) install the plugin (published on npm, unscoped)
dsh plugin --profile deckline add dsh-plugin-deck-studio
#   from git:     dsh plugin --profile deckline add "github:yuna78/dsh-deck-studio#path:/plugin/deck-studio"
#   local dev:    dsh plugin --profile deckline add "$PWD/plugin/deck-studio"

# 3) start
dsh --profile deckline --port 13090
```

Open the `http://127.0.0.1:13090/?token=…` URL printed in the terminal — that is the **workbench home**
(Decks / Designs / Assets / Conversations). Open a deck to get the **three-column workspace**:
DSH-native chat on the left, full-page image storyboard in the middle, document library on the right.

Detailed steps, git subdirectory installs and troubleshooting: [docs/install.en.md](docs/install.en.md) (English; [Chinese](docs/install.md)).

## Present directly from the workbench

Click **▶ 全屏演示 (Fullscreen presentation)** in a deck to play its existing full-page slide images:

- **← / ↑** goes back; **→ / ↓** goes forward — no PageUp / PageDown keys needed.
- **Esc** exits; on-screen previous / next controls and a slide counter are available.
- Playback does not generate images, edit content or overwrite revisions. Export PDF / PPTX when you need a file to share.

![Deckline fullscreen presentation with slide navigation](docs/assets/screenshots/08-presentation.png)

## Built-in templates and a reusable design library

A **template here is a visual style (Design)**: visual language, a reusable style prompt and sample images — not an editable PowerPoint master or a fixed slide layout.
Deckline ships **8 styles with 3 sample images each**: business consulting, premium dark, Japanese minimal, editorial, tech blueprint, whiteboard, Swiss minimal and aurora gradient.
They are imported on first start. Use **＋ 导入预设风格 (Import presets)** to fill an existing library; existing abbreviations are skipped.

![Eight built-in style templates with previews and management controls](docs/assets/screenshots/09-style-library.png)

- **Preview and select:** use a card's eye button for samples; pick a style when creating a deck, or associate / switch it in an existing deck's Design tab.
- **Create your own:** choose **＋ 添加风格 (Add style)**, enter a name, abbreviation and visual description, then paste, drag or upload sample images.
- **Manage definitions and samples:** open a style's dedicated canvas to inspect / copy its prompt, ask the Agent to update its definition, upload references or generate new samples.
- **Reuse across decks:** see linked decks and conversations; delete mistakenly created styles from their cards.
- Switching styles does not redraw old slides. Existing images remain; future renders use the selected style.

![Style management: definition, reusable prompt, conversations and sample controls](docs/assets/screenshots/10-style-management.png)

See the [style guide](docs/styles.en.md) and [user manual](docs/manual.en.md) for detailed steps.

## Configuration

Everything is configured in the **profile patch**: `~/.dsh/profiles/deckline/cordis.patch.yml`.
Copy the template at [`plugin/deck-studio/cordis.example.yml`](plugin/deck-studio/cordis.example.yml).

```yaml
- id: deck-studio
  name: 'dsh-plugin-deck-studio'
  config:
    displayName: 'Deckline'
    hideShellSidebar: true        # optional: collapse the DSH sidebar in this profile (default false)
    userName: 'your-name'
    projectsRoot: '/absolute/path/to/your/sharing'   # where new decks are created
    decks:                                            # read-only source decks
      - id: my-deck
        label: 'My deck'
        sourceRoot: '/absolute/path/to/my-deck'
```

### Image generation key

Deckline defaults to **fake mode** (placeholder images, no network), so you can walk through the whole
flow without a key. For real renders, point it at an OpenAI-compatible `/v1/images/generations` endpoint:

```yaml
    render:
      mode: real
      size: '2560x1440'
      default: 'main/gpt-image-2.5-sunburst'
      nodes:
        - id: main
          name: 'Main node'
          endpoint: 'https://your-image-relay.example.com/v1/images/generations'
          apiKeyEnv: 'DSH_DECK_IMAGE_API_KEY'        # or: apiKeyFile: '~/.keys/image.env'
          models: ['gpt-image-2.5-sunburst', 'gpt-image-2']
```

```sh
export DSH_DECK_IMAGE_API_KEY="sk-…"   # keys live in env vars / local key files, never in the repo
```

The workbench **Settings** panel shows each node and whether its key is configured
(boolean only — the key itself is never echoed).

## Using it

### An existing deck

Click a card under **Decks** on the home page: chat with the agent on the left, and on the right inspect
intent / script / design / changelog / feedback / research / materials / governance as document tabs.
Rendering is one slide at a time.

### A new deck

**＋ New Deck** (bottom left): fill in topic / audience / angle / intent and pick a style. Deckline creates
the source directory and the skeleton of 7 documents, then you keep working in chat.

### Your own design styles (paste images)

On the **Designs** page choose **＋ Add style** → name / abbreviation / visual description →
**paste with ⌘V, drag and drop, or pick files** in the "sample images" area (png/jpg/webp, multiple) → create.
That creates the style, a 0-page canvas and a design conversation.

To add samples to an existing style: click the **eye** icon on the style card → "＋ Add sample" at the
bottom of the preview. You can also drop images into `designs/<ABBR>/` directly
(see [docs/install.md](docs/install.md) §5, Chinese).

### 8 preset styles (shipped with the plugin)

**＋ Import preset styles** on the Designs page imports them in one click (idempotent; existing abbreviations
are skipped):

| Abbr | Style | Best for |
|---|---|---|
| BIZ | Business consulting (blue-grey) | Proposals / reviews / data pages |
| FYI | Premium dark (glass) | Launches / keynotes / premium brands |
| JPN | Japanese minimal (paper) | Culture / training / quiet narratives |
| EDT | Magazine editorial (serif headlines) | Brand stories / long-form info pages |
| TEC | Tech blueprint (isometric) | Architecture / technical proposals |
| SKT | Hand-drawn whiteboard (workshop) | Workshops / co-creation / training |
| SWS | Swiss minimal (black/white/red) | Minimal manifestos / big type |
| GRD | Aurora gradient (modern SaaS) | Product launches / internet style |

Each preset ships with 3 real baseline samples (cover / info page / data page, under
`plugin/deck-studio/seeds/samples/`); style definitions live in `plugin/deck-studio/seeds/styles/*.json`.
Directory layout and how to contribute your own: [docs/styles.en.md](docs/styles.en.md) (English; [Chinese](docs/styles.md)).

## Repository layout

```
plugin/deck-studio/        # the DSH plugin (npm package contents, installable as-is)
  seeds/styles/*.json      # built-in design style definitions
  seeds/samples/*.jpg      # three baseline samples per style
assets/logo/               # Deckline logo (svg + png)
samples/deckline-intro/    # example deck source: the Deckline product handbook
docs/                      # install / usage manual (zh + en), styles, sample deck, screenshots
  assets/screenshots/      # screenshots used by the README and the manual
market-index.json          # plugin-market index (add it as an index source in Discover)
```

## Sample deck: Deckline explains Deckline

[`samples/deckline-intro/`](samples/deckline-intro/) is a 10-page "Deckline product handbook" deck source
(intent / script / visual notes) shipped with the repo. Use it to walk the whole flow:
new deck → agent drafts the script → confirm → render slide by slide → export.

Follow [docs/sample-deck.en.md](docs/sample-deck.en.md) (English; [Chinese](docs/sample-deck.md)): content goes into the **＋ New Deck** dialog,
and the "references" come from the real inventory in
[samples/deckline-intro/materials.md](samples/deckline-intro/materials.md) (README / product docs / code
paths / preset styles and samples / logo / product screenshots, each mapped to a slide) — the agent is not
asked to invent them.

## Status

- Current version: `v0.2.5` (usable; API may still change)
- License: **MIT** (see [LICENSE](LICENSE))

## License

MIT © 2026 Yuna (Deckline). See [LICENSE](LICENSE).
