# AGENTS.md

## 1. Project identity

This repository is **OnePic Template Studio / 一图万式**, a standalone single-reference-image prompt template library.

It is not a fork, skin, patch set, or deployment variant of the upstream prompt gallery. Do not add upstream-derived application code, APIs, billing, authentication, databases, analytics, branding, or UI components to this repository. First-party server-side work is governed by the approved backend boundary in section 11.

## 2. Non-negotiable source boundary

The upstream ZIP is a read-only import source.

Allowed:

- Read canonical prompt data from `data/cases.json` inside the ZIP.
- Read framework prompt blocks from `docs/templates.md` inside the ZIP.
- Read source images only to create reduced preview thumbnails.
- Preserve source author, URL, repository, and MIT notice.

Forbidden:

- Modify the upstream ZIP.
- Extract and reuse upstream application source code.
- Patch files inside an unpacked upstream repository.
- Reuse upstream project branding, payment logic, account logic, API code, or page layout.
- Present this project as the upstream project or an official derivative service.

The import process must remain deterministic and read-only. Any task that would alter the source archive must be rejected and redesigned.

## 3. Product behavior

Every public template must be usable with exactly one uploaded image and no required text input.

The compiled prompt hierarchy is mandatory:

1. Uploaded image controls content.
2. Template blueprint controls visual treatment.
3. OnePic common rules override conflicting legacy instructions.

Public prompts must:

- Start with `[System / Prompt]`.
- State that the user may upload only one image.
- Prohibit follow-up questions.
- Preserve the source image aspect ratio and orientation.
- Treat all legacy placeholders as automatic fields.
- Prevent sample subjects, brands, places, slogans, and fixed text from replacing the uploaded image.
- Contain `BEGIN VISUAL BLUEPRINT` and `END VISUAL BLUEPRINT` delimiters.
- Return only the finished image.
- Mention Nano Banana Pro as the preferred rendering mode when available.

Do not introduce new user-fill variables into compiled prompts.

## 4. Architecture

The repository has four boundaries:

### Source archive boundary

`data/source/`

Contains canonical data extracted from the upstream ZIP and the import manifest. Treat as generated provenance data. Do not edit source prompt text manually.

### Prompt compiler boundary

`scripts/prompt_protocol.py` and `scripts/build_library.py`

Owns common rules, category adapters, mode detection, text behavior, and prompt compilation. Changes here affect every public prompt and require full validation.

### Public catalog boundary

`public/data/catalog.json`, `public/data/prompts/`, and `public/previews/`

Generated assets consumed by the static web interface. Do not edit generated files manually.

### Presentation boundary

`public/index.html` and `public/assets/`

Independent static interface. No framework dependency is required. Keep it accessible, responsive, and deployable as static files. Third-party runtime libraries (anime.js) are vendored under `public/assets/vendor/`; never load them from a CDN.

## 5. Generated files

Never hand-edit:

- `data/library/templates.json`
- `public/data/catalog.json`
- `public/data/stats.json`
- `public/data/prompts/*.txt`
- `public/previews/*.webp`

Regenerate them using the scripts.

## 6. Prompt compiler changes

When modifying prompt rules:

1. Change `scripts/prompt_protocol.py`.
2. Run `python3 scripts/build_library.py`.
3. Run `python3 scripts/validate_library.py`.
4. Run the test suite.
5. Inspect at least one template from each category.
6. Inspect the longest prompt (`case-532`) and one framework prompt.

Category adapters must never hallucinate facts. In particular:

- Infographics may use only observable information.
- Product templates may not invent prices or product claims.
- Beauty templates may not make medical diagnoses.
- Brand templates may not copy sample trademarks.
- UI templates may not clone a real platform pixel-for-pixel.
- Historical templates must avoid incoherent period mixing.

## 7. UI conventions

- Use semantic HTML and accessible labels.
- Preserve keyboard access to cards, filters, dialog, copy, download, and favorite controls.
- Avoid external fonts, analytics, trackers, and runtime CDN dependencies.
- Lazy-load preview images.
- Keep catalog metadata separate from full prompt TXT files so the initial payload remains reasonable.
- Do not load all prompt bodies at startup.
- Store favorites and generation credentials only in localStorage.
- No telemetry or analytics. The approved backend boundary (section 11) permits a controlled server side; outside that scope, uploaded images and prompts may only travel directly to the user-configured BYOK endpoint when the user explicitly triggers generation. Never add an implicit upload path, arbitrary baseUrl forwarding, payment, membership, or team systems.

## 8. Data and naming

Template IDs:

- `case-<upstream numeric id>` for case blueprints.
- `framework-<three-digit sequence>` for framework prompt blocks.

Do not renumber existing IDs. New source prompts must receive stable IDs.

Source fields must remain traceable. Do not remove upstream author or source URL merely to make the project look more original; project independence comes from architecture and compilation, not from deleting attribution.

## 9. Commands

```bash
npm run dev
npm run build
npm run validate
npm run test
npm run check
```

Reimport from a ZIP:

```bash
python3 scripts/import_source.py /absolute/path/to/source.zip
python3 scripts/build_library.py
python3 scripts/validate_library.py
```

## 10. Acceptance checklist

A change is complete only when:

- The upstream archive remains unchanged.
- The project contains exactly the expected number of templates.
- All prompt IDs are unique.
- All generated prompt files match the full library.
- All case previews exist and are non-empty.
- All required prompt sections are present.
- `node --check public/assets/app.js` and `node --check public/assets/fx.js` pass.
- Python files compile.
- Unit tests pass.
- The static site loads through `scripts/serve.py`.
- `NOTICE.md` and the third-party license remain present.

## 11. Approved backend boundary (2026-09-06)

The user explicitly approved ("我全部批准", recorded in `docs/adr/0003-backend-boundary-approval.md`) a controlled first-party backend within this scope:

- Modular monolith HTTPS API/BFF plus an independent Worker; no microservices, Redis, external message broker, or Kubernetes.
- PostgreSQL for metadata and the job table (the PG job table is the phase-one queue).
- S3-compatible private object storage; no public ACLs; short-lived signed URLs.
- Trusted OIDC (authorization code + PKCE) with server-side opaque sessions; managed-generation mode must refuse to start without a configured identity source.
- Object-level authorization, quota/rate/concurrency limits, unified errors and audit events.
- Managed generation sends images and prompts only to allowlisted providers after an explicit user trigger; provider keys are injected into the Worker from a secret manager or managed key file; arbitrary baseUrl forwarding is forbidden.

Still forbidden without separate per-action authorization: commit, push, deploy, paid provider calls, production migration; payment, membership, team systems; telemetry/analytics; upstream branding or application code; modifying the source archive. Static catalog-only and direct-BYOK modes must remain fully usable, and browser-stored BYOK keys must never be migrated or forwarded to the server.
