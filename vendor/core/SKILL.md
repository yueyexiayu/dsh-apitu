---
name: apitu
description: "Create polished, validated architecture, workflow, sequence, data-flow, and lifecycle/state diagrams as explorable standalone HTML with inline SVG, dark/light themes, optional trace motion, and PNG/JPEG/WebP/SVG/WebM export. Accept plain-language requirements or pasted Mermaid flowchart, sequenceDiagram, and stateDiagram input; inspect repository evidence when the diagram must reflect real code. Use when the user asks to visualize system architecture, infrastructure, cloud/security/network topology, technical workflows, API call sequences, request lifecycles, data pipelines, ETL/ELT, data lineage, state machines, or to convert/beautify Mermaid. Also use for everyday subjects with steps, parts, relationships, or states: a leave or travel plan, an application or approval process, a back-and-forth such as renting, where money or documents go, or where an application or order stands. Not for numeric charts or dashboards."
license: MIT
metadata:
  version: "3.1"
---

# apitu

Create an interactive HTML diagram from typed JSON. Static output is the default; enable motion only when requested.

Run commands from your working directory. Unless the user names another location, give each new diagram request its own folder `.apitu/<type>-<slug>-<YYYYMMDD-HHMMSS>/` there (local time, chosen once when the request starts): keep `candidate.json` and `<slug>.html` in it and set `meta.output` to that relative HTML path. A later request gets a new folder, so earlier versions stay intact. Replace `bin/apitu.mjs` in the commands below with the installed package's absolute path, or its path relative to your working directory; input and output paths resolve from that working directory.

### DSH Host output and repair contract

When using the DSH `apitu` tool or sidebar, this adapter contract takes precedence over standalone CLI instructions about replacing an existing output. Each new invocation that publishes a diagram must use an absent HTML output; any explicit receipt target or `--out-dir` must also be absent. Read-only input paths used by `check`, `browser-check` or `visual-check` are not new HTML output targets. Keep prior artifacts and evidence; do not delete them to force a retry, and do not bypass a policy refusal by invoking the CLI separately.

After a failed gate or a placement/width review, rerun the full `finalize` against a new revision path, for example `<folder>/repair-2/diagram.html`. Update `meta.output` when the candidate uses it, discard an earlier `--candidate-sha256` after editing, and use new paths for any explicit `--receipt`/`--out-dir`. Changing only `--out-dir` is insufficient when the HTML already exists. Even an unchanged-candidate retry needs a new HTML target if the previous attempt created it. Preserve semantic content and repository evidence; rerun all automated gates. A running `preview` may refresh only the artifact it owns; starting another preview is a new invocation and needs a new target. `recover-output` is a separate explicit recovery operation, not a general overwrite/retry switch.

For a real codebase, read [Repository authoring](references/repository-authoring.md) while tracing the requested behavior. A system description uses the steps below; an existing JSON uses the handoff path.

## Existing candidate handoff

When the user supplies a frozen candidate, run `finalize` first as one CLI invocation. Its passing receipt completes the automated gates; follow any visual review recommendation under Delivery before claiming visual quality. For repair, follow step 5.

## Fast authoring path

Use this path for ordinary generation. Read branch references only when their stated trigger applies.

