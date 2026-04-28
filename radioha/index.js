const http = require('http');
const https = require('https');
const child_process = require("child_process");
const fs = require('fs');
const axios = require('axios');
const path = require('path');

const port = 3005;
const OPTIONS_FILE = '/data/options.json';
let mytoken = 'homeassistant';
let publicIP = '';

// 팟캐스트 캐시
let podcastCache = [];
let lastPodcastUpdate = 0;
const PODCAST_CACHE_TTL = 600000; // 10분

async function fetchPodcastList() {
    const now = Date.now();
    if (podcastCache.length > 0 && now - lastPodcastUpdate < PODCAST_CACHE_TTL) {
        return podcastCache;
    }
    try {
        const response = await axios.get(
            'https://itunes.apple.com/lookup?id=437788220&media=podcast&entity=podcastEpisode&limit=20&country=kr',
            { headers: { 'User-Agent': FULL_UA }, timeout: 8000 }
        );
        const items = response.data.results.filter(r => r.wrapperType === 'podcastEpisode');
        const parsed = items.slice(0, 20).map(item => ({
            title: (item.trackName || '').substring(0, 40),
            url: item.episodeUrl || ''
            desc: (item.description || '').substring(0, 100)  // 추가
        })).filter(ep => ep.url !== '');
        if (parsed.length > 0) {
            podcastCache = parsed;
            lastPodcastUpdate = now;
            console.log(`[Podcast] ${podcastCache.length}개 에피소드 캐시 완료`);
        }
    } catch(e) {
        console.error('[Podcast] iTunes API 실패:', e.message);
    }
    return podcastCache;
}

// 서버 시작 시 미리 캐시
fetchPodcastList();

async function updatePublicIP() {
    try {
        const response = await axios.get('https://api.ipify.org?format=json', { timeout: 3000 });
        publicIP = response.data.ip;
        console.log(`[Network] 현재 공인 IP: ${publicIP}`);
    } catch (e) {
        console.error("[Network] 공인 IP를 가져오지 못했습니다.");
    }
}
updatePublicIP();
setInterval(updatePublicIP, 3600000);
setInterval(fetchPodcastList, PODCAST_CACHE_TTL);

try {
    if (fs.existsSync(OPTIONS_FILE)) {
        const options = JSON.parse(fs.readFileSync(OPTIONS_FILE, 'utf8'));
        if (options.token) {
            mytoken = options.token;
            console.log(`[Config] 토큰이 사용자 정의 값으로 설정되었습니다.`);
        }
    }
} catch (err) {
    console.error(`[Config] 옵션 파일 로드 실패:`, err);
}

const instance = axios.create({ timeout: 3000 });
const bitrateMap = { "0": 192, "1": 128, "2": 96 };

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
console.log("[HA API] SUPERVISOR_TOKEN 존재 여부:", !!SUPERVISOR_TOKEN);
const hassInstance = axios.create({
    baseURL: 'http://supervisor/core/api',
    headers: {
        'Authorization': `Bearer ${SUPERVISOR_TOKEN}`,
        'Content-Type': 'application/json'
    },
    timeout: 5000
});

const FULL_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function setSecurityHeaders(resp) {
    resp.setHeader('X-Content-Type-Options', 'nosniff');
    resp.setHeader('X-Frame-Options', 'SAMEORIGIN');
    resp.setHeader('X-XSS-Protection', '1; mode=block');
    resp.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    resp.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self';");
}

function validateParam(param, type) {
    if (!param) return false;
    const patterns = {
        'token': /^[a-zA-Z0-9_-]+$/,
        'key': /^[a-z0-9_]+$/,
        'entity_id': /^media_player\.[a-z0-9_]+$/,
        'action': /^(media_play|media_pause|media_stop|media_play_pause)$/,
        'volume': /^0(\.\d+)?|1(\.0)?$/
    };
    return patterns[type] ? patterns[type].test(param) : true;
}

