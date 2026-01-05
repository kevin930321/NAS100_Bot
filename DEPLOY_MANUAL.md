# NAS100 真實交易機器人 - 部署手冊

本手冊將引導您完成從申請 API 憑證到成功部署於 Render 的所有步驟。

---

## 📋 前置準備

在開始之前，請確保您擁有以下帳號：

- ✅ **Pepperstone cTrader 帳戶**（Demo 或 Live）
- ✅ **MongoDB Atlas 免費帳戶**
- ✅ **Render 帳戶**（免費版即可）
- ✅ **Discord 帳戶**（用於接收通知）
- ✅ **GitHub 帳戶**（用於程式碼託管與 Render 部署）

---

## 第一步：申請 cTrader Open API 憑證

### 1.1 註冊 Spotware Connect

1. 前往 https://connect.spotware.com/
2. 點擊右上角 **Sign Up** 註冊帳號
3. 使用您的 Email 完成註冊與驗證

### 1.2 建立 Application

1. 登入後，點擊 **Applications** > **Create New**
2. 填寫應用程式資訊：
   - **Name**: `NAS100 Trading Bot`
   - **Redirect URI**: `http://localhost:3000/callback` （本地測試用）
   - **Scope**: 選擇 `trading`

3. 送出後，您會取得：
   - **Client ID**：例如 `12345_abc...`
   - **Client Secret**：例如 `xyz123...`

### 1.3 取得 Access Token

這是最關鍵的一步。由於 OAuth2 流程較為複雜，建議使用 Spotware 官方提供的工具：

#### 方法一：使用官方 Playground（推薦）

1. 前往 https://connect.spotware.com/apps
2. 選擇您剛建立的 Application
3. 點擊 **Sanbox**
4. **Scope**: 選擇 `Account info and trading`
5. 點擊 **Get token**
6. 授權後，您會看到：
   - **Access Token**
   - **Refresh Token**
   - **Account ID**（ctidTraderAccountId）

#### 方法二：手動 OAuth2 流程

如果您熟悉 OAuth2，可以參考 Spotware 文檔手動完成流程。

> **⚠️ 重要**：Access Token 有效期為 1 年，請妥善保管並設定行事曆提醒更新。

---

## 第二步：設定 MongoDB Atlas

### 2.1 建立免費 Cluster

1. 前往 https://www.mongodb.com/cloud/atlas/register
2. 註冊並登入 MongoDB Atlas
3. 點擊 **Build a Database** > 選擇 **FREE** 方案
4. 選擇雲端提供商與區域（建議選 **AWS** + **us-east-1**，與 Render 同區）
5. Cluster 名稱保持預設即可，點擊 **Create**

### 2.2 設定資料庫使用者

1. 在左側選單點擊 **Database Access**
2. 點擊 **Add New Database User**
3. 設定：
   - **Authentication Method**: Password
   - **Username**: `trading-bot`
   - **Password**: 自動生成或自訂（請記住此密碼）
   - **Database User Privileges**: `Read and write to any database`
4. 點擊 **Add User**

### 2.3 設定網路存取

1. 在左側選單點擊 **Network Access**
2. 點擊 **Add IP Address**
3. 選擇 **Allow Access from Anywhere** (`0.0.0.0/0`)
   - 這是因為 Render 的 IP 是動態的
4. 點擊 **Confirm**

### 2.4 取得連線字串

1. 回到 **Database** 頁面
2. 點擊您的 Cluster 旁的 **Connect**
3. 選擇 **Connect your application**
4. 複製連線字串，格式類似：
   ```
   mongodb+srv://trading-bot:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
5. 將 `<password>` 替換為您剛才設定的密碼

---

## 第三步：下載 Protobuf 定義檔

> **必須步驟**：cTrader Open API 使用 Protobuf 通訊協議。

### 3.1 下載檔案

在您的專案 `proto/` 目錄下，執行以下指令：

**Windows (PowerShell)**:
```powershell
$baseUrl = "https://raw.githubusercontent.com/spotware/openapi-proto-messages/master"
$files = @("OpenApiMessages.proto", "OpenApiCommonMessages.proto", "OpenApiModelMessages.proto", "OpenApiCommonModelMessages.proto")
mkdir proto -Force
foreach ($file in $files) {
    Invoke-WebRequest -Uri "$baseUrl/$file" -OutFile "proto\$file"
}
```

**Linux / Mac**:
```bash
# 進入 proto 目錄
mkdir -p proto && cd proto

