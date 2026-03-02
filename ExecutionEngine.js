/**
 * ExecutionEngine - 交易執行引擎
 * 策略邏輯執行、持倉管理、cTrader API 整合
 */

const EventEmitter = require('events');
const { convertLongValue, rawToRealPrice, realToRawPrice, getTaipeiTime, isUsDst, API_PRICE_MULTIPLIER, TAIPEI_OFFSET_MS } = require('./utils');
const { tradeLogger, logAudit } = require('./logger');
const { OrderError, MarketDataError } = require('./errors');

const PNL_DIVISOR = 10000;
const VOLUME_DIVISOR = 100;
const MONEY_DIGITS_DEFAULT = 2;
const TRADE_HISTORY_MAX = 50;
const SYMBOL_CACHE_TTL = 3600000;
const ACCOUNT_CACHE_TTL = 300000;

class ExecutionEngine extends EventEmitter {
    constructor(connection, config, db) {
        super();

        this.connection = connection;
        this.config = config;
        this.db = db;

        // 策略參數
        this.entryOffset = config.strategy.entryOffset;
        this.longTP = config.strategy.longTP;
        this.shortTP = config.strategy.shortTP;
        this.longSL = config.strategy.longSL;
        this.shortSL = config.strategy.shortSL;
        this.lotSize = config.account.baseLotSize;
        this.minsAfterOpen = config.market.minsAfterOpen || 1;
        this.baselineOffsetMinutes = config.market.baselineOffsetMinutes || 0;

        // 狀態追蹤
        this.balance = null;
        this.positions = [];
        this.todayTradeDone = false;
        this.todayOpenPrice = null;
        this.currentPrice = null;
        this.isWatching = false;
        this.isPlacingOrder = false;
        this.tradingPaused = false;
        this.orderFailureCount = 0;

        // 統計
        this.wins = 0;
        this.losses = 0;
        this.trades = [];
        this.lastReportWins = 0;
        this.lastReportLosses = 0;
        this.lastReportProfit = 0;

        this.symbolInfoCache = {};
        this.closedPositionIds = new Set(); // 去重：防止同一筆平倉被重複計算勝負

        this.connection.on('message', this.handleMarketData.bind(this));
        this.connection.on('account-auth-success', () => {
            console.log('🔄 Account Auth 成功，重新訂閱報價並同步持倉...');
            this.subscribeToMarketData();
            this.reconcilePositions();
        });
    }

    getMarketConfig(date = new Date()) {
        const isDst = isUsDst(date);
        return isDst ? this.config.market.summer : this.config.market.winter;
    }


    /** 初始化：從資料庫載入狀態 */
    async initialize() {
        try {
            const state = await this.db.loadState();
            if (state) {
                this.wins = state.wins || 0;
                this.losses = state.losses || 0;
                this.trades = state.trades || [];
                this.todayTradeDone = state.todayTradeDone || false;
                this.lastResetDate = state.lastResetDate || null; // 恢復重置日期
                if (state.config) {
                    this.entryOffset = state.config.entryOffset || this.entryOffset;
                    this.longTP = state.config.longTP || this.longTP;
                    this.shortTP = state.config.shortTP || this.shortTP;
                    this.longSL = state.config.longSL || this.longSL;
                    this.shortSL = state.config.shortSL || this.shortSL;
                    this.lotSize = state.config.lotSize || this.lotSize;
                    if (state.config.minsAfterOpen !== undefined) this.minsAfterOpen = state.config.minsAfterOpen;
                    if (state.config.baselineOffsetMinutes !== undefined) this.baselineOffsetMinutes = state.config.baselineOffsetMinutes;
                    console.log('⚙️ 策略參數已從資料庫恢復');
                }

                console.log('✅ 狀態已從資料庫載入');
            }

            // 狀態對賬：詢問 cTrader 實際持倉
            await this.reconcilePositions();

            this.isWatching = false;
            this.todayOpenPrice = null;
            console.log('⏳ 等待盯盤訊號 (cron 觸發)...');

            // 啟動基準價輪詢
            this.startBaselinePricePolling();

        } catch (error) {
            console.error('❌ 初始化失敗:', error);
        }
    }

    /** 狀態對賬：比對 MongoDB 與 cTrader 的持倉 */
    async reconcilePositions() {
        try {
            // 請求當前持倉 (ProtoOAReconcileReq)
            const positions = await this.getOpenPositions();

            // 更新內部持倉列表
            this.positions = positions.map(p => {
                const side = p.tradeData.tradeSide; // 可能是 1 (BUY) 或 'BUY'
                const isBuy = side === 1 || side === 'BUY';

                const positionId = convertLongValue(p.positionId);
                const rawVolume = p.tradeData?.volume ?? p.volume;
                const volume = convertLongValue(rawVolume);
                const rawPrice = convertLongValue(p.price);
                const openTimestamp = convertLongValue(p.tradeData.openTimestamp);
                const volumeInLots = volume ? volume / VOLUME_DIVISOR : null;

                return {
                    id: positionId,
                    type: isBuy ? 'long' : 'short',
                    entryPrice: rawPrice,
                    volume: volumeInLots,
                    openTime: new Date(openTimestamp)
                };
            });

            if (this.positions.length > 0) {
                console.log(`⚠️ 偵測到 ${this.positions.length} 個未平倉部位，同步中...`);
                const now = new Date();
                const isDst = isUsDst(now);
                const marketConfig = isDst ? this.config.market.summer : this.config.market.winter;

                // 建立"當前會話"的起始時間
                const sessionOpen = new Date(now);
                sessionOpen.setHours(marketConfig.openHour, marketConfig.openMinute, 0, 0);

                // 如果現在時間還沒到今天的開盤時間 (例如 05:00, 開盤是 06:00)，那當前會話其實是從"昨天"的開盤時間算起
                if (now < sessionOpen) {
                    sessionOpen.setDate(sessionOpen.getDate() - 1);
                }

                console.log(`🕒 當前會話起始時間: ${sessionOpen.toLocaleString()}`);

                // 只記錄持倉資訊，不修改 todayTradeDone 狀態
                // todayTradeDone 只應該在成功下單時才設為 true（由 handleExecutionEvent 處理）
                this.positions.forEach(p => {
                    console.log(`   - 持倉: ${p.id} | ${p.type} | 開倉時間: ${p.openTime.toLocaleString()}`);
                });

                console.log('ℹ️ 持倉同步完成，todayTradeDone 狀態維持不變');

                await this.saveState();
                this.emit('positions-reconciled', this.positions);
            } else {
                console.log('✅ 無未平倉部位');
            }
        } catch (error) {
            console.error('❌ 狀態對賬失敗:', error);
        }
    }


