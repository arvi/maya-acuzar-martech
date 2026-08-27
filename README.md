## MAYA - Technical Assessment
#### Send Money Limits Module

---

## Setup
1. Create `.env`. See [.env.example](.env.example).
2. Start application and database.
```bash
docker compose up --build
```

## Links
- [API Documentation](http://localhost:8080/docs)
- [Database Management UI](http://localhost:8070/)

## Send money

`docker compose up --build` brings up Postgres, the API (migrated and
seeded) and DbGate — `--build` matters if you've built this image before
and changed source since; without it Compose reuses whatever it already
built. Then, optionally:

    ./scripts/scenarios.sh all

See [docs/SEND_MONEY.md](docs/SEND_MONEY.md) for the endpoint walkthrough,
the seeded identities, and SQL to cross-check each scenario against the
database.

## Troubleshooting

### Resetting the database

```bash
docker compose down -v && docker compose up --build
```

The `-v` is the part that matters: it drops the `postgres_data` volume.
Without it the old database survives, and the seed skips itself when it finds
existing data — so a plain `down` and `up` leaves every transfer you have
already posted in place.

Reset when:

- **Scenarios fail that passed before.** `sender-limit` and `recipient-limit`
  spend real daily headroom, so they only behave predictably from a fresh
  seed. `daily-reset` needs unspent headroom too.
- **Balances have drifted** from the figures in `docs/SEND_MONEY.md` after
  posting transfers of your own.

On the next `up`, the one-shot `migrate` service re-runs migrations and
re-seeds before the API starts, so the stack comes back with the documented
balances.

### Port already in use

The host ports come from `.env` (`API_HOST_PORT`, `POSTGRES_HOST_PORT`,
`DBGATE_HOST_PORT`). If one is taken, change it there rather than in
`docker-compose.yml`.

### Container name conflicts

Services use fixed `container_name` values, so two copies of this stack cannot
run at once — a second one fails with *"container name is already in use"*.
Run `docker compose down` in the other checkout first.

### Changes not showing up

`docker compose up` on its own reuses the image it built last time. Use
`docker compose up --build` after changing source.

## License

No license. Copyright © 2026 Arvi. All rights reserved. This repository is provided for technical assessment purposes only.

