import { createFederation, exportJwk, generateCryptoKeyPair } from "@fedify/fedify";
import { Person, Follow, Endpoints, Accept, Undo, Note, PUBLIC_COLLECTION, type Recipient, Create, Like } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { RedisKvStore, RedisMessageQueue } from "@fedify/redis";
import { Redis } from "ioredis";
import { db, apEntity, apFollow, apKeys } from './db/index.ts';
import { importJwk } from "@fedify/fedify";
import { eq, and } from "drizzle-orm";
import { Temporal } from "@js-temporal/polyfill";
import { CDID, type Document } from '@concrnt/client'

import concrntApi from "./concrnt.ts";
import { config } from "./config.ts";

const commit = async (document: Document<any>) => {
    await concrntApi.commit(document, concrntApi.defaultHost, { useMasterkey: true })
}

const logger = getLogger("activitypub");

const federation = createFederation({
    kv: new RedisKvStore(new Redis(config.redis.url)),
    queue: new RedisMessageQueue(() => new Redis(config.redis.url)),
});

federation.setNodeInfoDispatcher("/ap/nodeinfo/2.1", async (ctx) => {
    return {
        software: {
            name: "concrnt-ap-bridge",
            version: "0.1.0",
            homepage: new URL("https://github.com/concrnt/activitypub"),
        },
        protocols: ["activitypub"],
        usage: {
            users: {
                total: 0,
            },
            localPosts: 0,
            localComments: 0,
        }
    }
})

federation
    .setInboxListeners("/ap/users/{identifier}/inbox", "/ap/inbox")
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
        .onConflictDoUpdate({
            target: [apFollow.publisherId, apFollow.subscriberId],
            set: {
                accepted: true,
                subscriberInbox: follower.inboxId.toString(),
                subscriberSharedInbox: follower.endpoints?.sharedInbox?.toString(),
            },
        })

        const accept = new Accept({
            actor: follow.objectId,
            to: follow.actorId,
            object: follow,
        });

        await ctx.sendActivity(object, follower, accept);
    })
    .on(Undo, async (ctx, undo) => {
        console.log("Received Undo activity:", undo);
        const object = await undo.getObject();
        console.log("Parsed object from Undo activity:", object);
        if (object instanceof Follow) {
            console.log("Undoing Follow activity:", object);
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
    })
    .on(Accept, async (ctx, accept) => {
        console.log("Received Accept activity:", accept);

        console.log("Parsing object from Accept activity...");
        const follow = await accept.getObject({ crossOrigin: 'trust' });
        if (!(follow instanceof Follow)) return

        const followerId = follow.actorId
        if (followerId == null) return
        const parsed = ctx.parseUri(followerId)
        if (parsed == null || parsed.type !== "actor") return
        const followerIdentifier = parsed.identifier

        const followTarget = follow.objectId
        if (followTarget == null) return

        await db
            .insert(apFollow)
            .values({
                accepted: true,
                publisherId: followTarget.toString(),
                subscriberId: followerIdentifier,
            })
            .onConflictDoUpdate({
                target: [apFollow.publisherId, apFollow.subscriberId],
                set: {
                    accepted: true,
                },
            });
    })
    .on(Create, async (ctx, create) => {
        console.log("Received Create activity:", create);

        const actorId = create.actorId;
        if (actorId == null) {
            logger.warn(`Received Create activity with missing actor ID`);
            return;
        }
        const actorUri = create.actorId?.toString();
        if (actorUri == null) {
            logger.warn(`Received Create activity with invalid actor ID: ${create.actorId}`);
            return;
        }

        const followers = await db.select().from(apFollow)
            .where(eq(apFollow.publisherId, actorId.toString()));

        if (followers.length === 0) {
            logger.info(`Actor ${actorId} has no followers. Skipping Create activity.`);
            return;
        }

        const object = await create.getObject();
        if (object == null) {
            logger.warn(`Received Create activity with missing object`);
            return;
        }

        const objectUri = object.id?.toString();
        if (objectUri == null) {
            logger.warn(`Received Create activity with object missing ID`);
            return;
        }

        const objectUriHash = CDID.makeHash(new TextEncoder().encode(objectUri)).toString();

        const distribution: string[] = []

        for (const follower of followers) {
            const entity = await db.select().from(apEntity).where(eq(apEntity.id, follower.subscriberId)).limit(1).then(res => res[0]);
            if (!entity) {
                logger.warn(`No entity found for publisher ID: ${follower.publisherId}`);
                continue;
            }
            distribution.push(`cckv://${entity.ccid}/activitypub.concrnt.world/inbox`);
        }

        const document: Document<any> = {
            key: `cckv://${config.concrnt.ccid}/activitypub.concrnt.world/inbox/${objectUriHash}`,
            schema: "https://schema.concrnt.world/ap/note.json",
            value: {
                "actorURL": actorUri,
                "noteURL": objectUri
            },
            author: config.concrnt.ccid,
            createdAt: object.published ? new Date(object.published.toString()) : new Date(),
            distributes: distribution,
        }

        console.log("Committing document to Concrnt:", document);

        await commit(document);
    })
    .on(Like, async (ctx, like) => {
        console.log("Received Like activity:", like);

        const actorId = like.actorId;
        if (actorId == null) {
            logger.warn(`Received Like activity with missing actor ID`);
            return;
        }
        const actorUri = like.actorId?.toString();
        if (actorUri == null) {
            logger.warn(`Received Like activity with invalid actor ID: ${like.actorId}`);
            return;
        }

        const target = ctx.parseUri(like.objectId);
        if (target == null || target.type !== "object") {
            logger.warn(`Received Like activity with invalid object: ${like.objectId}`);
            return;
        }

        const apid = target.values.identifier
        const cckv = target.values.id

        const entity = await db.select().from(apEntity).where(eq(apEntity.id, apid)).limit(1).then(res => res[0]);
        if (!entity) {
            logger.warn(`No entity found for actor URI: ${actorUri}`);
            return;
        }
        const ccid = entity.ccid

        const distributes: string[] = [
            `cckv://${ccid}/concrnt.world/profiles/main/notify-timeline`
        ]

        const document: Document<any> = {
            author: config.concrnt.ccid,
            schema: "https://schema.concrnt.world/a/like.json",
            associate: cckv,
            value: {},
            distributes,
            createdAt: new Date(),
        }

        await commit(document);

    })
;


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
        followers: ctx.getFollowersUri(identifier),
    });

}).setKeyPairsDispatcher(async (ctx, identifier) => {


    const keys = await db.select().from(apKeys).where(eq(apKeys.ownerId, identifier));

    const pairs: CryptoKeyPair[] = []

    for (const keyType of ["RSASSA-PKCS1-v1_5", "Ed25519"] as const) {
        const key = keys.find(k => k.keyType === keyType);
        if (key == null) {
            logger.debug(
                `The user ${identifier} does not have a ${keyType} key; creating one...`,
            );
            const { privateKey, publicKey } = await generateCryptoKeyPair(keyType);
            await db.insert(apKeys).values({
                ownerId: identifier,
                keyType,
                private: JSON.stringify(await exportJwk(privateKey)),
                public: JSON.stringify(await exportJwk(publicKey)),
            });
            pairs.push({ privateKey, publicKey });
        } else {
            pairs.push({
                privateKey: await importJwk(JSON.parse(key.private), "private"),
                publicKey: await importJwk(JSON.parse(key.public), "public"),
            });
        }
    }

    return pairs;
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

        const document = await concrntApi.getDocument<any>(values.id)

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
