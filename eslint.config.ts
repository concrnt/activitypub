import fedifyLint from "@fedify/lint";

// @fedify/lint のデフォルトはルート直下の federation.ts しか対象にしないため、
// このリポジトリの配置(src/)に合わせて対象を広げる
export default [
    {
        ...fedifyLint,
        files: [...fedifyLint.files, "src/federation.ts"],
    },
];
