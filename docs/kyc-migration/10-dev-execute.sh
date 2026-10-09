#!/bin/bash
# DEV ONLY — executes the approved legacy-KYC-asset migration in small batches (one table per batch). NOT committed.
# Per batch: rename in Cloudinary (public -> authenticated) -> check the OLD public URL is 401/404 -> apply the guarded DB update in one
# transaction (each statement must touch exactly 1 row) -> check counts -> check that the new private reference can be signed and downloaded.
# On ANY failure: stop at once and roll that batch back (04-rollback.js + 04-rollback-db SQL). Prints COUNTS only (no URLs, no references).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TS=$(date -u +%Y%m%dT%H%M%SZ)
SSHC=(ssh -i "$HOME/.ssh/waseet_vps_ed25519" -o IdentitiesOnly=yes root@46.202.173.40)
PG=wasit-pg-dev; DB=waseetai_db_dev; APP=waseetai-backend-dev
W=/root/retired/kyc-migration-exec-$TS
psqlq() { "${SSHC[@]}" "docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' $PG sh -c 'psql -U \"\$POSTGRES_USER\" -d $DB -At'" ; }
R() { "${SSHC[@]}" "$@"; }

echo "## 0 pre-flight"
R "umask 077; mkdir -p $W; chmod 700 $W; D=/root/retired/pre-kyc-execute-dev-$TS.dump; docker exec $PG sh -c 'pg_dump -U \"\$POSTGRES_USER\" -Fc -d $DB -t client_profiles -t provider_profiles -t client_onboarding -t users -t proof_attachments -t affiliate_profiles -t provider_accreditation_proofs -t certificates' > \$D; chmod 600 \$D; stat -c 'fresh dump: mode %a size %s' \$D"
cat "$HERE/01-inventory.sql" | R "docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' $PG sh -c 'psql -U \"\$POSTGRES_USER\" -d $DB -At -F \",\"' > $W/inventory.csv; chmod 600 $W/inventory.csv; echo inventory rows: \$(( \$(wc -l < $W/inventory.csv) - 1 )); echo distinct assets: \$(tail -n +2 $W/inventory.csv | cut -d, -f4- | sort -u | wc -l)"
tar -C "$HERE" -cf - lib.js 02-rename-to-authenticated.js 03-generate-db-update.js 04-rollback.js 2>/dev/null | R "tar -x -C $W 2>/dev/null; chmod 600 $W/*.js"

# private-reference counts of a table's KYC columns (before/after)
count_private() { # table
  case "$1" in
    client_profiles) echo "select count(*) filter (where \"frontIdUrl\" like 'private:%') + count(*) filter (where \"backIdUrl\" like 'private:%') + count(*) filter (where \"supportingDocsUrl\" like 'private:%') from client_profiles";;
    provider_profiles) echo "select count(*) filter (where \"frontIdUrl\" like 'private:%') + count(*) filter (where \"backIdUrl\" like 'private:%') + count(*) filter (where \"supportingDocsUrl\" like 'private:%') + coalesce((select count(*) from provider_profiles p, unnest(p.\"certUrls\") u where u like 'private:%'),0) from provider_profiles";;
    proof_attachments) echo "select count(*) filter (where \"fileUrl\" like 'private:%') from proof_attachments";;
  esac
}
count_legacy() {
  case "$1" in
    client_profiles) echo "select count(*) filter (where \"frontIdUrl\" like 'https://res.cloudinary.com/%') + count(*) filter (where \"backIdUrl\" like 'https://res.cloudinary.com/%') + count(*) filter (where \"supportingDocsUrl\" like 'https://res.cloudinary.com/%') from client_profiles";;
    provider_profiles) echo "select count(*) filter (where \"frontIdUrl\" like 'https://res.cloudinary.com/%') + count(*) filter (where \"backIdUrl\" like 'https://res.cloudinary.com/%') + count(*) filter (where \"supportingDocsUrl\" like 'https://res.cloudinary.com/%') + coalesce((select count(*) from provider_profiles p, unnest(p.\"certUrls\") u where u like 'https://res.cloudinary.com/%'),0) from provider_profiles";;
    proof_attachments) echo "select count(*) filter (where \"fileUrl\" like 'https://res.cloudinary.com/%') from proof_attachments";;
  esac
}

rollback() { # table appliedDb(0/1)
  echo "!! ROLLING BACK batch $1"
  R "cd $W && if [ $2 = 1 ]; then docker exec -i $PG sh -c 'psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d $DB' < rollback-$1.sql | grep -c 'UPDATE' | sed 's/^/db rollback statements applied: /'; fi
    docker exec $APP sh -c 'rm -rf /tmp/kycm; mkdir -p /tmp/kycm'; docker cp lib.js $APP:/tmp/kycm/; docker cp 04-rollback.js $APP:/tmp/kycm/; docker cp mapping-$1.csv $APP:/tmp/kycm/mapping.csv
    docker exec -w /tmp/kycm -e CONFIRM=yes -e NODE_PATH=/app/node_modules $APP node 04-rollback.js mapping.csv --execute 2>&1 | grep -c '^restored' | sed 's/^/assets restored: /'; docker exec $APP rm -rf /tmp/kycm"
}

