# NAS100 cTrader 自動交易機器人 - 專案全解說

## 1. 專案總覽 (Project Overview)

本專案是一個基於 **Node.js** 開發的高頻/日內交易機器人，專門針對 **NAS100 (Nasdaq 100)** 指數進行自動化交易。它透過 TCP 協議直接連接 **cTrader Open API**，具備極低的延遲特性，並整合了 **MongoDB** 進行狀態管理、**Express** 提供網頁監控面板、以及 **Discord** 即時通知。

### 核心技術棧
*   **語言**: Node.js (v18+)
*   **通訊協議**: TCP Socket + Google Protobuf (cTrader Open API 2.0)
*   **資料庫**: MongoDB (儲存交易狀態、持倉記錄、策略參數)
*   **監控介面**: Express.js + HTML5 Dashboard
*   **通知系統**: Discord Webhook

---

## 2. 交易策略邏輯 (Trading Strategy)

本機器人採用 **「日內均值回歸策略 (Intraday Mean Reversion)」**。

### 核心概念
假設市場在開盤後的劇烈波動最終會回歸到某個均值（此處以「當日開盤價」為基準）。當價格偏離基準過大時，預期價格會回調。

### 交易流程
1.  **鎖定開盤價**: 每日美股開盤（冬令 07:00 / 夏令 06:00 台北時間）後，機器人會抓取 D1 (日線) 的開盤價作為基準 (`todayOpenPrice`)。
2.  **進場條件**:
    *   **做空 (Short)**: 當 `現價` >= `開盤價` + `Entry Offset` (價格漲太多，預期回跌)。
    *   **做多 (Long)**: 當 `現價` ≤ `開盤價` - `Entry Offset` (價格跌太多，預期回升)。
3.  **出場條件**:
    *   **止盈 (TP)**: 固定點數獲利出場 (Long: 8點 / Short: 5點)。
    *   **止損 (SL)**: 固定點數保護 (1000點，主要防止災難性行情，實際上依賴均值回歸特性)。
4.  **頻率限制**:
    *   每個交易日（Session）僅執行 **1 筆** 交易。
    *   一旦開倉，當日任務標記為完成 (`todayTradeDone = true`)，直到下個交易日重置。

---

## 3. 系統架構詳解 (System Architecture)

專案由四個核心模組組成：

### A. 連線管理 (`CTraderConnection.js`)
負責與 cTrader Server 的底層通訊。
*   **Protobuf 處理**: 自動加載 `.proto` 定義檔，負責訊息的序列化與反序列化。
*   **Heartbeat**: 每 10 秒發送一次心跳包，維持 TCP 長連線。
*   **Auth 流程**: 處理 `ApplicationAuth` (應用程式授權) 與 `AccountAuth` (帳戶授權)。
*   **斷線重連**: 具備指數退避 (Exponential Backoff) 機制，斷線後會自動嘗試重連。

### B. 執行引擎 (`ExecutionEngine.js`) **(核心大腦)**
包含所有交易邏輯、狀態管理與風控機制。
*   **即時報價**: 監聽 `ProtoOASpotEvent`，即時計算進場訊號。
*   **持倉同步 (`reconcilePositions`)**:
    *   **新功能**: 啟動時會自動比對 MongoDB 紀錄與 cTrader 實際持倉。
    *   **時段判定**: 使用「開盤時間」而非「日曆日期」來判斷訂單是否屬於「今日」，完美解決跨日（凌晨）交易的誤判問題。
*   **交易執行**: 發送 `ProtoOANewOrderReq` 進行下單，並處理成交回報。
*   **安全機制**:
    *   **錯誤重試限制**: 若下單被拒（如資金不足），失敗計數器累加，超過 3 次強制停止當日交易，防止 API 濫用。
    *   **動態 Symbol**: 若找不到 `NAS100`，會自動搜尋 `US100`, `USTEC` 等替代代碼。

### C. 機器人控制器 (`trading-bot.js`)
負責協調各模組與排程任務。
*   **時間排程 (Cron)**: 每分鐘檢查是否到達美股開盤時間，觸發「每日重置」與「開始盯盤」。
*   **通知中心**: 接收引擎的事件（成交、平倉、錯誤），轉發至 Discord。
*   **Web Server**: 啟動 Express 伺服器，提供 API 與靜態頁面。

