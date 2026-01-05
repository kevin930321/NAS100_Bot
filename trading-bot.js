/**
 * NAS100 真實交易機器人 - cTrader 版本
 * 架構：cTrader Open API + ExecutionEngine + Express Dashboard
 */

// 載入環境變數（必須在最前面）
require('dotenv').config();

const cron = require('node-cron');
const https = require('https');
const express = require('express');
const path = require('path');

// 載入配置與模組
const config = require('./config');
const CTraderConnection = require('./CTraderConnection');
const ExecutionEngine = require('./ExecutionEngine');
const db = require('./db');

class TradingBot {
    constructor() {
        // cTrader 連線與交易引擎
        this.connection = null;
        this.engine = null;

        // 時間追蹤
        this.lastDate = null;
        this.lastResetDate = null;

        console.log('🤖 NAS100 真實交易機器人初始化...');
    }

    /**
     * 初始化機器人
     */
    async init() {
        try {
            // 1. 建立 cTrader 連線
            this.connection = new CTraderConnection(config);

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

            // 註：sendAccountAuth 會由上面的 listener 觸發，或在此手動觸發均可
            // 為求保險，這裡等待一下，但其實上面的 event handler 已經會處理

            // 3. 建立交易引擎
            this.engine = new ExecutionEngine(this.connection, config, db);
            await this.engine.initialize();

            // 4. 訂閱市場數據 (將改由 engine 監聽 account-auth-success 自動觸發)
            // await this.engine.subscribeToMarketData(); 

            // 5. 綁定事件
            this.bindEvents();

            console.log('✅ 機器人初始化完成');
            return true;
        } catch (error) {
            console.error('❌ 初始化失敗:', error);
            throw error;
        }
    }

    /**
     * 綁定事件監聽
     */
    bindEvents() {
        // 交易事件
        this.engine.on('trade-opened', (trade) => {
            const msg = `**${trade.type === 'long' ? '📈 做多' : '📉 做空'}** | 價格: ${trade.price} | TP: ${trade.tp} | SL: ${trade.sl}`;
            this.sendDiscord(msg);
        });

        // 平倉事件
        this.engine.on('trade-closed', (trade) => {
            const icon = trade.profit >= 0 ? '💰' : '💸';
            const typeStr = trade.type === 'long' ? '多單' : '空單';
            const msg = `${icon} **${typeStr}平倉** | 損益: $${trade.profit.toFixed(2)} | 餘額: $${trade.balance.toFixed(2)}`;
            this.sendDiscord(msg);
        });

        this.engine.on('trade-error', (error) => {
            this.sendDiscord(`❌ 交易錯誤: ${error.message}`);
        });

        // 連線事件
        this.connection.on('reconnect-failed', () => {
            this.sendDiscord('⚠️ cTrader 重連失敗，請檢查連線');
        });
    }

    /**
     * 啟動機器人
     */
    start() {
        console.log('🚀 交易機器人啟動');

        // 計算盯盤時間
        const target = this.getTargetWatchTime();
        const timeStr = `${target.hour}:${target.minute.toString().padStart(2, '0')}`;
        const seasonStr = target.isDst ? '夏令' : '冬令';

        const msg = `**NAS100 真實交易機器人已啟動**\n目前為美股 ${seasonStr}時間\n等待 **${timeStr}** 開始盯盤...`;
        console.log(msg.replace(/\*\*/g, ''));
        this.sendDiscord(msg);

        // 每分鐘檢查時間
        cron.schedule('* * * * *', () => {
            this.checkTime();
        });
    }

    /**
     * 取得盯盤時間
     */
    getTargetWatchTime() {
        const now = new Date();
        const isDst = this.isUsDst(now);
        const marketConfig = isDst ? config.market.summer : config.market.winter;

        const targetMinuteTotal = marketConfig.openMinute + config.market.minsAfterOpen;
        const targetHour = marketConfig.openHour + Math.floor(targetMinuteTotal / 60);
        const targetMinute = targetMinuteTotal % 60;

        return { hour: targetHour, minute: targetMinute, isDst };
    }

