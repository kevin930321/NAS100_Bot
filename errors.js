/**
 * NAS100 Bot - 自定義錯誤類別
 */

// 基礎交易機器人錯誤
class TradingBotError extends Error {
    constructor(message, code = 'UNKNOWN', details = {}) {
        super(message);
        this.name = 'TradingBotError';
        this.code = code;
        this.details = details;
        this.timestamp = new Date();
    }

    toJSON() {
        return {
            name: this.name,
            message: this.message,
            code: this.code,
            details: this.details,
            timestamp: this.timestamp
        };
    }
}

// 連線錯誤
class ConnectionError extends TradingBotError {
    constructor(message, details = {}) {
        super(message, 'CONNECTION_ERROR', details);
        this.name = 'ConnectionError';
    }
}

// 訂單錯誤
class OrderError extends TradingBotError {
    constructor(message, details = {}) {
        super(message, 'ORDER_ERROR', details);
        this.name = 'OrderError';
    }
}

// 市場數據錯誤
class MarketDataError extends TradingBotError {
    constructor(message, details = {}) {
        super(message, 'MARKET_DATA_ERROR', details);
        this.name = 'MarketDataError';
    }
}

// 配置錯誤
class ConfigError extends TradingBotError {
    constructor(message, details = {}) {
        super(message, 'CONFIG_ERROR', details);
        this.name = 'ConfigError';
    }
}

module.exports = {
    TradingBotError,
    ConnectionError,
    OrderError,
    MarketDataError,
    ConfigError
};
