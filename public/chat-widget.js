(function() {
  'use strict';

  class ChatWidget {
    constructor(options = {}) {
      this.options = {
        serverUrl: options.serverUrl || 'ws://localhost:3000/',
        position: options.position || 'bottom-right',
        primaryColor: options.primaryColor || '#007bff',
        title: options.title || 'Chat Support',
        ...options
      };

      this.sessionId = this.getOrCreateSessionId();
      this.ws = null;
      this.isOpen = false;
      this.messages = this.loadMessages();
      this.isConnectedToHuman = false;
      this.reconnectAttempts = 0;
      this.maxReconnectAttempts = 10;

      this.init();
    }

    getOrCreateSessionId() {
      let sessionId = localStorage.getItem('chat_session_id');

      if (!sessionId) {
        sessionId = 'session_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
        localStorage.setItem('chat_session_id', sessionId);
        console.log('Created new session:', sessionId);
      } else {
        console.log('Restored session:', sessionId);
      }

      return sessionId;
    }

    saveMessages() {
      try {
        localStorage.setItem('chat_messages_' + this.sessionId, JSON.stringify(this.messages));
        localStorage.setItem('chat_last_activity', Date.now().toString());
      } catch (error) {
        console.error('Error saving messages:', error);
      }
    }

    loadMessages() {
      try {
        const savedMessages = localStorage.getItem('chat_messages_' + this.sessionId);
        if (savedMessages) {
          const messages = JSON.parse(savedMessages);
          console.log('Loaded', messages.length, 'previous messages');
          return messages;
        }
      } catch (error) {
        console.error('Error loading messages:', error);
      }
      return [];
    }

    clearSession() {
      localStorage.removeItem('chat_session_id');
      localStorage.removeItem('chat_messages_' + this.sessionId);
      localStorage.removeItem('chat_connection_state');
      localStorage.removeItem('chat_last_activity');
      this.messages = [];
    }

    saveConnectionState() {
      const state = {
        isConnectedToHuman: this.isConnectedToHuman,
        sessionId: this.sessionId,
        timestamp: Date.now()
      };
      localStorage.setItem('chat_connection_state', JSON.stringify(state));
    }

    loadConnectionState() {
      try {
        const stateStr = localStorage.getItem('chat_connection_state');
        if (stateStr) {
          const state = JSON.parse(stateStr);
          if (Date.now() - state.timestamp < 10 * 60 * 1000) {
            this.isConnectedToHuman = state.isConnectedToHuman;
            console.log('Restored connection state:', state);
            return state;
          }
        }
      } catch (error) {
        console.error('Error loading connection state:', error);
      }
      return null;
    }

    init() {
      this.createWidget();
      this.restoreMessages();
      this.connectWebSocket();

      const connectionState = this.loadConnectionState();
      if (connectionState) {
        this.updateConnectionStatus(
          this.isConnectedToHuman ? 'Human Agent' : 'AI Assistant',
          'Reconnecting to previous session...'
        );
      }
    }

    restoreMessages() {
      if (this.messages.length > 0) {
        const messagesContainer = document.getElementById('chat-messages');
        messagesContainer.innerHTML = '';

        this.addMessage('Previous conversation restored', 'system', false);

        this.messages.forEach(msg => {
          this.addMessage(msg.content, msg.sender, false);
        });

        console.log('Restored', this.messages.length, 'messages');
      } else {
        this.addMessage("Hi there! 👋 Welcome! I'm here to help you learn about our products and services. What can I assist you with today?", 'bot', false);
      }
    }

    createWidget() {
      this.widget = document.createElement('div');
      this.widget.id = 'chat-widget';
      this.widget.innerHTML = this.getWidgetHTML();
      document.body.appendChild(this.widget);

      const style = document.createElement('style');
      style.textContent = this.getWidgetCSS();
      document.head.appendChild(style);

      this.addEventListeners();
    }

    getWidgetHTML() {
      return `
        <div class="chat-widget-container ${this.options.position}">
          <div class="chat-toggle" id="chat-toggle">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>

          <div class="chat-window" id="chat-window" style="display: none;">
            <div class="chat-header">
              <span class="chat-title">${this.options.title}</span>
              <div class="connection-status" id="connection-status">
                <span class="status-text">AI Assistant</span>
                <div class="status-indicator"></div>
              </div>
              <div class="chat-actions">
                <button class="clear-chat-btn" id="clear-chat" title="Clear chat history">🗑️</button>
                <button class="end-session-btn" id="end-session" title="End session">❌</button>
                <button class="chat-close" id="chat-close">×</button>
              </div>
            </div>

            <div class="chat-messages" id="chat-messages"></div>

            <div class="chat-input-container">
              <input type="text" id="chat-input" placeholder="Type your message..." />
              <input type="file" id="file-input" style="display: none;" accept="image/*,.pdf,.doc,.docx,.txt">
              <button id="chat-send">Send</button>
              <button id="file-upload" title="Upload file">📎</button>
              <button id="request-human" title="Request human support">👤</button>
            </div>

            <!-- Handoff Confirmation Dialog -->
            <div id="handoff-dialog" class="handoff-dialog" style="display: none;">
              <div class="handoff-content">
                <p id="handoff-message">I don't have specific information about that. I can connect you with a human agent if you'd like more detailed assistance.</p>
                <div class="handoff-buttons">
                  <button id="handoff-yes" class="handoff-btn handoff-yes">Yes</button>
                  <button id="handoff-no" class="handoff-btn handoff-no">No</button>
                </div>
              </div>
            </div>

            <div id="satisfaction-survey" style="display: none;">
              <div class="survey-content">
                <h4>How was your experience?</h4>
                <div class="survey-options" id="survey-options"></div>
                <textarea id="survey-feedback" placeholder="Additional feedback (optional)"></textarea>
                <div class="survey-buttons">
                  <button id="survey-submit">Submit</button>
                  <button id="survey-skip">Skip</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    getWidgetCSS() {
      return `
        .chat-widget-container {
          position: fixed;
          z-index: 10000;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }

        .chat-widget-container.bottom-right {
          bottom: 20px;
          right: 20px;
        }

        .chat-widget-container.bottom-left {
          bottom: 20px;
          left: 20px;
        }

        .chat-toggle {
          width: 60px;
          height: 60px;
          background: ${this.options.primaryColor};
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          transition: all 0.3s ease;
          color: white;
        }

        .chat-toggle:hover {
          transform: scale(1.1);
        }

        .chat-window {
          width: 350px;
          height: 500px;
          background: white;
          border-radius: 12px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.3);
          display: flex;
          flex-direction: column;
          position: absolute;
          bottom: 70px;
          right: 0;
        }

        .chat-header {
          background: ${this.options.primaryColor};
          color: white;
          padding: 16px;
          border-radius: 12px 12px 0 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
        }

        .chat-title {
          font-weight: 600;
          flex-shrink: 0;
        }

        .connection-status {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          min-width: 0;
        }

        .status-text {
          font-size: 12px;
          opacity: 0.9;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .status-indicator {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #4CAF50;
          flex-shrink: 0;
        }

        .status-indicator.waiting {
          background: #FFC107;
          animation: pulse 1.5s infinite;
        }

        .status-indicator.human {
          background: #FF5722;
        }

        .status-indicator.disconnected {
          background: #dc3545;
        }

        .chat-actions {
          display: flex;
          align-items: center;
          gap: 5px;
        }

        .clear-chat-btn, .end-session-btn {
          background: none;
          border: none;
          color: white;
          font-size: 16px;
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
          opacity: 0.8;
          transition: all 0.2s ease;
        }

        .clear-chat-btn:hover, .end-session-btn:hover {
          opacity: 1;
          background: rgba(255,255,255,0.1);
        }

        .end-session-btn {
          font-size: 14px;
        }

        .chat-close {
          background: none;
          border: none;
          color: white;
          font-size: 24px;
          cursor: pointer;
          padding: 0;
          width: 30px;
          height: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        @keyframes pulse {
          0% { opacity: 1; }
          50% { opacity: 0.5; }
          100% { opacity: 1; }
        }

        .chat-messages {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .message {
          display: flex;
          margin-bottom: 8px;
        }

        .message-content {
          max-width: 80%;
          padding: 12px 16px;
          border-radius: 18px;
          word-wrap: break-word;
          font-size: 14px;
          line-height: 1.4;
        }

        .bot-message .message-content,
        .agent-message .message-content {
          background: #f1f1f1;
          color: #333;
          margin-right: auto;
        }

        .system-message .message-content {
          background: #e3f2fd;
          color: #1976d2;
          margin-right: auto;
          font-style: italic;
          font-size: 13px;
          text-align: center;
          max-width: 90%;
        }

        .user-message {
          justify-content: flex-end;
        }

        .user-message .message-content {
          background: ${this.options.primaryColor};
          color: white;
          margin-left: auto;
        }

        .chat-input-container {
          padding: 16px;
          border-top: 1px solid #eee;
          display: flex;
          gap: 8px;
        }

        #chat-input {
          flex: 1;
          padding: 12px;
          border: 1px solid #ddd;
          border-radius: 20px;
          outline: none;
          font-size: 14px;
        }

        #chat-send, #request-human {
          padding: 12px 16px;
          background: ${this.options.primaryColor};
          color: white;
          border: none;
          border-radius: 20px;
          cursor: pointer;
          font-size: 14px;
          transition: all 0.3s ease;
        }

        #request-human {
          padding: 12px;
        }

        #file-upload {
          background: #6c757d;
          color: white;
          padding: 12px;
          border: none;
          border-radius: 20px;
          cursor: pointer;
          font-size: 14px;
        }

        #request-human:hover, #file-upload:hover {
          transform: scale(1.05);
        }

        #request-human:disabled, #file-upload:disabled {
          opacity: 0.5;
          cursor: not-allowed;
          transform: none;
        }

        /* Handoff Dialog Styles */
        .handoff-dialog {
          position: absolute;
          bottom: 60px;
          left: 0;
          right: 0;
          background: white;
          border-top: 2px solid ${this.options.primaryColor};
          padding: 20px;
          box-shadow: 0 -4px 20px rgba(0,0,0,0.15);
          z-index: 1000;
        }

        .handoff-content h4 {
          margin: 0 0 10px 0;
          color: #333;
          font-size: 16px;
        }

        .handoff-content p {
          margin: 0 0 20px 0;
          color: #666;
          font-size: 14px;
          line-height: 1.4;
        }

        .handoff-buttons {
          display: flex;
          gap: 12px;
        }

        .handoff-btn {
          flex: 1;
          padding: 12px 16px;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          transition: all 0.2s ease;
        }

        .handoff-yes {
          background: ${this.options.primaryColor};
          color: white;
        }

        .handoff-yes:hover {
          background: ${this.options.primaryColor}dd;
          transform: translateY(-1px);
        }

        .handoff-no {
          background: #f8f9fa;
          color: #6c757d;
          border: 1px solid #dee2e6;
        }

        .handoff-no:hover {
          background: #e9ecef;
          transform: translateY(-1px);
        }

        #satisfaction-survey {
          position: absolute;
          bottom: 60px;
          left: 0;
          right: 0;
          background: white;
          border-top: 1px solid #eee;
          padding: 20px;
          box-shadow: 0 -2px 10px rgba(0,0,0,0.1);
        }

        .survey-content h4 {
          margin: 0 0 15px 0;
          color: #333;
        }

        .survey-options {
          display: flex;
          gap: 10px;
          margin-bottom: 15px;
          flex-wrap: wrap;
        }

        .survey-option {
          padding: 8px 12px;
          border: 1px solid #ddd;
          border-radius: 20px;
          cursor: pointer;
          background: white;
          transition: all 0.2s;
          font-size: 14px;
        }

        .survey-option:hover {
          background: #f0f0f0;
        }

        .survey-option.selected {
          background: ${this.options.primaryColor};
          color: white;
          border-color: ${this.options.primaryColor};
        }

        #survey-feedback {
          width: 100%;
          padding: 10px;
          border: 1px solid #ddd;
          border-radius: 8px;
          resize: vertical;
          min-height: 60px;
          margin-bottom: 15px;
          font-family: inherit;
          box-sizing: border-box;
        }

        .survey-buttons {
          display: flex;
          gap: 10px;
        }

        .survey-buttons button {
          padding: 8px 16px;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
        }

        #survey-submit {
          background: ${this.options.primaryColor};
          color: white;
        }

        #survey-skip {
          background: #6c757d;
          color: white;
        }

        .typing-indicator {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 12px 16px;
          background: #f1f1f1;
          border-radius: 18px;
          margin-right: auto;
          max-width: 80px;
        }

        .typing-dot {
          width: 8px;
          height: 8px;
          background: #999;
          border-radius: 50%;
          animation: typing 1.4s infinite ease-in-out;
        }

        .typing-dot:nth-child(1) { animation-delay: -0.32s; }
        .typing-dot:nth-child(2) { animation-delay: -0.16s; }

        @keyframes typing {
          0%, 80%, 100% { transform: scale(0); }
          40% { transform: scale(1); }
        }

        @media (max-width: 480px) {
          .chat-window {
            width: calc(100vw - 40px);
            height: calc(100vh - 100px);
            bottom: 70px;
            right: 20px;
          }

          .handoff-buttons {
            flex-direction: column;
          }
        }
      `;
    }

    addEventListeners() {
      const toggle = document.getElementById('chat-toggle');
      const close = document.getElementById('chat-close');
      const input = document.getElementById('chat-input');
      const send = document.getElementById('chat-send');
      const requestHuman = document.getElementById('request-human');
      const fileUpload = document.getElementById('file-upload');
      const fileInput = document.getElementById('file-input');
      const clearChat = document.getElementById('clear-chat');
      const endSession = document.getElementById('end-session');

      toggle.addEventListener('click', () => this.toggleChat());
      close.addEventListener('click', () => this.closeChat());
      send.addEventListener('click', () => this.sendMessage());
      requestHuman.addEventListener('click', () => this.requestHuman());
      fileUpload.addEventListener('click', () => this.handleFileUpload());
      clearChat.addEventListener('click', () => this.clearChatHistory());
      endSession.addEventListener('click', () => this.endSession());

      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          this.sendMessage();
        }
      });

      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          this.uploadFile(file);
        }
      });

      // Handoff dialog event listeners
      document.getElementById('handoff-yes').addEventListener('click', () => {
        this.handleHandoffResponse(true);
      });

      document.getElementById('handoff-no').addEventListener('click', () => {
        this.handleHandoffResponse(false);
      });
    }

    clearChatHistory() {
      if (confirm('Are you sure you want to clear the chat history? This cannot be undone.')) {
        this.clearSession();
        this.sessionId = this.getOrCreateSessionId();

        const messagesContainer = document.getElementById('chat-messages');
        messagesContainer.innerHTML = '';

        this.addMessage("Chat history cleared. Hi there! 👋 I'm here to help you learn about our products and services. What can I assist you with today?", 'bot', false);

        this.isConnectedToHuman = false;
        this.updateConnectionStatus('AI Assistant', 'Ready to help');
        document.getElementById('request-human').disabled = false;

        console.log('Chat history cleared, new session:', this.sessionId);
      }
    }

    endSession() {
      if (confirm('Are you sure you want to end this session?')) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: 'end_session',
            sessionId: this.sessionId
          }));
        }

        this.clearSession();
        this.sessionId = this.getOrCreateSessionId();

        const messagesContainer = document.getElementById('chat-messages');
        messagesContainer.innerHTML = '';

        this.addMessage('Session ended. Thank you for chatting with us!', 'system', false);
        this.addMessage("Hi there! 👋 I'm here to help you learn about our products and services. What can I assist you with today?", 'bot', false);

        this.isConnectedToHuman = false;
        this.updateConnectionStatus('AI Assistant', 'Ready to help');
        document.getElementById('request-human').disabled = false;
      }
    }

    connectWebSocket() {
      let wsUrl = this.options.serverUrl;

      if (wsUrl.endsWith('/')) {
        wsUrl = wsUrl.slice(0, -1);
      }

      if (wsUrl.startsWith('http://')) {
        wsUrl = wsUrl.replace('http://', 'ws://');
      } else if (wsUrl.startsWith('https://')) {
        wsUrl = wsUrl.replace('https://', 'wss://');
      } else if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsUrl = `${protocol}//${wsUrl}`;
      }

      console.log('Connecting to WebSocket:', wsUrl, 'Session:', this.sessionId);
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('WebSocket connected successfully');
        this.reconnectAttempts = 0;
        this.updateConnectionStatus('Connected', this.isConnectedToHuman ? 'Human Agent' : 'AI Assistant');
        this.requestSessionRestore();
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('Received message:', data);
          this.handleServerMessage(data);
        } catch (error) {
          console.error('Error parsing message:', error);
        }
      };

      this.ws.onclose = (event) => {
        console.log('WebSocket disconnected. Code:', event.code, 'Reason:', event.reason);
        this.updateConnectionStatus('Disconnected', 'Connection lost', true);

        if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          const delay = Math.min(1000 * this.reconnectAttempts, 10000);

          setTimeout(() => {
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            this.updateConnectionStatus('Reconnecting...', `Attempt ${this.reconnectAttempts}`);
            this.connectWebSocket();
          }, delay);
        } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          this.updateConnectionStatus('Connection Failed', 'Max reconnection attempts reached');
          this.addMessage('Connection lost. Please refresh the page to continue.', 'system');
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.updateConnectionStatus('Connection Error', 'Failed to connect');
      };
    }

    requestSessionRestore() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'restore_session',
          sessionId: this.sessionId,
          timestamp: Date.now()
        }));
      }
    }

    handleServerMessage(data) {
      const { type, message } = data;

      switch (type) {
        case 'session_restored':
          console.log('Session restored:', data);
          if (data.isConnectedToHuman) {
            this.isConnectedToHuman = true;
            this.updateConnectionStatus('Human Agent', 'Session restored');
            document.getElementById('request-human').disabled = true;
          }
          break;

        case 'ai_response':
          this.hideTypingIndicator();
          this.addMessage(message, 'bot');
          if (data.sources && data.sources.length > 0) {
            console.log('Response sources:', data.sources);
          }
          break;

        case 'agent_message':
          this.addMessage(message, 'agent');
          break;

        case 'human_joined':
          this.isConnectedToHuman = true;
          this.updateConnectionStatus('Human Agent', 'Connected to agent');
          this.addMessage(message, 'system');
          document.getElementById('request-human').disabled = true;
          this.saveConnectionState();
          break;

        case 'waiting_for_human':
          this.updateConnectionStatus('In Queue', 'Waiting for agent', true);
          this.addMessage(message, 'system');
          document.getElementById('request-human').disabled = true;
          break;

        case 'agent_left':
          this.isConnectedToHuman = false;
          this.updateConnectionStatus('AI Assistant', 'Back to AI');
          this.addMessage(message, 'system');
          document.getElementById('request-human').disabled = false;
          this.saveConnectionState();
          break;

        case 'agent_disconnected_temp':
          this.updateConnectionStatus('Agent Reconnecting', 'Temporary disconnection', true);
          this.addMessage(message, 'system');
          break;

        case 'agent_reconnected':
          this.updateConnectionStatus('Human Agent', 'Agent reconnected');
          this.addMessage(message, 'system');
          break;

        case 'handoff_offer':
          this.showHandoffDialog(data.message, data.reason);
          break;

        case 'satisfaction_survey':
          this.showSatisfactionSurvey(data);
          break;

        case 'no_agents_available':
          this.addMessage(message, 'system');
          document.getElementById('request-human').disabled = false;
          break;

        case 'session_ended':
          this.addMessage(message, 'system');
          break;

        case 'error':
          this.hideTypingIndicator();
          this.addMessage(message, 'system');
          break;

        default:
          console.log('Unknown message type:', type);
      }
    }

    showHandoffDialog(message, reason) {
      const dialog = document.getElementById('handoff-dialog');
      const messageElement = document.getElementById('handoff-message');

      messageElement.textContent = message;
      dialog.style.display = 'block';

      console.log('Handoff reason:', reason);
    }

    handleHandoffResponse(accepted) {
      const dialog = document.getElementById('handoff-dialog');
      dialog.style.display = 'none';

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'handoff_response',
          sessionId: this.sessionId,
          accepted: accepted
        }));
      }

      if (accepted) {
        this.addMessage('Connecting you to a sales representative...', 'system');
      }
    }

    updateConnectionStatus(statusText, tooltip, isWaiting = false) {
      const statusElement = document.getElementById('connection-status');
      let indicatorClass = '';

      if (isWaiting) {
        indicatorClass = 'waiting';
      } else if (this.isConnectedToHuman) {
        indicatorClass = 'human';
      } else if (statusText.includes('Disconnected') || statusText.includes('Error')) {
        indicatorClass = 'disconnected';
      }

      statusElement.innerHTML = `
        <span class="status-text" title="${tooltip}">${statusText}</span>
        <div class="status-indicator ${indicatorClass}"></div>
      `;
    }

    toggleChat() {
      const window = document.getElementById('chat-window');
      this.isOpen = !this.isOpen;
      window.style.display = this.isOpen ? 'flex' : 'none';
    }

    closeChat() {
      const window = document.getElementById('chat-window');
      this.isOpen = false;
      window.style.display = 'none';
    }

    sendMessage() {
      const input = document.getElementById('chat-input');
      const message = input.value.trim();

      if (!message) return;

      this.addMessage(message, 'user');
      input.value = '';

      if (!this.isConnectedToHuman) {
        this.showTypingIndicator();
      }

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'customer_message',
          sessionId: this.sessionId,
          message: message
        }));
      } else {
        this.hideTypingIndicator();
        this.addMessage('Connection lost. Trying to reconnect...', 'system');
      }
    }

    requestHuman() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'request_human',
          sessionId: this.sessionId
        }));

        this.addMessage('Requesting human agent...', 'system');
      } else {
        this.addMessage('Unable to connect to server. Please try again.', 'system');
      }
    }

    addMessage(message, sender, saveToStorage = true) {
      const messagesContainer = document.getElementById('chat-messages');
      const messageDiv = document.createElement('div');
      messageDiv.className = `message ${sender}-message`;

      messageDiv.innerHTML = `
        <div class="message-content">${message}</div>
      `;

      messagesContainer.appendChild(messageDiv);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;

      if (saveToStorage) {
        const messageObj = {
          content: message,
          sender: sender,
          timestamp: Date.now()
        };

        this.messages.push(messageObj);
        this.saveMessages();
      }
    }

    showTypingIndicator() {
      this.hideTypingIndicator();

      const messagesContainer = document.getElementById('chat-messages');
      const typingDiv = document.createElement('div');
      typingDiv.className = 'message bot-message';
      typingDiv.id = 'typing-indicator';

      typingDiv.innerHTML = `
        <div class="typing-indicator">
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
          <div class="typing-dot"></div>
        </div>
      `;

      messagesContainer.appendChild(typingDiv);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    hideTypingIndicator() {
      const typingIndicator = document.getElementById('typing-indicator');
      if (typingIndicator) {
        typingIndicator.remove();
      }
    }

    handleFileUpload() {
      document.getElementById('file-input').click();
    }

    uploadFile(file) {
      const fileName = file.name;
      const fileSize = (file.size / 1024).toFixed(1) + ' KB';

      this.addMessage(`📎 Uploading ${fileName} (${fileSize})...`, 'user');

      setTimeout(() => {
        this.addMessage(`✅ File uploaded: ${fileName}`, 'system');

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            type: 'file_upload',
            sessionId: this.sessionId,
            fileName: fileName,
            fileType: file.type,
            fileData: 'base64_data_here'
          }));
        }
      }, 1500);
    }

    showSatisfactionSurvey(data) {
      const surveyDiv = document.getElementById('satisfaction-survey');
      const optionsDiv = document.getElementById('survey-options');

      optionsDiv.innerHTML = '';

      data.options.forEach(option => {
        const optionButton = document.createElement('button');
        optionButton.className = 'survey-option';
        optionButton.textContent = option.label;
        optionButton.dataset.value = option.value;

        optionButton.addEventListener('click', () => {
          optionsDiv.querySelectorAll('.survey-option').forEach(btn => {
            btn.classList.remove('selected');
          });
          optionButton.classList.add('selected');
        });

        optionsDiv.appendChild(optionButton);
      });

      surveyDiv.style.display = 'block';

      document.getElementById('survey-submit').onclick = () => {
        const selectedOption = optionsDiv.querySelector('.survey-option.selected');
        const feedback = document.getElementById('survey-feedback').value;

        if (selectedOption) {
          const rating = parseInt(selectedOption.dataset.value);

          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
              type: 'satisfaction_response',
              sessionId: data.sessionId,
              rating: rating,
              feedback: feedback
            }));
          }

          this.addMessage('Thank you for your feedback!', 'system');
        }

        surveyDiv.style.display = 'none';
      };

      document.getElementById('survey-skip').onclick = () => {
        surveyDiv.style.display = 'none';
      };
    }
  }

  // Auto-initialize with smart defaults
  window.ChatWidget = ChatWidget;

  if (window.chatWidgetConfig) {
    new ChatWidget(window.chatWidgetConfig);
  } else {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;

    const defaultConfig = {
      serverUrl: `${protocol}//${host}`,
      position: 'bottom-right',
      primaryColor: '#007bff',
      title: 'Support Chat'
    };

    console.log('Auto-detected WebSocket URL:', defaultConfig.serverUrl);
    new ChatWidget(defaultConfig);
  }
})();