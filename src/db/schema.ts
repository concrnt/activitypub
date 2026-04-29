import { boolean, pgTable, text, date, serial, unique } from 'drizzle-orm/pg-core'

export const apEntity = pgTable("ap_entities", {
    id: text("id").notNull().primaryKey(),
    ccid: text("ccid").notNull().unique(),
    enabled: boolean("enabled").notNull().default(true),
    publicKey: text("publickey").notNull(),
    privateKey: text("privatekey").notNull(),
    cDate: date("c_date").notNull().defaultNow(),
});

export type ApEntity = typeof apEntity.$inferSelect;

export const apFollow = pgTable(
    "ap_follows", 
    {
        id: serial("id").notNull().primaryKey(),
        accepted: boolean("accepted").notNull().default(false),
        publisherId: text("publisher_id").notNull(),

        subscriberId: text("subscriber_id").notNull(),
        subscriberInbox: text("subscriber_inbox"),
        subscriberSharedInbox: text("subscriber_shared_inbox"),
    },
    (table) => [
        unique("unique_follow").on(table.publisherId, table.subscriberId)
    ]
);

export type ApFollow = typeof apFollow.$inferSelect;