1. Choose `roadmap`, `architecture`, `workflow`, `sequence`, `dataflow`, or `lifecycle` from the question. For 功能梳理、API 说明、F1/A1 station maps, use `roadmap` and read [Roadmap contract](references/roadmap.md) first. Roadmap is the bundled Chinese dual-map template, not the legacy theme/search/export viewer.
2. Use the exact schema and example paths in the Type router without listing their directories. Read [Authoring defaults](references/authoring-defaults.md) and the mode's example in a bounded batch separate from project documents and complete schemas so neither is truncated; recover any missing section before writing. For Architecture, use the matching showcase example. For Sequence, Dataflow, and Lifecycle, also read the mode and common schemas. Read the relevant schema definition before choosing any new field, enum, or constrained text, especially boundary kinds. Examples teach shape, not facts. Use fresh IDs, wording, and layout. Go directly to the candidate without preliminary help, doctor, starter validation, temporary diagrams, or output-path listing. Query brands only for an explicitly requested mark; read [Brand marks](references/brand-marks.md) for an unknown mark with a user-provided URL.
3. Once the requested scope and, for a real codebase, [source evidence](references/repository-authoring.md) are covered, write the complete candidate directly without planning coordinates in prose. Choose Architecture abstraction and connected placement using Authoring defaults before coordinates: show the main user journey and necessary branches, preserve control roles and behavior-changing conditions, and leave enough room for actual relationship labels. No node, relationship, source, view, card, or boundary count is a target or ceiling. Use automatic routes first; add explicit routing only for necessary branch, return, supplied geometry, or measured repair. Set `meta.quality_profile` to `"showcase"` unless the user requests dense `standard`.
4. Once the complete first candidate is written, run `finalize` directly. Its first gate is showcase validation; successful first drafts need no separate pre-validation. Keep the candidate unchanged while the command runs:

   ```bash
   node bin/apitu.mjs finalize <type> <candidate.json> <output.html> --quality showcase --json
   ```

   For a repository-backed candidate, include evidence on the first draft and use the complete first command: `node bin/apitu.mjs finalize <type> <candidate.json> <output.html> --repo-root <repo-root> --quality showcase --json`.

   A passing receipt proves the included `validate`, `deliver`, strict `check`, and real-browser `browser-check` gates passed. Use its compact summary; run standalone commands only for a separate request or focused failure diagnosis.

