# Workspace / Git の処理量と待ち時間を減らす構成（phase 3）

## 参照した VS Code ソース

ユーザー提供の `vscode-main.zip`、commit `25e7ea7b8ff47efaf5dd69ee2645f1ed1962ed2c` を参照した。VS Code のコードをランタイムへ同梱したり、VS Code 全体と同等の性能を保証したりする変更ではない。

| 参照ファイル | 実際に確認した仕組み | 今回の適用 |
| --- | --- | --- |
| `src/vs/platform/files/node/diskFileSystemProvider.ts` | ファイル単位の lock、`readFileStream` の chunk 読み取り | 読み取りを範囲単位で再利用し、長い処理は chunk の境界で取消を確認 |
| `src/vs/platform/files/common/io.ts` | `position` / `length` による限定読み取り、ループ内の取消確認 | 同じ版のファイルは疎な行 offset から seek し、必要な範囲の後に EOF まで読まない |
| `src/vs/base/common/async.ts` | `Limiter`、`Queue`、`ResourceQueue` による並列数と resource ごとの待ちの管理 | OS 処理を開始する前に semaphore を取得、同じ root の index 作成を共有 |
| `src/vs/workbench/services/search/node/rawSearchService.ts` | `cacheKey` による検索結果の再利用、絞り込み、取消、`clearCache` | UI 検索だけ短寿命の path index を利用し、fresh API と明示的無効化を維持 |
| `src/vs/platform/files/node/watcher/parcel/parcelWatcher.ts` | 再帰 watcher のイベント集約、buffer / chunk の上限 | 無制限の更新処理を避ける設計を参照。今回は native watcher を新規導入していない |
| `extensions/git/src/git.ts`、`extensions/git/src/repository.ts` | 状態一覧と差分統計の分離、取消、表示状態や操作の終了に合わせた更新 | 背景更新では行数集計を省略し、表示中の Changes だけ詳細を要求 |

## 実装した境界

### API の実行数と取消

`api/workspace.rs` は interactive I/O を 4 件、tree / files / search を別の 2 件まで同時実行する。待っている間は `spawn_blocking` を開始しないため、走査要求だけで blocking thread を増やさない。read-only handler の future が破棄されると共有 flag が立ち、walk の各 entry、read の各 chunk、検索中の各ファイルと一定行数ごとに取消を確認する。

permit は blocking thread が実際に終了するまで保持する。したがって、HTTP future だけが消えた直後に別の仕事を無制限に開始しない。開始済みの write / edit / remove は、元の atomic write の契約どおり完了する。OS の単一 syscall 自体を割り込んで止める仕組みではない。

Git は全体の operation を 4 件、実際の subprocess も 4 個に制限する。既存の timeout、プロセスグループの停止、`kill_on_drop` を維持し、未追跡ファイル集計も次のファイルで取消を確認する。

### ファイル一覧と tree

`/files` の `cache` は既定では false。従来どおりの agent / tool 呼び出しと明示 refresh は新しく走査する。UI の Quick Open / `@` 検索は `cache: true` を送り、完成後 2 秒未満の root 別 path index を再利用する。保持する root は最大 8 個、1 index の推定保持量は最大 8 MiB。大きすぎる index は結果を返すが保持しない。同時に同じ root を要求した場合は、作成中の index を待つ。

空 query の「最近変更したファイル」順と、文字列 query の既存 fuzzy score / tie-break を維持する。並べ替えは全候補を sort する構成から、必要な上位 `limit` 件を保持する heap に変更した。通常の tree ファイルでは、返却対象が決まった後にだけサイズ用 metadata を取得する。symlink をファイル・フォルダーのどちらとして表示するかの確認は従来どおり必要になる。

write / edit / remove、ignore ファイルの編集、実行したコマンドの開始と終了は対応する cache を無効化する。親 root と子 root の一覧も無効化対象になる。個別の保存では他ファイルの行 index を残し、何が変わったか分からないコマンドでは root 内をまとめて無効化する。

