# US30 均值回歸交易機器人

🤖 基於 cTrader Open API 的 US30 均值回歸自動交易系統

---

## ✨ 功能特色

- 📈 **均值回歸策略** - 基於開盤基準點進行多空判斷
- 🔌 **cTrader Open API** - 支援 Demo/Live 帳戶
- 💻 **Web Dashboard** - 即時監控介面 (Socket.IO)
- 📊 **績效圖表** - Chart.js 視覺化交易歷史
- 🔔 **Discord 通知** - 交易事件即時推送
- 🗄️ **MongoDB 持久化** - 狀態與策略參數儲存
- ⏰ **自動排程** - 開盤時間自動盯盤
- 🔄 **自動重連** - 斷線自動恢復 + 看門狗機制

---

## 📁 專案結構

```
NAS100_Bot/
├── trading-bot.js      # 主程式入口 + Express Dashboard
├── ExecutionEngine.js  # 交易執行引擎
├── CTraderConnection.js# cTrader API 連線管理
├── config.js           # 設定檔
├── db.js               # MongoDB 資料層
├── utils.js            # 共用工具函數
├── logger.js           # 結構化日誌 (pino)
├── errors.js           # 自定義錯誤類別
├── public/
│   └── dashboard.html  # Web Dashboard
├── proto/              # cTrader Protobuf 定義
├── .env                # 環境變數 (需自行建立)
└── package.json
```

---

## 🛠️ 安裝與執行

### 前置需求

- Node.js 18+
- MongoDB (MongoDB Atlas 或本地)
- cTrader API 憑證

### 安裝

```bash
git clone https://github.com/kevin930321/NAS100_Bot.git
cd NAS100_Bot
npm install
```

### 環境變數設定

建立 `.env` 檔案：

```env
# cTrader API
CTRADER_CLIENT_ID=你的ClientID
CTRADER_CLIENT_SECRET=你的ClientSecret
CTRADER_ACCESS_TOKEN=你的AccessToken
CTRADER_REFRESH_TOKEN=你的RefreshToken
CTRADER_ACCOUNT_ID=你的帳戶ID
CTRADER_MODE=demo  # demo 或 live

# MongoDB
MONGODB_URI=mongodb+srv://...連線字串...

# Dashboard
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=你的密碼
PORT=3000

# Discord 通知 (可選)
DISCORD_WEBHOOK_URL=
DISCORD_ENABLED=false
```

### 啟動

```bash
# 開發模式
npm run dev

# 生產模式 (PM2)
pm2 start trading-bot.js --name nas100-bot
pm2 save
```

---

## 📊 Dashboard

存取 `http://localhost:3000` 查看即時交易狀態：

- 🟢 連線狀態
- 💰 帳戶餘額 / 淨值
- 📈 持倉列表 (可手動平倉)
- 📉 績效曲線圖表
- ⚙️ 策略參數調整
- 📜 即時日誌

---

## ⚙️ 策略參數

| 參數 | 說明 | 預設值 |
|-----|------|:-----:|
| Entry Offset | 進場偏移點數 | 10 |
| Long TP | 多單止盈點數 | 8 |
| Short TP | 空單止盈點數 | 5 |
| Long SL | 多單止損點數 | 1000 |
| Short SL | 空單止損點數 | 1000 |
| Lot Size | 交易手數 | 0.1 |
| 盯盤開始 | 開盤後幾分鐘開始 | 1 |
| 基準偏移 | 基準點偏移分鐘 | 0 |

## 🚀 GCP 免費雲端部署

Google Cloud 提供**終身免費**的 e2-micro VM，非常適合部署此交易機器人！

### 免費額度

| 項目 | 免費額度 |
|-----|---------|
| VM 機型 | e2-micro (2 vCPU, 1GB) |
| 硬碟 | 30 GB 標準 HDD |
| 區域 | us-west1 / us-central1 / us-east1 |
| 對外流量 | 1 GB/月 |

