import { createFederation, Follow, Person } from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { MemoryKvStore, InProcessMessageQueue } from "@fedify/fedify";

const logger = getLogger("cc-ap-bridge");

const federation = createFederation({
  kv: new MemoryKvStore(),
  queue: new InProcessMessageQueue(),
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
    return new Person({
        id: ctx.getActorUri(identifier),
        preferredUsername: identifier,
        name: identifier,
        url: new URL("/", ctx.url),
        inbox: ctx.getInboxUri(identifier),
    });
});

export default federation;