    /**
     * 檢查時間並執行動作
     */
    checkTime() {
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

        // 週末不處理
        if (dayOfWeek === 0 || dayOfWeek === 6) return;

        // 新交易日
        if (this.lastDate !== today) {
            this.lastDate = today;
            console.log(`📅 新交易日: ${today} (美股 ${isDst ? '夏令' : '冬令'}時間)`);
        }

        // 假日判斷已移至 ExecutionEngine.checkMarketStatus()
        // 由 cTrader API 動態取得假日資訊，無需手動維護

        // 每日重置（市場開盤時或之後首次運行）
        const marketConfig = isDst ? config.market.summer : config.market.winter;
        const isAfterOpen = hour > marketConfig.openHour || (hour === marketConfig.openHour && minute >= marketConfig.openMinute);

        if (isAfterOpen) {
            // 嘗試執行重置，Engine 內部會檢查是否已經做過
            if (this.engine) {
                // 如果本地變數還沒更新，就呼叫 Engine 嘗試重置
                if (this.lastResetDate !== today) {
                    this.resetDaily();
                    this.lastResetDate = today;
                }
            }
        }

        // 盯盤時間到了
        // 盯盤時間檢查 (時間到 OR 時間已過且尚未開始盯盤)
        const isWatchTime = hour === target.hour && minute === target.minute;
        const isAfterWatchTime = hour > target.hour || (hour === target.hour && minute > target.minute);

        if ((isWatchTime || isAfterWatchTime) && this.engine && !this.engine.todayTradeDone) {
            // 如果尚未開始盯盤，嘗試啟動
            if (!this.engine.isWatching) {
                // Log only once per minute to avoid spam, or rely on ExecutionEngine's internal checks
                // 如果是剛好時間到，發送 Discord
                if (isWatchTime) {
                    console.log(`⏰ ${target.hour}:${target.minute.toString().padStart(2, '0')} 觸發盯盤機制！`);
                    this.sendDiscord(`⏰ **觸發盯盤機制！** (${isDst ? '夏令' : '冬令'}時間 ${target.hour}:${target.minute.toString().padStart(2, '0')})`);
                }

                // 嘗試開始盯盤 (內部會去 fetch 開盤價，失敗則下次 checkTime 再試)
                this.engine.startWatching();
            }
        }
    }

    /**
     * 判斷美股夏令時間
     */
    isUsDst(date) {
        const year = date.getFullYear();
        let dstStart = new Date(year, 2, 1);
        while (dstStart.getDay() !== 0) dstStart.setDate(dstStart.getDate() + 1);
        dstStart.setDate(dstStart.getDate() + 7);

        let dstEnd = new Date(year, 10, 1);
        while (dstEnd.getDay() !== 0) dstEnd.setDate(dstEnd.getDate() + 1);

        const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const ds = new Date(dstStart.getFullYear(), dstStart.getMonth(), dstStart.getDate());
        const de = new Date(dstEnd.getFullYear(), dstEnd.getMonth(), dstEnd.getDate());

        return d >= ds && d < de;
    }

    /**
     * 判斷美股假日
     */
    isMajorUSHoliday(date) {
        const month = date.getMonth();
        const day = date.getDate();

        if (month === 0 && day === 1) return true; // 元旦
        if (month === 11 && day === 25) return true; // 聖誕節

        return false;
    }

    /**
     * 每日重置
     */
    async resetDaily() {
        if (this.engine) {
            await this.engine.resetDaily();
        }
    }

    /**
     * 發送 Discord 通知
     */
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

    /**
     * 取得狀態
     */
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
        res.set('WWW-Authenticate', 'Basic realm="NAS100 Dashboard"');
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
const logs = [];
const originalLog = console.log;
console.log = function (...args) {
    const msg = `[${new Date().toLocaleTimeString()}] ${args.join(' ')}`;
    logs.unshift(msg);
    if (logs.length > 50) logs.pop();
    originalLog.apply(console, args);
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

            case 'updateConfig':
                if (bot.engine && req.body.config) {
                    bot.engine.updateConfig(req.body.config);
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

// 啟動 Web Server
const PORT = config.server?.port || process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Web Dashboard 啟動於 http://localhost:${PORT}`);
});

module.exports = bot;
