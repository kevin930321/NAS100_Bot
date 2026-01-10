/**
 * CTraderConnection - cTrader Open API 連線管理
 */

const net = require('net');
const tls = require('tls');
const protobuf = require('protobufjs');
const path = require('path');
const EventEmitter = require('events');

const CONNECTION_TIMEOUT_MS = 10000;
const REQUEST_TIMEOUT_MS = 30000;
const HEARTBEAT_INTERVAL_MS = 10000;
const HEARTBEAT_TIMEOUT_MS = 30000;
const MAX_RECONNECT_DELAY_MS = 60000;
const CLEANUP_INTERVAL_MS = 60000;

class CTraderConnection extends EventEmitter {
    constructor(config, tokenManager = null) {
        super();

        this.config = config;
        this.tokenManager = tokenManager;
        this.socket = null;
        this.proto = null;
        this.connected = false;
        this.authenticated = false;

        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000;
        this.reconnectTimeout = null;

        this.heartbeatInterval = null;
        this.lastHeartbeat = Date.now();

        this.messageQueue = [];
        this.pendingRequests = new Map();
        this.nextClientMsgId = 1;
        this.incomingBuffer = Buffer.alloc(0);
    }

    /** 載入 Protobuf 定義檔 */
    async loadProto() {
        try {
            // 同時載入所有定義，確保能處理 Heartbeat 與 Model
            const protoFiles = [
                path.join(__dirname, 'proto', 'OpenApiCommonMessages.proto'),
                path.join(__dirname, 'proto', 'OpenApiCommonModelMessages.proto'),
                path.join(__dirname, 'proto', 'OpenApiMessages.proto'),
                path.join(__dirname, 'proto', 'OpenApiModelMessages.proto')
            ];

            this.proto = await protobuf.load(protoFiles);
            console.log('✅ Protobuf 定義檔載入成功 (含 Heartbeat)');
            return true;
        } catch (error) {
            console.error('❌ Protobuf 載入失敗:', error.message);
            console.error('請確認 proto/ 目錄下存在 OpenApiCommonMessages.proto 與 OpenApiMessages.proto');
            throw error;
        }
    }

    /** 連接到 cTrader 伺服器 */
    async connect() {
        if (!this.proto) {
            await this.loadProto();
        }

        return new Promise((resolve, reject) => {
            const { host, port } = this.config.ctrader;

            console.log(`📡 正在連接 cTrader ${this.config.ctrader.mode} 伺服器...`);
            console.log(`   Host: ${host}:${port}`);

            this.socket = tls.connect({
                host: host,
                port: port,
                rejectUnauthorized: true
            }, () => {
                console.log('✅ TLS 連線建立成功');
                this.connected = true;
                this.reconnectAttempts = 0;
                // 發送 ApplicationAuth 請求
                this.sendApplicationAuth()
                    .then(() => {
                        this.startHeartbeat();
                        resolve();
                    })
                    .catch(reject);
            });

            this.socket.on('data', (data) => {
                try {
                    this.handleIncomingData(data);
                } catch (error) {
                    console.error('❌ 處理訊息時發生錯誤:', error);
                }
            });

            this.socket.on('close', () => {
                console.log('⚠️ TCP 連線已關閉');
                this.connected = false;
                this.authenticated = false;
                this.stopHeartbeat();
                this.scheduleReconnect();
            });

            this.socket.on('error', (error) => {
                console.error('❌ Socket 錯誤:', error.message);
                reject(error);
            });

            // 連線逾時（10 秒）
            setTimeout(() => {
                if (!this.connected) {
                    reject(new Error('連線逾時'));
                }
            }, 10000);
        });
    }

    /** 發送 Application Auth */
    async sendApplicationAuth() {
        const ProtoOAApplicationAuthReq = this.proto.lookupType('ProtoOAApplicationAuthReq');
        const message = ProtoOAApplicationAuthReq.create({
            clientId: this.config.ctrader.clientId,
            clientSecret: this.config.ctrader.clientSecret
        });

        return this.send('ProtoOAApplicationAuthReq', message);
    }

    /** 發送 Account Auth */
    async sendAccountAuth() {
        // 優先使用 TokenManager 的動態 Token
        const accessToken = this.tokenManager
            ? this.tokenManager.getAccessToken()
            : this.config.ctrader.accessToken;

        const ProtoOAAccountAuthReq = this.proto.lookupType('ProtoOAAccountAuthReq');
        const message = ProtoOAAccountAuthReq.create({
            ctidTraderAccountId: parseInt(this.config.ctrader.accountId),
            accessToken: accessToken
        });

        return this.send('ProtoOAAccountAuthReq', message);
    }

