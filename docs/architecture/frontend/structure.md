# 11. Folder Structure

`apps/web/src/contexts/<feature>/` owns a feature's public entry point, panels, hooks, query keys, validation and event invalidation. A context does not import routes, generated route trees, views or sibling private state. `views/` and `routes/` assemble public feature interfaces; route loaders delegate to narrow feature read helpers. `shared/ports`, `shared/adapters`, `shared/providers` and `shared/ui` own browser capabilities, composition infrastructure and shared presentation primitives. `feature-events.ts` is the explicit application list of mounted feature event handlers. `main.tsx` mounts the providers and the one stream connection.

During the Python transformation, legacy Operations reads are retired as their feature-owned replacements are wired. Their continued presence is not evidence that a feature is migrated. The target contains no central business-data read kernel, alternate backend writer or optional-to-core dependency.
