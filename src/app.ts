import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono, type Context as HonoContext } from "hono";
import { cors } from "hono/cors";
import { federation } from "@fedify/hono";
import { getLogger } from "@logtape/logtape";
import fedi from "./federation.ts";
import { isActor, Follow, Undo } from "@fedify/vocab";
import { db, apEntity } from "./db/index.ts"
import { eq, and } from "drizzle-orm";
import { apFollow } from "./db/schema.ts";
import { config } from "./config.ts";

const logger = getLogger("activitypub");

// ゲートウェイから伝搬される認証情報
interface AuthInfo {
    ccid: string
}

const receiveAuthInfo = (c: HonoContext): AuthInfo | null => {
    const authInfoStr = c.req.header("cc-requester")
    const authInfo = authInfoStr ? JSON.parse(authInfoStr) as AuthInfo : null;
    logger.debug(`Received request with auth info: ${authInfoStr}`);
    return authInfo;
}


const app = new Hono();
app.use(federation(fedi, () => undefined));
app.use(cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
}));

interface ApServerInfo {
    serviceAccountId: string
}

const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
) as { name: string; version: string };

// 本体は path.Join(service.Path, endpoint) で広告値を組み立てるため、
// services 設定では path を指定せず paths: [/ap, ...] + preservePath で登録すること
// (Fediverse向けURLが /ap 固定なので、このサービスはマウント位置を変えられない)。
const ccEndpoints: Record<string, string> = {
    "net.concrnt.activitypub.info":      "/ap/api/info",
    "net.concrnt.activitypub.setup":     "/ap/api/setup",      // POST {id}
    "net.concrnt.activitypub.settings":  "/ap/api/settings",   // GET=取得 / POST=更新
    "net.concrnt.activitypub.stats":     "/ap/api/stats",
    "net.concrnt.activitypub.followers": "/ap/api/followers",
    "net.concrnt.activitypub.following": "/ap/api/following",
    "net.concrnt.activitypub.follow":    "/ap/api/follow",     // POST {target}
    "net.concrnt.activitypub.unfollow":  "/ap/api/unfollow",   // POST {target}
    "net.concrnt.activitypub.resolve":   "/ap/api/resolve?uri={uri}",
};

// concrnt本体が services 登録済みサービスへ直接ポーリングするサービス広告
app.get("/cc-info", (c) =>
    c.json({ name: pkg.name, version: pkg.version, endpoints: ccEndpoints })
);

app.get("/ap", (c) => c.text("Hello, Fedify!"));

app.get("/ap/api/info", async (c) => {

    const serverInfo: ApServerInfo = {
        serviceAccountId: config.concrnt.ccid,
    };

    return c.json(serverInfo);
});



app.get("/ap/test", async (c) => {

    const authInfo = receiveAuthInfo(c);

    return c.json({ 
        message: "Hello from the API!",
        authInfo,
    });
});

app.post("/ap/api/setup", async (c) => {

    const authInfo = receiveAuthInfo(c)
    if (!authInfo) {
        return c.json({ error: "Missing authentication information" }, 400);
    }

    const { id } = await c.req.json();
    if (!id) {
        return c.json({ error: "Missing 'id' in request body" }, 400);
    }

    const ccid = authInfo.ccid

    logger.info(`Setting up ActivityPub entity for ccid: ${ccid}`);

    await db.insert(apEntity).values({
        id: id.toLowerCase(),
        ccid: ccid,
        enabled: true,
        listenTimelines: [],
    })

    return c.json({
        id: id,
        ccid: ccid,
        enabled: true,
        listenTimelines: [],
    })

});

app.get("/ap/api/settings", async (c) => {

    const authInfo = receiveAuthInfo(c)
    if (!authInfo) {
        return c.json({ error: "Missing authentication information" }, 400);
    }

    const id = authInfo.ccid

    const entity = await db.select().from(apEntity).where(eq(apEntity.ccid, id)).limit(1).then(res => res[0]);
    if (!entity) {
        return c.json({ error: "No ActivityPub entity found for this user" }, 404);
    }

    return c.json({
        ccid: entity.ccid,
        id: entity.id,
        enabled: entity.enabled,
        listenTimelines: entity.listenTimelines,
    });
});

app.post("/ap/api/settings", async (c) => {

    const authInfo = receiveAuthInfo(c)
    if (!authInfo) {
        return c.json({ error: "Missing authentication information" }, 400);
    }

    const id = authInfo.ccid

    const entity = await db.select().from(apEntity).where(eq(apEntity.ccid, id)).limit(1).then(res => res[0]);
    if (!entity) {
        return c.json({ error: "No ActivityPub entity found for this user" }, 404);
    }

    const { listenTimelines } = await c.req.json();

    await db.update(apEntity)
        .set({
            listenTimelines: listenTimelines ?? entity.listenTimelines,
        })
        .where(eq(apEntity.ccid, id));

    return c.json({ message: "Settings updated successfully" });
});


