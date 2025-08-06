// Agent notification service for secondary pages
class AgentSoundService {
    constructor() {
        this.ws = null;
        this.token = localStorage.getItem('agentToken');
        this.user = null;
        
        if (this.token && window.location.pathname !== '/agent') {
            this.validateAndConnect();
        }
    }

    async validateAndConnect() {
        try {
            const response = await fetch('/api/agent/validate', {
                headers: { 'Authorization': `Bearer ${this.token}` }
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
        const wsUrl = `ws://${window.location.host}`;
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            this.ws.send(JSON.stringify({
                type: 'agent_join',
                agentId: this.user.id,
                token: this.token
            }));
        };

        this.ws.onmessage = (e) => {
            const data = JSON.parse(e.data);
            if (data.type === 'pending_request') {
                this.showNotification(data);
            }
        };
    }

    showNotification(data) {
        const notification = document.createElement('div');
        notification.style.cssText = 'position:fixed;top:20px;right:20px;background:white;border:2px solid #007bff;padding:15px;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.3);z-index:10000;max-width:300px';
        notification.innerHTML = `
            <h4 style="margin:0 0 10px 0;color:#007bff">📞 New Customer Request</h4>
            <p style="margin:5px 0;font-size:14px">Position ${data.position} of ${data.totalInQueue}</p>
            <p style="margin:5px 0;font-size:14px">"${data.lastMessage}"</p>
            <button onclick="window.location.href='/agent'" style="background:#28a745;color:white;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;margin-right:10px">Go to Dashboard</button>
            <button onclick="this.parentNode.remove()" style="background:#6c757d;color:white;border:none;padding:8px 16px;border-radius:4px;cursor:pointer">Dismiss</button>
        `;
        document.body.appendChild(notification);
        this.playNotificationSound();
        setTimeout(() => notification.remove(), 30000);
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

}

// Global instance for sound only
window.agentSoundService = new AgentSoundService();
