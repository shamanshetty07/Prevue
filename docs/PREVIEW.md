# Browser preview (read-only, with selection)

Status: implemented and tested. It shows the **current registered design** of one project in a browser, and (Phase 2b) lets the developer click a component and read its properties in an inspector. It is a viewer: it cannot register, approve, reset or edit anything, and approval still happens only through the developer's `prevue approve <hash>` in Claude Code. Drag-and-drop, property editing, undo and any approval UI are not built.

## Use

```bash
cd preview && npm ci && npm run build          # once: builds preview/dist
cd ../server && npm run build                  # the CLI runs from server/dist
CLAUDE_PLUGIN_DATA=<absolute plugin data dir> node server/dist/src/cli.js preview [projectDir] [--port N]
```

It prints `http://127.0.0.1:<port>/#token=<token>` and keeps running until Ctrl+C. Open that exact URL. The page reads the token from the fragment once, keeps it in the tab's `sessionStorage`, and clears the fragment. The project is the argument (default: the working directory); the data directory is `CLAUDE_PLUGIN_DATA`, which must be absolute (same rule as the other state commands). Exit codes: `0` stopped by signal, `2` the app is not built, `64` usage or configuration. Development with hot reload: run `preview` as above, then `PREVUE_PREVIEW_URL=http://127.0.0.1:<port> npm run dev` in `preview/` and open the Vite URL with the same `#token=...`.

The toolbar shows the design name, revision, the first 12 characters of the hash and `Pending approval` / `Approved`, with Desktop (1200 px), Tablet (820 px) and Mobile (390 px) selectors. The page polls every 3 seconds (paused while the tab is hidden), so a revision registered by Claude appears without reloading.

## Architecture

- **`preview/src/render/`**, the renderer, independent of the gate and of registration:
  - `guard.ts` re-checks any value it is given: iterative raw depth/size guard, then the server's own strict Zod schema (`server/src/spec/schema.ts`, imported so there is one source of truth), then the component-count and nesting limits. It returns the parsed, normalized value, which is what gets rendered.
  - `registry.tsx` is the explicit component registry, one renderer per schema type (`stack`, `grid`, `text`, `button`, `stat-card`, `table`), plus the `header` and `sidebar` slots in `SpecView.tsx`. A `satisfies` clause makes the compiler reject a schema type with no renderer, and lookup is an own-property check.
  - `tokens.ts` turns tokens into class names from fixed tables; `icons.tsx` holds the eight inline icons. Styles live in `styles.css`, driven by those classes and by container queries, so the viewport selector and a narrow window behave the same.
  - Rendering is a pure function of the normalized spec: no state, effects, randomness or ids.
  - `paths.ts` defines structural paths, the editor's identity for a node (see **Selection**).
  - `selection.ts` is the one pure function, `nextSelection(prev, event, spec)`, through which every selection change goes (pick, Escape, a new design, a failed load), so the transitions are unit-tested rather than living only in the React component.
- **`preview/src/inspector/`**: `inspect.ts` builds the inspector's rows from the selected node; `Inspector.tsx` is the panel and the outline.
- **`preview/src/App.tsx`, `api.ts`**: toolbar, viewport selector, loading and error states, selection state, and the one same-origin `GET /api/design` call.
- **`server/src/preview-api.ts`**: `loadCurrentDesign(dataDir, projectDir)`. Reads the state with `load`, requires the `canonical` marker, and reads the design through `readDesignFile` in `design-store.ts`, the same reader the gate's verification uses (symlink and file-type checks, `O_NOFOLLOW`, 64 KB cap, strict UTF-8, full validation including duplicate keys, normalized hash equal to the file name and the state's hash). The result carries a code and a fixed message on failure; never a path, parser output or file content.
- **`server/src/preview-server.ts`, `preview-cli.ts`**: the HTTP server and the `preview` command.

## How the design is loaded, and the trust boundary

The browser never names a file, hash or revision. The server is started with one project and one data directory, resolves the design itself from the state, and returns the specification the state points at, after the gate's integrity checks. Whatever it returns, the renderer validates again.

A local HTTP server on 127.0.0.1 is **not authenticated by being on localhost**: any local web page the user visits can send requests to it, and a hostile site can try DNS rebinding. So:

- Host must be exactly `127.0.0.1:<port>` or `localhost:<port>` (refuses rebinding); a request with an `Origin` must be that same origin.
- `/api/design` additionally needs the random per-launch token (24 random bytes, constant-time compare) in the `X-Prevue-Token` header. A token in the query string or a cookie is not accepted. The token is delivered in the URL fragment, which browsers do not send to the server or in a `Referer`.
- Only `GET` and `HEAD` exist. Every other method gets 405, and there is no route that registers, approves, resets, writes, or takes a path. Unknown paths get 404.
- Static files come from an exact allow-list built at startup (regular files only, no symlinks, known extensions, at most 200 files of 5 MB); nothing from a request is joined to a path.
- Responses carry `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; ...; frame-ancestors 'none'`, `nosniff`, `no-referrer`, `no-store`, and no CORS headers, so another origin cannot read them. The built page has no inline script.
- It does not defend against another process running as the same user, which can read the same files directly (outside the threat model, section 1 of `ENFORCEMENT.md`).
- The code cannot change state: a test asserts the three preview modules reference no state-changing function, import neither registration nor gate code, use no file-writing API, spawn nothing and read no environment variable. The `preview` command is a developer command: Claude cannot run it while the gate is PENDING (shell commands are not on the read-only list).

## What the renderer does with a specification

Renders every schema component with nesting and layout tokens preserved. Text only ever reaches the DOM as a React child, so it is escaped; buttons and navigation items are inert (no handler, not focusable, no link). Output contains no script, link, image, iframe, form, URL attribute, `style` attribute or event handler (a test parses the output and allows only listed elements and attributes). Anything the schema rejects (unknown component, extra property such as `href`, bad token, over any limit) renders an error panel and no partial UI.

No schema change was needed: the example specification and every component type render as specified. Limits of the format itself (not changed): one screen kind (`dashboard`), no images, charts or links, text only.

## Selection and the inspector (Phase 2b)

**Structural paths.** A node's identity is its position in the normalized specification, never its optional `id` (ids can be missing or repeated, and no schema change was made):

| path | node |
|---|---|
| `header` | the header slot |
| `header.actions.<i>` | the i-th header action (a button) |
| `sidebar` | the sidebar slot (its items are properties of the sidebar, not components) |
| `main` | the main region (gap, padding) |
| `main.<i>(.<j>)*` | the i-th component in main, then the j-th child of that container, and so on |

Indexes are canonical decimals (no sign, no leading zero), so each node has one spelling. The same specification always gives the same paths, whatever its key order or ids. `resolvePath` looks a path up in the validated specification using own array indexes only. Anything else (`__proto__`, `main.length`, an index past the end, a child of a leaf) resolves to nothing.

**Rendering.** `SpecView` takes an optional `selection`. Without it the markup is exactly the Phase 2a output. With it, each selectable element gets `data-pv-path` (built by the renderer from array positions, never from specification values), and the selected one gets `data-pv-selected="true"`. The highlight is a CSS outline, so it does not change layout. Nothing else about the rendered design changes.

**Event handling.** There is one delegated click listener on the preview frame and no per-node handlers. On click, `target.closest("[data-pv-path]")` starts at the clicked element and walks outwards, so the innermost component under the pointer wins. A click inside a nested component never resolves to an ancestor, and no `stopPropagation` is needed. The path from the DOM is re-checked (syntax, inside the frame, resolves in the current validated spec) before it is used. A click on the frame outside every component clears the selection.
- To reach a container that its children fully cover, use **Select parent**, a child or outline entry, or click the container's gap or padding.
- The rendered design stays non-focusable, as in Phase 2a. The keyboard route is the inspector's outline: every node is a button there, with a visible focus ring. `Esc` and **Clear selection** clear the selection.

**Inspector.** `inspect()` shows the selected node's type, path and parent, plus its schema properties grouped as Content, Layout, Style, Items, Columns, Data and Identity, and its child components. Each row names the schema property it came from and shows its validated value. Defaults filled in by validation show as filled, because that is what renders. Optional properties that are not set show as "not set". A table's rows are shown as a count. If several components share an `id`, the inspector says so. All text reaches the DOM as React children. The panel has no inputs.

