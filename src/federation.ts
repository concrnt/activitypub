import { createFederation, exportJwk, generateCryptoKeyPair } from "@fedify/fedify";
import { Person, Follow, Endpoints, Accept, Reject, Undo, Note, type Recipient, Create, Like, Delete, Announce, EmojiReact, Emoji, Image, Update, type Actor } from "@fedify/vocab";
import type { Context } from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { RedisKvStore, RedisMessageQueue } from "@fedify/redis";
import { Redis } from "ioredis";
import { db, apEntity, apKeys, apObjectReference, apInboundObject } from './db/index.ts';
import { importJwk } from "@fedify/fedify";
import { eq, and } from "drizzle-orm";
import { CDID } from '@concrnt/client'

import concrntApi, { commit, type CommitDocument } from "./concrnt.ts";
import { config } from "./config.ts";
import { SCHEMA_AP_NOTE, SCHEMA_REROUTE, SCHEMA_LIKE, SCHEMA_REACTION, SCHEMA_DELETE, parseEmojiShortcode, renderMarkdownToHtml, buildNote } from "./convert.ts";
import { SCHEMA_AP_FOLLOWER, SCHEMA_AP_ACCEPT_STATE, followerKey, acceptStateKey, type ApFollowerValue } from "./schemas.ts";
import * as followStore from "./followStore.ts";
import {
    collectAudience,
    determineInboundVisibility,
    intersectInboundRecipients,
    isMissingCommitTargetError,
    isRestrictedInboundVisibility,
    mostRestrictiveInboundVisibility,
    type InboundVisibility,
} from "./inbound.ts";

const logger = getLogger("activitypub");

const actorPath = `/ap/${config.activitypub.actorPathSegment}`;

// AP objectのURLから、ブリッジ管理下のconcrnt保存先キーを決定的に導出する
const inboxKey = (url: string) =>
    `cckv://${config.concrnt.ccid}/activitypub.concrnt.world/inbox/${CDID.makeHash(new TextEncoder().encode(url)).toString()}`;

interface InboundDelivery {
    recipientCcids: string[];
    distributes: string[];
    visibility: InboundVisibility;
}

const makeInboundDelivery = (
    recipientCcids: readonly string[],
    visibility: InboundVisibility,
): InboundDelivery => {
    const recipients = [...new Set(recipientCcids)];
    return {
        recipientCcids: recipients,
        distributes: recipients.map((ccid) => `cckv://${ccid}/activitypub.concrnt.world/inbox`),
        visibility,
    };
};

const restrictReadersPolicy = (delivery: InboundDelivery): CommitDocument<any>["policy"] | undefined => {
    if (!isRestrictedInboundVisibility(delivery.visibility)) return undefined;
    return {
        entries: [{
            url: "https://policy.concrnt.world/t/restrict-readers.json",
            params: { entities: delivery.recipientCcids },
            defaults: { "record:read": "no" },
        }],
    };
};

const resolveInboundDelivery = async (
    ctx: { parseUri: (uri: URL | null) => any },
    actorUri: string,
    activityTo: readonly URL[],
    activityCc: readonly URL[],
    objectTo: readonly URL[],
    objectCc: readonly URL[],
    followersUri?: string,
): Promise<InboundDelivery> => {
    const to = collectAudience(activityTo, objectTo);
    const cc = collectAudience(activityCc, objectCc);
    const audience = [...new Set([...to, ...cc])];
    const visibility = determineInboundVisibility(to, cc, followersUri);
    const recipientCcids = new Set<string>();

    if (visibility !== "direct") {
        for (const ccid of followStore.getLocalFollowerCcids(actorUri)) {
            recipientCcids.add(ccid);
        }
    }

    // Direct posts and explicitly addressed mentions must reach a local actor
    // even when that actor does not follow the remote author.
    for (const uri of audience) {
        let parsed: ReturnType<typeof ctx.parseUri>;
        try {
            parsed = ctx.parseUri(new URL(uri));
        } catch {
            continue;
        }
        if (parsed == null || parsed.type !== "actor") continue;

        const entity = await db.select().from(apEntity)
            .where(eq(apEntity.id, parsed.identifier)).limit(1).then(res => res[0]);
        if (entity?.enabled) recipientCcids.add(entity.ccid);
    }

    return makeInboundDelivery([...recipientCcids], visibility);
};

