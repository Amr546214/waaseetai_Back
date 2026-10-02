# حالة فيتشرز AI على dev — 2026-10-02

**المصدر:** جولة العمل بتاريخ 2026-10-02. كل بند مصنّف حسب كيف تم التحقق منه:
**[مختبر]** اختبرته بنفسي (logs أو استدعاء حي ببيانات اصطناعية من حاوية dev)، **[أكّده المالك]** أكّده اختبار يدوي من المالك، **[docs]** مأخوذ من `waseetai-vendor-blockers.md` ولم يُعَد اختباره في هذه الجولة.
لا يحتوي هذا الملف أي secret. التفاصيل الكاملة للعقود المطلوبة من WaseetAI في `docs/waseetai-vendor-blockers.md`.

## 1. المنشور على dev
| المكوّن | الـcommit على main | الصورة |
|---|---|---|
| Backend | `2670476` (دمج PR #6) | `waseetai-backend-dev:release-2670476` |
| Frontend | `affb8e7` (دمج PR #5) | `waseetai-frontend-dev:release-affb8e7` |

- `RUN_DB_PUSH=false` و`RUN_DB_MIGRATIONS=false`. لم يُنفَّذ أي migration أو db push في هذه الجولة.
- PR #7 و#8 و#9 توثيق فقط، فلا فرق في سلوك dev.
- **غير منشور بعد:** PR "ai-suggest requires both title and message" (Back #10)، بانتظار المراجعة.

## 2. PRs المدمجة
**Backend (`waaseetai_Back`):** #2 و#3 تشغيل كل AI عبر WaseetAI فقط وحذف Gemini المباشر · #4 إصلاح `/api/specialties/public` (500) · #5 `suggestedAdvantages` اختياري · #6 Step 3: مراجعة جودة العرض عبر `proposals/enrich` · #7 و#8 و#9 توثيق matching وportfolio/accreditation وbio.
**Frontend (`waaseetai_Front`):** #1 و#2 مواءمة الواجهة وحذف النصوص المزيفة · #3 حذف "ثقة AI" المحسوبة محليًا وشارات "دقة NN%" · #4 Step 3/4 مراجعة جودة فقط · #5 تعطيل زر اقتراح النبذة.

## 3. يعمل على dev
| الفيتشر | الحالة |
|---|---|
| اقتراح العرض `ai-suggest` | يعمل [مختبر: 200 في الـlogs]. يتجاهل `priceAudit` عمدًا. يحتاج عنوانًا ونصًا معًا (انظر القسم 6) |
| Step 3: مراجعة جودة العرض | يعمل [أكّده المالك]: درجة ووسم وملخص فقط، بلا سعر عادل ولا احتمال قبول |
| إرسال العرض وظهور التقييم والملخص للعميل | [أكّده المالك] |
| Setup test (15 سؤالًا + submit) | PASS [أكّده المالك]: نتيجة 87%، بلا "ثقة AI"، والمستوى يُعرض "حسب الدرجة" |
| Labels المطابقة | صادقة: "قواعد ثابتة (دون AI)" وبلا نسبة [الكود] |
| تنظيف fake claims | شارات "دقة NN%" وثقة AI والقيم الوهمية في payload التدقيق، مع static guards تمنع عودتها [مختبر: bundle] |

مسارات مسجّلة WIRED في docs ولم تُعَد اختبارها: project-description وtext enhance/suggest وmilestones وproject-analysis وrequest-draft وTTS وprofile/skills وperformance-summary وbusiness-models/audit وdisputes/summary، واختبار التخصص ذو الـ20 سؤالًا في `/profile/specialties`.

## 4. متعطل عمدًا من جهتنا
- **اقتراح النبذة (Bio):** الباك يرجع 503 `AI_FEATURE_UNAVAILABLE`، والزر معطّل بنص "اقتراح النبذة غير متاح حاليًا"، والتحرير اليدوي سليم.
- **تقييم عينات الاعتماد:** تُحفظ بحالة `MANUAL_REVIEW` بلا درجة AI.
- **Portfolio review وAccreditation review:** لا نستدعيهما.
- **Bebo والمساعد وAvatar:** خارج هذه الجولة (مسار منفصل).

## 5. Blocked عند WaseetAI — العقود المطلوبة
(المعايير والتفاصيل في `waseetai-vendor-blockers.md`)

1. **أمني — يمنع أي إطلاق (القسم 0):** التوكن ظاهر في PDF الدليل وفي صفحة اختبار عامة. المطلوب توكن جديد وإلغاء القديم، وإزالة الحرف الحرفي من الصفحة والدليل، وتوكنات منفصلة لكل بيئة (dev وbank وprod).
2. **Matching `matching/projects-for-provider` (2.1):** [مختبر ببيانات اصطناعية] يرجع دائمًا `proj-verified-1:90, proj-verified-2:88` مهما كان المزوّد أو المرشحون. المطلوب: مدخلات `provider` و`candidates` و`limit`؛ مخرجات معرفات من `candidates` فقط مع `aiMatchScore` 0–100 و`matchReasons` مشتقة من المدخلات و`generationSource` صادق. القبول: مجموعتان مختلفتان تعطيان ترتيبين مختلفين.
3. **Bio `profile/bio` (2.7):** [مختبر، 8 عينات] 3 خيارات + markdown + نصائح في الكل، منصة منافسة في 5، إنجازات مختلقة في 2، طول 1,065–1,860 حرفًا، ولا مفتاح طلب يتحكم بالشكل. المطلوب: نبذة واحدة نصًا عاديًا ضمن `maxLength` نرسله، بلا عناوين ولا نصائح ولا أسماء منصات ولا وقائع مختلقة. القبول: 10 استدعاءات متتالية.
4. **Portfolio review (2.8):** [مختبر] لا تقرأ العينات. المطلوب: `specialtyName` و`samples[{title, description, technologies[], projectUrl, githubUrl, attachments[]}]` والرد يشير للعينات بعناوينها.
5. **Accreditation review (2.9):** [مختبر] تحسّن (يرفض المستودع غير الموجود بدرجة 0 ويفحص الحقيقي) لكنه يعطي 25 دون فحص أي شيء، ويضيف `strengths` لمستودع غير موجود، و`aiQualityRating = "Acceptable"` حتى مع الصفر. المطلوب: `inspected` و`basis`، و`aiScore: null` وبلا `strengths` عند `inspected: false`، و`aiQualityRating: null` عند الرفض، وقيم حالات موثقة، وقبول `description` و`projectUrl`.
6. **`proposals/suggest` (2.10):** `priceAudit` ثابت. المطلوب: قبول `project: {budgetMin, budgetMax, title, requirements[]}` وحسابه منه.
7. **أخرى [docs]:** `marketplace/recommendations` ثابتة (2.2) · `project-fit` لا يرى المشروع (2.3) · `project-health` يخترع مراحل (2.4) · `delivery-review` بلا بيانات تسليم (2.5) · `proposals/audit/stream` بلا بيانات مشروع أو مزوّد (2.6)، ونستخدم `proposals/enrich` بدله · فحص العنوان مقابل التخصص يحتاج endpoint جديدًا (2.11c) · أسئلة Assessments المفتوحة (القسم 3) · Bebo: الـKB فارغة (القسم 4) · أزمنة p95 (القسم 5).

## 6. نقاط مفتوحة عندنا
1. **العنوان الفارغ في `ai-suggest`:** WaseetAI يرفض `currentTitle` الفارغ، وكان الباك يحوّله إلى 503. الإصلاح في Back PR #10 (400 واضح لكل حالة ناقصة، بلا مساس بالمسار الناجح). غير منشور بعد.
2. **ادعاءات AI تستحق مراجعة لاحقة:** "AI يتحقق من المستندات آلياً" في `profile-setup` · "AI يراجع تفاصيل المشروع…" في `step5-evaluation` · `showAiSuggest` الخاص بالعميل في `create-request` · الرقم `+ 2` في `provider-overview.html`.
3. **اختبارات الـfrontend:** الـsuite الكامل فيه 69 فشلًا في 28 ملفًا، ثابتة على `main` قبل تعديلات هذه الجولة (mocks ناقصة للـlocalStorage والـhttp في مواصفات مكوّنات قديمة).
4. `DRIVE_REVIEW_PLAN.md` معدّل محليًا في الـfrontend وغير مضموم.

## 7. توصية التنظيف لاحقًا (لم يُنفَّذ شيء منها)
**لا تنظيف الآن.** هذه توصية للتنفيذ بعد المراجعة، وكل خطوة تُراجَع قبل تنفيذها.

**أ. متغيرات بيئة حاوية `waseetai-backend-dev` — حذف مقترح**
`OPENAI_API_KEY` و`GEMINI_API_KEYS` و`GEMINI_KEY_COOLDOWN_MS`.
- السبب: بعد Back PR #2 لا يوجد أي مرجع لها في `src` أو `scripts` أو `prisma` أو `compose.yaml` أو `.env.example` (تحققت: 0 مراجع)، فهي أسرار غير مستخدمة تزيد سطح التسريب.
- الطريقة: إعادة إنشاء الحاوية (نمط release image نفسه) بـ`--env-file` بدونها، مع الإبقاء على بقية الـenv و`RUN_DB_PUSH=false` و`RUN_DB_MIGRATIONS=false`، ثم فحص `/health`. وقبلها يُفضَّل إلغاء/تدوير هذه المفاتيح عند مزوّديها لأنها كانت في بيئة dev.
- لا تحذف `WASEET_AI_BASE_URL` ولا `WASEET_AI_BEARER_TOKEN` ولا `WASEET_AI_STREAM_TIMEOUT_MS`.
- لا تمس متغيرات الدفع والبريد وغيرها في هذه الخطوة.

**ب. حاويات متوقفة على السيرفر (`srv675810`) — يمكن حذفها بعد استقرار dev (مثلًا بعد أسبوع)**
- `waseetai-backend-dev-old-{2b2337b, dcbe350, 6811ad4, f68ebbb}` و`waseetai-backend-dev-failed-2b2337b`.
- `waseetai-frontend-dev-old-{4944902, 5dadf07, 3d96120, 7b4543a}`.
- **ابقِ** `...-old-` الأحدث (backend `f68ebbb` / frontend `7b4543a`) كحدّ أدنى للتراجع حتى تُراجَع آخر نشرة.
- حاويات `*-rollback-*` و`*-pre-*` القديمة من نشرات سابقة (غير هذه الجولة): تُراجع بشكل منفصل، لا تُحذف دفعة واحدة.

**ج. ملفات البناء المؤقتة على السيرفر — آمنة للحذف**
`/root/build-be-dev-{dcbe350, 6811ad4, f68ebbb, 2670476}` · `/root/build-fe-dev-{5dadf07, 3d96120, 7b4543a, affb8e7}` · `/root/be.tgz, be2.tgz, be3.tgz, be4.tgz` · `/root/fe.tgz, fe2.tgz, fe4.tgz, fe5.tgz` · `/root/build-be*.log` و`/root/build-fe*.log`.
(مجلد المصدر الجديد يمكن إعادة إنشاؤه من `git archive main`.)

**د. لا تلمس:** `wasit-bot` (في حالة restart متكرر ولم يُفحص)، وحاويات bank وprod، وقواعد البيانات.
**هـ. الصور (images):** أبقِ صور `release-*` التي ما زالت تقف عليها حاويات التراجع، وأي `docker image prune` يكون بعد حذف الحاويات المذكورة فقط.
