# Install & configure (Deckline · DSH plugin)

Deckline (`dsh-plugin-deck-studio`) is an **image-deck workbench plugin** for DeepSeek Harness (DSH):
native DSH chat on the left, a full-page image-deck workspace in the middle, and library / Designs /
assets / conversations on the right. It is not a standalone app — it runs on a DSH profile.

> Target users: people who build content and presentations with DSH. After setup you can edit a deck
> from its script, render slide images on request (single page or a named batch), manage governance documents, register your own
> design styles (with sample images) and start from 9 preset styles.

## Assistant capabilities (0.2.7+)

The Deckline preset explicitly mounts Web search/fetch, scoped file/image reading and search, scratch-file write/edit, a read-only research subagent, questions, todos, file delivery, time context and compaction. No shell, arbitrary-preset delegation or developer skills; internal audience reviewers remain tool-free.

Search uses the host Web settings. The default DeepSeek backend requires its account/`DEEPSEEK_API_KEY`; a third-party chat key does not configure search. HTTP fetch reads public destinations. Missing credentials must produce an explicit error, not fabricated results.

Generic reads are limited to the session workspace and explicit `deck-capabilities.config.readRoots`; secret paths and symlinks are denied. Authorize exact external material paths rather than an entire home directory. DSH image attachments use explicit `attachmentRoots` within its attachment objects subtree, for `read_image` only; this does not authorize the whole DSH directory. Image input also requires a vision-capable model route. Generic writes/edits are restricted to `.deck-assistant-scratch` under the workspace. Formal scripts, intent and revisions must use deck tools. Narrow directory searches to clean material directories if secret/symlink checks reject a broad scan.

If a handwritten profile overrides `preset-deck-studio.config.plugins`, merge the capability entries from the updated `cordis.example.yml`, restart and check a new session. Do not mount the whole standard preset or shell as a workaround.

## 0. Prerequisites

Plugin 0.2.6+ requires DSH 0.2.1-rc.2 or a newer 0.2.x release. Restart DSH after upgrading. Remove any manually declared `preset-deck-critic` entry from your profile; legacy `review.presetId` is ignored. Reviews now run internally without selecting another mode.

| Dependency | Version | Notes |
|---|---|---|
| Node.js | `^22.19` or `≥ 24` | Same as the DSH runtime; Node 23 is not supported |
| pnpm | 10+ | DSH uses pnpm to manage profile dependencies |
| DSH | `≥ 0.2.1-rc.2 < 0.3` (plugin 0.2.6+) | `npm i -g @deepseek-ai/dsh`; verified on 0.2.1-rc.2, see [compat.md](compat.md) |
| An LLM provider key | — | e.g. `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` (configured in the profile, see DSH docs) |
| An image node key | — | For real renders; the fake mode lets you try the flow first (section 4) |

```sh
node -v && pnpm -v && dsh --version
```

## 1. Installation (pick one of three)

### A. From npm (recommended once published)

```sh
# 1) create a deckline profile (based on the web template shipped with DSH)
dsh --profile deckline --from-default-profile web

# 2) install the plugin; dsh plugin add adds the bundle to the profile and enables it
dsh plugin --profile deckline add dsh-plugin-deck-studio
```

### B. From the Git repository (public repo, no npm account needed)

```sh
dsh --profile deckline --from-default-profile web
dsh plugin --profile deckline add "github:<your-account>/dsh-deck-studio#path:/plugin/deck-studio"
```

> pnpm's support for git subdirectories varies by version; if `#path:` fails, use C (clone + local install).

### C. Local clone (recommended for development / debugging)

```sh
git clone https://github.com/<your-account>/dsh-deck-studio.git
cd dsh-deck-studio
pnpm install --ignore-scripts   # optional: skip if you only run the plugin

dsh --profile deckline --from-default-profile web
dsh plugin --profile deckline add "$PWD/plugin/deck-studio"
```

Verify the installation:

```sh
dsh --profile deckline --dump-config | grep -n "deck-studio" | head
```

Seeing both `deck-studio` and `preset-deck-studio` means the install succeeded.

## 2. First configuration: decks / workspace / port

All Deckline configuration lives in the **profile patch**: `~/.dsh/profiles/deckline/cordis.patch.yml`.
The repository ships a copy-paste example:
[`plugin/deck-studio/cordis.example.yml`](../plugin/deck-studio/cordis.example.yml).