const storeInboundObject = async (
    objectId: string,
    actorId: string,
    object: Record<string, unknown>,
    delivery: InboundDelivery,
): Promise<InboundDelivery | null> => {
    const existing = await db.select().from(apInboundObject)
        .where(eq(apInboundObject.objectId, objectId)).limit(1).then(res => res[0]);
    if (existing && existing.actorId !== actorId) {
        logger.warn(`Inbound object actor mismatch for ${objectId}: ${actorId} vs ${existing.actorId}`);
        return null;
    }

    const storedDelivery = makeInboundDelivery(
        [...(existing?.recipientCcids ?? []), ...delivery.recipientCcids],
        existing
            ? mostRestrictiveInboundVisibility(existing.visibility, delivery.visibility)
            : delivery.visibility,
    );

    await db.insert(apInboundObject).values({
        objectId,
        actorId,
        object,
        recipientCcids: storedDelivery.recipientCcids,
        visibility: storedDelivery.visibility,
    }).onConflictDoUpdate({
        target: apInboundObject.objectId,
        set: {
            object,
            recipientCcids: storedDelivery.recipientCcids,
            visibility: storedDelivery.visibility,
            updatedAt: new Date(),
        },
    });

    return storedDelivery;
};

// リモートnoteを参照ドキュメント(ap/note.json)としてconcrntに保存し、保存先キーを返す
const storeApNote = async (
    noteURL: string,
    actorURL: string,
    createdAt: Date,
    distributes: string[],
    delivery?: InboundDelivery,
): Promise<string> => {
    const key = inboxKey(noteURL);
    const policy = delivery ? restrictReadersPolicy(delivery) : undefined;
    const document: CommitDocument<any> = {
        kind: 'record',
        key,
        schema: SCHEMA_AP_NOTE,
        value: {
            "actorURL": actorURL,
            "noteURL": noteURL,
        },
        author: config.concrnt.ccid,
        createdAt,
        distributes,
        ...(policy ? { policy } : {}),
    };
    await commit(document);
    return key;
};

// リモートアクターの表示情報をprofileOverrideとして抽出する
const buildProfileOverride = async (actor: Actor | null): Promise<{ username?: string, avatar?: string, link?: string } | undefined> => {
    if (actor == null) return undefined;
    const override: { username?: string, avatar?: string, link?: string } = {};

    const username = actor.name?.toString() ?? actor.preferredUsername?.toString();
    if (username) override.username = username;

    try {
        const icon = await actor.getIcon();
        const url = icon?.url;
        if (url instanceof URL) {
            override.avatar = url.href;
        } else if (url?.href != null) {
            override.avatar = url.href.href;
        }
    } catch {
        // アイコン取得失敗は装飾情報のため無視
    }

    if (actor.id != null) override.link = actor.id.href;

    return override;
};

// Like/EmojiReactから絵文字リアクション情報を抽出する。なければnull(プレーンなLike)。
const extractEmojiReaction = async (activity: Like | EmojiReact): Promise<{ shortcode: string, imageUrl: string | null } | null> => {
    let shortcode = parseEmojiShortcode(activity.content?.toString());
    let imageUrl: string | null = null;

    try {
        for await (const tag of activity.getTags()) {
            if (tag instanceof Emoji) {
                const name = parseEmojiShortcode(tag.name?.toString());
                if (name) shortcode = name;
                const icon = await tag.getIcon();
                const url = icon?.url;
                if (url instanceof URL) {
                    imageUrl = url.href;
                } else if (url?.href != null) {
                    imageUrl = url.href.href;
                }
                break;
            }
        }
    } catch {
        // タグ解決失敗時はcontentから得られた情報のみで判断する
    }

    if (!shortcode) return null;
    return { shortcode, imageUrl };
};

