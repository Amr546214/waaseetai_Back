# خطة نشر prod الرسمي — backend + frontend (main @ e0300ee)

> **خطة فقط. NOT EXECUTED.** يطبّقها الفريق على الـ VPS. لا أوامر هنا تُنفَّذ من جهاز التطوير.
> لا تلمس حاويات bank وdev وwasit-bot ولا قواعدها. لا تطبع أي قيمة سرية أثناء التنفيذ.

## 0) الوضع الحالي (من اكتشاف read-only)
- `api.waseetai.com` ← Nginx upstream `waseetai_backend` ← `127.0.0.1:15010` ← حاوية `waseetai-backend-live-amr-candidate` (صورة `waseetai-backend-live-amr:fda247d`، شبكة `waseetai-backend_waseetai`، بلا mounts، restart unless-stopped).
- `waseetai.com` و`www`: كتلتا 80 و443 فيهما `return 302 https://pmobs.com$request_uri;` ولا تخدمان frontend.
- قاعدة prod المرجّحة: `waseetai-backend-postgres-1` (postgres:16) على نفس الشبكة، volume `waseetai-backend_waseetai_postgres_data` (≈ 69.87MB). **غير مؤكد** أن candidate يستخدمها (قيمة `DATABASE_URL` لم تُقرأ).
- منفذا 15011 و8083: **حران** (تحقق بـ `ss` في هذه الجولة). أعد الفحص لحظة التنفيذ.
- `e0300ee` هو رأس `main` محليًا ("Merge PR #12 fix/sms-otp-no-code-logging-in-production")، ويتضمن إصلاح عدم تسجيل رمز OTP في production حين SMS معطّل.

## 0.5) بوابات ما قبل التنفيذ (Gates) — لا يبدأ أي تنفيذ قبل اكتمالها كلها
الحالة تعكس ما تحققت منه **فعليًا**. لم أنفّذ شيئًا منها على السيرفر لأنها تتطلب قراءة قيم env أو الاتصال بالقاعدة أو `docker exec`، وهذه خارج الأذونات الممنوحة.

| # | البوابة | الحالة | من ينفذ وكيف (دون طباعة أسرار) |
|---|---|---|---|
| G1 | تحديد مصدر env الحالي، أو إنشاء prod env جديد بصلاحيات 600 بنفس المفاتيح الحالية + `WASEET_AI_*` | **غير منفَّذة** (مصدر env الحالي ما زال مجهولًا) | الفريق. المفاتيح الحالية (أسماء فقط) مسجلة في الاكتشاف. أنشئ `/root/secure/waseetai-prod.env` بـ `umask 077` ثم `chmod 600`، خارج أي مجلد git ولا يُطبع محتواه. |
| G2 | `FRONTEND_URL` و`CORS_ORIGINS` و`API_PUBLIC_URL` تشمل `https://waseetai.com` (وwww إن لزم) | **جزئي** — `CORS_ORIGINS` يحتوي `https://waseetai.com` (✔). `FRONTEND_URL` و`API_PUBLIC_URL` لا يحتويانه (✘) ويجب تعديلهما في env الجديد | الفريق: اضبطها في ملف env الجديد. تحقق بـ `grep -c '^CORS_ORIGINS=.*waseetai.com' file` (يعيد عددًا لا قيمة). |
| G3 | token جديد من WaseetAI وإلغاء القديم المكشوف | **بانتظار المالك** | المالك: يولّد الجديد ويبطل القديم ويضعه مباشرة في ملف env (ليس في سطر الأوامر ولا في الدردشة). |
| G4 | backup لقاعدة prod | **غير منفَّذة** | الفريق: `pg_dump` من `waseetai-backend-postgres-1` إلى `/root/backups/` بصلاحيات 600، ثم تحقق الحجم > 0 واختبار استعادة على قاعدة مؤقتة. لا يتم الانتقال قبل ذلك. |
| G5 | schema diff للقراءة فقط بين main e0300ee وقاعدة prod قبل تشغيل أي candidate | **غير منفَّذة** | الفريق: من الصورة الجديدة على شبكة `waseetai-backend_waseetai` بـ `--env-file`: `npx prisma migrate diff` لطباعة SQL فقط (تحقق من صيغة الأمر على نسخة Prisma المستخدمة؛ المشروع يستخدم `prisma.config.ts`). لا `db push` ولا `migrate deploy`. أي `DROP` أو تغيير نوع عمود أو قيد unique على جدول فيه بيانات = **توقف وراجع**. |
| G6 | المنفذان 15011 و8083 حران | **مكتمل** — `PORT_15011=free` و`PORT_8083=free` (فحص قراءة فقط عبر ss) | الفريق: `ss -ltnH | awk '{print $4}' | grep -E ':(15011|8083)$'` يجب أن يعيد لا شيء. |
| G7 | خطة Nginx كاملة (القسم 3.3 أدناه) | **مكتوبة، لم تُجرَّب** | تُراجَع قبل التنفيذ و`nginx -t` شرط. |
| G8 | e0300ee هو الـ commit المبني | **تحققت محليًا** أنه رأس main | الفريق: ابنِ من checkout نظيف على `e0300ee`. |


