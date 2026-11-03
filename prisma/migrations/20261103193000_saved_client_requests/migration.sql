CREATE TABLE "saved_client_requests" (
  "providerId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "requestId" TEXT NOT NULL REFERENCES "client_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "saved_client_requests_pkey" PRIMARY KEY ("providerId", "requestId")
);

CREATE INDEX "saved_client_requests_requestId_idx" ON "saved_client_requests"("requestId");
