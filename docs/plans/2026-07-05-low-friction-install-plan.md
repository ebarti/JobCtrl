# Low-Friction Install & Auth Reuse Plan

- **Date:** 2026-07-05
- **Status:** Proposed — plan only, nothing implemented.
- **Anchors:** All file/line references verified against `main @ ab73ea84`. Per repo practice, machine-re-verify every anchor against the implementation base ref before handing any phase to an implementer.
- **Goal:** One-command setup that works across as many environments as the underlying tools permit, reusing whatever vendor auth is already present on the machine (Claude login/key, Codex login/key, Gemini key), and prompting only for what is genuinely missing.

---

## 0. Context

JobCtl's employer-analysis ensemble runs three coding-agent SDKs, exact-pinned in `workers/automation/pyproject.toml:48-54`:

| Leg | Packages | Adapter |
|---|---|---|
| Claude | `claude-agent-sdk==0.2.87` | `workers/automation/src/jobctl/infrastructure/analysis/claude_analysis_adapter.py` (+ `infrastructure/materials/voice_adapter.py`) |
| Codex | `openai-codex==0.1.0b2` + `openai-codex-cli-bin==0.132.0` | `infrastructure/analysis/codex_analysis_adapter.py` |
| Antigravity | `google-antigravity==0.1.2` | `infrastructure/analysis/antigravity_analysis_adapter.py` (+ `gemini_schema.py`) |

All adapters are constructed with no overrides in `workers/automation/src/jobctl/scoring/employer_analysis.py:62-70`, so SDK defaults govern binary resolution. The questions this plan answers: are the SDKs compatible with arbitrary CLI versions; should we bundle binaries; what does bundling mean for auth; and what does a low-friction installer need.

---

## 1. Findings (research basis for the plan)

Verified 2026-07-05 by inspecting the installed wheels in `workers/automation/.venv` plus vendor docs/repos/PyPI. Sources in the Appendix.

### 1.1 SDK ↔ CLI compatibility: version-locked, solved by bundling

**No SDK is compatible with arbitrary CLI versions — and none needs to be, because each pip wheel ships its own exactly-matched binary.**

| | Claude (`claude-agent-sdk` 0.2.87) | Codex (`openai-codex` 0.1.0b2) | Antigravity (`google-antigravity` 0.1.2) |
|---|---|---|---|
| What the wheel ships | Claude Code **2.1.150** as `_bundled/claude`, ~205 MB Bun-compiled native binary (no Node.js required) | `Requires-Dist: openai-codex-cli-bin==0.132.0` (exact pin); that wheel ships a ~185 MB native `codex` (verified `codex-cli 0.132.0`) | ~91 MB Go `localharness` binary vendored in each platform wheel; SDK version == binary version |
| Binary resolution order | `cli_path` option → **bundled** → `PATH` → fixed fallback dirs → error | `launch_args_override` → `codex_bin` option → **bundled only** (never searches PATH; no env-var override) | `ANTIGRAVITY_HARNESS_PATH` env → **wheel binary** → `which("localharness")` |
| External install needed? | No (bundled binary is self-contained) | No | No — the Antigravity IDE is *not* required |
| Version-skew behavior | Soft floor only: warns below CLI 2.0.0 (`CLAUDE_AGENT_SDK_SKIP_VERSION_CHECK` bypass); no upper bound. The stream-json control protocol is an undocumented internal contract that drifts per release; Anthropic co-versions SDK+CLI pairs. Older CLI + newer SDK → hard failure on unknown flags; newer CLI + older SDK → mostly works, silent-breakage risk | Explicitly experimental: app-server JSON-RPC v2 gated behind `experimentalApi: true`, no compat promise. OpenAI's FAQ: skew surfaces as `MethodNotFound` / `InvalidParams`; use the pinned runtime | No documented protocol versioning; ~weekly releases (0.1.5 latest observed, 2026-06-25). Real drift risk is **model IDs** — adapter already documents `gemini-3-pro` 404ing |

**Repo-specific deviation:** `codex_analysis_adapter.py:114-116` prefers a system `codex` from `shutil.which("codex")` over the pinned bundled binary — the one place in the repo that reintroduces the skew the SDK design prevents (fix: S2).

### 1.2 Bundling verdict

We already bundle — via the exact pins; `uv sync` delivers matched binaries from the vendors' own PyPI wheels. **Do not vendor binaries into our own release artifacts:**

