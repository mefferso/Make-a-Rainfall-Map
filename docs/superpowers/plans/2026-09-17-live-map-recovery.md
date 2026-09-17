# Live Map Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the deployed LA–MS rainfall map by fixing the proven Leaflet startup exception, then prevent a deploy from succeeding when the runtime cannot initialize.

**Architecture:** Keep the existing static GitHub Pages application and its runtime wrapper. Exercise the wrapper with a small Leaflet-compatible test double that reproduces Leaflet's `subdomains.length` access, make the one-line option fix, and strengthen the Pages workflow with a post-deployment headless-browser smoke check.

**Tech Stack:** Static HTML/CSS/ES modules, Leaflet 1.9.4, Node.js built-in test runner, GitHub Actions/GitHub Pages, headless Chrome.

**Spec:** User request in the 2026-09-17 Work conversation.

## Global Constraints

- Diagnose the deployed browser failure before editing.
- Keep the existing architecture and lean meteorologist-focused UI.
- Keep the map focused on Louisiana and Mississippi.
- Do not add API keys.
- Verify a real rainfall range on the deployed site after deployment.

---

### Task 1: Executable Leaflet Runtime Regression

**Files:**
- Modify: `tests/smoke.test.mjs`

**Interfaces:**
- Consumes: `map-runtime.js` and a Leaflet-compatible `window.L` test double.
- Produces: A test that fails when the OSM replacement passes an invalid `subdomains` value to Leaflet.

- [ ] **Step 1: Write the failing test**

Add a test that imports a temporary copy of `map-runtime.js` without its final `app.js` import, calls the patched `L.tileLayer` with the CARTO URL/options used by `app.js`, and has the fake Leaflet implementation evaluate `options.subdomains.length` exactly as Leaflet does.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --test-name-pattern="runtime replacement" tests/smoke.test.mjs`

Expected: FAIL with `Cannot read properties of undefined (reading 'length')`.

- [ ] **Step 3: Keep the test isolated**

Restore `window`, `requestAnimationFrame`, and the temporary module state after the assertion so the test has no global leakage.

### Task 2: Minimal Runtime Fix

**Files:**
- Modify: `map-runtime.js`

**Interfaces:**
- Consumes: CARTO tile-layer calls from `app.js`.
- Produces: A keyless OSM tile layer with a valid Leaflet options object.

- [ ] **Step 1: Remove the invalid override**

Delete only:

```js
subdomains: undefined,
```

The spread `options` already carries Leaflet's valid string value, and the replacement URL has no `{s}` token.

- [ ] **Step 2: Run the focused test and verify GREEN**

Run: `node --test --test-name-pattern="runtime replacement" tests/smoke.test.mjs`

Expected: PASS.

- [ ] **Step 3: Run the full suite**

Run: `npm test`

Expected: All tests pass with zero failures.

### Task 3: Post-Deployment Browser Gate

**Files:**
- Modify: `.github/workflows/pages.yml`

**Interfaces:**
- Consumes: `${{ steps.deployment.outputs.page_url }}` from GitHub Pages deployment.
- Produces: A failed workflow when the live DOM never receives initialized dates or an OSM tile.

- [ ] **Step 1: Add a post-deploy Chrome smoke step**

After `actions/deploy-pages`, load the cache-busted live URL with the runner's Chrome in headless mode and save the rendered DOM.

- [ ] **Step 2: Assert runtime behavior**

Require the rendered DOM to contain a non-empty ISO `value` for `#start-date`, a non-empty ISO `value` for `#end-date`, and at least one `tile.openstreetmap.org` image. Print the DOM on failure.

- [ ] **Step 3: Validate workflow syntax and rerun unit tests**

Parse the YAML locally, then run `npm test` again.

### Task 4: Deploy and Verify the Real Application

**Files:**
- No additional source files.

**Interfaces:**
- Consumes: the new commit on `main` and GitHub Pages workflow.
- Produces: verified live basemap, TIGER boundaries, initialized dates, and a rendered rainfall overlay.

- [ ] **Step 1: Commit the tested changes to `main`**

Use one atomic GitHub commit so Pages deploys a single known tree.

- [ ] **Step 2: Monitor the Pages run**

Inspect every workflow job and log; do not treat workflow success alone as acceptance.

- [ ] **Step 3: Reopen the public URL in the browser**

Verify no console exception, initialized dates, visible OSM tiles, and LA/MS boundary overlays.

- [ ] **Step 4: Generate a real rainfall map**

Use a known available one-day Stage IV range, submit the form, wait for completion, and verify the colored rainfall overlay, maximum value, hover value, enabled PNG download, and successful NOAA/Census requests.

- [ ] **Step 5: Compare the deployed files to the committed files**

Confirm `index.html`, `map-runtime.js`, `app.js`, and `styles.css` hashes match the committed tree.
