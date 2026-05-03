import { Api, InMemoryAuthProvider, InMemoryKVS } from '@concrnt/client'
import { config } from "./config.ts";

const authProvider = new InMemoryAuthProvider(config.concrnt.privateKey);
const kvs = new InMemoryKVS();

const api = new Api(config.concrnt.domain, authProvider, kvs)

console.log("Concrnt API initialized");
console.log("Concrnt API domain:", config.concrnt.domain);

export default api;