// Like / EmojiReact 共通の受信処理
const handleLikeActivity = async (ctx: { parseUri: (uri: URL | null) => any }, activity: Like | EmojiReact) => {
    const actorUri = activity.actorId?.toString();
    const activityId = activity.id?.toString();
    if (actorUri == null || activityId == null) {
        logger.warn(`Received Like/EmojiReact activity with missing actor or activity ID`);
        return;
    }

    const target = ctx.parseUri(activity.objectId);
    if (target == null || target.type !== "object") {
        logger.warn(`Received Like/EmojiReact activity with invalid object: ${activity.objectId}`);
        return;
    }

    const apid = target.values.identifier;
    const cckv = target.values.id;

    const entity = await db.select().from(apEntity).where(eq(apEntity.id, apid)).limit(1).then(res => res[0]);
    if (!entity) {
        logger.warn(`No entity found for identifier: ${apid}`);
        return;
    }

    const distributes: string[] = [
        `cckv://${entity.ccid}/concrnt.world/profiles/main/notify-timeline`
    ];

    const liker = await activity.getActor().catch(() => null);
    const profileOverride = await buildProfileOverride(liker);

    const reaction = await extractEmojiReaction(activity);

    let document: CommitDocument<any>;
    if (reaction != null) {
        document = {
            kind: 'association',
            author: config.concrnt.ccid,
            schema: SCHEMA_REACTION,
            associate: cckv,
            associationVariant: reaction.imageUrl ?? reaction.shortcode,
            value: {
                shortcode: reaction.shortcode,
                imageUrl: reaction.imageUrl ?? '',
                ...(profileOverride ? { profileOverride } : {}),
            },
            distributes,
            createdAt: new Date(),
        };
    } else {
        document = {
            kind: 'association',
            author: config.concrnt.ccid,
            schema: SCHEMA_LIKE,
            associate: cckv,
            value: profileOverride ? { profileOverride } : {},
            distributes,
            createdAt: new Date(),
        };
    }

    const signed = await commit(document);

    // Undo(Like)でassociationを削除できるよう、AP activity id → ccfs を記録する
    if (signed?.ccfs) {
        await db.insert(apObjectReference).values({
            apObjectId: activityId,
            ccUri: signed.ccfs,
            refType: 'inbound-like',
        }).onConflictDoNothing();
    }
};

const federation = createFederation({
    kv: new RedisKvStore(new Redis(config.redis.url)),
    queue: new RedisMessageQueue(() => new Redis(config.redis.url)),
});

federation.setNodeInfoDispatcher("/ap/nodeinfo/2.1", async (ctx) => {
    const users = await db.select().from(apEntity).where(eq(apEntity.enabled, true));
    return {
        software: {
            name: "concrnt-ap-bridge",
            version: "0.1.0",
            homepage: new URL("https://github.com/concrnt/activitypub"),
        },
        protocols: ["activitypub"],
        usage: {
            users: {
                total: users.length,
            },
            localPosts: 0,
            localComments: 0,
        }
    }
})

