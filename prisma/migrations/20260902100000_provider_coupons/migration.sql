ALTER TABLE "coupons" ADD COLUMN "providerId" TEXT,
ADD COLUMN "minimumAmount" DOUBLE PRECISION,
ADD COLUMN "maxDiscount" DOUBLE PRECISION,
ADD COLUMN "maxUsesPerUser" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "startAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "coupon_services" (
    "couponId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    CONSTRAINT "coupon_services_pkey" PRIMARY KEY ("couponId", "serviceId")
);

CREATE TABLE "coupon_redemptions" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "orders" ADD COLUMN "couponDiscountType" TEXT,
ADD COLUMN "couponDiscountValue" DOUBLE PRECISION;

CREATE UNIQUE INDEX "coupon_redemptions_orderId_key" ON "coupon_redemptions"("orderId");
CREATE UNIQUE INDEX "coupon_redemptions_couponId_userId_orderId_key" ON "coupon_redemptions"("couponId", "userId", "orderId");
CREATE INDEX "coupon_services_serviceId_idx" ON "coupon_services"("serviceId");
CREATE INDEX "coupon_redemptions_couponId_userId_idx" ON "coupon_redemptions"("couponId", "userId");
CREATE INDEX "coupons_providerId_idx" ON "coupons"("providerId");

ALTER TABLE "coupons" ADD CONSTRAINT "coupons_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "coupon_services" ADD CONSTRAINT "coupon_services_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coupon_services" ADD CONSTRAINT "coupon_services_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "service_catalogs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
