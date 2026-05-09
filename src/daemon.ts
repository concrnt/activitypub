import { db, apEntity, apFollow, type ApEntity } from './db/index.ts';
import { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import fedi from "./federation.ts";
import { Create, Delete, isActor, Like, Note } from '@fedify/vocab';

import concrntApi from "./concrnt.ts";
import { config } from "./config.ts";

let entities: ApEntity[] = [];

const updateEntities = async () => {
    entities = await db.select().from(apEntity);
}

export const startEntityBroker = async () => {

    const redis = new Redis(config.redis.url);

    updateEntities(); // Initial load of entities
    setInterval(updateEntities, 60000); // Update entities every 60 seconds

    redis.psubscribe("*", (err, count) => {
        if (err) {
            console.error("Failed to subscribe to Redis channels:", err);
            return;
        }
    });

    redis.on("pmessage", async (pattern, channel, message) => {

        if (!channel.startsWith('ccfs://') && !channel.startsWith('cckv://')) {
            return; // Ignore irrelevant channels
        }

        try {
            entities.forEach(async entity => {
                const prefix = `cckv://${entity.ccid}/concrnt.world/profiles/main/home-timeline`;
                if (channel.startsWith(prefix)) {

                    const followers = await db.select().from(apFollow)
                        .where(eq(apFollow.publisherId, entity.id));

                    if (followers.length === 0) {
                        console.log(`Entity ${entity.id} has no followers.`);
                        return;
                    }

                    console.log(`Entity ${entity.id} has ${followers.length} followers.`)

                    const msg = JSON.parse(message);
                    if (msg.type === "created") {
                        console.log(`Received created message for ${channel}`);

                        const document = await concrntApi.getDocument<any>(channel);
                        let cckv: string = document.key!

                        if (document.author != entity.ccid) {
                            return
                        }

                        if (document.schema === "https://schema.concrnt.net/reference.json") {
                            cckv = document.value.href
                        }

                        const baseURL = new URL(config.activitypub.baseUrl)
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
                    } else if (msg.type === "deleted") {
                        console.log(`Received deleted message for ${channel}`);

                        const cckv = msg.uri
                        const noteArgs = { identifier: entity.id, id: cckv }
                        const baseURL = new URL(config.activitypub.baseUrl)
                        const ctx = fedi.createContext(baseURL, undefined)
                        const noteURL = ctx.getObjectUri(Note, noteArgs)

                        await ctx.sendActivity(
                            { identifier: entity.id },
                            "followers",
                            new Delete({
                                id: new URL(`#delete-${Date.now()}`, noteURL),
                                actor: ctx.getActorUri(entity.id),
                                object: noteURL,
                            })
                        )
                    }
                }
            })

            const assocPrefix = `cckv://${config.concrnt.ccid}/activitypub.concrnt.world/inbox/`
            const msg = JSON.parse(message);
            if (msg.type === "associated" && channel.startsWith(assocPrefix)) {
                console.log(`Received association message for ${msg.uri}`);

                const ccfs = msg.association
                const association = await concrntApi.getDocument<any>(ccfs);
                console.log(`Fetched association document: ${association}`);
                const likerccid = association.author

                const likerEntity = await db.select().from(apEntity).where(eq(apEntity.ccid, likerccid)).limit(1).then(res => res[0]);
                if (!likerEntity) {
                    console.error(`No entity found for author CCID: ${likerccid}`);
                    return;
                }

                const target = await concrntApi.getDocument<any>(msg.uri);
                console.log(`Fetched document for association: ${target}`);

                const actorURL = new URL(target.value.actorURL);
                const noteURL = new URL(target.value.noteURL);

                const ctx = fedi.createContext(new URL(config.activitypub.baseUrl), undefined);
                const note = await ctx.lookupObject(noteURL.href);

                if (!note) {
                    console.error(`Failed to fetch note for association: ${noteURL.href}`);
                    return;
                }

                const likerUri = ctx.getActorUri(likerEntity.id);
                const likeActivityId = new URL(ccfs, likerUri)

                const actor = await ctx.lookupObject(actorURL.href);
                if (!actor || !isActor(actor)) {
                    console.error(`Failed to fetch actor for association: ${actorURL.href}`);
                    return;
                }

                // send like activity
                await ctx.sendActivity(
                    { identifier: likerEntity.id },
                    actor,
                    new Like({
                        id: likeActivityId,
                        actor: likerUri,
                        object: noteURL
                    })
                );

                /*
                const ccfs = msg.association
                const document = await concrntApi.getDocument<any>(ccfs);
                console.log(`Fetched document for association: ${document}`);
                */

            }
        } catch (error) {
            console.error("Error processing Redis message:", error);
        }

    });
}
