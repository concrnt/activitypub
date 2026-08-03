import { Api, InMemoryAuthProvider, InMemoryKVS, type Document, type SignedDocument } from '@concrnt/client'
import { config } from "./config.ts";

// 現行コアは document.kind でディスパッチするが、npm公開版 @concrnt/client 2.0.1 の
// Document 型には kind がまだ無い。クライアント更新までの間、ここで型を補う。
export type DocumentKind = 'entity' | 'record' | 'association' | 'delete' | 'ack' | 'unack'
export type CommitDocument<T> = Document<T> & {
    kind: DocumentKind
    policy?: {
        entries: Array<{
            url: string
            params?: Record<string, unknown>
            defaults?: Record<string, string>
        }>
    }
}

const authProvider = new InMemoryAuthProvider(config.concrnt.privateKey);
const kvs = new InMemoryKVS();

const api = new Api(config.concrnt.domain, authProvider, kvs)

// npm公開版 2.0.1 の Api.commit は旧パス(/commit)へPOSTし、かつ失敗を握りつぶして
// resolveしてしまうため使えない。現行コアの /api/v2/commit へ直接POSTする
// (Go版atprotoブリッジの CommitSigned と同じ対応)。サービスアカウントのマスター鍵で署名する。
export const commit = async <T>(document: CommitDocument<T>): Promise<Partial<SignedDocument>> => {
    const docString = JSON.stringify(document);
    const signature = await authProvider.signMaster(docString);
    const response = await fetch(`https://${config.concrnt.domain}/api/v2/commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            document: docString,
            proof: { type: 'concrnt-ecrecover-direct', signature },
        }),
    });
    if (!response.ok) {
        throw new Error(`commit failed: ${response.status} ${await response.text().catch(() => '')}`);
    }
    return await response.json() as Partial<SignedDocument>;
}

export default api;