federation
    .setInboxListeners(`${actorPath}/{identifier}/inbox`, "/ap/inbox")
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

        const subscriberId = follow.actorId?.toString();
        if (subscriberId == null) {
            logger.warn(`Received Follow activity with invalid actor ID: ${follow.actorId}`);
            return;
        }

        // フォロー対象のエンティティが存在し有効な場合のみ受け入れる
        const targetEntity = await db.select().from(apEntity)
            .where(eq(apEntity.id, object.identifier)).limit(1).then(res => res[0]);
        if (!targetEntity || !targetEntity.enabled) {
            logger.info(`Rejecting Follow for unknown or disabled entity: ${object.identifier}`);
            const reject = new Reject({
                actor: follow.objectId,
                to: follow.actorId,
                object: follow,
            });
            await ctx.sendActivity(object, follower, reject);
            return;
        }

        // フォロワーをサービスアカウントのレコードとして記録する。
        // 同一キーへの再commitはupdateになるため、再Follow時のinbox更新もこれで効く。
        const key = followerKey(config.concrnt.ccid, targetEntity.ccid, subscriberId);
        const value: ApFollowerValue = {
            ccid: targetEntity.ccid,
            actorURI: subscriberId,
            inbox: follower.inboxId.toString(),
        };
        const sharedInbox = follower.endpoints?.sharedInbox?.toString();
        if (sharedInbox) value.sharedInbox = sharedInbox;

        await commit({
            kind: 'record',
            key,
            schema: SCHEMA_AP_FOLLOWER,
            value,
            author: config.concrnt.ccid,
            createdAt: new Date(),
        });
        followStore.setFollower({ ccid: targetEntity.ccid, key, actorURI: subscriberId, inbox: value.inbox, sharedInbox });

        const accept = new Accept({
            actor: follow.objectId,
            to: follow.actorId,
            object: follow,
        });

        await ctx.sendActivity(object, follower, accept);
    })
    .on(Undo, async (ctx, undo) => {
        logger.debug(`Received Undo activity from ${undo.actorId}`);
        const object = await undo.getObject();
        if (object instanceof Follow) {
            if (undo.actorId == null || undo.objectId == null) return
            const parsed = ctx.parseUri(object.objectId);
            if (parsed == null || parsed.type !== "actor") return;

            const targetEntity = await db.select().from(apEntity)
                .where(eq(apEntity.id, parsed.identifier)).limit(1).then(res => res[0]);
            if (!targetEntity) {
                logger.warn(`Received Undo(Follow) for unknown entity: ${parsed.identifier}`);
                return;
            }

            const key = followerKey(config.concrnt.ccid, targetEntity.ccid, undo.actorId.toString());
            await commit({
                kind: 'delete',
                schema: SCHEMA_DELETE,
                value: key,
                author: config.concrnt.ccid,
                createdAt: new Date(),
            }).catch((error) => {
                // レコードが元々存在しない場合も先へ進む(冪等)
                logger.warn(`Failed to delete follower record ${key}: ${error}`);
            });
            followStore.removeFollowerByKey(key);

        } else if (object instanceof Announce) {
            if (object.id == null || undo.actorId == null) return;

            // Undo の送信者が Announce の作者本人であることを確認する
            // (他者のブースト削除を防ぐ)
            if (object.actorId != null && object.actorId.href !== undo.actorId.href) {
                logger.warn(`Undo(Announce) actor mismatch: ${undo.actorId} vs ${object.actorId}`);
                return;
            }

            // 受信AnnounceはannounceのURLから決定的に導出したキーで保存しているため、
            // 参照テーブルなしで削除対象を特定できる
            const document: CommitDocument<any> = {
                kind: 'delete',
                schema: SCHEMA_DELETE,
                value: inboxKey(object.id.href),
                author: config.concrnt.ccid,
                createdAt: new Date(),
            };
            await commit(document);
        } else if (object instanceof Like || object instanceof EmojiReact) {
            if (object.id == null) return;

            // 受信Likeとして記録した参照のみを対象にする
            // (送信済みLike等の他refTypeを誤って削除しない)
            const ref = await db.select().from(apObjectReference)
                .where(and(
                    eq(apObjectReference.apObjectId, object.id.href),
                    eq(apObjectReference.refType, 'inbound-like'),
                )).limit(1).then(res => res[0]);
            if (!ref) {
                logger.warn(`No inbound-like reference found for Undo(Like): ${object.id.href}`);
                return;
            }

            const document: CommitDocument<any> = {
                kind: 'delete',
                schema: SCHEMA_DELETE,
                value: ref.ccUri,
                author: config.concrnt.ccid,
                createdAt: new Date(),
            };
            await commit(document);

            await db.delete(apObjectReference).where(eq(apObjectReference.apObjectId, object.id.href));
        } else {
            logger.warn(`Received Undo activity with unsupported object: ${object}`);
        }
    })
    .on(Accept, async (ctx, accept) => {
        logger.debug(`Received Accept activity from ${accept.actorId}`);

        const follow = await accept.getObject({ crossOrigin: 'trust' });
        if (!(follow instanceof Follow)) return

        const followerId = follow.actorId
        if (followerId == null) return
        const parsed = ctx.parseUri(followerId)
        if (parsed == null || parsed.type !== "actor") return
        const followerIdentifier = parsed.identifier

        const followTarget = follow.objectId
        if (followTarget == null) return

        const entity = await db.select().from(apEntity)
            .where(eq(apEntity.id, followerIdentifier)).limit(1).then(res => res[0]);
        if (!entity) {
            logger.warn(`Received Accept(Follow) for unknown entity: ${followerIdentifier}`);
            return;
        }

        const actorURI = followTarget.toString();
        const key = acceptStateKey(config.concrnt.ccid, entity.ccid, actorURI);
        await commit({
            kind: 'record',
            key,
            schema: SCHEMA_AP_ACCEPT_STATE,
            value: { ccid: entity.ccid, actorURI, status: 'accepted' },
            author: config.concrnt.ccid,
            createdAt: new Date(),
        });
        followStore.setAcceptState(key, entity.ccid, actorURI, 'accepted');
    })
    .on(Create, async (ctx, create) => {
        const actorUri = create.actorId?.toString();
        if (actorUri == null) {
            logger.warn(`Received Create activity with missing actor ID`);
            return;
        }

        const object = await create.getObject();
        const objectUri = object?.id?.toString();
        if (object == null || objectUri == null) {
            logger.warn(`Received Create activity with missing or invalid object`);
            return;
        }

        const actor = await create.getActor().catch(() => null);
        const delivery = await resolveInboundDelivery(
            ctx,
            actorUri,
            create.toIds,
            create.ccIds,
            object.toIds,
            object.ccIds,
            actor?.followersId?.href,
        );
        if (delivery.distributes.length === 0) {
            logger.info(`Create ${objectUri} has no local recipients. Skipping.`);
            return;
        }

        const snapshot = await object.toJsonLd() as Record<string, unknown>;
        const storedDelivery = await storeInboundObject(objectUri, actorUri, snapshot, delivery);
        if (!storedDelivery) return;

        await storeApNote(
            objectUri,
            actorUri,
            object.published ? new Date(object.published.toString()) : new Date(),
            delivery.distributes,
            storedDelivery,
        );
    })
    .on(Announce, async (ctx, announce) => {
        const actorUri = announce.actorId?.toString();
        const announceUri = announce.id?.toString();
        if (actorUri == null || announceUri == null) {
            logger.warn(`Received Announce activity with missing actor or activity ID`);
            return;
        }

        const object = await announce.getObject();
        const noteURL = object?.id?.toString();
        if (object == null || noteURL == null) {
            logger.warn(`Received Announce activity with unresolvable object: ${announce.objectId}`);
            return;
        }

        const booster = await announce.getActor().catch(() => null);
        const hasAnnounceAudience = announce.toIds.length > 0 || announce.ccIds.length > 0;
        const outerDelivery = await resolveInboundDelivery(
            ctx,
            actorUri,
            hasAnnounceAudience ? announce.toIds : object.toIds,
            hasAnnounceAudience ? announce.ccIds : object.ccIds,
            [],
            [],
            booster?.followersId?.href,
        );
        if (outerDelivery.distributes.length === 0) {
            logger.info(`Announce ${announceUri} has no local recipients. Skipping.`);
            return;
        }

        const noteActorURL = object.attributionId?.toString() ?? actorUri;
        const noteActor = await object.getAttribution({ crossOrigin: 'trust' }).catch(() => null);
        const objectFollowersUri = noteActor?.followersId?.href
            ?? [...object.toIds, ...object.ccIds]
                .find((uri) => uri.pathname.endsWith('/followers'))?.href;
        const objectDelivery = await resolveInboundDelivery(
            ctx,
            noteActorURL,
            [],
            [],
            object.toIds,
            object.ccIds,
            objectFollowersUri,
        );

        const recipientCcids = isRestrictedInboundVisibility(objectDelivery.visibility)
            ? intersectInboundRecipients(outerDelivery.recipientCcids, objectDelivery.recipientCcids)
            : outerDelivery.recipientCcids;
        const rerouteDelivery = makeInboundDelivery(
            recipientCcids,
            mostRestrictiveInboundVisibility(outerDelivery.visibility, objectDelivery.visibility),
        );
        if (rerouteDelivery.distributes.length === 0) {
            logger.info(`Announce ${announceUri} has no recipients authorized for ${noteURL}. Skipping.`);
            return;
        }

        const noteDelivery = makeInboundDelivery(recipientCcids, objectDelivery.visibility);
        const storedNoteDelivery = await storeInboundObject(
            noteURL,
            noteActorURL,
            await object.toJsonLd() as Record<string, unknown>,
            noteDelivery,
        );
        if (!storedNoteDelivery) return;

        // 内側のNote自体はタイムラインへ配送せず、rerouteの参照先として保存する。
        const noteKey = await storeApNote(
            noteURL,
            noteActorURL,
            object.published ? new Date(object.published.toString()) : new Date(),
            [],
            storedNoteDelivery,
        );

        const profileOverride = await buildProfileOverride(booster);
        const policy = restrictReadersPolicy(rerouteDelivery);

        const document: CommitDocument<any> = {
            kind: 'record',
            key: inboxKey(announceUri),
            schema: SCHEMA_REROUTE,
            value: {
                targetURI: noteKey,
                ...(profileOverride ? { profileOverride } : {}),
            },
            author: config.concrnt.ccid,
            createdAt: announce.published ? new Date(announce.published.toString()) : new Date(),
            distributes: rerouteDelivery.distributes,
            ...(policy ? { policy } : {}),
        };

        await commit(document);
    })
    .on(Reject, async (ctx, reject) => {
        // こちらから送ったFollowがリモートに拒否された場合。
        // ユーザー署名のfollowレコードはブリッジには削除できないため、
        // accept-stateにrejectedを永続化して配送・一覧から除外する。
        const follow = await reject.getObject({ crossOrigin: 'trust' });
        if (!(follow instanceof Follow)) return;

        const followerId = follow.actorId;
        if (followerId == null) return;
        const parsed = ctx.parseUri(followerId);
        if (parsed == null || parsed.type !== "actor") return;
        const followerIdentifier = parsed.identifier;

        const followTarget = follow.objectId;
        if (followTarget == null) return;

        const entity = await db.select().from(apEntity)
            .where(eq(apEntity.id, followerIdentifier)).limit(1).then(res => res[0]);
        if (!entity) {
            logger.warn(`Received Reject(Follow) for unknown entity: ${followerIdentifier}`);
            return;
        }

        const actorURI = followTarget.toString();
        const key = acceptStateKey(config.concrnt.ccid, entity.ccid, actorURI);
        await commit({
            kind: 'record',
            key,
            schema: SCHEMA_AP_ACCEPT_STATE,
            value: { ccid: entity.ccid, actorURI, status: 'rejected' },
            author: config.concrnt.ccid,
            createdAt: new Date(),
        });
        followStore.setAcceptState(key, entity.ccid, actorURI, 'rejected');
    })
    .on(Update, async (ctx, update) => {
        const object = await update.getObject();
        const objectId = object?.id?.href;
        const actorId = update.actorId?.href;
        if (object == null || objectId == null || actorId == null) return;

        const stored = await db.select().from(apInboundObject)
            .where(eq(apInboundObject.objectId, objectId)).limit(1).then(res => res[0]);
        if (!stored) {
            logger.debug(`Received Update for an object without a delivered snapshot: ${objectId}`);
            return;
        }
        if (stored.actorId !== actorId) {
            logger.warn(`Update actor mismatch for ${objectId}: ${actorId} vs ${stored.actorId}`);
            return;
        }

        await db.update(apInboundObject).set({
            object: await object.toJsonLd() as Record<string, unknown>,
            updatedAt: new Date(),
        }).where(eq(apInboundObject.objectId, objectId));
    })
    .on(EmojiReact, async (ctx, react) => {
        await handleLikeActivity(ctx, react);
    })
    .on(Like, async (ctx, like) => {
        await handleLikeActivity(ctx, like);
    })
    .on(Delete, async (ctx, del) => {
        logger.debug(`Received Delete activity from ${del.actorId}`);

        const object = await del.getObject();
        if (object == null || object.id == null) {
            logger.warn(`Received Delete activity with missing or invalid object`);
            return;
        }

        // 削除者と対象オブジェクトが同一オリジンであることを確認する
        // (他サーバーのコンテンツ削除を防ぐ)
        if (del.actorId == null || new URL(del.actorId.href).host !== object.id.host) {
            logger.warn(`Delete actor/object origin mismatch: ${del.actorId} vs ${object.id}`);
            return;
        }

        const document: CommitDocument<any> = {
            kind: 'delete',
            schema: SCHEMA_DELETE,
            value: inboxKey(object.id.href),
            author: config.concrnt.ccid,
            createdAt: new Date(),
        }

        try {
            await commit(document);
        } catch (error) {
            if (!isMissingCommitTargetError(error)) throw error;
            logger.info(`Delete target is already absent: ${object.id.href}`);
        }
        await db.delete(apInboundObject).where(eq(apInboundObject.objectId, object.id.href));
    })
