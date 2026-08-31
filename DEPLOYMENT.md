# Waseet AI Backend — VPS deployment

## Port model

- API inside the Docker network: `5009`
- API exposed on the VPS: `5010` by default
- PostgreSQL: internal only (`5432`), not exposed to the internet

If `5010` is occupied, set another free port in `.env`:

```env
VPS_API_PORT=5011
```

The frontend must use the public API URL with that port, or preferably an Nginx HTTPS domain such as `https://api.example.com`.

## First deployment

```bash
cd waseetai-backend
cp .env.production.example .env
```

Edit `.env` and replace every placeholder. In particular, use a long URL-safe random value (letters and numbers only) for `POSTGRES_PASSWORD`, long random values for `JWT_SECRET` and `OTP_SECRET`, and configure the real frontend domain in `FRONTEND_URL` and `CORS_ORIGINS`. Compose builds the internal database URL using the `postgres` service name; do not use `localhost` in the container URL.

Then start the stack:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f api
```

Check the service:

```bash
curl http://127.0.0.1:5010/health
```

Expected response:

```json
{"success":true,"status":"ok","service":"waseetai-backend"}
```

## Updates

```bash
git pull
docker compose up -d --build
docker image prune -f
```

The API container applies committed Prisma migrations during startup. It fails fast if PostgreSQL is unavailable or migrations fail.

## Backup

Create a database backup before schema changes or upgrades:

```bash
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > backup-$(date +%F).sql
```

Keep `.env`, database backups, and uploaded secrets outside Git. The PostgreSQL data is stored in the `waseetai_postgres_data` Docker volume.

## Firewall / reverse proxy

When using Nginx, expose only ports `80/443` publicly and proxy to `127.0.0.1:5010`. If using the API port directly, allow only the required TCP port in the VPS firewall and do not expose PostgreSQL `5432`.

The repository includes an Nginx template at `deploy/nginx/waseetai-backend.conf.example`.
