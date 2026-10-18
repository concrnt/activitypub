// ブラウザ(AcceptがActivityPub型でない)でactor/Note URLを開かれたときのリダイレクト先(world-app)を決める。
// fedifyがroute一致後に「JSON-LD不可」と判定して onNotAcceptable を呼んだ時点で使うので、
// ここではAcceptヘッダは見ない。純粋関数(DB参照はlookupCcidで注入)でユニットテスト対象。

export type WebRedirectTarget =
    | { kind: 'profile'; identifier: string }
    | { kind: 'post'; identifier: string; uri: string };

export type WebRedirectResult =
    | { kind: 'redirect'; location: string }
    | { kind: 'not-found' };

// fedifyのルート: actor `/ap/acct/{identifier}`、Note `/ap/acct/{identifier}/posts/{+id}`。
// `{+id}` なのでcckv URIは生のままパスに載る(`/posts/cckv://ccid/...`)が、%エンコードされた形も受ける。
// outbox/followers/inbox 等は対象外(v1と同じ)。
export const parseApPath = (pathname: string): WebRedirectTarget | null => {
    const m = /^\/ap\/acct\/([^/]+)(?:\/posts\/(.+))?$/.exec(pathname);
    if (!m) return null;
    let identifier: string;
    let id: string | undefined;
    try {
        identifier = decodeURIComponent(m[1]);
        id = m[2] === undefined ? undefined : decodeURIComponent(m[2]);
    } catch {
        return null;
    }
    if (identifier.length === 0) return null;
    if (id === undefined) return { kind: 'profile', identifier };
    if (id.length === 0) return null;
    return { kind: 'post', identifier, uri: id };
};

// world-app webのルートに合わせる: `/profile/:ccid`、`/post/:uri`(uriはencodeURIComponent)
export const buildWebUrl = (webUrl: string, target: WebRedirectTarget, ccid: string): string => {
    const base = webUrl.replace(/\/+$/, '');
    switch (target.kind) {
        case 'profile':
            return `${base}/profile/${encodeURIComponent(ccid)}`;
        case 'post':
            return `${base}/post/${encodeURIComponent(target.uri)}`;
    }
};

export interface ResolveWebRedirectOptions {
    webUrl: string;
    // identifier→ccid。null=entity不在(404)、undefined=リダイレクト対象外(instance.actor等)
    lookupCcid: (identifier: string) => Promise<string | null | undefined>;
}

// null=このパスはリダイレクト対象外(呼び出し側は従来どおり406等にフォールバック)
export const resolveWebRedirect = async (
    pathname: string,
    options: ResolveWebRedirectOptions,
): Promise<WebRedirectResult | null> => {
    const target = parseApPath(pathname);
    if (!target) return null;

    const ccid = await options.lookupCcid(target.identifier);
    if (ccid === undefined) return null;
    if (ccid === null) return { kind: 'not-found' };

    if (target.kind === 'post') {
        // Noteディスパッチャと同じ整合条件: URIのowner(host)がentityのccidであること
        if (URL.parse(target.uri)?.host !== ccid) return { kind: 'not-found' };
    }

    return { kind: 'redirect', location: buildWebUrl(options.webUrl, target, ccid) };
};
