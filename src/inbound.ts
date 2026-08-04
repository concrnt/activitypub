export const ACTIVITYSTREAMS_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

export type InboundVisibility = "public" | "unlisted" | "followers" | "direct";

const VISIBILITY_RANK: Record<InboundVisibility, number> = {
    public: 0,
    unlisted: 1,
    followers: 2,
    direct: 3,
};

export const collectAudience = (...audiences: ReadonlyArray<readonly URL[]>): string[] =>
    [...new Set(audiences.flatMap((audience) => audience.map((uri) => uri.href)))];

export const determineInboundVisibility = (
    to: readonly string[],
    cc: readonly string[],
    followersUri?: string,
): InboundVisibility => {
    if (to.includes(ACTIVITYSTREAMS_PUBLIC)) return "public";
    if (cc.includes(ACTIVITYSTREAMS_PUBLIC)) return "unlisted";

    if (followersUri != null && [...to, ...cc].includes(followersUri)) {
        return "followers";
    }

    return "direct";
};

export const canReadInboundObject = (
    visibility: InboundVisibility,
    recipientCcids: readonly string[],
    requesterCcid?: string,
): boolean => {
    if (visibility === "public" || visibility === "unlisted") return true;
    return requesterCcid != null && recipientCcids.includes(requesterCcid);
};

export const isRestrictedInboundVisibility = (visibility: InboundVisibility): boolean =>
    visibility === "followers" || visibility === "direct";

export const mostRestrictiveInboundVisibility = (
    first: InboundVisibility,
    second: InboundVisibility,
): InboundVisibility => VISIBILITY_RANK[first] >= VISIBILITY_RANK[second] ? first : second;

export const intersectInboundRecipients = (
    first: readonly string[],
    second: readonly string[],
): string[] => {
    const allowed = new Set(second);
    return [...new Set(first)].filter((ccid) => allowed.has(ccid));
};

export const isMissingCommitTargetError = (error: unknown): boolean => {
    const message = error instanceof Error
        ? error.message
        : typeof error === "string" ? error : "";
    return /^commit failed: (?:404|500)\b[\s\S]*\b(?:record )?not found\b/i.test(message);
};
