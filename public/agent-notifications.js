// Sound-only notification service
class AgentSoundService {
    constructor() {
        // Only provide sound functionality, no WebSocket connections
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
