import { describe, it, expect } from 'vitest';
import { buildNoteParts, escapeHtml, renderPlaintextToHtml } from './render.ts';

describe('buildNoteParts', () => {
    it('markdownをHTMLに変換する', () => {
        const parts = buildNoteParts('**太字** です');
        expect(parts.contentHtml).toContain('<strong>太字</strong>');
        expect(parts.sensitive).toBe(false);
        expect(parts.summary).toBeNull();
    });

    it('detailsタグをCW(summary + sensitive)に変換する', () => {
        const parts = buildNoteParts('<details><summary>ネタバレ</summary>本文です</details>');
        expect(parts.summary).toBe('ネタバレ');
        expect(parts.sensitive).toBe(true);
        expect(parts.contentHtml).toContain('本文です');
        expect(parts.contentHtml).not.toContain('<details>');
    });

    it('summaryのないdetailsはデフォルトのCWラベル', () => {
        const parts = buildNoteParts('<details>本文</details>');
        expect(parts.summary).toBe('CW');
        expect(parts.sensitive).toBe(true);
    });

    it('details閉じタグ以降の続き本文も本文に含める', () => {
        const parts = buildNoteParts('<details><summary>CW</summary>隠す本文</details>続きの文');
        expect(parts.summary).toBe('CW');
        expect(parts.sensitive).toBe(true);
        expect(parts.contentHtml).toContain('隠す本文');
        expect(parts.contentHtml).toContain('続きの文');
    });

    it('先頭にテキストがある場合はdetailsをCW扱いしない', () => {
        const parts = buildNoteParts('前置き\n<details><summary>x</summary>y</details>');
        expect(parts.summary).toBeNull();
        expect(parts.sensitive).toBe(false);
    });

    it('画像markdownを添付として切り出す', () => {
        const parts = buildNoteParts('こんにちは ![キャプション](https://example.com/a.png)');
        expect(parts.inlineImages).toEqual([{ url: 'https://example.com/a.png', alt: 'キャプション' }]);
        expect(parts.contentHtml).not.toContain('a.png');
    });

    it('ハッシュタグを抽出する', () => {
        const parts = buildNoteParts('今日は #concrnt と #分散SNS の話');
        expect(parts.hashtags).toEqual(['concrnt', '分散SNS']);
    });

    it('メンションを抽出する', () => {
        const parts = buildNoteParts('hi @alice@mastodon.example how are you');
        expect(parts.mentions).toEqual(['@alice@mastodon.example']);
    });

    it('メールアドレス風でないただの@はメンションにしない', () => {
        const parts = buildNoteParts('user@localhost はメンションではない');
        expect(parts.mentions).toEqual([]);
    });

    it('絵文字マップをリスト化する', () => {
        const parts = buildNoteParts('smile :smile:', {
            smile: { imageURL: 'https://example.com/smile.png' },
            empty: {},
        });
        expect(parts.emojis).toEqual([{ shortcode: 'smile', imageUrl: 'https://example.com/smile.png' }]);
    });

    it('plaintextはHTMLエスケープ+brで変換する', () => {
        const parts = buildNoteParts('<b>bold</b>\n2行目', undefined, { plaintext: true });
        expect(parts.contentHtml).toBe('<p>&lt;b&gt;bold&lt;/b&gt;<br>2行目</p>');
    });
});

describe('escapeHtml', () => {
    it('特殊文字をエスケープする', () => {
        expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    });
});

describe('renderPlaintextToHtml', () => {
    it('改行をbrに変換する', () => {
        expect(renderPlaintextToHtml('a\r\nb')).toBe('<p>a<br>b</p>');
    });
});
