/** US30 真實交易機器人 - cTrader Open API + ExecutionEngine + Express Dashboard */

require('dotenv').config();

const cron = require('node-cron');
const https = require('https');
const http = require('http');
const express = require('express');
const path = require('path');
const { Server } = require('socket.io');
// 載入配置與模組
const config = require('./config');
const CTraderConnection = require('./CTraderConnection');
const ExecutionEngine = require('./ExecutionEngine');
const db = require('./db');
const { isUsDst, rawToRealPrice } = require('./utils');
const TokenManager = require('./tokenManager');

class TradingBot {
    constructor() {
        this.connection = null;
        this.engine = null;
        this.tokenManager = null;
        this.io = null;
        this.lastDate = null;
        this.lastResetDate = null;
        console.log('🤖 US30 真實交易機器人初始化...');
    }

    /** 初始化機器人 */
    async init() {
        try {
            // 0. 啟動 Token 管理 (先同步檢查/刷新 Token)
            this.tokenManager = new TokenManager(config);
            await this.tokenManager.checkAndRefresh(); // 等待 Token 準備好
            this.tokenManager.startAutoRefresh();      // 再啟動背景自動更新

            // 1. 建立 cTrader 連線
            this.connection = new CTraderConnection(config, this.tokenManager);

            // 自動重連後的認證邏輯
            this.connection.on('app-auth-success', async () => {
                console.log('🔄 Application Auth 成功，正在進行 Account Auth...');
                try {
                    await this.connection.sendAccountAuth();
                } catch (error) {
                    console.error('❌ Account Auth 失敗:', error.message);
                }
            });

            await this.connection.connect();

            // 建立交易引擎
            this.engine = new ExecutionEngine(this.connection, config, db);
            await this.engine.initialize();

            this.lastResetDate = this.engine.lastResetDate;
            console.log(`📅 同步重置日期: ${this.lastResetDate || '無'}`);

            // 綁定事件
            this.bindEvents();

            console.log('✅ 機器人初始化完成');
            return true;
        } catch (error) {
            console.error('❌ 初始化失敗:', error);
            throw error;
        }
    }

    setupRiskApi() {
        // Simple API for Risk Agent to modify positions
        this.app.post('/api/risk/modify', express.json(), async (req, res) => {
            const { token, positionId, takeProfit, stopLoss } = req.body;

            // Simple security check
            if (token !== process.env.RISK_AGENT_TOKEN) {
                return res.status(403).json({ error: 'Unauthorized' });
            }

            if (!this.engine) {
                return res.status(503).json({ error: 'Engine not ready' });
            }

            try {
                console.log(`🛡️ Risk Agent requesting modification for Position ${positionId}...`);

                // If stopLoss is not provided, we need to fetch the current one or keep it same.
                // setPositionSlTp requires both. 
                // Let's find the position to get current SL if missing
                let currentSl = stopLoss;
                let currentTp = takeProfit;

                if (currentSl === undefined || currentTp === undefined) {
                    const positions = await this.engine.getOpenPositions();
                    // Handle Long/Integer position ID matching
                    const pos = positions.find(p => {
                        const pId = typeof p.positionId === 'object' ? p.positionId.toNumber() : parseInt(p.positionId);
                        return pId == positionId;
                    });

                    if (!pos) {
                        return res.status(404).json({ error: 'Position not found' });
                    }

                    if (currentSl === undefined) currentSl = pos.stopLoss; // Note: cTrader API might return raw price or relative? 
                    // Wait, getOpenPositions returns ProtoOAPosition which has stopLoss in raw format usually. 
                    // But setPositionSlTp expects Real Price.
                    // ExecutionEngine.js internal structure uses "positions" array with parsed data?
                    // Let's rely on the engine's internal list if possible, or force user to provide both.

                    // Actually, to be safe, Risk Agent should provide the explicit value it wants.
                    // But if Risk Agent only wants to change TP, it needs to know SL.
                    // For now, let's assume Risk Agent provides BOTH or we use the engine's cached positions.

                    const cachedPos = this.engine.positions.find(p => p.id == positionId);
                    if (cachedPos) {
                        // cachedPos doesn't store SL/TP in the lightweight list in ExecutionEngine.js constructor...
                        // It only stores: id, type, entryPrice, volume, openTime.
                        // So we MUST fetch from API or require input.
                    }
                }

                // If we still don't have SL, we can't call setPositionSlTp safely without querying.
                // Simplified: The Risk Agent MUST provide both TP and SL if it calls this.
                // Or we fetch it here. Let's fetch it here to be robust.
                if (currentSl === undefined) {
                    const positions = await this.engine.getOpenPositions();
                    const pos = positions.find(p => {
                        const pId = typeof p.positionId === 'object' ? p.positionId.toNumber() : parseInt(p.positionId);
                        return pId == positionId;
                    });
                    if (pos && pos.stopLoss) {
                        // ProtoOAPosition stopLoss is raw? Yes.
                        currentSl = rawToRealPrice(pos.stopLoss);
                    }
                }

                if (currentSl !== undefined && currentTp !== undefined) {
                    await this.engine.setPositionSlTp(positionId, currentSl, currentTp);
                    res.json({ success: true, message: 'Modification command sent' });
                } else {
                    res.status(400).json({ error: 'Missing SL or TP and could not fetch current values' });
                }

            } catch (error) {
                console.error('❌ Risk API Error:', error);
                res.status(500).json({ error: error.message });
            }
        });
    }