### نتائج فحوص القراءة على candidate الحالي (`waseetai-backend-live-amr-candidate`) — yes/no فقط، لم تُطبع أي قيمة
```
PORT_15011=free
PORT_8083=free
FRONTEND_URL_HAS_WASEETAI_COM=no
CORS_ORIGINS_HAS_WASEETAI_COM=yes
API_PUBLIC_URL_HAS_WASEETAI_COM=no
WASEET_AI_BASE_URL_EXISTS=no
WASEET_AI_BEARER_TOKEN_EXISTS=no
WASEET_AI_STREAM_TIMEOUT_MS_EXISTS=no
RUN_DB_PUSH_KEYS_COUNT=2
RUN_DB_MIGRATIONS_KEYS_COUNT=2
RUN_DB_PUSH_ACCEPT_DATA_LOSS_EXISTS=yes
```
تعريف "yes" للروابط: يطابق `https://waseetai.com` أو `https://www.waseetai.com` فقط (قيمة dev.waseetai.com أو api.waseetai.com تُحسب no).

**المطلوب في env الجديد بناءً على هذه النتائج:**
- [ ] `FRONTEND_URL=https://waseetai.com` — **قرار مثبَّت**. تعديل مطلوب (الحالي لا يحتويه).
- [ ] `API_PUBLIC_URL=https://api.waseetai.com` — **قرار مثبَّت** (المقترح). تعديل مطلوب (الحالي لا يحتوي `https://waseetai.com`، ولا أعرف قيمته). يبقى `api.waseetai.com` عنوان الـ API العام.
- **تثبيت معماري:** كتلة `waseetai.com` في Nginx تبقى توجّه `/api/` و`/socket.io/` إلى الـ backend (القسم 3.3)، لأن الـ frontend prod يستخدم مسارات نسبية (`url_api: '/api'` و`socketUrl: '/'`). فالطلبات من المتصفح تذهب إلى waseetai.com نفسه (same-origin) ولا تستخدم `API_PUBLIC_URL`. و`api.waseetai.com` يبقى يعمل بالتوازي لعملاء آخرين وللروابط التي يبنيها الـ backend.
- [ ] `CORS_ORIGINS` — يحتوي `https://waseetai.com` حاليًا (✔). أبقِه، وتحقق من www إذا استُخدم.
- [ ] إضافة `WASEET_AI_BASE_URL` و`WASEET_AI_BEARER_TOKEN` (جديد) و`WASEET_AI_STREAM_TIMEOUT_MS=90000` — الثلاثة غير موجودة حاليًا.
- [ ] `RUN_DB_PUSH` و`RUN_DB_MIGRATIONS` ظهر كل منهما **مرتين** في الحاوية الحالية: في env الجديد يوضع كل مفتاح **مرة واحدة فقط**.
- [ ] القيم المقصودة في env الجديد: `RUN_DB_PUSH=false` و`RUN_DB_MIGRATIONS=false` و`RUN_DB_PUSH_ACCEPT_DATA_LOSS=false`. (هذه هي القيم المقررة. القيم الحالية في الحاوية لم أقرأها؛ الفحص أكد وجود المفاتيح وعددها فقط.)
- [ ] بعد إنشاء ملف env الجديد: تحقق بعدّ المفاتيح (`grep -c '^RUN_DB_PUSH=' file` ويجب أن يعيد 1) دون طباعة محتواه.

