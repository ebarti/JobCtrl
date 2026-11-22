# Future Hosted Considerations

JobCtrl's accepted transformation targets a local Python application, SQLite,
React and durable execution. Cloud hosting, multi-tenant isolation, hosted
identity, deployment, database replacement and distributed event delivery are
not implemented or required by this work. There is no approved cloud transport
or JSON-RPC compatibility bridge.

A future hosted design would require its own decisions and evidence for tenant
authorization, per-tenant data isolation, secret custody, origin policy,
network boundaries, migrations, backups, recovery and idempotent external
effects. A port is a way to isolate a real dependency; its existence alone does
not establish that a hosted adapter or equivalent security guarantee exists.

See [security](../../developer/security.md) for the local threat model and
[feature boundaries](strategic.md) for the current target.
