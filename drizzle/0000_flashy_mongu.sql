CREATE TABLE "ap_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"ccid" text NOT NULL,
	"listen_timelines" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"c_date" date DEFAULT now() NOT NULL,
	CONSTRAINT "ap_entities_ccid_unique" UNIQUE("ccid")
);
--> statement-breakpoint
CREATE TABLE "ap_follows" (
	"accepted" boolean DEFAULT false NOT NULL,
	"publisher_id" text NOT NULL,
	"subscriber_id" text NOT NULL,
	"subscriber_inbox" text,
	"subscriber_shared_inbox" text,
	CONSTRAINT "ap_follows_publisher_id_subscriber_id_pk" PRIMARY KEY("publisher_id","subscriber_id")
);
--> statement-breakpoint
CREATE TABLE "ap_keys" (
	"owner_id" text NOT NULL,
	"key_type" text NOT NULL,
	"private" text NOT NULL,
	"public" text NOT NULL,
	"c_date" date DEFAULT now() NOT NULL,
	CONSTRAINT "ap_keys_owner_id_key_type_pk" PRIMARY KEY("owner_id","key_type")
);