### D. 資料持久化 (`db.js`)
*   連接 MongoDB Atlas。
*   儲存機器人狀態（餘額、勝敗場數、當日是否已交易），確保重啟後狀態不丟失。

---

## 4. 關鍵運作流程 (Workflows)

### 啟動流程
1.  載入 `.env` 設定。
2.  連接 MongoDB，載入上次的狀態（勝率、餘額等）。
3.  建立 cTrader TCP 連線 -> App Auth -> Account Auth。
4.  **同步持倉**: 詢問 cTrader 當前持倉，判斷「今日」是否已交易過。
5.  啟動 Web Dashboard 與 Discord 通知。

### 每日循環 (美股開盤時)
1.  **時間檢查**: `trading-bot.js` 偵測到開盤時間（如 07:00）。
2.  **重置**: 呼叫 `resetDaily()`，將 `todayTradeDone` 設為 `false`，清空失敗計數器。
3.  **盯盤**: 呼叫 `startWatching()` -> 取得今日 D1 開盤價 -> 設為基準。
4.  **監聽**: 開始接收即時報價，等待價格觸發 `Entry Offset`。
5.  **下單**: 條件滿足 -> 發送市價單 -> 標記 `todayTradeDone = true` -> 停止盯盤。
6.  **結算**: 等待 TP 或 SL 觸發平倉 -> 更新餘額與勝率 -> 存入 MongoDB。

---

## 5. 設定參數說明 (.env)

| 變數名稱 | 說明 | 範例值 |
| :--- | :--- | :--- |
| `CTRADER_CLIENT_ID` | cTrader API 應用程式 ID | (從 Spotware 取得) |
| `CTRADER_ACCESS_TOKEN` | 交易帳戶授權 Token | (從 Spotware 取得) |
| `CTRADER_ACCOUNT_ID` | 您的 cTrader 帳號 ID | 12345678 |
| `CTRADER_MODE` | 模式 | `demo` 或 `live` |
| `MONGODB_URI` | 資料庫連線字串 | `mongodb+srv://...` |
| `ENTRY_OFFSET` | 進場偏移點數 | 10 |
| `LONG_TP` / `SHORT_TP` | 做多/做空止盈點數 | 8 / 5 |
| `BASE_LOT_SIZE` | 下單手數 | 0.1 |

---

## 6. 監控與操作

### Web Dashboard
*   **網址**: `http://localhost:3000` (或 Render 網址)
*   **功能**:
    *   查看即時價格、開盤價、價差。
    *   查看目前持倉與帳戶餘額。
    *   **緊急操作**: 手動切換盯盤狀態、強制平倉、重置今日狀態。
    *   **參數調整**: 線上修改 TP/SL 與 Offset，即時生效。

### Discord 通知
機器人會在以下情況發送通知：
*   機器人啟動 / 每日開盤盯盤開始。
*   **交易開倉**: 包含方向、價格、TP/SL。
*   **交易平倉**: 包含損益金額、最新餘額。
*   **嚴重錯誤**: 如連線失敗、下單連續被拒。

---

## 7. 部署指南 (Deployment)

### 使用 Docker (推薦)
```bash
# 建構映像檔
docker build -t nas100-bot .

# 執行容器
docker run -d --name bot --env-file .env -p 3000:3000 nas100-bot
```

### 使用 PM2 (一般 Server)
```bash
# 安裝依賴
npm install

# 啟動
pm2 start ecosystem.config.js
```

### 雲端部署 (Render/Heroku)
專案已包含 `process.env` 適配，可直接部署至支援 Node.js 的 PaaS 平台。需注意免費版平台可能休眠，需配合 UptimeRobot 使用。

---

## 8. 安全注意事項 (Safety Features)

1.  **防止過度交易**: 嚴格的 `todayTradeDone` 檢查與時段鎖定。
2.  **API 保護**: 內建 3 次失敗重試上限，防止因保證金不足導致的無限迴圈請求。
3.  **狀態恢復**: 即使伺服器重啟，機器人也會先從 MongoDB 讀取狀態，並與券商 Server 核對持倉，不會盲目下單。
4.  **智慧代碼**: 自動適應不同券商的 Symbol 名稱 (NAS100/US100)，減少設定錯誤風險。
