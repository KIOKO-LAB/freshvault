[English](./README.md) · [한국어](./README.ko.md)

# freshvault

[![CI](https://github.com/KIOKO-LAB/freshvault/actions/workflows/ci.yml/badge.svg)](https://github.com/KIOKO-LAB/freshvault/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/freshvault)](https://www.npmjs.com/package/freshvault)
[![MCP Registry](https://img.shields.io/badge/MCP_registry-io.github.KIOKO--LAB%2Ffreshvault-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=freshvault)
![node](https://img.shields.io/node/v/freshvault)

**Obsidian ボルトがそのまま Claude のメモリになります。常に最新、常にローカル。**

他のボルト検索 MCP は、インデックスコマンドの再実行、watch ターミナルの常駐、Web UI での「Update Index」クリックをユーザーに強います。freshvault は MCP サーバーの*内部*からボルトを監視します。ノートを編集すれば、数秒後には Claude が認識します。自動で、ずっと。

![freshvault demo: save a note, the watcher reindexes it automatically, semantic search finds it seconds later](https://raw.githubusercontent.com/KIOKO-LAB/freshvault/main/docs/demo.gif)

- 🔄 **再インデックス不要** — ファイルウォッチャーはサーバープロセス内で動作し、起動時のキャッチアップがオフライン中の編集も取り込みます
- 🔒 **100% ローカル** — 埋め込みは Ollama(`bge-m3`)で処理され、ノートがマシンの外に出ることはありません
- 🌏 **標準でマルチリンガル** — 英語専用のデフォルトモデルが苦手とする韓国語・日本語を含め、`bge-m3` が 100 以上の言語に対応します
- 🎯 **ベンチマーク駆動の検索設計** — BM25 ハイブリッドを実装し、韓国語パラフレーズクエリで測定した結果、精度が悪化したため(top-1 82.5%→47.5%)削除しました。純粋な dense 検索は意図的な選択です — [測定記録](docs/ko-bench.md)
- 🪶 **ベクトル DB も Docker も Python も不要** — JSON メタデータ + Float32 サイドカー、素の Node、一気に読み切れるソースコード
- 🧠 **文を尊重するチャンキング** — YAML フロントマターを除去し、段落・文の境界で分割します(CJK 対応)

## インストール

前提条件: [Node 20+](https://nodejs.org) と [Ollama](https://ollama.com)。

```bash
npx -y freshvault setup
```

これだけです。ウィザードが Obsidian ボルトを検出し、埋め込みモデルを取得し、インデックスを構築し、Claude Code に登録します。ステップ 2 は存在せず、これからも存在しません。再実行する `index` コマンドも、`watch` ターミナルも、バックグラウンドサービスもありません。

<details>
<summary>手動インストール (Claude Desktop / Cursor / Windsurf)</summary>

```json
{
  "mcpServers": {
    "freshvault": {
      "command": "npx",
      "args": ["-y", "freshvault", "serve"],
      "env": { "FRESHVAULT_VAULT": "/absolute/path/to/your/vault" }
    }
  }
}
```

Claude Code のワンライナー:

```bash
claude mcp add freshvault -s user -- npx -y freshvault serve
```

</details>

## 使い方

Claude にノートのことを聞くだけです:

> 「キャッシュ削除戦略について書いたノートを検索して」

ツールは 3 つ、すべて読み取り専用です:

| tool | what it does |
|---|---|
| `search_notes` | hybrid semantic search — finds meaning, not just keywords |
| `get_note_context` | reads a full note after a search hit (path-traversal safe) |
| `index_status` | freshness report: notes/chunks, last sync, watcher state |

## 仕組み

```
Obsidian vault ──fs.watch──▶ freshvault MCP server ──search_notes──▶ Claude
   (.md files)               (chunks → bge-m3 embeddings              (generation)
                              → one JSON index, incremental)
```

- **インクリメンタル**: 変更・削除されたノートだけを再埋め込みします(mtime+size の差分、4 秒のデバウンス)
- **セーフティネット**: 60 秒間隔の mtime スイープが、ウォッチャーの取りこぼし(ネットワークドライブ、atomic rename を行うエディタ)を回収します
- **マルチクライアント対応**: 最初のサーバープロセスが writer になり(ハートビート付きロック)、他は reader としてホットリロードし、writer が落ちれば自ら昇格します
- **トランザクショナル**: インデックス処理の途中で埋め込みサーバーが落ちても、ノートの消失や破損は起こりません
- **スケール**: ベクトルはパックされた Float32 サイドカーに格納されます(高速起動・コンパクト)。数千チャンクへのブルートフォースなコサイン計算はミリ秒で終わります。正直な注記: 検索は依然として線形です — 数万チャンクまでは 100ms 未満ですが、巨大コーパス向けのベクトル DB の代替にはなりません

### 複数ボルト

ボルトごとにサーバーを 1 つ登録します — インデックスファイルはボルト単位で自動的に分離されます:

```bash
claude mcp add work-vault -s user -e FRESHVAULT_VAULT=/path/to/work -- npx -y freshvault serve
claude mcp add personal-vault -s user -e FRESHVAULT_VAULT=/path/to/personal -- npx -y freshvault serve
```

### 他の埋め込みサーバー (LM Studio, LiteLLM, OpenAI 互換)

```bash
FRESHVAULT_EMBED_API=openai FRESHVAULT_EMBED_URL=http://localhost:1234 npx -y freshvault serve
```

`/v1/embeddings` を話すサーバーなら何でも動作します。認証付きエンドポイントには `FRESHVAULT_EMBED_KEY` を使います(設定ファイルには一切書き込まれません)。

## 設定

`setup` 後はゼロコンフィグで動作します。必要な場合のみ上書きします:

| Flag | Env | Default |
|---|---|---|
| `--vault` | `FRESHVAULT_VAULT` | from `setup` |
| `--model` | `FRESHVAULT_MODEL` | `bge-m3` |
| `--ollama-url` | `FRESHVAULT_OLLAMA_URL` | `http://localhost:11434` |
| `--data` | `FRESHVAULT_DATA` | platform data dir |
| — | `FRESHVAULT_EMBED_API` | `ollama` (or `openai`) |
| — | `FRESHVAULT_EMBED_URL` | `http://localhost:1234` (openai mode) |
| — | `FRESHVAULT_EMBED_KEY` | none (openai mode, optional) |

コマンド: `setup` · `serve` (デフォルト) · `index` (手動の逃げ道) · `status`

## ベンチマーク

韓国語検索のマイクロベンチマークをリポジトリに同梱しています(`node scripts/bench.mjs`) — 韓国語ノート 30 件・パラフレーズクエリ 40 件で、埋め込みモデルの top-1/MRR を比較します。結果は [docs/ko-bench.md](docs/ko-bench.md) にあります。

## ロードマップ

- `bge-m3-ko` ファインチューニングオプション + 公開ベンチマークの拡充
- ワンクリックで Claude Desktop にインストールできる MCPB バンドル
- 大規模ボルト向けのリランキングパス

## ライセンス

MIT © Kioko Lab
