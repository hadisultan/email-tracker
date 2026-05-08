-- 0001_extensions.sql
--
-- Postgres extensions required by the rest of the schema.
-- Must run before all other migrations.
--
-- Why pgcrypto: gen_random_uuid() lives here. Supabase's stock image
-- preinstalls it but we keep the explicit CREATE for portability to
-- vanilla Postgres deployments and for forward-compatibility.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
