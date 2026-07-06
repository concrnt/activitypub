// concrntメッセージ本文からAP Note構成要素を抽出する純粋ロジック。
// 設定・DB・ネットワークに依存しない(ユニットテスト対象)。
import { marked } from 'marked';

export interface MessageEmojis {
    [shortcode: string]: { imageURL?: string, animURL?: string }
}

export interface NoteParts {
    contentHtml: string
    summary: string | null
    sensitive: boolean
    hashtags: string[]
    mentions: string[]
    inlineImages: { url: string, alt: string }[]
    emojis: { shortcode: string, imageUrl: string }[]
}

const IMAGE_MD_REGEX = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
// 本文が <details><summary>CW</summary>...</details> で始まる場合のみCWとして扱う。
// 末尾に $ を付けないことで </details> 以降の続き本文も拾う。
const DETAILS_REGEX = /^\s*<details>\s*(?:<summary>([\s\S]*?)<\/summary>)?([\s\S]*?)<\/details>([\s\S]*)$/;
const HASHTAG_REGEX = /(?:^|\s)#([^\s#:;,.!?'"()[\]]+)/g;
const MENTION_REGEX = /(?:^|\s)@([a-zA-Z0-9_.-]+)@([a-zA-Z0-9_.-]+\.[a-zA-Z]{2,})/g;

export const renderMarkdownToHtml = (markdown: string): string =>
    marked.parse(markdown, { async: false });

export const escapeHtml = (text: string): string =>
    text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');

export const renderPlaintextToHtml = (text: string): string =>
    `<p>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</p>`;

export const buildNoteParts = (body: string, emojis?: MessageEmojis, opts?: { plaintext?: boolean }): NoteParts => {
    let text = body ?? '';

    // <details><summary>CW</summary>本文</details> 規約 → summary + sensitive
    let summary: string | null = null;
    let sensitive = false;
    const details = text.match(DETAILS_REGEX);
    if (details) {
        summary = details[1]?.trim() || 'CW';
        text = `${details[2].trim()}${details[3] ? `\n${details[3].trim()}` : ''}`.trim();
        sensitive = true;
    }

    // 本文中の画像markdownは添付として切り出す
    const inlineImages: { url: string, alt: string }[] = [];
    text = text.replace(IMAGE_MD_REGEX, (_match, alt: string, url: string) => {
        inlineImages.push({ url, alt });
        return '';
    }).trim();

    const hashtags = [...text.matchAll(HASHTAG_REGEX)].map(m => m[1]);
    const mentions = [...text.matchAll(MENTION_REGEX)].map(m => `@${m[1]}@${m[2]}`);

    const emojiList = Object.entries(emojis ?? {})
        .map(([shortcode, v]) => ({ shortcode, imageUrl: v.imageURL ?? v.animURL }))
        .filter((e): e is { shortcode: string, imageUrl: string } => !!e.imageUrl);

    return {
        contentHtml: opts?.plaintext ? renderPlaintextToHtml(text) : renderMarkdownToHtml(text),
        summary,
        sensitive,
        hashtags,
        mentions,
        inlineImages,
        emojis: emojiList,
    };
}