    /** 綁定事件監聽 */
    bindEvents() {
        this.engine.on('trade-opened', (trade) => {
            // Socket.IO 推送
            if (this.io) {
                this.io.emit('trade-opened', trade);
            }
        });

        // 平倉事件 - 每 100 次結算發送一次統計報告
        this.engine.on('trade-closed', (trade) => {
            // Socket.IO 推送
            if (this.io) {
                this.io.emit('trade-closed', trade);
            }

            // 每 10 次結算發送 Discord 統計報告
            const totalTrades = this.engine.wins + this.engine.losses;
            if (totalTrades > 0 && totalTrades % 10 === 0) {
                // 計算累計統計
                const totalWinRate = ((this.engine.wins / totalTrades) * 100).toFixed(1);
                const totalProfit = this.engine.trades.reduce((sum, t) => sum + (t.profit || 0), 0);

                // 計算本期區間統計 (最近 10 次)
                const periodWins = this.engine.wins - this.engine.lastReportWins;
                const periodLosses = this.engine.losses - this.engine.lastReportLosses;
                const periodTotal = periodWins + periodLosses;
                const periodWinRate = periodTotal > 0 ? ((periodWins / periodTotal) * 100).toFixed(1) : '0.0';
                const periodProfit = totalProfit - this.engine.lastReportProfit;

                // 計算區間範圍
                const fromTrade = totalTrades - 9;
                const toTrade = totalTrades;

                const msg = `📊 **第 ${fromTrade}-${toTrade} 次結算報告**\n` +
                    `✅ 本期勝率: ${periodWinRate}% (${periodWins}勝/${periodLosses}敗)\n` +
                    `💰 本期損益: $${periodProfit.toFixed(2)}\n` +
                    `📈 累計勝率: ${totalWinRate}% (${this.engine.wins}勝/${this.engine.losses}敗)\n` +
                    `💵 當前餘額: $${this.engine.balance?.toFixed(2) || '--'}`;
                this.sendDiscord(msg);

                // 更新追蹤變數供下次報告使用
                this.engine.lastReportWins = this.engine.wins;
                this.engine.lastReportLosses = this.engine.losses;
                this.engine.lastReportProfit = totalProfit;
            }
        });

        this.engine.on('trade-error', (error) => {
            this.sendDiscord(`❌ 交易錯誤: ${error.message}`);
        });

        // 連線事件
        this.connection.on('reconnect-failed', () => {
            this.sendDiscord('⚠️ cTrader 重連失敗，請檢查連線');
        });

        // === Socket.IO 即時推送事件 ===

        // 價格更新 (節流：最多每 500ms 推送一次)
        let lastPricePush = 0;
        this.engine.on('price-update', (data) => {
            if (this.io && Date.now() - lastPricePush >= 500) {
                lastPricePush = Date.now();
                // 附加即時帳戶資訊 (accountInfo.positions 已包含即時損益)
                const accountInfo = this.engine.calculateRealTimeAccountInfo();
                this.io.emit('realtime-update', {
                    ...data,
                    currentPrice: data.price,
                    ...accountInfo,
                    isWatching: this.engine.isWatching,
                    tradingPaused: this.engine.tradingPaused,
                    todayTradeDone: this.engine.todayTradeDone,
                    wins: this.engine.wins,
                    losses: this.engine.losses,
                    winRate: this.engine.wins + this.engine.losses > 0
                        ? ((this.engine.wins / (this.engine.wins + this.engine.losses)) * 100).toFixed(1) + '%'
                        : '--'
                });
            }
        });

        // 帳戶更新 (交易完成後)
        this.engine.on('account-update', (data) => {
            if (this.io) {
                this.io.emit('account-update', data);
            }
        });
        // 佈倉同步完成
        this.engine.on('positions-reconciled', (positions) => {
            if (this.io) {
                this.io.emit('positions-update', { positions });
            }
        });
    }