### Step 1：建立 GCP 專案

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 點擊頂部的專案選擇器 → **新增專案**
3. 專案名稱：`nas100-bot`
4. 點擊**建立**

### Step 2：建立 VM 執行個體

1. 左側選單 → **Compute Engine** → **VM 執行個體**
2. 點擊 **建立執行個體**

**⚠️ 重要設定（避免收費）：**

| 設定項目 | 值 |
|---------|-----|
| 名稱 | `nas100-bot` |
| 區域 | `us-west1 (Oregon)` ← 離台灣最近 |
| 機器類型 | `e2-micro (2 vCPU, 1GB)` ← **必須選這個！** |
| 開機硬碟 | Ubuntu 22.04 LTS, **20-30GB 標準永久磁碟** (不要選 SSD) |
| 防火牆 | ☑️ 允許 HTTP / HTTPS 流量 |
| 網路服務級別 | **標準級** (不是進階級) |
| 資料保護 | **無備份** |
| 觀測能力 | **取消勾選 Ops Agent** |

3. 點擊**建立**

### Step 3：連線並安裝環境

1. 在 VM 列表中，點擊 **SSH** 按鈕
2. 執行以下命令：

```bash
# 更新系統
sudo apt update && sudo apt upgrade -y

# 安裝 Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs git

# 安裝 PM2
sudo npm install -g pm2

# 驗證安裝
node -v  # v18.x.x
pm2 -v
```

### Step 4：下載並設定程式

```bash
# 複製程式碼
git clone https://github.com/kevin930321/NAS100_Bot.git
cd NAS100_Bot
npm install

# 建立環境變數
nano .env
```

貼上 `.env` 內容（參考上方環境變數設定），按 `Ctrl+O` 儲存，`Ctrl+X` 離開。

### Step 5：啟動機器人

```bash
# 使用 PM2 啟動
pm2 start trading-bot.js --name nas100-bot

# 設定開機自動啟動
pm2 startup
pm2 save

# 查看日誌
pm2 logs nas100-bot
```

### Step 6：設定防火牆

1. GCP Console → **VPC 網路** → **防火牆**
2. **建立防火牆規則**：
   - 名稱：`allow-dashboard`
   - 來源 IP：`0.0.0.0/0`
   - TCP 埠：`3000`

### Step 7：存取 Dashboard

複製 VM 的**外部 IP**，在瀏覽器開啟：`http://外部IP:3000`

### 常用 PM2 指令

```bash
pm2 status              # 查看狀態
pm2 logs nas100-bot     # 查看日誌
pm2 restart nas100-bot  # 重啟
pm2 stop nas100-bot     # 停止

# 更新程式碼
git pull && npm install && pm2 restart nas100-bot
```

---

## 📝 API 端點

| 路徑 | 方法 | 說明 |
|-----|:----:|------|
| `/` | GET | Dashboard 頁面 |
| `/health` | GET | 健康檢查 (UptimeRobot) |
| `/api/status` | GET | 取得機器人狀態 |
| `/api/action` | POST | 執行操作 |

### 可用操作 (POST /api/action)

```json
{ "action": "toggleWatch" }       // 切換盯盤
{ "action": "reset" }             // 重置今日狀態
{ "action": "closePositions" }    // 緊急平倉所有
{ "action": "closePosition", "positionId": 123 }  // 平倉指定持倉
{ "action": "fetchOpenPrice" }    // 取得基準點
{ "action": "updateConfig", "config": {...} }    // 更新策略參數
```

---

## ⚠️ 注意事項

1. **風險警告** - 自動交易有風險，請先使用 Demo 帳戶測試
2. **Token 自動更新** - cTrader Access Token 約 30 天過期，系統會自動刷新（需設定 Refresh Token）
3. **時區** - 系統使用台北時間 (Asia/Taipei)
4. **網路** - 需穩定網路連線，建議使用雲端 VPS

---

## 📄 授權

MIT License