5. A non-zero exit is never success. Read compact stdout or `evidence.summaryReceipt`, then [repair the failed gate](references/delivery-contract.md#failed-finalize-and-candidate-repair), including its repair limit. Preserve requested meaning and source evidence. For several tangled Architecture routes, read [Architecture layout repair](references/architecture-layout-repair.md); for measured field or geometry failures, read [Authoring contract](references/authoring-contract.md). Edit the connected neighborhood and rerun the complete `finalize` command from step 4. In DSH, follow the Host contract above: select a new HTML revision path and new explicit receipt/evidence paths, not the previous command's occupied output.

Before the first candidate, use the authoring references and relevant repository source, not apitu implementation or tests. Inspect apitu implementation if diagnostics remain unactionable after focused repairs.

## Type router

| Type | Use for | Schema | Example |
|---|---|---|---|
| `architecture` | Components, services, cloud/security boundaries, infrastructure; what something everyday is made of | `schemas/architecture.schema.json` | System descriptions, services, libraries, and CLI repos: `examples/web-app.architecture.json`; deployment repos: `examples/production-deployment.architecture.json` |
| `workflow` | Processes, approval gates, tool calls, runbooks, CI/CD; plans and step-by-step life processes | `schemas/workflow.schema.json` | `examples/agent-tool-call.workflow.json` |
| `sequence` | API call chains, request lifecycles, async traces, returns; back-and-forth between people | `schemas/sequence.schema.json` | `examples/cache-miss-request.sequence.json` |
| `dataflow` | Pipelines, ETL/ELT, lineage, governance, consumers; where money or documents go | `schemas/dataflow.schema.json` | `examples/product-analytics.dataflow.json` |
| `roadmap` | Chinese feature/API station maps, 功能梳理、API 说明、F1/A1 | `schemas/roadmap.schema.json` | `examples/apitu-plugin.roadmap.json` |
| `lifecycle` | State/status transitions, retries, waiting and terminal states; where an application or order stands | `schemas/lifecycle.schema.json` | `examples/deployment-release.lifecycle.json` |

When ambiguous, run `node bin/apitu.mjs guide "<scenario>" --json`. Scenario proof examples are structural references, not facts to copy.

For an everyday subject, keep the same five modes and semantic types, then name them for the reader: use everyday `icon` values and `meta.legend` labels as in [Node icons](references/authoring-contract.md#node-icons). Ask for missing personal facts instead of inventing dates, amounts, or rules.

## Mermaid input

Read Mermaid for topology and meaning, then author fresh apitu JSON; do not mechanically render Mermaid styling.

- `flowchart` / `graph` → `workflow`, or `architecture` for a component map.
- `sequenceDiagram` → `sequence`; participants become semantic participants and arrows become messages.
- `stateDiagram` → `lifecycle`; states and transitions retain meaning, not Mermaid style.

## Delivery

Use the `finalize` command above for the first candidate and after a repair.

`finalize` stops at the first non-passing gate. Its compact stdout and `<output-stem>.finalize-summary.json` are ordinary evidence. A passing run creates no screenshots and reports `visualReview: "not-requested"`.

When a passing Architecture receipt reports `visualReviewRecommendation.signals.resolvedCrossovers`, copy the candidate aside and apply the hints in one edit that changes only node positions and sizes: every node, relationship (including its `from` and `to`), label, and source stays as it was. Rerun the complete `finalize` once. In DSH, use new HTML `<folder>/review-2/diagram.html`, align `meta.output`, and use new explicit receipt/evidence paths as described above. A standalone CLI replacement uses `--out-dir <folder>/review-2` to preserve browser evidence. If the run fails or reports more crossings, restore the copy and finalize it at the next new revision (`review-3` in DSH, with matching `meta.output`). Do not start a second placement round. Hints about extra bends alone are optional.

When `layoutReviewRecommendation.action` is `inspect-sequence-width`, follow [Sequence width review](references/delivery-contract.md#sequence-width-review) before handing off a newly authored Sequence.

Perceptual review is optional for ordinary generation, including a newly positioned Architecture. Use [Optional capture evidence](references/delivery-contract.md#optional-capture-evidence), with `--out-dir <folder>/visual-check`, when the user requests visual review, during development audits, or for a concrete route/browser concern. `visualReviewRecommendation` is advisory. Inspect captures before claiming visual quality; otherwise report automated checks only.

Read [Delivery contract](references/delivery-contract.md) for failed gates, standalone commands, provenance/recovery, repeated delivery, exports, or opening. Recovery follows `deliver` → strict provenance `check` → `browser-check`; captures require strict provenance.

For workflow viewport overflow, read [Workflow viewport repair](references/authoring-contract.md#workflow-viewport-repair) before the next layout edit.

Report artifact checks, browser evidence, captures, and actual perceptual review as distinct results. For an explicitly requested immediate preview or active desktop loop, see [Optional opening](references/delivery-contract.md#optional-opening).

## Optional viewer capabilities

These legacy viewer capabilities apply only to the original five diagram types. Roadmap uses [its own contract](references/roadmap.md), `roadmap-v1` evidence, and no theme/search/export/contact-sheet gate. Use `browser-check` for roadmap; `visual-check` fails explicitly as unsupported. Narrow screens initially show only part of the station map; drag to inspect it and use wheel zoom for full-map/label reading. Pinch zoom and +/- zoom buttons are not implemented; this is not a claimed legacy 16px readability or real-phone touch PASS.

`meta.animation: "trace"` is opt-in for the original five types.

Read `references/viewer-runtime.md` only when the user explicitly asks for Share Cards, Route/Reach cards, motion, deep links, presentation, search/focus, or another Viewer Runtime feature.

## Setup and fallback

No install is required inside the skill package. For setup diagnosis, verify with:

```bash
node bin/apitu.mjs doctor
node bin/apitu.mjs demo <output-directory>
```

When shell access is unavailable, hand-place architecture SVG into `assets/template.html`, use CSS semantic classes rather than inline colors, and follow the visual review contract in `references/delivery-contract.md`.

## Output

Return the checked HTML as an absolute path, diagram type, validation summary, specification/artifact receipt, browser-evidence status, and truthful visual-review status. Do not claim success for a non-zero command or claim visual inspection you did not perform.
