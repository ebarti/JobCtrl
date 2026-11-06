# 10. Testing Strategy

The accepted transformation starts a fresh E2E-only behavioral suite. Static lint, type checking and builds remain necessary, but no new component, unit, snapshot, isolated contract or internal-mock tests are added. A test that reaches only an adapter or stub cannot establish product behavior.

## 10.4 End-to-End Tests (Playwright)

Exercise the real browser UI, Python HTTP application, feature actions, SQLite/files, Temporal worker and renderer in owned synthetic workspaces. Only external model, job-source or provider boundaries may be controlled. Do not use internal dispatch, API/domain/repository stubs, semantic fake matchers, recorded model replay corpora, arbitrary sleeps or retries that mask flakes. Build once and use bounded isolated worker stacks with shared dependencies.

Cover retained user journeys and failures: stale inputs and conflicting saves, model and rendering failure, cancellation and worker restart, preservation of accepted artifacts, uncertain submission without duplicate external effects, event-driven refresh and one shell connection. Feature-removal verification demonstrates that core remains usable without the removed optional registration. Real-provider change/pre-release evidence remains distinct from controlled-boundary E2E. One-off Profile transfer verification is separate from the recurring suite.

## 10.7 Accessibility Spot Checks

Browser journeys check accessible names, keyboard navigation, focus and relevant status/error announcements on changed paths. Use owned accessible primitives and do not hide failures behind cosmetic status changes.

## 10.9 CI Pipeline (Cross-Reference)

Run the current commands in [local reliability QA](../../local-reliability-qa.md) and the target journey harness. Record actual setup and suite time on the declared runner and distinguish static checks, browser behavior and real-provider evidence.
