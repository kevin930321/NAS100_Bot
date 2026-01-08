/**
 * NAS100 交易機器人設定檔
 * 支援從環境變數讀取設定，並提供預設值
 */

// 工具函數：從環境變數讀取數值，提供預設值
const getEnvNumber = (key, defaultValue) => {
    const value = process.env[key];
    return value ? parseFloat(value) : defaultValue;
};

const getEnvString = (key, defaultValue) => {
    return process.env[key] || defaultValue;
};

const getEnvBoolean = (key, defaultValue) => {
    const value = process.env[key];
    if (value === undefined) return defaultValue;
    return value === 'true' || value === '1';
};

module.exports = {
    // cTrader Open API 設定
    ctrader: {
        clientId: getEnvString('CTRADER_CLIENT_ID', ''),
        clientSecret: getEnvString('CTRADER_CLIENT_SECRET', ''),
        accessToken: getEnvString('CTRADER_ACCESS_TOKEN', ''),
        refreshToken: getEnvString('CTRADER_REFRESH_TOKEN', ''),

        // Demo or Live
        mode: getEnvString('CTRADER_MODE', 'demo'),
        accountId: getEnvString('CTRADER_ACCOUNT_ID', ''),

        // API Endpoints (更新於 2026-01: 使用 ctraderapi.com)
        host: getEnvString('CTRADER_MODE', 'demo') === 'demo'
            ? 'demo.ctraderapi.com'
            : 'live.ctraderapi.com',
        port: 5035  // Demo 和 Live 都使用 5035
    },

    // MongoDB 設定
    mongodb: {
        uri: getEnvString('MONGODB_URI', 'mongodb://localhost:27017/nas100-bot')
    },

    // 交易策略參數
    strategy: {
        entryOffset: getEnvNumber('ENTRY_OFFSET', 10),
        longTP: getEnvNumber('LONG_TP', 8),
        shortTP: getEnvNumber('SHORT_TP', 5),
        longSL: getEnvNumber('LONG_SL', 1000),
        shortSL: getEnvNumber('SHORT_SL', 1000),
        stopLoss: getEnvNumber('LONG_SL', 1000) // 保留相容性
    },

    // 帳戶設定
    account: {
        initialBalance: getEnvNumber('INITIAL_BALANCE', 300),
        baseLotSize: getEnvNumber('BASE_LOT_SIZE', 0.1)
    },

    // 市場時間設定 (CME Globex)
    market: {
        symbol: 'NAS100', // cTrader symbol name
        minsAfterOpen: 1,

        // 冬令時間 (UTC-5) -> 台北 07:00 開盤
        winter: {
            openHour: 7,
            openMinute: 0
        },
        // 夏令時間 (UTC-4) -> 台北 06:00 開盤
        summer: {
            openHour: 6,
            openMinute: 0
        }
    },

    // TradingView WebSocket (用於獲取開盤價)
    tradingView: {
        wsUrl: 'wss://data.tradingview.com/socket.io/websocket',
        symbol: 'PEPPERSTONE:NAS100'  // Pepperstone NAS100
    },

    // Discord 通知
    discord: {
        webhookUrl: getEnvString('DISCORD_WEBHOOK_URL', ''),
        enabled: getEnvBoolean('DISCORD_ENABLED', true)
    },

    // Server 設定
    server: {
        port: getEnvNumber('PORT', 3000)
    }
};

// 驗證必要設定
const requiredVars = [
    'CTRADER_CLIENT_ID',
    'CTRADER_CLIENT_SECRET',
    'CTRADER_ACCESS_TOKEN',
    'CTRADER_ACCOUNT_ID'
];

const missingVars = requiredVars.filter(key => !process.env[key]);

if (missingVars.length > 0) {
    console.error('❌ 設定錯誤：缺少以下環境變數:');
    missingVars.forEach(v => console.error(`   - ${v}`));
    console.error('請參考 .env.example 建立 .env 檔案');
    process.exit(1);
}