**探索上限と完全性:** 従来の files 最大 50,000 ファイル、search 最大 50,000 スキャン対象ファイルに加え、files と search は訪問 entry の総数も 100,000 までにした。大量の空フォルダーや検索対象外の巨大ファイルばかりでも、走査を際限なく続けないためである。search はこの上限で停止すると `truncated: true` を返す。tree は既存の最大 50,000 entry と返却 `limit` を維持し、切り詰め時に `truncated: true` を返す。**FilesResponse は既存の `paths` だけの形を維持しており、打ち切りフラグはない。** 極端に大きな構成では返却件数が `limit` 未満でも、未走査のファイルが存在し得る。対象サブフォルダーを workspace として開くと探索範囲を狭められる。

native watcher はないため、外部エディタ・Git 操作の変更が、既に表示中の一覧へ自動で即反映されるとは保証しない。次の問い合わせで短寿命 index が期限切れなら再走査する。Quick Open の UI query cache は即表示用で、再 query 時にはバックエンドへ再検証する。2 秒は index の再利用期間であり、ファイル変更から画面反映までの応答時間保証ではない。

### ファイル本文の読み取り

UI の file cache も未完了リクエストを最大 2 件に制限した。ファイルを次々選んでも古い要求を際限なく残さず、最も長く再選択されていない pending を abort する。同じファイルに戻った場合は既存の Promise を共有して優先順位を上げる。force refresh と root の無効化でも古い pending を取り消し、dispatch 前に取り消されたものは API を開始しない。完成済み本文とスクロール位置の cache は従来どおり最大 12 件を保持し、単にパネルを閉じたことでは破棄しない。応答を返す側が abort を無視しても待ち Promise を解放し、古い結果を consumer へ返したり新しい cache を上書きしたりしない。取り消された force refresh の古い完成 bytes は画面の保持に使えるが、fresh な応答として再利用しない。

いま表示しているファイルが無効化で取り消された場合は、取消を error 表示せず最新の cache / read を取り直す。再試行は一度に 1 timer だけとし、繰り返す取消では待ちを段階的に増やして上限を設ける。非表示・別 path・unmount では timer を止める。一般の I/O エラーは自動再試行ループに入れない。旧 WebView にない `AbortSignal.throwIfAborted()` は使わず、`reason` がない場合も `AbortError` を作る互換経路を用意した。

`total_lines` を正確に返す既存の契約は維持した。そのため **初回、ファイル更新後、または index がない読み取りは EOF まで行数を数える**。本文全体を保持するわけではなく、返却する本文の byte 上限も従来どおりである。

作成するのは行番号と byte offset の疎な index で、最大 32 ファイル、各 8,192 checkpoint、再利用期間 60 秒。最初は 256 行間隔とし、checkpoint が増えると間隔を広げる。同じ版への次の要求は、指定行の直前の checkpoint へ seek して、指定範囲または byte 上限の後に停止する。最終行の改行有無、UTF-8 の途中を切らない処理、行境界での切り詰め、binary 判定は維持する。

cache lookup の前に、毎回既存の canonical path / workspace 境界チェックを行う。ファイルを開いた handle のサイズ・更新時刻・作成時刻を照合し、Unix では device / inode / ctime も照合する。atomic replacement や変更後の file には古い行 offset を使わない。読み取り中に版が変わった場合は、新しい index を cache に公開しない。OS の metadata が正確に変化しない特殊な filesystem まで、内容のハッシュによる完全検知を行う実装ではない。

### Git の一覧と詳細

`/git/status` は `include_counts` を省略すると従来どおりの完全な結果を返す。`false` を指定した背景更新は porcelain の状態だけを読み、`numstat` と未追跡ファイル内容の行数集計を実行しない。この場合のみ `counts_included: false` を追加し、file ごとの集計値を null、合計を 0 とする。未計測の 0 を「変更がない」と表示しないよう、Changes と Session の UI も対応させた。完全な応答の JSON 形は変えていない。

