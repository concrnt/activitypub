import { Api, InMemoryAuthProvider, InMemoryKVS } from '@concrnt/client'

const authProvider = new InMemoryAuthProvider(process.env.CONCRNT_PRIVATE);
const kvs = new InMemoryKVS();

const api = new Api(process.env.CONCRNT_DOMAIN, authProvider, kvs)

console.log("Concrnt API initialized");
console.log("Concrnt API domain:", process.env.CONCRNT_DOMAIN);

export default api;

