# Notifications event matrix (Batch B / T5)

Gate legend. CLIENT = notification_preferences.settings (`inApp`/`channel_in_app` = real-time push, `email`/`channel_email` = mail; per-type toggles are NOT applied). PROVIDER = provider_profiles.preferences.notifChannels (`push`,`email`), else the shared CLIENT keys. MARKETER = shared keys + per-event switch (REFERRAL_JOINED=marketer_new_referral, COMMISSION_APPROVED=marketer_new_commission). The channel family is chosen by the actionUrl prefix (/client-overview, /marketer-overview, else provider/admin). The inbox row is ALWAYS stored; a disabled channel is not pushed/mailed. SMS and mobile-push keys control nothing (honest wording kept). CHAT is push only (never one mail per message).
Created = stored in the same transaction as the state change (tx.notification.create) and delivered after commit (deliverStored), or created after the committed write through a never-throwing sender. Test column: PG = src/services/pg-notifications-ratings-t5.pg.test.ts (real PostgreSQL), U = existing unit tests, S = notification.producers.static.test.ts.

| Event (type) | Code path | Recipient | Channel pref | actionUrl | Test |
|---|---|---|---|---|---|
| New offer (NEW_PROPOSAL) | proposal.service submit (tx + deliverStored). Dead preference-ignoring `notification_received` emit REMOVED | client | CLIENT | /client-overview/my-requests/:requestId | U, S |
| Project match (PROJECT_MATCH) | client-requests publish (createMany + deliverStored) | matching providers | PROVIDER | /provider-overview/explore-requests/:id/apply | U |
| Offer selected (OFFER_SELECTED) | client-requests.selectOffer | provider | PROVIDER | /provider-overview/offers | U |
| Negotiation requested / counter accepted | chat.service, client-offer-counter | provider | PROVIDER | /provider-overview/offers/:offerId/negotiate | U |
| Counter declined (OFFER_COUNTER_DECLINED) | client-offer-counter.decline (tx row) | provider | PROVIDER | /provider-overview/offers/:id/negotiate | U (row stored in tx; NOT pushed: see gaps) |
| Offer withdrawn / counter / negotiation declined | provider-offer-negotiation (tx + deliverStored) | client | CLIENT | /client-overview/my-requests/:requestId | U |
| Negotiation chat message (CHAT) | chat.gateway send_message, after sendMessage succeeded. FIXED: was a bare insert (never pushed, no category, no link); now createAndEmit with role-correct link | other party | per role family, push only | /client-overview/messages?conversationId= or /provider-overview/messages?conversationId= | S, PG(channels) |
| Funding (ESCROW_FUNDED) | client-requests.depositEscrow, after commit | client | CLIENT | /client-overview/projects/active | U |
| Accepted + funded, please sign (OFFER_ACCEPTED) | depositEscrow, after commit | provider | PROVIDER | /provider-overview/offers/:offerId/sign-contract | U |
| Signing (CONTRACT_SIGNED) NEW | provider.controller signContract, after the signing tx | client | CLIENT | /client-overview/projects/:projectId | PG (once; repeat+3 concurrent = 1) |
| Purchase paid (ORDER_PAID) | cart-checkout confirmPayment, after commit | client | CLIENT | /client-overview/projects/:id or /projects/active | U |
| Purchase received (SERVICE_PURCHASED) NEW | cart-checkout, after commit (one per item) | seller provider | PROVIDER | /provider-overview/projects/active/progress/:projectId | tsc, U regression |
| Deposit (FINANCIAL) | paypal-finance (tx + deliverStored) | client | CLIENT | /client-overview/finance/wallet | U |
| Delivery submitted (STAGE_DELIVERY) | project-progress.submitDelivery (tx + deliverStored) | client | CLIENT | /client-overview/projects/:id/delivery-review/:stageId | U |
| Stage approved / revision (STAGE_REVIEW, STAGE_APPROVED) | project-progress.reviewDelivery (tx + deliver) | provider + client | PROVIDER / CLIENT | provider progress/:projectId; client /client-overview/projects/:id | U |
| Project completed (PROJECT_COMPLETED / PROJECT_COMPLETION_REWARD) | reviewDelivery | client / provider | CLIENT / PROVIDER | client /projects/:id/rating; provider progress | U |
| Amendment requested/answered/cancelled (PROJECT_AMENDMENT) | project-amendment (tx rows + deliverStored; the two client-bound answers FIXED to the safe sender so a notification failure cannot fail a committed answer) | other party | CLIENT / PROVIDER | client /client-overview/projects/amendments; provider progress/:contractId | U, S |
| Dispute opened/resolved | dispute.service | both parties | CLIENT / PROVIDER | client /client-overview/disputes?dispute=:id; provider /provider-overview/disputes/:id | U |
| New dispute / ticket / withdrawal / KYC / suspicious payment (ADMIN_*) | admin-notifications.notifyAdmins (never throws) | active admins | shared keys | /supper-admin-overview/... | U |
| Rating received (RATING_RECEIVED) | rating.service after the review tx. CHANGED link | provider (client rated), client (provider rated) | PROVIDER / CLIENT | provider /provider-overview/projects/:id/rating (stage: progress/:id); client /client-overview/projects/:id/rating | PG (once, 409 retry adds none, 5 concurrent = 1) |
| Ticket (SUPPORT_TICKET) | support-ticket.notifyOwner | owner | by owner role | /{role}-overview/help/tickets/:id | U |
| Withdrawal states (WITHDRAWAL_*) | withdrawal/payout via provider or marketer helper | provider / marketer | PROVIDER / MARKETER | /provider-overview/finance/withdraw, /marketer-overview/withdraw | U |
| Referral joined / commission approved | marketer-notifications | marketer | MARKETER + per-event switch | /marketer-overview/referrals, /commissions | PG (switch off = stored only) |
| Approvals (KYC/SPECIALTY/ACCREDITATION decided, marketer KYC, affiliate request) | provider-notifications / admin services | owner | PROVIDER / MARKETER | profile/data, profile/specialties, accreditation-details/:id, /marketer-overview/profile(/requests) | U |
| Admin message (ADMIN_MESSAGE) | admin-users.sendMessage | user | by role | role-specific | U |

## Fixed in this batch
CHAT never reached an open session (bare insert) -> now delivered; amendment answers could 500 after commit; dead `notification_received`; missing CONTRACT_SIGNED and SERVICE_PURCHASED; rating links now open the rating inside the project; `GET /notifications` gained `since` (recovery, ISO date, `>=` so a same-ms tie is safe, 400 on garbage) and `unreadCount` (exact total); client reports average mixed provider->client reviews into the client's own ratings.

## Known gaps (not changed)
OFFER_COUNTER_DECLINED is stored in the transaction but not pushed/mailed (needs a deliverStored after commit in client-offer-counter, money-adjacent file left untouched). Providers whose offers lose to another selected offer get no notice. Dedupe on retry relies on the conditional transitions (409) of each flow; there is no generic idempotency key.