    /** 發送訊息（通用） */
    async send(payloadType, payload) {
        if (!this.socket || !this.connected) {
            throw new Error('Socket 未連線');
        }

        const clientMsgId = this.nextClientMsgId++;

        // 建立 ProtoMessage wrapper
        const ProtoMessage = this.proto.lookupType('ProtoMessage');
        const wrappedMessage = ProtoMessage.create({
            payloadType: this.getPayloadTypeId(payloadType),
            payload: this.proto.lookupType(payloadType).encode(payload).finish(),
            clientMsgId: clientMsgId.toString()
        });

        const buffer = ProtoMessage.encode(wrappedMessage).finish();

        // cTrader 需要前綴長度（4 bytes, big-endian）
        const lengthPrefix = Buffer.alloc(4);
        lengthPrefix.writeUInt32BE(buffer.length, 0);

        const packet = Buffer.concat([lengthPrefix, buffer]);

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(clientMsgId.toString(), { resolve, reject, type: payloadType });

            this.socket.write(packet, (error) => {
                if (error) {
                    this.pendingRequests.delete(clientMsgId.toString());
                    reject(error);
                }
            });

            // 超時處理
            setTimeout(() => {
                if (this.pendingRequests.has(clientMsgId.toString())) {
                    this.pendingRequests.delete(clientMsgId.toString());
                    reject(new Error(`Request timeout: ${payloadType}`));
                }
            }, REQUEST_TIMEOUT_MS);
        });
    }

    /** 處理接收到的資料 */
    handleIncomingData(data) {
        // 將新資料追加到緩衝區
        this.incomingBuffer = Buffer.concat([this.incomingBuffer, data]);

        // cTrader 訊息格式: [4 bytes length][protobuf message]
        let offset = 0;

        while (true) {
            // 檢查是否至少有 4 bytes (長度前綴)
            if (this.incomingBuffer.length - offset < 4) break;

            const messageLength = this.incomingBuffer.readUInt32BE(offset);

            // 檢查完整訊息是否已到達
            if (this.incomingBuffer.length - offset < 4 + messageLength) break;

            // 提取完整訊息
            const messageBytes = this.incomingBuffer.subarray(offset + 4, offset + 4 + messageLength);
            offset += (4 + messageLength);

            try {
                const ProtoMessage = this.proto.lookupType('ProtoMessage');
                const message = ProtoMessage.decode(messageBytes);
                this.handleMessage(message);
            } catch (error) {
                console.error('❌ Protobuf 解碼失敗:', error);
            }
        }

        // 移除已處理的資料，保留剩餘部分
        if (offset > 0) {
            this.incomingBuffer = this.incomingBuffer.subarray(offset);
        }
    }

    /** 處理解碼後的訊息 */
    handleMessage(message) {
        // 收到任何訊息都視為連線活躍 (Heartbeat)
        this.lastHeartbeat = Date.now();

        const payloadTypeName = this.getPayloadTypeName(message.payloadType);

        // 過濾掉頻繁的訊息，避免 log 洗版
        const quietMessages = [
            'ProtoOASpotEvent',
            'ProtoHeartbeatEvent',
            'ProtoOATraderRes',
            'ProtoOAReconcileRes'
        ];
        if (!quietMessages.includes(payloadTypeName)) {
            console.log(`📨 收到訊息: ${payloadTypeName}`);
        }

        // 處理回應
        if (message.clientMsgId && this.pendingRequests.has(message.clientMsgId)) {
            const { resolve } = this.pendingRequests.get(message.clientMsgId);
            this.pendingRequests.delete(message.clientMsgId);
            resolve(message);
        }

        // 特殊訊息處理
        switch (payloadTypeName) {
            case 'ProtoOAApplicationAuthRes':
                console.log('✅ Application Auth 成功');
                this.emit('app-auth-success');
                break;

            case 'ProtoOAAccountAuthRes':
                console.log('✅ Account Auth 成功');
                this.authenticated = true;
                this.emit('account-auth-success');
                break;

            case 'ProtoOAErrorRes':
                const ErrorRes = this.proto.lookupType('ProtoOAErrorRes');
                const errorPayload = ErrorRes.decode(message.payload);
                console.error(`❌ API 錯誤: ${errorPayload.errorCode} - ${errorPayload.description}`);
                this.emit('api-error', errorPayload);
                break;

            case 'ProtoOAOrderErrorEvent':
                const OrderErrorEvent = this.proto.lookupType('ProtoOAOrderErrorEvent');
                const orderError = OrderErrorEvent.decode(message.payload);
                console.error(`❌ 訂單錯誤: ${orderError.errorCode} - ${orderError.description || '無描述'}`);
                this.emit('order-error', orderError);
                break;

            case 'ProtoHeartbeatEvent':
                this.lastHeartbeat = Date.now();
                break;
        }

        // 發送給外部監聽器
        this.emit('message', { type: payloadTypeName, payload: message.payload });
    }

    /** 啟動 Heartbeat */
    startHeartbeat() {
        this.stopHeartbeat();

        this.heartbeatInterval = setInterval(() => {
            if (!this.connected) {
                this.stopHeartbeat();
                return;
            }

            // 檢查 Heartbeat 超時
            if (Date.now() - this.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
                console.error('❌ Heartbeat 超時，斷開連線');
                this.disconnect();
                return;
            }

            // 發送 heartbeat (ProtoHeartbeatEvent, payloadType=51)
            try {
                // 主動發送心跳以維持連線 (Keep Alive)
                if (this.proto) {
                    const ProtoHeartbeatEvent = this.proto.lookupType('ProtoHeartbeatEvent');
                    const message = ProtoHeartbeatEvent.create({ payloadType: 51 });
                    this.send('ProtoHeartbeatEvent', message).catch(err => console.debug('Heartbeat 發送忽略:', err.message));
                }
            } catch (error) {
                console.error('Heartbeat 發送失敗:', error.message);
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    /** 停止 Heartbeat */
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    /** 排程重連 */
    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('❌ 重連次數已達上限，停止重連');
            this.emit('reconnect-failed');
            return;
        }

        const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), MAX_RECONNECT_DELAY_MS);
        this.reconnectAttempts++;

        console.log(`🔄 將在 ${delay}ms 後重連 (第 ${this.reconnectAttempts} 次嘗試)...`);

        this.reconnectTimeout = setTimeout(() => {
            this.connect().catch((error) => {
                console.error('重連失敗:', error.message);
            });
        }, delay);
    }

    /** 斷開連線 */
    disconnect() {
        this.connected = false;
        this.authenticated = false;

        this.stopHeartbeat();

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }

        console.log('👋 已斷開 cTrader 連線');
    }

    /** 檢查連線是否健康 */
    isHealthy() {
        if (!this.connected || !this.socket) return false;
        // 檢查最後心跳時間
        const timeSinceLastHeartbeat = Date.now() - this.lastHeartbeat;
        return timeSinceLastHeartbeat < HEARTBEAT_TIMEOUT_MS;
    }

    /** 工具函數：取得 Payload Type ID */
    getPayloadTypeId(typeName) {
        let key;

        if (typeName.startsWith('ProtoOA')) {
            // Open API Messages
            // ProtoOAApplicationAuthReq -> APPLICATION_AUTH_REQ -> PROTO_OA_APPLICATION_AUTH_REQ
            const baseName = typeName.substring(7); // Remove 'ProtoOA'
            // 改進的 snake case 轉換：處理連續大寫字母（如 SLTP）
            const snakeName = baseName
                .replace(/([a-z])([A-Z])/g, '$1_$2')  // camelCase 轉換
                .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')  // 處理連續大寫如 SLTPReq -> SLTP_Req
                .toUpperCase();
            key = `PROTO_OA_${snakeName}`;

            const enumType = this.proto.lookupEnum('ProtoOAPayloadType');
            const result = enumType.values[key];

            if (result === undefined) {
                console.warn(`⚠️ [getPayloadTypeId] 找不到 payloadType: ${key} (from ${typeName})`);
                // 嘗試其他可能的命名格式
                const altKey = `PROTO_OA_${baseName.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
                if (enumType.values[altKey] !== undefined) {
                    console.log(`   使用替代 key: ${altKey}`);
                    return enumType.values[altKey];
                }
                console.error(`❌ 無法找到 enum 值，可用的值:`, Object.keys(enumType.values).filter(k => k.includes('AMEND')));
            }
            return result || 0;
        } else {
            // Common Messages
            // ProtoHeartbeatEvent -> HEARTBEAT_EVENT
            const baseName = typeName.substring(5); // Remove 'Proto'
            const snakeName = baseName.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
            key = snakeName;

            const enumType = this.proto.lookupEnum('ProtoPayloadType');
            return enumType.values[key];
        }
    }

    /** 工具函數：取得 Payload Type Name */
    getPayloadTypeName(typeId) {
        // 根據 ID 範圍判斷 (OA > 2000, Common < 2000)
        if (typeId < 2000) {
            const ProtoPayloadType = this.proto.lookupEnum('ProtoPayloadType');
            for (const [name, id] of Object.entries(ProtoPayloadType.values)) {
                if (id === typeId) {
                    // Common Message (e.g. HEARTBEAT_EVENT -> ProtoHeartbeatEvent)
                    return name
                        .split('_')
                        .map(part => part.charAt(0) + part.slice(1).toLowerCase()) // Capitalize
                        .join('')
                        .replace('Req', 'Req').replace('Res', 'Res') // Already capitalized
                        .replace(/^/, 'Proto'); // Prepend Proto
                    // Example: HEARTBEAT_EVENT -> HeartbeatEvent -> ProtoHeartbeatEvent
                }
            }
        } else {
            const ProtoOAPayloadType = this.proto.lookupEnum('ProtoOAPayloadType');
            for (const [name, id] of Object.entries(ProtoOAPayloadType.values)) {
                if (id === typeId) {
                    // 將 PROTO_OA_ERROR_RES 轉為 ProtoOAErrorRes
                    return name
                        .split('_')
                        .map(part => {
                            if (part === 'OA') return 'OA'; // 保留 OA 大寫
                            if (part === 'PROTO') return 'Proto';
                            return part.charAt(0) + part.slice(1).toLowerCase();
                        })
                        .join('')
                        .replace('Req', 'Req').replace('Res', 'Res').replace('Event', 'Event'); // 確保尾綴格式正確
                }
            }
        }
        return `Unknown(${typeId})`;
    }
}

module.exports = CTraderConnection;
