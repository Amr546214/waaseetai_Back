# قائمة تحقق نشر الإنتاج — Waseet AI

> وثيقة محلية للفريق. لم يُنفَّذ أي شيء على prod أو السيرفر. كل البنود أدناه **NOT EXECUTED** ويطبّقها الفريق على الخادم.
> مصدر المعلومات: ملفات المستودع فقط (DEPLOYMENT.md, compose.yaml, .env.production.example). ما يعمل فعليًا على waseetai.com غير مؤكد.

## 0) أسئلة مفتوحة يجب أن يجيب عنها الفريق أولًا
- [ ] على أي خادم وأي حاويات يعمل prod حاليًا؟ وهل هو نفس الـ VPS الذي يستخدم المنفذين 5008 و5009 لـ backends أخرى؟
- [ ] هل لـ prod قاعدة بيانات فعلية؟ ما حجمها وما آلية النسخ الاحتياطي الحالية؟
- [ ] من يخدم الـ frontend على الدومين الرئيسي وكيف يُنشر؟
- [ ] هل `api.waseetai.com` مستخدم فعلًا؟
- [ ] أين تُحفظ أسرار prod ومن يملك صلاحية تعديلها؟
- [ ] لا تلمس حاويات bank أو prod الحالية أثناء التحضير.

## 1) المعمارية المخططة (حسب الملفات)
- [ ] حاوية `postgres` (postgres:16-alpine): داخلية فقط، لا يُكشف 5432، والبيانات في volume `waseetai_postgres_data`.
- [ ] حاوية `api` (Node 22، مرحلة production): 5009 داخليًا و`VPS_API_PORT` (الافتراضي 5010) على الـ VPS.
- [ ] Nginx كـ reverse proxy: منفذا 80/443 فقط للعامة، والتوجيه إلى `127.0.0.1:5010` (القالب في deploy/nginx/waseetai-backend.conf.example) مع WebSocket وحد رفع 15MB.
- [ ] تأكد أن 5010 غير مستخدم، وإلا غيّر `VPS_API_PORT`.
- [ ] جدار ناري: لا تفتح 5010 ولا 5432 للإنترنت إذا استُخدم Nginx.

## 2) ملف environment للإنتاج وبناء frontend مستقل
- [x] **تصحيح:** `environment.prod.ts` **موجود** في angular-app ويستخدم مسارات **نسبية**: `url_api: '/api'` و`socketUrl: '/'`. و`angular.json` فيه configuration `production` تستبدل `environment.ts` به (fileReplacements). فلا حاجة لإنشاء ملف جديد، ولا لكتابة دومين prod داخل الـ frontend.
- [ ] (بسبب المسارات النسبية) **شرط Nginx إلزامي:** الدومين الذي يخدم الـ frontend يجب أن يوجّه على نفس الدومين: `location /api/` و`location /socket.io/` إلى الـ backend (`127.0.0.1:5010`)، مع ترقية WebSocket لـ `/socket.io/` (`proxy_http_version 1.1` و`Upgrade`/`Connection`)، وباقي المسارات تخدم ملفات الـ frontend (مع `try_files $uri /index.html`). بدون ذلك تفشل كل طلبات الـ API والـ socket (تذهب إلى الـ frontend نفسه).
- [ ] تنبيه: قالب `deploy/nginx/waseetai-backend.conf.example` فيه `location /` واحد يوجّه كل شيء للـ backend، فهو يناسب دومينًا للـ API فقط؛ لا يصلح كما هو لدومين يخدم الـ frontend أيضًا. أضف locations منفصلة أو استخدم دومينًا فرعيًا للـ API (وحينها `url_api` النسبي لا يكفي).
- [ ] ابنِ نسخة prod مستقلة (`ng build --configuration production`) في مخرج منفصل عن بناء dev، ولا تعيد استخدام artifact بُني لـ dev.
- [ ] تحقق بعد البناء (بحثًا في dist) أن النص `dev.waseetai.com` غير موجود.
- [ ] تأكد أن البناء لا يحتوي أي secret (مفاتيح Moyasar السرية، PayPal secret، إلخ). المفتاح العام (publishable) فقط مسموح في الـ frontend.
- [ ] حدد من يخدم ملفات الـ frontend وأين تُنشر (سؤال مفتوح في البند 0).
- [ ] اضبط `FRONTEND_URL` و`CORS_ORIGINS` في الـ backend على دومين الـ frontend الفعلي.