    /** 取得當前持倉 */
    async getOpenPositions() {
        const ProtoOAReconcileReq = this.connection.proto.lookupType('ProtoOAReconcileReq');
        const message = ProtoOAReconcileReq.create({
            ctidTraderAccountId: parseInt(this.config.ctrader.accountId)
        });

        const response = await this.connection.send('ProtoOAReconcileReq', message);
        const ProtoOAReconcileRes = this.connection.proto.lookupType('ProtoOAReconcileRes');
        const payload = ProtoOAReconcileRes.decode(response.payload);

        return payload.position || [];
    }

    /** 取得帳戶資訊 (餘額、淨值、保證金等) */
    async getAccountInfo() {
        if (!this.connection?.connected || !this.connection?.authenticated) {
            if (this.cachedAccountInfo && Date.now() - this.cachedAccountInfoTime < 300000) {
                return this.cachedAccountInfo;
            }
            return null;
        }

        try {
            // 1. 取得帳戶基本資訊
            const ProtoOATraderReq = this.connection.proto.lookupType('ProtoOATraderReq');
            const traderMessage = ProtoOATraderReq.create({
                ctidTraderAccountId: parseInt(this.config.ctrader.accountId)
            });

            const traderResponse = await this.connection.send('ProtoOATraderReq', traderMessage);
            const ProtoOATraderRes = this.connection.proto.lookupType('ProtoOATraderRes');
            const traderPayload = ProtoOATraderRes.decode(traderResponse.payload);

            const moneyDigits = traderPayload.trader.moneyDigits || 2;
            const divisor = Math.pow(10, moneyDigits);
            const balance = traderPayload.trader.balance / divisor;

            // 2. 取得持倉資訊計算已用保證金
            let usedMargin = 0;
            let unrealizedPnL = 0;
            try {
                const positions = await this.getOpenPositions();
                for (const pos of positions) {
                    const posMoneyDigits = pos.moneyDigits || moneyDigits;
                    const posDivisor = Math.pow(10, posMoneyDigits);
                    usedMargin += (pos.usedMargin || 0) / posDivisor;
                    // 從 swap 和 commission 估算 (實際 PnL 需要用當前價格計算)
                    unrealizedPnL += ((pos.swap || 0) + (pos.commission || 0)) / posDivisor;
                }
            } catch (e) {
                // 忽略
            }

            // 3. 計算衍生值 (淨值 = 餘額 + 未實現損益，但因為無法精確計算 PnL，暫時用餘額)
            const equity = balance + unrealizedPnL;
            const freeMargin = equity - usedMargin;

            const accountInfo = {
                balance: balance,
                equity: equity,
                usedMargin: usedMargin,
                freeMargin: freeMargin,
                unrealizedPnL: unrealizedPnL,
                leverage: traderPayload.trader.leverageInCents ? traderPayload.trader.leverageInCents / 100 : null,
                moneyDigits: moneyDigits
            };

            // 快取帳戶資訊
            this.cachedAccountInfo = accountInfo;
            this.cachedAccountInfoTime = Date.now();

            return accountInfo;
        } catch (error) {
            console.error('❌ 取得帳戶資訊失敗:', error.message);
            // 如果有快取且在 5 分鐘內，返回快取
            if (this.cachedAccountInfo && Date.now() - this.cachedAccountInfoTime < 300000) {
                return this.cachedAccountInfo;
            }
            return null;
        }
    }

    /** 訂閱報價 */
    async subscribeToMarketData() {
        try {
            const ProtoOASubscribeSpotsReq = this.connection.proto.lookupType('ProtoOASubscribeSpotsReq');
            const symbolData = await this.getSymbolInfo(this.config.market.symbol);
            if (!symbolData) {
                console.error('❌ 無法取得 Symbol 資訊，訂閱失敗');
                return;
            }

            const message = ProtoOASubscribeSpotsReq.create({
                ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
                symbolId: [symbolData.symbolId]
            });

            await this.connection.send('ProtoOASubscribeSpotsReq', message);
            console.log(`📊 已訂閱 ${this.config.market.symbol} 報價`);
        } catch (error) {
            console.error('❌ 訂閱報價失敗:', error.message);
        }
    }

    /** 取得 Symbol 資訊 */
    async getSymbolInfo(symbolName) {
        // 先查緩存
        if (this.symbolInfoCache && this.symbolInfoCache[symbolName]) {
            return this.symbolInfoCache[symbolName];
        }

        console.log(`🔍 正在查詢 Symbol 資訊: ${symbolName}...`);

        try {
            const ProtoOASymbolsListReq = this.connection.proto.lookupType('ProtoOASymbolsListReq');
            const message = ProtoOASymbolsListReq.create({
                ctidTraderAccountId: parseInt(this.config.ctrader.accountId)
            });

            // 請求所有 Symbols
            const response = await this.connection.send('ProtoOASymbolsListReq', message);
            const ProtoOASymbolsListRes = this.connection.proto.lookupType('ProtoOASymbolsListRes');
            const payload = ProtoOASymbolsListRes.decode(response.payload);

            // 尋找匹配的 Symbol
            let symbol = payload.symbol.find(s => s.symbolName === symbolName);

            // 如果找不到精確匹配，嘗試模糊搜尋
            if (!symbol) {
                console.warn(`⚠️ 找不到精確名稱 '${symbolName}'，嘗試搜尋替代名稱...`);
                const candidates = ['US30', 'DJ30', 'Wall Street 30', 'WS30', 'US30.cash', 'DJ30.cash'];

                for (const candidate of candidates) {
                    symbol = payload.symbol.find(s => s.symbolName.toUpperCase().includes(candidate.toUpperCase()));
                    if (symbol) {
                        console.log(`✅ 自動匹配到替代 Symbol: ${symbol.symbolName}`);
                        break;
                    }
                }
            }

            if (symbol) {
                // 取得 Lot Size (in cents)，如果沒有則預設為 100 (1 unit)
                const lotSize = symbol.lotSize || 100;
                const digits = symbol.digits || 2; // 預設 2 位小數
                // 取得 Volume 限制
                const stepVolume = symbol.stepVolume || 100000; // 預設較大的 step 以防錯誤
                const minVolume = symbol.minVolume || 100000;

                // 取得交易時段和假日資訊
                const schedule = symbol.schedule || [];
                const holidays = symbol.holiday || [];
                const scheduleTimeZone = symbol.scheduleTimeZone || 'UTC';

                console.log(`✅ 找到 Symbol: ${symbol.symbolName} (ID: ${symbol.symbolId}, LotSize: ${lotSize}, Digits: ${digits}, Step: ${stepVolume})`);
                console.log(`   📅 交易時段: ${schedule.length} 個區間, 假日: ${holidays.length} 個`);

                const info = {
                    symbolId: symbol.symbolId,
                    symbolName: symbol.symbolName,
                    lotSize: lotSize,
                    digits: digits,
                    stepVolume: stepVolume,
                    minVolume: minVolume,
                    schedule: schedule,
                    holidays: holidays,
                    scheduleTimeZone: scheduleTimeZone
                };
                this.symbolInfoCache[symbolName] = info; // 緩存原始 key 以便下次快速查找
                return info;
            } else {
                console.error(`❌ 找不到 Symbol: ${symbolName} 且無合適替代品`);

                // 列出建議
                const suggestions = payload.symbol
                    .filter(s => s.symbolName.includes('NAS') || s.symbolName.includes('US100') || s.symbolName.includes('100'))
                    .map(s => `${s.symbolName}(${s.symbolId})`)
                    .join(', ');

                if (suggestions) {
                    console.log(`💡 可能的選項: ${suggestions}`);
                }

                return null;
            }
        } catch (error) {
            console.error('❌ 查詢 Symbol 資訊失敗:', error.message);

            // Fallback: 如果查詢失敗且是標準 US30
            if (symbolName === 'US30') {
                console.warn('⚠️ API 查詢失敗，使用預設值嘗試...');
                return { symbolId: 1, lotSize: 100, digits: 2 };
            }
            return null;
        }
    }