function escapeHtml(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[&<>"']/g, function (m) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
}

function isLocalRequest(req) {
    let clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (clientIP.includes(',')) clientIP = clientIP.split(',')[0].trim();
    if (clientIP.startsWith('::ffff:')) clientIP = clientIP.split('::ffff:')[1];
    const isPrivate = clientIP === '127.0.0.1' || clientIP === '::1' ||
        clientIP.startsWith('192.168.') || clientIP.startsWith('10.') ||
        clientIP.startsWith('172.16.') || clientIP.startsWith('172.17.') ||
        clientIP.startsWith('172.18.') || clientIP.startsWith('172.19.') ||
        clientIP.startsWith('172.2') || clientIP.startsWith('172.3');
    const isPublicMatch = publicIP && clientIP === publicIP;
    return isPrivate || isPublicMatch;
}

function getRadioData() {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'radio-list.json'), 'utf8'));
    } catch (e) {
        console.error("데이터 로딩 실패:", e);
        return {};
    }
}

function getkbs(param) {
    return new Promise((resolve) => {
        let kbs_ch = { 'kbs_1radio': '21', 'kbs_3radio': '23', 'kbs_classic': '24', 'kbs_cool': '25', 'kbs_happy': '22' };
        instance.get('https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/' + kbs_ch[param], {
            headers: { 'User-Agent': FULL_UA, 'Referer': 'https://onair.kbs.co.kr/' }
        }).then(response => {
            const kbs_src = response.data.channel_item;
            let media_src = "invalid";
            for (let i = 0; i < kbs_src.length; i++) {
                if (kbs_src[i].media_type == 'radio') { media_src = kbs_src[i].service_url; break; }
            }
            resolve(media_src);
        }).catch(() => resolve("invalid"));
    });
}

function getmbc(ch) {
    return new Promise(function (resolve, reject) {
        try {
            let mbc_ch = { 'mbc_fm4u': 'mfm', 'mbc_fm': 'sfm' };
            instance({
                method: 'get',
                url: 'https://sminiplay.imbc.com/aacplay.ashx?agent=webapp&channel=' + mbc_ch[ch] + '&callback=jarvis.miniInfo.loadOnAirComplete',
                headers: {
                    'User-Agent': FULL_UA, 'Referer': 'https://mini.imbc.com/',
                    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Accept-Encoding': 'gzip, deflate'
                }
            }).then(response => {
                var text = 'https://' + response.data.split('"https://')[1].split('"')[0];
                resolve(text);
            }).catch(e => { console.log(e); resolve("invalid"); })
        } catch { resolve("invalid"); }
    })
}

function getsbs(ch) {
    return new Promise((resolve) => {
        let sbs_ch = { 'sbs_power': ['powerfm', 'powerpc'], 'sbs_love': ['lovefm', 'lovepc'] };
        if (!sbs_ch[ch]) return resolve("invalid");
        instance.get(`https://apis.sbs.co.kr/play-api/1.0/livestream/${sbs_ch[ch][1]}/${sbs_ch[ch][0]}?protocol=hls&ssl=Y`, {
            headers: { 'User-Agent': FULL_UA, 'Referer': 'https://gorealraplayer.radio.sbs.co.kr/' }
        }).then(response => resolve(response.data)).catch(() => resolve("invalid"));
    });
}

function return_pipe(urls, resp, req, key, fixedBitrate) {
    const baseURL = `http://${req.headers.host || 'localhost'}`;
    const myUrl = new URL(req.url, baseURL);
    const urlParams = myUrl.searchParams;
    let bitrateRaw = urlParams.get("atype") || "1";
    const bitrate = fixedBitrate || bitrateMap[bitrateRaw] || 128;

    let headerStr = `User-Agent: ${FULL_UA}\r\n`;
    if (key === 'obs') headerStr += `Referer: https://www.obs.co.kr/\r\n`;

    const ffmpegArgs = [
        "-headers", headerStr,
        "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "3",
        "-loglevel", "error", "-i", urls,
        "-c:a", "mp3", "-b:a", `${bitrate}k`, "-ac", "2",
        "-bufsize", "256K", "-f", "mp3", "pipe:1"
    ];

    console.log(`[Smart Engine] ${key} - ${bitrate}k (Buffer: 256K)`);

    resp.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });

    const xffmpeg = child_process.spawn("ffmpeg", ffmpegArgs, { detached: false });
    xffmpeg.stdout.pipe(resp);
    const cleanup = () => { if (xffmpeg) xffmpeg.kill(); };
    req.on("close", cleanup);
    req.on("end", cleanup);
}