    /** 啟動機器人 */
    start() {
        console.log('🚀 交易機器人啟動');

        // 計算盯盤時間
        const target = this.getTargetWatchTime();
        const timeStr = `${target.hour}:${target.minute.toString().padStart(2, '0')}`;
        const seasonStr = target.isDst ? '夏令' : '冬令';

        console.log(`目前為美股 ${seasonStr}時間，等待 ${timeStr} 開始盯盤...`);

        // 每分鐘檢查時間
        cron.schedule('* * * * *', () => {
            this.checkTime();
        });
    }

    /** 取得盯盤時間 */
    getTargetWatchTime() {
        const now = new Date();
        const isDst = isUsDst(now);
        const marketConfig = isDst ? config.market.summer : config.market.winter;

        // 優先使用 engine 的動態設定，否則使用 config 預設值
        const minsAfterOpen = this.engine?.minsAfterOpen ?? config.market.minsAfterOpen;

        const targetMinuteTotal = marketConfig.openMinute + minsAfterOpen;
        const targetHour = marketConfig.openHour + Math.floor(targetMinuteTotal / 60);
        const targetMinute = targetMinuteTotal % 60;

        return { hour: targetHour, minute: targetMinute, isDst };
    }

    /** 檢查時間並執行動作 */
    async checkTime() {
        // --- 連線看門狗 (Connection Watchdog) ---
        // 防止週末維護導致斷線後，週一無法自動恢復
        if (this.connection && !this.connection.connected && !this.connection.reconnectTimeout) {
            console.log('🐕 看門狗偵測到連線中斷，嘗試復活...');
            this.connection.connect().catch(err => console.error('看門狗重連失敗:', err.message));
        }

        const target = this.getTargetWatchTime();
        const isDst = target.isDst;

        const taipeiTimeStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" });
        const taipeiTime = new Date(taipeiTimeStr);
        const hour = taipeiTime.getHours();
        const minute = taipeiTime.getMinutes();
        const today = taipeiTime.toDateString();
        const dayOfWeek = taipeiTime.getDay();

        // 週末處理：仍需檢查是否需要重置狀態，但不啟動盯盤
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        // 假日判斷已移至 ExecutionEngine.checkMarketStatus()
        // 由 cTrader API 動態取得假日資訊，無需手動維護

        // 判斷是否已過開盤時間
        const marketConfig = isDst ? config.market.summer : config.market.winter;
        const isAfterOpen = hour > marketConfig.openHour || (hour === marketConfig.openHour && minute >= marketConfig.openMinute);

        // 新交易日判斷：檢查日期是否變更
        // 即使是週末/假日，也需要重置 todayTradeDone 狀態
        if (this.lastResetDate !== today) {
            const seasonStr = isDst ? '夏令' : '冬令';

            // 取得市場狀態 (從 cTrader API)
            let marketStatusStr = isWeekend ? '週末' : '交易日';
            if (this.engine && this.connection?.connected) {
                try {
                    const status = await this.engine.checkMarketStatus();
                    if (!status.isOpen) {
                        marketStatusStr = status.reason; // 如: "假日: Martin Luther King Day"
                    }
                } catch (e) {
                    // 忽略錯誤，使用預設值
                }
            }

            console.log(`📅 新日期: ${today} (${marketStatusStr}, 美股${seasonStr})`);

            // 執行每日重置
            if (this.engine) {
                this.resetDaily();
                this.lastResetDate = today;

                // 非休市日才嘗試取得基準點
                if (!isWeekend) {
                    console.log('🔄 新交易日，嘗試取得今日基準點...');
                    this.engine.fetchAndSetOpenPrice();
                }
            }
        }

        // 盯盤時間到了
        // 只在精確的盯盤時間才觸發，不在之後的時間自動補觸發
        // 這樣可以防止重啟後自動開始盯盤
        const isWatchTime = hour === target.hour && minute === target.minute;

        // 週末不盯盤
        if (isWeekend) return;

        // 檢查市場是否開放 (假日等)
        if (isWatchTime && this.engine && !this.engine.todayTradeDone && !this.engine.isWatching) {
            // 先檢查市場狀態
            const marketStatus = await this.engine.checkMarketStatus();
            if (!marketStatus.isOpen) {
                console.log(`🚫 市場休市: ${marketStatus.reason}，跳過盯盤`);
                return;
            }

            console.log(`⏰ ${target.hour}:${target.minute.toString().padStart(2, '0')} 觸發盯盤機制！`);
            this.engine.startWatching();
        }
    }

