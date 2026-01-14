/**
 * cTrader Token 自動更新管理
 * Access Token 約 30 天過期，使用 Refresh Token 自動更新
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { systemLogger } = require('./logger');

const TOKEN_ENDPOINT = 'https://openapi.ctrader.com/apps/token';
const TOKEN_REFRESH_BUFFER_MS = 24 * 60 * 60 * 1000; // 提前 1 天更新
const TOKEN_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 每小時檢查一次

class TokenManager {
    constructor(config) {
        this.config = config;
        this.accessToken = config.ctrader.accessToken;
        this.refreshToken = config.ctrader.refreshToken;
        this.tokenExpiresAt = null;
        this.checkInterval = null;

        // 嘗試載入存儲的 Token 資訊
        this.loadTokenInfo();
    }

    // 載入 Token 資訊
    loadTokenInfo() {
        try {
            const tokenFile = path.join(__dirname, '.token_info.json');
            if (fs.existsSync(tokenFile)) {
                const data = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
                if (data.accessToken) this.accessToken = data.accessToken;
                if (data.refreshToken) this.refreshToken = data.refreshToken;
                if (data.expiresAt) this.tokenExpiresAt = new Date(data.expiresAt);
                console.log('📄 已載入儲存的 Token 資訊');
            }
        } catch (e) {
            console.debug('Token 資訊載入失敗:', e.message);
        }
    }

    // 儲存 Token 資訊
    saveTokenInfo() {
        try {
            const tokenFile = path.join(__dirname, '.token_info.json');
            const data = {
                accessToken: this.accessToken,
                refreshToken: this.refreshToken,
                expiresAt: this.tokenExpiresAt?.toISOString(),
                updatedAt: new Date().toISOString()
            };
            fs.writeFileSync(tokenFile, JSON.stringify(data, null, 2));
            console.log('💾 Token 資訊已儲存');
        } catch (e) {
            console.error('Token 資訊儲存失敗:', e.message);
        }
    }

    // 刷新 Access Token
    async refreshAccessToken() {
        return new Promise((resolve, reject) => {
            const url = new URL(TOKEN_ENDPOINT);
            const params = new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: this.config.ctrader.clientId,
                client_secret: this.config.ctrader.clientSecret,
                refresh_token: this.refreshToken
            });

            const options = {
                hostname: url.hostname,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(params.toString())
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        if (result.access_token) {
                            this.accessToken = result.access_token;
                            if (result.refresh_token) this.refreshToken = result.refresh_token;

                            // 計算過期時間 (約 30 天)
                            const expiresIn = result.expires_in || 2628000;
                            this.tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

                            // 儲存新的 Token
                            this.saveTokenInfo();

                            console.log('✅ Access Token 已更新，有效期至:', this.tokenExpiresAt.toLocaleString());
                            resolve(this.accessToken);
                        } else {
                            reject(new Error(result.error_description || result.error || 'Token 刷新失敗'));
                        }
                    } catch (e) {
                        reject(new Error('Token 回應解析失敗: ' + e.message));
                    }
                });
            });

            req.on('error', reject);
            req.write(params.toString());
            req.end();
        });
    }

    // 檢查並更新 Token
    async checkAndRefresh() {
        // 如果沒有過期時間，假設需要更新
        if (!this.tokenExpiresAt) {
            console.log('⏰ Token 過期時間未知，嘗試更新...');
            return this.refreshAccessToken();
        }

        const now = Date.now();
        const expiresAt = this.tokenExpiresAt.getTime();
        const remaining = expiresAt - now;

        // 如果即將過期（小於 1 天），更新
        if (remaining < TOKEN_REFRESH_BUFFER_MS) {
            console.log('⏰ Token 即將過期，更新中...');
            return this.refreshAccessToken();
        }

        const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
        console.log(`🔑 Token 有效，剩餘 ${days} 天`);
        return this.accessToken;
    }

    // 啟動自動檢查
    startAutoRefresh() {
        if (this.checkInterval) return;

        console.log('🔄 Token 自動更新已啟動');

        // 立即檢查一次
        this.checkAndRefresh().catch(e => console.error('Token 首次檢查失敗:', e.message));

        // 每小時檢查
        this.checkInterval = setInterval(() => {
            this.checkAndRefresh().catch(e => console.error('Token 自動更新失敗:', e.message));
        }, TOKEN_CHECK_INTERVAL_MS);
    }

    // 停止自動檢查
    stopAutoRefresh() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    // 取得目前有效的 Access Token
    getAccessToken() {
        return this.accessToken;
    }
}

module.exports = TokenManager;