The minimum (append to the profile's `cordis.patch.yml`):

```yaml
# your deck source directory (read-only; any existing deck directory works)
- id: deck-studio
  name: 'dsh-plugin-deck-studio'
  config:
    displayName: 'Deckline'
    userName: 'Yuna'
    # root for new deck source files; empty = <dataRoot>/projects/<deck-id>/source
    projectsRoot: '/absolute/path/to/your/decks'
    # workspacePath: '/absolute/path/to/your/workspace'  # DSH chat workspace, not storage
    decks:
      - id: my-deck
        label: 'My deck'
        sourceRoot: '/absolute/path/to/my-deck'
```

> `decks[].sourceRoot` is a managed source and always read-only: Deckline never writes to it; working copies,
> revisions and renders live under `dataRoot`. A locally created deck is different: after user confirmation,
> script / intent source files may be written back to that local project directory. You can also start with **＋ New Deck** if you have no deck yet.

### Per-deck project rules (optional)

Drop a `deck.rules.md` at the root of a deck project to describe the creative constraints for that deck
(audience, taboos, brand, facts that must be respected). The Deck Agent reads and follows it on every
`deck_source_overview`:

```md
# Project rules
- Audience: internal business and IT, no technical background assumed
- Taboos: no unverified efficiency numbers; never name real customers
- Visual: cream paper + colored pencil, no 3D
```

- It only constrains **that one deck** and does not affect other decks; without the file there are no rules.
- It **cannot override** the product's hard rules (read-only source decks / QA gates / no fabrication /
  user confirmation). In a conflict the hard rules win and the agent says so.
- Max 8 KB; it is never written back and never triggers any automatic action.
- Do not name it `AGENTS.md`: that belongs to DSH workspace instructions and Deckline does not depend on it.

## 2.5 Where the data lives: source deck / documents / images / exports

Deckline keeps data in two places: **your deck source** (`projectsRoot`, plain markdown + source images)
and **runtime data** (`dataRoot`: working copies / renders / events). If you cannot find files after
creating a deck, check this table first.

| Content | Location | Notes |
|---|---|---|
| New deck source documents | `<projectsRoot>/<dir>/` | `intent.md` / `script.md` / `style-reference.md`; confirmed `docs/*.md` are written back here; `prompts/`, `pages/`, `outputs/` sit alongside |
| Working copies + governance docs | `<dataRoot>/decks/<deckId>/docs/` | changelog / feedback / research / materials / review / fact-check…; stay here until confirmed |
| Script revisions | `<dataRoot>/decks/<deckId>/script/revisions/vNNN.md` | copy-on-write; `current.md` is always latest |
| Rendered page images | `<dataRoot>/decks/<deckId>/slides/<pageId>/versions/<vNNN>/image.png` | one directory per revision, with `prompt.txt` / `content.json` / `qa.json`; old revisions are never overwritten |
| Style samples | `<dataRoot>/projects/<canvasDeckId>/source/designs/<ABBR>/sample-vNNN.png` (or your own `designs/<ABBR>/`) | samples imported / pasted in the UI |
| Exports | your browser's download folder | zips from "Export" (PDF / PPTX / handoff package) |

- **`dataRoot` defaults to `$DSH_HOME/deckline`** (usually `~/.dsh/deckline`) — never inside the plugin
  package, so plugin upgrades do not touch it. Override with `dataRoot: '/your/path'` in the profile patch,
  or the `DSH_DECK_DATA_ROOT` env var.
- **`projectsRoot`** decides where locally created deck source files live; if unset they go to `<dataRoot>/projects/<deckId>/source`. It does not select the chat workspace.
- **`workspacePath`** selects the DSH workspace used for conversation binding; it is independent of `projectsRoot` / `dataRoot`. If unset, Deckline resolves it from the startup and source directories.
- **Managed source decks are read-only**: Deckline never writes to a deck registered via `decks[].sourceRoot`; a confirmed local deck may write back to its own source files.
- **Backup**: archive `dataRoot` and `projectsRoot` together (documents + images + events):
  ```sh
  tar czf deckline-backup-$(date +%Y%m%d).tgz "$DSH_HOME/deckline" "<your projectsRoot>"
  ```
- The workbench **Settings** panel shows the current data directory; keep `dataRoot` outside the source tree
  in normal installs so runtime data is portable and plugin upgrades cannot overwrite it.

## 3. Start

```sh
dsh --profile deckline --port 13090
```

Open the `http://127.0.0.1:13090/?token=…` URL printed in the terminal.
`--port` is optional; the default is 13090 to avoid colliding with DSH's web profile on 3080.

## 4. Configure the image key (required for real renders)

Deckline supports:

- **fake mode** (default, offline): renders placeholder SVGs, enough to try the whole flow;
- **real mode**: calls an OpenAI-compatible `/v1/images/generations` node for real images.

