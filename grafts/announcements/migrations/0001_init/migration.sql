CREATE TABLE announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 500),
  tone text NOT NULL DEFAULT 'info' CHECK (tone IN ('info', 'success', 'warning')),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

CREATE INDEX announcements_active ON announcements (created_at DESC) WHERE expires_at IS NULL;