## 3) حذف ALLOW_TEST_CHECKOUT_WITHOUT_BALANCE
- [ ] هذا المتغير موجود في `.env` الخاص بـ dev ويسمح بإتمام الدفع من المحفظة دون رصيد كافٍ، **بغض النظر عن NODE_ENV**.
- [ ] يجب ألا يكون موجودًا إطلاقًا في `.env` الخاص بـ prod (لا `true` ولا `false`: يُحذف السطر).
- [ ] تحقق: `grep -c ALLOW_TEST_CHECKOUT_WITHOUT_BALANCE .env` على الخادم يعطي 0.
- [ ] تحقق من الكود أن القراءة لا تتجاوز شروط الرصيد في prod (مراجعة محلية للمصدر قبل النشر).
- [ ] نفس الأمر لأي علم اختبار آخر: `RATE_LIMIT_ENABLED=false` ممنوع في prod (اتركه `true` أو غير مضبوط).

## 4) تأكيد أن مفاتيح dev لا تُنسخ إلى prod
ملف dev المحلي `.env` يحتوي مفاتيح حقيقية (Moyasar، Cloudinary، SMTP، OpenAI، Gemini، Waseet AI bearer، POSTGRES_PASSWORD، JWT_SECRET).
- [ ] ابدأ ملف prod من `.env.production.example` فقط، وليس بنسخ `.env` الحالي.
- [ ] `JWT_SECRET` و`OTP_SECRET`: قيمتان جديدتان ومختلفتان (64 حرفًا فأكثر) ولا تتكرران من dev.
- [ ] `POSTGRES_PASSWORD`: عشوائية طويلة بأحرف وأرقام فقط.
- [ ] Moyasar: **قرار حالي: يبقى sandbox على prod** (مفاتيح `pk_test`/`sk_test` معًا، ولا `pk_live` الآن). لكن لا تنسخ مفاتيح dev نفسها؛ أنشئ/استخدم مفاتيح test مخصصة لـ prod إن أمكن، ولا تخلط test مع live.
- [ ] PayPal: **قرار حالي: يبقى sandbox** (`PAYPAL_ENV=sandbox`). `PAYPAL_CLIENT_SECRET` و`PAYPAL_WEBHOOK_ID` لا يصلان للـ frontend. webhook الخاص بـ prod يحتاج تسجيلًا جديدًا في لوحة PayPal sandbox باسم دومين prod.
- [ ] Cloudinary وSMTP وGoogle وGemini: حسابات/مفاتيح خاصة بـ prod.
- [ ] تأكد أن `.env` و`.env.*` و`*.zip` لا تدخل صورة Docker (راجع `.dockerignore`) ولا Git ولا الأرشيفات التي تُرسل للفريق.
- [ ] الأرشيفان `WaseetAI-Frontend.zip` و`BeboAI-Ready.zip` لم يُفحصا؛ افحصهما قبل تسليمهما لأي جهة.
- [ ] إن ظهرت مفاتيح dev في أي قناة مشاركة سابقة، دوّرها (rotate).
- [ ] بعد الإعداد: قارن أسماء المتغيرات (وليس القيم) بين `.env.production.example` و`.env` على الخادم، وتحقق يدويًا أن كل قيمة مختلفة عن dev.