    /** 處理市場數據 */
    handleMarketData(data) {
        const { type, payload } = data;

        switch (type) {
            case 'ProtoOASpotEvent':
                this.handleSpotEvent(payload);
                break;

            case 'ProtoOAExecutionEvent':
                this.handleExecutionEvent(payload);
                break;
        }
    }

    /** 處理報價更新 */
    handleSpotEvent(payload) {
        const ProtoOASpotEvent = this.connection.proto.lookupType('ProtoOASpotEvent');
        const spot = ProtoOASpotEvent.decode(payload);

        // 使用工具函數處理 protobuf Long 物件轉換
        const bid = convertLongValue(spot.bid);
        const ask = convertLongValue(spot.ask);

        // 1️⃣ 檢查 bid/ask 都是有效正數
        if (!bid || !ask || bid <= 0 || ask <= 0) {
            return; // 忽略不完整的報價
        }

        // 2️⃣ 檢查 bid/ask 的合理性 (ask 應該 >= bid)
        if (ask < bid) {
            console.warn(`⚠️ 異常報價: bid=${bid} > ask=${ask}，忽略`);
            return;
        }

        // ✅ 通過驗證，更新價格（使用 bid/ask 中間價）
        this.currentPrice = (bid + ask) / 2;
        this.currentBid = bid;
        this.currentAsk = ask;

        this.emit('price-update', {
            price: this.currentPrice,
            bid: bid,
            ask: ask,
            openPrice: this.todayOpenPrice,
            timestamp: Date.now()
        });

        this.executeStrategy();
    }

    /** 計算即時帳戶資訊（基於當前價格） */
    calculateRealTimeAccountInfo() {
        const balance = this.cachedAccountInfo?.balance ?? 0;
        let unrealizedPnL = 0;

        // 計算每個持倉的即時損益
        const positionsWithPnL = this.positions.map(pos => {
            const entryPrice = pos.entryPrice;
            const currentPrice = this.currentPrice ? rawToRealPrice(this.currentPrice) : null;
            const volume = pos.volume;

            let pnl = null;
            if (currentPrice && volume) {
                if (pos.type === 'long') {
                    pnl = (currentPrice - entryPrice) * volume;
                } else {
                    pnl = (entryPrice - currentPrice) * volume;
                }
                unrealizedPnL += pnl;
            }

            return {
                ...pos,
                currentPrice: currentPrice,
                pnl: pnl
            };
        });

        const equity = balance + unrealizedPnL;

        return {
            balance: balance,
            equity: equity,
            unrealizedPnL: unrealizedPnL,
            usedMargin: this.cachedAccountInfo?.usedMargin || 0,
            freeMargin: equity - (this.cachedAccountInfo?.usedMargin || 0),
            leverage: this.cachedAccountInfo?.leverage || null,
            positions: positionsWithPnL
        };
    }

    /** 處理訂單執行事件 */
    handleExecutionEvent(payload) {
        const ProtoOAExecutionEvent = this.connection.proto.lookupType('ProtoOAExecutionEvent');
        const execution = ProtoOAExecutionEvent.decode(payload);

        const execType = execution.executionType;
        console.log('📨 訂單執行事件:', execType);

        // ORDER_FILLED
        if (execType === 3 || execType === 'ORDER_FILLED') {
            // 檢查是否有 Deal 資訊
            if (execution.deal) {
                const deal = execution.deal;

                // 檢查是否為平倉交易 (Closing Deal)
                if (deal.closePositionDetail) {
                    this.handleTradeClosed(deal);
                } else {
                    // 開倉交易成功 - 標記今日已交易
                    this.todayTradeDone = true;
                    this.saveState();
                    console.log('✅ 開倉成功，今日交易任務完成');

                    // 設定 SL/TP（基於基準點）
                    if (this.pendingSlTp && execution.position) {
                        const positionId = convertLongValue(execution.position.positionId);
                        console.log(`📝 正在設定 SL/TP for position ${positionId}...`);
                        this.setPositionSlTp(positionId, this.pendingSlTp.stopLoss, this.pendingSlTp.takeProfit);
                        this.pendingSlTp = null;
                    } else {
                        console.warn('⚠️ 無法設定 SL/TP: pendingSlTp 或 position 資訊不存在');
                    }

                    // 同步持倉 (重要：確保 Dashboard 顯示最新狀態)
                    this.reconcilePositions();

                    this.emit('order-filled', execution);
                }
            } else {
                // 向下相容舊邏輯 (雖然 ORDER_FILLED 通常都有 Deal)
                this.todayTradeDone = true;
                this.saveState();
                console.log('✅ 訂單成交，今日交易任務完成');

                // 同步持倉
                this.reconcilePositions();

                this.emit('order-filled', execution);
            }
        }
        // 處理訂單被拒 (例如：保證金不足、市場關閉) - executionType = 4 (ORDER_REJECTED)
        else if (execType === 4 || execType === 'ORDER_REJECTED') {
            const errCode = execution.errorCode || '原因未知';
            console.error('❌ 訂單被拒:', errCode);

            this.orderFailureCount++;

            // 重要：重置交易標誌，允許重試（如果不是致命錯誤）
            // 在這裡我們假設它是資金問題或其他可恢復問題，或者至少讓人工介入後不需要重啟機器人
            if (this.todayTradeDone) {
                if (this.orderFailureCount <= 3) {
                    this.todayTradeDone = false;
                    this.saveState();
                    console.log(`🔄 已重置交易標誌 (失敗次數: ${this.orderFailureCount}/3)，準備重試...`);
                } else {
                    console.error('⛔ 訂單連續失敗超過 3 次，停止今日交易以免發生意外。請檢查帳戶或系統狀態。');
                    this.emit('trade-error', new Error(`訂單連續失敗 (已停止重試): ${errCode}`));
                    return; // 不重置標誌，停止交易
                }
            }

            this.emit('trade-error', new Error(`訂單被拒: ${errCode}`));
        }
    }

