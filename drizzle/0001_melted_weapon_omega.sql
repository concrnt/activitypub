CREATE TABLE "ap_object_references" (
	"ap_object_id" text PRIMARY KEY NOT NULL,
	"cc_uri" text NOT NULL,
	"ref_type" text NOT NULL,
	"meta" jsonb,
	"c_date" date DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ap_object_references_cc_uri_idx" ON "ap_object_references" USING btree ("cc_uri");