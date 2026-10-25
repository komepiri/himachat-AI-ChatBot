# himachat-AI-ChatBot
himachat のルームで動く、AIチャットボットです。ブラウザのコンソールに貼って動かします。

> ⚠️ 利用は自己責任です。サイトの規約を確認してから使ってください。
> ⚠️ コンソールに貼るコードは、必ず中身を読んでから実行してください。

## 準備
1. [Groq Console](https://console.groq.com/home) にGoogleかGitHubでログインします。
2. 右上の「API Keys」→「Create API key」で、キーを作ります。
3. 出てきた長い文字列をメモします。**他人に見せない・GitHubに上げないでください。**

## 設定
`index.js` の先頭を書き換えます。

```js
const ROOM_ID = '192275';        // ルームURLの ?room=〇〇 の〇〇
const GROQ_API_KEY = '';         // さっきメモしたキー
```

## 動かし方
1. 対象のルームを開きます。
2. F12 → 「コンソール」を開きます。
3. `index.js` の中身を全部貼って、Enterを押します。
   貼れないときは、`allow pasting` もしくは`貼り付けを許可`と入力してEnterを押してから、もう一度貼ってください。
4. 「Botを起動しました」と出たら成功です。

## 使い方
- `!ai こんにちは` または `ai こんにちは` と書くと、AIが返信します。
- 止めるときは、コンソールで `stopBot()` を実行します。
- モデルは、`MODEL` で `openai/gpt-oss-120b` と `openai/gpt-oss-20b` を切り替えられます。
- Groqの無料枠には、1日・1分あたりの上限があります。
