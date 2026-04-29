ALTER TABLE "ap_entities" ALTER COLUMN "ccid" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ap_entities" ALTER COLUMN "enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "ap_entities" ALTER COLUMN "enabled" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ap_entities" ALTER COLUMN "publickey" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ap_entities" ALTER COLUMN "privatekey" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ap_entities" ALTER COLUMN "c_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ap_follows" ALTER COLUMN "accepted" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ap_follows" ALTER COLUMN "publisher_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ap_follows" ALTER COLUMN "subscriber_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ap_follows" ADD COLUMN "subscriber_inbox" text;--> statement-breakpoint
ALTER TABLE "ap_follows" ADD COLUMN "subscriber_shared_inbox" text;