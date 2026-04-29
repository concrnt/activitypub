import { createFederation, exportJwk, generateCryptoKeyPair } from "@fedify/fedify";
import { Person, Follow, Endpoints, Accept, Undo, Note, PUBLIC_COLLECTION, type Recipient, isActor } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { RedisKvStore, RedisMessageQueue } from "@fedify/redis";
import { Redis } from "ioredis";
import { db, apEntity, apFollow, apKeys } from './db/index.ts';
import { importJwk } from "@fedify/fedify";
import { eq, and } from "drizzle-orm";
import { resolveConcrntDocument, type Document } from "./concrnt.ts";
import { Temporal } from "@js-temporal/polyfill";

const logger = getLogger("activitypub");

const federation = createFederation({
  kv: new RedisKvStore(new Redis(process.env.REDIS_URL)),
  queue: new RedisMessageQueue(() => new Redis(process.env.REDIS_URL)),
});

federation.setNodeInfoDispatcher("/nodeinfo/2.1", async (ctx) => {
    return {
        software: {
            name: "concrnt-ap-bridge",
            version: { major: 0, minor: 1, patch: 0 },
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

        const follow = await accept.getObject()
        if (!(follow instanceof Follow)) return

        const following = await accept.getActor()
        if (!isActor(following)) return

        const followerId = follow.actorId
        if (followerId == null) return

        /*
        await db.insert(apFollow).values({
            accepted: true,
            publisherId: follow.objectId.toString(),
            subscriberId: followerId.toString(),
        })
        */

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


    /*
    const users = await db.select().from(apEntity).where(eq(apEntity.id, identifier)).limit(1);
    if (users.length === 0) {
        console.warn(`No user found for identifier: ${identifier}`);
        return [];
    }
    
    const user = users[0];
    if (!user.publicKey || !user.privateKey) {
        console.warn(`User ${identifier} does not have valid keys`);
        return [];
    }

    return [{
        privateKey: await importJwk(JSON.parse(user.privateKey), "private"),
        publicKey: await importJwk(JSON.parse(user.publicKey), "public"),
    }]
    */

   /*
    const user = db
      .prepare<unknown[], User>("SELECT * FROM users WHERE username = ?")
      .get(identifier);
    if (user == null) return [];
    const rows = db
      .prepare<unknown[], Key>("SELECT * FROM keys WHERE keys.user_id = ?")
      .all(user.id);
    const keys = Object.fromEntries(
      rows.map((row) => [row.type, row]),
    ) as Record<Key["type"], Key>;
    const pairs: CryptoKeyPair[] = [];
    // For each of the two key formats (RSASSA-PKCS1-v1_5 and Ed25519) that
    // the actor supports, check if they have a key pair, and if not,
    // generate one and store it in the database:
    for (const keyType of ["RSASSA-PKCS1-v1_5", "Ed25519"] as const) {
      if (keys[keyType] == null) {
        logger.debug(
          "The user {identifier} does not have an {keyType} key; creating one...",
          { identifier, keyType },
        );
        const { privateKey, publicKey } = await generateCryptoKeyPair(keyType);
        db.prepare(
          `
          INSERT INTO keys (user_id, type, private_key, public_key)
          VALUES (?, ?, ?, ?)
          `,
        ).run(
          user.id,
          keyType,
          JSON.stringify(await exportJwk(privateKey)),
          JSON.stringify(await exportJwk(publicKey)),
        );
        pairs.push({ privateKey, publicKey });
      } else {
        pairs.push({
          privateKey: await importJwk(
            JSON.parse(keys[keyType].private_key),
            "private",
          ),
          publicKey: await importJwk(
            JSON.parse(keys[keyType].public_key),
            "public",
          ),
        });
      }
    }
    return pairs;
    */




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
