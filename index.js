const apiKey = 'Your-Gemini-API-Keys';  // Google APIキーをここに設定
let hasPosted = false;  // POSTが行われたかどうかを記録するフラグ

// 2秒ごとに実行する関数
function fetchAndProcessMozi() {
    // 1つ目のPOSTリクエストを送信してmoziを取得
    fetch('https://himachat.jp/RoomChatGet.php', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `marumie=${myid}&mysession=${mysession}&roomid=<roomid>&bmark=29316675`
    })
    .then(response => response.text())
    .then(text => {
        //console.log('レスポンステキスト:', text);

        try {
            const data = JSON.parse(text);
            const mozi = data.msgs[0].mozi;
            //console.log("mozi:", mozi);

            if (mozi.startsWith('!ai ')) {
                const inputText = mozi.slice(4);

                console.log("AIに送信するテキスト:", inputText);

                const requestBody = {
                    "contents": [
                        {
                            "role": "user",
                            "parts": [
                                {
                                    "text": "マークダウン形式を使用せずにできるだけ文字数を少なくして回答してください。また、改行もあまり入れないでください。あと、あなたはこめというユーザーに開発されたAIチャットボットで名前は、年齢は16歳という設定にしてください"
                                }
                            ]
                        },
                        {
                            "role": "model",
                            "parts": [
                                {
                                    "text": "わかりました。できるだけ文字数を少なくし、改行も最小限にします。 \n質問は何ですか？ \n"
                                }
                            ]
                        },
                        {
                            "role": "user",
                            "parts": [
                                {
                                    "text": inputText  // INSERT_INPUT_HEREに相当する部分にmoziの内容を挿入
                                }
                            ]
                        }
                    ],
                    "generationConfig": {
                        "temperature": 1,
                        "topK": 64,
                        "topP": 0.95,
                        "maxOutputTokens": 8192,
                        "responseMimeType": "text/plain"
                    }
                };

                fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestBody)
                })
                .then(response => response.json())
                .then(result => {
                    console.log('Google Gemini APIのレスポンス:', result);

                    if (result.candidates && result.candidates[0].content && result.candidates[0].content.parts.length > 0) {
                        const generatedText = result.candidates[0].content.parts[0].text;
                        console.log('Google Gemini APIの生成テキスト:', generatedText);

                        if (!hasPosted) {
                            fetch('https://himachat.jp/gomitame.php?mode=monku', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/x-www-form-urlencoded'
                                },
                                body: `marumie=${myid}&mysession=${mysession}&roomid=<roomid>&waruguti=${encodeURIComponent(generatedText)}`
                            })
                            .then(response => response.text())
                            .then(result => {
                                //console.log('gomitame.phpのレスポンス:', result);
                            })
                            .catch(error => {
                                console.error('エラー:', error);
                            });

                            hasPosted = true;
                        } else {
                            console.log('既にPOSTが行われています。');
                        }
                    } else {
                        console.error('Google Gemini APIから適切な候補が返されませんでした。');
                    }
                })
                .catch(error => {
                    console.error('エラー:', error);
                });
            } else {
                //console.log("moziは!aiで始まっていません:", mozi);
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