batch() { # table expected-rows
  local T=$1 N=$2
  echo; echo "## batch $T (expected $N rows)"
  local priv0 leg0; priv0=$(echo "$(count_private $T)" | psqlq); leg0=$(echo "$(count_legacy $T)" | psqlq)
  echo "before: legacy public values $leg0, private references $priv0"
  [ "$leg0" = "$N" ] || { echo "STOP: legacy count $leg0 != expected $N (nothing changed)"; return 1; }
  # a) rename in Cloudinary (inside the dev backend container: it has the SDK and the credentials; files are removed afterwards)
  R "cd $W && awk -F, -v t=$T 'NR==1 || \$1==t' inventory.csv > batch-$T.csv
    docker exec $APP sh -c 'rm -rf /tmp/kycm; mkdir -p /tmp/kycm'; docker cp lib.js $APP:/tmp/kycm/; docker cp 02-rename-to-authenticated.js $APP:/tmp/kycm/; docker cp batch-$T.csv $APP:/tmp/kycm/
    docker exec -w /tmp/kycm -e CONFIRM=yes -e NODE_PATH=/app/node_modules $APP node 02-rename-to-authenticated.js batch-$T.csv --execute > /dev/null 2> err-$T.txt; echo exit=\$?
    docker cp $APP:/tmp/kycm/mapping.csv mapping-$T.csv 2>/dev/null; chmod 600 mapping-$T.csv; docker exec $APP rm -rf /tmp/kycm
    echo renamed: \$(awk -F, '\$6==\"RENAMED\"' mapping-$T.csv | wc -l) failed: \$(awk -F, '\$6 ~ /^FAILED/' mapping-$T.csv | wc -l)"
  local renamed; renamed=$(R "awk -F, '\$6==\"RENAMED\"' $W/mapping-$T.csv | wc -l")
  if [ "$renamed" != "$N" ]; then echo "STOP: renamed $renamed of $N"; rollback $T 0; return 1; fi
  # b) the OLD public URL must be 401/404
  local ok
  ok=$(R "cd $W; ok=0; for i in 1 2 3 4 5 6; do ok=0; while IFS=, read -r t c id old new st; do [ \"\$st\" = RENAMED ] || continue; code=\$(curl -s -o /dev/null -w '%{http_code}' \"\$old\"); case \$code in 401|404) ok=\$((ok+1));; esac; done < <(tail -n +2 mapping-$T.csv); [ \$ok = $N ] && break; sleep 10; done; echo \$ok")
  echo "old public URL answers 401/404: $ok of $N"
  [ "$ok" = "$N" ] || { echo "STOP: some old public URLs still answer"; rollback $T 0; return 1; }
  # c) guarded DB update in one transaction
  R "cd $W && node 03-generate-db-update.js mapping-$T.csv > update-$T.sql && mv 04-rollback-db.NOT-EXECUTED.sql rollback-$T.sql && chmod 600 update-$T.sql rollback-$T.sql"
  local out; out=$(R "cd $W && docker exec -i $PG sh -c 'psql -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d $DB' < update-$T.sql 2>&1 | tr '\n' ' '")
  local upd; upd=$(echo "$out" | grep -o 'UPDATE 1' | wc -l | tr -d ' ')
  echo "db update statements that touched exactly 1 row: $upd of $N; transaction: $(echo "$out" | grep -c COMMIT)"
  if [ "$upd" != "$N" ] || ! echo "$out" | grep -q COMMIT; then echo "STOP: db update did not apply cleanly"; rollback $T 0; return 1; fi
  # d) counts
  local leg1 priv1; leg1=$(echo "$(count_legacy $T)" | psqlq); priv1=$(echo "$(count_private $T)" | psqlq)
  echo "after: legacy public values $leg1 (expected 0), private references $priv1 (expected $((priv0+N)))"
  if [ "$leg1" != 0 ] || [ "$priv1" != "$((priv0+N))" ]; then echo "STOP: counts do not match"; rollback $T 1; return 1; fi
  # e) the new private reference can be signed (same function as /kyc-documents/access-link) and downloaded
  local dl
  dl=$(R "cd $W && cut -d, -f5 mapping-$T.csv | tail -n +2 | docker exec -i $APP node -e \"
const rl=require('readline').createInterface({input:process.stdin});const refs=[];rl.on('line',l=>l&&refs.push(l.trim()));
rl.on('close',async()=>{const {createPrivateDownloadUrl}=require('/app/dist/utils/cloudinary-storage');let ok=0;
for(const r of refs){const s=createPrivateDownloadUrl(r,120);if(!s)continue;const res=await fetch(s.url);if(res.status===200)ok++;}
console.log(ok);});\"")
  echo "signed 120 s link downloads (200): $dl of $N"
  [ "$dl" = "$N" ] || { echo "STOP: signed download failed"; rollback $T 1; return 1; }
  echo "batch $T OK"
}

batch client_profiles 8 || { echo "## STOPPED after a failure (rolled back). Nothing further was run."; exit 1; }
batch provider_profiles 15 || { echo "## STOPPED after a failure (rolled back). Earlier batches stay migrated and verified."; exit 1; }
batch proof_attachments 3 || { echo "## STOPPED after a failure (rolled back). Earlier batches stay migrated and verified."; exit 1; }
echo; echo "## all batches done"
echo "final legacy public values (all three tables): $(echo "$(count_legacy client_profiles)" | psqlq) / $(echo "$(count_legacy provider_profiles)" | psqlq) / $(echo "$(count_legacy proof_attachments)" | psqlq)"
echo "work dir (mapping + rollback SQL, mode 600): $W"