# 下載定義檔
curl -O https://raw.githubusercontent.com/spotware/openapi-proto-messages/master/OpenApiMessages.proto
curl -O https://raw.githubusercontent.com/spotware/openapi-proto-messages/master/OpenApiCommonMessages.proto
curl -O https://raw.githubusercontent.com/spotware/openapi-proto-messages/master/OpenApiModelMessages.proto
curl -O https://raw.githubusercontent.com/spotware/openapi-proto-messages/master/OpenApiCommonModelMessages.proto
```

### 3.2 手動下載

1. 前往 https://github.com/spotware/openapi-proto-messages
2. 下載上述 4 個 `.proto` 檔案並放入 `proto/` 目錄。

---

## 第四步：設定環境變數

### 4.1 建立本地 .env 檔案

從 `.env.example` 複製一份為 `.env`：

```bash
cp .env.example .env
```

### 4.2 填入真實憑證

編輯 `.env`，填入您在前面步驟取得的值：

```env
# cTrader Open API 憑證
CTRADER_CLIENT_ID=你的_Client_ID
CTRADER_CLIENT_SECRET=你的_Client_Secret
CTRADER_ACCESS_TOKEN=你的_Access_Token
CTRADER_REFRESH_TOKEN=你的_Refresh_Token

# cTrader 帳戶設定
CTRADER_MODE=demo  # 或 live（真實交易請小心！）
CTRADER_ACCOUNT_ID=你的_Account_ID

# MongoDB 連線
MONGODB_URI=mongodb+srv://trading-bot:你的密碼@cluster0.xxxxx.mongodb.net/nas100-bot

# Discord 通知（下一步設定）
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/你的_Webhook_URL

# 其他設定
PORT=3000
NODE_ENV=production
```

---

## 第五步：設定 Discord Webhook

### 5.1 建立 Webhook

1. 在您的 Discord 伺服器中，選擇一個頻道
2. 點擊頻道設定（齒輪圖示）> **整合** > **Webhooks**
3. 點擊 **新 Webhook**
4. 設定名稱為 `NAS100 Bot`
5. 複製 **Webhook URL**

### 5.2 填入 .env

將剛才複製的 URL 填入 `.env` 的 `DISCORD_WEBHOOK_URL`。

---

## 第六步：部署至 Render

### 6.1 推送程式碼至 GitHub

1. 在專案根目錄初始化 Git（如果尚未）：
   ```bash
   git init
   git add .
   git commit -m "Initial commit: NAS100 Trading Bot"
   ```

2. 在 GitHub 建立新 Repository（名稱如 `nas100-trading-bot`）

3. 推送程式碼：
   ```bash
   git remote add origin https://github.com/你的用戶名/nas100-trading-bot.git
   git branch -M main
   git push -u origin main
   ```

> **⚠️ 重要**：確保 `.env` 檔案已在 `.gitignore` 中，**絕不要**將它推送到 GitHub！

### 6.2 連接 Render

1. 前往 https://render.com/ 並登入
2. 點擊 **New +** > **Web Service**
3. 選擇 **Connect a repository**
4. 授權 GitHub 並選擇您的 `nas100-trading-bot` Repository

### 6.3 設定 Render Service

填寫設定：

| 欄位 | 值 |
|------|-----|
| **Name** | `nas100-trading-bot` |
| **Environment** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Plan** | Free（或 Starter $7/月 for 24/7） |

### 6.4 設定環境變數

在 **Environment Variables** 區塊，點擊 **Add Environment Variable**，逐一新增以下變數（從您的 `.env` 複製值）：

- `CTRADER_CLIENT_ID`
- `CTRADER_CLIENT_SECRET`
- `CTRADER_ACCESS_TOKEN`
- `CTRADER_REFRESH_TOKEN`
- `CTRADER_MODE`
- `CTRADER_ACCOUNT_ID`
- `MONGODB_URI`
- `DISCORD_WEBHOOK_URL`
- `NODE_ENV` = `production`

### 6.5 部署

點擊 **Create Web Service**，Render 將自動：
1. Clone 您的 Repository
2. 執行 `npm install`
3. 執行 `npm start`

等待約 2-3 分鐘，部署完成後您會看到狀態變為 **Live**。

---

## 第七步：設定 UptimeRobot（防止休眠）

> **關鍵步驟**：Render 免費版會在閒置 15 分鐘後休眠，我們使用 UptimeRobot 保持活躍。

### 7.1 註冊 UptimeRobot

1. 前往 https://uptimerobot.com/signUp
2. 註冊免費帳戶

### 7.2 建立監控

1. 登入後點擊 **Add New Monitor**
2. 設定：
   - **Monitor Type**: HTTP(s)
   - **Friendly Name**: `NAS100 Bot Health Check`
   - **URL**: `https://你的-render-網址.onrender.com/health`
   - **Monitoring Interval**: 5 minutes
