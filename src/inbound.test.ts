import { describe, expect, test } from "vitest";
import {
    ACTIVITYSTREAMS_PUBLIC,
    canReadInboundObject,
    collectAudience,
    determineInboundVisibility,
} from "./inbound.ts";

describe("collectAudience", () => {
    test("combines activity and object audience without duplicates", () => {
        expect(collectAudience(
            [new URL("https://example.com/users/alice")],
            [new URL("https://example.com/users/alice"), new URL(ACTIVITYSTREAMS_PUBLIC)],
        )).toEqual([
            "https://example.com/users/alice",
            ACTIVITYSTREAMS_PUBLIC,
        ]);
    });
});

describe("determineInboundVisibility", () => {
    const followers = "https://remote.example/users/bob/followers";

    test("distinguishes public and unlisted posts", () => {
        expect(determineInboundVisibility([ACTIVITYSTREAMS_PUBLIC], [], followers)).toBe("public");
        expect(determineInboundVisibility([], [ACTIVITYSTREAMS_PUBLIC], followers)).toBe("unlisted");
    });

    test("distinguishes followers-only and direct posts", () => {
        expect(determineInboundVisibility([followers], [], followers)).toBe("followers");
        expect(determineInboundVisibility(["https://local.example/ap/users/alice"], [], followers)).toBe("direct");
    });
});

describe("canReadInboundObject", () => {
    test("allows public objects without a requester", () => {
        expect(canReadInboundObject("public", [], undefined)).toBe(true);
        expect(canReadInboundObject("unlisted", [], undefined)).toBe(true);
    });

    test("allows restricted objects only for a delivered recipient", () => {
        expect(canReadInboundObject("followers", ["con1recipient"], "con1recipient")).toBe(true);
        expect(canReadInboundObject("direct", ["con1recipient"], "con1other")).toBe(false);
        expect(canReadInboundObject("direct", ["con1recipient"], undefined)).toBe(false);
    });
});
