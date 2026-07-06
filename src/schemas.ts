// concrntスキーマURLと、それに関する純粋なロジック。
// このモジュールは設定やDBに依存しない(ユニットテスト対象)。

export const SCHEMA_MARKDOWN = "https://schema.concrnt.world/m/markdown.json";
export const SCHEMA_GFM = "https://schema.concrnt.world/m/gfm.json";
export const SCHEMA_MFM = "https://schema.concrnt.world/m/mfm.json";
export const SCHEMA_PLAINTEXT = "https://schema.concrnt.world/m/plaintext.json";
export const SCHEMA_MEDIA = "https://schema.concrnt.world/m/media.json";
export const SCHEMA_REPLY = "https://schema.concrnt.world/m/reply.json";
export const SCHEMA_REROUTE = "https://schema.concrnt.world/m/reroute.json";
export const SCHEMA_AP_NOTE = "https://schema.concrnt.world/ap/note.json";
export const SCHEMA_REFERENCE = "https://schema.concrnt.net/reference.json";
export const SCHEMA_DELETE = "https://schema.concrnt.net/delete.json";
export const SCHEMA_LIKE = "https://schema.concrnt.world/a/like.json";
export const SCHEMA_REACTION = "https://schema.concrnt.world/a/reaction.json";

// テキストなしreroute = boost (Announce)。テキストあり = 引用投稿として連合する。
export const isPlainReroute = (document: { schema: string, value?: { body?: string } }): boolean =>
    document.schema === SCHEMA_REROUTE && !document.value?.body?.trim();

// ":shortcode:" 形式の絵文字リアクションcontentからショートコードを取り出す。
// 該当しなければnull(プレーンなLike扱い)。
export const parseEmojiShortcode = (content?: string | null): string | null => {
    const trimmed = content?.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^:([^:\s]+):$/);
    return match ? match[1] : null;
}
