/**
 * ExecutionEngine - 交易執行引擎
 * 
 * 功能：
 * - 策略邏輯執行（均值回歸）
 * - 持倉管理
 * - 與 cTrader API 整合
 * - 狀態追蹤與持久化
 */

const EventEmitter = require('events');

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

        // 狀態追蹤
        this.balance = config.account.initialBalance;
        this.positions = [];
        this.todayTradeDone = false;
        this.todayOpenPrice = null;
        this.currentPrice = null;
        this.isWatching = false;
        this.isPlacingOrder = false; // 並發鎖
        this.orderFailureCount = 0; // 訂單失敗計數

        // 統計
        this.wins = 0;
        this.losses = 0;
        this.trades = [];

        // 緩存
        this.symbolInfoCache = {};

        // 綁定訊息處理
        this.connection.on('message', this.handleMarketData.bind(this));

        // 監聽 Account Auth 成功，自動訂閱報價（重連恢復機制的關鍵）
        this.connection.on('account-auth-success', () => {
            console.log('🔄 Account Auth 成功，重新訂閱報價並同步持倉...');
            this.subscribeToMarketData();
            this.reconcilePositions(); // 關鍵修復：斷線重連後必須確認持倉狀態
        });
    }

    /**
     * 初始化：從資料庫載入狀態
     */
    async initialize() {
        try {
            const state = await this.db.loadState();
            if (state) {
                // 注意：balance 不再從資料庫載入，現在從 cTrader API 即時取得
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
                    console.log('⚙️ 策略參數已從資料庫恢復');
                }

                console.log('✅ 狀態已從資料庫載入');
            }

            // 狀態對賬：詢問 cTrader 實際持倉
            await this.reconcilePositions();

            // 重要：啟動時強制清除盯盤狀態
            // 必須等待 07:01 的 cron 觸發才能開始盯盤
            // 這可以防止重啟後自動使用舊的開盤價開始交易
            this.isWatching = false;
            this.todayOpenPrice = null;
            console.log('⏳ 等待盯盤訊號 (07:01 cron 觸發)...');

        } catch (error) {
            console.error('❌ 初始化失敗:', error);
        }
    }

    /**
     * 狀態對賬：比對 MongoDB 與 cTrader 的持倉
     */
    async reconcilePositions() {
        try {
            // 請求當前持倉 (ProtoOAReconcileReq)
            const positions = await this.getOpenPositions();

            // 更新內部持倉列表
            this.positions = positions.map(p => {
                const side = p.tradeData.tradeSide; // 可能是 1 (BUY) 或 'BUY'
                const isBuy = side === 1 || side === 'BUY';
                return {
                    id: p.positionId,
                    type: isBuy ? 'long' : 'short',
                    entryPrice: p.price,
                    volume: p.volume,
                    openTime: new Date(p.tradeData.openTimestamp)
                };
            });

            if (this.positions.length > 0) {
                console.log(`⚠️ 偵測到 ${this.positions.length} 個未平倉部位，同步中...`);

                // 計算今日開盤時間 (Session Start Time)
                // 判斷夏令時間 (簡單實作)
                const now = new Date();
                const year = now.getFullYear();
                // 美股 DST: 3月第二個週日 ~ 11月第一個週日
                // 這裡用簡化版: 3/14 ~ 11/7 大約範圍，或是直接複製完整邏輯
                const isDst = this.checkIsUsDst(now);

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

    /**
     * 判斷美股夏令時間
     */
    checkIsUsDst(date) {
        const year = date.getFullYear();
        let dstStart = new Date(year, 2, 1);
        while (dstStart.getDay() !== 0) dstStart.setDate(dstStart.getDate() + 1);
        dstStart.setDate(dstStart.getDate() + 7); // 3月第2個週日

        let dstEnd = new Date(year, 10, 1);
        while (dstEnd.getDay() !== 0) dstEnd.setDate(dstEnd.getDate() + 1); // 11月第1個週日

        return date >= dstStart && date < dstEnd;
    }

    /**
     * 取得當前持倉
     */
    async getOpenPositions() {
        // 發送 ProtoOAReconcileReq
        const ProtoOAReconcileReq = this.connection.proto.lookupType('ProtoOAReconcileReq');
        const message = ProtoOAReconcileReq.create({
            ctidTraderAccountId: parseInt(this.config.ctrader.accountId)
        });

        const response = await this.connection.send('ProtoOAReconcileReq', message);
        const ProtoOAReconcileRes = this.connection.proto.lookupType('ProtoOAReconcileRes');
        const payload = ProtoOAReconcileRes.decode(response.payload);

        return payload.position || [];
    }

    /**
     * 取得帳戶資訊 (餘額、淨值、保證金等)
     */
    async getAccountInfo() {
        // 檢查是否已連線且已認證
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

    /**
     * 訂閱報價
     */
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

    /**
     * 取得 Symbol 資訊
     */
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
                const candidates = ['NAS100', 'US100', 'USTEC', 'QQQ', 'NAS100.cash', 'US100.cash'];

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

            // Fallback: 如果查詢失敗且是標準 NAS100
            if (symbolName === 'NAS100') {
                console.warn('⚠️ API 查詢失敗，使用預設值嘗試...');
                return { symbolId: 1, lotSize: 100, digits: 2 };
            }
            return null;
        }
    }

    /**
     * 處理市場數據
     */
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

    /**
     * 處理報價更新
     */
    handleSpotEvent(payload) {
        const ProtoOASpotEvent = this.connection.proto.lookupType('ProtoOASpotEvent');
        const spot = ProtoOASpotEvent.decode(payload);

        // 更新當前價格（使用 bid/ask 中間價）
        if (spot.bid && spot.ask) {
            // 修正：protobufjs Long 物件轉為 Number
            // SpotEvent 中的 bid/ask 是 uint64 (raw value)
            const bid = typeof spot.bid === 'number' ? spot.bid : (spot.bid.toNumber ? spot.bid.toNumber() : Number(spot.bid));
            const ask = typeof spot.ask === 'number' ? spot.ask : (spot.ask.toNumber ? spot.ask.toNumber() : Number(spot.ask));

            this.currentPrice = (bid + ask) / 2;

            // 執行策略邏輯
            this.executeStrategy();
        }
    }

    /**
     * 處理訂單執行事件
     */
    handleExecutionEvent(payload) {
        const ProtoOAExecutionEvent = this.connection.proto.lookupType('ProtoOAExecutionEvent');
        const execution = ProtoOAExecutionEvent.decode(payload);

        console.log('📨 訂單執行事件:', execution.executionType);

        // 處理訂單成交（開倉或平倉）
        if (execution.executionType === 'ORDER_FILLED') {
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

                    // 設定 SL/TP（基於開盤價）
                    if (this.pendingSlTp && execution.position) {
                        const positionId = execution.position.positionId;
                        this.setPositionSlTp(positionId, this.pendingSlTp.stopLoss, this.pendingSlTp.takeProfit);
                        this.pendingSlTp = null;
                    }

                    this.emit('order-filled', execution);
                }
            } else {
                // 向下相容舊邏輯 (雖然 ORDER_FILLED 通常都有 Deal)
                this.todayTradeDone = true;
                this.saveState();
                console.log('✅ 訂單成交，今日交易任務完成');
                this.emit('order-filled', execution);
            }
        }
        // 處理訂單被拒 (例如：保證金不足、市場關閉)
        else if (execution.executionType === 'ORDER_REJECTED') {
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

        // 計算損益 (Net Profit = Gross Profit + Swap + Commission)
        // 注意: 這些值都是 cents，需要除以 100 轉為金額
        const netProfitCents = detail.grossProfit + detail.swap + detail.commission;
        const netProfit = netProfitCents / 100;
        const balance = detail.balance / 100;

        console.log(`💰 交易平倉 ID: ${positionId} | 損益: $${netProfit.toFixed(2)} | 餘額: $${balance.toFixed(2)}`);

        // 更新狀態
        this.balance = balance;
        if (netProfit > 0) this.wins++;
        else this.losses++;

        // 記錄交易歷史
        const tradeRecord = {
            id: positionId,
            closeTime: new Date(deal.executionTimestamp),
            profit: netProfit,
            balance: this.balance,
            type: deal.tradeSide === 1 || deal.tradeSide === 'BUY' ? 'long' : 'short' // 1=BUY, 2=SELL
        };
        this.trades.unshift(tradeRecord);
        if (this.trades.length > 50) this.trades.pop(); // 只保留最近 50 筆

        // 從持倉列表中移除
        this.positions = this.positions.filter(p => p.id !== positionId);

        // 儲存狀態
        this.saveState();

        // 發送事件通知
        this.emit('trade-closed', tradeRecord);
    }

    /**
     * 檢查是否在交易時段內
     * 交易時段：台北時間 07:01 ~ 隔天 06:00 (對應美股交易時間)
     * 冬令: 開盤 07:30，收盤 06:00
     * 夏令: 開盤 06:30，收盤 05:00
     */
    isWithinTradingHours() {
        const now = new Date();
        const hour = now.getHours();
        const minute = now.getMinutes();
        const currentMinutes = hour * 60 + minute;

        // 判斷夏令/冬令
        const isDst = this.checkIsUsDst(now);

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
        if (!this.currentPrice || !this.todayOpenPrice) return;
        if (this.todayTradeDone || !this.isWatching) return;

        // 檢查是否在交易時段內 (台北時間 07:01 - 06:00 隔天，即美股交易時間)
        if (!this.isWithinTradingHours()) {
            return; // 非交易時段，不執行策略
        }

        // 修正：cTrader API v2 的 Raw Price 固定為真實價格 * 100,000
        // 不論 Symbol 的 digits 是多少 (例如 NAS100 是 2)，API 傳來的整數都是乘了 10^5
        // 因此，我們的 Offset 也必須乘上 100,000 才能進行比較
        const multiplier = 100000;

        const diff = this.currentPrice - this.todayOpenPrice;
        const offsetRaw = this.entryOffset * multiplier;

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

            // 計算基於開盤價的 TP/SL 絕對價格
            // 策略：TP/SL 是相對於「開盤價」而非「成交價」
            const apiMultiplier = 100000;
            const openPriceReal = this.todayOpenPrice / apiMultiplier;

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
                label: 'NAS100_MR'
            });

            const currentPriceReal = this.currentPrice / apiMultiplier;
            console.log(`${type === 'long' ? '📈' : '📉'} 開${type === 'long' ? '多' : '空'} | Price: ${currentPriceReal.toFixed(2)} | 目標TP: ${tpPriceReal.toFixed(2)} | 目標SL: ${slPriceReal.toFixed(2)}`);

            const response = await this.connection.send('ProtoOANewOrderReq', order);

            console.log('📨 訂單發送成功，等待執行（SL/TP 將在成交後設定）...');

            // 發送 Discord 通知
            this.emit('trade-opened', {
                type,
                price: this.currentPrice,
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
     * 設定今日開盤價
     */
    setTodayOpenPrice(price) {
        this.todayOpenPrice = price;
        console.log(`📊 今日開盤價: ${price}`);
    }

    /**
     * 每日重置
     * @param {boolean} force - 強制重置，忽略資料庫檢查
     */
    async resetDaily(force = false) {
        const todayStr = new Date().toDateString();

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
                // 注意：balance 不再儲存，因為從 cTrader API 即時取得
                wins: this.wins,
                losses: this.losses,
                trades: this.trades,
                todayTradeDone: this.todayTradeDone,
                lastResetDate: this.lastResetDate, // 新增：保存重置日期
                // positions 不再儲存，直接從 cTrader API 即時取得
                config: {
                    entryOffset: this.entryOffset,
                    longTP: this.longTP,
                    shortTP: this.shortTP,
                    longSL: this.longSL,
                    shortSL: this.shortSL,
                    lotSize: this.lotSize
                },
                lastUpdate: new Date()
            };

            await this.db.saveState(state);
        } catch (error) {
            console.error('❌ 儲存狀態失敗:', error);
        }
    }
    async fetchDailyOpenPrice() {
        console.log('🔄 正在從 cTrader 獲取今日開盤價 (M1 at Open Time)...');
        try {
            const ProtoOAGetTrendbarsReq = this.connection.proto.lookupType('ProtoOAGetTrendbarsReq');
            const ProtoOATrendbarPeriod = this.connection.proto.lookupEnum('ProtoOATrendbarPeriod');

            const symbolData = await this.getSymbolInfo(this.config.market.symbol);
            if (!symbolData) throw new Error('Symbol info not found');

            // 計算今天的開盤時間
            const now = new Date();
            const isDst = this.checkIsUsDst(now);
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
                console.warn('⚠️ 當前時間早於今日開盤時間，嘗試獲取昨日開盤價...');
                openTimeTaipei.setDate(openTimeTaipei.getDate() - 1);
            }

            // 將台北時間轉回 UTC timestamp (供 API 使用)
            const openTimeUtc = openTimeTaipei.getTime() - TAIPEI_OFFSET - openTimeTaipei.getTimezoneOffset() * 60 * 1000;

            console.log(`📅 鎖定開盤時間: ${openTimeTaipei.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })} (台北時間)`);

            // 請求該分鐘的 M1 K 線
            // 請求前後 5 分鐘的 K 線，確保能包含到 07:00
            // 有時候 API 邊界處理可能會漏掉剛好在起始點的資料
            const fromTimestamp = openTimeUtc - 60000; // 提早 1 分鐘
            const toTimestamp = openTimeUtc + 300000;  // 往後 5 分鐘

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
                // 尋找時間戳記剛好等於 openTimeUtc 的 K 線
                // cTrader Trendbar timestamp 是 UTC 分鐘數 (沒有毫秒)
                // 我們可以直接比對 utcTimestampInMinutes
                const targetMinute = Math.floor(openTimeUtc / 60000);

                const targetBar = payload.trendbar.find(bar => bar.utcTimestampInMinutes === targetMinute);

                if (targetBar) {
                    const low = typeof targetBar.low === 'number' ? targetBar.low : targetBar.low.toNumber();
                    const deltaOpen = typeof targetBar.deltaOpen === 'number' ? targetBar.deltaOpen : (targetBar.deltaOpen ? targetBar.deltaOpen.toNumber() : 0);
                    const openPrice = low + deltaOpen;

                    // Debug: 顯示這根 K 線的實際時間
                    const barTimeUtc = targetBar.utcTimestampInMinutes * 60000;
                    const barTimeTaipei = new Date(barTimeUtc).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
                    console.log(`🔍 [Debug] K線時間: ${barTimeTaipei} (UTC: ${new Date(barTimeUtc).toISOString()})`);

                    console.log(`✅ 取得 cTrader 精確開盤價 (${openTimeTaipei.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' })}): ${openPrice} (Raw Points)`);
                    return openPrice;
                } else {
                    console.warn(`⚠️ 找到 K 線資料，但沒有 07:00 整的資料 (最近: ${new Date(payload.trendbar[0].utcTimestampInMinutes * 60000).toISOString()})`);

                    // 如果真的沒有 07:00，是否要用最接近的一根？
                    // 目前先回傳 null 讓它重試
                    return null;
                }
            } else {
                console.warn('⚠️ 該時間範圍內無 K 線資料');
                return null;
            }
        } catch (error) {
            console.error('❌ 取得開盤價失敗:', error.message);
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
     * 取得並設定開盤價（新交易日時呼叫）
     * 與 startWatching 分離，讓取得開盤價可以提早執行
     * @param {number} retryCount - 當前重試次數（內部使用）
     */
    async fetchAndSetOpenPrice(retryCount = 0) {
        const MAX_RETRIES = 1;
        const RETRY_DELAY_MS = 30000; // 30 秒

        if (this.todayOpenPrice !== null) {
            console.log('ℹ️ 已有開盤價，跳過取得');
            return true;
        }
        if (this.isFetchingOpenPrice) return false;

        this.isFetchingOpenPrice = true;
        try {
            // 先檢查市場是否開放
            const marketStatus = await this.checkMarketStatus();
            if (!marketStatus.isOpen) {
                console.log(`🚫 市場未開放: ${marketStatus.reason}`);
                return false;
            }

            const price = await this.fetchDailyOpenPrice();
            if (price !== null) {
                this.setTodayOpenPrice(price);
                console.log('✅ 開盤價已鎖定，等待盯盤時間...');
                return true;
            } else {
                // 失敗，嘗試重試
                if (retryCount < MAX_RETRIES) {
                    console.warn(`⚠️ 尚未取得有效開盤價，${RETRY_DELAY_MS / 1000} 秒後重試 (${retryCount + 1}/${MAX_RETRIES})...`);
                    this.isFetchingOpenPrice = false; // 先釋放鎖

                    // 設定延遲重試
                    setTimeout(() => {
                        this.fetchAndSetOpenPrice(retryCount + 1);
                    }, RETRY_DELAY_MS);

                    return false;
                } else {
                    console.error('❌ 多次重試後仍無法取得開盤價，將在盯盤時間再次嘗試');
                    return false;
                }
            }
        } finally {
            this.isFetchingOpenPrice = false;
        }
    }

    /**
     * 開始盯盤 (非同步)
     * 如果已有開盤價，直接開始盯盤；否則嘗試取得
     */
    async startWatching() {
        if (this.isWatching || this.todayTradeDone) return;

        // 如果還沒有開盤價，嘗試取得
        if (this.todayOpenPrice === null) {
            const success = await this.fetchAndSetOpenPrice();
            if (!success) {
                console.warn('⚠️ 無法取得開盤價，暫停盯盤');
                return;
            }
        }

        // 開始盯盤
        this.isWatching = true;
        console.log('👀 開始盯盤');
    }


    /**
     * 取得當前狀態（即時從 cTrader API 取得）
     */
    async getStatus() {
        // 即時取得帳戶資訊和持倉
        let accountInfo = {};
        let livePositions = [];

        try {
            if (this.connection && this.connection.authenticated) {
                // 取得帳戶資訊
                accountInfo = await this.getAccountInfo();

                // 取得即時持倉
                const rawPositions = await this.getOpenPositions();
                livePositions = rawPositions.map(p => {
                    const side = p.tradeData?.tradeSide;
                    const isBuy = side === 1 || side === 'BUY';
                    const positionId = typeof p.positionId === 'object' && p.positionId.toNumber
                        ? p.positionId.toNumber() : p.positionId;
                    const volume = typeof p.volume === 'object' && p.volume.toNumber
                        ? p.volume.toNumber() : p.volume;

                    return {
                        id: positionId,
                        type: isBuy ? 'long' : 'short',
                        entryPrice: p.price,
                        volume: volume / 100, // 轉為 lots
                    };
                });
            }
        } catch (error) {
            console.error('⚠️ 取得即時狀態失敗:', error.message);
        }

        return {
            connected: this.connection?.connected || false,
            authenticated: this.connection?.authenticated || false,
            balance: accountInfo.balance || this.balance || 0,
            equity: accountInfo.equity || 0,
            usedMargin: accountInfo.usedMargin || 0,
            freeMargin: accountInfo.freeMargin || 0,
            unrealizedPnL: accountInfo.unrealizedPnL || 0,
            leverage: accountInfo.leverage || 0,
            wins: this.wins,
            losses: this.losses,
            winRate: this.wins + this.losses > 0
                ? ((this.wins / (this.wins + this.losses)) * 100).toFixed(1) + '%'
                : '--',
            currentPrice: this.currentPrice,
            openPrice: this.todayOpenPrice,
            positions: livePositions,
            isWatching: this.isWatching,
            todayTradeDone: this.todayTradeDone,
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
                lotSize: this.lotSize
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

                    const volume = typeof position.volume === 'object' && position.volume.toNumber
                        ? position.volume.toNumber()
                        : position.volume;

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

            const volume = typeof position.volume === 'object' && position.volume.toNumber
                ? position.volume.toNumber()
                : position.volume;

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
     * 設定持倉的 SL/TP（基於開盤價）
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
