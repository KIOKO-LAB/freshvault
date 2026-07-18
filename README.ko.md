[English](./README.md) · [日本語](./README.ja.md)

# freshvault

[![CI](https://github.com/KIOKO-LAB/freshvault/actions/workflows/ci.yml/badge.svg)](https://github.com/KIOKO-LAB/freshvault/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/freshvault)](https://www.npmjs.com/package/freshvault)
[![MCP Registry](https://img.shields.io/badge/MCP_registry-io.github.KIOKO--LAB%2Ffreshvault-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=freshvault)
![node](https://img.shields.io/node/v/freshvault)

**Obsidian 볼트가 그대로 Claude의 메모리가 됩니다. 항상 최신, 항상 로컬.**

다른 볼트 검색 MCP는 인덱스 명령을 매번 다시 실행하거나, watch 터미널을 계속 띄워두거나, 웹 UI에서 "Update Index"를 눌러야 합니다. freshvault는 MCP 서버 *내부*에서 볼트를 감시합니다. 노트를 수정하면 몇 초 뒤 Claude가 바로 인식합니다. 자동으로, 계속.

![freshvault demo: save a note, the watcher reindexes it automatically, semantic search finds it seconds later](https://raw.githubusercontent.com/KIOKO-LAB/freshvault/main/docs/demo.gif)

- 🔄 **재인덱싱 불필요** — 파일 워처가 서버 프로세스 안에서 동작하며, 부팅 시 catch-up이 오프라인 중의 수정까지 흡수합니다
- 🔒 **100% 로컬** — 임베딩은 Ollama(`bge-m3`)로 처리되고, 노트는 머신 밖으로 나가지 않습니다
- 🌏 **기본 다국어 지원** — 영어 전용 기본 모델이 놓치는 한국어·일본어를 포함해 `bge-m3`가 100개 이상의 언어를 처리합니다
- 🎯 **벤치마크가 결정하는 검색** — BM25 하이브리드를 직접 만들어 한국어 패러프레이즈 쿼리로 측정했더니 오히려 나빠져서(top-1 82.5%→47.5%) 삭제했습니다. 순수 dense는 의도된 선택 — [측정 기록](docs/ko-bench.md)
- 🪶 **벡터 DB도, Docker도, Python도 없음** — JSON 메타데이터 + Float32 사이드카, 순수 Node, 한자리에서 다 읽을 수 있는 소스
- 🧠 **문장을 존중하는 청킹** — YAML frontmatter를 제거하고 문단/문장 경계에서 분할합니다(CJK 인식)

## 설치

사전 요구 사항: [Node 20+](https://nodejs.org)와 [Ollama](https://ollama.com).

```bash
npx -y freshvault setup
```

이걸로 끝입니다. 위저드가 Obsidian 볼트를 감지하고, 임베딩 모델을 받고, 인덱스를 빌드하고, Claude Code에 등록합니다. 2단계는 없고, 앞으로도 없습니다. 다시 실행할 `index` 명령도, `watch` 터미널도, 백그라운드 서비스도 없습니다.

<details>
<summary>수동 설치 (Claude Desktop / Cursor / Windsurf)</summary>

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

Claude Code 한 줄 등록:

```bash
claude mcp add freshvault -s user -- npx -y freshvault serve
```

</details>

## 사용법

Claude에게 노트에 대해 물어보면 됩니다:

> "캐시 축출 전략에 대해 적어둔 노트를 검색해줘"

도구는 세 개, 전부 읽기 전용입니다:

| tool | what it does |
|---|---|
| `search_notes` | hybrid semantic search — finds meaning, not just keywords |
| `get_note_context` | reads a full note after a search hit (path-traversal safe) |
| `index_status` | freshness report: notes/chunks, last sync, watcher state |

## 동작 방식

```
Obsidian vault ──fs.watch──▶ freshvault MCP server ──search_notes──▶ Claude
   (.md files)               (chunks → bge-m3 embeddings              (generation)
                              → one JSON index, incremental)
```

- **증분 인덱싱**: 변경/삭제된 노트만 다시 임베딩합니다(mtime+size diff, 4초 디바운스)
- **안전망**: 60초 주기의 mtime 스윕이 워처가 놓친 이벤트(네트워크 드라이브, atomic-rename 에디터)를 잡아냅니다
- **다중 클라이언트 안전**: 첫 번째 서버 프로세스가 writer가 되고(하트비트 락), 나머지는 reader로 핫 리로드하다가 writer가 죽으면 스스로 승격합니다
- **트랜잭션 보장**: 인덱싱 도중 임베딩 서버가 죽어도 노트가 유실되거나 손상되는 일은 없습니다
- **스케일**: 벡터는 패킹된 Float32 사이드카에 저장됩니다(빠른 시작, 컴팩트한 용량). 수천 청크에 대한 브루트포스 코사인 연산은 밀리초 단위입니다. 솔직한 한계: 검색은 여전히 선형입니다 — 수만 청크까지는 100ms 미만이지만, 초대형 코퍼스용 벡터 DB를 대체하지는 않습니다

### 다중 볼트

볼트마다 서버를 하나씩 등록합니다 — 인덱스 파일은 볼트별로 자동 분리됩니다:

```bash
claude mcp add work-vault -s user -e FRESHVAULT_VAULT=/path/to/work -- npx -y freshvault serve
claude mcp add personal-vault -s user -e FRESHVAULT_VAULT=/path/to/personal -- npx -y freshvault serve
```

### 다른 임베딩 서버 (LM Studio, LiteLLM, OpenAI 호환)

```bash
FRESHVAULT_EMBED_API=openai FRESHVAULT_EMBED_URL=http://localhost:1234 npx -y freshvault serve
```

`/v1/embeddings`를 지원하는 서버라면 무엇이든 동작합니다. 인증이 필요한 엔드포인트에는 `FRESHVAULT_EMBED_KEY`를 사용합니다(설정 파일에는 절대 기록되지 않습니다).

## 설정

`setup` 이후에는 별도 설정 없이 동작합니다. 필요할 때만 오버라이드합니다:

| Flag | Env | Default |
|---|---|---|
| `--vault` | `FRESHVAULT_VAULT` | from `setup` |
| `--model` | `FRESHVAULT_MODEL` | `bge-m3` |
| `--ollama-url` | `FRESHVAULT_OLLAMA_URL` | `http://localhost:11434` |
| `--data` | `FRESHVAULT_DATA` | platform data dir |
| — | `FRESHVAULT_EMBED_API` | `ollama` (or `openai`) |
| — | `FRESHVAULT_EMBED_URL` | `http://localhost:1234` (openai mode) |
| — | `FRESHVAULT_EMBED_KEY` | none (openai mode, optional) |

명령어: `setup` · `serve` (기본값) · `index` (수동 escape hatch) · `status`

## 벤치마크

한국어 검색 마이크로 벤치마크가 저장소에 포함되어 있습니다(`node scripts/bench.mjs`) — 한국어 노트 30개, 패러프레이즈 쿼리 40개로 임베딩 모델의 top-1/MRR을 비교합니다. 결과는 [docs/ko-bench.md](docs/ko-bench.md)에 있습니다.

## 로드맵

- `bge-m3-ko` 파인튜닝 옵션 + 공개 벤치마크 확장
- 원클릭 Claude Desktop 설치를 위한 MCPB 번들
- 대형 볼트를 위한 리랭킹 패스

## 라이선스

MIT © Kioko Lab
