# Deploying tally to Hetzner via Dokploy

## What to create in Dokploy

**One Application.** Not a database service — the database is a SQLite file on
a volume. Not a second service for the nightly sync — it runs in-process inside
the same container.

1. **Create → Application**, source = this Git repository, branch `main`.
2. **Build type: Dockerfile** (the repo root `Dockerfile`). Nothing else to
   configure; the image builds `dist/` and drops dev dependencies.
3. **Environment** — paste every value from your local `.env`, with these
   overrides:

   ```
   DB_PATH=/data/finmcp.db
   PORT=8787
   CRON_ENABLED=true
   CRON_HOUR=4
   CRON_MINUTE=15
   ```

   `MCP_SECRET` must be the same value you will put in the connector URL.
   Set `TOKEN_ENC_KEY` (`openssl rand -hex 32`) here too — the first boot
   encrypts the stored Plaid access tokens in place, and the migration is
   idempotent.

4. **Volumes → Volume Mount**, mount path `/data`. This holds the database,
   `sync.log` and `backups/`. Without it, every redeploy loses the Plaid access
   tokens and you would have to re-Link all ten banks.
5. **Domain**, e.g. `tally.yourdomain.com`, container port **8787**, HTTPS on
   (Dokploy/Traefik handles the certificate).
6. **Health check** path `/health`. The image also carries a `HEALTHCHECK`.
7. **Do not expose port 8788.** The Plaid Link helper is deleted from the image
   and never runs on the server.

## Carrying the Plaid tokens over

Link the banks locally first (`npm run link`), then copy the database onto the
volume once. Do **not** re-Link on the server.

```bash
# stop the app in Dokploy first, then:
scp data/finmcp.db root@<host>:/var/lib/dokploy/volumes/<volume>/finmcp.db
```

Adjust the destination to whatever Dokploy reports as the volume's host path.
Start the app and check `/health` returns a non-zero `accounts` count.

## Verifying the nightly sync

The scheduler logs one line per run to `/data/sync.log`:

```bash
docker exec -it <container> tail -n 20 /data/sync.log
```

Expect a line the morning after deploy with per-source results and the backup
file that was written. `sync_report` returns the same information through MCP,
including an `age_hours` and a `stale` flag, so Claude can say how fresh the
numbers are before answering.

Backups land in `/data/backups/finmcp-YYYY-MM-DD.db`, 14 days retained
(`BACKUP_KEEP_DAYS`).

## Adding it to Claude

Claude.ai → **Settings → Connectors → Add custom connector**:

```
https://tally.yourdomain.com/mcp/<MCP_SECRET>
```

The secret in the path is the whole auth model, so treat that URL as a
credential. A wrong secret returns a plain `404`, and the route is rate limited
to `MCP_RATE_LIMIT` requests per minute per IP.

Then try:

- "what's my net worth"
- "show my holdings concentration"
- "plaid status"
- "how much RRSP room do I have left"

## Local parity

```bash
docker compose up --build
curl localhost:8787/health
```
