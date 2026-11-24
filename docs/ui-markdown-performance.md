# Markdown表示の負荷分離

## 変更した処理

従来の `ui/src/components/Markdown.tsx` は、ストリーム更新ごとにUIスレッドで全文をMarkdownへ変換し、`rehype-highlight` の言語自動判定も実行していました。KaTeXと構文解析用の言語定義もChatの初期チャンクに含まれていました。

現在は `components/markdown/markdown.worker.ts` がMarkdownの解析、数式の正規化、安全なHASTの生成を担当します。UIはその結果をReact要素に変換します。Workerが完成済みの各ブロックに安定したIDを付けるため、ストリームの末尾が変わっても、前方の変化していない段落・コードブロックを再構築しません。

- 解析の実行は1件ずつです。待機中は各メッセージの最新1件だけを残し、古いトークンごとの全文解析を蓄積しません。ストリーム中のメッセージを待機中の履歴より優先します。
- 非表示・アンマウント時はそのメッセージの待機処理と結果の配送を解除します。再表示、本文の差し替え、同じコンポーネントの再利用後に、以前の結果を挿入しないようライフサイクルと本文を照合します。
- ストリーム中のコードはプレーンなコードとして表示します。生成完了後、Filesと共有する構文ハイライトWorkerに色付けを依頼します。ラベルのないコードの言語判定もWorker内で行います。50,000文字を超えるコードは全文をプレーンなコードとして表示し、コピーと折り返しは使えます。
- 数式のある完成文だけが `remark-math`、`rehype-katex`、KaTeXのCSSを遅延読込します。コード内の `$HOME`、インラインコード、価格、URLのドル記号だけでは数式処理を読み込みません。

## キャッシュと制限

| 対象 | 上限 |
| --- | --- |
| 完成したMarkdownの共有キャッシュ | 32件・ソースと直列化ASTの合計400万文字 |
| Worker内の前回ブロック比較用データ | 32メッセージ・直列化ASTの合計400万文字 |
| 共有構文ハイライトの結果 | 16件・入力とHTMLの合計200万文字 |
| Markdown Workerの応答待ち | 1件につき30秒 |

文字数は保持するデータの予算です。JavaScriptオブジェクト、現在表示している文書、DOMを含むアプリ全体のメモリ量を保証する数値ではありません。

## Workerが使えない場合

本文は最初からプレーンテキストで表示でき、Workerの初期化を待つ必要はありません。CSP、WebViewの対応状況、起動エラーなどでWorkerを使用できない場合、完成済みかつ50,000文字以下の本文だけを、別チャンクのパーサーでアイドル時に整形します。ストリーム中と50,000文字超の本文は全文をプレーンテキストで表示します。

Workerが30秒間応答しなかった場合はWorkerを終了し、待機中の最新本文も全文プレーンテキストへ戻します。そのウィンドウでは以後プレーン表示を継続し、応答しなかった入力をUIスレッドで再解析しません。通常の整形を再開するにはウィンドウを開き直します。途中まで整形できていた場合も、古い先頭部分だけを残して後続の本文を隠さないようにしています。

この互換経路では大きな本文やストリームの装飾が省略されます。通常のWorker経路でも、描画そのものとHASTからReactへの変換はUIスレッドで行います。すべての処理をWorkerに移した構成ではありません。

## 安全性と既存操作

生のHTMLは文字列として表示し、解釈しません。URL属性は `react-markdown` の既定と同じプロトコル方針で検査します。数式の `trust` は無効です。外部画像は読み込まず、画像を開くボタンを表示します。HTTP(S)リンクは既存の `api.web.open` 経由で開きます。

コードのコピー・折り返し、GFMの表・タスクリスト・参照リンク、数式のMathMLを維持しています。コードブロックの操作状態は末尾への追記やストリーム完了でも保持します。

## ビルド設定

`vite.config.ts` は `worker.format: 'es'` を使い、数式用チャンクの動的importを許可します。`resolve.conditions` に `worker` とViteの既定client条件を指定しています。Markdownの文字参照デコーダーとKaTeXのHTML→AST変換にはDOMを使うbrowser版があるため、公式のDOM不要worker版を選ぶ必要があります。遅延互換パーサーにも同じ解決条件を使います。TauriのCSPは変更していません。

次の既存の推移依存を、既存lockと同じ版で直接依存として明示しました。他の依存版は変更していません。

| パッケージ | 版 |
| --- | --- |
| `unified` | `11.0.5` |
| `remark-parse` | `11.0.0` |
| `remark-rehype` | `11.1.2` |
| `hast-util-to-jsx-runtime` | `2.3.6` |
| `html-url-attributes` | `3.0.1` |

## 検証方法

`ui/` で以下を実行します。

```sh
npm run typecheck
npm test
npm run build
npm run test:markdown-worker
npm run test:workbench
```

`markdown-pipeline.test.ts` はURL方針、HTML・数式の安全性、GFM、数式読込の条件、完成ブロックの再利用、300件の更新の集約、非表示メッセージへの配送停止を確認します。

`markdown-dom.test.ts` はコードのコピー・折り返し、外部リンクの経路、画像非読込、数式DOM、遅れて到着した結果の排除、部分描画後のWorker故障、無応答時の全文復帰を確認します。

`test:markdown-worker` はViteが生成した本番WorkerをNodeの `worker_threads` で起動します。`document` と `DOMParser` がない環境で、文字参照・GFM・遅延数式・安全なURL/HTML・ブロック再利用が動くことを確認します。ブラウザ固有のレイアウト、CSP、描画時間や実機の操作遅延を測るテストではありません。

## 最終ビルドの比較

前回修正版の `validation-v1/LLM-Studio-main/ui/dist` と、今回の最終 `ui/dist` を比較しました。`index.html` が指定するmainエントリーを特定し、mainとChatViewから静的import/re-exportを辿り、同じJSアセットを重複して数えない集計です。`index-*.js` には動的な数式用チャンクもあるため、名前だけでmainとは判定していません。

| 測定対象 | 前回修正版 | 今回の最終ビルド |
| --- | ---: | ---: |
| mainエントリー単体 | 436,592 bytes | 460,670 bytes |
| ChatViewチャンク単体 | 793,170 bytes | 222,942 bytes |
| main＋Chat＋静的JS依存の重複除外合計 | 1,249,146 bytes | 702,996 bytes |
| 上記アセットを個別gzipしたサイズの合計 | 383,625 bytes | 222,797 bytes |

mainエントリー自体は増えています。ChatView単体は71.89%、mainとChatの静的依存集合は43.72%縮小しました。これはUIスレッド側の静的JS量の比較であり、操作の高速化率ではありません。

別途、Markdown Workerは159,639 bytes、共有ハイライトWorkerは165,321 bytesです。KaTeXを含む動的チャンクはWorker用459,157 bytesと互換パーサー用441,045 bytesで、どちらもmainとChatの静的依存集合には入りません。Worker、動的import、CSS、フォント、画像、source mapは上表の合計から除外しています。Workerへ分離した結果、ビルド全体の合計サイズが増える場合もあります。

アセットの正確なファイル名、SHA-256、個別サイズ、gzipサイズ、集計条件は [phase2-bundle-sizes.json](phase2-bundle-sizes.json) に記録しています。source mapでも、前回のChatViewにあったMarkdownパーサー、KaTeX、`rehype-highlight` / `lowlight` の共通言語定義が、今回のmain/Chat静的依存から外れたことを確認しています。