    /**
     * 處理平倉結算
     */
    handleTradeClosed(deal) {
        const detail = deal.closePositionDetail;
        const positionId = deal.positionId;
        const positionIdNorm = convertLongValue(positionId);

        // 去重：防止 cTrader 對同一筆平倉發送多個 ORDER_FILLED 事件
        if (this.closedPositionIds.has(positionIdNorm)) {
            console.log(`⚠️ 重複的平倉事件 (ID: ${positionIdNorm})，已忽略`);
            return;
        }
        this.closedPositionIds.add(positionIdNorm);

        // 計算損益 (Net Profit = Gross Profit + Swap + Commission)
        const netProfitRaw = (detail.grossProfit || 0) + (detail.swap || 0) + (detail.commission || 0);
        const netProfit = netProfitRaw / PNL_DIVISOR;

        // balance 使用 moneyDigits 計算
        const moneyDigits = detail.moneyDigits || MONEY_DIGITS_DEFAULT;
        const balance = (detail.balance || 0) / Math.pow(10, moneyDigits);

        console.log(`💰 交易平倉 ID: ${positionIdNorm} | 損益: $${netProfit.toFixed(2)} | 餘額: $${balance.toFixed(2)}`);

        // 更新狀態
        this.balance = balance;
        if (netProfit > 0) this.wins++;
        else if (netProfit < 0) this.losses++;
        // netProfit == 0 (打平) 不計入勝負

        // 記錄交易歷史
        const tradeRecord = {
            id: positionId,
            closeTime: new Date(deal.executionTimestamp),
            profit: netProfit,
            balance: this.balance,
            type: deal.tradeSide === 1 || deal.tradeSide === 'BUY' ? 'long' : 'short' // 1=BUY, 2=SELL
        };
        this.trades.unshift(tradeRecord);
        if (this.trades.length > TRADE_HISTORY_MAX) this.trades.pop();

        // 從持倉列表中移除
        const closedPositionId = convertLongValue(positionId);
        this.positions = this.positions.filter(p => p.id !== closedPositionId);

        // 儲存狀態
        this.saveState();

        // 發送事件通知
        this.emit('trade-closed', tradeRecord);

        // 審計日誌
        logAudit('CLOSE_POSITION', {
            positionId: closedPositionId,
            profit: netProfit,
            balance: this.balance,
            type: tradeRecord.type
        });

        // 發送帳戶更新事件 (用於 Socket.IO 即時推送)
        this.emit('account-update', {
            balance: this.balance,
            wins: this.wins,
            losses: this.losses,
            positions: this.positions
        });
    }

    /**
     * 檢查是否在交易時段內
     * 交易時段：台北時間 07:01 ~ 隔天 06:00 (對應美股交易時間)
     * 冬令: 開盤 07:30，收盤 06:00
     * 夏令: 開盤 06:30，收盤 05:00
     */
    isWithinTradingHours() {
        const now = new Date();

        // 使用台北時區 (UTC+8) 計算時間，避免伺服器時區問題
        const taipeiTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        const hour = taipeiTime.getHours();
        const minute = taipeiTime.getMinutes();
        const currentMinutes = hour * 60 + minute;

        // 判斷夏令/冬令
        const isDst = isUsDst(now);

        // 冬令時間：台北時間 07:30 - 隔天 06:00 (即 07:30-23:59 和 00:00-06:00)
        // 夏令時間：台北時間 06:30 - 隔天 05:00 (即 06:30-23:59 和 00:00-05:00)
        const openMinutes = isDst ? (6 * 60 + 30) : (7 * 60 + 30);  // 夏令 06:30，冬令 07:30
        const closeMinutes = isDst ? (5 * 60) : (6 * 60);           // 夏令 05:00，冬令 06:00

        // 交易時段跨越午夜
        // 有效時段：開盤時間 ~ 23:59 或 00:00 ~ 收盤時間
        if (currentMinutes >= openMinutes) {
            // 開盤後 (07:30+ 或 06:30+)
            return true;
        } else if (currentMinutes < closeMinutes) {
            // 隔天未收盤前 (00:00 ~ 06:00 或 00:00 ~ 05:00)
            return true;
        }

        return false;
    }

    /**
     * 執行策略邏輯
     */
    async executeStrategy() {
        if (this.tradingPaused) return;
        if (!this.currentPrice || !this.todayOpenPrice) return;
        if (this.todayTradeDone || !this.isWatching) return;

        // 檢查是否在交易時段內 (台北時間 07:01 - 06:00 隔天，即美股交易時間)
        if (!this.isWithinTradingHours()) {
            return; // 非交易時段，不執行策略
        }

        // cTrader API 的 Raw Price = 真實價格 * API_PRICE_MULTIPLIER
        const diff = this.currentPrice - this.todayOpenPrice;
        const offsetRaw = this.entryOffset * API_PRICE_MULTIPLIER;

        // 做空條件：價格高於開盤 + 進場偏移
        if (diff >= offsetRaw) {
            console.log(`📉 訊號觸發: 現價(${this.currentPrice}) >= 開盤(${this.todayOpenPrice}) + Offset(${offsetRaw})`);
            this.openPosition('short');
        }
        // 做多條件：價格低於開盤 - 進場偏移
        else if (diff <= -offsetRaw) {
            console.log(`📈 訊號觸發: 現價(${this.currentPrice}) <= 開盤(${this.todayOpenPrice}) - Offset(${offsetRaw})`);
            this.openPosition('long');
        }
    }

