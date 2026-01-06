# Google Cloud Platform 免費 VPS 部署教學

本教學說明如何在 Google Cloud Platform (GCP) 的免費 e2-micro VM 上部署 NAS100 交易機器人。

---

## 📋 前置準備

1. **Google 帳號**
2. **信用卡** (驗證用，不會扣款)
3. **GitHub 上的程式碼**

---

## 🚀 部署步驟

### Step 1：建立 GCP 專案

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 點擊頂部的專案選擇器 → **新增專案**
3. 專案名稱：`nas100-bot`
4. 點擊**建立**

---

### Step 2：建立 VM 執行個體

1. 在左側選單找到 **Compute Engine** → **VM 執行個體**
2. 首次使用需等待 API 啟用 (約 1-2 分鐘)
3. 點擊 **建立執行個體**

#### VM 設定

| 設定項目 | 值 |
|---------|-----|
| 名稱 | `nas100-bot` |
| 區域 | `us-west1 (Oregon)` 或 `us-central1 (Iowa)` |
| 機器類型 | `e2-micro (2 vCPU, 1GB)` ← 免費方案 |
| 開機磁碟 | Ubuntu 22.04 LTS, 30GB 標準磁碟 |
| 防火牆 | ☑️ 允許 HTTP 流量 |

4. 點擊**建立**

---

### Step 3：連線到 VM

1. 在 VM 列表中，點擊 **SSH** 按鈕
2. 等待瀏覽器 SSH 視窗開啟

---

### Step 4：安裝環境

在 SSH 視窗中執行以下命令：

```bash
# 更新系統
sudo apt update && sudo apt upgrade -y

# 安裝 Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# 安裝 Git 和 PM2
sudo apt install -y git
sudo npm install -g pm2

# 確認安裝
node -v  # 應顯示 v18.x.x
pm2 -v   # 應顯示版本號
```

---

### Step 5：下載程式碼

```bash
# 複製你的 GitHub 儲存庫
git clone https://github.com/你的帳號/NAS100_Bot.git
cd NAS100_Bot

# 安裝依賴
npm install
```

---

### Step 6：設定環境變數

```bash
# 建立 .env 檔案
nano .env
```

貼上以下內容 (記得修改成你的值)：

```env
# cTrader API
CTRADER_CLIENT_ID=你的ClientID
CTRADER_CLIENT_SECRET=你的ClientSecret
CTRADER_ACCESS_TOKEN=你的AccessToken
CTRADER_REFRESH_TOKEN=你的RefreshToken
CTRADER_ACCOUNT_ID=45795812
CTRADER_MODE=demo

# MongoDB
MONGODB_URI=mongodb+srv://...你的連線字串...

# Dashboard
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=你的密碼
PORT=3000

# 通知 (可選)
DISCORD_WEBHOOK_URL=
DISCORD_ENABLED=false
```

按 `Ctrl+O` 儲存，`Ctrl+X` 離開。

---

### Step 7：啟動機器人

```bash
# 使用 PM2 啟動 (背景執行)
pm2 start trading-bot.js --name nas100-bot

# 設定開機自動啟動
pm2 startup
pm2 save

# 查看日誌
pm2 logs nas100-bot
```

---

### Step 8：設定防火牆 (開放 Dashboard)

1. 回到 GCP Console
2. 左側選單 → **VPC 網路** → **防火牆**
3. 點擊 **建立防火牆規則**

| 設定 | 值 |
|------|-----|
| 名稱 | `allow-dashboard` |
| 目標 | 網路中的所有執行個體 |
| 來源 IP 範圍 | `0.0.0.0/0` |
| 通訊協定和埠 | TCP: `3000` |

4. 點擊**建立**

---

### Step 9：存取 Dashboard

1. 回到 VM 執行個體頁面
2. 複製**外部 IP** (例如 `34.xx.xx.xx`)
3. 在瀏覽器開啟：`http://34.xx.xx.xx:3000`
4. 輸入帳號密碼登入

---

## 🔧 常用指令

```bash
# 查看狀態
pm2 status

# 查看日誌
pm2 logs nas100-bot

# 重啟
pm2 restart nas100-bot

# 停止
pm2 stop nas100-bot

# 更新程式碼
cd ~/NAS100_Bot
git pull
npm install
pm2 restart nas100-bot
```

---

## ⚠️ 注意事項

1. **外部 IP 可能變動** - 建議設定靜態 IP (免費額度內)
2. **定期更新 Token** - cTrader Access Token 有效期約 30 天
3. **監控用量** - 確保不超出免費額度

---

## ✅ 驗證部署

1. Dashboard 可正常存取
2. 連線狀態顯示 **🟢 已連線**
3. Discord 收到啟動通知 (如有設定)

完成！🎉
