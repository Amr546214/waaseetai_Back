#!/usr/bin/env bash
# READ-ONLY server discovery for waseetai.com. NOT EXECUTED — to be run by the team on the VPS.
# Does not start/stop/restart/exec anything, does not read .env contents, does not print secrets.
# Does not run `docker inspect` / `docker exec` on any container, so bank / prod / wasit-bot are only listed by name.
set -u

echo "== 1. Hostname / host =="
hostname; uname -sr

echo; echo "== 2. Containers: name | image | ports | status (names only, no env) =="
docker ps -a --format '{{.Names}} | {{.Image}} | {{.Ports}} | {{.Status}}'

echo; echo "== 3. Listening TCP ports =="
ss -ltnH 2>/dev/null | awk '{print $4}' | sort -u
echo "-- watched ports (5008 5009 5010 8086 80 443 5432) --"
for p in 5008 5009 5010 8086 80 443 5432; do
  ss -ltnH 2>/dev/null | awk -v p=":$p" '$4 ~ p"$" {f=1} END {print (f ? "IN USE  " : "free    ") substr(p,2)}'
done

echo; echo "== 4. Nginx: server_name / listen / upstream / proxy_pass only =="
if command -v nginx >/dev/null 2>&1; then
  nginx -T 2>/dev/null | grep -E '^\s*(server_name|listen|upstream|proxy_pass|root)\b' | sed 's/^\s*//'
  echo "-- upstream blocks --"
  nginx -T 2>/dev/null | grep -n -E '^\s*upstream' -A3
  echo "-- enabled site files --"; ls -l /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null
else
  echo "nginx not found on host (may run in a container or another host)"
fi

echo; echo "== 5. Compose projects and their file paths (paths only) =="
docker compose ls -a 2>/dev/null
docker ps -a --format '{{.Names}}' | while read -r n; do
  :  # intentionally no inspect of containers
done

echo; echo "== 6. Volumes: name + size only =="
docker volume ls --format '{{.Name}}'
docker system df -v 2>/dev/null | sed -n '/Local Volumes space usage/,/^$/p'

echo; echo "== 7. .env locations: path / owner / group / mode only (contents NOT read) =="
for d in $(docker compose ls -a --format json 2>/dev/null | tr ',' '\n' | grep -o '"ConfigFiles":"[^"]*"' | cut -d'"' -f4 | xargs -r -n1 dirname | sort -u); do
  ls -l "$d"/.env* 2>/dev/null | awk '{print $1, $3, $4, $NF}'
done
echo "-- who can administer the server --"
getent group docker sudo 2>/dev/null
echo "(sudoers files: names only)"; ls /etc/sudoers.d 2>/dev/null

echo; echo "== 8. Optional: user COUNT only (uncomment ONLY for the correct prod DB container; run by the team) =="
# docker exec <POSTGRES_CONTAINER> sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM users;"'
# (table name may differ — check @@map in prisma/schema.prisma. Prints a number only.)