## 5) فروق الإعدادات dev مقابل prod
| البند | dev | prod |
|---|---|---|
| NODE_ENV | dev | production |
| RATE_LIMIT_ENABLED | معطّل مؤقتًا | true / غير مضبوط |
| AUTH_RATE_LIMIT_MAX / WINDOW_MS | قد يُرفع | 10 / 3600000 |
| ALLOW_TEST_CHECKOUT_WITHOUT_BALANCE | موجود | محذوف |
| Moyasar | test | test (قرار: لا pk_live الآن) |
| PayPal | sandbox | sandbox (قرار) |
| DATABASE_URL | localhost | postgres الداخلي (يبنيه compose) |
| FRONTEND_URL / CORS_ORIGINS / API_PUBLIC_URL | dev.waseetai.com | دومينات prod |
| PAYOUT_AUTOMATION_ENABLED | — | false (لا migration لجداول payout_attempts وpaypal_webhook_events) |
| AFFILIATE_COMMISSION_ENGINE_ENABLED | — | false حتى يُحسم سؤال USD مقابل SAR |
| SMS_ENABLED | — | false (لا نحتاج SMS للإطلاق؛ الرمز لا يُسجَّل في production) |
| RUN_DB_MIGRATIONS | — | false |
| RUN_DB_PUSH | — | true (db push دون قبول فقدان بيانات) |
| RUN_DB_PUSH_ACCEPT_DATA_LOSS | — | false |

## 6) قاعدة البيانات وتغيير المخطط
- [ ] المخطط يُزامَن بـ `prisma db push` لأن سلسلة migrations القديمة غير آمنة على قاعدة جديدة. أبقِ `RUN_DB_MIGRATIONS=false`.
- [ ] `RUN_DB_PUSH_ACCEPT_DATA_LOSS=true` فقط عند أول تهيئة لقاعدة **فارغة ومؤكدة**، ثم يُعاد إلى false وتُعاد تهيئة حاوية الـ API.
- [ ] أي تغيير مخطط على قاعدة فيها بيانات: خذ نسخة احتياطية أولًا وراجع تحذير Prisma.
- [ ] لا ننفذ SQL/migration مباشرة من الجهاز المحلي على أي خادم. نكتب السكيما والـ SQL محليًا ونعلّمها NOT EXECUTED، والفريق يطبقها على السيرفر.

## 7) خطة الأدمن الأول
- [ ] ضع `SEED_ADMIN_EMAIL` (بريد حقيقي للمالك لا example.com) و`SEED_ADMIN_PASSWORD` (12 حرفًا فأكثر، عشوائية) في `.env` على الخادم فقط.
- [ ] نفّذ على الخادم: `docker compose exec api npm run db:seed` (آمن للتكرار؛ يحدّث الأدمن بنفس البريد دون تكرار).
- [ ] تحقق من تسجيل الدخول بالأدمن ثم **غيّر كلمة المرور فورًا** من النظام.
- [ ] احذف `SEED_ADMIN_PASSWORD` من `.env` بعد نجاح الإنشاء، وأعد تهيئة حاوية الـ API.
- [ ] لا تضع كلمة مرور حقيقية في `prisma/seed.ts` ولا في Git ولا في المحادثات.
- [ ] وثّق من يملك حساب الأدمن الأول وخطة استرجاعه.
- [ ] إن كانت القاعدة تحتوي أدمنًا بالفعل، تحقق أن seed لن يغيّر كلمة مروره بالخطأ (يحدّث بحسب البريد).

## 8) النسخ الاحتياطي
- [ ] قبل أي نشر أو تغيير مخطط:
  `docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > backup-$(date +%F).sql`
- [ ] خزّن النسخة خارج الخادم وخارج Git، ومشفّرة إن أمكن.
- [ ] اختبر الاستعادة على بيئة منفصلة (ليست prod) مرة واحدة على الأقل.
- [ ] حدد جدولة تلقائية (cron) وفترة احتفاظ؛ حاليًا لا يوجد ما يدل على جدولة.
- [ ] انسخ أيضًا `.env` الخاص بـ prod إلى مخزن أسرار آمن (ليس داخل نفس مخزن نسخ القاعدة).
- [ ] تذكّر أن volume `waseetai_postgres_data` يضيع إذا حُذف مع `docker compose down -v`؛ لا تستخدم `-v` على prod.

