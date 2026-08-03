export const ACTIVITYSTREAMS_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

export type InboundVisibility = "public" | "unlisted" | "followers" | "direct";

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
