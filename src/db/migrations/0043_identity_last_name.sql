ALTER TABLE "identities" ADD COLUMN IF NOT EXISTS "last_name" text;
--> statement-breakpoint
UPDATE "identities"
SET "last_name" = regexp_replace(trim("display_name"), '^.*\s', '')
WHERE "last_name" IS NULL
  AND "role" IN ('customer', 'contact')
  AND "display_name" IS NOT NULL
  AND trim("display_name") ~ '\s';
