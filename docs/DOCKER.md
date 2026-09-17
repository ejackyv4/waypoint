# Docker package

Waypoint includes an optional Docker package for running the backend in an isolated environment. It is additive: the normal `./spike/demo` workflow and its local database are unchanged.

## Current state (2026-09-16)

The Docker package is stored in the repository but is not the default development workflow. The image was built successfully with Node 24, and the named volume `waypoint_waypoint_docker_data` was created and tested. It has not been pushed to a registry or used for the DigitalOcean deployment. The normal local workflow remains `./spike/demo restart`.

## Services and ports

The image runs the existing Node server and its three listeners:

| Service | Container port | Host port | URL |
| --- | ---: | ---: | --- |
| Waypoint API, console, learner site | 8090 | 18090 | http://app.localhost:18090 |
| Content origin | 8091 | 18091 | http://content.localhost:18091 |
| Northwood mock SaaS | 8092 | 18092 | http://saas.localhost:18092 |

Host ports are intentionally different from normal local ports (`8090–8092`) so both environments can run simultaneously.

## Database

Docker uses the named volume `waypoint_waypoint_docker_data`, mounted at `/var/lib/waypoint`. The database inside the container is:

```text
/var/lib/waypoint/waypoint.db
```

It is separate from `spike/data/waypoint.db` and any `.local/.../waypoint.db`. The image excludes local databases, backups, corpus files, mobile native output, Expo state, and `node_modules`.

## Build and run

From the repository root:

```bash
docker compose build
docker compose up
```

Open Northwood at `http://saas.localhost:18092`. Stop the foreground container with `Ctrl+C`.

For background operation:

```bash
docker compose up -d
docker compose logs -f
```

Stop it with:

```bash
docker compose down
```

This keeps the named volume. `docker compose down -v` intentionally erases the Docker-only database and is destructive.

## Mobile

Docker runs the backend only; the iOS simulator remains on the Mac. The normal mobile development configuration targets ports `8090–8092`, so it does not automatically use Docker's `18090–18092` ports. TestFlight builds are unaffected and continue to use the deployed public Northwood origin.

## Environment and safety

`docker-compose.yml` loads `spike/.env` for development secrets and sets the container origins and data directory. Do not commit `spike/.env`, mount a production database, or use `down -v` unless discarding Docker data is intentional.
