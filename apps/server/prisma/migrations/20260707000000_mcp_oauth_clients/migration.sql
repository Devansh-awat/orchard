CREATE TABLE "mcp_oauth_clients" (
    "id" VARCHAR(64) NOT NULL,
    "client_secret" VARCHAR(128),
    "name" VARCHAR(255) NOT NULL,
    "redirect_uris" JSONB NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_oauth_clients_pkey" PRIMARY KEY ("id")
);