    /**
     * 開倉
     */
    async openPosition(type) {
        if (this.todayTradeDone || this.isPlacingOrder) return;
        this.isPlacingOrder = true;

        try {
            const tradeType = type === 'long' ? 'BUY' : 'SELL';

            // 取得 Symbol 資訊以計算 Volume
            const symbolData = await this.getSymbolInfo(this.config.market.symbol);
            if (!symbolData) throw new Error('無法取得 Symbol 資訊');

            // cTrader Volume 計算：
            // - cTrader volume 單位: 1 lot = 100 volume units (centilots)
            // - 所以 0.1 lots = 10 volume units
            // - 最小 volume 通常是 100 (= 0.01 lots) 或根據 broker 設定

            // 計算 volume (lots * 100)
            let volume = Math.round(this.lotSize * 100);

            // 最小量檢查 (0.01 lots = 1 volume, 但通常最小是 0.1 lots = 10 volume)
            const minVolume = 10; // 0.1 lots = 10 volume units (大部分 broker 的最小)
            if (volume < minVolume) {
                console.warn(`⚠️ 計算出的交易量 (${volume}) 小於最小限制 (${minVolume})，已自動修正為最小量。`);
                volume = minVolume;
            }

            console.log(`📊 下單量: ${this.lotSize} lots = ${volume} volume units`);

            // 計算基於基準點的 TP/SL 絕對價格
            // 策略：TP/SL 是相對於「基準點」而非「成交價」
            const openPriceReal = rawToRealPrice(this.todayOpenPrice);

            let tpPriceReal, slPriceReal;
            if (type === 'long') {
                tpPriceReal = openPriceReal + this.longTP;
                slPriceReal = openPriceReal - this.longSL;
            } else {
                tpPriceReal = openPriceReal - this.shortTP;
                slPriceReal = openPriceReal + this.shortSL;
            }

            // 儲存待設定的 SL/TP（成交後才設定）
            this.pendingSlTp = {
                type,
                stopLoss: slPriceReal,
                takeProfit: tpPriceReal
            };

            // 發送訂單（不帶 SL/TP）
            // 成交後在 handleExecutionEvent 中設定 SL/TP
            const ProtoOANewOrderReq = this.connection.proto.lookupType('ProtoOANewOrderReq');
            const order = ProtoOANewOrderReq.create({
                ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
                symbolId: symbolData.symbolId,
                orderType: 1, // MARKET
                tradeSide: type === 'long' ? 1 : 2, // BUY=1, SELL=2
                volume: volume,
                // 不帶 SL/TP，成交後設定
                label: 'US30_MR'
            });

            const currentPriceReal = rawToRealPrice(this.currentPrice);
            console.log(`${type === 'long' ? '📈' : '📉'} 開${type === 'long' ? '多' : '空'} | Price: ${currentPriceReal.toFixed(2)} | 目標TP: ${tpPriceReal.toFixed(2)} | 目標SL: ${slPriceReal.toFixed(2)}`);

            const response = await this.connection.send('ProtoOANewOrderReq', order);

            console.log('📨 訂單發送成功，等待執行（SL/TP 將在成交後設定）...');

            // 發送 Discord 通知
            this.emit('trade-opened', {
                type,
                price: this.currentPrice,
                tp: tpPriceReal,
                sl: slPriceReal,
                baselinePrice: rawToRealPrice(this.todayOpenPrice), // Add baseline price for Risk Agent
                positionId: null // positionId is not available yet, will be updated in order-filled if needed, or Risk Agent waits for order-filled
            });

            // 審計日誌
            logAudit('OPEN_POSITION', {
                type,
                price: currentPriceReal,
                volume: volume,
                tp: tpPriceReal,
                sl: slPriceReal
            });

        } catch (error) {
            console.error('❌ 開倉失敗:', error);
            this.emit('trade-error', error);
        } finally {
            this.isPlacingOrder = false;
            // 無論成功或失敗，都關閉盯盤狀態，防止重複下單
            this.isWatching = false;
            console.log('🔒 盯盤狀態已關閉（已嘗試下單）');
        }
    }

    /**
     * 設定今日基準點
     */
    setTodayOpenPrice(price) {
        this.todayOpenPrice = price;
        console.log(`📊 今日基準點: ${price}`);
    }

    /**
     * 每日重置
     * @param {boolean} force - 強制重置，忽略資料庫檢查
     */
    async resetDaily(force = false) {

        const taipeiTimeStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" });
        const todayStr = new Date(taipeiTimeStr).toDateString();

        // 如果不是強制重置，先檢查資料庫是否已經在今天重置過
        if (!force) {
            const state = await this.db.loadState();
            if (state && state.lastResetDate === todayStr) {
                console.log(`ℹ️ 今日 (${todayStr}) 已執行過重置，跳過。`);
                // 即使跳過重置，也要確保記憶體中的日期同步，以免 trading-bot 重複呼叫
                return;
            }
        }

        this.todayTradeDone = false;
        this.todayOpenPrice = null;
        this.isWatching = false;
        this.isPlacingOrder = false;
        this.orderFailureCount = 0;
        this.closedPositionIds.clear(); // 清空去重記錄
        this.tradingPaused = false; // Reset tradingPaused

        // 記錄重置日期
        this.lastResetDate = todayStr;

        await this.saveState();
        console.log('🔄 每日狀態已重置 (並已寫入資料庫)');
    }

