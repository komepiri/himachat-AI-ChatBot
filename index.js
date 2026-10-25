// ===== 設定 =====
const ROOM_ID = '192275';
const GROQ_API_KEY = '';

// 使うモデル(どちらかに切り替え)
const MODEL = 'openai/gpt-oss-120b';
// const MODEL = 'openai/gpt-oss-20b';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const POLL_INTERVAL_MS = 2000;
const MAX_HISTORY = 7; // localStorageに残す会話の最大数(古いものから削除)
const STORAGE_KEY = 'conversationLog';
const MAX_POST_LENGTH = 200; // 1回の投稿の最大文字数(空白含む)
const MAX_PARTS = 3;         // 長い返信を分割して送る最大回数(これを超えた分は切り捨て)
const PART_DELAY_MS = 1500;  // 分割投稿の間隔(順番が入れ替わらないようにするため)
const MIN_REQUEST_INTERVAL_MS = 2000; // API呼び出しの最短間隔(暴走対策&レート制限対策)
const MAX_QUEUE = 2;          // 返信待ちコマンドの最大数(荒らしによる大量投稿対策)
const MAX_HANDLED_KEYS = 500;  // 処理済みキーを覚えておく最大数
const MAX_BOT_POSTS = 10;      // 自分の投稿として覚えておく最大数

// ----- 同じ人の連投防止 -----
const USER_COOLDOWN_MS = 4000; // 同じ人が次にコマンドを送れるまでの間隔
const MAX_TRACKED_USERS = 200;  // クールダウンを覚えておく人数の上限
// 投稿者を区別できるフィールド名(例: 'name' や 'uid')。null のままだと連投防止は無効。
// 調べ方: 起動時にコンソールへ最新メッセージの中身が出るので、投稿者のIDや名前が入っている項目名を入れる。
const SENDER_FIELD = 'uid';

const SYSTEM_PROMPT = [
    `あなたはチャットルームで動くAIチャットボットです。Groq APIとGPT-OSS-120Bを使って開発されています。管理者は「こめ」という人物です。`,
    '複数の人が同じ会話に書き込むため、前の発言と話し手が変わっている場合があります。',
    'マークダウン記法や絵文字、改行をどの理由があろうと絶対に使用しないこと。平文の一行で。',
    '空白や記号を含めて170文字以内に必ず収める(投稿の上限が200文字のため)。多少多くなっても問題はない設計だがこれは絶対に遵守すること。必要最低限の情報だけを出力すること。',
    'リアルタイムの情報は取得できないこと。(例えば今日の天気などは取れない)'
].join('\n');

// "!ai 文章" または "ai 文章" にマッチ(区切りは空白、全角空白もOK)
const COMMAND_PATTERN = /^(?:!ai|ai)(?:\s+([\s\S]+))?$/i;

const HELP_TEXT =
    'ヘルプメッセージです。' +
    '!aiまたはaiのあとに空白を入れてその後に適当な文章を入力してください。' +
    '';

const START_TEXT = `Botを起動しました。現在動作中のモデルは${MODEL}です。`;
const STOP_TEXT = 'Bot内部のコード修正作業に入るため、Botを一時停止しました。数秒以内に再起動します。';

const RATE_LIMIT_TEXT = '現在使用できない状態です。1~2分後に再度使用してください。Error: Rate limit reached.';

// ===== 状態 =====
let initialized = false;  // 初回ポーリング済みか(起動前の古いコマンドに返信しないため)
let stopped = false;      // stopBot()が呼ばれたか
let lastRequestAt = 0;    // 最後にAPIを呼んだ時刻
let isBusy = false;       // キュー処理中か(二重実行防止)
const handledKeys = new Set(); // 処理済み(キュー投入済み)のメッセージ識別キー
const queue = [];              // 返信待ちのコマンド(古い順)
const botPosts = [];           // Botが最近投稿した文章(自分の発言に反応しないため)
const lastUserAt = new Map();  // 投稿者 → 最後にコマンドを受け付けた時刻(連投防止)

// ===== 会話履歴 =====
function loadHistory() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch {
        return [];
    }
}

function saveConversation(input, response) {
    const log = loadHistory();
    log.push({ input, response });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(log.slice(-MAX_HISTORY)));
}