> لتشغيل G5 دون تشغيل تطبيق prod: لا تُشغّل candidate قبل نتيجة الـ diff؛ لأن إقلاع الـ API الجديد قد ينفّذ `prisma db push` (RUN_DB_PUSH). في env الجديد ضع `RUN_DB_PUSH=false` و`RUN_DB_MIGRATIONS=false` و`RUN_DB_PUSH_ACCEPT_DATA_LOSS=false` أول مرة، ولا تفعّل push إلا بعد مراجعة الـ diff واعتماد الفريق. (المتغيران ظهرا مكررين في env الحالي، فتأكد من القيمة الفعلية بعد الدمج.)

## 1) متطلبات قبل أي تنفيذ (مفتوحة)
- [ ] **مصدر env الحالي للحاوية غير معروف** (لا compose labels ولا mounts؛ غالبًا `docker run --env-file`). أحدد مكانه قبل البدء.
- [ ] `.env`/compose الخاص بـ prod لم يعد في `/root/waseetai-backend` (غير موجود الآن).
- [ ] **WASEET_AI_BEARER_TOKEN:** استخدم token **جديد** من WaseetAI. وأبطِل القديم. (لم أجد نمط token في docs المحلية بالبحث، لكن أكّد بنفسك أين كُشف ونظّف المصدر.)
- [ ] قيم env المطلوبة إضافتها: `WASEET_AI_BASE_URL` (الافتراضي في الكود: عنوان Cloud Run المعروف في `waseet-ai.config.ts` إن تُرك غير مضبوط) و`WASEET_AI_BEARER_TOKEN` و`WASEET_AI_STREAM_TIMEOUT_MS=90000`.
- [ ] **راجع قيم** `FRONTEND_URL` و`CORS_ORIGINS` و`API_PUBLIC_URL`: يجب أن تتضمن `https://waseetai.com` (وwww إن لزم) حين يُخدم الـ frontend هناك. أسماؤها موجودة في env الحالي لكن قيمها لم أرها.
- [ ] تأكد أن هذه غير موجودة/مضبوطة بأمان في prod: `ALLOW_TEST_CHECKOUT_WITHOUT_BALANCE` (غير موجود)، `RATE_LIMIT_ENABLED` ليس false، `PAYOUT_AUTOMATION_ENABLED` غير true، `SMS_ENABLED` غير true، Moyasar وPayPal sandbox (قرار سابق).
- [ ] نسخة احتياطية: `pg_dump` من `waseetai-backend-postgres-1` إلى مكان خارج الـ volume قبل أي شيء (انظر 2.0).
- [ ] تأكد من تأثير `RUN_DB_PUSH`: عند الإقلاع الجديد قد يغيّر السكيما على قاعدة prod. قبل ذلك راجع الفروق (إجراء قراءة فقط، مثل `prisma migrate diff` لطباعة SQL دون تنفيذه) وأبقِ `RUN_DB_PUSH_ACCEPT_DATA_LOSS=false`. التراجع على Nginx **لا** يعيد السكيما.

## 2) Backend: candidate جديد على 127.0.0.1:15011
**2.0 نسخة احتياطية (بعد موافقة الفريق):**
`docker exec waseetai-backend-postgres-1 sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > /root/backups/prod-$(date +%F-%H%M).sql` (وفق DEPLOYMENT.md). تحقق أن الملف غير فارغ.

**2.1 بناء الصورة من main e0300ee:**
- `git fetch && git checkout e0300ee` في نسخة نظيفة (لا تبنِ من شجرة فيها تعديلات).
- `docker build --target production -t waseetai-backend-live-amr:e0300ee .` (الـ Dockerfile فيه مرحلة production).
- تأكد أن `.dockerignore` يستثني `.env` (موجود).

**2.2 ملف env للـ candidate (بلا طباعة قيم):**
- أنشئ ملفًا بصلاحيات 600 خارج أي مجلد git (مثلًا `/root/secure/waseetai-prod.env`) من نفس مصدر env الحالي، أو من الحاوية القديمة بتصفية متغيرات الصورة (`PATH`/`NODE_VERSION`/`YARN_VERSION`) دون عرض المحتوى على الشاشة.
- أضف: `WASEET_AI_BASE_URL` و`WASEET_AI_BEARER_TOKEN` (الجديد) و`WASEET_AI_STREAM_TIMEOUT_MS=90000`، وحدّث CORS/FRONTEND_URL/API_PUBLIC_URL.
- لا تمرّر الـ token في سطر الأوامر (`-e TOKEN=...`) حتى لا يبقى في history أو `ps`.