    /**
     * 儲存狀態到資料庫
     */
    async saveState() {
        try {
            const state = {
                wins: this.wins,
                losses: this.losses,
                trades: this.trades,
                todayTradeDone: this.todayTradeDone,
                lastResetDate: this.lastResetDate,
                config: {
                    entryOffset: this.entryOffset,
                    longTP: this.longTP,
                    shortTP: this.shortTP,
                    longSL: this.longSL,
                    shortSL: this.shortSL,
                    lotSize: this.lotSize,
                    minsAfterOpen: this.minsAfterOpen,
                    baselineOffsetMinutes: this.baselineOffsetMinutes
                },
                lastUpdate: new Date()
            };

            await this.db.saveState(state);
        } catch (error) {
            console.error('❌ 儲存狀態失敗:', error);
        }
    }
    async fetchDailyOpenPrice() {
        const offsetMinutes = this.baselineOffsetMinutes || 0;
        console.log(`🔄 正在從 cTrader 獲取今日基準價 (M1 at Open Time + ${offsetMinutes} 分鐘)...`);
        try {
            const ProtoOAGetTrendbarsReq = this.connection.proto.lookupType('ProtoOAGetTrendbarsReq');
            const ProtoOATrendbarPeriod = this.connection.proto.lookupEnum('ProtoOATrendbarPeriod');

            const symbolData = await this.getSymbolInfo(this.config.market.symbol);
            if (!symbolData) throw new Error('Symbol info not found');

            // 計算今天的開盤時間
            const now = new Date();
            const isDst = isUsDst(now);
            const marketConfig = isDst ? this.config.market.summer : this.config.market.winter;

            // 修正：使用台北時區 (UTC+8) 計算開盤時間
            // 避免伺服器時區不同導致計算錯誤
            const TAIPEI_OFFSET = 8 * 60 * 60 * 1000; // UTC+8 in milliseconds

            // 取得當前 UTC 時間
            const nowUtc = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
            // 轉換為台北時間
            const nowTaipei = new Date(nowUtc + TAIPEI_OFFSET);

            // 計算今日開盤時間（台北時間）
            const openTimeTaipei = new Date(nowTaipei);
            openTimeTaipei.setHours(marketConfig.openHour, marketConfig.openMinute, 0, 0);

            // 如果當前台北時間還沒到開盤，退回一天
            if (nowTaipei < openTimeTaipei) {
                console.warn('⚠️ 當前時間早於今日開盤時間，嘗試獲取昨日基準點...');
                openTimeTaipei.setDate(openTimeTaipei.getDate() - 1);
            }

            // 將台北時間轉回 UTC timestamp (供 API 使用)
            const openTimeUtc = openTimeTaipei.getTime() - TAIPEI_OFFSET - openTimeTaipei.getTimezoneOffset() * 60 * 1000;

            // 加上基準點偏移
            const baselineTimeUtc = openTimeUtc + (offsetMinutes * 60000);
            const baselineTimeTaipei = new Date(baselineTimeUtc);

            console.log(`📅 鎖定基準時間: ${baselineTimeTaipei.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })} (台北時間, 偏移 ${offsetMinutes} 分鐘)`);

            // 請求該分鐘的 M1 K 線
            // 請求前後 5 分鐘的 K 線，確保能包含到目標時間
            // 有時候 API 邊界處理可能會漏掉剛好在起始點的資料
            const fromTimestamp = baselineTimeUtc - 60000; // 提早 1 分鐘
            const toTimestamp = baselineTimeUtc + 300000;  // 往後 5 分鐘

            const request = ProtoOAGetTrendbarsReq.create({
                ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
                period: ProtoOATrendbarPeriod.values.M1,
                symbolId: symbolData.symbolId,
                fromTimestamp: fromTimestamp,
                toTimestamp: toTimestamp,
                count: 10
            });

            const response = await this.connection.send('ProtoOAGetTrendbarsReq', request);
            const ProtoOAGetTrendbarsRes = this.connection.proto.lookupType('ProtoOAGetTrendbarsRes');
            const payload = ProtoOAGetTrendbarsRes.decode(response.payload);

            if (payload.trendbar && payload.trendbar.length > 0) {
                // 尋找時間戳記剛好等於 baselineTimeUtc 的 K 線
                // cTrader Trendbar timestamp 是 UTC 分鐘數 (沒有毫秒)
                // 我們可以直接比對 utcTimestampInMinutes
                const targetMinute = Math.floor(baselineTimeUtc / 60000);

                const targetBar = payload.trendbar.find(bar => bar.utcTimestampInMinutes === targetMinute);

                if (targetBar) {
                    const low = typeof targetBar.low === 'number' ? targetBar.low : targetBar.low.toNumber();
                    const deltaOpen = typeof targetBar.deltaOpen === 'number' ? targetBar.deltaOpen : (targetBar.deltaOpen ? targetBar.deltaOpen.toNumber() : 0);
                    const openPrice = low + deltaOpen;

                    // Debug: 顯示這根 K 線的實際時間
                    const barTimeUtc = targetBar.utcTimestampInMinutes * 60000;
                    const barTimeTaipei = new Date(barTimeUtc).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
                    console.log(`🔍 [Debug] K線時間: ${barTimeTaipei} (UTC: ${new Date(barTimeUtc).toISOString()})`);

                    console.log(`✅ 取得 cTrader 精確基準價 (${baselineTimeTaipei.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' })}): ${openPrice} (Raw Points)`);
                    return openPrice;
                } else {
                    console.warn(`⚠️ 找到 K 線資料，但沒有目標時間的資料 (最近: ${new Date(payload.trendbar[0].utcTimestampInMinutes * 60000).toISOString()})`);

                    // 如果真的沒有 07:00，是否要用最接近的一根？
                    // 目前先回傳 null 讓它重試
                    return null;
                }
            } else {
                console.warn('⚠️ 該時間範圍內無 K 線資料');
                return null;
            }
        } catch (error) {
            console.error('❌ 取得基準價失敗:', error.message);
            return null;
        }
    }

    /**
     * 檢查市場是否開放交易
     * @returns {object} { isOpen: boolean, reason: string }
     */
    async checkMarketStatus() {
        try {
            const symbolData = await this.getSymbolInfo(this.config.market.symbol);
            if (!symbolData) {
                return { isOpen: false, reason: 'Symbol 資訊不可用' };
            }

            const now = new Date();

            // 1. 檢查是否為假日
            const holidayCheck = this.checkHoliday(symbolData.holidays, symbolData.scheduleTimeZone, now);
            if (holidayCheck.isHoliday) {
                return { isOpen: false, reason: `假日: ${holidayCheck.holidayName}` };
            }

            // 2. 檢查是否在交易時段
            const scheduleCheck = this.checkTradingSchedule(symbolData.schedule, symbolData.scheduleTimeZone, now);
            if (!scheduleCheck.isWithinSchedule) {
                return { isOpen: false, reason: '非交易時段' };
            }

            return { isOpen: true, reason: '市場開放' };
        } catch (error) {
            console.error('❌ 檢查市場狀態失敗:', error.message);
            // 失敗時預設為開放，讓原有邏輯處理
            return { isOpen: true, reason: '無法確認，預設開放' };
        }
    }

