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

## License

No license. Copyright © 2026 Arvi. All rights reserved. This repository is provided for technical assessment purposes only.

