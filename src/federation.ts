import { createFederation } from "@fedify/fedify";
import { Person, Follow } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { RedisKvStore, RedisMessageQueue } from "@fedify/redis";
import { Redis } from "ioredis";

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

federation.setActorDispatcher(
  "/users/{identifier}",
  async (ctx, identifier) => {
    return new Person({
      id: ctx.getActorUri(identifier),
      preferredUsername: identifier,
      name: identifier,
    });
  },
);

export default federation;
