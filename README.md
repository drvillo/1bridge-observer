# 1bridge independent observer

Public, customer-operated pull observer for 1bridge authenticated governance evidence. This repository is being built in dependency order with [1bridge-authority](https://github.com/drvillo/1bridge-authority). It is **not yet runnable or a source of audit assurances**; the first published revision records the deployment and verification contract so implementation can be reviewed against it.

The observer will use its own Postgres database (including customer-owned Supabase Postgres), fetch bounded signed checkpoints and contiguous history ranges from 1bridge, independently verify and replay them, retain heads and findings, and sign precise coverage reports. It will not receive the provider's Supabase service-role key or block product releases. A configured observer can be offline while 1bridge keeps operating; later jobs resume from durable progress.

[Architecture and implementation order](docs/architecture.md) gives the initial contract. The eventual detection of a suppressed completed event requires an honest receipt or head to reach independent custody. A source-only pull cannot discover a coherent hidden branch whose only copy the provider withholds.

License: MIT.
