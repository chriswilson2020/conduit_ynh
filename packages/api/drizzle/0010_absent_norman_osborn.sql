-- v1.0.1 raises the logo from 32KB to 300KB, so the column bound goes with it:
-- 4 * ceil(307200/3) = 409600 characters of base64, plus 23 for the longest
-- permitted prefix, "data:image/jpeg;base64,".
--
-- WIDENING ONLY, so every row that satisfied the old constraint satisfies this
-- one and the ALTER cannot fail on existing data. What the column still cannot
-- see is the picture's dimensions -- see MAX_LOGO_PIXELS -- which is checked at
-- the upload and again at the renderer, where a 12KB file that decodes to 100
-- megapixels is refused.
ALTER TABLE "org_profile" DROP CONSTRAINT "org_profile_logo_size";--> statement-breakpoint
ALTER TABLE "org_profile" ADD CONSTRAINT "org_profile_logo_size" CHECK (char_length("org_profile"."logo_data_uri") <= 409623);
