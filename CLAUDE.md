# Nuzlocke Tracker — Project Reference (post-v5.3 audit)

## Where to start this session

No single forced first task. The closest things to ready-to-pick-up:

- **Deferred from the v5.3 audit**: (a) Gen 2 Burned Tower B1F missing Weezing 1% — Bulbapedia-verified, needs `pret/pokegold` source clone + a `gen2-convert.mjs` re-run to ship cleanly. (b) XY Santalune Forest missing Metapod — PokemonEncCalc binary disagrees with Bulbapedia on whether the slot exists; resolving requires re-reading the binary in `AngefloSH/PokemonEncCalc`'s `EncounterSlots/` data files.
- **In-flight ideas from prior iteration** still open: persist PokeAPI backfill to localStorage (30-day TTL), shiny clause wiring, no-legendaries wiring, hand-coded `bosses` arrays for XY/ORAS, Sinnoh conditional-encounters audit.

Ask the user before starting any of these — they may have something fresh.

---

## PWA offline mode (v1.0)

This fork (`offlineApp1.0/`) adds Progressive Web App support so the tracker installs to home screens and works offline. Files at the repo root that deploy alongside `log.html`:

- `manifest.json` — Web App Manifest (name, theme + background both `#0f0f10` to keep mobile chrome flush with the app, start_url `/log.html`, standalone display)
- `sw.js` — service worker (3 cache layers, message protocol)
- `icons/icon.svg` — Pokeball master icon (512×512 viewBox)
- `icons/icon-192.png`, `icons/icon-512.png` — rasterized icons for iOS apple-touch-icon + Android maskable
- `icons/_build-pngs.mjs` — Node script that regenerates the PNGs from scratch (uses built-in `zlib` + manual CRC; no sharp/canvas dependency). Re-run after editing `icon.svg`.

### Three-layer cache strategy

1. **Shell cache** (`nuz-shell-v1`) — populated on `install`. Network-first for HTML (updates land when online), cache-first for the other shell assets. Always on.
2. **PokeAPI runtime cache** (`nuz-pokeapi-v1`) — stale-while-revalidate for `pokeapi.co/api/v2/*` and `raw.githubusercontent.com/PokeAPI/sprites/*`. Always on. No size cap in v1.
3. **Aggressive pre-cache** — opt-in. Page sends a URL list via `postMessage`; SW fills the PokeAPI cache with concurrency 4 and reports progress.

### Cache versioning

Rename `nuz-shell-v1` → `nuz-shell-v2` (and same for `nuz-pokeapi-v1`) when:
- shell file list changes (add/remove anything in `SHELL_URLS` in `sw.js`)
- PokeAPI response shape changes in a way that invalidates stored bodies

The `activate` handler sweeps any `nuz-*` cache not in the keep-set, so a version bump auto-evicts the old one. Page can also force-clear via the `clear-caches` message.

### Shell file list (update on shell changes)

Whatever is in `SHELL_URLS` in `sw.js`. Current:
```
/log.html
/data.bundle.js
/manifest.json
/icons/icon.svg
/icons/icon-192.png
/icons/icon-512.png
https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js
https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600&family=Crimson+Pro:ital,wght@0,400;0,600;1,400&display=swap
```

If you add a CDN dep to `log.html`, append it here too — otherwise it won't be available offline. Bump the shell cache version when you do.

### SW message protocol (page <-> sw.js)

All messages exchanged via `postMessage`. Page side uses `navigator.serviceWorker.controller.postMessage(...)` and listens via `navigator.serviceWorker.addEventListener('message', ...)`.

```js
// Pre-fetch a batch of PokeAPI URLs into the runtime cache.
sw.postMessage({ type: 'prefetch-all', urls: [ 'https://pokeapi.co/api/v2/pokemon/1', ... ] });
// SW replies repeatedly with progress, then once with done.
//   { type: 'prefetch-progress', done: 40, total: 1200 }
//   { type: 'prefetch-done',     cached: 1198, failed: 2 }

// Wipe all nuz-* caches.
sw.postMessage({ type: 'clear-caches' });
// -> { type: 'caches-cleared' }

// Count items in each cache.
sw.postMessage({ type: 'cache-status' });
// -> { type: 'cache-status-result', shell: 8, pokeapi: 1240 }

// Activate a new waiting SW immediately (no reply).
sw.postMessage({ type: 'skip-waiting' });
```

The `type` strings are the contract — both sides must use them verbatim.

### Deploy notes

`manifest.json`, `sw.js`, and `icons/*` are part of the deploy and ship at the repo root alongside `log.html` / `data.bundle.js`. The SW is registered at scope `/` so it controls every page on the origin. iOS picks up the apple-touch-icon from `/icons/icon-192.png`; Chrome/Edge consume the SVG directly from the manifest. The `_build-pngs.mjs` script is build-time only — safe to ship but not required at runtime.

---

## v5.1 → v5.3 work history

Recent context — everything that landed since the v5.1 CLAUDE.md was written. Listed roughly in order of significance.

### Major features / data extractions

