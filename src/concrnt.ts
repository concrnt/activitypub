import { Api, InMemoryAuthProvider, InMemoryKVS, type Document } from '@concrnt/client'
import { config } from "./config.ts";

// 現行コアは document.kind でディスパッチするが、npm公開版 @concrnt/client 2.0.1 の
// Document 型には kind がまだ無い。クライアント更新までの間、ここで型を補う。
export type DocumentKind = 'entity' | 'record' | 'association' | 'delete' | 'ack' | 'unack'
export type CommitDocument<T> = Document<T> & { kind: DocumentKind }

const authProvider = new InMemoryAuthProvider(config.concrnt.privateKey);
const kvs = new InMemoryKVS();

const api = new Api(config.concrnt.domain, authProvider, kvs)


export default api;