    // isUsDst 已移至 utils.js
    // isMajorUSHoliday 已移除，假日判斷由 ExecutionEngine.checkMarketStatus() 透過 cTrader API 動態處理

    /** 每日重置 */
    async resetDaily() {
        if (this.engine) {
            await this.engine.resetDaily();
        }
    }

    /** 發送 Discord 通知 */
    sendDiscord(message) {
        if (!config.discord.webhookUrl || !config.discord.enabled) {
            return;
        }

        const url = new URL(config.discord.webhookUrl);
        const data = JSON.stringify({ content: message });

        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {
            if (res.statusCode !== 204) {
                console.error('Discord 通知失敗:', res.statusCode);
            }
        });

        req.on('error', (error) => {
            console.error('Discord 通知錯誤:', error.message);
        });

        req.write(data);
        req.end();
    }

    /** 取得狀態 */
    getStatus() {
        if (!this.engine) {
            return {
                connected: false,
                message: '引擎未初始化'
            };
        }

        return {
            connected: this.connection?.connected || false,
            authenticated: this.connection?.authenticated || false,
            ...this.engine.getStatus()
        };
    }
}

// 啟動機器人
const bot = new TradingBot();

(async () => {
    try {
        await bot.init();
        bot.start();
    } catch (error) {
        console.error('❌ 機器人啟動失敗:', error.message);
        process.exit(1);
    }
})();

// 定時狀態輸出 (使用即時帳戶餘額)
cron.schedule('0,30 * * * * *', async () => {
    const status = bot.getStatus();
    if (status.connected) {
        // 嘗試取得即時餘額
        let balance = status.balance;
        if (bot.engine && bot.connection?.connected && bot.connection?.authenticated) {
            try {
                const accountInfo = await bot.engine.getAccountInfo();
                if (accountInfo) {
                    balance = accountInfo.balance;
                }
            } catch (e) {
                // 忽略錯誤，使用原本的餘額
            }
        }
        console.log(`📊 狀態: 餘額=$${balance?.toFixed(2) || 0} | 勝率=${status.winRate} | 盯盤=${status.isWatching ? '是' : '否'} | 今日完成=${status.todayTradeDone ? '是' : '否'}`);
    }
});

// 訊號處理
process.on('SIGINT', () => {
    console.log('\n👋 機器人關閉中 (SIGINT)...');
    if (bot.connection) {
        bot.connection.disconnect();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 機器人關閉中 (SIGTERM)...');
    if (bot.connection) {
        bot.connection.disconnect();
    }
    process.exit(0);
});

// Express Web Dashboard
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Dashboard Basic Authentication
const DASHBOARD_USER = process.env.DASHBOARD_USERNAME || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASSWORD || '';

const basicAuth = (req, res, next) => {
    // 跳過健康檢查端點 (給 UptimeRobot 用)
    if (req.path === '/health') return next();

    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.set('WWW-Authenticate', 'Basic realm="US30 Dashboard"');
        return res.status(401).send('需要登入');
    }

    const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    const [user, pass] = credentials;

    if (user === DASHBOARD_USER && pass === DASHBOARD_PASS) {
        return next();
    }

    res.set('WWW-Authenticate', 'Basic realm="NAS100 Dashboard"');
    return res.status(401).send('帳號或密碼錯誤');
};