// ===== Groq API =====
function buildMessages(inputText) {
    const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

    for (const { input, response } of loadHistory()) {
        messages.push({ role: 'user', content: input });
        messages.push({ role: 'assistant', content: response });
    }

    messages.push({ role: 'user', content: inputText });
    return messages;
}

async function askGroq(inputText) {
    const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
            model: MODEL,
            messages: buildMessages(inputText),
            temperature: 1,
            top_p: 0.95,
            max_completion_tokens: 8192,
            reasoning_effort: 'medium' // 質を上げたいので medium。枠を節約したいなら 'low'
        })
    });

    if (res.status === 429) {
        const err = new Error('HTTP 429: レート制限エラー');
        err.rateLimited = true;
        throw err;
    }
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Groq APIから適切な応答が返されませんでした。');
    return clipAnswer(text);
}

// モデルが書きすぎたときの保険(分割しても MAX_PARTS 回に収まる長さまで)
function clipAnswer(text) {
    const limit = MAX_POST_LENGTH * MAX_PARTS;
    const chars = Array.from(text);
    return chars.length <= limit
        ? text
        : chars.slice(0, limit - 1).join('') + '…';
}

// 長い文章を MAX_POST_LENGTH 文字ごとに分割する(続きから送るため)
// 区切りの近くに句点などがあれば、そこで切って読みやすくする
function splitText(text) {
    const chars = Array.from(text);
    const parts = [];
    let start = 0;

    while (start < chars.length) {
        let end = Math.min(start + MAX_POST_LENGTH, chars.length);

        if (end < chars.length) {
            // 後半(100文字目以降)に文末記号があれば、その直後で切る
            for (let i = end - 1; i >= start + MAX_POST_LENGTH / 2; i--) {
                if ('。！？!?\n'.includes(chars[i])) {
                    end = i + 1;
                    break;
                }
            }
        }

        const part = chars.slice(start, end).join('').trim();
        if (part) parts.push(part);
        start = end;
    }
    return parts.slice(0, MAX_PARTS);
}

// ===== himachat =====
async function postMessage(text) {
    const body = new URLSearchParams({
        marumie: myid,
        mysession: mysession,
        roomid: ROOM_ID,
        waruguti: text
    });

    const res = await fetch('https://himachat.jp/gomitame.php?mode=monku', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });

    // 投稿が弾かれていないか確認できるようにレスポンスをログに出す
    const result = await res.text();
    console.log(`投稿レスポンス(HTTP ${res.status}):`, result);
    return result;
}