    /**
     * 檢查是否為假日
     */
    checkHoliday(holidays, timezone, now) {
        if (!holidays || holidays.length === 0) {
            return { isHoliday: false };
        }

        // 計算當前日期 (距離 1970/1/1 的天數)
        const msPerDay = 86400000;
        const todayDays = Math.floor(now.getTime() / msPerDay);

        for (const holiday of holidays) {
            // holidayDate 是距離 1970/1/1 的天數
            const holidayDays = typeof holiday.holidayDate === 'number'
                ? holiday.holidayDate
                : (holiday.holidayDate.toNumber ? holiday.holidayDate.toNumber() : Number(holiday.holidayDate));

            // 檢查是否為今天
            if (holidayDays === todayDays) {
                // 如果有指定時間範圍，檢查當前時間是否在範圍內
                if (holiday.startSecond !== undefined && holiday.endSecond !== undefined) {
                    const secondsFromMidnight = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
                    if (secondsFromMidnight >= holiday.startSecond && secondsFromMidnight < holiday.endSecond) {
                        return { isHoliday: true, holidayName: holiday.name };
                    }
                } else {
                    // 全天假日
                    return { isHoliday: true, holidayName: holiday.name };
                }
            }

            // 檢查年度重複假日
            if (holiday.isRecurring) {
                const holidayDate = new Date(holidayDays * msPerDay);
                if (now.getMonth() === holidayDate.getMonth() && now.getDate() === holidayDate.getDate()) {
                    return { isHoliday: true, holidayName: holiday.name };
                }
            }
        }

        return { isHoliday: false };
    }

    /**
     * 檢查是否在交易時段
     */
    checkTradingSchedule(schedule, timezone, now) {
        if (!schedule || schedule.length === 0) {
            // 沒有時段資訊，預設為開放
            return { isWithinSchedule: true };
        }

        // 計算從本週日 00:00 開始的秒數
        const dayOfWeek = now.getDay(); // 0 = Sunday
        const secondsFromSunday =
            dayOfWeek * 86400 +
            now.getHours() * 3600 +
            now.getMinutes() * 60 +
            now.getSeconds();

        for (const interval of schedule) {
            const start = typeof interval.startSecond === 'number'
                ? interval.startSecond
                : (interval.startSecond.toNumber ? interval.startSecond.toNumber() : Number(interval.startSecond));
            const end = typeof interval.endSecond === 'number'
                ? interval.endSecond
                : (interval.endSecond.toNumber ? interval.endSecond.toNumber() : Number(interval.endSecond));

            if (secondsFromSunday >= start && secondsFromSunday < end) {
                return { isWithinSchedule: true };
            }
        }

        return { isWithinSchedule: false };
    }

    /**
     * 取得並設定基準價（每 30 秒輪詢一次）
     * 使用 cTrader API 獲取基準價
     * 會持續每 30 秒嘗試獲取，直到今日交易完成或手動停止
     * 當到達基準點時間時，會先清空目前的基準價再重新獲取
     */
    async fetchAndSetOpenPrice() {
        const POLL_INTERVAL_MS = 30000; // 30 秒

        if (this.isFetchingOpenPrice) return false;

        this.isFetchingOpenPrice = true;
        try {
            // 先檢查市場是否開放
            const marketStatus = await this.checkMarketStatus();
            if (!marketStatus.isOpen) {
                console.log(`🚫 市場未開放: ${marketStatus.reason}`);
                return false;
            }

            // 檢查是否到達基準點時間，若是則先清空目前的基準價
            const shouldResetBaseline = this.checkIfBaselineTimeReached();
            if (shouldResetBaseline && this.todayOpenPrice !== null) {
                console.log('🔄 到達基準點時間，清空目前基準價以重新獲取...');
                this.todayOpenPrice = null;
            }

            // 使用 cTrader API 取得基準價
            const price = await this.fetchDailyOpenPrice();
            if (price !== null) {
                this.setTodayOpenPrice(price);
                return true;
            }

            // 取得失敗（可能是 K 線還沒形成）
            const offsetMinutes = this.baselineOffsetMinutes || 0;
            console.warn(`⚠️ 尚未取得有效基準價 (開盤+${offsetMinutes}分鐘)，等待下次輪詢...`);
            return false;
        } finally {
            this.isFetchingOpenPrice = false;
        }
    }

    /**
     * 檢查當前時間是否剛好到達基準點時間（在 2 分鐘內）
     * 用於判斷是否需要清空並重新獲取基準價
     * @returns {boolean} 是否到達基準點時間
     */
    checkIfBaselineTimeReached() {
        const offsetMinutes = this.baselineOffsetMinutes || 0;
        const now = new Date();
        const isDst = isUsDst(now);
        const marketConfig = isDst ? this.config.market.summer : this.config.market.winter;

        // 計算當前台北時間
        const taipeiTimeStr = now.toLocaleString("en-US", { timeZone: "Asia/Taipei" });
        const taipeiTime = new Date(taipeiTimeStr);
        const currentHour = taipeiTime.getHours();
        const currentMinute = taipeiTime.getMinutes();
        const currentTotalMinutes = currentHour * 60 + currentMinute;

        // 計算基準點時間 (開盤時間 + 偏移)
        const baselineTotalMinutes = marketConfig.openHour * 60 + marketConfig.openMinute + offsetMinutes;

        // 判斷當前時間是否在基準點時間的 2 分鐘內
        // 這樣可以確保在基準點時間前後都能觸發清空
        const isWithinBaselineWindow = currentTotalMinutes >= baselineTotalMinutes &&
            currentTotalMinutes < baselineTotalMinutes + 2;

        return isWithinBaselineWindow;
    }

    /**
     * 啟動基準價輪詢（每 30 秒獲取一次）
     */
    startBaselinePricePolling() {
        const POLL_INTERVAL_MS = 30000; // 30 秒

        // 如果已經在輪詢中，不重複啟動
        if (this.baselinePricePollingInterval) {
            return;
        }

        console.log('🔄 啟動基準價輪詢 (每 30 秒)...');

        // 立即執行一次
        this.fetchAndSetOpenPrice();

        // 每 30 秒執行一次 (只要市場開盤就持續輪詢)
        this.baselinePricePollingInterval = setInterval(async () => {
            await this.fetchAndSetOpenPrice();
        }, POLL_INTERVAL_MS);
    }

    /**
     * 停止基準價輪詢
     */
    stopBaselinePricePolling() {
        if (this.baselinePricePollingInterval) {
            clearInterval(this.baselinePricePollingInterval);
            this.baselinePricePollingInterval = null;
            console.log('⏹️ 基準價輪詢已停止');
        }
    }

    /**
     * 開始盯盤 (非同步)
     */
    async startWatching() {
        if (this.isWatching || this.todayTradeDone) return;

        // 開始盯盤
        this.isWatching = true;
        console.log('👀 開始盯盤');
    }


