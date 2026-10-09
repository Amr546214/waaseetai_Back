import type { Application } from 'express';

type ExpressLayer = {
	name?: string;
	path?: string;
	regexp?: { source?: string };
	__swaggerPath?: string;
	route?: {
		path: string;
		stack?: Array<{ method?: string }>;
		methods?: Record<string, boolean>;
	};
	handle?: { stack?: ExpressLayer[] };
};

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

function normalizePath(path: string): string {
	const normalized = `/${path}`.replace(/\/+/g, '/').replace(/\/$/, '');
	return normalized === '/' ? '/' : normalized;
}

/**
 * Paths in this document already include the canonical /api prefix. The
 * server URL must therefore point to the host root; otherwise Swagger UI
 * concatenates both values and calls /api/api/*.
 */
function normalizeServerUrl(value: string): string {
	return value.replace(/\/+$/, '').replace(/\/api$/i, '') || '/';
}

function mountedPath(layer: ExpressLayer): string {
	if (layer.__swaggerPath) return layer.__swaggerPath;
	if (layer.path) return layer.path;

	const source = layer.regexp?.source || '';
	// Express serializes mounted paths as /^\\/prefix(?:\\/(?=$))?(?=\\/|$)/i.
	const match = source.match(/^\^\\?\/(.+?)(?:\(\?:|\/?\$|\(\?=)/);
	return match?.[1] ? `/${match[1].replace(/\\\//g, '/')}` : '';
}

function routeParameters(path: string) {
	return Array.from(path.matchAll(/:([A-Za-z0-9_]+)/g)).map((match) => ({
		name: match[1],
		in: 'path' as const,
		required: true,
		schema: { type: 'string' }
	}));
}

function operationFor(method: string, path: string) {
	const tag = path.split('/').filter(Boolean)[1] || 'system';
	const requestSchema = requestSchemaFor(path, method);
	const successStatus = method === 'post' && /\/auth\/register$|\/projects$|\/projects\/[^/]+\/proposals$|\/client\/requests$|\/portfolio$|\/ref-links\/custom$|\/channels$|\/cart\/items$|\/checkout\/order$|\/provider\/coupons$/.test(path) ? '201' : '200';
	const responseSchema = responseSchemaFor(path, method);
	const operation: Record<string, unknown> = {
		tags: [tag],
		operationId: `${method}_${path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root'}`,
		summary: `${method.toUpperCase()} ${path}`,
		parameters: routeParameters(path),
		responses: {
			[successStatus]: {
				description: 'Successful response',
				content: { 'application/json': { schema: responseSchema ? { allOf: [{ $ref: '#/components/schemas/ApiSuccess' }, { type: 'object', properties: { data: { $ref: `#/components/schemas/${responseSchema}` } } }] } : { $ref: '#/components/schemas/ApiSuccess' } } }
			},
			'400': { description: 'Validation or business error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
			'401': { description: 'Authentication required', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
			'404': { description: 'Resource not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
			'409': { description: 'Conflict, such as a duplicate coupon code', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
			'500': { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } }
		},
		security: [{ bearerAuth: [] }]
	};
	if (path === '/api' || path === '/ref/:slug') operation.security = [];

	const marketplacePath = path.endsWith('/marketplace/models') || path.endsWith('/marketplace');
	if (method === 'get' && marketplacePath) {
		(operation.parameters as unknown[]).push(
			...['category', 'cat', 'specialization', 'sub', 'search', 'sort', 'page', 'limit', 'minPrice', 'maxPrice', 'minRating', 'maxDays', 'level']
				.map((name) => ({ name, in: 'query', required: false, schema: { type: name === 'page' || name === 'limit' ? 'integer' : 'string' } }))
		);
	}

	if (['post', 'put', 'patch'].includes(method)) {
		const isMultipart = /\/upload$|\/upload-proof$|\/documents\/upload$|\/accreditation\/submit$|\/upload-gallery$/.test(path);
		(operation.requestBody as unknown) = {
			required: requestSchema.required,
			content: isMultipart ? {
				'multipart/form-data': {
					schema: { $ref: `#/components/schemas/${path === '/api/auth/onboarding/upload' ? 'OnboardingUploadRequest' : 'UploadRequest'}` }
				}
			} : {
				'application/json': {
					schema: { $ref: `#/components/schemas/${requestSchema.name}` },
					example: requestSchema.example
				}
			}
		};
	}

	if (method === 'get' && (path === '/api/admin/disputes' || path === '/api/admin/withdrawals')) {
		(operation.parameters as unknown[]).push(
			{ name: 'status', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by status.' },
			{ name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
			{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }
		);
	}

	return operation;
}

function responseSchemaFor(path: string, method: string): string | undefined {
	if (path === '/api/cart' && method === 'get') return 'CartResponse';
	if (/^\/api\/cart\/items(?:\/[^/]+)?$/.test(path) || path === '/api/cart/sync') return 'CartResponse';
	if (path === '/api/checkout/coupon/validate' && method === 'post') return 'CouponValidationResponse';
	if (path === '/api/provider/coupons' && method === 'get') return 'ProviderCouponListResponse';
	if (/^\/api\/provider\/coupons(?:\/[^/]+)?$/.test(path) && ['get', 'post', 'put', 'delete'].includes(method)) return 'ProviderCouponResponse';
	if (path === '/api/checkout/order' && method === 'post') return 'OrderResponse';
	if (/^\/api\/checkout\/order\/[^/]+$/.test(path) && method === 'get') return 'OrderResponse';
	if (path.startsWith('/api/admin/disputes') && method === 'get') return path.endsWith('/disputes') ? 'DisputeListResponse' : 'DisputeResponse';
	if (path.startsWith('/api/admin/withdrawals') && method === 'get') return path.endsWith('/withdrawals') ? 'WithdrawalListResponse' : 'WithdrawalResponse';
	if (/^\/api\/admin\/disputes\/[^/]+\/resolve$/.test(path) && method === 'post') return 'DisputeResponse';
	if (/^\/api\/admin\/withdrawals\/[^/]+\/(approve|reject)$/.test(path) && method === 'post') return 'WithdrawalResponse';
	if (/^\/api\/(client|provider)\/requests\/[^/]+\/(disputes|rate)$/.test(path) && method === 'post') return path.endsWith('/rate') ? 'RatingResponse' : 'DisputeResponse';
	if (path === '/api/auth/onboarding/status' && method === 'get') return 'OnboardingStatusResponse';
	if (path === '/api/auth/onboarding/upload' && method === 'post') return 'OnboardingStatusResponse';
	if (path === '/api/checkout/payment/methods' && method === 'get') return 'PaymentMethodsResponse';
	if (path === '/api/checkout/payment/init' && method === 'post') return 'PaymentInitResponse';
	if (path === '/api/checkout/payment/confirm' && method === 'post') return 'PaymentConfirmResponse';
	if (path === '/api/checkout/payment/resend-otp' && method === 'post') return 'PaymentInitResponse';
	return undefined;
}

function requestSchemaFor(path: string, method: string) {
		const definitions: Array<{ match: RegExp; methods?: string[]; name: string; example: Record<string, unknown>; required?: boolean }> = [
			{ match: /\/auth\/login$/, name: 'LoginRequest', example: { email: 'client@example.com', password: 'Password123' }, required: true },
			{ match: /\/auth\/register$/, name: 'RegisterRequest', example: { accountType: 'CLIENT_INDIVIDUAL', firstName: 'محمد', lastName: 'العربي', email: 'client@example.com', phoneCountryCode: '+966', phoneNumber: '501234567', password: 'Password123', agreedToTerms: true }, required: true },
			{ match: /\/auth\/verify-otp$/, name: 'VerifyOtpRequest', example: { userId: '00000000-0000-0000-0000-000000000000', code: '123456' }, required: true },
			{ match: /\/auth\/resend-otp$/, name: 'ResendOtpRequest', example: { userId: '00000000-0000-0000-0000-000000000000' }, required: true },
			{ match: /\/auth\/google$/, name: 'GoogleAuthRequest', example: { idToken: 'google-id-token', accountType: 'CLIENT_INDIVIDUAL' }, required: true },
			{ match: /\/projects$/, methods: ['post'], name: 'CreateProjectRequest', example: { title: 'تطوير منصة إلكترونية', description: 'أحتاج إلى تطوير منصة متكاملة لإدارة العملاء', specialty: 'برمجة وتطوير', deliveryDays: 30, budgetType: 'fixed', budgetFixed: 5000 }, required: true },
			{ match: /\/projects\/[^/]+\/proposals$/, methods: ['post'], name: 'CreateProposalRequest', example: { title: 'عرض تنفيذ المشروع', message: 'سأنفذ المشروع بجودة عالية مع خطة واضحة للتسليم والمراجعة', totalPrice: 5000, deliveryDays: 30, milestones: [{ stepOrder: 1, title: 'التحليل', description: 'تحليل المتطلبات وتجهيز الخطة', days: 5, percentage: 100, amount: 5000 }], agreedToTerms: true, agreedToEscrow: true }, required: true },
			{ match: /\/proposals\/ai-suggest$/, methods: ['post'], name: 'AiSuggestRequest', example: { projectId: 'project-id', currentTitle: 'عنوان العرض', currentMessage: 'رسالة العرض الحالية' }, required: true },
			{ match: /\/chat\/conversations\/initiate$/, methods: ['post'], name: 'CreateConversationRequest', example: { projectId: 'project-id', providerId: 'provider-id' }, required: true },
			{ match: /\/client\/requests\/ai-suggest$/, methods: ['post'], name: 'ClientRequestAiSuggestRequest', example: { title: 'تطبيق جوال', description: 'وصف مبدئي للمشروع' }, required: false },
			{ match: /\/client\/requests$/, methods: ['post'], name: 'CreateClientRequest', example: { title: 'أحتاج خدمة جديدة', description: 'وصف تفصيلي للخدمة المطلوبة لا يقل عن عشرة أحرف', specialty: 'برمجة', budgetType: 'FIXED' }, required: true },
			{ match: /\/marketplace\/ai-recommendations$/, methods: ['post'], name: 'AiRecommendationRequest', example: { query: 'تطوير تطبيق جوال', category: 'code', subSpecialty: 'mobile-development', limit: 3 }, required: true },
			{ match: /\/marketplace\/models\/[^/]+\/favorite$/, methods: ['put'], name: 'FavoriteRequest', example: { favorite: true }, required: true },
			{ match: /\/marketplace\/models\/[^/]+\/request$/, methods: ['post'], name: 'ServiceRequest', example: { mode: 'order', message: 'أرغب في طلب هذه الخدمة' }, required: true },
			{ match: /\/profiles\/update$/, methods: ['put'], name: 'UpdateProfileRequest', example: { firstName: 'محمد', lastName: 'العربي', bio: 'نبذة عني', city: 'الرياض' }, required: true },
			{ match: /\/profiles\/setup$/, methods: ['post'], name: 'ProfileSetupRequest', example: { bio: 'نبذة مهنية', skills: ['React', 'Node.js'], city: 'الرياض', country: 'SA' }, required: true },
			{ match: /\/user\/add-account-type$/, methods: ['post'], name: 'AddAccountTypeRequest', example: { targetRole: 'PROVIDER', profileMetadata: {} }, required: true },
			{ match: /\/user\/switch-active-role$/, methods: ['post'], name: 'SwitchActiveRoleRequest', example: { targetRole: 'PROVIDER' }, required: true },
			{ match: /\/notifications\/read-all$/, methods: ['patch'], name: 'EmptyRequest', example: {}, required: false },
			{ match: /\/notifications\/[^/]+\/read$/, methods: ['patch'], name: 'EmptyRequest', example: {}, required: false },
			{ match: /\/client\/finance\/deposit\/init$/, methods: ['post'], name: 'DepositInitRequest', example: { amount: 1000, paymentMethod: 'card' }, required: true },
			{ match: /\/client\/finance\/deposit\/verify$/, methods: ['post'], name: 'DepositVerifyRequest', example: { paymentId: 'payment-id', amount: 1000, paymentMethod: 'card' }, required: true },
			{ match: /\/marketer-overview\/ref-links\/custom$/, methods: ['post'], name: 'CustomReferralLinkRequest', example: { name: 'حملة رمضان', targetUrl: 'https://waseetai.com/marketplace' } },
			{ match: /\/marketer\/profile\/channels$/, methods: ['post'], name: 'MarketingChannelRequest', example: { platform: 'linkedin', url: 'https://linkedin.com/in/example' } },
			{ match: /\/ai-review\/suggest-milestones$/, methods: ['post'], name: 'AiSuggestMilestonesRequest', example: { title: 'تطوير تطبيق جوال', description: 'تطبيق لإدارة العملاء', totalAmount: 5000 }, required: true },
			{ match: /\/ai-review\/analyze$/, methods: ['post'], name: 'AiAnalyzeProjectRequest', example: { title: 'تطوير منصة', description: 'منصة لإدارة العملاء' }, required: true },
			{ match: /\/provider\/profile\/password$/, methods: ['put'], name: 'ChangePasswordRequest', example: { currentPassword: 'OldPassword123', newPassword: 'NewPassword123' }, required: true },
			{ match: /\/provider\/profile\/basic-info$/, methods: ['put'], name: 'BasicInfoRequest', example: { firstName: 'محمد', lastName: 'العربي' }, required: true },
			{ match: /\/provider\/profile\/contact$/, methods: ['put'], name: 'ContactInfoRequest', example: { email: 'provider@example.com', phoneNumber: '501234567', city: 'الرياض' }, required: true },
			{ match: /\/admin\/users\/[^/]+\/status$/, methods: ['patch'], name: 'UserStatusRequest', example: { status: 'ACTIVE' }, required: true }
			,{ match: /\/cart\/items$/, methods: ['post'], name: 'AddCartItemRequest', example: { modelId: '31d7c925-cbc2-4b31-91eb-f8db9cf704f9', packageId: 'basic', savedForLater: false }, required: true }
			,{ match: /\/cart\/items\/[^/]+$/, methods: ['put'], name: 'UpdateCartItemRequest', example: { packageId: 'basic', savedForLater: true }, required: true }
			,{ match: /\/cart\/sync$/, methods: ['post'], name: 'CartSyncRequest', example: { items: [{ modelId: '31d7c925-cbc2-4b31-91eb-f8db9cf704f9', packageId: 'basic', savedForLater: false }] }, required: true }
			,{ match: /\/checkout\/coupon\/validate$/, methods: ['post'], name: 'CouponValidationRequest', example: { code: 'WASEET10', items: [{ modelId: '31d7c925-cbc2-4b31-91eb-f8db9cf704f9', totalAmount: 4500 }] }, required: true }
			,{ match: /\/checkout\/order$/, methods: ['post'], name: 'CheckoutOrderRequest', example: { items: [{ modelId: '31d7c925-cbc2-4b31-91eb-f8db9cf704f9', packageId: 'basic' }], couponCode: 'WASEET10' }, required: true }
			,{ match: /\/checkout\/payment\/init$/, methods: ['post'], name: 'PaymentInitRequest', example: { orderId: '00000000-0000-0000-0000-000000000000', paymentMethod: 'wallet' }, required: true }
			,{ match: /\/checkout\/payment\/confirm$/, methods: ['post'], name: 'PaymentConfirmRequest', example: { orderId: '00000000-0000-0000-0000-000000000000', otpCode: '123456' }, required: true }
			,{ match: /\/checkout\/payment\/resend-otp$/, methods: ['post'], name: 'ResendPaymentOtpRequest', example: { orderId: '00000000-0000-0000-0000-000000000000' }, required: true }
			,{ match: /\/provider\/coupons$/, methods: ['post'], name: 'CreateCouponRequest', example: { code: 'DESIGN20', discountType: 'percentage', discountValue: 20, serviceIds: ['31d7c925-cbc2-4b31-91eb-f8db9cf704f9'], maxUses: 100, maxUsesPerUser: 1, minimumAmount: 200, expiresAt: '2026-09-30T23:59:59.000Z' }, required: true }
			,{ match: /\/provider\/coupons\/[^/]+$/, methods: ['put'], name: 'UpdateCouponRequest', example: { discountValue: 15, active: true, maxUses: 200 }, required: true }
			,{ match: /\/admin\/disputes\/[^/]+\/resolve$/, methods: ['post'], name: 'ResolveDisputeRequest', example: { action: 'resolve', resolution: 'REFUND_CLIENT', resolutionNote: 'تمت مراجعة الأدلة واعتماد الاسترداد' }, required: true }
			,{ match: /\/(client|provider)\/requests\/[^/]+\/disputes$/, methods: ['post'], name: 'CreateDisputeRequest', example: { reason: 'عدم تسليم المتطلبات', description: 'تفاصيل النزاع والأضرار الناتجة عنه', evidence: ['https://res.cloudinary.com/example/evidence.pdf'] }, required: true }
			,{ match: /\/(client|provider)\/requests\/[^/]+\/rate$/, methods: ['post'], name: 'CreateRatingRequest', example: { rating: 5, comment: 'تجربة ممتازة' }, required: true }
			,{ match: /\/admin\/withdrawals\/[^/]+\/approve$/, methods: ['post'], name: 'ApproveWithdrawalRequest', example: { adminNote: 'تمت مراجعة البيانات البنكية' }, required: false }
			,{ match: /\/admin\/withdrawals\/[^/]+\/reject$/, methods: ['post'], name: 'RejectWithdrawalRequest', example: { rejectionReason: 'البيانات البنكية غير مكتملة' }, required: true }
			,{ match: /\/auth\/onboarding\/upload$/, methods: ['post'], name: 'OnboardingUploadRequest', example: { documentType: 'national_id' }, required: true }
		];
		const definition = definitions.find((item) => item.match.test(path) && (!item.methods || item.methods.includes(method)));
		return definition || { name: 'GenericObject', example: {}, required: false };
}

function collectLayers(layers: ExpressLayer[], prefix = '', paths: Record<string, Record<string, unknown>> = {}) {
	for (const layer of layers) {
		if (layer.route) {
			const path = normalizePath(`${prefix}/${layer.route.path}`);
			const methods = Object.keys(layer.route.methods || {}).filter((method) => HTTP_METHODS.has(method));
			for (const method of methods) {
				paths[path] ||= {};
				paths[path][method] = operationFor(method, path);
			}
			continue;
		}

		if (layer.handle?.stack) {
			collectLayers(layer.handle.stack, normalizePath(`${prefix}/${mountedPath(layer)}`), paths);
		}
	}
	return paths;
}

function canonicalPaths(paths: Record<string, Record<string, unknown>>) {
	const result: Record<string, Record<string, unknown>> = {};
	for (const [path, operations] of Object.entries(paths)) {
		// /api is the documented public prefix. Keep /ref because it is a real
		// standalone redirect endpoint and has no /api mount.
		if (path === '/ref' || path.startsWith('/ref/')) result[path] = operations;
		else if (path === '/api' || path.startsWith('/api/')) result[path] = operations;
	}
	return result;
}

/**
 * Builds an OpenAPI document from the routes actually registered in Express.
 * This keeps the documentation in sync with the running application without
 * changing route files or duplicating endpoint definitions.
 */
export function createOpenApiDocument(app: Application) {
	const expressApp = app as Application & { router?: { stack?: ExpressLayer[] }; _router?: { stack?: ExpressLayer[] } };
	const stack = expressApp.router?.stack || expressApp._router?.stack || [];
		const paths = canonicalPaths(collectLayers(stack));

	return {
		openapi: '3.0.3',
		info: {
			title: 'Waseet AI API',
			version: process.env.API_VERSION || '1.0.0',
			description: 'Central API documentation for the Waseet AI platform.',
			contact: { name: 'Waseet AI Engineering' }
		},
		servers: [
			{ url: normalizeServerUrl(process.env.API_PUBLIC_URL || 'http://localhost:5009'), description: 'API server' }
		],
		tags: [
			{ name: 'auth', description: 'Authentication and sessions' },
			{ name: 'profiles', description: 'User profiles' },
			{ name: 'marketplace', description: 'Marketplace services and discovery' },
			{ name: 'projects', description: 'Projects and requests' },
			{ name: 'provider', description: 'Provider tools and management' },
			{ name: 'system', description: 'System endpoints' }
		],
		paths,
		components: {
			securitySchemes: {
				bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
			},
				schemas: {
				GenericObject: { type: 'object', description: 'Request payload for an endpoint without a dedicated DTO.', additionalProperties: true },
				AddCartItemRequest: { type: 'object', required: ['modelId'], properties: { modelId: { type: 'string', format: 'uuid' }, packageId: { type: 'string', example: 'basic' }, savedForLater: { type: 'boolean', default: false } } },
				UpdateCartItemRequest: { type: 'object', minProperties: 1, properties: { packageId: { type: 'string', example: 'basic' }, savedForLater: { type: 'boolean' } } },
				CartSyncRequest: { type: 'object', required: ['items'], properties: { items: { type: 'array', maxItems: 50, items: { $ref: '#/components/schemas/AddCartItemRequest' } } } },
				CouponValidationRequest: { type: 'object', required: ['code', 'items'], properties: { code: { type: 'string', example: 'WASEET10' }, items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', required: ['modelId', 'totalAmount'], properties: { modelId: { type: 'string', format: 'uuid' }, totalAmount: { type: 'number', minimum: 0, example: 4500 } } } } } },
				CheckoutOrderRequest: { type: 'object', required: ['items'], properties: { items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', required: ['modelId'], properties: { modelId: { type: 'string', format: 'uuid' }, packageId: { type: 'string', example: 'basic' } } } }, couponCode: { type: 'string', nullable: true, example: 'WASEET10' } } },
				ProviderSnapshot: { type: 'object', required: ['id', 'name', 'initials', 'isVerified'], properties: { id: { type: 'string' }, name: { type: 'string' }, initials: { type: 'string' }, isVerified: { type: 'boolean' } } },
				CartItemResponse: { type: 'object', properties: { id: { type: 'string' }, modelId: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' }, categorySlug: { type: 'string' }, specializationSlug: { type: 'string' }, totalAmount: { type: 'number' }, totalDays: { type: 'integer' }, aiScore: { type: 'integer' }, level: { type: 'string' }, provider: { $ref: '#/components/schemas/ProviderSnapshot' }, packageName: { type: 'string' }, addedAt: { type: 'string', format: 'date-time' }, savedForLater: { type: 'boolean' } } },
				CartResponse: { type: 'object', required: ['id', 'items'], properties: { id: { type: 'string' }, items: { type: 'array', items: { $ref: '#/components/schemas/CartItemResponse' } } } },
				OrderItemResponse: { type: 'object', properties: { id: { type: 'string' }, modelId: { type: 'string' }, title: { type: 'string' }, provider: { $ref: '#/components/schemas/ProviderSnapshot' }, packageName: { type: 'string' }, price: { type: 'number' }, deliveryDays: { type: 'integer' }, aiScore: { type: 'integer' } } },
				CouponValidationResponse: { type: 'object', properties: { code: { type: 'string', example: 'DESIGN20' }, discountType: { type: 'string', enum: ['percentage', 'fixed'] }, discountValue: { type: 'number', example: 20 }, discountAmount: { type: 'number', example: 450 } } },
				CreateCouponRequest: { type: 'object', required: ['code', 'discountType', 'discountValue', 'serviceIds'], properties: { code: { type: 'string', minLength: 3, maxLength: 50, pattern: '^[a-zA-Z0-9_-]+$', example: 'DESIGN20' }, discountType: { type: 'string', enum: ['percentage', 'fixed'] }, discountValue: { type: 'number', exclusiveMinimum: 0, example: 20, description: 'Percentage must be at most 100; fixed values are in USD.' }, serviceIds: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', format: 'uuid' } }, minimumAmount: { type: 'number', minimum: 0, nullable: true }, maxDiscount: { type: 'number', exclusiveMinimum: 0, nullable: true }, maxUses: { type: 'integer', minimum: 1, nullable: true }, maxUsesPerUser: { type: 'integer', minimum: 1, default: 1 }, startAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time', nullable: true } } },
				UpdateCouponRequest: { type: 'object', minProperties: 1, properties: { code: { type: 'string', minLength: 3, maxLength: 50, pattern: '^[a-zA-Z0-9_-]+$' }, discountType: { type: 'string', enum: ['percentage', 'fixed'] }, discountValue: { type: 'number', exclusiveMinimum: 0, maximum: 100 }, serviceIds: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', format: 'uuid' } }, minimumAmount: { type: 'number', minimum: 0, nullable: true }, maxDiscount: { type: 'number', exclusiveMinimum: 0, nullable: true }, maxUses: { type: 'integer', minimum: 1, nullable: true }, maxUsesPerUser: { type: 'integer', minimum: 1 }, startAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time', nullable: true }, active: { type: 'boolean' } } },
				ProviderCouponResponse: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, code: { type: 'string', example: 'DESIGN20' }, discountType: { type: 'string', enum: ['percentage', 'fixed'] }, discountValue: { type: 'number' }, minimumAmount: { type: 'number', nullable: true }, maxDiscount: { type: 'number', nullable: true }, maxUses: { type: 'integer', nullable: true }, usedCount: { type: 'integer' }, maxUsesPerUser: { type: 'integer' }, active: { type: 'boolean' }, startAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time', nullable: true }, serviceIds: { type: 'array', items: { type: 'string', format: 'uuid' } }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } },
				ProviderCouponListResponse: { type: 'array', items: { $ref: '#/components/schemas/ProviderCouponResponse' } },
				OrderResponse: { type: 'object', properties: { id: { type: 'string' }, orderId: { type: 'string' }, orderNumber: { type: 'string', example: 'WS-2026-000001' }, status: { type: 'string', example: 'pending_payment' }, items: { type: 'array', items: { $ref: '#/components/schemas/OrderItemResponse' } }, subtotal: { type: 'number', example: 4500 }, discount: { type: 'number', example: 450 }, total: { type: 'number', example: 4050 }, couponCode: { type: 'string', nullable: true }, createdAt: { type: 'string', format: 'date-time' } } },
				CreateDisputeRequest: { type: 'object', required: ['reason', 'description'], properties: { reason: { type: 'string', minLength: 2, maxLength: 120 }, description: { type: 'string', minLength: 10, maxLength: 10000 }, evidence: { type: 'array', maxItems: 10, items: { type: 'string', format: 'uri' } } } },
				ResolveDisputeRequest: { type: 'object', required: ['action', 'resolution'], properties: { action: { type: 'string', enum: ['resolve', 'reject'] }, resolution: { type: 'string' }, resolutionNote: { type: 'string' } } },
				DisputeResponse: { type: 'object', properties: { id: { type: 'string' }, requestId: { type: 'string', nullable: true }, projectId: { type: 'string', nullable: true }, status: { type: 'string', enum: ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'REJECTED'] }, reason: { type: 'string' }, description: { type: 'string' }, evidence: { type: 'array', items: { type: 'string', format: 'uri' } }, resolution: { type: 'string', nullable: true }, resolutionNote: { type: 'string', nullable: true }, createdAt: { type: 'string', format: 'date-time' }, resolvedAt: { type: 'string', format: 'date-time', nullable: true } } },
				DisputeListResponse: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/DisputeResponse' } }, pagination: { $ref: '#/components/schemas/Pagination' } } },
				CreateRatingRequest: { type: 'object', required: ['rating'], properties: { rating: { type: 'number', minimum: 1, maximum: 5 }, comment: { type: 'string', maxLength: 2000 } } },
				RatingResponse: { type: 'object', properties: { id: { type: 'string' }, clientRequestId: { type: 'string' }, providerId: { type: 'string' }, clientId: { type: 'string', nullable: true }, rating: { type: 'number' }, comment: { type: 'string', nullable: true }, createdAt: { type: 'string', format: 'date-time' } } },
				ApproveWithdrawalRequest: { type: 'object', properties: { adminNote: { type: 'string', maxLength: 2000 } } },
				RejectWithdrawalRequest: { type: 'object', required: ['rejectionReason'], properties: { rejectionReason: { type: 'string', minLength: 2, maxLength: 2000 } } },
				WithdrawalResponse: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string', example: 'USD' }, method: { type: 'string' }, status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'COMPLETED'] }, rejectionReason: { type: 'string', nullable: true }, createdAt: { type: 'string', format: 'date-time' } } },
				WithdrawalListResponse: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/WithdrawalResponse' } }, pagination: { $ref: '#/components/schemas/Pagination' } } },
				OnboardingStatusResponse: { type: 'object', properties: { id: { type: 'string', nullable: true }, userId: { type: 'string' }, documentUrl: { type: 'string', nullable: true }, documentName: { type: 'string', nullable: true }, documentType: { type: 'string', nullable: true }, status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] }, rejectionReason: { type: 'string', nullable: true }, reviewedAt: { type: 'string', format: 'date-time', nullable: true } } },
				OnboardingUploadRequest: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, documentType: { type: 'string', enum: ['national_id', 'commercial_registration', 'other'], default: 'national_id' } } },
				Pagination: { type: 'object', properties: { page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, pages: { type: 'integer' } } },
				PaymentInitRequest: { type: 'object', required: ['orderId', 'paymentMethod'], properties: { orderId: { type: 'string', format: 'uuid' }, paymentMethod: { type: 'string', enum: ['wallet'] } } },
				PaymentConfirmRequest: { type: 'object', required: ['orderId', 'otpCode'], properties: { orderId: { type: 'string', format: 'uuid' }, otpCode: { type: 'string', pattern: '^\\d{6}$', example: '123456' } } },
				ResendPaymentOtpRequest: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string', format: 'uuid' } } },
				PaymentInitResponse: { type: 'object', properties: { paymentReference: { type: 'string', example: 'PAY-ABC123' }, otpSentTo: { type: 'string', example: 'mo••••@example.com', description: 'OTP is always sent to the registered email address.' }, expiresAt: { type: 'string', format: 'date-time' } } },
				PaymentConfirmResponse: { type: 'object', properties: { orderId: { type: 'string' }, orderNumber: { type: 'string', example: 'WS-2026-000001' }, status: { type: 'string', example: 'paid' }, total: { type: 'number', example: 4050 }, projectIds: { type: 'array', items: { type: 'string' } } } },
				PaymentMethod: { type: 'object', required: ['id', 'name', 'available'], properties: { id: { type: 'string', example: 'card' }, name: { type: 'string', example: 'بطاقة بنكية' }, available: { type: 'boolean' }, balance: { type: 'number' }, badge: { type: 'string', example: 'قريباً' } } },
				PaymentMethodsResponse: { type: 'array', items: { $ref: '#/components/schemas/PaymentMethod' } },
				EmptyRequest: { type: 'object', additionalProperties: false },
				UploadRequest: { type: 'object', description: 'Multipart payload. The required file field depends on the upload endpoint.', properties: { file: { type: 'string', format: 'binary' }, files: { type: 'array', items: { type: 'string', format: 'binary' } }, attachments: { type: 'array', items: { type: 'string', format: 'binary' } }, providerSpecialtyId: { type: 'string' }, documentType: { type: 'string', enum: ['national_id', 'commercial_registration', 'other'] }, title: { type: 'string' }, description: { type: 'string' }, technologiesUsed: { type: 'string', description: 'JSON array or comma-separated list' }, projectUrl: { type: 'string', format: 'uri' }, githubUrl: { type: 'string', format: 'uri' } } },
				AiRecommendationRequest: { type: 'object', properties: { query: { type: 'string' }, category: { type: 'string' }, subSpecialty: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } } },
				FavoriteRequest: { type: 'object', required: ['favorite'], properties: { favorite: { type: 'boolean' } } },
				ServiceRequest: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['order', 'negotiation'] }, message: { type: 'string', maxLength: 3000 } } },
				UpdateProfileRequest: { type: 'object', properties: { firstName: { type: 'string' }, lastName: { type: 'string' }, email: { type: 'string', format: 'email' }, phoneNumber: { type: 'string' }, bio: { type: 'string', maxLength: 1000 }, skills: { type: 'array', items: { type: 'string' } }, city: { type: 'string' }, country: { type: 'string' } } },
				ProfileSetupRequest: { type: 'object', properties: { avatarUrl: { type: 'string', format: 'uri' }, phoneNumber: { type: 'string' }, bio: { type: 'string' }, skills: { type: 'array', items: { type: 'string' } }, city: { type: 'string' }, country: { type: 'string' }, hourlyRate: { type: 'number', exclusiveMinimum: true } } },
				AddAccountTypeRequest: { type: 'object', required: ['targetRole'], additionalProperties: false, properties: { targetRole: { type: 'string', enum: ['CLIENT', 'PROVIDER', 'AFFILIATE', 'ADMIN', 'SUPER_ADMIN'] }, profileMetadata: { type: 'object', additionalProperties: true } } },
				SwitchActiveRoleRequest: { type: 'object', required: ['targetRole'], additionalProperties: false, properties: { targetRole: { type: 'string', enum: ['CLIENT', 'PROVIDER', 'AFFILIATE', 'ADMIN', 'SUPER_ADMIN'] } } },
				DepositInitRequest: { type: 'object', required: ['amount'], properties: { amount: { type: 'number', exclusiveMinimum: true }, paymentMethod: { type: 'string' } } },
				DepositVerifyRequest: { type: 'object', properties: { paymentId: { type: 'string' }, transactionId: { type: 'string' } } },
				CustomReferralLinkRequest: { type: 'object', properties: { name: { type: 'string' }, targetUrl: { type: 'string', format: 'uri' } } },
				MarketingChannelRequest: { type: 'object', required: ['platform', 'url'], properties: { platform: { type: 'string' }, url: { type: 'string', format: 'uri' } } },
				AssistantChatRequest: { type: 'object', required: ['message'], additionalProperties: false, properties: { message: { type: 'string' }, currentRoute: { type: 'string' } } },
				CreateConversationRequest: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string' }, providerId: { type: 'string' }, clientId: { type: 'string' }, offerId: { type: 'string' }, negotiationPayload: { type: 'object', additionalProperties: false, properties: { isNegotiation: { type: 'boolean' }, negType: { type: 'string' }, negTypeName: { type: 'string' }, price: { type: 'string' }, duration: { type: 'string' }, notes: { type: 'string' }, status: { type: 'string' } } } } },
				AiSuggestRequest: { type: 'object', required: ['projectId'], properties: { projectId: { type: 'string', minLength: 1 }, currentTitle: { type: 'string' }, currentMessage: { type: 'string' }, advantages: { type: 'array', items: { type: 'string' } } } },
				ClientRequestAiSuggestRequest: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, specialtyId: { type: 'string' }, specialtyName: { type: 'string' }, subSpecialties: { type: 'array', items: { type: 'string' } } } },
				AiEnhanceDescriptionRequest: { type: 'object', anyOf: [{ required: ['title'] }, { required: ['description'] }], properties: { title: { type: 'string' }, description: { type: 'string' } } },
				AiSuggestTextRequest: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
				AiSuggestMilestonesRequest: { type: 'object', anyOf: [{ required: ['title'] }, { required: ['description'] }], properties: { title: { type: 'string' }, description: { type: 'string' }, totalAmount: { type: 'number', exclusiveMinimum: true } } },
				AiAnalyzeProjectRequest: { type: 'object', required: ['title', 'description'], properties: { title: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, specialtyId: { type: 'string' }, modelType: { type: 'string' }, portfolioItemId: { type: 'string' }, accreditationSampleId: { type: 'string' }, totalAmount: { type: 'number' }, stages: { type: 'array', items: { $ref: '#/components/schemas/AiMilestone' } }, milestones: { type: 'array', items: { $ref: '#/components/schemas/AiMilestone' } } } },
				AiMilestone: { type: 'object', properties: { title: { type: 'string' }, desc: { type: 'string' }, description: { type: 'string' }, days: { type: 'integer' }, estimatedDays: { type: 'integer' }, percentage: { type: 'number', minimum: 0, maximum: 100 } } },
				ChangePasswordRequest: { type: 'object', required: ['currentPassword', 'newPassword'], properties: { currentPassword: { type: 'string', format: 'password' }, newPassword: { type: 'string', format: 'password', minLength: 8 } } },
				BasicInfoRequest: { type: 'object', properties: { firstName: { type: 'string' }, lastName: { type: 'string' }, avatarUrl: { type: 'string' } } },
				ContactInfoRequest: { type: 'object', properties: { email: { type: 'string', format: 'email' }, phoneNumber: { type: 'string' }, alternativePhone: { type: 'string' }, address: { type: 'string' }, city: { type: 'string' }, country: { type: 'string' } } },
				UserStatusRequest: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } },
				LoginRequest: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', format: 'password', minLength: 1 } } },
				RegisterRequest: { type: 'object', required: ['accountType', 'firstName', 'lastName', 'email', 'password', 'agreedToTerms'], properties: { accountType: { type: 'string', enum: ['CLIENT_INDIVIDUAL', 'CLIENT_COMPANY', 'PROVIDER_INDIVIDUAL', 'PROVIDER_COMPANY', 'MARKETING_BROKER'] }, firstName: { type: 'string', minLength: 2 }, lastName: { type: 'string', minLength: 2 }, email: { type: 'string', format: 'email' }, phoneCountryCode: { type: 'string', default: '+966' }, phoneNumber: { type: 'string' }, password: { type: 'string', format: 'password', minLength: 8 }, agreedToTerms: { type: 'boolean', enum: [true] } } },
				VerifyOtpRequest: { type: 'object', required: ['userId', 'code'], properties: { userId: { type: 'string', format: 'uuid' }, code: { type: 'string', pattern: '^\\d{6}$' } } },
				ResendOtpRequest: { type: 'object', required: ['userId'], properties: { userId: { type: 'string', format: 'uuid' } } },
				GoogleAuthRequest: { type: 'object', required: ['idToken'], properties: { idToken: { type: 'string' }, accountType: { type: 'string' } } },
				CreateProjectRequest: { type: 'object', required: ['title', 'description', 'specialty', 'deliveryDays'], properties: { title: { type: 'string', minLength: 5, maxLength: 200 }, description: { type: 'string', minLength: 20 }, specialty: { type: 'string' }, subSpecialties: { type: 'array', items: { type: 'string' } }, deliveryDays: { type: 'integer', minimum: 1 }, budgetType: { type: 'string', enum: ['range', 'fixed', 'hourly'] }, budgetMin: { type: 'number' }, budgetMax: { type: 'number' }, budgetFixed: { type: 'number' }, allowNegotiation: { type: 'boolean' } } },
				CreateProposalRequest: { type: 'object', required: ['title', 'message', 'totalPrice', 'deliveryDays', 'agreedToTerms', 'agreedToEscrow'], properties: { title: { type: 'string' }, message: { type: 'string' }, advantages: { type: 'array', items: { type: 'string' }, maxItems: 10 }, totalPrice: { type: 'number', exclusiveMinimum: true }, deliveryDays: { type: 'integer', minimum: 1 }, agreedToTerms: { type: 'boolean', enum: [true] }, agreedToEscrow: { type: 'boolean', enum: [true] } } },
				ChatRequest: { type: 'object', properties: { conversationId: { type: 'string' }, projectId: { type: 'string' }, content: { type: 'string' }, fileUrl: { type: 'string' }, fileName: { type: 'string' } } },
				CreateClientRequest: { type: 'object', required: ['title', 'description'], properties: { title: { type: 'string', minLength: 3 }, description: { type: 'string', minLength: 10 }, specialty: { type: 'string' }, subSpecialties: { type: 'array', items: { type: 'string' } }, budgetType: { type: 'string' }, minBudget: { type: 'number' }, maxBudget: { type: 'number' } } },
				ApiSuccess: { type: 'object', properties: { success: { type: 'boolean' }, data: {} } },
				ApiError: { type: 'object', properties: { success: { type: 'boolean' }, error: { type: 'string' }, message: { type: 'string' } } }
			}
		}
	};
}
