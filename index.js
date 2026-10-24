// ===== 設定 =====
const ROOM_ID = 'YOUR_ROOM_ID';
const GROQ_API_KEY = 'YOUR_GROQ_API_KEY';

// 使うモデル(どちらかに切り替え)
const MODEL = 'openai/gpt-oss-120b';
// const MODEL = 'openai/gpt-oss-20b';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const POLL_INTERVAL_MS = 2000;
const MAX_HISTORY = 20; // localStorageに残す会話の最大数(古いものから削除)
const STORAGE_KEY = 'conversationLog';
const MIN_REQUEST_INTERVAL_MS = 5000; // 暴走(Bot自身への返信ループ等)対策の最短API呼び出し間隔

const SYSTEM_PROMPT =
    'マークダウン形式を使用せずにできるだけ文字数を少なくして回答してください。' +
    'また、改行もあまり入れないでください。' +
    'あなたはGroq APIとGPT-OSSを使って開発されたAIチャットボットです。';

// "!ai 文章" または "ai 文章" のみ取得(区切りは空白、全角空白もOK)
const COMMAND_PATTERN = /^(?:!ai|ai)(?:\s+([\s\S]+))?$/i;

const HELP_TEXT =
    '!aiまたはaiのあとに空白を入れてその後に適当な文章を入力してください。' +
    '' +
    '';

const RATE_LIMIT_TEXT = 'レート制限がかかっています。少し待ってから再試行してください。';

// ===== 状態 =====
let initialized = false;    // 初回ポーリング済みか(起動前の古いコマンドに返信しないため)
let lastHandledKey = null;  // 最後に処理したメッセージの識別キー(同じメッセージへの二重返信防止)
let lastBotPost = null;  // Botが最後に投稿した文章(自分の発言に反応しないため)
let lastRequestAt = 0;   // 最後にAPIを呼んだ時刻
let isBusy = false;      // API呼び出し中の二重実行防止

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
            reasoning_effort: 'low' // 思考を軽くして応答を速くする
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
    return text;
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
    if (!lastBotPost) return false;
    return mozi === lastBotPost || (mozi.length >= 20 && lastBotPost.startsWith(mozi));
}

// コマンドなら本文を返す("!ai"だけなら空文字、コマンドでなければnull)
function parseCommand(mozi) {
    const match = mozi.match(COMMAND_PATTERN);
    return match ? (match[1]?.trim() ?? '') : null;
}

// 直近のメッセージから「aiコマンドが付いている一番新しい投稿」を探す
// (コマンドなしの発言が同時に来ても、それに邪魔されない)
function findLatestCommand(msgs) {
    for (const msg of msgs) {
        const mozi = msg?.mozi?.trim();
        if (!mozi || isOwnMessage(mozi)) continue;

        const inputText = parseCommand(mozi);
        if (inputText !== null) {
            // メッセージ全体をキーにして、同じ文面の別投稿も区別する
            return { key: JSON.stringify(msg), mozi, inputText };
        }
    }
    return null;
}

async function handleCommand({ key, mozi, inputText }) {
    if (key === lastHandledKey || isBusy) return;
    if (Date.now() - lastRequestAt < MIN_REQUEST_INTERVAL_MS) return;

    console.log('コマンド検知:', mozi);
    lastHandledKey = key;
    lastRequestAt = Date.now();
    isBusy = true;

    try {
        // コマンドだけで本文がない → 使い方を返す
        if (!inputText) {
            console.log('使い方をPOST:', HELP_TEXT);
            lastBotPost = HELP_TEXT;
            await postMessage(HELP_TEXT);
            return;
        }

        const answer = await askGroq(inputText);
        console.log('Groqの生成テキスト:', answer);

        saveConversation(inputText, answer);
        lastBotPost = answer;
        await postMessage(answer);
    } catch (e) {
        console.error('エラー:', e);
        if (e.rateLimited) {
            lastBotPost = RATE_LIMIT_TEXT;
            await postMessage(RATE_LIMIT_TEXT).catch(console.error);
        }
    } finally {
        isBusy = false;
    }
}

async function poll() {
    try {
        const target = findLatestCommand(await fetchRecentMessages());

        // 初回は、すでにあるコマンドを「処理済み」にするだけで返信しない
        if (!initialized) {
            initialized = true;
            lastHandledKey = target?.key ?? null;
            return;
        }

        if (target) await handleCommand(target);
    } catch (e) {
        console.error('エラー:', e);
    }
}

setInterval(poll, POLL_INTERVAL_MS);
