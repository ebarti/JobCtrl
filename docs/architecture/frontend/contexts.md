# 3. Frontend Feature Ownership

Frontend features expose public components, query/mutation hooks, loader helpers and event handlers for their own data. They use the Python feature's public HTTP contract and validate untrusted responses at their boundary. A feature must not import another feature's private hooks, stores, repositories or implementation files. Cross-feature pages compose public interfaces; core features have no dependency on optional features.

## 3.1 Frontend Context Map

Profile owns authored facts, evidence, sources and wording approval; Jobs owns posting reads and capture; Requirements owns qualified requirement records; Fit owns person-fit and wording coverage reads; Resumes owns document composition, editing and acceptance. Discovery, Companies, Contacts, Outreach, Applications, Interviews, Learning, Digest, Compensation and Offers expose their own retained capabilities. The shell explicitly selects and composes optional features; deleting an optional feature and its shell registrations must leave Profile, Jobs, Fit and Resumes operational.

## 3.10 Views (Composition Layer — NOT Bounded Contexts)

Views and routes compose feature public interfaces and ephemeral UI state. They do not acquire raw HTTP, Query or persistent-store authority. Shared pages, including Dashboard, Activity, Settings and Evidence Map, render independently owned feature panels and coordinate public queries where needed. Job Detail receives optional contributions through shell-owned slots rather than importing optional features into core. Route search validation and mapping stay at the route; feature-owned loaders receive only the narrow dependencies needed to read.

## 3.9 Operations / Read-Side

A central Operations business read kernel is not the target. Reads, keys and invalidations move to their owning features. Shell infrastructure may provide transport, event delivery, query setup and cache-safety utilities but must not become an alternate owner of feature data.
