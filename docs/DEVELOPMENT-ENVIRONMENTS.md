# Waypoint Development Environments

Each developer has a private local environment and SQLite database. Sales has
a separate demo server and persistent SQLite database. Application code is
shared; environment variables select origins, ports, and database location.

## Local developer setup

Get the latest code and create a feature branch:

    git clone https://github.com/ejackyv4/waypoint.git
    cd waypoint
    git switch main
    git pull --ff-only origin main
    git switch -c feature/<short-description>

Use Node 22 or newer because the server uses built-in `node:sqlite`.

Give every developer a different database directory, outside Git:

    mkdir -p "$PWD/.local/eric"

Start the services on localhost with your private database:

    HOST=localhost \
    WAYPOINT_DATA_DIR="$PWD/.local/eric" \
    APP_PORT=8090 CONTENT_PORT=8091 SAAS_PORT=8092 \
    node --env-file=spike/.env spike/api/server.mjs

The local URLs are `http://localhost:8090/console`,
`http://localhost:8090/learn`, and `http://localhost:8092`. Confirm the
database path printed at startup before using the application.

Never use another developer's database or the demo database. Reset only your
own environment, passing the same data directory used at startup:

    WAYPOINT_DATA_DIR="$PWD/.local/eric" ./spike/demo reset

The helper now honors `WAYPOINT_DATA_DIR` for both startup and reset. Verify
the path printed by the script before confirming a destructive reset.

`reset` restores the populated local baseline. To keep a subject's profile and
login but remove that subject's modules, documents, assignments, course
attempts, and activity, use the separate subject-scoped clean command. It
saves a safety snapshot first and defaults to Dana:

    ./spike/demo clean
    ./spike/demo clean cust-2298

`clean` does not alter the baseline or the catalog programs.

## Physical-phone testing

Browser development stays on localhost. A phone requires an explicit LAN
override:

    WAYPOINT_HOST=192.168.x.x ./spike/demo start

Keep the phone and computer on the same Wi-Fi network. Do not commit generated
machine-specific changes such as `spike/mobile/config.js`.

## Demo environment

The demo server uses a dedicated persistent directory and public origins. Its
service configuration should include values like:

    HOST=127.0.0.1
    WAYPOINT_BIND_HOST=127.0.0.1
    WAYPOINT_DATA_DIR=/var/lib/waypoint-demo
    WAYPOINT_APP_ORIGIN=https://waypoint.example.com
    WAYPOINT_CONTENT_ORIGIN=https://content.waypoint.example.com
    WAYPOINT_SAAS_ORIGIN=https://northwood.waypoint.example.com

The demo database is maintained by the deployment operator. Developers must
not copy local databases into it, change its data directory, or run local
reset commands against the demo host.

## Checks before sharing a change

    git status --short
    git diff --check
    npm test   # if the repository test script is present

Confirm startup output shows the intended origins and database path. Never
commit `.env` files, SQLite databases, generated documents, API keys, or
machine-specific IP configuration.

## Integration workflow

Before new work:

    git switch main
    git pull --ff-only origin main
    git switch -c feature/<short-description>

Before a pull request, update the feature branch from the team's integration
branch, resolve conflicts there, run the checks, and have another developer
review it. The demo server should pull reviewed commits only.
