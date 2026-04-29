import { createFederation } from "@fedify/fedify";
import { Person, Follow, Endpoints, Accept, Undo, Note, PUBLIC_COLLECTION, type Recipient } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { RedisKvStore, RedisMessageQueue } from "@fedify/redis";
import { Redis } from "ioredis";
import { db, apEntity, apFollow } from './db/index.ts';
import { importJwk } from "@fedify/fedify";
import { eq, and } from "drizzle-orm";
import { resolveConcrntDocument, type Document } from "./concrnt.ts";
import { Temporal } from "@js-temporal/polyfill";

const logger = getLogger("activitypub");

const federation = createFederation({
  kv: new RedisKvStore(new Redis(process.env.REDIS_URL)),
  queue: new RedisMessageQueue(() => new Redis(process.env.REDIS_URL)),
});

federation
    .setInboxListeners("/ap/users/{identifier}/inbox", "/inbox")
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

        const subscriberId = follow.actorId?.toString();
        if (subscriberId == null) {
            logger.warn(`Received Follow activity with invalid actor ID: ${follow.actorId}`);
            return;
        }

        await db.insert(apFollow).values({
            accepted: true,
            publisherId: object.identifier,
            subscriberId: subscriberId,
            subscriberInbox: follower.inboxId.toString(),
            subscriberSharedInbox: follower.endpoints?.sharedInbox?.toString(),
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

federation.setActorDispatcher("/ap/users/{identifier}", async (ctx, identifier) => {

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

federation.setFollowersDispatcher(
    "/ap/users/{identifier}/followers",
    async (ctx, identifier) => {
        const followers = await db.select().from(apFollow)
            .where(eq(apFollow.publisherId, identifier));

        const items: Recipient[] = followers.map(f => {
            if (!f.subscriberInbox) return null
            return {
                id: new URL(f.subscriberId),
                inboxId: new URL(f.subscriberInbox),
                endpoints:
                    f.subscriberSharedInbox
                    ? { sharedInbox: new URL(f.subscriberSharedInbox) }
                    : undefined,
            }
        }).filter(f => f !== null);

        return { items }
    },
).setCounter((ctx, identifier) => {
    return db.select().from(apFollow)
        .where(eq(apFollow.publisherId, identifier))
        .then(followers => followers.length)
});

federation.setObjectDispatcher(
    Note,
    "/ap/users/{identifier}/posts/{+id}",
    async (ctx, values) => {

        const entity = await db.select().from(apEntity).where(eq(apEntity.id, values.identifier)).limit(1);
        if (entity.length === 0) {
            logger.warn(`No entity found for identifier: ${values.identifier}`);
            return null;
        }

        const uri = URL.parse(values.id)
        if (uri == null) {
            logger.warn(`Invalid URI for Note ID: ${values.id}`);
            return null;
        }
        const owner = uri.host

        if (owner !== entity[0].ccid) {
            logger.warn(`Owner mismatch for Note. Expected: ${entity[0].ccid}, Found: ${owner}`);
            return null;
        }

        const sd = await resolveConcrntDocument(values.id);
        const document: Document<any> = JSON.parse(sd.document)

        return new Note({
            id: ctx.getObjectUri(Note, values),
            attribution: ctx.getActorUri(values.identifier),
            to: PUBLIC_COLLECTION,
            cc: ctx.getFollowersUri(values.identifier),
            content: document.value.body,
            mediaType: "text/html",
            published: Temporal.Instant.from(document.createdAt.toString()),
            url: ctx.getObjectUri(Note, values),
        })
    },
);

export default federation;
