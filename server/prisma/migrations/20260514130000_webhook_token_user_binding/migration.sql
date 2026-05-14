ALTER TABLE deployment_webhook_tokens ADD COLUMN created_by_user_id UUID;
ALTER TABLE deployment_webhook_tokens ADD CONSTRAINT deployment_webhook_tokens_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