;


// concrntプロフィール(p/main.json)を反映したPersonアクターを構築する。
// エンティティが存在しなければnull。
export const buildPerson = async (ctx: Context<unknown>, identifier: string): Promise<Person | null> => {
    const users = await db.select().from(apEntity).where(eq(apEntity.id, identifier)).limit(1);
    if (users.length === 0) return null;
    const entity = users[0];

    const keys = await ctx.getActorKeyPairs(identifier);

    const profile = await concrntApi.getDocument<any>(`cckv://${entity.ccid}/concrnt.world/profiles/main`)
        .then(doc => doc?.value ?? null)
        .catch(() => null);

    return new Person({
        id: ctx.getActorUri(identifier),
        preferredUsername: identifier,
        name: profile?.username ?? identifier,
        summary: profile?.description ? renderMarkdownToHtml(profile.description) : null,
        icon: profile?.avatar ? new Image({ url: new URL(profile.avatar) }) : null,
        image: profile?.banner ? new Image({ url: new URL(profile.banner) }) : null,
        inbox: ctx.getInboxUri(identifier),
        outbox: ctx.getOutboxUri(identifier),
        endpoints: new Endpoints({
            sharedInbox: ctx.getInboxUri(),
        }),
        url: ctx.getActorUri(identifier),
        publicKey: keys[0]?.cryptographicKey,
        assertionMethods: keys.map((k) => k.multikey),
        followers: ctx.getFollowersUri(identifier),
    });
};

