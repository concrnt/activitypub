import { db, apEntity, apFollow, apObjectReference, type ApEntity } from './db/index.ts';
import { Redis } from "ioredis";
import { and, eq } from "drizzle-orm";
import fedi, { buildPerson } from "./federation.ts";
import { Announce, Create, Delete, Emoji, Image, isActor, Like, Note, PUBLIC_COLLECTION, Tombstone, Undo, Update } from '@fedify/vocab';

import { getLogger } from "@logtape/logtape";

import concrntApi from "./concrnt.ts";
import { config } from "./config.ts";
import { buildNote, isPlainReroute, resolveApObjectUrl, SCHEMA_AP_NOTE, SCHEMA_REFERENCE, SCHEMA_LIKE, SCHEMA_REACTION } from "./convert.ts";

interface CoreSignedDocument {
    document: string;
    references?: Record<string, CoreSignedDocument>;
}

// concrntコアがpubsubへ流すイベント
interface CoreEvent {
    type: string;
    uri: string;
    source?: string;
    association?: string;
    documents?: Record<string, CoreSignedDocument>;
}

const logger = getLogger("activitypub");

let entities: ApEntity[] = [];

// 送信済みLike/リアクションのccfs集合。psubscribe("*")で流れてくる大量の
// deleted イベントに対し、ブリッジ由来のものだけをDB照会するためのフィルタ。
const outboundLikeCcfs = new Set<string>();

const updateEntities = async () => {
    entities = await db.select().from(apEntity);
}

const loadOutboundLikes = async () => {
    const rows = await db.select().from(apObjectReference)
        .where(eq(apObjectReference.refType, 'outbound-like'));
    outboundLikeCcfs.clear();
    for (const row of rows) outboundLikeCcfs.add(row.ccUri);
}

const handleTimelineEvent = async (entity: ApEntity, channel: string, msg: CoreEvent) => {

    // タイムラインイベントで対象とするのは投稿の作成・削除のみ
    if (msg.type !== "created" && msg.type !== "deleted") {
        return;
    }

    const baseURL = new URL(config.activitypub.baseUrl);
    const ctx = fedi.createContext(baseURL, undefined);

    if (msg.type === "created") {

        // イベントに同梱された署名済みドキュメントを優先し、なければフェッチする
        const eventSD = msg.documents?.[channel];
        let document: any = eventSD
            ? JSON.parse(eventSD.document)
            : await concrntApi.getDocument<any>(channel);
        let cckv: string = document.key!;

        if (document.author != entity.ccid) {
            return;
        }

        // タイムラインには参照ドキュメントが配られるので、実体まで辿る
        if (document.schema === SCHEMA_REFERENCE) {
            cckv = document.value.href;
            const refSD = eventSD?.references?.[cckv];
            document = refSD
                ? JSON.parse(refSD.document)
                : await concrntApi.getDocument<any>(cckv).catch(() => null);
            if (document == null) {
                logger.error(`Failed to resolve referenced document: ${cckv}`);
                return;
            }
        }

        if (isPlainReroute(document)) {
            // テキストなしreroute → Announce (boost)
            const targetURI: string | undefined = document.value?.targetURI;
            if (!targetURI) return;

            const objectRef = await resolveApObjectUrl(ctx, targetURI);
            if (!objectRef) {
                logger.info(`Reroute target is not resolvable to an AP object, skipping: ${targetURI}`);
                return;
            }

            const announceId = new URL(`${config.activitypub.baseUrl}/ap/announces/${encodeURIComponent(cckv)}`);

            await ctx.sendActivity(
                { identifier: entity.id },
                "followers",
                new Announce({
                    id: announceId,
                    actor: ctx.getActorUri(entity.id),
                    object: new URL(objectRef),
                    tos: [PUBLIC_COLLECTION],
                    ccs: [ctx.getFollowersUri(entity.id)],
                }),
            );

            // unboost時にUndo(Announce)を送るための対応を記録
            await db.insert(apObjectReference).values({
                apObjectId: announceId.href,
                ccUri: cckv,
                refType: 'outbound-announce',
                meta: { object: objectRef },
            }).onConflictDoNothing();

            return;
        }

        // 通常投稿・引用reroute → Create(Note)。
        // 手元のdocumentから直接Noteを構築する(自己HTTP経由の再取得を避ける)。
        const noteArgs = { identifier: entity.id, id: cckv };
        const note = await buildNote(ctx, noteArgs, document);
        if (note == null) {
            logger.info(`Document does not resolve to a Note, skipping: ${cckv}`);
            return;
        }

        const createActivity = new Create({
            id: new URL("#activity", note.id ?? undefined),
            object: note,
            actors: note.attributionIds,
            tos: note.toIds,
            ccs: note.ccIds,
        });

        await ctx.sendActivity(
            { identifier: entity.id },
            "followers",
            createActivity,
        );

        // メンション・リプライ相手(ccに含まれるアクター)には直接配送する。
        // フォロワーの有無に関わらず届ける必要がある。
        const followersUri = ctx.getFollowersUri(entity.id).href;
        const extraRecipients = (await Promise.all(
            note.ccIds
                .filter(cc => cc.href !== PUBLIC_COLLECTION.href && cc.href !== followersUri)
                .map(cc => ctx.lookupObject(cc.href).catch(() => null))
        )).filter(isActor);
        if (extraRecipients.length > 0) {
            await ctx.sendActivity(
                { identifier: entity.id },
                extraRecipients,
                createActivity,
            );
        }

    } else if (msg.type === "deleted") {

        const cckv = msg.uri;

        // 削除対象がこのエンティティ自身のドキュメントであることを確認する
        // (共有タイムライン上の他者コンテンツ削除で誤配信しない)
        if (!cckv.startsWith(`cckv://${entity.ccid}/`)) {
            return;
        }

        // 送信済みAnnounceの削除ならUndo(Announce)を送る
        const ref = await db.select().from(apObjectReference)
            .where(eq(apObjectReference.ccUri, cckv)).limit(1).then(res => res[0]);

        if (ref?.refType === 'outbound-announce') {
            const announceId = new URL(ref.apObjectId);
            await ctx.sendActivity(
                { identifier: entity.id },
                "followers",
                new Undo({
                    id: new URL("#undo", announceId),
                    actor: ctx.getActorUri(entity.id),
                    object: new Announce({
                        id: announceId,
                        actor: ctx.getActorUri(entity.id),
                        object: ref.meta?.object ? new URL(ref.meta.object) : null,
                    }),
                    tos: [PUBLIC_COLLECTION],
                }),
            );
            await db.delete(apObjectReference).where(eq(apObjectReference.apObjectId, ref.apObjectId));
            return;
        }

        const noteArgs = { identifier: entity.id, id: cckv };
        const noteURL = ctx.getObjectUri(Note, noteArgs);

        await ctx.sendActivity(
            { identifier: entity.id },
            "followers",
            new Delete({
                id: new URL(`#delete-${Date.now()}`, noteURL),
                actor: ctx.getActorUri(entity.id),
                object: new Tombstone({ id: noteURL }),
                tos: [PUBLIC_COLLECTION],
            })
        );
    }
}