- **Claude Code is proprietary** ("© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms"). The SDK's Python code is MIT, but the bundled CLI grants no redistribution right. Installing from PyPI keeps Anthropic as the distributor; copying the binary into our artifacts would make us an unlicensed redistributor. The subprocess boundary keeps it out of our AGPL-3.0 copyleft scope (arm's-length invocation, not linking).
- **Codex is Apache-2.0**, both PyPI packages officially OpenAI-published (Trusted Publishing from `openai/codex`). Vendoring would be legal but pointless given the pin.
- **Antigravity is Apache-2.0** (author Google LLC) but the wheel ships no NOTICE/third-party attribution for the statically-linked Go binary — another reason to keep it a declared dependency.

**Portability gap (critical):** `openai-codex-cli-bin` 0.132.0 is wheel-only with **no glibc/manylinux Linux wheels** — only macOS x86_64/arm64, Windows amd64/arm64, and *musllinux* aarch64/x86_64. The pinned set does not resolve on standard Ubuntu/Debian. This is the single biggest cross-setup blocker (addressed by S5).

### 1.3 Authentication: bundling changes nothing; credentials are user-scoped, not binary-scoped

All three binaries read credential stores keyed to the user's home/keychain, so a bundled copy transparently reuses whatever the user's separately installed CLI wrote. Two framing rules bound how setup uses this:

- **API/provider auth is the supported distributed path.** The Claude Agent SDK docs lead with `ANTHROPIC_API_KEY` / cloud-provider auth, and OpenAI recommends API keys for programmatic use. Setup's prompts and our docs lead with keys.
- **Reuse of existing subscription/CLI login state is a local/dev convenience only** — detected and honored on the user's own machine, never presented as the supported product path. Where setup offers subscription enrollment, it only invokes the vendor's own login flow for the user's own account (see open decision 4).