1. **XY encounter-tables (new ROM-extracted)** — sourced from [AngefloSH/PokemonEncCalc](https://github.com/AngefloSH/PokemonEncCalc) binary resource files in its `EncounterSlots/` folder. Converter at `_converters/xy-convert.mjs` reads the C# parser's binary format and emits `X.txt` + `Y.txt` (41 locations × 167 tables each, all 100%-summing). Carries hordes, Rock Smash, tall grass, shallow water, three flower-tile color variants, surf, all three rods — none of which PokeAPI's `kalos` region exposes condition data for. PokeAPI kept as fallback for sub-zones not extracted. XY does NOT have a day/night cycle for wild encounters (every table emits `(Day)` as the only time tag — that's accurate to the ROM, not a converter bug).

2. **SwSh encounter-tables (new web-extraction)** — Serebii Pokearth scrape via `_converters/swsh-convert.mjs`. Produces `Sword.txt` (461 Map blocks, 1371 tables) + `Shield.txt` (461 blocks, 1387 tables). Covers all 10 routes, Wild Area zones (17 main + 16 Isle of Armor + 13 Crown Tundra), with weather variants encoded as sub-zone suffixes (e.g. `Rolling Fields (Overcast)`). Cave of Dragonflies' Wild Area data was probed but its per-weather JSON groups by Pokemon (not by location) and lacks level ranges; Serebii used exclusively. pkNX (kwsch) was identified as the ROM-direct gold standard but requires a user-dumped ROM — out of scope.

3. **SwSh weather tabs renderer** — Wild Area locations have up to 9 weather variants (Normal Weather, Overcast, Raining, Thunderstorm, Intense Sun, Snowing, Snowstorm, Sandstorm, Fog). Rendering them as stacked sub-zones gave 9 sections per location; instead, `buildEncounterMainFromTables` now detects weather-shaped sub-zones via `extractWeather(subZone)` and renders a tab strip above the encounter sections (parallel to the Day/Night tabs). State: `selectedEncWeather` global + `setEncWeather()` setter. Non-weather residual (e.g. "Area 2, Overcast" → "Area 2") is preserved as the sub-zone label inside the active-weather view.

4. **SV exclusivity prune** — Scarlet.txt and Violet.txt previously contained IDENTICAL species lists at every location, so `buildEncounterMainNuzData`'s per-species version set always saw `{S,V}` and no version badge ever rendered. Pruned via `_converters/sv-prune-exclusives.mjs`. Authoritative list per Bulbapedia: Scarlet-only (`larvitar/pupitar/tyranitar`, `stunky/skuntank`, `drifloon/drifblim`, `skrelp/dragalge`, `deino/zweilous/hydreigon`, `larvesta/volcarona`, `houndour/houndoom`, `stonjourner`, `oranguru`, `armarouge`, past paradoxes, koraidon) and Violet-only (`misdreavus/mismagius`, `bagon/shelgon/salamence`, `gulpin/swalot`, `clauncher/clawitzer`, `goomy/sliggoo/goodra`, `dreepy/drakloak/dragapult`, `eiscue`, `passimian`, `ceruledge`, future paradoxes, miraidon). Removed 19 species from Scarlet + 141 from Violet across 35 lines total. The converter is idempotent.

5. **SV boss-tier retags** — 5 Team Star bosses (`giacomo/mela/atticus/ortega/eri`) retagged `evil-team` → `mini-boss`; 5 Titans (`t1/t2/t3/t4s/t4v/t5`) retagged `titan` → `mini-boss`; Geeta (`ec`) retagged `elite-four` → `champion`; Nemona's final battle (`ec2`, Mesagoza) retagged `rival` → `champion`. Final SV boss list: 8 gyms + 10 mini-bosses (5 Team Star + 5 Titans) + 4 Elite Four + 2 Champions = 24 entries. Also fixed `--Weat Province (A1)` → `--West Province (A1)` typo (Open Sky Titan was attached to a phantom location).

6. **SwSh letter relabel `S`/`H` → `Sw`/`Sh`** — Sword and Shield both start with "S" so single-letter keys were ambiguous in version-exclusive badges. `GAMES['sword_shield'].versions` is now `{ Sw: 'Sword', Sh: 'Shield' }`; same for `dataSources.routes`, `dataSources.encounterTables`, `defaultVersion`. `migrateLegacyGameKeys` rewrites existing saves with `run.version === 'S' → 'Sw'` and `'H' → 'Sh'` for sword_shield runs. New CSS rules `.ver-tag.Sw` (crimson) and `.ver-tag.Sh` (cyan).

7. **HGSS version-tag fix (was the v5.1 first task)** — `derivePoolsFromMethods` was filtering `letter !== ver` before adding letters to the per-pool `letters` set, so for a shared species like Geodude in Dark Cave the set always ended up with `{H}` and the species was tagged HG-exclusive. Fix at log.html ~line 5697: letters now accumulate from every version's bucket, but only the active version's `sum` contributes to `bucket.chance`. The existing `if (chance <= 0) continue` further down filters off-version species (S-only when viewing HG → `chance=0` → dropped), so the "don't show the other version" behavior is preserved.

8. **Encounter-tables cross-version merge key fix** — Was `${mapId}#${tableN}#${lvMin}-${lvMax}#${method}`. SwSh's Serebii scrape can carry slightly different level ranges for what's conceptually the same Table N (Rolling Fields Table 2 was Lv 7-9 in Sword vs Lv 7-10 in Shield). The lvRange in the key prevented those pools from merging across versions and falsely tagged every species in them as version-exclusive. Fixed to `${mapId}#${tableN}#${method}#${subZone||''}`. When the second version's pool merges in, we now union `min(lvMin)/max(lvMax)` so the displayed range covers both.

9. **Evolution-move learnset detection** — PokeAPI tags evolution-learned moves with `level_learned_at: 0` in Gen 7+ version groups. The previous code filtered `level_learned_at > 0` and broke on first match per move, so e.g. Crobat's Cross Poison (level 1 in HGSS data) looked like a regular L1 starting move and got greyed out as "already known" when the user evolved a Golbat. Fix in `fetchLearnset`: cross-references modern VGs (`sword-shield`, `brilliant-diamond-shining-pearl`, `ultra-sun-ultra-moon`, `sun-moon`) for L0 entries, stamps `isEvo: true` on the chosen-VG entry, and sets `lv: 0` as the canonical marker. `renderPokeViewLearnset` splits evo moves out from level moves, pins them to the top of the list with an "Evo" label, surfaces them in the suggestion scorer with a lower threshold (35 vs 45), and shows "On evolution — Cross Poison" in the suggest banner. Also fixed a latent typo in the preferred-VG list (`brilliant-diamond-and-shining-pearl` → `brilliant-diamond-shining-pearl`). Cache key bumped `learnset_` → `learnset_v2_` to invalidate stale localStorage caches that lacked the `isEvo` flag.

10. **Details action button on encounter menu** — `encActionMenu` (the click-on-species popover) now has a 4th button "🔍 Details (types, stats, matchups)" calling `encActionDetails(species)` that opens a modal with weakness/resistance/stats so the user can plan a catch without 1-shotting.

11. **Level Up button on roster cards** — `pv-actions` block gained "▲ Level Up (Lv N+1)" calling `levelUpPoke(idx)`. Bumps level by 1, and if the new level matches a learnset entry, surfaces the inline new-move prompt with the suggestion blurb (reuses `renderPokeViewLearnset`'s logic) so the user doesn't have to: open card → edit → bump level → re-open → check moves → maybe edit again.

12. **Mobile Switch-save button restore** — At the 420px breakpoint, `.header-sub` (save-key indicator) and `.hdr-btn.danger` (Switch save) were both `display: none` with a TODO comment about reaching them "from a menu" that was never built. Both restored; the Switch save label compresses from "🚪 Switch save" → "🚪 Switch" on phones via paired `.hdr-btn-full-label` / `.hdr-btn-compact-label` spans.

### Card UX polish (smaller items)

- **Drag responsiveness** — Replaced time-based hold disambiguation (`delay: 150ms desktop / 250ms touch`) with movement threshold: `delayOnTouchOnly: true`, `touchStartThreshold: 6`. Desktop drag starts on first 6px of motion, no time wait; touch keeps the 250ms hold + 6px threshold so page scroll still works.
- **Hover state + text-select** — `.poke-card` now has `user-select: none` + `-webkit-touch-callout: none` so a fast click-drag doesn't accidentally start a native text selection. Hover state bolded: accent-tinted border + soft 1px accent ring + drop shadow.
- **`+ Add to party` button layout** — Was a sibling of the sprite inside the horizontal flex row of `.card-top.with-sprite`. On 3-col desktop cards it ate ~100px of a ~330px card and squished the moves grid. Pulled into a new `cardPartyBtn(p, idx)` helper rendered as a footer row below `.card-top`, right-aligned via `align-self: flex-end` (the `.poke-card` is column-flex).
- **Bench reorder splice fix** — `initRosterSortable.onEnd` used `alive[evt.oldIndex].i` to map the dragged item to a team-array index, but `evt.oldIndex` is a position in the BENCH grid (which excludes party members). When the user had anyone in party, the splice grabbed the wrong slot and silently mangled the team array. Switched to a `benchOf()` helper that mirrors `renderRoster`'s exact filter (`alive && !inParty && matchFilter`). Both drag handlers now also call `renderRoster()` / `renderActive()` at the end of `onEnd` to refresh stale `onclick="openEdit(${i})"` handlers — previously, clicking the moved card would open a different Pokémon's editor.

### v5.3 audit pass (2026-05-19)

Four-engineer audit (E1-E4) + proof team (P1). Read-only, all findings cited file:line + Bulbapedia URL.

- **E1**: verified version-tag fix on every paired game. All 13 PokeAPI / encounter-tables paths PASS (RB, GS, RS, FRLG, DP, BW, B2W2, HGSS, ORAS, XY, BDSP, SwSh, Gen 2). SV was the one FAIL (item #4 above — exclusivity prune fixed it).
- **E2**: 2-3 routes per mainline vs Bulbapedia. Most clean. Caught: Gen 2 Burned Tower B1F missing Weezing (deferred), XY Santalune Forest missing Metapod (deferred — source dispute), XY Route 2 Caterpie (correct as-is, Y-only), SwSh Rolling Fields Vulpix/Growlithe reversed between versions, Yellow Route 2 phantom `mrmime`. Plus various NEEDS-CHECK items that resolved as no-bug.
- **E3**: boss data audit. Zero data bugs across all mainlines. Confirmed v5.3 boss counts: RBY/Y 13, GSC 21, RSE 13, FRLG 13, DPPt 13, HGSS 21, BW 18, B2W2 13, XY 13, ORAS 13, SM 17, USUM 17, BDSP 13, SwSh 18, SV 24. (My audit brief said HGSS 24 — that was stale, post-retag is 21.)
- **E4**: hack ROM audit (first ever). Found 5 phantom-location typos: `Insurgence.txt mini-bos`, `BlazeBlack.txt + VoltWhite.txt + Black.txt + White.txt Tranier's School`, `InclementEmerald.txt Petalbug Woods`, `Glazed.txt OceanView Power Plant`, `EmeraldRunAndBun.txt Slatport Museum`. Plus a vanilla-bonus: 6 Kanto routes had `Pokemon Tower Rival` with ASCII `e` while the route header used `Pokémon Tower` with `é` (mirrors the Yellow.txt fix that hadn't propagated).

**Fixes applied**: 5 hack typos + 6 Kanto Pokémon Tower accent + Yellow mrmime + SwSh vulpix/growlithe swap + SV exclusivity comprehensive prune. 19 routes files modified.

---

A web app for tracking Pokémon Nuzlocke runs. Single-page HTML deployed via GitHub Pages. The user opens it through their domain (`pokenuztracker.runeshift.xyz`), picks a game + version, and the app provides: encounter reference, boss matchup analysis, roster/active-team tracking, route log, graveyard, run stats with timeline, and configurable house rules. Saves cloud-sync to a Cloudflare Worker — same save key works across machines.

## File layout

**Repo layout (= GitHub Pages deploy target, served at `pokenuztracker.runeshift.xyz`)**:

```
runeshift/                            ← repo root, served as the site root
├── CNAME                             ← pokenuztracker.runeshift.xyz
├── log.html                          ← the entire app
├── data.bundle.js                    ← generated; exposes window.NUZ_DATA
└── nuzlocke data sets for unique cases/
    ├── routes/<Name>.txt
    ├── leagues/<Name>.txt
    ├── patches/<Name>.txt
    └── encounter-tables/<Name>.txt
```

**Dev-time additions** (not committed to repo but live alongside the deployed files in the working folder):

```
runeshift/
├── CLAUDE.md                         ← this file
├── .gitignore
├── build-data.mjs                    ← Node bundler script (ESM)
├── _converters/                      ← regeneration scripts (idempotent, kept for rebuilds)
│   ├── gen2-convert.mjs              — pret/pokegold + pret/pokecrystal → Gold/Silver/Crystal
│   ├── bdsp-subzone-labels.mjs       — adds (SubZone) parens to BDSP Map headers
│   ├── classify-sm-usum-methods.mjs  — adds [grass]/[surf]/[rod] tags to SM/USUM dumps
│   ├── xy-convert.mjs                — AngefloSH/PokemonEncCalc binary → X.txt/Y.txt
│   ├── swsh-convert.mjs              — Serebii Pokearth scrape → Sword.txt/Shield.txt
│   ├── sv-prune-exclusives.mjs       — Bulbapedia-sourced SV exclusivity sweep on Scarlet/Violet
│   └── fix-typos.mjs                 — one-shot location-name typo fixer (already applied)
└── _to-upload/                       ← per-batch upload staging (gitignored via `_*/`)
```

**Old working copies** are in `!old/` at repo root (v5.1, v5.2, etc.). The current working dir is the freshly-pulled `5.3/runeshift/`.

## Data flow

1. **Bundler** (`build-data.mjs`): reads every `.txt` under `nuzlocke data sets for unique cases/{routes,leagues,patches,encounter-tables}/`. Each file is parsed into structured objects. Output: `data.bundle.js` which sets `window.NUZ_DATA = { meta, routes, leagues, patches, encounterTables }`. Run with `node build-data.mjs` from the runeshift root after editing any data file.
2. **Bundle keys** = file basename without `.txt`. Example: `leagues/BrilliantDiamondShiningPearl.txt` → `NUZ_DATA.leagues.BrilliantDiamondShiningPearl`.
3. **App** (`log.html`): a single `<script src="data.bundle.js">` loads `NUZ_DATA` before the inline app code runs. `GAMES[...].dataSources` references those keys.

## Save system

Saves cloud-sync to a Cloudflare Worker at `https://shrill-darkness-8d1c.mcollins189.workers.dev` (constant `API` at the top of log.html). localStorage only caches the save key locally; data lives in the cloud, so the same save key works across machines.

- Autosave fires 5 min after any change (`saveTimer`).
- Manual "💾 Save now" button forces an immediate push.
- `visibilitychange` listener fires `cloudSave` when the tab is backgrounded with unsaved changes (fixes "I made changes, re-logged in, lost them" edge case).
- Loading runs migrations:
  - `migrateLegacyGameKeys` — renames retired GAMES keys + remaps `run.version` `S`→`Sw`, `H`→`Sh` for `sword_shield` runs (added when SwSh letters were relabeled in v5.3).
  - `migrateLegacyLocationNames` — rewrites typo'd location strings in saved `team[].route` / `routes[].route` fields.
  - Both migrations are idempotent.
- Header has `⬇ Export` (downloads `nuzlocke-<saveKey>-<timestamp>.json`) and `⬆ Import` (file picker → confirm → replace → immediate cloud-save).

When fixing typos in `routes/` location names, add the rewrite mapping to `LEGACY_LOCATION_NAME_SUBSTRINGS` in log.html so existing saves keep linking to the rail correctly after deploy.

## Adding a new game

Three steps:

1. **Get the data files in place** under the right folder (PascalCase per version for routes; combined per game-pair for leagues/patches).
2. **Add a GAMES entry** in `log.html`:
   ```js
   'my_new_game': {
     name: 'My New Game', short: 'MNG', gen: 5,
     versions: { A: 'Version A', B: 'Version B' },  // omit for solo games
     defaultVersion: 'A',
     dataSources: {
       routes: { A: 'VersionAFile', B: 'VersionBFile' },
       leagues: 'CombinedLeaguesFile',
       patches: 'OptionalPatchesFile',     // only for ROM hacks
       encounterTables: 'OptionalTableFile', // BDSP/USUM/SM/Gen2/XY/SwSh — rich per-map data
       pokeapiRegion: 'unova'              // omit if no PokeAPI coverage. Can be array
                                            // for multi-region games (Gen 2 + HGSS).
     }
   }
   ```
3. **Add to `GAME_DISPLAY_ORDER`** so it appears in the new-run dropdown. Optionally also add a `POKEAPI_GAME_VERSIONS` entry if it uses PokeAPI region encounters.

Re-run the bundler. Reload the app.

## `renderEncounters` dispatch order

Top-level dispatch in `renderEncounters()`:

1. If `game.dataSources.encounterTables`: → `renderEncountersFromTables()` (rail from txt routes, body from `encounter-tables/<file>.txt` — Gen 2, BDSP, SM, USUM, **XY**, **SwSh**)
2. Else if `game.dataSources.pokeapiRegion`: → `renderEncountersByRegion()` (fetches PokeAPI region, lazy-fetches per-location areas)
3. Else if `game.dataSources.routes`: → `renderEncountersFromNuzData()` (txt species lists only — hack ROMs + SV)
4. Else: empty fallback

XY also keeps `pokeapiRegion: 'kalos'` as a fallback for sub-zones the encounter-tables don't cover.

## Boss derivation (`getBosses(gameKey)`)

- **Hand-coded** `GAMES[k].bosses` wins. BDSP, B2W2, USUM are hand-coded.
- If `dataSources.leagues` is also set, `enrichBossesWithLeagues()` merges moves/ability/item from the txt file into hand-coded entries by trainer name (fuzzy normalization strips `(Trial)`, "Island Kahuna", "Captain", etc.).
- If no hand-coded `bosses`, `deriveBossesFromData()` builds the list from `NUZ_DATA.leagues.<key>` cross-referenced with the routes file's `battleType` marker.

**`BOSS_BATTLE_TYPES`** = `{'gym-leader','elite-four','champion','mini-boss'}`. Intentionally excludes `evil-team`, `rival`, `event-boss`, `titan`:
- `evil-team` would surface N's four BW pre-Champion battles, Ghetsis, Cyrus, Lysandre, Guzma — story bosses but not cap-defining.
- `event-boss` is the tag for HGSS's Elder Li / Eusine / Kimono Girls (sub-boss but not cap-defining).
- `titan` is unused in BOSS_BATTLE_TYPES because the SV Titans were retagged `mini-boss` in v5.3.
- `mini-boss` IS in the set because ROM hacks (Blaze Black 2, New Generations) and SV (Team Star + Titans) use it.

**Multi-version tier lookup** — for paired games `tierByKey` walks every version's routes file. Catches version-exclusive gym leaders like Iris (W-only). When the same trainer key appears in both versions with different battleTypes, boss-tier outranks rival/evil-team.

**Strict filter** — entries in the leagues file without a matching routes-file `battleType` marker are dropped. Catches leagues-file orphans (XY's AZ, SM's Gladion g2, ORAS Team Aqua admins, etc.).

**Rematch dedupe** — within each derived list, when the same trainer name reappears at the SAME location with different caps, only the lowest-cap entry survives. Drops BW/B2W2's second-round Elite Four.

**Name disambiguation** when one trainer has multiple battles: location → theme → cap level → enumeration. E.g. "N — Accumula Town", "Shauntal — Pokémon League (Lv 56)".

Result cached in `_bossesCache[gameKey]`. Cache busted automatically when PokeAPI backfill completes.

**Mini-boss tag handling** — ROM hacks (Blaze Black 2, New Generations) use `mini-boss` as their primary cross-region gym leader tag. SV uses `mini-boss` for Team Star bases + Titans. Vanilla games that have story-mini-boss fights (Elder Li / Eusine / Kimono Girls in HGSS) use `event-boss` (NOT in BOSS_BATTLE_TYPES) so they show up under the trainer list at their location but don't pollute the cap dropdown. When tagging new content: `mini-boss` for cap-defining battles, `event-boss` for one-off story bosses.

## PokeAPI backfill (gen-aware)

`backfilledPokemon` (in-memory) and `backfilledMoves`. Both auto-populated as views need data not in `POKEMON_DB` (Sinnoh-focused) or `MOVE_DATA` (BDSP-era).

- **Species**: `fetchPokemonFromApi(species, gen)` reads `past_types`.
- **Moves**: `fetchMoveFromApi(name, gen)` reads `past_values`. Handles Gen 1-3 type-based physical/special split.
- Re-render via `onBackfill(fn)` subscribers (debounced). Currently re-renders matchup, roster, and encounters tabs.
- Failure (404) cached as `'error'` so fakemon don't retry.
- **Learnset** (`fetchLearnset`): localStorage-cached with 30-day TTL under key `learnset_v2_<species>`. Captures level-up moves from a preferred version group, and additionally detects evolution-learned moves (L0 entries in modern VGs) and flags them with `isEvo: true`. Renderer treats evo moves separately: pinned to top of learnset list, shown with "Evo" label instead of L1, included in suggestion scorer with a lower threshold.

## Patches (ROM hack overrides) — `getActivePatches()`

Four maps indexed when active game has `dataSources.patches`: **moves**, **stats**, **fakemon**, **items**.

Two distinct shapes coexist in `--pokemon` sections:
- Glazed-style **form linkage**: `|charizard||charmander>charizard-mega-x,charizard-mega-y`
- Blazevolt-style **stat overrides**: `,,,95,,90|butterfree`

Parser sniffs the leading field — numeric-CSV = stat override, otherwise form linkage. Stored with `kind` discriminator.

## Encounter-tables file format

Text format expected by `parseEncounterTables()` in `build-data.mjs`:

```
==========
Map: <zoneID> - <Location Name> [(<SubZone>)]
                                ← (SubZone) optional, e.g. "Hau'oli City (Beachfront)"
                                ← Multi-name "Map: NNN - X / MMM - Y" supported
                                ← SwSh uses sub-zone for weather variants: "Rolling Fields (Overcast)"
Tables: <count>
Table 1 [grass] (Day):          ← (Day|Night|Morning|All) required; (All) for games with no time cycle (XY, SwSh)
Encounters (Levels X-Y): Sp1 (P%), Sp2 (P%), ...
Additional SOS encounters: (None)
```

**Method tags currently in use**: `grass`, `surf`, `oldRod`, `goodRod`, `superRod`, `rockSmash`, `horde`. XY-specific extras: `tallGrass`, `shallowWater`, `yellowFlowers`, `redFlowers`, `purpleFlowers`. Future-proofed for `honey`.

**Time-of-day tags**: `Morning` (Gen 2 only), `Day`, `Night`, `All` (XY, SwSh — no time cycle). The parser maps `All` → `day` bucket so it renders without a time tab strip.

Each parsed pool: `{ mapId, tableN, lvMin, lvMax, method, morning:[], day:[], night:[], subZone }`.

**Sub-zone labels**: when the Map header has a parenthetical, the parser stores the pool under both the parent name AND the parenthetical-qualified name, but tags `pool.subZone = "Beachfront"` only on the parent's entry. The renderer surfaces this label in place of generic A/B/C.

## Encounter-tables renderer (`buildEncounterMainFromTables()`)

1. **Cross-version structural merge** by key `${mapId}#${tableN}#${method}#${subZone||''}`. Note: lvMin/lvMax are NOT in the key (was a bug pre-v5.3 — SwSh's Serebii scrape sometimes carried slightly different level ranges per version for the same conceptual table, which prevented merge and falsely tagged species as version-exclusive). On merge, lvMin/lvMax are unioned via min/max.
2. **Post-merge sig-dedup** to collapse identical-content pools (e.g., USUM's bundled Map 000/003/010 producing 3 identical entries).
3. **SwSh weather tabs** — `extractWeather(subZone)` recognizes the 9 SwSh weather names (Normal Weather / Overcast / Raining / Thunderstorm / Intense Sun / Snowing / Snowstorm / Sandstorm / Fog). When >1 weather appears, a tab strip renders above the encounter sections and pools get filtered to the active weather; the weather is peeled off `pool.subZone` so any residual (e.g. "Area 2" from "Area 2, Overcast") still labels the sub-section.
4. **Method-based rendering** when pools have method tags: one section per method in canonical order (Walking → Tall grass → Shallow water → Flowers → Surfing → Rods → Rock Smash → Horde). Morning/Day/Night tabs inside the Walking section only.
5. **Methodless rendering** fallback (USUM): groups by level range with a global Day/Night tab.
6. **Sub-zone-aware sub-pool labels** — when a Map has multiple distinct pools per location, the label prefers `pool.subZone` (e.g., "1F Outside", "Beachfront", "B2F Mahogany Side") over A/B/C. When siblings share the same subZone, A/B/C/D appended to disambiguate.
7. **Per-species version filter** via `matchesVer` — species tagged with the OPPOSITE version filtered out for the user's current selection.
8. **Alola grass sub-method classifier** (SM/USUM): heuristic split of `[grass]` pools into Walking / Rustling grass / Flying overhead / Berry trees. Rules in `classifyGrassSubMethod`: 1 species at ≥95% + whitelisted berry-tree species (Crabrawler / Crabominable / Komala) → Berry; else 1@95% → Rustling. 2-3 species top ≥60% + all-Alola-flying-set (Spearow/Pikipek/Rufflet/Vullaby lines) → Flying. 2-4 species top ≥50% → Rustling. Otherwise → Walking. Plus a promotion pass that re-labels rustling-only locations to Walking when ≥3 species or sibling levels overlap.

## Building the encounter-tables files

### Gen 2 (Gold / Silver / Crystal)

Source: `pret/pokegold` (Gold+Silver, branched by `IF DEF(_GOLD)/_SILVER`) and `pret/pokecrystal` (Crystal). Converter at `_converters/gen2-convert.mjs`. Requires `gen2-pret/pokegold/` + `gen2-pret/pokecrystal/` clones (gitignored). Applies slot probs grass `[30,30,20,10,5,4,1]`, water `[60,30,10]`, fish via cumulative-percent decoding.

### BDSP

Source: TeamLumi/Gamedata `vanilla_input/FieldEncountTable_d.json`. SP derived by applying documented BD↔SP swaps. Slot probs grass `[20,20,10,10,10,10,5,5,4,4,1,1]`, surf `[60,30,5,4,1]`, all rods `[40,25,25,5,5]` (BDSP-specific, NOT canonical DPPt). Day/Night override at `ground_mons` indices 2 and 3 (NOT 3, 4). Sub-zone labels post-processed by `_converters/bdsp-subzone-labels.mjs` using TeamLumi's `input/areas.csv` + manual map.

### SM and USUM

Source: pk3DS dumps. USUM via SciresM gists (`a539739085…` Sun, `deecdcf5fc…` Moon). SM via SkyLink98 Project Pokemon forum attachment (`projectpokemon.org/home/applications/core/interface/file/attachment.php?id=47152` for Sun) + pastebins (`YjNi4Qdk` + `HKEVPUYX` for Moon). Method tagging via `_converters/classify-sm-usum-methods.mjs`. PKHeX is NOT a usable source (no time-of-day).

### XY (new in v5.3)

Source: `AngefloSH/PokemonEncCalc` C# encounter calculator's bundled binary resource files (`EncounterSlots/` folder, ROM-derived). Converter at `_converters/xy-convert.mjs` reads the C# parser's binary format. Slot probabilities verified against `AreaMapXY.cs`:
- grass / flowers / "other" (12 slots): `[10,10,10,10,10,10,10,10,10,5,4,1]`
- surf / rock smash (5 slots): `[50,30,15,4,1]`
- all rods (3 slots each): `[60,35,5]`
- hordes: 3 horde groups weighted `[60,35,5]`, each slot is `groupWeight / 5`

Other-slots dispatch (per `AreaMapXY.cs` map-index switches): maps `{17, 27}` → `tallGrass` (Routes 6 + 16); `{25, 30}` → `shallowWater` (Routes 14 + 19); `{20, 24, 28}` → `grass` (Routes 9 + 13 + 17 rough terrain). Re-run only when PokemonEncCalc binary changes. **Deferred**: Santalune Forest Metapod 4% discrepancy between PokemonEncCalc binary (no Metapod, 100% pool sum) and Bulbapedia (Metapod present, 114% pool sum). The binary is treated as ROM-authoritative for now.

### SwSh (new in v5.3)

Source: Serebii Pokearth per-zone pages (`https://www.serebii.net/pokearth/galar/<slug>.shtml`). Converter at `_converters/swsh-convert.mjs` scrapes with 500ms rate-limit. Cave of Dragonflies' inline JS for Wild Area was probed but groups by Pokemon (not location) and lacks level ranges — not used. Coverage: 10 routes + Galar Mine 1+2 + Motostoke + Hulbury + Glimwood Tangle + Axew's Eye + Slumbering Weald + 17 main Wild Area zones + 16 Isle of Armor zones + 13 Crown Tundra zones. Weather variants encoded as sub-zone parens. SwSh has no day/night cycle (every table tagged `(All)`).

## Name lookup quirks (PokeAPI-driven games)

PokeAPI returns location-area slugs like `kanto-vermilion-city`. `prettifyLocationName()` strips the region prefix and capitalizes. Sometimes txt routes names don't strict-match.

Solutions in place (log.html, around `findRegionLocation`):
- **`normLocForApi()`** — strips periods, accents (NFD + combining-marks removal), apostrophe variants, leading "The ", lowercase. Matches `Mt. Moon ↔ Mt Moon`, `Pokémon Tower ↔ Pokemon Tower`, `The Old Chateau ↔ Old Chateau`, `Hau'oli ↔ Hauoli`.
- **`LOC_NAME_ALIASES`** — small static map for stubborn renames: Mirage Forest → Mirage Spot Forest (ORAS), Soaring → Soaring In The Sky, Ruin Maniac's Tunnel → Maniac Tunnel (DP), Nature Preserve → Nature Sanctuary (B2W2), Tin Tower → Bell Tower (HGSS), Rocket Hideout → Team Rocket Hq.
- **Sea-prefix fallback** — retry with `"sea "` prepended. Handles RGBY/FRLG Routes 19/20/21 ↔ Sea Route N, GS/HGSS Routes 40/41 ↔ Sea Route N.
- **Multi-floor merge** (`findRegionLocationsWithFloors`) — when PokeAPI splits one txt location into floor-numbered variants, the loader fetches all and merges area lists.
- **Multi-region** — `pokeapiRegion` can be an array (`['johto', 'kanto']` for Gen 2 + HGSS). `ensureRegionLoaded` loads each, `findLocationAcrossRegions` walks them in order.

`prettifyLocationName` recognizes `kalos` in its region-strip regex (was originally missing).

## Encounter rate aggregation (PokeAPI path)

`fetchPokeApiEncounters()` aggregates `pokemon_encounters` from PokeAPI:
- **Within an `(area, season, version-letter, condTag)` bucket**: SUM chances.
- **Across buckets**: MAX. Handles BW seasons (4 × 25% would inflate to 100% with sum), multi-floor caves.

Bucket key: `"${areaIdx}:${season}:${letter}:${condTag}"`. Finalize rolls into `chanceByLetter` (version exclusivity) and `chanceBySeason` (season pill).

**`condTag`** separates mutex states like PokeRadar / Swarm / GBA Slot 2 / HGSS Radio. `'base'` = baseline play.

## Pool-mode rendering (PokeAPI-driven games)

`buildEncounterMain()` detects pool-mode when `data.areas` exists and species carry `chanceBy`. Calls `derivePoolsFromMethods()` to emit one section per `(areaIdx, method, condTag)` tuple.

Drives the Day/Night tab and the **"Baseline / + Conditionals" toggle** (`selectedEncConditionals`, default off) that filters in/out non-`base` condTag pools.

**HGSS fix** (v5.3): the per-pool `letters` set is populated unconditionally of the current `ver` filter (was conditional, which made every shared species look version-exclusive). Only the active version's `sum` contributes to `bucket.chance`; off-version species get filtered out by `if (chance <= 0) continue` downstream.

## Known PokeAPI quirks (and our workarounds)

- **BDSP has zero encounter data**. Bypassed via encounter-tables.
- **SM/USUM time-of-day stripped** — every `condition_values` array is empty in Gen 7 location-areas. Bypassed via encounter-tables (pk3DS dumps).
- **XY has no condition_values** — zero day/night/horde/Friend Safari data in PokeAPI. Bypassed via encounter-tables (PokemonEncCalc binary). PokeAPI kept as fallback for sub-zones we didn't extract.
- **Galar (SwSh) has zero encounter data**. Bypassed via encounter-tables (Serebii scrape).
- **Paldea (SV) has no location-areas at all**. Falls back to NUZ_DATA-only species-list path with hand-tagged exclusivity in `Scarlet.txt` / `Violet.txt`.
- **USUM Alolan forms tagged with `sun`/`moon`**: PokeAPI parks meowth-alola/grimer-alola etc. under the older Sun/Moon versions. Fix: `POKEAPI_GAME_VERSIONS.ultra_sun_moon` lists priority `['ultra-sun', 'sun']` and `['ultra-moon', 'moon']`. Not currently exercised since USUM uses encounter-tables.
- **BW/B2W2 seasons mostly missing** — only ~9 of 120 walking-data areas in `region/unova` carry `season-*` condition values. The renderer hides the season pill for any location whose fetched data has no season-tagged buckets.
- **Most of `region/unova` is dead** — 48+ locations have zero encounter data for BW versions. Rail driven only by the txt routes file.
- **Gen 2 super-rod inflated rates** — PokeAPI returns 5 ungrouped slot entries (Qwilfish 10+40+30+20+10 = 110%). Bypassed via pret-sourced encounter-tables.

## Other conventions

- **Filename spelling**: data files use `"Saphire"` (single P) for Ruby/Sapphire-related files (`Saphire.txt`, `RubySaphire.txt`). JS references match. Don't "correct" to `Sapphire` unless renaming.
- **Bundle key = file basename**: rename a file, the JS key changes. Update `GAMES[].dataSources` references accordingly.
- **PascalCase per version** for routes (`Black.txt`, `White.txt`); **combined per pair** for leagues + patches (`BlackWhite.txt`).
- **Game keys** in `GAMES` are snake_case (`red_blue`, `heart_gold_soul_silver`).
- **No "Pokémon" prefix** on game names in the dropdown.
- **SwSh letter convention**: `Sw` (Sword) and `Sh` (Shield) — two chars, NOT single letters. Other paired games still use single letters.
- **Don't edit text via PowerShell `Get-Content` + `Set-Content`** — it mangles UTF-8 characters like `…`, `—`, `'`, `é`. Use the Edit tool, or Node with explicit `'utf8'` encoding.

## Current state — games wired

**Vanilla (PokeAPI region path)**:
- Gen 1: Red/Blue, Yellow
- Gen 2: Gold/Silver, Crystal *(encounter-tables authoritative; PokeAPI is fallback)*
- Gen 3: Ruby/Saphire, Emerald, FireRed/LeafGreen
- Gen 4: Diamond/Pearl, Platinum, HeartGold/SoulSilver
- Gen 5: BW, B2W2 [Normal/Challenge variants] [hand-coded bosses + leagues enrichment]
- Gen 6: **XY** *(encounter-tables authoritative — PokemonEncCalc binary; PokeAPI fallback)*, ORAS
- Gen 7: Sun/Moon *(encounter-tables authoritative)*, USUM *(encounter-tables authoritative)*

Gen 2 + HGSS use multi-region PokeAPI (`['johto', 'kanto']`).

**Vanilla (encounter-tables path, authoritative)**:
- Gen 2: Gold, Silver, Crystal
- Gen 6: XY (PokemonEncCalc binary — new v5.3)
- Gen 7: Sun, Moon (SkyLink98 + pastebin); UltraSun, UltraMoon (SciresM gists)
- Gen 8: BDSP (TeamLumi); **SwSh** (Serebii scrape — new v5.3)

**Vanilla (NUZ_DATA-only path)**:
- Gen 9: Scarlet/Violet — PokeAPI's paldea has no location-areas; exclusivity hand-tagged in Scarlet.txt / Violet.txt

**ROM hacks (NUZ_DATA-only path, with patches)**:
- Blaze Black / Volt White
- Blaze Black 2 / Volt White 2 [Normal/Challenge variants]
- Radical Red [Normal/Hard variants]
- Unbound [Normal/Expert variants]
- Renegade Platinum
- Blazing Emerald, Emerald Kaizo, Emerald Run & Bun, Inclement Emerald
- Glazed (multi-region Emerald hack)
- Storm Silver / Sacred Gold (Drayano's HGSS hack)
- Rising Ruby / Sinking Sapphire (Drayano's ORAS hack)
- New Generations (Crystal hack)
- Insurgence (fan game)

## Variants

Some games ship multiple difficulty modes that share most data but differ on routes/trainers. Modeled as `variants: { letter: 'Label' }` sibling to `versions`. Picked at run-create time, switchable via a header pill, stored on the run as `run.variant`.

`dataSources.routes` (and leagues/patches/encounterTables) can be:
- a string: `'Yellow'`
- version-keyed: `{ R: 'Red', B: 'Blue' }`
- variant-keyed: `{ N: 'RadicalRed', H: 'RadicalRedHard' }`
- variant-outer + version-inner: `{ N: { B: 'Black2', W: 'White2' }, C: { B: 'Black2Challenge', W: 'White2Challenge' } }`

`resolveDataSource(srcConfig, game, ver, variant)` walks any of these shapes; `peelVariant(srcConfig, game, variant)` strips just the variant level.

## Tabs

- **Roster** — party strip (6 slots) + filter (by type) + sort dropdown (custom/level/name/type/recent) + bench grid. Pokémon detail modal has Edit / Evolve / Level Up / + Add to party (or × Remove) / Mark dead / Delete actions.
- **Active team** — drag-orderable party.
- **Boss matchup** — cap dropdown ✓ marks defeated bosses. Show-details toggle expands cards inline (sprite + BST + stat bars + moves + ability/item + best counter from your roster). `BOSS_NOTES` overlay enriches auto-derived bosses with mechanic-specific annotations (SM Trial Totems + Z-Crystal users, SwSh Dynamax/Gigantamax aces, SV Tera-type aces).
- **Encounters** — left rail location list (trainer-only filtered out). Main panel: pool-based sections per method, each summing to ~100%. Day/Night tab inside Walking section for Gen 2/BDSP/SM/USUM; Morning tab additionally for Gen 2. Weather tab strip for SwSh Wild Area locations. Season pill for Gen 5 (only when current location has season-tagged data). Version pill in header. Variant pill for difficulty-mode games. Sub-zone labels when data carries them. Clicking a species opens an action menu: Caught (prefills add-Pokémon form) / Skipped (dupe) / Missed / **Details** (types + stats + matchups, helps avoid 1-shotting during catches) / Cancel.
- **Route log** — chronological encounter log per route.
- **Graveyard** — fallen Pokémon.
- **Stats** — counts, type distribution, death-cause breakdown, per-route catch rate (red/amber/green pips), run timeline.
- **Rules** — master "Nuzlocke Mode" toggle. ignoreCapForMatchups + dupesClause/speciesClause wired; shinyClause + noLegendaries stored only. Free-form notes.

## Mobile breakpoints

- **900px** (iPad portrait): encounter rail capped, boss detail single-col.
- **600px** (phone landscape): header un-stickies, tabs take `top:0` sticky slot, smaller chrome.
- **420px** (phone portrait): single-col grids, hide rare buttons, smaller party strip. Switch save button compresses to `🚪 Switch` (was previously `display: none` with a TODO that never landed — restored in v5.3).
- Touch (`@media (hover: none), (pointer: coarse)`): party-strip remove-X always visible (was hover-only), drag handles hidden, hold-to-drag delay 250ms.

## In-flight ideas / open work

- **Persist PokeAPI backfill to localStorage** with 30-day TTL — second sessions would be instant. (Learnset cache already does this.)
- **Shiny clause wiring**: add `isShiny` flag, surface in encounter view.
- **No-legendaries wiring**: grab `is_legendary` from `/pokemon-species/<slug>`, mark in encounter rail.
- **Hand-coded `bosses` arrays for XY / ORAS** — currently auto-derived. Megas already show via the `item` field so curated notes would mostly be cosmetic. Low priority.
- **Sinnoh conditional-encounters audit** (PokeAPI path): radar/swarm/slot2 variants on D/P/Pt routes inflate by 60-90% over baseline. Bucket-key already includes `condTag`; would need UI to expose the conditional toggle.
- **Deferred from v5.3 audit**:
  - Gen 2 Burned Tower B1F missing Weezing 1%. Bulbapedia-verified. Needs `pret/pokegold` source + `gen2-convert.mjs` re-run.
  - XY Santalune Forest missing Metapod 4%. PokemonEncCalc binary disagrees with Bulbapedia. Needs re-inspecting `AngefloSH/PokemonEncCalc`'s binary data files.

## Bundler operations

```bash
# From runeshift/ root (where build-data.mjs lives):
node build-data.mjs
# Should print: "wrote ...data.bundle.js (~6.2 MB)"
# route files: 65, league files: 32, patch files: 14, encounter-table files: 13
```

If Node isn't on PATH after install, open a fresh PowerShell session — Windows doesn't refresh PATH in existing shells.

## Hosting + deploy workflow

GitHub Pages serves `mcollins189/runeshift` main branch root. Custom domain `pokenuztracker.runeshift.xyz` (CNAME at repo root, 28 bytes, content: `pokenuztracker.runeshift.xyz`). Production URL is `https://pokenuztracker.runeshift.xyz/log.html`. Pages serves the static files including `data.bundle.js` (gzipped ~500KB over the wire from ~6.2MB raw).

The user uploads files **manually** via the GitHub web UI (no git remote configured in local clones). The pattern when staging a batch of files for upload is to create `_to-upload/` mirroring the repo's target paths — the folder is auto-excluded by `.gitignore` (`_*/` pattern). **Always wipe `_to-upload/` at the start of a new batch** so it contains only the current changes.

**Important**: deploys go to the **repo ROOT** (not to a `v5.x/` subdirectory). The deploy structure is flat:
```
runeshift/
├── CNAME
├── log.html
├── data.bundle.js
└── nuzlocke data sets for unique cases/
```

So `_to-upload/` should mirror that flat structure too:
```
_to-upload/
├── log.html
├── data.bundle.js
└── nuzlocke data sets for unique cases/...
```

Minimum files for a logic change to go live: `log.html` + `data.bundle.js`. If data files (`routes/`, `leagues/`, `patches/`, `encounter-tables/`) changed, mirror those too so anyone rebuilding the bundle gets consistent results.

GitHub web UI converts LF → CRLF on upload, so a freshly-pulled `data.bundle.js` will be 3 bytes larger than a locally-built one (3 line endings × +1 byte for CR). Content is identical after stripping CR.

## When debugging

- **"Encounter rates look wrong"** → PokeAPI path: check `chanceBy` map (area-sum + cross-bucket-max). Encounter-tables path: verify slot probabilities (Gen 2 grass `[30,30,20,10,5,4,1]`, Gen 4 grass `[20,20,10,10,10,10,5,5,4,4,1,1]`, surf `[60,30,5,4,1]`, all BDSP rods `[40,25,25,5,5]`, XY grass `[10,10,10,10,10,10,10,10,10,5,4,1]`).
- **"Version-exclusive badge wrong"** → PokeAPI path: check `derivePoolsFromMethods` letters set (should track ALL versions, only chance gated by current ver). Encounter-tables path: check the cross-version merge key (`${mapId}#${tableN}#${method}#${subZone||''}` — NO lvMin/lvMax). SV path: check `Scarlet.txt` / `Violet.txt` per-file presence of the species (exclusivity is by file presence, not by tag).
- **"Sub-zone showing as A/B/C"** → check encounter-tables `Map:` headers. If no parenthetical, parser has no sub-zone. SM/USUM dumps carry them; Gen 2 converter derives from camelCase mapNames; BDSP needs `_converters/bdsp-subzone-labels.mjs` re-run; XY/SwSh emit them already.
- **"SwSh weather tab missing"** → location only has one weather variant, so the tab strip self-hides. Check `extractWeather()` returns non-null for the location's `pool.subZone` values.
- **"Boss missing from cap dropdown"** → trainer's `battleType` in routes file is `evil-team` / `rival` / `event-boss` / `titan` (all excluded). Or trainer-key isn't in routes file (strict filter drops). Or rematch hidden by lowest-cap dedupe.
- **"Sprite missing"** → species not in `POKEMON_DB` AND backfill hasn't fired, OR PokeAPI returned 404 (fakemon). Check `backfilledPokemon[slug]` in console.
- **"Existing save's logged dots gone after deploy"** → typo'd location string in saved data doesn't match new rail name. Add the substring rewrite to `LEGACY_LOCATION_NAME_SUBSTRINGS`.
- **"After rename, app shows empty data"** → `data.bundle.js` stale. Re-run `node build-data.mjs`.
- **"SwSh run version letter mismatch"** → run.version is `S` or `H`? Run `migrateLegacyGameKeys` (should auto-fire on load). Should be `Sw` or `Sh`.
- **"BDSP mojibake (Ã©, â€™)"** → don't edit txt files via PowerShell `Get-Content` + `Set-Content`. Use Edit tool or Node with explicit `'utf8'`.
- **"Evo move greyed out as already-learned"** → check `fetchLearnset` returned `isEvo: true` for it. The L0 detection cross-references modern VGs; if the species has no Gen 7+ data, evo moves can't be detected. Cache key bumped `learnset_v2_` to invalidate stale entries.

## Previous work history

### v5 → v5.1 (archived for context)

1. Alola grass sub-method classifier (SM / USUM)
2. BDSP sub-zone labels (`_converters/bdsp-subzone-labels.mjs`)
3. Duplicate sub-zone disambiguation (A/B/C/D suffix)
4. Typo audit + fixes (`Valley Windoworks → Windworks`, `Virdian → Viridian`, `Pokémon Tower` accent in Yellow, `Weat Province (A1) → West`)
5. HGSS mini-boss pruning (Elder Li / Eusine / Kimono Girls → `event-boss`)
6. Dead code removal (`BDSP_ENCOUNTERS` const, `renderEncountersBDSP` — replaced by encounter-tables path)
7. `BOSS_NOTES` overlay (46 hand-curated notes for SM Trial Totems / SwSh Dynamax / SV Tera-types)
8. PokeAPI multi-floor rendering fix (`buildEncounterMain` now overlays `richData.areas` AND `richData.methods`)
9. Evolution-line dupes (`getEvoChainSet` BFS-walks POKEMON_DB forward and backward)
10. Mobile / responsive polish (breakpoints 900/600/420)
11. Hold-to-drag everywhere (SortableJS, replaced by movement-threshold disambiguation in v5.3)
12. Card UX (party toggle button replacing checkbox)
13. Export / Import save + visibilitychange autosave
14. Modal close (×) button

### v5 audit pass (mainline games, 2026-05-18) — archived

Programmatic sweep of all mainline games. Fixed: `Valley Windoworks → Windworks` typo in 8 Sinnoh files + Renegade Plat; `Virdian City Gym → Viridian` in 6 Gen 2/HGSS files; `Pokemon Tower → Pokémon Tower` accent in Yellow; `Weat Province (A1) → West Province` in Scarlet+Violet; Mt. Coronet BDSP zone 215 re-tagged B1F (was 1F). Boss counts confirmed across all mainlines.

### v3 → v4 — archived

Multi-pass audit + fix. Built `audit-probe.mjs` / `audit-tables.mjs` / `audit-nuz-only.mjs` / `audit-crosscheck.mjs` (now under `audits/` at the old repo root). Identified 7 typos in routes files. Name normalizer + alias map + multi-floor merge + multi-region. Gen 2 encounter-tables (pret-sourced). SM encounter-tables (public dumps). SM/USUM method classification. Boss derivation cleanup. Sub-zone labels. Save-data migration.

If picking this up: read `!old/audit-report.md` for the v3→v4 findings. Most `_converters/` scripts are idempotent. Always run `node build-data.mjs` after any data file edit before testing.
