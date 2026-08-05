import { Api, InMemoryAuthProvider, InMemoryKVS, type Document, type SignedDocument } from '@concrnt/client'
import { config } from "./config.ts";

const authProvider = new InMemoryAuthProvider(config.concrnt.privateKey);
const kvs = new InMemoryKVS();

const api = new Api(config.concrnt.domain, authProvider, kvs)

// サービスアカウントはマスター鍵のみ(subkeyなし)なので useMasterkey を明示する
export const commit = <T>(document: Document<T>): Promise<SignedDocument> =>
    api.commit(document, undefined, { useMasterkey: true });

export default api;
