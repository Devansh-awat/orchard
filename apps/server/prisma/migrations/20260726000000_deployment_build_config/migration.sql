-- Zero-config build settings. All nullable: null means "use whatever Railpack
-- detected", a value becomes a RAILPACK_* override on the build.
ALTER TABLE "deployments" ADD COLUMN "root_directory" VARCHAR(500),
ADD COLUMN "framework" VARCHAR(50),
ADD COLUMN "install_command" VARCHAR(2000),
ADD COLUMN "build_command" VARCHAR(2000),
ADD COLUMN "start_command" VARCHAR(2000),
ADD COLUMN "output_directory" VARCHAR(500),
ADD COLUMN "detected_config" JSONB;
