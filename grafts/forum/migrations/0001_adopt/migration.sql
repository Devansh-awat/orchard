DO $adopt$
DECLARE
  t text;
  tables text[] := ARRAY['forum_categories', 'forum_threads', 'forum_replies', 'forum_votes'];
BEGIN
  IF (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.forum_threads')) = 'r' THEN
    FOREACH t IN ARRAY tables LOOP
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA ext_forum', t);
    END LOOP;
  ELSIF to_regclass('ext_forum.forum_threads') IS NULL THEN
    EXECUTE $ddl$
      CREATE TABLE "forum_categories" (
          "id" UUID NOT NULL,
          "slug" VARCHAR(100) NOT NULL,
          "name" VARCHAR(100) NOT NULL,
          "emoji" VARCHAR(16) NOT NULL,
          "description" VARCHAR(300),
          "sort_order" INTEGER NOT NULL DEFAULT 0,
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "forum_categories_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "forum_threads" (
          "id" UUID NOT NULL,
          "number" SERIAL NOT NULL,
          "category_id" UUID NOT NULL,
          "author_id" UUID NOT NULL,
          "title" VARCHAR(200) NOT NULL,
          "body" TEXT NOT NULL,
          "status" VARCHAR(20) NOT NULL DEFAULT 'open',
          "priority" VARCHAR(20) NOT NULL DEFAULT 'none',
          "scope" VARCHAR(30) NOT NULL DEFAULT 'platform',
          "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
          "pinned" BOOLEAN NOT NULL DEFAULT false,
          "locked" BOOLEAN NOT NULL DEFAULT false,
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "last_activity_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "forum_threads_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "forum_replies" (
          "id" UUID NOT NULL,
          "thread_id" UUID NOT NULL,
          "author_id" UUID NOT NULL,
          "body" TEXT NOT NULL,
          "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "forum_replies_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE "forum_votes" (
          "thread_id" UUID NOT NULL,
          "user_id" UUID NOT NULL,
          "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CONSTRAINT "forum_votes_pkey" PRIMARY KEY ("thread_id", "user_id")
      );

      CREATE UNIQUE INDEX "forum_categories_slug_key" ON "forum_categories"("slug");
      CREATE UNIQUE INDEX "forum_threads_number_key" ON "forum_threads"("number");
      CREATE INDEX "forum_threads_category_id_last_activity_at_idx" ON "forum_threads"("category_id", "last_activity_at");
      CREATE INDEX "forum_replies_thread_id_created_at_idx" ON "forum_replies"("thread_id", "created_at");

      ALTER TABLE "forum_threads" ADD CONSTRAINT "forum_threads_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "forum_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      ALTER TABLE "forum_threads" ADD CONSTRAINT "forum_threads_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES public."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      ALTER TABLE "forum_replies" ADD CONSTRAINT "forum_replies_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "forum_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      ALTER TABLE "forum_replies" ADD CONSTRAINT "forum_replies_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES public."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      ALTER TABLE "forum_votes" ADD CONSTRAINT "forum_votes_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "forum_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
      ALTER TABLE "forum_votes" ADD CONSTRAINT "forum_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES public."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    $ddl$;
  END IF;
END
$adopt$;

ALTER TABLE ext_forum.forum_categories ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE ext_forum.forum_threads ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE ext_forum.forum_replies ALTER COLUMN id SET DEFAULT gen_random_uuid();

INSERT INTO ext_forum.forum_categories (slug, name, emoji, description, sort_order)
VALUES
  ('bugs', 'Bugs', '', 'Something is broken or behaving wrong', 0),
  ('features', 'Feature requests', '', 'Something Orchard should do', 1)
ON CONFLICT (slug) DO NOTHING;

DO $compat$
DECLARE
  t text;
  c record;
  tables text[] := ARRAY['forum_categories', 'forum_threads', 'forum_replies', 'forum_votes'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      EXECUTE format('CREATE VIEW public.%I AS SELECT * FROM ext_forum.%I', t, t);
      FOR c IN
        SELECT column_name, column_default
        FROM information_schema.columns
        WHERE table_schema = 'ext_forum' AND table_name = t AND column_default IS NOT NULL
      LOOP
        EXECUTE format('ALTER VIEW public.%I ALTER COLUMN %I SET DEFAULT %s', t, c.column_name, c.column_default);
      END LOOP;
    END IF;
  END LOOP;
END
$compat$;
