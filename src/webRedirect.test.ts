import { describe, expect, it } from 'vitest';
import { buildWebUrl, parseApPath, resolveWebRedirect } from './webRedirect.ts';

const uri = 'cckv://con1alice/concrnt.world/profiles/main/posts/abc';

describe('parseApPath', () => {
    it('actor', () => {
        expect(parseApPath('/ap/acct/alice')).toEqual({ kind: 'profile', identifier: 'alice' });
        expect(parseApPath('/ap/acct/instance.actor')).toEqual({ kind: 'profile', identifier: 'instance.actor' });
    });

    it('note with raw cckv path ({+id} route)', () => {
        expect(parseApPath(`/ap/acct/alice/posts/${uri}`)).toEqual({ kind: 'post', identifier: 'alice', uri });
    });

    it('note with percent-encoded id', () => {
        expect(parseApPath(`/ap/acct/alice/posts/${encodeURIComponent(uri)}`)).toEqual({ kind: 'post', identifier: 'alice', uri });
        expect(parseApPath('/ap/acct/a%20b')).toEqual({ kind: 'profile', identifier: 'a b' });
    });

    it('other routes are not targets', () => {
        for (const p of [
            '/ap/acct/alice/outbox',
            '/ap/acct/alice/followers',
            '/ap/acct/alice/inbox',
            '/ap/inbox',
            '/ap/acct/alice/posts/',
            '/ap/acct/',
            '/ap/acct',
            '/ap/api/info',
            '/ap/nodeinfo/2.1',
            '/.well-known/webfinger',
            '/',
        ]) {
            expect(parseApPath(p), p).toBeNull();
        }
    });

    it('malformed percent-encoding is not a target', () => {
        expect(parseApPath('/ap/acct/%E0%A4%A')).toBeNull();
        expect(parseApPath('/ap/acct/alice/posts/%')).toBeNull();
    });
});

describe('buildWebUrl', () => {
    it('profile and post', () => {
        expect(buildWebUrl('https://concrnt.world', { kind: 'profile', identifier: 'alice' }, 'con1alice'))
            .toBe('https://concrnt.world/profile/con1alice');
        expect(buildWebUrl('https://concrnt.world', { kind: 'post', identifier: 'alice', uri }, 'con1alice'))
            .toBe(`https://concrnt.world/post/${encodeURIComponent(uri)}`);
    });

    it('strips trailing slash and keeps a base path', () => {
        expect(buildWebUrl('https://example.com/', { kind: 'profile', identifier: 'alice' }, 'con1alice'))
            .toBe('https://example.com/profile/con1alice');
        expect(buildWebUrl('https://example.com/app/', { kind: 'profile', identifier: 'alice' }, 'con1alice'))
            .toBe('https://example.com/app/profile/con1alice');
    });
});

describe('resolveWebRedirect', () => {
    const lookupCcid = async (identifier: string) => {
        if (identifier === 'instance.actor') return undefined;
        if (identifier === 'alice') return 'con1alice';
        return null;
    };
    const options = { webUrl: 'https://concrnt.world', lookupCcid };

    it('redirects actor to profile page', async () => {
        await expect(resolveWebRedirect('/ap/acct/alice', options))
            .resolves.toEqual({ kind: 'redirect', location: 'https://concrnt.world/profile/con1alice' });
    });

    it('redirects note to post page', async () => {
        await expect(resolveWebRedirect(`/ap/acct/alice/posts/${uri}`, options))
            .resolves.toEqual({ kind: 'redirect', location: `https://concrnt.world/post/${encodeURIComponent(uri)}` });
    });

    it('unknown entity is not-found', async () => {
        await expect(resolveWebRedirect('/ap/acct/bob', options)).resolves.toEqual({ kind: 'not-found' });
        await expect(resolveWebRedirect(`/ap/acct/bob/posts/${uri}`, options)).resolves.toEqual({ kind: 'not-found' });
    });

    it('owner mismatch is not-found', async () => {
        await expect(resolveWebRedirect('/ap/acct/alice/posts/cckv://con1mallory/concrnt.world/profiles/main/posts/x', options))
            .resolves.toEqual({ kind: 'not-found' });
        await expect(resolveWebRedirect('/ap/acct/alice/posts/not-a-uri', options))
            .resolves.toEqual({ kind: 'not-found' });
    });

    it('instance actor and non-target paths pass through', async () => {
        await expect(resolveWebRedirect('/ap/acct/instance.actor', options)).resolves.toBeNull();
        await expect(resolveWebRedirect('/ap/acct/alice/outbox', options)).resolves.toBeNull();
    });
});
