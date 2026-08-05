import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono, type Context as HonoContext } from "hono";
import { cors } from "hono/cors";
import { federation } from "@fedify/hono";
import { getLogger } from "@logtape/logtape";
import fedi, { INSTANCE_ACTOR } from "./federation.ts";
import { db, apEntity } from "./db/index.ts"
import { eq } from "drizzle-orm";
import { config } from "./config.ts";
import * as followStore from "./followStore.ts";

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
    "net.concrnt.activitypub.resolve":   "/ap/api/resolve?uri={uri}",
};

// 以下2つは定期ポーリングされるため、fedifyミドルウェアより前に登録して
// fedify·federation·http のアクセスログ(毎リクエストINFO)に乗せない。

// concrnt本体が services 登録済みサービスへ直接ポーリングするサービス広告
app.get("/cc-info", (c) =>
    c.json({ name: pkg.name, version: pkg.version, endpoints: ccEndpoints })
);

// livenessProbe用ヘルスチェック
app.get("/health", (c) => c.json({ status: "ok" }));

app.use(federation(fedi, () => undefined));
app.use(cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
}));

app.get("/ap", (c) => c.text("Hello, Fedify!"));

app.get("/ap/api/info", async (c) => {

    const serverInfo: ApServerInfo = {
        serviceAccountId: config.concrnt.ccid,
    };

    return c.json(serverInfo);
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
    if (id.toLowerCase() === INSTANCE_ACTOR) {
        return c.json({ error: `'${INSTANCE_ACTOR}' is a reserved id` }, 400);
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

    const follows = followStore.getFollowing(entity.ccid)
        .filter(f => f.status !== 'rejected')
        .map(f => f.actorURI);

    const followers = followStore.getFollowers(entity.ccid)
        .map(f => f.actorURI);

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

    const followers = followStore.getFollowers(entity.ccid)
        .map(f => f.actorURI);

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

    // フォローはユーザー署名のcckvレコード(follows/)がsource of truth。
    // フォロー・アンフォロー操作はクライアントがレコードをcommit/deleteすることで行う。
    const following = followStore.getFollowing(entity.ccid)
        .filter(f => f.status !== 'rejected')
        .map(f => f.actorURI);

    return c.json(following);
});


app.get("/ap/api/resolve", async (c) => {
    const ctx = fedi.createContext(c.req.raw, undefined);
    let uri = c.req.query("uri")?.trim();
    if (typeof uri !== "string") {
        return c.json({ error: "Missing 'uri' query parameter" }, 400);
    }
    uri = decodeURIComponent(uri);
    uri = uri.replace(/^activity:\/\//, "https://");

    // authorized fetch実装向けに、リクエストユーザー(AP未セットアップならインスタンス
    // アクター)の鍵で署名して解決する
    const authInfo = receiveAuthInfo(c);
    const entity = authInfo
        ? await db.select().from(apEntity).where(eq(apEntity.ccid, authInfo.ccid)).limit(1).then(res => res[0])
        : undefined;
    const documentLoader = await ctx.getDocumentLoader({ identifier: entity?.id ?? INSTANCE_ACTOR });

    return await ctx.lookupObject(uri, { crossOrigin: 'trust', documentLoader }).then(async (obj) => {
        if (obj) {
            const jsonLd = await obj.toJsonLd() as Record<string, unknown>;
            // fedifyのvocabは_misskey_content等の未知プロパティをJSON-LD変換で落とすため、生JSONから拾い直す
            try {
                const raw = await documentLoader(obj.id?.href ?? uri);
                const rawDoc = raw.document as Record<string, unknown>;
                for (const key of Object.keys(rawDoc)) {
                    if (key.startsWith("_misskey_")) jsonLd[key] = rawDoc[key];
                }
            } catch (e) {
                logger.debug(`failed to fetch raw document for ${uri}: ${e}`);
            }
            return c.json(jsonLd);
        } else {
            logger.info(`Object not found for URI: ${uri}`);
            return c.json({ error: "Object not found" }, 404);
        }
    })
});

export default app;