// id・inbox・publicKey等の必須プロパティはbuildPerson内で設定している(静的解析の誤検知)
// eslint-disable-next-line @fedify/lint/actor-id-required
federation.setActorDispatcher(`${actorPath}/{identifier}`, async (ctx, identifier) => {
    return await buildPerson(ctx, identifier);
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

// Mastodon等のUI表示用の最小実装。投稿の列挙は今のところ提供しない。
federation.setOutboxDispatcher(
    `${actorPath}/{identifier}/outbox`,
    async (ctx, identifier) => {
        const users = await db.select().from(apEntity).where(eq(apEntity.id, identifier)).limit(1);
        if (users.length === 0) return null;
        return { items: [] };
    },
);

federation.setFollowersDispatcher(
    `${actorPath}/{identifier}/followers`,
    async (ctx, identifier) => {
        const entity = await db.select().from(apEntity)
            .where(eq(apEntity.id, identifier)).limit(1).then(res => res[0]);
        if (!entity) return null;

        const items: Recipient[] = followStore.getFollowers(entity.ccid).map(f => ({
            id: new URL(f.actorURI),
            inboxId: new URL(f.inbox),
            endpoints:
                f.sharedInbox
                ? { sharedInbox: new URL(f.sharedInbox) }
                : undefined,
        }));

        return { items }
    },
).setCounter(async (ctx, identifier) => {
    const entity = await db.select().from(apEntity)
        .where(eq(apEntity.id, identifier)).limit(1).then(res => res[0]);
    if (!entity) return 0;
    return followStore.getFollowers(entity.ccid).length;
});


federation.setObjectDispatcher(
    Note,
    `${actorPath}/{identifier}/posts/{+id}`,
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

        return await buildNote(ctx, values, document);
    },
);

export default federation;
