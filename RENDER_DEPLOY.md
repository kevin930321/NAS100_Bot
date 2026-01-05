# Render 部署教學

本教學說明如何將 NAS100 交易機器人部署到 [Render](https://render.com) 免費方案。

---

## 📋 前置準備

1. **GitHub 帳號** - 程式碼需上傳至 GitHub
2. **Render 帳號** - 使用 GitHub 登入即可
3. **cTrader API 憑證** - Client ID、Client Secret、Access Token
4. **MongoDB Atlas** - 雲端資料庫 (已有)

---

## 🚀 部署步驟

### Step 1：上傳程式碼至 GitHub

```bash
# 初始化 Git (如果還沒有)
git init

# 建立 .gitignore
echo "node_modules/" > .gitignore
echo ".env" >> .gitignore
echo "logs/" >> .gitignore

# 提交程式碼
git add .
git commit -m "Initial commit"

# 推送到 GitHub
git remote add origin https://github.com/你的帳號/nas100-bot.git
git push -u origin main
```

### Step 2：建立 Render 服務

1. 前往 [render.com](https://render.com) 並登入
2. 點擊 **New +** → **Web Service**
3. 連接你的 GitHub 儲存庫
4. 設定服務：

| 設定項目 | 值 |
|---------|-----|
| Name | `nas100-bot` |
| Region | `Singapore` (離台灣最近) |
| Branch | `main` |
| Runtime | `Node` |
| Build Command | `npm install` |
| Start Command | `node trading-bot.js` |
| Instance Type | `Free` |

### Step 3：設定環境變數

在 Render 的 **Environment** 區塊，新增以下變數：

| Key | Value |
|-----|-------|
| `CTRADER_CLIENT_ID` | 你的 Client ID |
| `CTRADER_CLIENT_SECRET` | 你的 Client Secret |
| `CTRADER_ACCESS_TOKEN` | 你的 Access Token |
| `CTRADER_REFRESH_TOKEN` | 你的 Refresh Token |
| `CTRADER_ACCOUNT_ID` | 你的帳戶 ID |
| `CTRADER_MODE` | `demo` 或 `live` |
| `MONGODB_URI` | `mongodb+srv://...` |
| `DISCORD_WEBHOOK_URL` | Discord Webhook (可選) |
| `DASHBOARD_USERNAME` | `admin` |
| `DASHBOARD_PASSWORD` | 你的密碼 |
| `TZ` | `Asia/Taipei` |

### Step 4：部署

1. 點擊 **Create Web Service**
2. 等待部署完成 (約 2-3 分鐘)
3. 部署成功後，會顯示網址如：`https://nas100-bot.onrender.com`

---

## ⚠️ 免費方案限制

| 限制 | 說明 |
|------|------|
| **休眠機制** | 15 分鐘無流量會休眠，下次請求需等 30-60 秒喚醒 |
| **每月時數** | 750 小時 (足夠單一服務 24/7 運行) |
| **無固定 IP** | 每次重啟 IP 會變 |

### 解決休眠問題

使用 **UptimeRobot** 每 5 分鐘 ping 一次：

1. 前往 [uptimerobot.com](https://uptimerobot.com) 註冊
2. 新增監控：
   - Monitor Type: `HTTP(s)`
   - URL: `https://nas100-bot.onrender.com/health`
   - Interval: `5 minutes`

---

## 🔧 維護指令

### 查看日誌
在 Render Dashboard → 你的服務 → **Logs**

### 手動重啟
在 Render Dashboard → 你的服務 → **Manual Deploy** → **Deploy latest commit**

### 更新程式碼
```bash
git add .
git commit -m "Update"
git push
```
Render 會自動偵測並重新部署。

---

## ✅ 驗證部署

1. 開啟 `https://你的服務.onrender.com`
2. 輸入帳號密碼登入
3. 確認連線狀態顯示 **🟢 已連線**
4. 確認 Discord 收到啟動通知

完成！🎉
