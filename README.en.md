# Mozhou · AI Novel Writing Tool

> A **local-first, AI-native** production system for long-form Chinese web novels.
> It writes from a one-line idea all the way to a finished book — not "AI writes you a paragraph," but a **resumable, auditable, settleable** long-form production line.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D23.4-brightgreen.svg)](https://nodejs.org/)
[![CI](https://github.com/FEOH333/mozhou-ai-novel/actions/workflows/ci.yml/badge.svg)](https://github.com/FEOH333/mozhou-ai-novel/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-1556%20passed-brightgreen.svg)](#testing)
[![Dependencies](https://img.shields.io/badge/dependencies-1-brightgreen.svg)](./package.json)
[![Vulnerabilities](https://img.shields.io/badge/vulnerabilities-0-brightgreen.svg)](https://github.com/FEOH333/mozhou-ai-novel/security/dependabot)
[![Local First](https://img.shields.io/badge/local--first-your%20data%20never%20leaves%20your%20machine-blueviolet.svg)](#local-first)

[简体中文](./README.md) | **English**

---

## What This Is

Mozhou breaks "writing a long web novel" into a **stateful pipeline**:

```
idea escalation → book contract / opening-promise profile → opening structure candidates + blind comparison
   → world / character design → book outline → volume outline → chapter outline → scene prose
   → continuity audit → minimal revision → coverage check → atomic settlement
   → stage review / polish → completion verdict
```

Every artifact is **persisted, traceable, and rollback-able**. It targets the real pain points of long-form fiction:

| Pain point | How Mozhou handles it |
| --- | --- |
| Characters drift out of character mid-book | Single source of truth for character cards (personality / speech listed separately); vitality profile grows per chapter |
| Contradictions and forgotten foreshadowing | Foreshadowing ledger + cross-chapter repetition window + coverage check; overdue threads are aged out or promoted to long arcs |
| Outline and prose drift apart | **Prose is the authority**; summaries / facts / characters / foreshadowing are only *projections*. Version switches are all-or-nothing |
| AI flavor, template sentences, repetition | Anti-templating dramatic contract + sentence-family rotation + word-root repetition detection + banlist for clichés |
| One bad chapter forces a full rewrite | Candidate prose is validated in a shadow version first; on failure the entire previous version is kept |
| A crash mid-run loses everything | Server-side background jobs are persisted; the browser is only an observation surface. Disconnects are replayable and resumable |
| Runaway cost | Layered prompt caching (constant prefix + dynamic tail), dual-view cost accounting, injection-size guardrails |

---

## Quick Start

### Requirements

- **Node.js ≥ 23.4** (relies on built-in `node:sqlite`; plain JS, no build step, ESM)
- First run downloads a local embedding model (~100 MB); fully offline afterwards

### Install and Run

```bash
git clone https://github.com/FEOH333/mozhou-ai-novel.git
cd mozhou-ai-novel
npm install          # only one dependency: @huggingface/transformers

cp data-config.example.json data/config.json
cp secrets.env.example secrets.env
# edit secrets.env and put your own model API key in it

start.bat            # Windows: one-click start (recommended)
# or
npm start            # any platform: http://127.0.0.1:8770
```

> **Windows note**: `start.bat` runs the server in the foreground of the current window. **Closing the window stops the service** — no hidden process is left behind.

### Model Configuration

`data/config.json` only needs one OpenAI-compatible endpoint (**keep the key empty; use environment variables**):

```json
{
  "baseUrl": "https://your-endpoint/v1",
  "apiKey": "",
  "model": "your-model-name"
}
```

**Automatic dual-endpoint failover** is supported: fill in `backup.baseUrl` / `backup.apiKey` and, when the primary endpoint fails, the call degrades automatically — the call record notes which source actually served it.

### Manage Secrets with Environment Variables (Recommended)

**Never write a plaintext key into a config file.** Put it in the environment instead:

```bash
# Git Bash / macOS / Linux
cp secrets.env.example secrets.env   # secrets.env is git-ignored
# edit secrets.env with your real key, then:
source secrets.env
npm start
```

```powershell
# PowerShell (current session)
$env:NOVEL_API_KEY = "sk-xxxxxxxx"
$env:NOVEL_BACKUP_API_KEY = "sk-yyyyyyyy"   # optional, backup endpoint
npm start

# Persist across sessions
setx NOVEL_API_KEY "sk-xxxxxxxx"
```

Precedence is **environment variable > `config.json`**, and a key supplied via environment variable is **never written back to disk** — even if you click "Save" on the settings page, `config.json` keeps its previous (empty) value. The key exists only in the environment.

> ⚠️ Both `data/` and `secrets.env` are `.gitignore`d, so keys never enter version control.

### Try Without a Key

```bash
NOVEL_MOCK_LLM=1 npm start    # deterministic mock: full pipeline runs, zero cost
```

---

## Common Commands

```bash
npm start                        # start the server
npm test                         # full test suite (1500+ cases)
npm run doctor                   # read-only health check: structure, continuity, consistency
npm run audit:recovery           # read-only audit of recovery/rework progress
```

Isolated data directory (multiple books / configs side by side):

```bash
NOVEL_DATA_DIR=./data-experiment npm start
```

---

## Data and Environment Variables

| Variable | Purpose |
| --- | --- |
| `NOVEL_API_KEY` | Primary endpoint key; overrides `apiKey` in `config.json` (preferred — never touches disk) |
| `NOVEL_BACKUP_API_KEY` | Backup endpoint key; overrides `backup.apiKey` in `config.json` |
| `NOVEL_DATA_DIR` | Data directory, defaults to `./data` (holds `novel.db` + `config.json`) |
| `NOVEL_MOCK_LLM=1` | Deterministic mock model — for tests and zero-cost trial runs |
| `NOVEL_NO_OPEN=1` | Do not auto-open the browser on start |
| `NOVEL_HISTORICAL_ERA_TEMPLATE=1` | Enable the built-in historical era stage table (see below) |

---

## Historical Fiction: the Era Table Is a **Switch**, Not a Title Match

A built-in "Southern Song, late period, alternate-history" 15-volume era skeleton (from a youth in exile in 1241 to a settled new order in 1294) provides per-year windows, protagonist ages, stage duties, real historical figures' appearance windows, and historical-boundary validation.

**Enable it in any of three ways**:

1. Book-level setting: `settings.historicalEraTemplate = true`
2. Environment variable: `NOVEL_HISTORICAL_ERA_TEMPLATE=1`
3. State a starting year and a geographic anchor together in the blurb (e.g. "the first year of Chunyou" + "Diaoyucheng")

Set it to `false` to disable explicitly. **No specific work's title ever becomes a framework switch** — that is one of this project's iron rules.

---

## Project Structure

```
server/
  engine/          creation pipeline: outline, scenes, audit, revision, settlement, narrative versions
  data/            craft files: literary doctrine, genre packs, historical anchors, redline numbers
  db/              schema.sql + store.js (node:sqlite, with migrations)
  llm/             model calls: routing, cache layering, resilience/retry, cost metering
  maintenance/     general maintenance tools: doctor, backfill, repair (all support dry-run)
web/               frontend: vanilla JS + CSS, no build
tests/             1500+ cases (node:test)
```

---

## Development Conventions

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before contributing. The most important rules:

- **Prompt files are craft files**: literary doctrine states "the narrative effect to achieve + the material available in this scene" — no walls of rules, no stock action examples.
- **No one-off hardcoded special cases**: genre specifics must be reduced to configuration switches; a specific book title never enters the framework.
- **Never bypass existing frameworks**: state changes go through the state machine, prose lands through validation gates; no new direct-write entries.
- **Never touch the cache prefix**: constant prefix and dynamic injection are strictly layered; new doctrine only enters the final user message.
- **Writing and auditing share one source**: the same doctrine is injected into both the writing and the auditing instruction; injection must be verifiable.
- **Prefer fixing the tool**: problems found during review should become deterministic defenses or doctrine text — editing the prose directly is the exception.

---

## Local First

- Your book data lives in `data/novel.db` on your own machine. Nothing is uploaded anywhere except your own model API calls.
- The server binds to `127.0.0.1` by default and is not designed to be exposed publicly.
- Secrets can be kept entirely out of on-disk config (see above).

**Do not expose the service to the public internet** without adding your own authentication layer. See [`SECURITY.md`](./SECURITY.md) for the full security model.

---

## Testing

```bash
npm test
```

Uses Node's built-in test runner (`node:test`). **Node ≥ 23.4 is required** — older versions fail on `node:sqlite` behavior, not on project logic.

---

## License

**AGPL-3.0** (GNU Affero General Public License v3.0).

What that means:

- ✅ You may freely use, modify, and distribute this project
- ✅ You may modify it and use it internally in a self-hosted service
- ⚠️ If you **distribute** a modified version, you must open-source your changes under the same license
- ⚠️ **If you turn Mozhou into an online service (even API-only), you must publish your complete source code**

That is the key difference between AGPL and GPL (Section 13: network interaction also constitutes "distribution").
The intent is straightforward: **no one gets to wrap Mozhou in a shell and turn it into a closed-source commercial service.**

Full terms in [`LICENSE`](./LICENSE).

---

## Known Boundaries

- Optimized for **long-form Chinese web novels**; short stories and other languages are out of scope.
- You must bring your own model API. This project ships no model weights, and includes only one lightweight local embedding model for retrieval.
- Large-scale generation consumes substantial tokens — validate cost on a small book first.
