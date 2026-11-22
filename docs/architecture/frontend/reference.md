# 12–15. Risks, Glossary and Resolutions

## 12. Risks

Cache invalidation can miss upstream changes; each mounted feature declares all event names that affect its reads, and E2E journeys prove observable refresh. Optimistic rollback can overwrite newer state; use ownership-aware patch, rollback and invalidation. Reconnect can race a first read; reconcile after connection and after unfinished reads settle. A failed refresh retains accepted data and reports the error. Timeouts or incomplete acknowledgements after writes leave the outcome uncertain and must not authorize a duplicate external action.

Optional-feature removal must remove its navigation, public panels and event registration without making core imports fail. DTO drift must fail validation visibly rather than fabricate a compatible response. Browser and OS effects remain behind injected ports. A build or isolated static check cannot prove a real workflow.

## 13. Glossary

**Feature:** an owner of public data, actions and presentation. **View:** a composition of public feature interfaces. **Port:** a narrow dependency at a real I/O boundary. **Committed event:** an invalidation signal persisted with the business change. **Accepted artifact:** a user-accepted document that remains available if a later generation or refresh fails.

## 14. Open Questions Resolution Summary

The accepted [transformation plan](../../plans/2026-11-06-python-transformation.md) owns current scope and delivery status. It supersedes the former centralized Operations read kernel and legacy test pyramid.
