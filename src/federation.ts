import { createFederation } from "@fedify/fedify";
import { Person, Follow, Endpoints, Accept, Undo } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { RedisKvStore, RedisMessageQueue } from "@fedify/redis";
import { Redis } from "ioredis";
import { db, apEntity, apFollow } from './db/index.ts';
import { importJwk } from "@fedify/fedify";
import { eq, and } from "drizzle-orm";

const logger = getLogger("activitypub");

const federation = createFederation({
  kv: new RedisKvStore(new Redis(process.env.REDIS_URL)),
  queue: new RedisMessageQueue(() => new Redis(process.env.REDIS_URL)),
});

federation
    .setInboxListeners("/users/{identifier}/inbox", "/inbox")
    .on(Follow, async (ctx, follow) => {

        const object = ctx.parseUri(follow.objectId);
        if (object == null || object.type !== "actor") {
            logger.warn(`Received Follow activity with invalid object: ${follow.objectId}`);
            return;
        }

        const follower = await follow.getActor();
        if (follower?.id == null || follower.inboxId == null) {
            logger.warn(`Received Follow activity with invalid actor: ${follow.actorId}`);
            return;
        }

        // TODO: object.identifierを内部IDに変換 + 存在確認

        await db.insert(apFollow).values({
            accepted: true,
            publisherId: object.identifier,
            subscriberId: follow.actorId?.toString(),
        })

        const accept = new Accept({
            actor: follow.objectId,
            to: follow.actorId,
            object: follow,
        });

        await ctx.sendActivity(object, follower, accept);
    })
    .on(Undo, async (ctx, undo) => {
        const object = await undo.getObject();
        if (object instanceof Follow) {
            if (undo.actorId == null || undo.objectId == null) return
            const parsed = ctx.parseUri(object.objectId);
            if (parsed == null || parsed.type !== "actor") return;

            // TODO: object.identifierを内部IDに変換 + 存在確認

            await db
                .delete(apFollow)
                .where(
                    and(
                        eq(apFollow.publisherId, parsed.identifier),
                        eq(apFollow.subscriberId, undo.actorId.toString())
                    )
                );

        } else {
            logger.warn(`Received Undo activity with unsupported object: ${object}`);
        }
    });

federation.setActorDispatcher("/users/{identifier}", async (ctx, identifier) => {

    const users = await db.select().from(apEntity).where(eq(apEntity.id, identifier)).limit(1);
    if (users.length === 0) return null;

    const keys = await ctx.getActorKeyPairs(identifier);

    return new Person({
        id: ctx.getActorUri(identifier),
        preferredUsername: identifier,
        name: identifier,
        inbox: ctx.getInboxUri(identifier),
        endpoints: new Endpoints({
            sharedInbox: ctx.getInboxUri(),
        }),
        url: ctx.getActorUri(identifier),
        publicKey: keys[0]?.cryptographicKey,
        assertionMethods: keys.map((k) => k.multikey),
    });

}).setKeyPairsDispatcher(async (ctx, identifier) => {

    const users = await db.select().from(apEntity).where(eq(apEntity.id, identifier)).limit(1);
    if (users.length === 0) return [];
    
    const user = users[0];
    if (!user.publicKey || !user.privateKey) return [];

    return [{
        privateKey: await importJwk(JSON.parse(user.privateKey), "private"),
        publicKey: await importJwk(JSON.parse(user.publicKey), "public"),
    }]

});

export default federation;
