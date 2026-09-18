import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError, PermissionError, ServerOfflineError } from '@concrnt/client';
import { PUBLIC_COLLECTION } from '@fedify/vocab';
import type { Context } from '@fedify/fedify';

const getDocument = vi.fn();
const resolveAsProxy = vi.fn();
vi.mock('./concrnt.ts', () => ({
    default: { getDocument: (...args: unknown[]) => getDocument(...args) },
    resolveAsProxy: (...args: unknown[]) => resolveAsProxy(...args),
}));
vi.mock('./config.ts', () => ({
    config: { activitypub: { baseUrl: 'https://bridge.test' }, concrnt: { ccid: 'con1svc', domain: 'bridge.test' } },
}));
vi.mock('./db/index.ts', () => ({ db: {}, apEntity: {} }));

const { resolveVisibility, audience, buildNote } = await import('./convert.ts');

const uri = 'cckv://con1alice/concrnt.world/profiles/main/posts/abc';

describe('resolveVisibility', () => {
    beforeEach(() => {
        getDocument.mockReset();
        resolveAsProxy.mockReset();
    });

    it('同梱isPublic=trueはネットワークなしでpublic', async () => {
        expect(await resolveVisibility(uri, true)).toBe('public');
        expect(getDocument).not.toHaveBeenCalled();
        expect(resolveAsProxy).not.toHaveBeenCalled();
    });

    it('同梱isPublic=falseは匿名fetchを再確認せず、apProxyで読めればフォロワー限定', async () => {
        resolveAsProxy.mockResolvedValue({ kind: 'record' });
        expect(await resolveVisibility(uri, false)).toBe('followers');
        expect(getDocument).not.toHaveBeenCalled();
        expect(resolveAsProxy).toHaveBeenCalledWith(uri);
    });

    it('同梱isPublic=falseでapProxyも読めなければ連合しない(404/403とも)', async () => {
        resolveAsProxy.mockRejectedValueOnce(new NotFoundError('not found', uri));
        expect(await resolveVisibility(uri, false)).toBeNull();
        resolveAsProxy.mockRejectedValueOnce(new PermissionError('denied'));
        expect(await resolveVisibility(uri, false)).toBeNull();
    });

    it('同梱isPublic未評価はキャッシュを見ない匿名fetchで判定する', async () => {
        getDocument.mockResolvedValue({ kind: 'record' });
        expect(await resolveVisibility(uri, undefined)).toBe('public');
        expect(getDocument).toHaveBeenCalledWith(uri, undefined, { cache: 'no-cache' });
        expect(resolveAsProxy).not.toHaveBeenCalled();
    });

    it('匿名で読めずapProxyで読めればフォロワー限定', async () => {
        getDocument.mockRejectedValue(new NotFoundError('not found', uri));
        resolveAsProxy.mockResolvedValue({ kind: 'record' });
        expect(await resolveVisibility(uri, undefined)).toBe('followers');
    });

    it('トランスポート障害は無音スキップにせず投げる', async () => {
        getDocument.mockRejectedValue(new Error('network'));
        await expect(resolveVisibility(uri, undefined)).rejects.toThrow('network');
        resolveAsProxy.mockRejectedValue(new ServerOfflineError('bridge.test'));
        await expect(resolveVisibility(uri, false)).rejects.toBeInstanceOf(ServerOfflineError);
    });
});

describe('audience', () => {
    const followers = new URL('https://bridge.test/ap/acct/alice/followers');
    const mentioned = new URL('https://remote.test/users/bob');

    it('公開はto=Public, cc=followers+宛先', () => {
        expect(audience('public', followers, [mentioned])).toEqual({
            tos: [PUBLIC_COLLECTION],
            ccs: [followers, mentioned],
        });
    });

    it('フォロワー限定はto=followers, cc=宛先のみでPublicを含まない', () => {
        const { tos, ccs } = audience('followers', followers, [mentioned]);
        expect(tos).toEqual([followers]);
        expect(ccs).toEqual([mentioned]);
        expect([...tos, ...ccs].map(u => u.href)).not.toContain(PUBLIC_COLLECTION.href);
    });
});

describe('buildNote', () => {
    const ctx = {
        getObjectUri: (_cls: unknown, values: { identifier: string, id: string }) =>
            new URL(`https://bridge.test/ap/acct/${values.identifier}/posts/${encodeURIComponent(values.id)}`),
        getActorUri: (identifier: string) => new URL(`https://bridge.test/ap/acct/${identifier}`),
        getFollowersUri: (identifier: string) => new URL(`https://bridge.test/ap/acct/${identifier}/followers`),
        getDocumentLoader: async () => async () => { throw new Error('no network in test'); },
        lookupObject: async () => null,
    } as unknown as Context<unknown>;
    const values = { identifier: 'alice', id: uri };
    const document = {
        kind: 'record',
        schema: 'https://schema.concrnt.net/markdown.json',
        author: 'con1alice',
        createdAt: '2026-09-19T00:00:00.000Z',
        value: { body: 'hello' },
    };

    it('公開NoteはPublic宛て', async () => {
        const note = await buildNote(ctx, values, document, 'public');
        expect(note?.toIds.map(u => u.href)).toEqual([PUBLIC_COLLECTION.href]);
        expect(note?.ccIds.map(u => u.href)).toEqual(['https://bridge.test/ap/acct/alice/followers']);
    });

    it('フォロワー限定Noteはfollowers宛てでPublicを含まない', async () => {
        const note = await buildNote(ctx, values, document, 'followers');
        expect(note?.toIds.map(u => u.href)).toEqual(['https://bridge.test/ap/acct/alice/followers']);
        expect(note?.ccIds).toEqual([]);
    });
});