// concrntプロフィールが更新されたらUpdate(Person)をフォロワーへ配信する
const handleProfileUpdate = async (entity: ApEntity) => {

    const ctx = fedi.createContext(new URL(config.activitypub.baseUrl), undefined);

    const person = await buildPerson(ctx, entity.id);
    if (person == null) return;

    await ctx.sendActivity(
        { identifier: entity.id },
        "followers",
        new Update({
            id: new URL(`${config.activitypub.baseUrl}/ap/users/${entity.id}#update-${Date.now()}`),
            actor: ctx.getActorUri(entity.id),
            object: person,
            tos: [PUBLIC_COLLECTION],
            ccs: [ctx.getFollowersUri(entity.id)],
        }),
    );
}

const handleAssociationEvent = async (msg: CoreEvent) => {

    const ccfs = msg.association;
    if (ccfs == null) return;

    // イベントに同梱されたassociationドキュメントを優先し、なければフェッチする
    const assocSD = msg.documents?.[ccfs];
    const association: any = assocSD
        ? JSON.parse(assocSD.document)
        : await concrntApi.getDocument<any>(ccfs).catch(() => null);
    if (association == null) {
        logger.error(`Failed to resolve association document: ${ccfs}`);
        return;
    }

    if (association.schema !== SCHEMA_LIKE && association.schema !== SCHEMA_REACTION) {
        return; // Like・リアクション以外のassociationは連合しない
    }

    const likerccid = association.author;

    const likerEntity = await db.select().from(apEntity).where(eq(apEntity.ccid, likerccid)).limit(1).then(res => res[0]);
    if (!likerEntity) {
        logger.error(`No entity found for author CCID: ${likerccid}`);
        return;
    }

    // Like対象は ap/note.json (リモート投稿の参照) でなければ連合しない。
    // 受信Announceも同じinbox名前空間にreroute記録を保存するため、スキーマで判別する。
    const target = await concrntApi.getDocument<any>(msg.uri).catch(() => null);
    if (target == null || target.schema !== SCHEMA_AP_NOTE || !target.value?.actorURL || !target.value?.noteURL) {
        logger.info(`Association target is not a bridgeable AP note, skipping: ${msg.uri}`);
        return;
    }

    const actorURL = new URL(target.value.actorURL);
    const noteURL = new URL(target.value.noteURL);

    const ctx = fedi.createContext(new URL(config.activitypub.baseUrl), undefined);

    const actor = await ctx.lookupObject(actorURL.href);
    if (!actor || !isActor(actor)) {
        logger.error(`Failed to fetch actor for association: ${actorURL.href}`);
        return;
    }

    const likerUri = ctx.getActorUri(likerEntity.id);
    const likeId = new URL(`${config.activitypub.baseUrl}/ap/likes/${encodeURIComponent(ccfs)}`);

    let like: Like;
    if (association.schema === SCHEMA_REACTION) {
        const shortcode: string | undefined = association.value?.shortcode;
        const imageUrl: string | undefined = association.value?.imageUrl;
        like = new Like({
            id: likeId,
            actor: likerUri,
            object: noteURL,
            content: shortcode ? `:${shortcode}:` : null,
            tags: (shortcode && imageUrl) ? [
                new Emoji({
                    id: new URL(imageUrl),
                    name: `:${shortcode}:`,
                    icon: new Image({ url: new URL(imageUrl) }),
                }),
            ] : [],
        });
    } else {
        like = new Like({
            id: likeId,
            actor: likerUri,
            object: noteURL,
            content: "⭐",
        });
    }

    await ctx.sendActivity(
        { identifier: likerEntity.id },
        actor,
        like,
    );

    // 削除時にUndo(Like)を送るための対応を記録
    await db.insert(apObjectReference).values({
        apObjectId: likeId.href,
        ccUri: ccfs,
        refType: 'outbound-like',
        meta: {
            likerId: likerEntity.id,
            actor: actorURL.href,
            object: noteURL.href,
        },
    }).onConflictDoNothing();
    outboundLikeCcfs.add(ccfs);
}

