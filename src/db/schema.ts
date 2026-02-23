import { boolean, pgTable, text, date, serial } from 'drizzle-orm/pg-core'

export const apEntity = pgTable("ap_entities", {
    id: text("id").primaryKey(),
    ccid: text("ccid").unique(),
    enabled: boolean("enabled"),
    publicKey: text("publickey"),
    privateKey: text("privatekey"),
    cDate: date("c_date").defaultNow(),
});

export const apFollow = pgTable("ap_follows", {
    id: serial("id").primaryKey(),
    accepted: boolean("accepted").default(false),
    publisherId: text("publisher_id"),
    subscriberId: text("subscriber_id"),
});

