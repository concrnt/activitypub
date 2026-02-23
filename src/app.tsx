// @ts-nocheck this file is just a template
import { Hono } from "hono";
import { federation } from "@fedify/hono";
import { getLogger } from "@logtape/logtape";
import fedi from "./federation.ts";
import { Person, Note } from "@fedify/vocab";
import { db, apEntity } from "./db"
import { generateCryptoKeyPair, exportJwk } from "@fedify/fedify";

const logger = getLogger("activitypub");

const app = new Hono();
app.use(federation(fedi, () => undefined));

app.get("/", (c) => c.text("Hello, Fedify!"));

app.get("/api/test", async (c) => {
    return c.json({ message: "Hello from the API!" });
});

app.post("/api/setup", async (c) => {
    const { username } = await c.req.json();

    if (typeof username !== "string" || !username.trim()) {
        return c.json({ error: "Invalid 'username' in request body" }, 400);
    }

    console.log("Setting up ActivityPub entity for username:", username);

    const { privateKey, publicKey } = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");

    await db.insert(apEntity).values({
        id: username,
        publicKey: JSON.stringify(await exportJwk(publicKey)),
        privateKey: JSON.stringify(await exportJwk(privateKey)),
    })
});

app.get("/api/resolve", async (c) => {
    const ctx = fedi.createContext(c.req.raw, undefined);
    const uri = c.req.query("uri")?.trim();
    console.log("Resolving URI:", uri);
    if (typeof uri !== "string") {
        return c.json({ error: "Missing 'uri' query parameter" }, 400);
    }
    return await ctx.lookupObject(uri).then(async (obj) => {
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
            return c.json(obj);
        } else {
            console.log("Object not found for URI:", uri);
            return c.json({ error: "Object not found" }, 404);
        }
    })
});

export default app;
