import { Redis } from "ioredis";
import type { Object as ApObject } from "@fedify/vocab";
import { config } from "./config.ts";

// inbox受信・resolve済みAPオブジェクトの本文キャッシュ。DBには保存しない純粋な
// TTL付きキャッシュで、リモートへのfetch回数削減と即応答が目的。副次的に、
// リモートが再fetchを許さないオブジェクト(Misskeyのフォロワー限定ノート等)も
// TTLの間は表示できる。TTL切れ後に遡って取得不能になるのは仕様として許容する。

const OBJECT_PREFIX = "apcache:object:";
const ALIAS_PREFIX = "apcache:alias:";

export interface CachedApObject {
    json: Record<string, unknown>;
    actorUri: string;
    // to/cc に as:Public を含むオブジェクトは誰にでも返せる
    public: boolean;
    // 非publicオブジェクトを閲覧できるccid。受信時に配送対象だったローカル
    // フォロワー+宛先ローカルユーザーのスナップショットで、読み出し時の
    // フォロー再判定はしない
    allowedCcids: string[];
    receivedAt: string;
}

const redis = new Redis(config.redis.url);

// fedifyのtoJsonLd()はvocab未知のプロパティを落とすため、受信時の生JSON-LDから
// _misskey_*(MFMソース等)を拾い直してマージする。埋め込みオブジェクトは自身の
// _cachedJsonLdを持たないため、アクティビティ側の生JSON-LDのobjectから拾う
export const buildCacheJson = async (object: ApObject, activity?: ApObject): Promise<Record<string, unknown>> => {
    const jsonLd = await object.toJsonLd() as Record<string, unknown>;
    let raw = (object as unknown as { _cachedJsonLd?: unknown })._cachedJsonLd;
    if (raw == null && activity != null) {
        const activityRaw = (activity as unknown as { _cachedJsonLd?: unknown })._cachedJsonLd;
        if (activityRaw != null && typeof activityRaw === "object") {
            const embedded = (activityRaw as Record<string, unknown>).object;
            if (embedded != null && typeof embedded === "object" && !Array.isArray(embedded)) {
                raw = embedded;
            }
        }
    }
    if (raw != null && typeof raw === "object") {
        for (const [key, value] of Object.entries(raw)) {
            if (key.startsWith("_misskey_")) jsonLd[key] = value;
        }
    }
    return jsonLd;
};

export const putObject = async (uri: string, entry: CachedApObject): Promise<void> => {
    await redis.set(OBJECT_PREFIX + uri, JSON.stringify(entry), "EX", config.activitypub.objectCacheTTL);
};

// 正準id以外のURLでresolveされた場合の別名。実体は持たず正準idへのポインタに
// する(Deleteで正準idをpurgeするだけで実体が確実に消えるように)
export const putAlias = async (uri: string, canonicalUri: string): Promise<void> => {
    await redis.set(ALIAS_PREFIX + uri, canonicalUri, "EX", config.activitypub.objectCacheTTL);
};

export const getObject = async (uri: string): Promise<CachedApObject | null> => {
    let raw = await redis.get(OBJECT_PREFIX + uri);
    if (raw == null) {
        const canonical = await redis.get(ALIAS_PREFIX + uri);
        if (canonical == null) return null;
        raw = await redis.get(OBJECT_PREFIX + canonical);
    }
    if (raw == null) return null;
    return JSON.parse(raw) as CachedApObject;
};

export const deleteObject = async (uri: string): Promise<void> => {
    await redis.del(OBJECT_PREFIX + uri);
};