// 如果有設定密碼，則啟用認證
if (DASHBOARD_PASS) {
    app.use(basicAuth);
    console.log('🔐 Dashboard 已啟用密碼保護');
} else {
    console.warn('⚠️ Dashboard 未設定密碼，建議設定 DASHBOARD_PASSWORD 環境變數');
}

// 日誌系統
const MAX_LOGS = 100;  // 日誌最大保留數量
const logs = [];
const originalLog = console.log;
console.log = function (...args) {
    const taipeiTime = new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    const msg = `[${taipeiTime}] ${args.join(' ')}`;
    logs.unshift(msg);
    if (logs.length > MAX_LOGS) logs.pop();
    originalLog.apply(console, args);

    // 透過 Socket.IO 即時推送新日誌
    if (bot.io) {
        bot.io.emit('new-log', msg);
    }
};

// 健康檢查端點（給 UptimeRobot）
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        connected: bot.connection?.connected || false,
        timestamp: new Date().toISOString()
    });
});

// 狀態 API (異步，取得即時帳戶餘額)
app.get('/api/status', async (req, res) => {
    try {
        const status = bot.getStatus();

        // 嘗試取得即時帳戶餘額
        if (bot.engine && bot.connection?.connected) {
            try {
                const accountInfo = await bot.engine.getAccountInfo();
                if (accountInfo) {
                    status.balance = accountInfo.balance;
                    status.equity = accountInfo.equity;
                    status.usedMargin = accountInfo.usedMargin;
                    status.freeMargin = accountInfo.freeMargin;
                    status.unrealizedPnL = accountInfo.unrealizedPnL;
                    status.leverage = accountInfo.leverage;
                }
            } catch (e) {
                // 忽略錯誤，使用原本的餘額
            }
        }

        res.json({
            ...status,
            logs: logs
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 操作 API
app.post('/api/action', async (req, res) => {
    const { action } = req.body;
    console.log(`收到操作請求: ${action}`);

    try {
        switch (action) {
            case 'reset':
                await bot.resetDaily();
                break;

            case 'toggleWatch':
                if (bot.engine) {
                    bot.engine.isWatching = !bot.engine.isWatching;
                }
                break;

            case 'closePositions':
                if (bot.engine) {
                    await bot.engine.closeAllPositions();
                }
                break;

            case 'closePosition':
                if (bot.engine && req.body.positionId) {
                    await bot.engine.closePosition(req.body.positionId);
                }
                break;

            case 'updateConfig':
                if (bot.engine && req.body.config) {
                    bot.engine.updateConfig(req.body.config);
                }
                break;

            case 'togglePause':
                if (bot.engine) {
                    bot.engine.tradingPaused = !bot.engine.tradingPaused;
                    console.log(`⏸️ 交易${bot.engine.tradingPaused ? '已暫停' : '已繼續'}`);
                }
                break;

            case 'fetchOpenPrice':
                if (bot.engine) {
                    const success = await bot.engine.fetchAndSetOpenPrice();
                    if (!success) {
                        return res.json({ success: false, message: '無法取得基準點', state: bot.getStatus() });
                    }
                }
                break;
        }
        res.json({ success: true, state: bot.getStatus() });
    } catch (e) {
        console.error('API Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// 首頁
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// 啟動 Web Server (使用 http.createServer 以便綁定 Socket.IO)
const PORT = config.server?.port || process.env.PORT || 3000;
const server = http.createServer(app);

// 初始化 Socket.IO
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// 將 io 和 app 注入到 bot
bot.io = io;
bot.app = app;

// 初始化 Risk Management API (必須在 bot.app 設定後)
bot.setupRiskApi();

// Socket.IO 連線處理
io.on('connection', (socket) => {
    console.log('🔌 Dashboard 客戶端已連線');

    // 連線時立即推送當前狀態
    const status = bot.getStatus();
    if (bot.engine) {
        const accountInfo = bot.engine.calculateRealTimeAccountInfo();
        socket.emit('initial-state', {
            ...status,
            ...accountInfo
        });
    }

    socket.on('disconnect', () => {
        console.log('🔌 Dashboard 客戶端已斷開');
    });
});

server.listen(PORT, () => {
    console.log(`🌐 Web Dashboard 啟動於 http://localhost:${PORT}`);
    console.log(`🔌 Socket.IO 即時推送已啟用`);
});

module.exports = bot;