    /**
     * 取得當前狀態
     */
    getStatus() {
        return {
            tradingPaused: this.tradingPaused,
            balance: this.balance,
            wins: this.wins,
            losses: this.losses,
            winRate: this.wins + this.losses > 0
                ? ((this.wins / (this.wins + this.losses)) * 100).toFixed(1) + '%'
                : '--',
            currentPrice: this.currentPrice,
            openPrice: this.todayOpenPrice,
            positions: this.positions,
            isWatching: this.isWatching,
            todayTradeDone: this.todayTradeDone,
            trades: this.trades,
            symbolInfo: this.symbolInfoCache[this.config.market.symbol] ? {
                name: this.symbolInfoCache[this.config.market.symbol].symbolName,
                holidays: this.symbolInfoCache[this.config.market.symbol].holidays?.length || 0,
                schedules: this.symbolInfoCache[this.config.market.symbol].schedule?.length || 0
            } : null,
            config: {
                entryOffset: this.entryOffset,
                longTP: this.longTP,
                shortTP: this.shortTP,
                longSL: this.longSL,
                shortSL: this.shortSL,
                lotSize: this.lotSize,
                minsAfterOpen: this.minsAfterOpen,
                baselineOffsetMinutes: this.baselineOffsetMinutes
            }
        };
    }

    /**
     * 更新策略參數（從 Dashboard）
     */
    updateConfig(newConfig) {
        if (newConfig.entryOffset !== undefined) this.entryOffset = parseFloat(newConfig.entryOffset);
        if (newConfig.longTP !== undefined) this.longTP = parseFloat(newConfig.longTP);
        if (newConfig.shortTP !== undefined) this.shortTP = parseFloat(newConfig.shortTP);
        if (newConfig.longSL !== undefined) this.longSL = parseFloat(newConfig.longSL);
        if (newConfig.shortSL !== undefined) this.shortSL = parseFloat(newConfig.shortSL);
        if (newConfig.lotSize !== undefined) this.lotSize = parseFloat(newConfig.lotSize);
        if (newConfig.minsAfterOpen !== undefined) this.minsAfterOpen = parseInt(newConfig.minsAfterOpen);
        if (newConfig.baselineOffsetMinutes !== undefined) this.baselineOffsetMinutes = parseInt(newConfig.baselineOffsetMinutes);

        console.log('⚙️ 策略參數已更新');
        this.saveState();
    }

    /**
     * 手動平倉（從 cTrader API 取得最新持倉，不使用快取）
     */
    async closeAllPositions() {
        try {
            // 直接從 cTrader API 取得最新持倉
            const positions = await this.getOpenPositions();

            if (positions.length === 0) {
                console.log('ℹ️ 目前無持倉');
                return;
            }

            console.log(`📊 準備平倉 ${positions.length} 個部位...`);

            for (const position of positions) {
                try {
                    // 處理 positionId 可能是 Long 物件
                    const positionId = typeof position.positionId === 'object' && position.positionId.toNumber
                        ? position.positionId.toNumber()
                        : position.positionId;

                    // volume 可能在 tradeData 或 position 中
                    const rawVolume = position.tradeData?.volume ?? position.volume;
                    const volume = typeof rawVolume === 'object' && rawVolume.toNumber
                        ? rawVolume.toNumber()
                        : rawVolume;

                    console.log(`📊 平倉 ID: ${positionId}, Volume: ${volume}`);

                    const ProtoOAClosePositionReq = this.connection.proto.lookupType('ProtoOAClosePositionReq');
                    const message = ProtoOAClosePositionReq.create({
                        ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
                        positionId: positionId,
                        volume: volume
                    });

                    await this.connection.send('ProtoOAClosePositionReq', message);
                    console.log(`✅ 已平倉部位 ID: ${positionId}`);
                } catch (error) {
                    console.error(`❌ 平倉失敗:`, error.message);
                }
            }
        } catch (error) {
            console.error('❌ 取得持倉失敗:', error.message);
        }
    }

    /**
     * 平倉
     */
    async closePosition(positionId) {
        try {
            // 轉換傳入的 positionId 為數字（可能是字串）
            const targetId = typeof positionId === 'string' ? parseInt(positionId) : positionId;

            // 先取得持倉的正確 volume
            const positions = await this.getOpenPositions();

            // 找到目標持倉（處理 positionId 可能是 Long 物件的情況）
            const position = positions.find(p => {
                const pId = typeof p.positionId === 'object' && p.positionId.toNumber
                    ? p.positionId.toNumber()
                    : parseInt(p.positionId);
                return pId === targetId;
            });

            if (!position) {
                console.warn(`⚠️ 找不到持倉 ID: ${positionId}`);
                return;
            }

            // volume 可能在 tradeData 或 position 中
            const rawVolume = position.tradeData?.volume ?? position.volume;
            const volume = typeof rawVolume === 'object' && rawVolume.toNumber
                ? rawVolume.toNumber()
                : rawVolume;

            console.log(`📊 平倉 ID: ${positionId}, Volume: ${volume}`);

            const ProtoOAClosePositionReq = this.connection.proto.lookupType('ProtoOAClosePositionReq');
            const message = ProtoOAClosePositionReq.create({
                ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
                positionId: targetId,
                volume: volume
            });

            await this.connection.send('ProtoOAClosePositionReq', message);
            console.log(`✅ 已平倉部位 ID: ${positionId}`);
        } catch (error) {
            console.error(`❌ 平倉失敗 (ID: ${positionId}):`, error.message);
        }
    }

    /**
     * 設定持倉的 SL/TP（基於基準點）
     * @param {number} positionId - 持倉 ID
     * @param {number} stopLoss - 止損價格（真實價格）
     * @param {number} takeProfit - 止盈價格（真實價格）
     */
    async setPositionSlTp(positionId, stopLoss, takeProfit) {
        try {
            const ProtoOAAmendPositionSLTPReq = this.connection.proto.lookupType('ProtoOAAmendPositionSLTPReq');
            const message = ProtoOAAmendPositionSLTPReq.create({
                ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
                positionId: positionId,
                stopLoss: stopLoss,
                takeProfit: takeProfit
            });

            await this.connection.send('ProtoOAAmendPositionSLTPReq', message);
            console.log(`✅ SL/TP 已設定: TP=${takeProfit.toFixed(2)}, SL=${stopLoss.toFixed(2)}`);
        } catch (error) {
            console.error('❌ 設定 SL/TP 失敗:', error.message);
            // 即使 SL/TP 設定失敗，訂單仍已成交，交易員需要手動處理
        }
    }
}

module.exports = ExecutionEngine;