// ローカルユーザーがLike/リアクションを削除したらUndo(Like)を送る
const handleAssociationDeleted = async (msg: CoreEvent) => {

    // 全nodeのassociation削除が流れてくるため、ブリッジ由来のものだけDB照会する
    if (!outboundLikeCcfs.has(msg.uri)) return;

    const ref = await db.select().from(apObjectReference)
        .where(and(
            eq(apObjectReference.ccUri, msg.uri),
            eq(apObjectReference.refType, 'outbound-like'),
        )).limit(1).then(res => res[0]);
    if (!ref) {
        outboundLikeCcfs.delete(msg.uri);
        return;
    }

    const meta = ref.meta ?? {};
    const likerId = meta.likerId;
    const actorURL = meta.actor;
    const noteURL = meta.object;

    if (!likerId || !actorURL || !noteURL) {
        logger.error(`Incomplete metadata for outbound like reference: ${ref.apObjectId}`);
        await db.delete(apObjectReference).where(eq(apObjectReference.apObjectId, ref.apObjectId));
        outboundLikeCcfs.delete(msg.uri);
        return;
    }

    const ctx = fedi.createContext(new URL(config.activitypub.baseUrl), undefined);

    const actor = await ctx.lookupObject(actorURL);
    if (!actor || !isActor(actor)) {
        logger.error(`Failed to fetch actor for undo like: ${actorURL}`);
        return;
    }

    const likeId = new URL(ref.apObjectId);

    await ctx.sendActivity(
        { identifier: likerId },
        actor,
        new Undo({
            id: new URL("#undo", likeId),
            actor: ctx.getActorUri(likerId),
            object: new Like({
                id: likeId,
                actor: ctx.getActorUri(likerId),
                object: new URL(noteURL),
            }),
        }),
    );

    await db.delete(apObjectReference).where(eq(apObjectReference.apObjectId, ref.apObjectId));
    outboundLikeCcfs.delete(msg.uri);
}

export const startEntityBroker = async () => {

    const redis = new Redis(config.redis.url);

    await updateEntities(); // Initial load of entities
    await loadOutboundLikes(); // 送信済みLikeのフィルタを初期化
    setInterval(updateEntities, 60000); // Update entities every 60 seconds

    redis.psubscribe("*", (err, count) => {
        if (err) {
            logger.error(`Failed to subscribe to Redis channels: ${err}`);
            return;
        }
    });

    redis.on("pmessage", async (pattern, channel, message) => {

        if (!channel.startsWith('ccfs://') && !channel.startsWith('cckv://')) {
            return; // Ignore irrelevant channels
        }

        try {
            const msg: CoreEvent = JSON.parse(message);

            for (const entity of entities) {
                if (!entity.enabled) continue;

                // 監視対象タイムライン(未設定ならhome-timeline)
                const timelines = entity.listenTimelines.length > 0
                    ? entity.listenTimelines
                    : [`cckv://${entity.ccid}/concrnt.world/profiles/main/home-timeline`];

                for (const prefix of timelines) {
                    if (channel.startsWith(prefix)) {
                        await handleTimelineEvent(entity, channel, msg);
                        break;
                    }
                }

                // プロフィール更新(kv上書きでもcreatedが発火する)
                const profileKey = `cckv://${entity.ccid}/concrnt.world/profiles/main`;
                if (channel === profileKey && msg.type === "created") {
                    await handleProfileUpdate(entity);
                }
            }

            const assocPrefix = `cckv://${config.concrnt.ccid}/activitypub.concrnt.world/inbox/`
            if (msg.type === "associated" && channel.startsWith(assocPrefix)) {
                await handleAssociationEvent(msg);
            }

            // association削除イベントはccfs URI自身のチャンネルに流れる
            if (msg.type === "deleted" && msg.uri?.startsWith("ccfs://")) {
                await handleAssociationDeleted(msg);
            }
        } catch (error) {
            logger.error(`Error processing Redis message: ${error}`);
        }

    });
}
