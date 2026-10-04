# Runbook (DEV, on the server) — Client PayPal migration

Migration: `20261004120000_add_client_paypal_payout_email`
SQL: `ALTER TABLE "client_profiles" ADD COLUMN "paypalPayoutEmail" TEXT;` (additive, nullable, no data change)
Run everything **on the server itself**. Do NOT run from a laptop. Do not touch prod.

## 1. Code version
```
cd <backend dev checkout> && git fetch && git checkout main && git pull
git rev-parse --short HEAD        # must be 18ff50d (merge of PR #13)
```

## 2. Backup (before any change)
```
docker exec wasit-pg-dev pg_dump -U <user> -Fc <db> > ~/backups/dev-pre-client-paypal-$(date +%F-%H%M).dump
ls -lh ~/backups/dev-pre-client-paypal-*.dump     # non-empty
```

## 3. Status
```
npx prisma migrate status
```
- Only `20261004120000_add_client_paypal_payout_email` pending -> go to 4.
- Any OTHER pending migration (or drift/failed) -> **STOP, apply nothing**, report the output.

## 4. Apply
```
npx prisma migrate deploy
npx prisma migrate status         # "Database schema is up to date"
```

## 5. Verify column
```
docker exec wasit-pg-dev psql -U <user> -d <db> -c \
 "SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_name='client_profiles' AND column_name='paypalPayoutEmail';"
```
Expect one row: text / YES.

## 6. Deploy backend dev from 18ff50d
Rebuild/restart the dev backend container from that commit (keep the previous image/container as rollback).
`npx prisma generate` must run in the build so the client knows the new column.

## 7. curl checks (client test account; `$T` = its Bearer token, `$B` = dev API base)
```
curl -s $B/api/health                                              # {"success":true,...ok}

# save
curl -s -X PUT $B/api/profiles/update/banking -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"paypalPayoutEmail":"Test.Client@example.com"}'             # 200, message "تم حفظ بريد PayPal بنجاح"
curl -s $B/api/profiles/me -H "Authorization: Bearer $T"           # currentProfileData.paypalPayoutEmail = test.client@example.com
curl -s $B/api/client/profile/setup -H "Authorization: Bearer $T"  # data.paypalPayoutEmail set, data.paymentType = "paypal"

# invalid rejected
curl -s -X PUT $B/api/profiles/update/banking -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"paypalPayoutEmail":"bad"}'                                 # 400

# clear
curl -s -X PUT $B/api/profiles/update/banking -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"paypalPayoutEmail":null}'                                  # 200
curl -s $B/api/client/profile/setup -H "Authorization: Bearer $T"  # paypalPayoutEmail null, paymentType null (not "paypal")

# setup with PayPal (no bank fields)
curl -s -X POST $B/api/client/profile/setup -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"details":{"idNumber":"1234567890"},"identity":{},"bank":{"paymentType":"paypal","paypalPayoutEmail":"test.client@example.com"},"documents":{},"agreements":{"accurate":true,"terms":true,"privacy":true}}'
                                                                   # 200, data.paypalPayoutEmail set, paymentType "paypal", iban/accountHolder unchanged
```
Also check: `bank.paymentType="paypal"` with a bad/missing email -> 400.
Use a throwaway test client; setup writes KYC fields (idNumber etc.) on that account.

## 8. Report back (all 9 items required)
1. Backup file name and size.
2. `prisma migrate status` output BEFORE applying.
3. Confirmation that the only pending migration was `20261004120000_add_client_paypal_payout_email`.
4. `prisma migrate deploy` output.
5. `prisma migrate status` output AFTER applying.
6. Column check: `client_profiles.paypalPayoutEmail` exists, type `text`, nullable.
7. Deployed backend dev commit / image / container (must be from `18ff50d`).
8. All curl results, especially: save PayPal; invalid email = 400; clear (null) makes `paypalPayoutEmail` AND `paymentType` null; `/profiles/me` returns `paypalPayoutEmail`; `/client/profile/setup` returns `paypalPayoutEmail` + `paymentType`; setup accepts `paymentType=paypal` + email and rejects missing/bad email.
9. Rollback image/container ready (name).

After the team confirms, the frontend PR is opened (paypalSaveSupported=true, client onboarding step 3 -> PayPal, save/edit/setup tested against the real dev backend).