- **Claude** — resolution precedence: cloud switches (`CLAUDE_CODE_USE_BEDROCK`/`VERTEX`/`FOUNDRY`) → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` → `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`; Pro/Max/Team; ~1-year, inference-only) → the `/login` credential store (macOS Keychain service `"Claude Code-credentials"`; `~/.claude/.credentials.json` elsewhere; `CLAUDE_CONFIG_DIR` redirects). Anyone who has ever run `claude /login` on this machine is therefore picked up with zero configuration — as a local convenience; the SDK's documented auth model remains `ANTHROPIC_API_KEY` / cloud-provider auth, which is what setup leads with.
- **Codex** — all surfaces (CLI, IDE, app-server, SDK) share persisted login state in `$CODEX_HOME/auth.json`, default `~/.codex/`. Our adapter already exploits this: it seeds an isolated `CODEX_HOME` (`~/.jobctl/codex_home`) with a 0600 copy of the user's `auth.json` (`codex_analysis_adapter.py:85-97`). **Env API keys do not authenticate this surface:** `CODEX_API_KEY` is documented for `codex exec` only, and the Python SDK app-server path reads neither `OPENAI_API_KEY` nor `CODEX_API_KEY` — verified against the installed wheel, whose only key-based auth is the explicit `login_api_key(...)` call (`openai_codex/api.py`), which runs the app-server `apiKey` login and persists it. Key-based users must therefore be *enrolled* — SDK `login_api_key(...)` or `printenv OPENAI_API_KEY | codex login --with-api-key` — so `auth.json` exists; a bare env key must never mark the leg ready. Device-code login exists for headless subscription enrollment (`codex login --device-auth`; both flags verified on the pinned 0.132.0 binary).
- **Antigravity** — as pinned (0.1.2) and as our adapter enforces (`antigravity_analysis_adapter.py:85-98`), a `GEMINI_API_KEY`/`GOOGLE_API_KEY` is required. The binary embeds the full Google auth stack (ADC, OAuth, Vertex, Code-Assist backend), and 0.1.5 docs make ADC the documented default — an optional friction reducer (S6). App/session state defaults to `~/.gemini/antigravity`; our adapter already isolates it to per-process tmp dirs.

**ToS constraints to encode:**

- Anthropic: the Agent SDK docs lead with `ANTHROPIC_API_KEY` / cloud-provider auth, and third-party products may not offer claude.ai login/rate-limits without prior approval. API/provider auth is therefore the supported distributed path; a user running `setup-token` for their *own* subscription on their own machine is a sanctioned local convenience, not something we present as the product's auth model.
- OpenAI: API keys recommended for programmatic use; **ChatGPT-account automation is banned for public/OSS-repo CI**. Local personal use draws from the user's own plan limits (rolling 5-hour window).
- Never ship, proxy, or commit credentials of any kind.

### 1.4 Repo gaps the installer must close

- `jobctl doctor` (`workers/automation/src/jobctl/cli.py:1742`) checks **none** of the three ensemble SDKs or their auth. Its Tier-2 "LLM API key" row (`GEMINI_API_KEY`/`OPENAI_API_KEY`/`LLM_URL`, `cli.py:1845-1858`) belongs to the legacy httpx `LlmClient`, and its Tier-3 `which("claude")` row (`cli.py:1862-1867`) validates the **auto-apply** subprocess, not the Agent SDK. Already tracked as OSS spec §W2.6 (`docs/plans/2026-07-03-oss-release-remediation-spec.md:1075-1088`).
- `.env.example` and `docs/user/getting-started.md:66-76` claim a single LLM key suffices; `docs/architecture.md:1006-1010` states the correct model (Claude session + reused Codex login + Gemini key). User docs contradict architecture docs.
- The apply path spawns a bare `"claude"` from PATH (`infrastructure/apply/claude_code_cli.py:145-176`) — the only remaining "install a vendor CLI" prerequisite (S3 decision).
- Ensemble degradation already works: lazy SDK imports keep the package importable; `_draft_with_retry` retries twice, records a failed leg as `AnalysisFailure`, and hard-fails (`EnsembleError`) only when **all** legs fail (`scoring/ensemble.py:55,90-98,200-214`). But there is no way to *intentionally* disable a leg, so a known-unauthed leg burns retries every run (S4).
- `SDK_SET_VERSION = "claude+codex+antigravity-v1"` is folded into the analysis cache key (`domain/materials/analysis.py:51-53`) — any leg-configurability must feed this key.

---

## 2. Design principles

1. **Never install vendor CLIs as a prerequisite.** `uv sync` already delivers matched Claude/Codex/Antigravity binaries inside the wheels. System prerequisites are toolchain-level only: uv, Node 20+/pnpm, Temporal CLI, Chrome/Playwright.
2. **Detect and reuse before prompting.** Per leg: probe the credential sources that actually authenticate that leg's runtime surface (for Codex, only persisted `auth.json` counts — env keys never reach the app-server; see Phase 3); only if nothing is found, offer (a) API-key enrollment — the supported path, always listed first, (b) the vendor's own login flow as a local/dev convenience, or (c) skip the leg. A user who already uses these tools sees zero prompts.
3. **Degrade gracefully, explicitly.** Persist which legs are enabled so runs don't burn retries on known-missing auth; doctor reports the same truth.
4. **Never touch or ship credentials.** Persist only key references into git-ignored `.env`; login flows write to the vendors' own stores.
5. **Bash stays dumb; Python does the thinking.** A thin `scripts/install.sh` bootstraps uv/Node and hands off to a new `jobctl setup` Typer command — cross-platform, unit-testable, sharing probe code with doctor.

---

## 3. Install flow (`scripts/install.sh` → `jobctl setup`)

### Phase 0 — bootstrap (bash, minimal)
Detect OS/arch. Install/verify `uv` and Node 20+ with pnpm (corepack). Hand off to `uv --project workers/automation run jobctl setup`.

### Phase 1 — toolchain checks (Python)
- Temporal CLI (offer brew/curl install, or print instructions).
- Chrome/Chromium + `playwright install chromium`.
- `pdflatex` optional (Playwright PDF fallback already exists — report, don't block).
- Disk-space note: ~500 MB of vendored binaries across the three wheels.

### Phase 2 — dependencies
`uv --project workers/automation sync` and `pnpm install`. On glibc Linux, run the S5 platform gate **before** sync so the Codex-wheel gap surfaces as a friendly message with options, not a resolver error.

### Phase 3 — per-leg auth detection and enrollment

| Leg | Detect (in order; any hit → no prompt) | Enroll options if none found |
|---|---|---|
| Claude | Supported path first: `ANTHROPIC_API_KEY` / Bedrock-Vertex-Foundry switches / `CLAUDE_CODE_OAUTH_TOKEN`; then, as local-convenience detection: macOS Keychain `"Claude Code-credentials"`, `~/.claude/.credentials.json` (honor `CLAUDE_CONFIG_DIR`) | (a) paste `ANTHROPIC_API_KEY` (supported path); (b) `claude setup-token` against the user's *own* subscription (interactive browser; local/dev convenience) — invokable via the SDK's bundled CLI so no separate install; (c) skip leg |
| Codex | `~/.codex/auth.json` (honor `CODEX_HOME`) — the **only** readiness signal. A bare `OPENAI_API_KEY`/`CODEX_API_KEY` is enroll-input, not readiness: the SDK app-server path reads neither, and `CODEX_API_KEY` is `codex exec`-only | (a) enroll an API key into `auth.json` (SDK `login_api_key(...)` or `printenv OPENAI_API_KEY \| codex login --with-api-key` via the bundled binary, `codex_cli_bin.bundled_codex_path()`) — a key left only in `.env` feeds the legacy Tier-2 `LlmClient`, not this leg; (b) `codex login --device-auth` (subscription; local/dev convenience); (c) skip leg |
| Antigravity | `GEMINI_API_KEY` / `GOOGLE_API_KEY` (plus ADC/Vertex if S6 lands) | (a) paste key (link to the AI Studio key page); (b) skip leg |

Separately confirm the **apply** prerequisite (PATH `claude`, or the S3 fallback if approved) and label it as the apply-agent requirement, distinct from the ensemble.

### Phase 4 — persist + verify
- Write enabled-legs config + key env vars to git-ignored `.env`.
- Run the extended `jobctl doctor` (S1).
- Offer an optional per-leg **live smoke test**: one tiny schema-constrained prompt per enabled leg so auth failures surface at setup time, not mid-pipeline.

### Phase 5 — modes
- `--yes` / `--non-interactive`: answers via env vars, JSON summary output, meaningful exit codes (CI/agent use).
- Idempotent re-runs: re-running setup updates only what changed.

---

## 4. Source changes

Each lands in its own worktree/PR per repo conventions; Conventional Commit titles.

| ID | Change | Where | Why / notes |
|---|---|---|---|
| **S1** | Doctor gains real per-leg ensemble checks: SDK importable; bundled binary present + version (`claude_agent_sdk._cli_version.__cli_version__`, `codex --version`, antigravity wheel version); per-leg auth-chain probes (Codex: persisted `auth.json` only — env keys never authenticate the app-server surface). Fix the misleading Tier-2 "one LLM key suffices" and the Tier-3 `claude` row labeling | `workers/automation/src/jobctl/cli.py:1742` (doctor); `config.py` tier logic (`:1214-1250`) | Already scoped as OSS spec §W2.6 — implement there; `jobctl setup` reuses the same probe module |
| **S2** | Remove the Codex PATH-preference: stop passing `shutil.which("codex")` as `codex_bin`; always run the pinned bundled binary. Keep an explicit opt-in override env (`JOBCTL_CODEX_BIN`) as the sanctioned escape hatch (used by S5 fallback) | `codex_analysis_adapter.py:114-116` | Eliminates the repo's one version-skew exposure; matches SDK design and the no-compat-shims rule |
| **S3** | *(Decision)* Apply-agent CLI resolution: env override → `which("claude")` → the Agent SDK's bundled binary path. Removes the last "install a vendor CLI" prerequisite. Tradeoff: `_bundled/claude` is a private SDK path (pin-tested, unsupported API) | `infrastructure/apply/claude_code_cli.py:145-160`; confirm legacy `apply/launcher.py` is dead code | Cuts real setup friction; needs owner sign-off given SDK-internal reliance |
| **S4** | Explicit leg enable/disable config (e.g. `JOBCTL_ANALYSIS_LEGS=claude,codex,antigravity` or a config key) consumed by the composition root; fold the enabled set into the analysis cache key | `scoring/employer_analysis.py:62-70`; `domain/materials/analysis.py:51-53` (`SDK_SET_VERSION`) | Lets setup persist "skip codex" cleanly; cache key must reflect the enabled set or cached analyses go stale across configs. **Resolved (2026-07-06, #317):** shipped — the enabled leg set never governs synthesis: every run reconciles with the Claude Agent SDK synthesizer, so Claude synthesis auth is always required regardless of `JOBCTL_ANALYSIS_LEGS` (`probe_analysis_setup` always emits a `Claude synthesis auth` row; setup reports analysis NOT ready without it). |
| **S5** | Linux/Codex portability: pinned `openai-codex-cli-bin==0.132.0` ships no glibc wheels. **Preferred:** bump the `openai-codex` pin to a release whose runtime wheel covers manylinux (verify on PyPI at implementation time; 0.1.0b3 pins `0.137.0a4`). **Fallback:** on glibc Linux, setup installs codex via npm/brew and sets `JOBCTL_CODEX_BIN`. **Last resort:** doctor marks the leg unsupported on that platform | `workers/automation/pyproject.toml:49-50`; setup platform gate | Without this, `uv sync` fails or the Codex leg is dead on standard Linux — the biggest cross-setup blocker |
| **S6** | *(Optional)* Antigravity ADC/Vertex acceptance: proceed when gcloud ADC / `GOOGLE_GENAI_USE_VERTEXAI` is configured instead of hard-requiring an API key. Key remains the primary documented path | `antigravity_analysis_adapter.py:85-98,139-153` | Newer SDK docs make ADC the default; lowers friction for gcloud users |
| **S7** | Docs + `.env.example`: lead with `ANTHROPIC_API_KEY` (supported path) and note `CLAUDE_CODE_OAUTH_TOKEN`/subscription reuse as local convenience; Codex auth note — the leg needs persisted `auth.json` (enrolled key or login); env keys are `codex exec`-only and don't reach the SDK leg; `GEMINI_API_KEY`/`GOOGLE_API_KEY` scoped to the Antigravity leg; fix `docs/user/getting-started.md:66-76` single-key claim; README quickstart gains the one-command install. Update per the CLAUDE.md doc-ownership matrix | `.env.example`, `README.md`, `docs/user/getting-started.md`, `docs/user/configuration.md` | `docs/architecture.md:1006-1010` already states the correct auth model; user docs contradict it |
| **S8** | The `jobctl setup` command + thin `scripts/install.sh`; shared probe module used by both setup and doctor | new `cli.py` command + `infrastructure/` probe module | Keeps bash dumb and the logic unit-testable |

---

## 5. Non-goals

- **No vendoring of vendor binaries** into our repo, wheels, tarballs, or published images (Claude: prohibited; Codex/Antigravity: legal but strictly worse than the pin).
- **No credential shipping or proxying**; no shared keys of any kind.
- **No ChatGPT-account or claude.ai-login automation in public CI** — API keys only there.
- No changes to ensemble semantics (retry counts, no-timeout policy, synthesis) — this plan is packaging/onboarding only.

---

## 6. Validation & QA

- **Unit tests** for every detection probe (mocked env vars, credential files, keychain lookups; parametrized per-OS behavior).
- **QA matrix** (per repo rules, user-facing flow ⇒ QA stage required):
  1. Fresh macOS user account, no vendor CLIs → full prompt path; each enroll option exercised.
  2. macOS with existing `claude` login + `codex` login + `GEMINI_API_KEY` → zero-prompt path; ensemble smoke test passes.
  3. glibc-Linux container (Ubuntu) → exercises the S5 gate and chosen strategy.
  4. `--non-interactive` in a clean container → deterministic exit codes + JSON summary.
- Doctor output asserted in a regression fixture (per-leg rows present, correct labels).

---

## 7. Sequencing

1. **S5 investigation** (PyPI wheel audit of newer `openai-codex` releases) — informs everything downstream.
2. **S1 + S7** (doctor + docs) — aligns with the in-flight OSS spec §W2.6.
3. **S2 + S4** (codex bundled-binary default; leg configurability + cache key).
4. **S8** (setup command + install.sh) on top of the probes from S1.
5. **S3 / S6** if approved.

---

## 8. Open decisions (owner)

1. **S3 scope:** should apply fall back to the SDK-bundled Claude binary (leans on a private SDK path), or keep requiring a system `claude` for apply?
   - **Resolved (2026-07-06, #317):** fall-back chain shipped. `resolve_claude_apply_binary` (`infrastructure/setup_probes.py`) resolves `JOBCTL_CLAUDE_BIN` (expanded) → system `claude` on PATH → SDK-bundled `claude_agent_sdk/_bundled/claude` → literal `"claude"` sentinel; apply no longer requires a system `claude`. This relies on a **private, underscore-prefixed SDK path** (`_bundled/claude`); if it moves the resolver degrades to the `"claude"` sentinel while `jobctl doctor` surfaces it loudly (the `Claude analysis SDK` row reports "bundled Claude binary missing at …" and the `Claude apply runtime` row goes MISSING → tier drops) — there is no hard exception at resolution time. **Owner sign-off flagged in the PR review** for the private-SDK-path reliance.
2. **S5 strategy:** bump the Codex pin (if manylinux wheels exist upstream) vs. npm-install fallback with `JOBCTL_CODEX_BIN` on glibc Linux?
   - **Resolved (2026-07-06, #317):** pin bump chosen. `openai-codex-cli-bin==0.137.0a4` (with `openai-codex==0.1.0b3`) is the first audited runtime shipping `manylinux_2_17` wheels for standard glibc Linux, closing the gap (verified in `workers/automation/uv.lock`: the `openai-codex-cli-bin` 0.137.0a4 block carries `manylinux_2_17`, `macosx`, `musllinux`, and `win_amd64` wheels). `JOBCTL_CODEX_BIN` remains the explicit override rather than an npm-install fallback path.
3. **S6:** is ADC/Vertex acceptance for the Antigravity leg worth the extra surface?
   - **Resolved (2026-07-06, #317):** implemented. `antigravity_auth_kwargs`/`probe_antigravity_auth` accept `GEMINI_API_KEY`/`GOOGLE_API_KEY` or Vertex AI ADC (`GOOGLE_GENAI_USE_VERTEXAI`/`GOOGLE_CLOUD_VERTEXAI` + project via `GOOGLE_CLOUD_PROJECT`/`GOOGLE_PROJECT_ID`/`GCLOUD_PROJECT` and/or the ADC credentials file, with optional `GOOGLE_CLOUD_LOCATION`). Documented in `docs/user/configuration.md`.
4. **Login UX:** should `jobctl setup` *launch* the interactive vendor logins (`claude setup-token`, `codex login --device-auth`) or print the exact commands and re-probe?
   - **Resolved (2026-07-06, #317):** print/prompt-and-re-probe by default. `jobctl setup` prompts inline to paste `ANTHROPIC_API_KEY` (Claude) and `GEMINI_API_KEY` (Antigravity), and for Codex prints the exact enrollment commands (`codex login` / `printenv OPENAI_API_KEY | codex login --with-api-key`) and re-probes on rerun. An opt-in `--launch-logins` flag additionally launches **only** the Codex API-key enrollment (`codex login --with-api-key`) when an OpenAI key is present and confirmed; it does **not** launch `claude setup-token` or `codex login --device-auth`, and `jobctl init` (`wizard/init.py`) does not launch logins.

---

## Appendix — research provenance

Local ground truth: installed wheels under `workers/automation/.venv/lib/python3.14/site-packages/` — `claude_agent_sdk/` (`_version.py`, `_cli_version.py`, `_bundled/claude`, `_internal/transport/subprocess_cli.py`, `_internal/session_resume.py`, `types.py:1702`), `openai_codex/client.py`, `openai_codex/api.py` + `_login.py` (login surface: `login_api_key`, ChatGPT/device-code handles; no env-key reads anywhere in the package), `codex_cli_bin/bin/codex` (`login --help` verified: `--with-api-key`, `--device-auth`), `google/antigravity/` (`connections/local/local_connection.py`, `types.py`, `bin/localharness`), plus each `*.dist-info/METADATA`.

Web sources: Claude Agent SDK overview & auth (code.claude.com/docs/en/agent-sdk/overview, /en/authentication), `anthropics/claude-agent-sdk-python` and `-typescript` CHANGELOGs, `anthropics/claude-code` LICENSE.md, Anthropic Commercial Terms; `github.com/openai/codex` (sdk/python docs: api-reference, faq, getting-started; release `rust-v0.132.0`), developers.openai.com/codex (auth, environment-variables, noninteractive, ci-cd-auth, pricing), PyPI JSON for `openai-codex` / `openai-codex-cli-bin`; PyPI JSON for `google-antigravity`, `github.com/Google-Antigravity/antigravity-sdk-python`, Wikipedia "Google Antigravity".