**2.3 تشغيل candidate (دون إيقاف الحالي):**
```
docker run -d --name waseetai-backend-live-amr-e0300ee-candidate \
  --restart unless-stopped \
  --network waseetai-backend_waseetai \
  --env-file /root/secure/waseetai-prod.env \
  -p 127.0.0.1:15011:5009 \
  waseetai-backend-live-amr:e0300ee
```
- لا تحذف `waseetai-backend-live-amr-candidate` الحالية ولا توقفها (15010 يبقى جاهزًا للتراجع).
- راجع `docker logs --tail 50` للتأكد من نجاح الإقلاع. تحقق أن اللوغ لا يحتوي رمز OTP ولا أسرارًا.

**2.4 Health check:** `curl -fsS http://127.0.0.1:15011/health` يعيد `{"success":true,"status":"ok","service":"waseetai-backend"}`.

**2.5 Smoke test (بدون كشف secrets):**
- `/health` عبر 15011.
- نقطة AI واحدة: مثلًا `POST /…/tts` الذي يستخدم `waseetAiClient` (`src/routes/help-assistant-tts.routes.ts`). مسار الـ mount الكامل والـ guards (يحتاج مستخدمًا موثقًا) يُتحقق منها من `app.ts`. استخدم حسابًا اختباريًا، وأخفِ الـ Authorization من أي مخرجات. المتوقع نجاح الطلب، وأن غياب/خطأ token يعيد خطأ إعداد وليس تسريبًا.
- تأكد أن الاستجابة لا تتضمن قيمًا سرية.

**2.6 تحويل Nginx لـ api.waseetai.com من 15010 إلى 15011:**
- انسخ الملف احتياطيًا: `cp /etc/nginx/sites-available/api.waseetai.com /root/backups/api.waseetai.com.$(date +%F-%H%M)`.
- عدّل `upstream waseetai_backend { server 127.0.0.1:15011; ... }` فقط.
- `nginx -t` ثم `systemctl reload nginx` (reload وليس restart).
- تحقق: `curl -fsS https://api.waseetai.com/health`.

**2.7 Rollback للـ backend:** أعد `server 127.0.0.1:15010;` (أو استرجع النسخة الاحتياطية)، ثم `nginx -t` و`reload`. أبقِ حاوية 15011 للفحص أو أوقفها بعد التأكد. **تحذير:** إن غيّر الإقلاع الجديد السكيما، فالتراجع على Nginx لا يعيدها؛ الاستعادة تتطلب النسخة الاحتياطية.

## 3) Frontend: prod على 127.0.0.1:8083
**نقطة مهمة:** `environment.prod.ts` يستخدم `url_api: '/api'` و`socketUrl: '/'` نسبيين. لذلك كتلة `waseetai.com` في Nginx لا تكفي فيها `proxy_pass` للـ frontend فقط، بل يجب أيضًا توجيه `/api` و`/socket.io` (مع ترويسات WebSocket) إلى الـ backend، وإلا تفشل كل الطلبات.

**3.1 بناء frontend prod من main:**
- من الـ commit نفسه المختبَر على dev. الـ Dockerfile.dev يبني أصلًا بـ `--configuration=production`، لكن استخدم Dockerfile مخصصًا لـ prod ووسم الصورة بالـ commit (مثل `waseetai-frontend-prod:<sha>`). `npm ci` يفضَّل على `npm install --legacy-peer-deps` (قد يتطلب lockfile سليمًا).
- بعد البناء تحقق في الناتج أن `dev.waseetai.com` غير موجود وأن لا secrets مضمّنة (المعرّفات العامة فقط).
- تحقق أن معرّف PayPal sandbox المضمّن هو المقصود لـ prod.

**3.2 تشغيل:** `docker run -d --name waseetai-frontend-prod-<sha> --restart unless-stopped -p 127.0.0.1:8083:4200 waseetai-frontend-prod:<sha>` (لا تعدّل `waseetai-frontend-prod` الموجودة على 8082).
`curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8083/` يجب أن يعيد 200.

