import { describe, it, expect } from 'vitest';
import { isPlainReroute, parseEmojiShortcode, SCHEMA_REROUTE, SCHEMA_AP_NOTE } from './schemas.ts';

describe('isPlainReroute', () => {
    it('bodyのないrerouteはboost扱い', () => {
        expect(isPlainReroute({ schema: SCHEMA_REROUTE, value: { } })).toBe(true);
    });

    it('valueすらないrerouteもboost扱い', () => {
        expect(isPlainReroute({ schema: SCHEMA_REROUTE })).toBe(true);
    });

    it('空白のみのbodyはboost扱い', () => {
        expect(isPlainReroute({ schema: SCHEMA_REROUTE, value: { body: '   ' } })).toBe(true);
    });

    it('bodyのあるrerouteは引用投稿', () => {
        expect(isPlainReroute({ schema: SCHEMA_REROUTE, value: { body: 'これはコメント' } })).toBe(false);
    });

    it('reroute以外のスキーマは対象外', () => {
        expect(isPlainReroute({ schema: SCHEMA_AP_NOTE, value: {} })).toBe(false);
    });
});

describe('parseEmojiShortcode', () => {
    it(':shortcode:形式からショートコードを取り出す', () => {
        expect(parseEmojiShortcode(':blobcat:')).toBe('blobcat');
    });

    it('前後の空白を無視する', () => {
        expect(parseEmojiShortcode('  :party_parrot:  ')).toBe('party_parrot');
    });

    it('通常のcontentはnull', () => {
        expect(parseEmojiShortcode('⭐')).toBeNull();
        expect(parseEmojiShortcode('hello :world:')).toBeNull();
    });

    it('空・未定義はnull', () => {
        expect(parseEmojiShortcode('')).toBeNull();
        expect(parseEmojiShortcode(null)).toBeNull();
        expect(parseEmojiShortcode(undefined)).toBeNull();
    });

    it('コロンのみはnull', () => {
        expect(parseEmojiShortcode('::')).toBeNull();
    });
});
