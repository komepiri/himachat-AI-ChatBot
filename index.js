const roomid = 'YOUR_ROOM_ID'
const apiKey = 'YOUR_GEMINI_API_KEYS';  // Google APIキーをここに設定
let hasPosted = false;  // POSTが行われたかどうかを記録するフラグ

// systemInstructionの設定
const systemInstruction = {
    role: "user",
    parts: [
        {
            text: "マークダウン形式を使用せずにできるだけ文字数を少なくして回答してください。また、改行もあまり入れないでください。あと、あなたはGoogle Gemini APIを使って開発されたAIチャットボットです。"
        }
    ]
};

// 会話履歴を保存する関数
function saveConversation(inputText, responseText) {
    let conversationLog = JSON.parse(localStorage.getItem('conversationLog')) || [];
    conversationLog.push({
        input: inputText,
        response: responseText
    });
    localStorage.setItem('conversationLog', JSON.stringify(conversationLog));
}

// 会話履歴を使ってリクエストボディを生成する関数
function buildConversationHistory(inputText) {
    let conversationLog = JSON.parse(localStorage.getItem('conversationLog')) || [];
    let contents = [];

    // 過去の会話内容を整形
    conversationLog.forEach(entry => {
        contents.push({
            role: "user",
            parts: [{ text: entry.input }]
        });
        contents.push({
            role: "model",
            parts: [{ text: entry.response }]
        });
    });

    // 今回の入力を追加
    contents.push({
        role: "user",
        parts: [{ text: inputText }]
    });

    // Gemini APIに渡すリクエストボディ
    const requestBody = {
        contents: contents,
        systemInstruction: systemInstruction,
        generationConfig: {
            temperature: 1,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 8192,
            responseMimeType: "text/plain"
        }
    };

    return requestBody;
}

// 2秒ごとに実行する関数
function fetchAndProcessMozi() {
    fetch('https://himachat.jp/RoomChatGet.php', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `marumie=${myid}&mysession=${mysession}&roomid=${roomid}&bmark=29316675`
    })
    .then(response => response.text())
    .then(text => {
        try {
            const data = JSON.parse(text);
            const mozi = data.msgs[0].mozi;

            if (mozi === '!ai') {
                const predefinedText = "!aiのあとに空白を入れてその後に適当な文章を入力してください。また、会話内容の記録はめんどくさすぎてやってません。なので会話内容の記録が必要な会話はしないでください。";

                console.log("事前定義されたテキストをPOST:", predefinedText);

                if (!hasPosted) {
                    fetch('https://himachat.jp/gomitame.php?mode=monku', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded'
                        },
                        body: `marumie=${myid}&mysession=${mysession}&roomid=${roomid}&waruguti=${encodeURIComponent(predefinedText)}`
                    })
                    .then(response => response.text())
                    .then(result => {
                        //console.log('gomitame.phpのレスポンス:', result);
                    })
                    .catch(error => {
                        console.error('エラー:', error);
                    });

                    hasPosted = true;
                }
            } else if (mozi.startsWith('!ai ')) {
                const inputText = mozi.slice(4);

                // 会話履歴を含むリクエストボディを生成
                const requestBody = buildConversationHistory(inputText);

                fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestBody)
                })
                .then(response => {
                    if (response.status === 429) {
                        const rateLimitMessage = "レート制限がかかっています。少し待ってから再試行してください。";
                        console.log('レート制限のメッセージをPOST:', rateLimitMessage);

                        fetch('https://himachat.jp/gomitame.php?mode=monku', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded'
                            },
                            body: `marumie=${myid}&mysession=${mysession}&roomid=${roomid}&waruguti=${encodeURIComponent(rateLimitMessage)}`
                        })
                        .then(response => response.text())
                        .then(result => {
                            //console.log('gomitame.phpのレスポンス:', result);
                        })
                        .catch(error => {
                            console.error('エラー:', error);
                        });

                        throw new Error('HTTP 429: レート制限エラー');
                    }
                    return response.json();
                })
                .then(result => {
                    if (result.candidates && result.candidates[0].content && result.candidates[0].content.parts.length > 0) {
                        const generatedText = result.candidates[0].content.parts[0].text.trim();
                        console.log('Google Gemini APIの生成テキスト:', generatedText);

                        // 会話履歴に保存
                        saveConversation(inputText, generatedText);

                        if (!hasPosted) {
                            fetch('https://himachat.jp/gomitame.php?mode=monku', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/x-www-form-urlencoded'
                                },
                                body: `marumie=${myid}&mysession=${mysession}&roomid=${roomid}&waruguti=${encodeURIComponent(generatedText)}`
                            })
                            .then(response => response.text())
                            .then(result => {
                                //console.log('gomitame.phpのレスポンス:', result);
                            })
                            .catch(error => {
                                console.error('エラー:', error);
                            });

                            hasPosted = true;
                        }
                    } else {
                        console.error('Google Gemini APIから適切な候補が返されませんでした。');
                    }
                })
                .catch(error => {
                    console.error('エラー:', error);
                });
            } else {
                hasPosted = false;
            }
        } catch (e) {
            console.error("JSONのパースに失敗しました:", e);
        }
    })
    .catch(error => {
        console.error('エラー:', error);
    });
}

// 2秒間隔でfetchAndProcessMoziを実行
setInterval(fetchAndProcessMozi, 2000);