app.get("/ap/api/stats", async (c) => {

    const authInfo = receiveAuthInfo(c)
    if (!authInfo) {
        return c.json({ error: "Missing authentication information" }, 400);
    }

    const id = authInfo.ccid

    const entity = await db.select().from(apEntity).where(eq(apEntity.ccid, id)).limit(1).then(res => res[0]);
    if (!entity) {
        return c.json({ error: "No ActivityPub entity found for this user" }, 404);
    }

    const follows = await db.select().from(apFollow)
        .where(eq(apFollow.subscriberId, entity.id))
        .then(follows => follows.map(f => f.publisherId));

    const followers = await db.select().from(apFollow)
        .where(eq(apFollow.publisherId, entity.id))
        .then(followers => followers.map(f => f.subscriberId));

    return c.json({ follows, followers });
});

app.get("/ap/api/followers", async (c) => {

    const authInfo = receiveAuthInfo(c)
    if (!authInfo) {
        return c.json({ error: "Missing authentication information" }, 400);
    }

    const id = authInfo.ccid

    const entity = await db.select().from(apEntity).where(eq(apEntity.ccid, id)).limit(1).then(res => res[0]);
    if (!entity) {
        return c.json({ error: "No ActivityPub entity found for this user" }, 404);
    }

    const followers = await db.select().from(apFollow)
        .where(eq(apFollow.publisherId, entity.id))
        .then(followers => followers.map(f => f.subscriberId));

    return c.json(followers);
});

app.get("/ap/api/following", async (c) => {

    const authInfo = receiveAuthInfo(c)
    if (!authInfo) {
        return c.json({ error: "Missing authentication information" }, 400);
    }

    const id = authInfo.ccid

    const entity = await db.select().from(apEntity).where(eq(apEntity.ccid, id)).limit(1).then(res => res[0]);
    if (!entity) {
        return c.json({ error: "No ActivityPub entity found for this user" }, 404);
    }

    const following = await db.select().from(apFollow)
        .where(eq(apFollow.subscriberId, entity.id))
        .then(following => following.map(f => f.publisherId));

    return c.json(following);
});


app.post("/ap/api/follow", async (c) => {

    const authInfo = receiveAuthInfo(c)
    if (!authInfo) {
        return c.json({ error: "Missing authentication information" }, 400);
    }

    const id = authInfo.ccid

    const entity = await db.select().from(apEntity).where(eq(apEntity.ccid, id)).limit(1).then(res => res[0]);
    if (!entity) {
        return c.json({ error: "No ActivityPub entity found for this user" }, 404);
    }

    const { target } = await c.req.json();

    const ctx = fedi.createContext(c.req.raw, undefined);
    const actor = await ctx.lookupObject(target);
    if (actor == null || !isActor(actor) || actor.id == null) {
        return c.json({ error: "Target URI does not resolve to an actor" }, 400);
    }

    await ctx.sendActivity(
        { identifier: entity.id },
        actor,
        new Follow({
            actor: ctx.getActorUri(entity.id),
            object: actor.id,
            to: actor.id,
        }),
        { excludeBaseUris: [new URL(ctx.origin)] }
    )

    await db
        .insert(apFollow)
        .values({
            accepted: false,
            publisherId: actor.id.toString(),
            subscriberId: entity.id,
        })
        .onConflictDoNothing();

    return c.json({ message: "Follow request sent to " + target });
});

app.post("/ap/api/unfollow", async (c) => {

    const authInfo = receiveAuthInfo(c)
    if (!authInfo) {
        return c.json({ error: "Missing authentication information" }, 400);
    }

    const id = authInfo.ccid

    const entity = await db.select().from(apEntity).where(eq(apEntity.ccid, id)).limit(1).then(res => res[0]);
    if (!entity) {
        return c.json({ error: "No ActivityPub entity found for this user" }, 404);
    }

    const { target } = await c.req.json();

    const ctx = fedi.createContext(c.req.raw, undefined);
    const actor = await ctx.lookupObject(target);
    if (actor == null || !isActor(actor) || actor.id == null) {
        return c.json({ error: "Target URI does not resolve to an actor" }, 400);
    }

    await ctx.sendActivity(
        { identifier: entity.id },
        actor,
        new Undo({
            actor: ctx.getActorUri(entity.id),
            object: new Follow({
                actor: ctx.getActorUri(entity.id),
                object: actor.id,
                to: actor.id,
            }),
        }),
        { excludeBaseUris: [new URL(ctx.origin)] }
    )

    await db
        .delete(apFollow)
        .where(
            and(
                eq(apFollow.publisherId, actor.id.toString()),
                eq(apFollow.subscriberId, entity.id)
            )
        );

    return c.json({ message: "Unfollow request sent to " + target });
});


app.get("/ap/api/resolve", async (c) => {
    const ctx = fedi.createContext(c.req.raw, undefined);
    let uri = c.req.query("uri")?.trim();
    if (typeof uri !== "string") {
        return c.json({ error: "Missing 'uri' query parameter" }, 400);
    }
    uri = decodeURIComponent(uri);
    uri = uri.replace(/^activity:\/\//, "https://");

    return await ctx.lookupObject(uri, {crossOrigin: 'trust'}).then(async (obj) => {
        if (obj) {
            return c.json(await obj.toJsonLd() as object);
        } else {
            logger.info(`Object not found for URI: ${uri}`);
            return c.json({ error: "Object not found" }, 404);
        }
    })
});

export default app;
