// @ts-nocheck this file is just a template
import { Hono } from "hono";
import { cors } from "hono/cors";
import { federation } from "@fedify/hono";
import { getLogger } from "@logtape/logtape";
import fedi from "./federation.ts";
import { Person, Note, isActor, Follow, Undo } from "@fedify/vocab";
import { db, apEntity } from "./db"
import { resolveConcrntDocument } from "./concrnt.ts";
import { eq, and } from "drizzle-orm";
import { apFollow } from "./db/schema.ts";

const logger = getLogger("activitypub");


const receiveAuthInfo = (c: any) => {
    const authInfoStr = c.req.header("cc-requester")
    const authInfo = authInfoStr ? JSON.parse(authInfoStr) : null;
    logger.info("Received request with auth info:", authInfo);
    return authInfo;
}


const app = new Hono();
app.use(federation(fedi, () => undefined));
app.use(cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
}));

app.get("/ap", (c) => c.text("Hello, Fedify!"));

app.get("/ap/concrnt", async (c) => {

    const uri = c.req.query("uri")?.trim();
    console.log("Received request for URI:", uri);

    if (!uri) {
        return c.json({ error: "Missing 'uri' query parameter" }, 400);
    }

    const sd = await resolveConcrntDocument(uri);
    console.log("Resolved Concrnt document:", sd);

    return c.json({ 
        message: "Hello from the API!",
    });
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

    console.log("Setting up ActivityPub entity for id:", ccid);

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
    if (!isActor(actor)) {
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
    if (!isActor(actor)) {
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
    const uri = c.req.query("uri")?.trim();
    console.log("Resolving URI:", uri);
    if (typeof uri !== "string") {
        return c.json({ error: "Missing 'uri' query parameter" }, 400);
    }
    return await ctx.lookupObject(uri, {crossOrigin: 'trust'}).then(async (obj) => {
        if (obj) {
            /*
            console.log(obj)
            console.log("===========")
            console.log(await obj.toJsonLd())
            console.log("===========")
            */
            if (obj instanceof Note) {
                console.log("Resolved Note content:", obj.content);
            } else if (obj instanceof Person) {
                console.log("Resolved Person name:", obj.name);
            } else {
                console.log("Resolved object of type:", obj);
            }
            return c.json(await obj.toJsonLd());
        } else {
            console.log("Object not found for URI:", uri);
            return c.json({ error: "Object not found" }, 404);
        }
    })
});

export default app;
