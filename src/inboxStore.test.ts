import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from '@concrnt/client';

const getDocument = vi.fn();
vi.mock('./concrnt.ts', () => ({ default: { getDocument: (...args: unknown[]) => getDocument(...args) } }));

const inboxStore = await import('./inboxStore.ts');
const { inboxTimelineKey } = await import('./schemas.ts');

describe('inboxStore', () => {
    beforeEach(() => {
        getDocument.mockReset();
    });

    it('inboxが存在するccidは配送先に残る', async () => {
        getDocument.mockResolvedValue({ kind: 'record' });
        expect(await inboxStore.filterCcidsWithInbox(['con1has'])).toEqual(['con1has']);
        expect(getDocument).toHaveBeenCalledWith(inboxTimelineKey('con1has'));
    });

    it('inboxが無い(404)ccidは配送先から外れ、結果はキャッシュされる', async () => {
        getDocument.mockRejectedValue(new NotFoundError('not found'));
        expect(await inboxStore.filterCcidsWithInbox(['con1none'])).toEqual([]);
        expect(await inboxStore.filterCcidsWithInbox(['con1none'])).toEqual([]);
        expect(getDocument).toHaveBeenCalledTimes(1);
    });

    it('404以外の失敗はキャッシュせず、次回に再試行する', async () => {
        getDocument.mockRejectedValueOnce(new Error('network'));
        expect(await inboxStore.filterCcidsWithInbox(['con1flaky'])).toEqual([]);
        getDocument.mockResolvedValueOnce({ kind: 'record' });
        expect(await inboxStore.filterCcidsWithInbox(['con1flaky'])).toEqual(['con1flaky']);
        expect(getDocument).toHaveBeenCalledTimes(2);
    });

    it('createdイベントで未作成→作成済みに切り替わり、deletedで戻る', async () => {
        getDocument.mockRejectedValue(new NotFoundError('not found'));
        expect(await inboxStore.filterCcidsWithInbox(['con1later'])).toEqual([]);

        inboxStore.applyEvent('con1later', { type: 'created' });
        expect(await inboxStore.filterCcidsWithInbox(['con1later'])).toEqual(['con1later']);

        inboxStore.applyEvent('con1later', { type: 'deleted' });
        expect(await inboxStore.filterCcidsWithInbox(['con1later'])).toEqual([]);
        // イベント反映後はフェッチし直さない
        expect(getDocument).toHaveBeenCalledTimes(1);
    });

    it('イベントが先に届いたccidはロード時にフェッチしない', async () => {
        inboxStore.applyEvent('con1early', { type: 'created' });
        await inboxStore.ensureEntityInboxLoaded('con1early');
        expect(inboxStore.hasInbox('con1early')).toBe(true);
        expect(getDocument).not.toHaveBeenCalled();
    });
});