3. 點擊 **Create Monitor**

現在 UptimeRobot 每 5 分鐘會 Ping 一次您的機器人，防止 Render 休眠。

---

## 第八步：驗證部署

### 8.1 檢查 Render 日誌

1. 在 Render Dashboard 點擊您的 Service
2. 查看 **Logs** 頁籤
3. 應該看到類似以下的訊息：
   ```
   ✅ Protobuf 定義檔載入成功
   📡 正在連接 cTrader demo 伺服器...
   ✅ TCP 連線建立成功
   ✅ Application Auth 成功
   ✅ Account Auth 成功
   📊 已訂閱 NAS100 報價
   ✅ 機器人初始化完成
   🚀 交易機器人啟動
   🌐 Web Dashboard 啟動於 http://localhost:3000
   ```

### 8.2 訪問 Dashboard

1. 在瀏覽器開啟：`https://你的-render-網址.onrender.com`
2. 您應該看到 Web Dashboard 顯示：
   - 帳戶餘額
   - 連線狀態
   - 即時價格
   - 交易記錄

### 8.3 測試 Discord 通知

等待機器人啟動後，您應該在 Discord 頻道收到通知：
```
**NAS100 真實交易機器人已啟動**
目前為美股 冬令時間
等待 **07:01** 開始盯盤...
```

---

## 故障排除

### 問題：Render 顯示 "Build failed"

**可能原因**：
- `package.json` 有誤
- Protobuf 檔案未正確放入 `proto/` 目錄

**解決方案**：
1. 檢查 Render Build Log找出錯誤
2. 確保 `proto/` 目錄包含所有 `.proto` 檔案
3. 推送修正後重新部署

### 問題：Logs 顯示 "MongoDB 連線失敗"

**可能原因**：
- MongoDB URI 錯誤
- IP 白名單未設為 `0.0.0.0/0`

**解決方案**：
1. 確認 `MONGODB_URI` 環境變數正確
2. 檢查 MongoDB Atlas Network Access 設定

### 問題：Logs 顯示 "❌ API 錯誤: INVALID_TOKEN"

**可能原因**：
- Access Token 過期或錯誤
- Account ID 錯誤

**解決方案**：
1. 重新從 Spotware Connect 取得新的 Access Token
2. 確認 `CTRADER_ACCOUNT_ID` 正確

---

## 安全提醒

⚠️ **請務必遵守以下安全原則**：

1. **絕不分享** Access Token 或 Client Secret
2. **定期更新** Access Token（每年）
3. **先用 Demo 帳戶測試**，確認無誤後再使用 Live 帳戶
4. **設定最大虧損限制**，避免資金風險
5. **定期檢查** Discord 通知與 Dashboard，確保機器人運作正常

---

## 下一步

恭喜！您的 NAS100 真實交易機器人已成功部署。

**建議的後續動作**：

1. **觀察 2-4 週**：在 Demo 帳戶上運行，監控交易決策
2. **調整參數**：透過 Dashboard 修改 Entry Offset, TP, SL 等參數
3. **設定警示**：在 Discord 啟用通知聲音，及時掌握交易動態
4. **備份策略**：定期備份 MongoDB 資料

**需要支援？**

- 查看 `walkthrough.md` 了解架構細節
- 查看 `trading-bot.js` 中的註解理解邏輯
- 檢查 Render Logs 與 Discord 訊息找出問題

祝您交易順利！🚀