**3.3 تعديل Nginx لـ waseetai.com بدل redirect (النموذج النهائي المقترح):**
- احتفظ بنسخة من الملفين `sites-available/waseetai.com` و`waseetai.com-ssl` قبل التعديل.
- حافظ على مسارات شهادة SSL الموجودة في `-ssl` كما هي (لا تغيّرها ولا تطبع المفاتيح).
```nginx
# sites-available/waseetai.com  (port 80)  — redirect إلى HTTPS على نفس الدومين وليس pmobs.com
server {
    listen 80;
    listen [::]:80;
    server_name waseetai.com www.waseetai.com;
    return 301 https://waseetai.com$request_uri;
}

# sites-available/waseetai.com-ssl  (port 443)
server {
    listen 443 ssl;
    server_name waseetai.com www.waseetai.com;
    # ... أسطر ssl_certificate / ssl_certificate_key الحالية تبقى كما هي ...

    client_max_body_size 15M;

    # توحيد www على الدومين الأساسي (اختياري)
    if ($host = www.waseetai.com) { return 301 https://waseetai.com$request_uri; }

    # Frontend
    location / {
        proxy_pass http://127.0.0.1:8083;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Backend API
    location /api/ {
        proxy_pass http://waseetai_backend;   # نفس upstream الحالي (يشير إلى 15011 بعد التحويل)
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # Socket.IO / WebSocket
    location /socket.io/ {
        proxy_pass http://waseetai_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```
- ملاحظات: (أ) `proxy_pass http://waseetai_backend;` بدون `/` في آخره يُبقي المسار كما هو (`/api/...`)، وهو المطلوب. (ب) `if` لإعادة توجيه www اختياري ويمكن استبداله بكتلة منفصلة. (ج) الـ upstream `waseetai_backend` معرّف في ملف `api.waseetai.com`؛ تأكد أنه في سياق `http` يشمل كل الملفات (سيعمل ضمن `nginx -t`). وإلا عرّف upstream مماثلًا.
- يجب أن يبقى `$http_upgrade` صالحًا؛ إن لم يوجد `map $http_upgrade $connection_upgrade` عام فالصيغة أعلاه (Connection "upgrade") مطابقة لقالب api.
- بعد التعديل: `nginx -t` أولًا، وفقط عند النجاح `systemctl reload nginx`.
- تحقق: `curl -sI https://waseetai.com/` ← 200؛ `curl -sI http://waseetai.com/` ← 301 إلى `https://waseetai.com/`؛ `curl -fsS https://waseetai.com/api/health` (أو المسار الصحيح من app.ts) ← ok؛ اتصال WebSocket ناجح من المتصفح.
- أثر الانتقال: لن يُحوَّل waseetai.com إلى pmobs.com بعد الآن؛ تأكد أن هذا مقصود ولا يخص مالك pmobs.com.

**3.4 Rollback للـ frontend:** استرجع النسخة الاحتياطية من الملفين (redirect 302 إلى `https://pmobs.com$request_uri` على 80 و443)، ثم `nginx -t` و`reload`.

## 4) ترتيب التنفيذ المقترح
1. أسئلة القسم 1 + النسخة الاحتياطية.
2. backend candidate على 15011 ← health ← smoke.
3. تحويل api إلى 15011 ← مراقبة ← (rollback جاهز).
4. frontend على 8083 ← اختبار مباشر على 127.0.0.1:8083.
5. تحويل waseetai.com ← اختبار تسجيل دخول/دفع sandbox/WebSocket.
6. بعد الاستقرار: أبطل الـ token القديم، وأوقف `candidate` القديمة بعد فترة مراقبة.

## 5) ما لم يُتأكد منه
- قيم env الحالية، ومنها قاعدة البيانات التي يستخدمها candidate الحالي.
- مصدر env وأمر `docker run` الأصلي.
- مسار mount كامل لنقطة AI واحتياجات الـ guards.
- محتوى ملف `sites-available/api.waseetai.com` الكامل وشهادة waseetai.com.
- سبب وجود redirect إلى pmobs.com، ولمن يعود ذلك الدومين.
- حجم فرق السكيما بين الصورة الجديدة وقاعدة prod الحالية.
