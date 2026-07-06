# concrnt-ap-bridge

concrnt v2 の ActivityPub ブリッジ。concrnt のユーザーを Fediverse (Mastodon / Misskey 等) へ連合し、逆にリモートのアクターを concrnt のタイムラインへ取り込みます。

## アーキテクチャ

```
Fediverse ⇄ [Fedify federation (src/federation.ts)] ⇄ concrnt core
                       ↑                                  ↓ Redis pub/sub
              [REST API (src/app.ts)]        [daemon (src/daemon.ts)]
```

- **src/federation.ts** — Fedify の inbox リスナー(Follow / Undo / Accept / Reject / Create / Announce / Like / EmojiReact / Update / Delete)、アクター・鍵・followers・outbox・Note の各ディスパッチャ。
- **src/daemon.ts** — Redis pub/sub で concrnt のイベントを購読し、投稿→Create、boost→Announce、Like/リアクション→Like、削除→Delete/Undo、プロフィール更新→Update(Person) を配信。
- **src/app.ts** — concrnt クライアント向けの REST API (`/ap/api/*`): setup / settings / followers / following / follow / unfollow / resolve。
- **src/convert.ts, src/render.ts, src/schemas.ts** — concrnt ドキュメント ⇄ AP オブジェクトの変換ロジック。render/schemas は純粋関数でユニットテスト対象。
- **src/db/** — Drizzle ORM (Postgres)。

## スキーママッピング

| concrnt | ActivityPub | 方向 |
|---|---|---|
| `m/markdown.json` ほかテキスト系 | `Create{Note}` | 送信 |
| `m/media.json` | `Create{Note}` + attachments | 送信 |
| `m/reply.json` | `Create{Note}` + `inReplyTo` | 送信 |
| `m/reroute.json` (bodyなし) | `Announce` | 双方向 |
| `m/reroute.json` (bodyあり) | `Create{Note}` + `quoteUrl` | 送信 |
| `a/like.json` | `Like` | 双方向 |
| `a/reaction.json` | `Like` + `Emoji` tag / `EmojiReact` | 双方向 |
| `ap/note.json` | リモート Note への軽量参照 | 受信 |
| `delete.json` | `Delete` / `Undo` | 双方向 |
| `p/main.json` | `Person` (name/summary/icon) + `Update` | 送信 |

受信したリモート投稿は本文を複製せず、`ap/note.json` (`{actorURL, noteURL}`) としてフォロワーの inbox タイムラインへ配送します(表示時にクライアントが解決)。受信 boost は同様にサービスアカウント名義の `m/reroute.json` + `profileOverride` で表現します。

AP オブジェクト ⇄ concrnt URI の対応は、note/announce は URL ハッシュによる決定的キー、like/reaction と送信済み activity は `ap_object_references` テーブルで管理します。

## セットアップ

```sh
cp config.example.yaml config.yaml   # 編集する
pnpm install
pnpm migrate
pnpm dev        # 開発 (tsx watch)
pnpm prod       # 本番
```

必要なもの: Postgres、Redis(concrnt コアと同じインスタンス)、concrnt コア。リバースプロキシで `/ap/*` と `/.well-known/*` をこのサーバーへ向けてください。

## 開発

```sh
pnpm typecheck  # tsc --noEmit
pnpm test       # vitest
pnpm lint       # eslint
```
