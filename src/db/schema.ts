import { boolean, pgTable, text, date } from 'drizzle-orm/pg-core'

export const apEntity = pgTable("ap_entities", {
    id: text("id").primaryKey(),
    ccid: text("ccid").unique(),
    enabled: boolean("enabled"),
    publickey: text("publickey"),
    privatekey: text("privatekey"),
    cDate: date("c_date").defaultNow(),
});