async function getHostIP() {
    try {
        const response = await axios.get('http://supervisor/network/info', {
            headers: { 'Authorization': `Bearer ${SUPERVISOR_TOKEN}` }, timeout: 2000
        });
        const interfaces = response.data.data.interfaces;
        for (const iface of interfaces) {
            if (iface.enabled && iface.ipv4 && iface.ipv4.address.length > 0) {
                for (const addr of iface.ipv4.address) {
                    const ip = addr.split('/')[0];
                    if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.')) return ip;
                }
            }
        }
        for (const iface of interfaces) {
            if (iface.enabled && iface.ipv4 && iface.ipv4.address.length > 0) {
                const ip = iface.ipv4.address[0].split('/')[0];
                if (!ip.startsWith('127.') && !ip.startsWith('172.30.')) return ip;
            }
        }
    } catch (e) {
        console.error("[Network] Supervisor API에서 IP 정보를 가져오지 못했습니다:", e.message);
    }
    return null;
}

const liveServer = http.createServer(async (req, resp) => {
    const baseURL = `http://${req.headers.host || 'localhost'}`;
    const myUrl = new URL(req.url, baseURL);
    const urlParams = myUrl.searchParams;
    const urlPath = myUrl.pathname;
    const isLocal = isLocalRequest(req);

    if (urlPath === "/" && !isLocal) setSecurityHeaders(resp);

    // 라디오 스트리밍
    if (urlPath === "/radio") {
        if (urlParams.get('token') === mytoken) {
            const key = urlParams.get('keys');
            if (!validateParam(key, 'key')) { resp.statusCode = 400; return resp.end("Bad Request"); }
            const currentData = getRadioData();
            const station = currentData[key];
            if (station) {
                const myData = (typeof station === 'string') ? station : station.url;
                if (myData === "kbs_lib") {
                    getkbs(key).then(data => data !== "invalid" ? return_pipe(data, resp, req, key) : resp.end("Error"));
                } else if (myData === "mbc_lib") {
                    getmbc(key).then(data => data !== "invalid" ? return_pipe(data, resp, req, key) : resp.end("Error"));
                } else if (myData === "sbs_lib") {
                    getsbs(key).then(data => data !== "invalid" ? return_pipe(data, resp, req, key) : resp.end("Error"));
                } else {
                    return_pipe(myData, resp, req, key);
                }
            } else { resp.statusCode = 404; resp.end("Not Found"); }
        } else { resp.statusCode = 403; resp.end("Forbidden"); }
        return;
    }

    // 팟캐스트 목록 (JSON)
    if (urlPath === "/podcast/list") {
        if (urlParams.get('token') === mytoken) {
            const list = await fetchPodcastList();
            resp.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            resp.end(JSON.stringify(list));
        } else { resp.statusCode = 403; resp.end("Forbidden"); }
        return;
    }

    // 팟캐스트 재생 (ffmpeg 변환)
    if (urlPath === "/podcast/play") {
        if (urlParams.get('token') === mytoken) {
            const list = await fetchPodcastList();
            const idx = parseInt(urlParams.get('idx') || '0');
            if (idx >= 0 && idx < list.length && list[idx].url) {
                console.log(`[Podcast] Playing idx=${idx}: ${list[idx].title}`);
                return_pipe(list[idx].url, resp, req, 'podcast', 128);
            } else { resp.statusCode = 404; resp.end("Not Found"); }
        } else { resp.statusCode = 403; resp.end("Forbidden"); }
        return;
    }

    if (urlPath === "/") {
        resp.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const currentData = getRadioData();
        const sortedKeys = Object.keys(currentData).sort((a, b) => {
            const freqA = (typeof currentData[a] === 'object') ? currentData[a].freq : 999;
            const freqB = (typeof currentData[b] === 'object') ? currentData[b].freq : 999;
            return freqA - freqB;
        });
        const radioButtons = sortedKeys.map(key => {
            const info = currentData[key];
            const name = escapeHtml((typeof info === 'object') ? info.name : key.toUpperCase());
            const freq = (typeof info === 'object') ? info.freq + ' MHz' : '';
            return `<button class="radio-btn" onclick="playRadio('${escapeHtml(key)}')">
                        <div class="btn-name">${name}</div>
                        <div class="btn-freq">${freq}</div>
                    </button>`;
        }).join('');
        try {
            let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
            const configScript = `<script>const API_CONFIG = { token: "${mytoken}", isLocal: ${isLocal} };</script>`;
            html = html.replace('</head>', `${configScript}\n</head>`);
            html = html.replace(/{{RADIO_BUTTONS}}/g, radioButtons);
            html = html.replace(/{{MY_TOKEN}}/g, 'API_CONFIG.token');
            resp.end(html);
        } catch (e) { resp.end("Internal Server Error"); }
        return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        let postData = {};
        if (req.method === 'POST' && body) {
            try { postData = JSON.parse(body); } catch (e) { console.error("[API] Body Parse Error"); }
        }
        const getParam = (name) => postData[name] || urlParams.get(name);
        const token = getParam('token');
        const isAuthorized = token === mytoken;

        if (urlPath === "/get_players") {
            if (isAuthorized) {
                if (!isLocal) return resp.end(JSON.stringify([]));
                hassInstance.get('/states').then(r => {
                    const players = r.data.filter(s => s.entity_id.startsWith('media_player.'))
                        .map(s => ({ name: s.attributes.friendly_name || s.entity_id, id: s.entity_id }));
                    resp.writeHead(200, { 'Content-Type': 'application/json' });
                    resp.end(JSON.stringify(players));
                }).catch(() => resp.end("[]"));
            } else { resp.statusCode = 403; resp.end("Forbidden"); }
            return;
        }

        if (urlPath === "/play_on_player") {
            if (isAuthorized) {
                if (!isLocal) { resp.statusCode = 403; return resp.end("Forbidden: Local Network Only"); }
                const entity_id = getParam('entity_id');
                const keys = getParam('keys');
                const atype = getParam('atype') || '1';
                if (!validateParam(entity_id, 'entity_id') || !validateParam(keys, 'key')) {
                    resp.statusCode = 400; return resp.end("Bad Request");
                }
                const hostIp = await getHostIP();
                let finalHost = hostIp || req.headers.host.split(':')[0];
                finalHost = `${finalHost}:${port}`;
                const streamUrl = `http://${finalHost}/radio?token=${mytoken}&keys=${keys}&atype=${atype}`;
                hassInstance.post('/services/media_player/play_media', {
                    entity_id, media_content_id: streamUrl, media_content_type: 'music'
                }).then(() => resp.end("Success")).catch(() => (resp.statusCode = 500, resp.end("Error")));
            } else { resp.statusCode = 403; resp.end("Forbidden"); }
            return;
        }

        if (urlPath === "/media_action") {
            if (isAuthorized) {
                if (!isLocal) { resp.statusCode = 403; return resp.end("Forbidden: Local Network Only"); }
                const entity_id = getParam('entity_id');
                const action = getParam('action');
                if (!validateParam(entity_id, 'entity_id') || !validateParam(action, 'action')) {
                    resp.statusCode = 400; return resp.end("Bad Request");
                }
                hassInstance.post(`/services/media_player/${action}`, { entity_id })
                    .then(() => resp.end("Success")).catch(() => (resp.statusCode = 500, resp.end("Error")));
            } else { resp.statusCode = 403; resp.end("Forbidden"); }
            return;
        }

        if (urlPath === "/set_volume") {
            if (isAuthorized) {
                if (!isLocal) { resp.statusCode = 403; return resp.end("Forbidden: Local Network Only"); }
                const entity_id = getParam('entity_id');
                const volume = getParam('volume');
                if (!validateParam(entity_id, 'entity_id') || !validateParam(volume, 'volume')) {
                    resp.statusCode = 400; return resp.end("Bad Request");
                }
                hassInstance.post('/services/media_player/volume_set', {
                    entity_id, volume_level: parseFloat(volume)
                }).then(() => resp.end("Success")).catch(() => (resp.statusCode = 500, resp.end("Error")));
            } else { resp.statusCode = 403; resp.end("Forbidden"); }
            return;
        }

        if (urlPath === "/mute_volume") {
            if (isAuthorized) {
                if (!isLocal) { resp.statusCode = 403; return resp.end("Forbidden: Local Network Only"); }
                const entity_id = getParam('entity_id');
                const mute = getParam('mute') === 'true' || getParam('mute') === true;
                if (!validateParam(entity_id, 'entity_id')) { resp.statusCode = 400; return resp.end("Bad Request"); }
                hassInstance.post('/services/media_player/volume_mute', {
                    entity_id, is_volume_muted: mute
                }).then(() => resp.end("Success")).catch(() => (resp.statusCode = 500, resp.end("Error")));
            } else { resp.statusCode = 403; resp.end("Forbidden"); }
            return;
        }

        resp.statusCode = 404;
        resp.end("Not Found");
    });
});

liveServer.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
});
