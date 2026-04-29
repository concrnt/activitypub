

export async function resolveConcrntDocument(uri: string) {

    const resp = await fetch(`https://cc2.tunnel.anthrotech.dev/resolve?uri=${encodeURIComponent(uri)}`)
    if (!resp.ok) {
        throw new Error(`Failed to resolve document: ${resp.statusText}`)
    }
    const data = await resp.json()
    return data as SignedDocument
}

export interface Document<T> {
    key?: string
    schema: string
    value: T
    author: string
    createdAt: Date
    distributes?: string[]

    associate?: string
    associationVariant?: string

    policies?: Policy[]
}

export interface Policy {
    url: string
    params?: any
    defaults?: Record<string, string>
}

export interface SignedDocument {
    cckv: string
    ccfs: string
    document: string
    proof: Proof
}

export interface Proof {
    type: string
    signature: string
    key?: string
}

