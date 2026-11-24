// ユーザーごとのブリッジ設定(listenTimelines, aliases)のメモリストア。
// source of truth は concrnt 上の cckv レコード:
//   - settings: cckv://<userCcid>/activitypub.concrnt.world/settings (ユーザー署名)
// キーが各ユーザーの空間に散っているため prefix 一括クエリはできず、
// entityごとに getDocument でロードし、以後は Redis イベント(daemon.ts)で更新する。
// レコード無し = 空設定(listenTimelines空はdaemon側でhome-timelineへフォールバック)。

import { getLogger } from "@logtape/logtape";
import { NotFoundError } from "@concrnt/client";

import concrntApi from "./concrnt.ts";
import { SCHEMA_AP_SETTINGS, settingsKey, type ApSettingsValue } from "./schemas.ts";

const logger = getLogger("activitypub");

interface Settings { listenTimelines: string[], aliases: string[] }

const EMPTY: Settings = { listenTimelines: [], aliases: [] };

const settingsByCcid = new Map<string, Settings>();
const loadedCcids = new Set<string>();

const sanitize = (document: { author: string, schema: string, value?: ApSettingsValue }, ccid: string): Settings => {
    // 本人署名かつ正しいスキーマのレコードのみ採用する
    if (document.author !== ccid || document.schema !== SCHEMA_AP_SETTINGS) return EMPTY;
    const timelines = document.value?.listenTimelines;
    const aliases = document.value?.aliases;
    return {
        listenTimelines: Array.isArray(timelines)
            ? timelines.filter((t): t is string => typeof t === 'string' && t.length > 0)
            : [],
        // PersonのalsoKnownAsにURLとして出すので、URLにならない値はactor全体を壊さないよう落とす
        aliases: Array.isArray(aliases)
            ? aliases.filter((a): a is string => typeof a === 'string' && URL.canParse(a))
            : [],
    };
}

export const getListenTimelines = (ccid: string): string[] =>
    settingsByCcid.get(ccid)?.listenTimelines ?? [];

export const getAliases = (ccid: string): string[] =>
    settingsByCcid.get(ccid)?.aliases ?? [];

// entityのsettingsレコードを未ロードならロードする(新規entityの遅延ロード対応)
export const ensureEntitySettingsLoaded = async (ccid: string) => {
    if (loadedCcids.has(ccid)) return;
    loadedCcids.add(ccid);

    try {
        const document = await concrntApi.getDocument<ApSettingsValue>(settingsKey(ccid));
        const settings = sanitize(document, ccid);
        settingsByCcid.set(ccid, settings);
        logger.info(`settingsStore: loaded ${settings.listenTimelines.length} listen timelines, ${settings.aliases.length} aliases for ${ccid}`);
    } catch (error) {
        if (error instanceof NotFoundError) {
            settingsByCcid.set(ccid, EMPTY);
            return;
        }
        // 失敗時は次の機会(updateEntitiesの60秒周期)に再試行できるようにする
        loadedCcids.delete(ccid);
        throw error;
    }
}

// settingsレコードのRedisイベントを反映する(即時反映)
export const applyEvent = async (ccid: string, msg: { type: string, documents?: Record<string, { document: string }> }) => {
    if (msg.type === "created") {
        const key = settingsKey(ccid);
        // イベントに同梱された署名済みドキュメントを優先し、なければフェッチする
        const eventSD = msg.documents?.[key];
        const document = eventSD
            ? JSON.parse(eventSD.document)
            : await concrntApi.getDocument<ApSettingsValue>(key).catch(() => null);
        if (document == null) return;
        const settings = sanitize(document, ccid);
        settingsByCcid.set(ccid, settings);
        loadedCcids.add(ccid);
        logger.info(`settingsStore: updated settings for ${ccid}: ${JSON.stringify(settings)}`);
    } else if (msg.type === "deleted") {
        settingsByCcid.set(ccid, EMPTY);
        loadedCcids.add(ccid);
        logger.info(`settingsStore: cleared settings for ${ccid}`);
    }
}