// 直近のメッセージ一覧を取得(先頭が最新)
async function fetchRecentMessages() {
    const body = new URLSearchParams({
        marumie: myid,
        mysession: mysession,
        roomid: ROOM_ID,
        bmark: '29316675'
    });

    const res = await fetch('https://himachat.jp/RoomChatGet.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });

    const data = JSON.parse(await res.text());
    return data.msgs ?? [];
}

// ===== メイン処理 =====
// Bot自身の投稿かどうか(サイト側で切り詰められた場合も考慮)
function isOwnMessage(mozi) {
    return botPosts.some(post =>
        mozi === post || (mozi.length >= 20 && post.startsWith(mozi))
    );
}

// 投稿する文章を覚えておく(直近の数件。複数返信しても全部「自分の発言」と判定できるように)
function rememberBotPost(text) {
    botPosts.push(text);
    if (botPosts.length > MAX_BOT_POSTS) botPosts.shift();
}

// コマンドなら本文を返す("!ai"だけなら空文字、コマンドでなければnull)
function parseCommand(mozi) {
    const match = mozi.match(COMMAND_PATTERN);
    return match ? (match[1]?.trim() ?? '') : null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function markHandled(key) {
    handledKeys.add(key);
    if (handledKeys.size > MAX_HANDLED_KEYS) {
        handledKeys.delete(handledKeys.values().next().value); // 一番古いキーを捨てる
    }
}

// 直近のメッセージから「まだ処理していないaiコマンド」を全部集める(古い順)
function collectNewCommands(msgs) {
    const commands = [];

    for (const msg of [...msgs].reverse()) { // msgsは先頭が最新なので逆順にする
        const mozi = msg?.mozi?.trim();
        if (!mozi || isOwnMessage(mozi)) continue;

        const inputText = parseCommand(mozi);
        if (inputText === null) continue;

        // メッセージ全体をキーにして、同じ文面の別投稿も区別する
        const key = JSON.stringify(msg);
        if (!handledKeys.has(key)) {
            commands.push({
                key,
                mozi,
                inputText,
                sender: SENDER_FIELD ? msg[SENDER_FIELD] ?? null : null
            });
        }
    }
    return commands;
}

// 同じ人の連投なら true(クールダウン中)。受け付けるなら時刻を記録して false
function isUserOnCooldown(sender) {
    if (sender == null) return false; // 投稿者が不明なら判定しない

    const now = Date.now();
    const last = lastUserAt.get(sender);
    if (last && now - last < USER_COOLDOWN_MS) return true;

    lastUserAt.delete(sender); // 入れ直して「一番新しい」位置にする
    lastUserAt.set(sender, now);
    if (lastUserAt.size > MAX_TRACKED_USERS) {
        lastUserAt.delete(lastUserAt.keys().next().value); // 一番古い人を捨てる
    }
    return false;
}

async function handleCommand({ mozi, inputText }) {
    console.log('コマンド検知:', mozi);

    try {
        // コマンドだけで本文がない → 使い方を返す
        if (!inputText) {
            console.log('使い方をPOST:', HELP_TEXT);
            rememberBotPost(HELP_TEXT);
            await postMessage(HELP_TEXT);
            return;
        }

        const answer = await askGroq(inputText);
        console.log('Groqの生成テキスト:', answer);

        saveConversation(inputText, answer); // 履歴には分割前の全文を保存

        // 200文字を超える分は、続きとして順番に投稿する
        const parts = splitText(answer);
        for (let i = 0; i < parts.length; i++) {
            if (stopped) break;
            if (i > 0) await sleep(PART_DELAY_MS);

            rememberBotPost(parts[i]); // 投稿前に記録して、自分の発言に反応しないようにする
            await postMessage(parts[i]);
        }
    } catch (e) {
        console.error('エラー:', e);
        if (e.rateLimited) {
            queue.length = 0; // 制限中は残りも失敗するので、キューを捨てて連投を防ぐ
            rememberBotPost(RATE_LIMIT_TEXT);
            await postMessage(RATE_LIMIT_TEXT).catch(console.error);
        }
    }
}

// キューのコマンドを1件ずつ、順番に処理する
async function processQueue() {
    if (isBusy) return; // すでに処理中なら、そのループが残りも片付ける
    isBusy = true;

    try {
        while (queue.length > 0 && !stopped) {
            const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
            if (wait > 0) await sleep(wait);

            lastRequestAt = Date.now();
            await handleCommand(queue.shift());
        }
    } finally {
        isBusy = false;
    }
}

async function poll() {
    try {
        const msgs = await fetchRecentMessages();
        const commands = collectNewCommands(msgs);

        // 初回は、すでにあるコマンドを「処理済み」にするだけで返信しない
        if (!initialized) {
            initialized = true;
            commands.forEach(c => markHandled(c.key));
            if (!SENDER_FIELD) {
                console.log('SENDER_FIELD未設定です。投稿者を示す項目を探してください。最新メッセージ:', msgs[0]);
            }
            return;
        }

        for (const command of commands) {
            markHandled(command.key);
            if (queue.length >= MAX_QUEUE) {
                console.warn('キューが満杯のため破棄:', command.mozi);
                continue;
            }
            if (isUserOnCooldown(command.sender)) {
                console.warn('同じ人の連投のため無視:', command.mozi);
                continue; // 返信せず黙って捨てる
            }
            queue.push(command);
        }

        processQueue(); // 待たずに実行(処理中でもポーリングは止めない)
    } catch (e) {
        console.error('エラー:', e);
    }
}

// 止めたいときはコンソールで stopBot() を実行
const pollTimerId = setInterval(poll, POLL_INTERVAL_MS);

async function stopBot() {
    if (stopped) return;
    stopped = true;
    clearInterval(pollTimerId);
    queue.length = 0;

    try {
        await postMessage(STOP_TEXT);
    } catch (e) {
        console.error('停止メッセージの送信に失敗:', e);
    }
    console.log('Botを停止しました');
}

// 起動メッセージ
rememberBotPost(START_TEXT); // 自分の発言として扱い、反応しないようにする
postMessage(START_TEXT).catch(e => console.error('起動メッセージの送信に失敗:', e));