可視 Changes の effect が詳細購読を登録し、非表示で解除する。最後の詳細購読者がいなくなったら、その詳細リクエストを abort し、必要な一覧更新を軽量な要求へ戻す。遅れて完了した古い応答は状態へ反映しない。個々の diff 行も閉じる・非表示・対象変更で abort する。

単一ファイルの diff は status の pathspec もそのファイルへ限定する。ただし Git は範囲外との rename を A / D に分けて報告することがあるため、その場合は全体 listing に戻り、従来の rename patch を復元する。`GIT_OPTIONAL_LOCKS=0`、fsmonitor hook 無効、外部 diff / textconv 無効、literal pathspec、workspace のパス検査は維持した。Git status の完成結果を TTL で使い回す cache は追加していない。

## 実際に検証した作業量

Linux、Rust / Cargo 1.100.0、実 Git の一時リポジトリを使用。以下はアプリ内カウンターと subprocess 引数の回帰テストによる値であり、ディスクの物理 I/O、UI のフレーム時間、利用者環境の所要時間を表すものではない。

| 条件 | 確認した結果 |
| --- | --- |
| 同じ root で空 query → `main` → `model`、index が有効 | directory walker の作成 1 回 |
| 同時に 2 query、500 ファイルの root | directory walker の作成 1 回 |
| UI で未完了ファイルを 3 個選択し、その間に同じ file を再選択 | API read の同時有効数は 2、共有 Promise を維持し、優先順位の低い pending を abort |
| 通常ファイル 400 件、tree の `limit: 7` | 返却用サイズ stat 7 回、順序とサイズ一致、`truncated: true` |
| `line 000001\n` 形式の 150,000 行、初回 1～2 行を要求 | 本文 scan の buffered chunk 28 個、`total_lines = 150000` |
| 同じ版の 100,000～100,002 行を要求 | 本文 scan の buffered chunk 1 個、本文・開始行・終了行・総行数が正確 |
| 変更 tracked file 1 個＋未追跡 file 2 個、Git summary | subprocess 2 個、`--numstat` 0 回、未追跡 file 集計 0 回 |
| 同じ fixture の完全な Git status | 行数集計を保持し、added 4 / removed 1、未追跡 file 集計 2 回 |
| 通常の tracked file を 1 個 diff | status はその pathspec 1 回 |
| 範囲外から rename した file を diff | scoped status と全体 status の 2 回、rename from / to を維持 |

追加の検証には、fresh request と TTL 期限切れ、ignore 編集後の無効化、同サイズ・同 mtime の atomic replacement、cache 後の symlink escape 拒否、取消済みの queued job が開始しないこと、実行中 job が止まるまで permit を保持すること、可視の詳細購読者が複数いる場合の共有を含む。

作業中の個別 gate は workspace unit 70/70、workspace API 2/2、Git / terminal HTTP integration 10/10、editor cache 13/13、FileViewer cancellation DOM 4/4、Git lifecycle DOM 3/3、UI typecheck が成功。FileViewer は公開 `FilesPanel` を実際に mount し、20 回の無効化 burst、7 回の連続取消、隠す・再表示・別 path への移動、旧 transport の遅い完了を検証した。最終的な統合 gate は phase 3 全体の検証報告と合わせて確認する。

## 再実行

リポジトリ root から:

```sh
cargo test --locked -p misaka-studio-runtime --lib workspace -- --nocapture
cargo test --locked -p misaka-studio-runtime --test workspace_api --test workspace_git_and_terminal
```

`ui` から:

```sh
node --test test/editor-cache.test.ts test/file-viewer-cancellation.test.ts test/git-status-lifecycle.test.ts
npm run typecheck
```

主な実装: `crates/misaka-studio-runtime/src/workspace.rs`、`workspace/git.rs`、`api/workspace.rs`。作業量のテストは `workspace/performance_tests.rs`、UI の可視性と取消は `ui/test/file-viewer-cancellation.test.ts` と `ui/test/git-status-lifecycle.test.ts`。依存ライブラリは追加していない。
