CREATE TABLE "ap_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"ccid" text,
	"enabled" boolean,
	"publickey" text,
	"privatekey" text,
	"c_date" date DEFAULT now(),
	CONSTRAINT "ap_entities_ccid_unique" UNIQUE("ccid")
);
--> statement-breakpoint
CREATE TABLE "ap_follows" (
	"id" serial PRIMARY KEY NOT NULL,
	"accepted" boolean DEFAULT false,
	"publisher_id" text,
	"subscriber_id" text
);
