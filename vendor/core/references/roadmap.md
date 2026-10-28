# Roadmap: Chinese feature + API station maps

Use `roadmap` for 功能梳理、路线图、API 说明、F1/A1. It uses the bundled api-sheji/Dataiyi template, not the original five-type viewer. Read `schemas/roadmap.schema.json` and `examples/apitu-plugin.roadmap.json` before authoring.

## Authoring contract

- `schema_version: 1`; `meta` requires `title`, `eyebrow`, `description`, `checked_at` (`YYYY-MM-DD`), and `runtime_flags`. State the date actually checked and distinguish disk implementation from loaded runtime. Never copy an example's date or inventory as a verified fact.
- Required `flow` and `api` maps have `title`, `stations` (2–24), and `routes` (1–48). IDs are map-local; badges F1…/A1… follow array order. Each station requires `id`, `label`, `subtitle`, `description`, and `kind` (`auto`, `manual`, `gap`). Keep semantics factual.
- Coordinates `x`/`y` are optional as a pair. Omit them for deterministic placement. Optional `role` is source/pipeline/hub/consume/extra/secondary. API stations/routes may use `api_group` for filters.
- Routes require `from`, `to`, `kind`, `color` (gold/jade/coral); API routes are auto only. Flow manual routes must be jade and static; gap routes are static dashed. Automatic flow routes and API routes animate packet lights. Optional cubic `curve` and `label_position` override placement; invalid, colliding or out-of-bounds geometry fails visibly.
- Required arrays: `rules`, `consumption`, `lifecycle`, `pages_commands` contain title/description entries (optional command only for pages_commands); `boundaries` contains factual strings. Empty table arrays explicitly say no facts were supplied; do not invent them.
- Optional `meta.output` is a portable relative `.html` path. Unknown fields, duplicate IDs, missing references, invalid dates and unsupported geometry are errors. No legacy cards/meta fields.

## CLI and delivery

```sh
node bin/apitu.mjs validate roadmap candidate.json --json
node bin/apitu.mjs validate roadmap candidate.json --layout-json
node bin/apitu.mjs inspect roadmap candidate.json
node bin/apitu.mjs finalize roadmap candidate.json new-diagram.html --json
node bin/apitu.mjs browser-check new-diagram.html --require-provenance --json
node bin/apitu.mjs preview roadmap candidate.json new-preview.html --no-open
```

Roadmap always reports `roadmap-v1`, even when a generic caller supplies standard/showcase. It supports render, validate, inspect, deliver, finalize, check, browser-check, preview, guide, examples and doctor. Compare remains architecture-only; migrate remains workflow-only. DSH outputs must be absent and every repair gets a new HTML/evidence path. Atomic publication, receipt identity, candidate binding, provenance, trusted session policy and failed-preview history are retained.

## Actual template behavior and acceptance

The Chinese single file has two SVGs (1180×620 feature / 1180×560 API), gold/jade/coral stations, numbered badges and indices, clickable descriptions, filters, animated packets, wheel zoom, drag pan and button/double-click reset. It loads no external assets. At narrow widths the original template keeps a 650px minimum SVG width, so only part of the map is visible initially; drag to inspect other parts and use a wheel to zoom for full-map/label reading. There are no pinch-zoom gestures or +/- zoom buttons. Descriptions and tables remain normal flowing text. A 390px mouse/DOM-event viewport check is not a real-phone touch acceptance claim.

`roadmap-v1` checks exact bundled CSS/script, dual-map viewBoxes, IDs/dictionary coverage, route kinds/styles, numbering, required Chinese sections/date/footer and offline references. Real isolated Chrome checks desktop 1440×1000 and mobile 390×844: map bounds, actual SVG/text geometry, document horizontal containment, readable station hints, each station click (DOM event dispatch explicitly recorded), filters and dimmed routes, packet movement (not-applicable for all-static flow routes), wheel zoom, pan, button/double-click reset, and absence of console/runtime errors or HTTP(S) requests. The browser receipt's `roadmap` section contains this evidence; original viewer containment/theme/readability/viewerChrome fields are **not-applicable**, not fabricated passes.

There is no legacy theme toggle, search, presentation or PNG/SVG/WebM viewer export. Legacy `visual-check` screenshot/contact-sheet gates are unsupported and fail explicitly; use roadmap `browser-check` for interaction evidence, then actual screenshots for a separately requested human visual review. Automated gates do not constitute human visual approval.
