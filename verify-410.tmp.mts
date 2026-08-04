// 410 Gone follower purge + circuit breaker の動作検証スクリプト
// 実行: cd ~/workspace/activitypub && CONFIG_PATH=<scratchpad>/apbridge-config.yaml npx tsx <this file>
import './src/logging.ts';
import http from 'node:http';
import federation, { buildPerson } from './src/federation.ts';
import * as followStore from './src/followStore.ts';
import concrntApi, { commit } from './src/concrnt.ts';
import { followerKey, SCHEMA_AP_FOLLOWER } from './src/schemas.ts';
import { SCHEMA_DELETE } from './src/convert.ts';
import { config } from './src/config.ts';
import { Update, PUBLIC_COLLECTION } from '@fedify/vocab';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// --- mock: 410 Gone を返すinbox (8666) / 8667は誰もlistenしない(接続拒否) ---
const goneServer = http.createServer((req, res) => {
    console.log(`[mock:8666] ${req.method} ${req.url} -> 410`);
    res.writeHead(410, { 'content-type': 'text/plain' });
    res.end('Gone');
});
await new Promise<void>(r => goneServer.listen(8666, '127.0.0.1', r));

const svc = config.concrnt.ccid;
const entityCcid = svc; // testuser の ccid はサービスACと同一 (devnet構成)

const registerFollower = async (actorURI: string, inbox: string) => {
    const key = followerKey(svc, entityCcid, actorURI);
    await commit({
        kind: 'record',
        key,
        schema: SCHEMA_AP_FOLLOWER,
        value: { ccid: entityCcid, actorURI, inbox },
        author: svc,
        createdAt: new Date(),
    });
    followStore.setFollower({ ccid: entityCcid, key, actorURI, inbox });
    return key;
};

const cleanupFollower = async (key: string) => {
    await commit({
        kind: 'delete', schema: SCHEMA_DELETE, value: key,
        author: svc, createdAt: new Date(),
    }).catch(() => {});
    followStore.removeFollowerByKey(key);
};

const ctx = federation.createContext(new URL(config.activitypub.baseUrl), undefined);
await federation.startQueue(undefined);

const sendUpdate = async (n: number) => {
    const person = await buildPerson(ctx, 'testuser');
    await ctx.sendActivity(
        { identifier: 'testuser' },
        'followers',
        new Update({
            id: new URL(`${config.activitypub.baseUrl}/ap/updates/verify410-${n}-${Date.now()}`),
            actor: ctx.getActorUri('testuser'),
            object: person!,
            tos: [PUBLIC_COLLECTION],
        }),
    );
};

// ========== Test 1: 410 inbox -> follower purge ==========
console.log('===== Test 1: 410 Gone -> follower purge =====');
const aliceURI = 'http://127.0.0.1:8666/users/alice';
const aliceKey = await registerFollower(aliceURI, 'http://127.0.0.1:8666/inbox');
console.log(`registered follower: ${aliceURI} (${aliceKey})`);
console.log('followers now:', followStore.getFollowers(entityCcid).map(f => f.actorURI));

await sendUpdate(1);

let purged = false;
for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (followStore.getFollowersByActorURI(aliceURI).length === 0) { purged = true; break; }
}
const record = await concrntApi.getDocument(aliceKey).catch(() => null);
console.log(`RESULT test1: purged from store=${purged}, cckv record after=${record == null ? 'deleted' : 'STILL EXISTS'}`);
if (!purged) await cleanupFollower(aliceKey);

// ========== Test 2: connection refused -> circuit breaker opens ==========
console.log('===== Test 2: offline host -> circuit breaker =====');
const bobURI = 'http://127.0.0.1:8667/users/bob';
const bobKey = await registerFollower(bobURI, 'http://127.0.0.1:8667/inbox');
console.log(`registered follower: ${bobURI}`);

for (let n = 2; n <= 8; n++) {
    await sendUpdate(n);
    await sleep(500);
}
// 各配送の初回試行+リトライで連続失敗が蓄積し、5失敗でopenになるはず
console.log('waiting 45s for circuit breaker to accumulate failures...');
await sleep(45000);

// Redis上のcircuit breaker状態を確認
const { Redis } = await import('ioredis');
const redis = new Redis(config.redis.url);
const keys = await redis.keys('*circuit*');
console.log('circuit breaker KV keys:', keys);
for (const k of keys) {
    const v = await redis.get(k);
    console.log(`  ${k} = ${v}`);
}
redis.disconnect();

await cleanupFollower(bobKey);
console.log('cleaned up bob follower record');

goneServer.close();
console.log('===== verification script done =====');
process.exit(0);
