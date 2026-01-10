/**
 * NAS100 Bot - 結構化日誌系統
 */

const pino = require('pino');

const isDev = process.env.NODE_ENV !== 'production';

// 主 Logger
const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: isDev ? {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname'
        }
    } : undefined
});

// 子 Logger - 交易相關
const tradeLogger = logger.child({ module: 'trade' });

// 子 Logger - API 連線
const apiLogger = logger.child({ module: 'api' });

// 子 Logger - 系統
const systemLogger = logger.child({ module: 'system' });

// 審計日誌 - 記錄所有交易操作
const auditLogger = logger.child({ module: 'audit' });

// 審計記錄函數
function logAudit(action, details = {}) {
    auditLogger.info({
        action,
        ...details,
        timestamp: new Date().toISOString()
    });
}

module.exports = {
    logger,
    tradeLogger,
    apiLogger,
    systemLogger,
    auditLogger,
    logAudit
};
