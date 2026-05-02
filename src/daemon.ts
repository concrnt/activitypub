import { db, apEntity, apFollow, type ApEntity } from './db/index.ts';
import { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import fedi from "./federation.ts";
import { Create, Note } from '@fedify/vocab';

import concrntApi from "./concrnt.ts";

let entities: ApEntity[] = [];

const updateEntities = async () => {
    entities = await db.select().from(apEntity);
}

export const startEntityBroker = async () => {

    const redis = new Redis(process.env.REDIS_URL);

    updateEntities(); // Initial load of entities
    setInterval(updateEntities, 60000); // Update entities every 60 seconds

    redis.psubscribe("*", (err, count) => {
        if (err) {
            console.error("Failed to subscribe to Redis channels:", err);
            return;
        }
    });

    redis.on("pmessage", async (pattern, channel, message) => {

        entities.forEach(async entity => {
            const prefix = `cckv://${entity.ccid}/concrnt.world/profiles/main/home-timeline/`;
            if (channel.startsWith(prefix)) {

                const followers = await db.select().from(apFollow)
                    .where(eq(apFollow.publisherId, entity.id));

                if (followers.length === 0) {
                    console.log(`Entity ${entity.id} has no followers.`);
                    return;
                }

                console.log(`Entity ${entity.id} has ${followers.length} followers.`)

                let cckv = channel

                const document = await concrntApi.getDocument<any>(channel);

                if (document.author != entity.ccid) {
                    return
                }

                if (document.schema === "https://schema.concrnt.net/reference.json") {
                    cckv = document.value.href
                }

                const baseURL = new URL('https://cc2.tunnel.anthrotech.dev')
                const ctx = fedi.createContext(baseURL, undefined)
                const noteArgs = { identifier: entity.id, id: cckv }
                const noteURL = ctx.getObjectUri(Note, noteArgs)
                const note = await ctx.lookupObject(noteURL)

                await ctx.sendActivity(
                    { identifier: entity.id },
                    "followers",
                    new Create({
                        id: new URL("#activity", note?.id ?? undefined),
                        object: note,
                        actors: note?.attributionIds,
                        tos: note?.toIds,
                        ccs: note?.ccIds,
                    }),
                )
            }
        })
    });
}