**State.** The selection is one path in `App`'s React state, changed only through `nextSelection` (a test asserts `App.tsx` has no other way to set it). It is never sent to the server or stored. It is cleared when a different design (a new hash) arrives, because the same path may name a different node in another revision. A path that no longer resolves is treated as no selection. Selection adds no request and no route, and it does not touch the specification, the canonical design file, the hash, the revision or the approval state.

## Tested

- Selection, `cd preview && npm test` (10 tests in `test/select.test.tsx` and 6 in `test/selection.test.ts`, on top of the 19 renderer tests; 35 in total):
  - every selectable type is stamped once and marks only itself when selected;
  - clicks resolve to the innermost component, using a DOM tree parsed from the real rendered markup;
  - paths are deterministic (repeat, key order, round trip, ids);
  - duplicate and missing ids do not affect selection;
  - non-canonical or hostile paths are rejected;
  - the inspector updates when the selection changes and empties when it is cleared;
  - inspector rows equal the validated node's schema properties, with completeness both ways;
  - no mutation of deep-frozen specs, and no network or storage access in the selection code;
  - invalid specs are still rejected with selection on;
  - selectable output and the inspector pass element and attribute allow-lists with hostile text;
  - selection transitions (`selection.test.ts`): picking any node, forged, stale, malformed or out-of-design paths clearing the selection, Escape and a failed load clearing it, an unchanged poll keeping it, a new revision clearing it, purity, and `App.tsx` using only `nextSelection`.
- Renderer, `cd preview && npm test` (19 tests): every component type, nesting order, tokens, slots and icons, hostile text in every text position, an allow-list check of the output's elements and attributes, rejection of URL-bearing and unknown properties and of malformed specifications, every limit at its boundary and one past it, hostile depth and size, determinism (repeat, key order, round trip, no mutation), normalization.
- Server, in the backend suite (`server/test/preview.test.ts`, 15 tests): the loader's results and failure codes for each integrity failure, no writes while loading, the HTTP boundary (token, Host, Origin, methods, traversal, symlinks and dotfiles, headers, loopback binding), the static-source check, and the CLI command including a real start, a request, and shutdown.
- Browser smoke test with the real page in headless Chromium (not part of the automated suites; run by hand with the `browser-automation` skill): one session against a temporary data directory with the example design registered through `register-design`, all assertions below passed. Rendered content came from the registered JSON (title, three stat values, two table rows, the active nav item); the frame measured 1200 / 820 / 390 px for the three viewports with the grid reflowing from 3 columns to 1 on mobile and no horizontal overflow; the page had zero inline styles, links or images, and a single same-origin script; no CSP violation was logged; clicking an inert button changed nothing; `/api/design` without the token returned 401, POST returned 405 and `/api/approve` returned 404; opening the page without the token showed an error panel and no design; registering a different design from the CLI while the page was open updated it to revision 2 within the poll interval; corrupting the stored design file replaced the page with an error panel (HTTP 409) with no content leaked. Screenshots were read and looked correct. The page was not tested in any other browser.

- Phase 2b browser check, by hand in headless Chromium with the `browser-automation` skill against a scratch data directory: selection by clicking a stat-card value, a text, a table cell, the header action, a sidebar item and the grid's gap; outline click, Select parent, `Esc`, keyboard Enter on an outline entry, and Clear selection; the mobile layout (inspector below the frame, no horizontal overflow at 390 px). The selection survived an unchanged poll and was cleared when a new revision was registered. Zero console errors. The check was repeated after the selection transitions were moved into `selection.ts`, with identical results; in a real 390 px browser window the inspector sat below the frame with no horizontal overflow. The page made only `GET /api/design`. Other methods still returned 405 and unknown `/api/*` routes 404. The state and design files were byte-identical before and after the selection session.

## Limitations

- Not exercised: browsers other than the headless one used for the smoke test, a very long-running session, or a real interactive Claude Code session alongside the preview.
- The preview shows approval state but cannot change it, and it cannot tell who typed an approval in Claude Code (see `ENFORCEMENT.md`).
- Polling is a simple 3-second GET, not a push channel.