> The plugin **ships no image node address** (provider-neutral): real mode requires your own endpoint
> and key. Otherwise the Settings panel says "no endpoint / key configured" and rendering fails loudly
> instead of silently hitting a default node.

### 4.1 Environment variables (simplest)

```sh
# image node (any OpenAI-compatible relay works)
export DSH_DECK_IMAGE_ENDPOINT="https://your-image-relay.example.com/v1/images/generations"
export DSH_DECK_IMAGE_MODEL="your-image-model"
export DSH_DECK_IMAGE_API_KEY="sk-…"          # shell / secret manager only
```

### 4.2 Profile patch (recommended: multiple nodes + team-shared config)

Override the `deck-studio` render config in `~/.dsh/profiles/deckline/cordis.patch.yml`:

```yaml
- id: deck-studio
  name: 'dsh-plugin-deck-studio'
  config:
    # …keep the displayName / decks from above
    render:
      mode: real
      size: '2560x1440'
      default: 'main/gpt-image-2.5-sunburst'
      nodes:
        - id: main
          name: 'Main node'
          endpoint: 'https://your-image-relay.example.com/v1/images/generations'
          # choose one: the environment variable name, or a local key file (KEY=VALUE, chmod 600, never in git)
          apiKeyEnv: 'DSH_DECK_IMAGE_API_KEY'
          apiKeyFile: '~/.config/image-relay.env'
          models:
            - 'gpt-image-2.5-sunburst'
            - 'gpt-image-2'
```

Key points:

- **Keys never go into the repo or into plain-text profile config**: the config only holds `apiKeyEnv`
  (environment variable name) or `apiKeyFile` (local file path).
- The workbench **Settings** panel shows whether each node's key is configured (boolean + source only,
  never the key itself).
- When no key is configured or the mode is still fake, the Settings panel shows a hint.
- Model names must match what your relay actually serves; for OpenAI-compatible `gpt-image-2`-series ids,
  consult the node's `/v1/models`.

## 5. Adding your own designs (two ways)

### Way 1: in the UI (recommended, supports pasting images)

1. Home → **Designs** → **＋ Add style**;
2. Fill in name / abbreviation / visual description (used as the prompt);
3. In the "sample images" area **paste with ⌘V, drag and drop, or pick files** (png/jpg/webp, multiple,
   ≤12 MB each);
4. Creating it also creates the style, a 0-page canvas and a design conversation; the samples appear
   immediately on the Designs card and in the preview.

To add samples to an existing style: click the **eye** icon on the style card → "＋ Add sample" at the
bottom of the preview (paste / pick files work the same way).

### Way 2: drop files on disk

Samples live under `designs/<ABBR>/` (ABBR is your style abbreviation):

- canvas directory (recommended): `<dataRoot>/projects/<canvasDeckId>/source/designs/<ABBR>/`;
- or `designs/<ABBR>/` inside any managed deck source (Deckline scans and merges them).

Refresh the page afterwards. png / jpg / webp are supported; names are free-form
(`sample-01.jpg` and similar keep them ordered).

### Use preset styles (no prompt writing needed)

**＋ Import preset styles** on the Designs page imports all 9 bundled styles (business consulting /
premium dark / Japanese minimal / magazine editorial / tech blueprint / hand-drawn whiteboard /
Swiss minimal / aurora gradient / deep-sea amber), each with samples. See [styles.md](styles.md).

## 6. Troubleshooting

| Symptom | What to do |
|---|---|
| Port already in use | `dsh --profile deckline --port 13100`; or kill the old process with `lsof -tiTCP:13090 -sTCP:LISTEN` |
| Page 404 / blank | Make sure the plugin bundle is enabled: `dsh --profile deckline --dump-config \| grep deck-studio` |
| No "render" button / render fails | Check the key state in Settings; confirm `render.mode: real`; `curl` the node endpoint |
| New decks land in the wrong place | Set `projectsRoot`; otherwise they go to `<dataRoot>/projects/` (by default `<DSH_HOME>/deckline/projects/`) |
| Where are data / samples | See section 2.5: source decks in `projectsRoot`, working copies / renders in `dataRoot` (default `~/.dsh/deckline`) |
| Upgrading the plugin | `dsh plugin --profile deckline install <spec>`, or `add` the new version again |

## 7. Developers: local verification

```sh
node plugin/deck-studio/verify/smoke.mjs        # 46 contract tests (no network or key needed)
node scripts/harness-check.mjs                 # instruction-chain / link / redaction / ledger gate
dsh --profile deck-studio --no-open             # development profile (port configured locally)
```

The plugin has no third-party runtime dependencies (Node built-ins only). Changes to
`plugin/deck-studio/index.js` require a profile restart; changes to `ui/` html/css hot-reload.
