import { boolean, pgTable, text, date, primaryKey } from 'drizzle-orm/pg-core'

export const apEntity = pgTable("ap_entities", {
    id: text("id").notNull().primaryKey(),
    ccid: text("ccid").notNull().unique(),
    enabled: boolean("enabled").notNull().default(true),
    cDate: date("c_date").notNull().defaultNow(),
});

export type ApEntity = typeof apEntity.$inferSelect;

export const apFollow = pgTable(
    "ap_follows", 
    {
        accepted: boolean("accepted").notNull().default(false),
        publisherId: text("publisher_id").notNull(),

        subscriberId: text("subscriber_id").notNull(),
        subscriberInbox: text("subscriber_inbox"),
        subscriberSharedInbox: text("subscriber_shared_inbox"),
    },
    (table) => [
        primaryKey({
            columns: [table.publisherId, table.subscriberId]
        })
    ]
);

export type ApFollow = typeof apFollow.$inferSelect;

export const apKeys = pgTable(
    "ap_keys", 
    {
        ownerId: text("owner_id").notNull(),
        keyType: text("key_type").notNull(),
        private: text("private").notNull(),
        public: text("public").notNull(),
        cDate: date("c_date").notNull().defaultNow(),
    },
    (table) => [
        primaryKey({
            columns: [table.ownerId, table.keyType]
        })
    ]
);

export type ApKey = typeof apKeys.$inferSelect;

