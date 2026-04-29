import { db, apEntity, apFollow, type ApEntity } from './db/index.ts';
import { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import { federation } from '@fedify/hono';

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
        console.log(`Subscribed to ${count} Redis channels.`);
    });

    redis.on("pmessage", async (pattern, channel, message) => {
        console.log(`Received message on channel ${channel}: ${message}`);

        entities.forEach(async entity => {
            const prefix = `cckv://${entity.ccid}/concrnt.world/profiles/main/home-timeline/`;
            if (channel.startsWith(prefix)) {

                const followers = await db.select().from(apFollow)
                    .where(eq(apFollow.publisherId, entity.id));

                if (followers.length === 0) {
                    console.log(`Entity ${entity.id} has no followers.`);
                    return;
                }

                console.log(`Entity ${entity.id} has followers:`, followers);


            }

        })

    });

}