## 9) خطوات النشر المقترحة (للتنفيذ من الفريق)
1. [ ] أكمل البند 0 وتأكد من المنفذ والدومين.
2. [ ] جهّز `.env` من `.env.production.example` (البنود 4 و5).
3. [ ] خذ نسخة احتياطية إن كانت هناك قاعدة موجودة (البند 8).
4. [ ] `docker compose up -d --build` ثم `docker compose ps` و`docker compose logs -f api`.
5. [ ] `curl http://127.0.0.1:5010/health` يجب أن يعيد `{"success":true,"status":"ok","service":"waseetai-backend"}`.
6. [ ] أنشئ الأدمن الأول (البند 7).
7. [ ] اضبط Nginx وHTTPS (Certbot) وأعد التحقق من 80/443 فقط.
8. [ ] انشر frontend prod المبني (البند 2) واختبر: تسجيل دخول، دفع Moyasar بمبلغ صغير، WebSocket.
9. [ ] راجع اللوغ بحثًا عن أخطاء، وتأكد أن رمز OTP لا يظهر في اللوغ (مُصلَح في PR #12 للـ SMS؛ بقية المسارات تسجّل الرمز فقط عند NODE_ENV=development).

## 10) التحقق النهائي قبل الإعلان
- [ ] لا وجود لـ `dev.waseetai.com` في أي مكان بالـ frontend أو الإعدادات.
- [ ] لا وجود لمتغيرات الاختبار (ALLOW_TEST_CHECKOUT_WITHOUT_BALANCE، RATE_LIMIT_ENABLED=false).
- [ ] 5432 غير مكشوف (فحص من خارج الخادم).
- [ ] Moyasar وPayPal في وضع sandbox/test عن قصد، ولا يوجد أي `pk_live`/`sk_live` على السيرفر.
- [ ] نسخة احتياطية حديثة موجودة ومُجرَّبة الاستعادة.
- [ ] حاويات bank وprod القائمة لم تتأثر (لم تُمَس أثناء التحضير).

## 11) إضافات المهمة التحضيرية (نقل dev إلى waseetai.com)

### أ) OTP/SMS (محسوم: لا نحتاج SMS للإطلاق)
- التسجيل يتطلب **OTP بريد فقط** (`registerUser` ينشئ OTP نوع EMAIL، والحساب يبقى PENDING_VERIFICATION حتى `verifyOtp`). رقم الجوال لا يُرسل له رمز، وتحقق الصيغة فقط.
- OTP الهاتف (`OtpType.PHONE`) يُطلب عند الدخول فقط إذا كان `phoneOtpEnabled=true`. الافتراضي `false` ولا يوجد كود يفعّله، فلا أحد يمر به. لذلك لا حاجة لمزود SMS قبل الإطلاق، وتبقى `SMS_ENABLED=false`.
- تأكيد التعديلات الحساسة للمزوّد (`requiresOtp` في provider-profile.service.ts) هو أيضًا OTP بريد.
- [ ] **المطلوب: SMTP خاص بـ prod** (حساب/مفاتيح مستقلة عن dev). بدونه لا يصل رمز التفعيل ولا رمز إعادة تعيين كلمة المرور ولا رمز التعديلات الحساسة. اختبر على prod: تسجيل جديد ← وصول الرمز ← التفعيل.
- [x] الرمز لم يعد يُطبع في اللوغ عند `NODE_ENV=production` (PR #12، مدموج في main). تحقق مع ذلك أن `NODE_ENV=production` مضبوط فعلًا على prod.
- [ ] لا تفعّل `phoneOtpEnabled` لأي مستخدم على prod قبل ربط مزود SMS (`sendSmsViaTwilio` غير مكتوب).

### ب) الـ frontend: بناء مستقل لـ prod
- ملف `environment.prod.ts` والمسارات النسبية وشرط Nginx لـ `/api` و`/socket.io`: انظر البند 2 (مصحَّح).
- [ ] `Dockerfile.dev` يبني أصلًا بـ `--configuration=production` (رغم تعليقه) ويخدم عبر nginx داخل الحاوية على 4200. ربط 8086 غير موجود في الملفات المحلية، ويجب تأكيده من الخادم.
- [ ] أنشئ Dockerfile.prod (أو build arg) يبني من نفس الـ commit الذي اختُبر على dev، مع `npm ci` بدل `npm install --legacy-peer-deps` إن أمكن، ويحمل وسم الـ commit في اسم الصورة.
- [ ] ملاحظة: `environment.prod.ts` يحتوي معرّفات عامة (Google client id وPayPal sandbox client id) وليست أسرارًا، لكن تأكد أن PayPal client id المضمَّن هو للحساب المقصود لـ prod.

### ج) قاعدة prod فاضية: ما يجب أن تبدأ به
القرار: لا نسخ من dev. التصنيف أدناه **مبني على أسماء الجداول وعلى seed/الخدمات فقط** ولم أقرأ كل نموذج بالتفصيل. (اقتراح فقط، لا SQL ولا استخراج.)
- **(أ) مرجعية:** `Category` و`Specialty` (يملأها `npm run seed:taxonomy` وهو idempotent)؛ حساب SUPER_ADMIN في `User` (عبر `npm run db:seed`).
- **(ب) بيانات مستخدمين، تبقى فاضية:** User (عدا الأدمن)، UserSession، OtpVerification، ClientProfile، ProviderProfile، ProfileChangeRequest، ProfileModificationRequest، PortfolioItem، Education، Certificate، ProviderSpecialty، WorkSample، ProofAttachment، Project، SavedProject، Proposal، ProposalAttachment، ProjectProposal، ProposalMilestone، Escrow، ServiceCatalog، ServiceStage، Cart، CartItem، Order، OrderItem، MarketplaceFavorite، CouponRedemption، SpecialOfferRedemption، Review، PointTransaction، ProviderGamification، AccountAuditLog، AiAuditLog، Notification، NotificationPreference، SupportTicket، SupportTicketMessage، Conversation، Message، Contract، ProjectAmendment، ProjectStage، StageDelivery، Dispute، Withdrawal، PayoutAttempt، PaypalWebhookEvent، PaypalPayment، WalletTransaction، ClientOnboarding، ClientRequest، NewsletterSubscriber، CompanyTeamMember، AccreditationSubmission، AccreditationProofFile، AiAccreditationAuditLog، AssessmentAttempt، ProviderSkillAssessment، وجداول الأفيليت (AffiliateProfile، AffiliateChannelHandle، Referral، CommissionLog، AffiliateChannelMetric، ReferralCustomLink).
- **(ج) غير واضحة، تحتاج قرار:**
  - `GamificationRule`: `gamification.service.ts` ينشئ القواعد الافتراضية تلقائيًا عند أول قراءة إن كان الجدول فارغًا، فغالبًا لا يحتاج seed (غير مؤكد).
  - `Skill`: هل هو كتالوج مهارات مرجعي أم مهارات مرتبطة بكل مزوّد؟
  - `Question` و`AccreditationSample`: هل هي أسئلة/عينات تقييم واعتماد مرجعية يجب أن تبدأ بها prod؟
  - `Coupon` و`CouponService` و`SpecialOffer`: يُنشئها الأدمن؛ الأرجح تبدأ فاضية.
- [ ] تحقق من `seed-e2e.ts` و`seed-visual-audit.ts` و`seed-local-chat.ts`: **لا تُشغَّل على prod** (بيانات اختبار).
- [ ] Skill وQuestion: كُتب سكربتان محليًا **(NOT EXECUTED)** في `scripts/reference-data/`: `export-skills-questions.ts` (قراءة فقط من dev، يربط كل سؤال بـ `Specialty.slug` لا بالـ ID) و`import-skills-questions.ts` (يُشغَّل على prod **بعد** `seed:taxonomy`، آمن للتكرار: Skill بالاسم الفريد وQuestion بالتخصص+النص، ولا يعدّل ولا يحذف، ويدعم `--dry-run`). راجع ملف JSON الناتج قبل نقله. AccreditationSample تبقى فاضية.
