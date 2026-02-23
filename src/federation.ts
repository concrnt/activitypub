import { createFederation } from "@fedify/fedify";
import { Person, Follow, Endpoints } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { RedisKvStore, RedisMessageQueue } from "@fedify/redis";
import { Redis } from "ioredis";
import { db, apEntity } from './db/index.ts';
import { importJwk } from "@fedify/fedify";
import { eq } from "drizzle-orm";

const logger = getLogger("activitypub");

const federation = createFederation({
  kv: new RedisKvStore(new Redis(process.env.REDIS_URL)),
  queue: new RedisMessageQueue(() => new Redis(process.env.REDIS_URL)),
});

federation
    .setInboxListeners("/users/{identifier}/inbox", "/inbox")
    .on(Follow, async (ctx, follow) => {
        if (follow.id == null || follow.actorId == null || follow.objectId == null) {
            return;
        }
        const parsed = ctx.parseUri(follow.objectId);
        if (parsed?.type !== "actor") return;
        const follower = await follow.getActor(ctx);
        console.debug(follower);
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
    if (users.length === 0) return null;
    
    const user = users[0];
    if (!user.publicKey || !user.privateKey) return null;

    return [{
        privateKey: await importJwk(JSON.parse(user.privateKey), "private"),
        publicKey: await importJwk(JSON.parse(user.publicKey), "public"),
    }]

});

export default federation;
