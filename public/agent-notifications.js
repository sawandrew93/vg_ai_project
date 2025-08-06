// Agent notification system with smart connection management
class AgentNotificationSystem {
    constructor() {
        this.ws = null;
        this.token = localStorage.getItem('agentToken');
        this.user = null;
        this.isConnected = false;
        
        if (this.token) {
            this.validateAndConnect();
        }
    }

    async validateAndConnect() {
        try {
            const response = await fetch('/api/agent/validate', {
                headers: {
                    'Authorization': `Bearer ${this.token}`
                }
            });

            if (response.ok) {
                const data = await response.json();
                this.user = data.user;
                this.connectWebSocket();
            }
        } catch (error) {
            console.error('Agent validation failed:', error);
        }
    }

    connectWebSocket() {
        if (this.isConnected) return;
        
        // Don't create connection if we're on agent dashboard (it has its own)
        if (window.location.pathname === '/agent') return;

        const wsUrl = `ws://${window.location.host}`;
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            this.ws.send(JSON.stringify({
                type: 'agent_join',
                agentId: this.user.id,
                token: this.token
            }));
            this.isConnected = true;
        };

        this.ws.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                this.handleMessage(data);
            } catch (error) {
                console.error('Error parsing notification message:', error);
            }
        };

        this.ws.onclose = () => {
            this.isConnected = false;
            // Don't auto-reconnect to avoid conflicts
        };
    }

    handleMessage(data) {
        switch(data.type) {
            case 'pending_request':
                this.showNotification(data);
                break;
            case 'customer_assigned':
                window.location.href = '/agent';
                break;
        }
    }

    showNotification(data) {
        // Create notification popup
        const notification = document.createElement('div');
        notification.className = 'agent-notification';
        notification.innerHTML = `
            <div class="notification-content">
                <h4>📞 New Customer Request</h4>
                <p>Position ${data.position} of ${data.totalInQueue}</p>
                <p>"${data.lastMessage}"</p>
                <div class="notification-actions">
                    <button onclick="agentNotifications.acceptRequest('${data.sessionId}')" class="accept-btn">Accept</button>
                    <button onclick="agentNotifications.dismissNotification(this)" class="dismiss-btn">Dismiss</button>
                </div>
            </div>
        `;

        document.body.appendChild(notification);

        // Show desktop notification and play sound
        this.showDesktopNotification(data);

        // Auto-dismiss after 30 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 30000);
    }

    acceptRequest(sessionId) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'accept_request',
                sessionId: sessionId,
                agentId: this.user.id
            }));
        }
        
        // Remove all notifications
        document.querySelectorAll('.agent-notification').forEach(n => n.remove());
    }

    showDesktopNotification(data) {
        // Request notification permission if not granted
        if (Notification.permission === 'default') {
            Notification.requestPermission();
        }

        // Show desktop notification if permission granted
        if (Notification.permission === 'granted') {
            const notification = new Notification('New Customer Request', {
                body: `Position ${data.position}: "${data.lastMessage}"`,
                icon: '/favicon.ico',
                tag: 'customer-request',
                requireInteraction: true
            });

            notification.onclick = () => {
                window.focus();
                this.acceptRequest(data.sessionId);
                notification.close();
            };
        }

        // Play notification sound
        this.playNotificationSound();
    }

    playNotificationSound() {
        try {
            // Create audio context for notification sound
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            
            // Play multiple beeps for attention
            for (let i = 0; i < 3; i++) {
                const oscillator = audioContext.createOscillator();
                const gainNode = audioContext.createGain();
                
                oscillator.connect(gainNode);
                gainNode.connect(audioContext.destination);
                
                const startTime = audioContext.currentTime + (i * 0.4);
                
                oscillator.frequency.setValueAtTime(1000, startTime);
                oscillator.frequency.setValueAtTime(800, startTime + 0.1);
                
                gainNode.gain.setValueAtTime(0.6, startTime);
                gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + 0.2);
                
                oscillator.start(startTime);
                oscillator.stop(startTime + 0.2);
            }
        } catch (error) {
            console.log('Could not play notification sound:', error);
        }
    }

    dismissNotification(button) {
        const notification = button.closest('.agent-notification');
        if (notification) {
            notification.remove();
        }
    }
}

// Global instance
window.agentNotifications = new AgentNotificationSystem();

// Add CSS for notifications
const style = document.createElement('style');
style.textContent = `
    .agent-notification {
        position: fixed;
        top: 20px;
        right: 20px;
        background: white;
        border: 2px solid #007bff;
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        padding: 1rem;
        z-index: 10000;
        max-width: 300px;
        animation: slideIn 0.3s ease;
    }

    @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }

    .notification-content h4 {
        margin: 0 0 0.5rem 0;
        color: #007bff;
    }

    .notification-content p {
        margin: 0.25rem 0;
        font-size: 0.9rem;
        color: #666;
    }

    .notification-actions {
        display: flex;
        gap: 0.5rem;
        margin-top: 1rem;
    }

    .accept-btn {
        background: #28a745;
        color: white;
        border: none;
        padding: 0.5rem 1rem;
        border-radius: 4px;
        cursor: pointer;
        flex: 1;
    }

    .dismiss-btn {
        background: #6c757d;
        color: white;
        border: none;
        padding: 0.5rem 1rem;
        border-radius: 4px;
        cursor: pointer;
        flex: 1;
    }

    .accept-btn:hover {
        background: #218838;
    }

    .dismiss-btn:hover {
        background: #5a6268;
    }
`;
document.head.appendChild(style);

// Also provide sound service for agent dashboard
window.agentSoundService = {
    playNotificationSound: () => {
        if (window.agentNotifications) {
            window.agentNotifications.playNotificationSound();
        }
    }
};