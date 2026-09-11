// ユーザーごとのinboxタイムライン(cckv://<userCcid>/activitypub.concrnt.world/inbox)の
// 有無のメモリストア。inboxはユーザー本人がアプリ側で作成するため、フォロー関係だけ
// 移行済みで未作成のユーザーが存在しうる。そこへ配送するとpolicy denyで
// dead-letterに落ちるだけなので、配送前にここで存在を確認して宛先から外す。
// settingsStoreと同じく entityごとに getDocument でロードし、以後は
// Redisイベント(daemon.ts)で更新する。

import { getLogger } from "@logtape/logtape";
import { NotFoundError } from "@concrnt/client";

import concrntApi from "./concrnt.ts";
import { inboxTimelineKey } from "./schemas.ts";

const logger = getLogger("activitypub");

const inboxExistsByCcid = new Map<string, boolean>();
const loadedCcids = new Set<string>();

export const hasInbox = (ccid: string): boolean =>
    inboxExistsByCcid.get(ccid) ?? false;

// entityのinboxレコードの有無を未ロードならロードする(新規entityの遅延ロード対応)
export const ensureEntityInboxLoaded = async (ccid: string) => {
    if (loadedCcids.has(ccid)) return;
    loadedCcids.add(ccid);

    try {
        await concrntApi.getDocument<unknown>(inboxTimelineKey(ccid));
        inboxExistsByCcid.set(ccid, true);
    } catch (error) {
        if (error instanceof NotFoundError) {
            inboxExistsByCcid.set(ccid, false);
            logger.info(`inboxStore: ${ccid} has no inbox timeline yet; inbound notes will be skipped until it is created`);
            return;
        }
        // 失敗時は次の機会(updateEntitiesの60秒周期)に再試行できるようにする
        loadedCcids.delete(ccid);
        throw error;
    }
}

// 宛先候補のうちinboxを持つccidだけを返す(未ロードのものはその場でロードする)
export const filterCcidsWithInbox = async (ccids: string[]): Promise<string[]> => {
    const result: string[] = [];
    for (const ccid of ccids) {
        await ensureEntityInboxLoaded(ccid).catch((error) => {
            logger.error(`inboxStore: failed to load inbox state for ${ccid}: ${error}`);
        });
        if (hasInbox(ccid)) {
            result.push(ccid);
        } else {
            logger.debug(`inboxStore: skipping delivery to ${ccid}: no inbox timeline`);
        }
    }
    return result;
}

// inboxレコードのRedisイベントを反映する(即時反映)
export const applyEvent = (ccid: string, msg: { type: string }) => {
    if (msg.type === "created") {
        inboxExistsByCcid.set(ccid, true);
        loadedCcids.add(ccid);
        logger.info(`inboxStore: inbox timeline created for ${ccid}`);
    } else if (msg.type === "deleted") {
        inboxExistsByCcid.set(ccid, false);
        loadedCcids.add(ccid);
        logger.info(`inboxStore: inbox timeline deleted for ${ccid}`);
    }
}
