require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize Gemini AI with latest models
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" }); // Gemini 2.5 Flash
const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" }); // Gemini Embeddings 001

// Import knowledge base services
const EmbeddingService = require('./knowledge-base/embeddings');
const KnowledgeBaseDB = require('./knowledge-base/database');

// Initialize knowledge base services
const embeddingService = new EmbeddingService();
const knowledgeDB = new KnowledgeBaseDB();

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Storage
const conversations = new Map();
const humanAgents = new Map();
const waitingQueue = [];
const agentSessions = new Map();
const sessionAgentMap = new Map();
const customerTimeouts = new Map();
const chatHistory = [];
const agentReconnectTimeouts = new Map();

// Agent users (same as before)
const agentUsers = new Map([
  ['agent1', {
    id: 'agent1',
    username: 'john_doe',
    email: 'john@company.com',
    name: 'John Doe',
    password: '$2b$10$example_hash_here',
    role: 'agent',
    isActive: true
  }],
  ['agent2', {
    id: 'agent2',
    username: 'jane_smith',
    email: 'jane@company.com',
    name: 'Jane Smith',
    password: '$2b$10$example_hash_here2',
    role: 'senior_agent',
    isActive: true
  }]
]);

async function initializeAgentUsers() {
  const users = [
    { id: 'agent1', username: 'john_doe', email: 'john@company.com', name: 'John Doe', password: 'password123', role: 'agent' },
    { id: 'agent2', username: 'jane_smith', email: 'jane@company.com', name: 'Jane Smith', password: 'password456', role: 'senior_agent' }
  ];

  for (const user of users) {
    const hashedPassword = await bcrypt.hash(user.password, 10);
    agentUsers.set(user.id, {
      ...user,
      password: hashedPassword,
      isActive: true
    });
  }
}

// Constants
const CUSTOMER_TIMEOUT = 10 * 60 * 1000;
const AGENT_RECONNECT_WINDOW = 5 * 60 * 1000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-here';
const SIMILARITY_THRESHOLD = 0.5; // Minimum similarity for knowledge base answers
const HANDOFF_THRESHOLD = 0.8; // Threshold for intelligent handoff detection

// ========== VECTOR DATABASE FUNCTIONS ========== //
async function generateEmbedding(text) {
  try {
    return await embeddingService.generateEmbedding(text);
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw error;
  }
}

async function searchKnowledgeBase(query, limit = 5) {
  try {
    console.log('🔍 Searching knowledge base for:', query);
    
    // Generate embedding for the query
    const queryEmbedding = await generateEmbedding(query);
    console.log('✅ Generated embedding, length:', queryEmbedding.length);

    // Search using the knowledge base service
    const results = await knowledgeDB.searchSimilarDocuments(queryEmbedding, SIMILARITY_THRESHOLD, limit);

    console.log(`📊 Found ${results?.length || 0} results with threshold ${SIMILARITY_THRESHOLD}`);
    if (results && results.length > 0) {
      console.log('📝 Top result similarity:', results[0].similarity);
      console.log('📝 Top result:', results[0].content?.substring(0, 100) + '...');
    } else {
      // Try with lower threshold to see what's available
      const fallbackResults = await knowledgeDB.searchSimilarDocuments(queryEmbedding, 0.1, 3);
      console.log('🔍 Fallback results (lower threshold):', fallbackResults?.length || 0);
      if (fallbackResults && fallbackResults.length > 0) {
        console.log('📝 Best similarity score:', fallbackResults[0].similarity);
      }
    }

    return results || [];
  } catch (error) {
    console.error('❌ Knowledge base search error:', error);
    return [];
  }
}

// ========== INTELLIGENT HANDOFF DETECTION ========== //
async function analyzeHandoffIntent(message, conversationHistory = []) {
  try {
    const context = `
    Analyze if this customer message indicates they want to speak with a human sales representative.

    Consider these scenarios as requiring human handoff:
    - Explicit requests for human help, agent, representative, sales person, "talk to someone"
    - Ready to purchase or buy something ("I want to buy", "how much does it cost", "pricing")
    - Complex product questions that need detailed explanation
    - Custom requirements or enterprise solutions
    - Complaints or frustration with previous responses
    - Account-specific issues requiring authorization
    - Expressions of dissatisfaction with AI responses
    - Questions about implementation, setup, or technical integration
    - Requests for demos, trials, or consultations

    Recent conversation context:
    ${conversationHistory.slice(-3).map(msg => `${msg.role}: ${msg.content}`).join('\n')}

    Current message: "${message}"

    Respond with only a JSON object:
    {
      "needsHuman": true/false,
      "confidence": 0.0-1.0,
      "reason": "brief explanation",
      "suggestedResponse": "friendly message to offer human connection"
    }
    `;

    const result = await model.generateContent(context);
    const responseText = result.response.text().trim();

    // Try to extract JSON from the response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);
      return {
        needsHuman: analysis.needsHuman || false,
        confidence: analysis.confidence || 0,
        reason: analysis.reason || '',
        suggestedResponse: analysis.suggestedResponse || ''
      };
    }

    return { needsHuman: false, confidence: 0, reason: 'Failed to analyze', suggestedResponse: '' };
  } catch (error) {
    console.error('Handoff analysis error:', error);
    return { needsHuman: false, confidence: 0, reason: 'Analysis error', suggestedResponse: '' };
  }
}

// ========== ENHANCED AI RESPONSE GENERATION ========== //
async function generateAIResponse(userMessage, conversationHistory = []) {
  try {
    // Handle greeting messages with friendly responses
    const greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'];
    const isGreeting = greetings.some(greeting => 
      userMessage.toLowerCase().trim() === greeting || userMessage.toLowerCase().includes(greeting + ' ') || userMessage.toLowerCase().includes(' ' + greeting)
    ) && userMessage.length < 30;

    if (isGreeting) {
      return {
        type: 'ai_response',
        message: "Hi there! 👋 How can I help you today?",
        sources: []
      };
    }

    // Handle meta questions about capabilities
    const metaQuestions = ['what can you help', 'what can i ask', 'what do you know', 'what topics', 'what can you answer'];
    const isMetaQuestion = metaQuestions.some(meta => 
      userMessage.toLowerCase().includes(meta)
    );

    if (isMetaQuestion) {
      // Get sample topics from knowledge base
      const sampleResults = await knowledgeDB.getAllDocuments(10);
      const topics = sampleResults.map(doc => doc.metadata?.category || 'General').filter((v, i, a) => a.indexOf(v) === i);
      
      return {
        type: 'ai_response',
        message: `I can help you with questions about: ${topics.length > 0 ? topics.join(', ') : 'our products and services'}. Feel free to ask me anything about these topics!`,
        sources: []
      };
    }

    // First, search the knowledge base
    const knowledgeResults = await searchKnowledgeBase(userMessage);

    // Check for handoff intent
    const handoffAnalysis = await analyzeHandoffIntent(userMessage, conversationHistory);

    // If high confidence handoff intent, return handoff suggestion
    if (handoffAnalysis.needsHuman && handoffAnalysis.confidence > HANDOFF_THRESHOLD) {
      return {
        type: 'handoff_suggestion',
        message: handoffAnalysis.suggestedResponse || "I'd be happy to connect you with one of our sales specialists who can give you personalized assistance.",
        reason: handoffAnalysis.reason
      };
    }

    // If no relevant knowledge found, suggest human help
    if (knowledgeResults.length === 0) {
      return {
        type: 'no_knowledge',
        message: "I don't have specific information about that. I can connect you with a human agent if you'd like more detailed assistance.",
        reason: "No relevant knowledge found",
        intent: 'unknown',
        category: 'general'
      };
    }

    // Generate response using knowledge base context with sales-focused personality
    const context = `
    You are a helpful customer service assistant. Answer ONLY based on the provided knowledge base information.

    STRICT RULES:
    - Use ONLY the information provided below
    - Do NOT add information not in the knowledge base
    - If the knowledge base doesn't contain the answer, say "I don't have that specific information"
    - Be direct and precise
    - Keep responses concise

    Knowledge base information:
    ${knowledgeResults.map(item => `- ${item.content}`).join('\n')}

    Customer question: "${userMessage}"

    Answer based ONLY on the knowledge base information above.
    `;

    const result = await model.generateContent(context);
    const responseText = result.response.text();

    // Determine intent category from knowledge results
    const category = knowledgeResults[0]?.metadata?.category || 'general';
    const intent = userMessage.toLowerCase().includes('price') || userMessage.toLowerCase().includes('cost') ? 'pricing' :
                  userMessage.toLowerCase().includes('trial') ? 'trial' :
                  userMessage.toLowerCase().includes('cancel') ? 'cancellation' :
                  userMessage.toLowerCase().includes('support') ? 'support' : 'general';

    return {
      type: 'ai_response',
      message: responseText,
      sources: knowledgeResults.map(item => ({
        content: item.content.substring(0, 100) + '...',
        similarity: item.similarity
      })),
      intent: intent,
      category: category
    };

  } catch (error) {
    console.error('AI generation error:', error);
    return {
      type: 'error',
      message: "Oops! I'm having a bit of trouble right now. Let me connect you with one of our team members who can help you better!"
    };
  }
}

// ========== UTILITY FUNCTIONS (keeping existing ones) ========== //
function setupCustomerTimeout(sessionId) {
  clearCustomerTimeout(sessionId);

  const timeoutId = setTimeout(() => {
    const conversation = conversations.get(sessionId);
    if (conversation && !conversation.hasHuman) {
      const index = waitingQueue.indexOf(sessionId);
      if (index > -1) {
        waitingQueue.splice(index, 1);

        humanAgents.forEach((agentData, agentId) => {
          if (agentData.ws && agentData.ws.readyState === WebSocket.OPEN) {
            agentData.ws.send(JSON.stringify({
              type: 'customer_timeout',
              sessionId,
              remainingQueue: waitingQueue.length
            }));
          }
        });

        console.log(`Customer ${sessionId} timed out and removed from queue`);
      }
    }
    customerTimeouts.delete(sessionId);
  }, CUSTOMER_TIMEOUT);

  customerTimeouts.set(sessionId, timeoutId);
}

function clearCustomerTimeout(sessionId) {
  const timeoutId = customerTimeouts.get(sessionId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    customerTimeouts.delete(sessionId);
  }
}

function saveChatHistory(sessionId, endReason = 'completed') {
  const conversation = conversations.get(sessionId);
  if (!conversation) return;

  const historyRecord = {
    sessionId,
    messages: [...conversation.messages],
    startTime: conversation.startTime || new Date(),
    endTime: new Date(),
    agentId: conversation.assignedAgent,
    agentName: conversation.agentName || 'Unknown',
    endReason,
    customerSatisfaction: null
  };

  chatHistory.push(historyRecord);
  console.log(`Chat history saved for session ${sessionId}`);
  return historyRecord;
}

// Keep all existing agent reconnection and session management functions...
function handleAgentReconnection(agentId, ws, user) {
  console.log(`Attempting to reconnect agent ${agentId}`);

  if (agentReconnectTimeouts.has(agentId)) {
    clearTimeout(agentReconnectTimeouts.get(agentId));
    agentReconnectTimeouts.delete(agentId);
  }

  const previousSessionId = agentSessions.get(agentId);
  console.log(`Previous session for agent ${agentId}: ${previousSessionId}`);

  if (previousSessionId) {
    const conversation = conversations.get(previousSessionId);
    console.log(`Conversation exists: ${!!conversation}`);

    if (conversation && conversation.hasHuman && conversation.assignedAgent === agentId) {
      console.log(`Restoring connection for agent ${agentId} to session ${previousSessionId}`);

      conversation.agentWs = ws;
      humanAgents.set(agentId, {
        ws,
        user,
        status: 'busy',
        sessionId: previousSessionId
      });

      ws.send(JSON.stringify({
        type: 'connection_restored',
        sessionId: previousSessionId,
        message: 'Connection restored. You can continue the conversation.',
        history: conversation.messages.slice(-10)
      }));

      if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN) {
        conversation.customerWs.send(JSON.stringify({
          type: 'agent_reconnected',
          message: `${user.name} has reconnected and is back online.`
        }));
      }

      console.log(`Agent ${user.name} (${agentId}) successfully reconnected to session ${previousSessionId}`);
      return true;
    } else {
      console.log(`Session ${previousSessionId} is no longer valid for agent ${agentId}`);
      agentSessions.delete(agentId);
      sessionAgentMap.delete(previousSessionId);
    }
  }

  console.log(`No valid session found for agent ${agentId} to reconnect to`);
  return false;
}

function handleCustomerSessionRestore(ws, sessionId) {
  console.log(`Customer attempting to restore session: ${sessionId}`);

  const conversation = conversations.get(sessionId);
  if (conversation) {
    conversation.customerWs = ws;

    ws.send(JSON.stringify({
      type: 'session_restored',
      sessionId: sessionId,
      isConnectedToHuman: conversation.hasHuman,
      agentName: conversation.agentName || null,
      message: conversation.hasHuman
        ? `Session restored. You're connected to ${conversation.agentName}.`
        : 'Session restored. You can continue chatting with our AI assistant.'
    }));

    if (conversation.hasHuman && conversation.agentWs && conversation.agentWs.readyState === WebSocket.OPEN) {
      conversation.agentWs.send(JSON.stringify({
        type: 'customer_reconnected',
        sessionId: sessionId,
        message: 'Customer has reconnected to the chat.'
      }));
    }

    console.log(`Session ${sessionId} restored successfully`);
  } else {
    conversations.set(sessionId, {
      customerWs: ws,
      messages: [],
      hasHuman: false,
      agentWs: null,
      startTime: new Date()
    });

    ws.send(JSON.stringify({
      type: 'session_restored',
      sessionId: sessionId,
      isConnectedToHuman: false,
      message: 'New session created.'
    }));

    setupCustomerTimeout(sessionId);
    console.log(`New session ${sessionId} created for customer`);
  }
}

function setupAgentReconnectTimeout(agentId, sessionId) {
  console.log(`Setting up reconnect timeout for agent ${agentId}, session ${sessionId}`);

  const timeoutId = setTimeout(() => {
    console.log(`Agent ${agentId} reconnect timeout expired, ending session ${sessionId}`);

    const conversation = conversations.get(sessionId);
    if (conversation && conversation.assignedAgent === agentId) {
      handleEndChat(sessionId, 'agent_timeout');
    }

    agentSessions.delete(agentId);
    sessionAgentMap.delete(sessionId);
    agentReconnectTimeouts.delete(agentId);
  }, AGENT_RECONNECT_WINDOW);

  agentReconnectTimeouts.set(agentId, timeoutId);
}

function sendSatisfactionSurvey(customerWs, sessionId) {
  if (customerWs && customerWs.readyState === WebSocket.OPEN) {
    customerWs.send(JSON.stringify({
      type: 'satisfaction_survey',
      sessionId,
      message: 'How was your experience with our support?',
      options: [
        { value: 5, label: '😊 Excellent' },
        { value: 4, label: '🙂 Good' },
        { value: 3, label: '😐 Okay' },
        { value: 2, label: '😕 Poor' },
        { value: 1, label: '😞 Very Poor' }
      ]
    }));
  }
}

// ========== ENHANCED MESSAGE HANDLERS ========== //
async function handleCustomerMessage(ws, sessionId, message) {
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, {
      customerWs: ws,
      messages: [],
      hasHuman: false,
      agentWs: null,
      startTime: new Date()
    });
    setupCustomerTimeout(sessionId);
  }

  const conversation = conversations.get(sessionId);
  conversation.messages.push({
    role: 'user',
    content: message,
    timestamp: new Date()
  });

  clearCustomerTimeout(sessionId);
  setupCustomerTimeout(sessionId);

  // If already connected to human agent, forward message
  if (conversation.hasHuman && conversation.agentWs) {
    if (conversation.agentWs.readyState === WebSocket.OPEN) {
      conversation.agentWs.send(JSON.stringify({
        type: 'customer_message',
        sessionId,
        message,
        timestamp: new Date()
      }));
    } else {
      const agentId = conversation.assignedAgent;
      console.log(`Agent ${agentId} connection lost for session ${sessionId}`);

      if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN) {
        conversation.customerWs.send(JSON.stringify({
          type: 'agent_disconnected_temp',
          message: 'Your agent seems to have lost connection. Please wait while they reconnect...'
        }));
      }

      if (!agentReconnectTimeouts.has(agentId)) {
        setupAgentReconnectTimeout(agentId, sessionId);
      }
    }
    return;
  }

  try {
    const aiResponse = await generateAIResponse(message, conversation.messages);

    if (aiResponse.type === 'handoff_suggestion' || aiResponse.type === 'no_knowledge') {
      // Log customer intent
      await knowledgeDB.logCustomerIntent(
        sessionId,
        message,
        aiResponse.intent || 'unknown',
        aiResponse.category || 'general',
        0,
        [],
        aiResponse.type
      );

      // Show AI response directly in handoff popup
      ws.send(JSON.stringify({
        type: 'handoff_offer',
        sessionId,
        message: aiResponse.message,
        reason: aiResponse.reason
      }));

      return;
    }

    if (aiResponse.type === 'ai_response') {
      conversation.messages.push({
        role: 'assistant',
        content: aiResponse.message,
        timestamp: new Date()
      });

      // Log customer intent
      await knowledgeDB.logCustomerIntent(
        sessionId,
        message,
        aiResponse.intent || 'general',
        aiResponse.category || 'general',
        aiResponse.sources?.[0]?.similarity || 0,
        aiResponse.sources || [],
        'ai_response'
      );

      ws.send(JSON.stringify({
        type: 'ai_response',
        message: aiResponse.message,
        sessionId,
        sources: aiResponse.sources
      }));
    } else {
      // Error case
      conversation.messages.push({
        role: 'assistant',
        content: aiResponse.message,
        timestamp: new Date()
      });

      ws.send(JSON.stringify({
        type: 'error',
        message: aiResponse.message,
        sessionId
      }));
    }
  } catch (error) {
    console.error('AI error:', error);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Sorry, I encountered an error. Would you like to connect with a human agent?'
    }));
  }
}

// Keep all existing handler functions (handleAgentJoin, handleAcceptRequest, etc.)
function handleAgentJoin(ws, data) {
  const { agentId, token } = data;

  let user;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    user = agentUsers.get(decoded.agentId);
    if (!user || !user.isActive) {
      ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid user account' }));
      ws.close();
      return;
    }
  } catch (error) {
    ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token' }));
    ws.close();
    return;
  }

  console.log(`Agent ${user.name} (${user.username}) attempting to connect`);

  const wasReconnected = handleAgentReconnection(agentId, ws, user);

  if (!wasReconnected) {
    humanAgents.set(agentId, {
      ws,
      user,
      status: 'online',
      sessionId: null
    });
  }

  ws.send(JSON.stringify({
    type: 'agent_status',
    message: wasReconnected ? `Welcome back, ${user.name}! Connection restored.` : `Welcome, ${user.name}! You're now online.`,
    waitingCustomers: waitingQueue.length,
    totalAgents: humanAgents.size,
    status: wasReconnected ? 'reconnected' : 'online',
    user: {
      id: user.id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role
    }
  }));

  if (!wasReconnected) {
    waitingQueue.forEach((sessionId, index) => {
      const conversation = conversations.get(sessionId);
      if (conversation) {
        ws.send(JSON.stringify({
          type: 'pending_request',
          sessionId,
          position: index + 1,
          totalInQueue: waitingQueue.length,
          lastMessage: conversation.messages.slice(-1)[0]?.content || "New request"
        }));
      }
    });

    humanAgents.forEach((agentData, otherId) => {
      if (otherId !== agentId && agentData.ws && agentData.ws.readyState === WebSocket.OPEN) {
        agentData.ws.send(JSON.stringify({
          type: 'agent_joined',
          agentId: agentId,
          agentName: user.name,
          totalAgents: humanAgents.size
        }));
      }
    });
  }
}

function handleAcceptRequest(sessionId, agentId) {
  const conversation = conversations.get(sessionId);
  const agentData = humanAgents.get(agentId);

  if (!conversation || !agentData) {
    console.log('Cannot accept request - conversation or agent not found');
    return;
  }

  if (conversation.hasHuman) {
    agentData.ws.send(JSON.stringify({
      type: 'request_already_taken',
      message: 'This customer has already been assigned to another agent',
      sessionId
    }));
    return;
  }

  conversation.hasHuman = true;
  conversation.agentWs = agentData.ws;
  conversation.assignedAgent = agentId;
  conversation.agentName = agentData.user.name;

  agentSessions.set(agentId, sessionId);
  sessionAgentMap.set(sessionId, agentId);

  agentData.status = 'busy';
  agentData.sessionId = sessionId;

  clearCustomerTimeout(sessionId);

  const index = waitingQueue.indexOf(sessionId);
  if (index > -1) waitingQueue.splice(index, 1);

  humanAgents.forEach((otherAgentData, otherId) => {
    if (otherId !== agentId && otherAgentData.ws && otherAgentData.ws.readyState === WebSocket.OPEN) {
      otherAgentData.ws.send(JSON.stringify({
        type: 'request_taken',
        sessionId,
        takenBy: agentData.user.name,
        remainingQueue: waitingQueue.length
      }));
    }
  });

  if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN) {
    conversation.customerWs.send(JSON.stringify({
      type: 'human_joined',
      message: `${agentData.user.name} has joined the chat! How can I help you?`
    }));
  }

  agentData.ws.send(JSON.stringify({
    type: 'customer_assigned',
    sessionId,
    history: conversation.messages,
    queuePosition: 0,
    cannedResponses: [
      "Thank you for contacting us! How can I assist you today?",
      "I understand your concern. Let me look into this for you right away.",
      "Is there anything else I can help you with?",
      "Let me transfer you to a specialist who can better assist you.",
      "Thank you for your patience. I have the information you need.",
      "I apologize for any inconvenience. Let me resolve this for you.",
      "Your issue has been resolved. Is there anything else you need help with?"
    ]
  }));

  console.log(`Agent ${agentData.user.name} accepted request for session ${sessionId}. Queue now: ${waitingQueue.length}`);
}

function handleAgentMessage(sessionId, message, messageType = 'text') {
  const conversation = conversations.get(sessionId);
  if (!conversation || !conversation.customerWs) {
    console.log('Cannot send agent message - conversation or customer not found');
    return;
  }

  conversation.messages.push({
    role: 'agent',
    content: message,
    messageType,
    timestamp: new Date()
  });

  if (conversation.customerWs.readyState === WebSocket.OPEN) {
    conversation.customerWs.send(JSON.stringify({
      type: 'agent_message',
      message,
      messageType,
      timestamp: new Date()
    }));
  }
}

function handleEndChat(sessionId, endReason = 'agent_ended') {
  const conversation = conversations.get(sessionId);
  if (!conversation) return;

  const agentId = conversation.assignedAgent;
  const agentData = humanAgents.get(agentId);

  saveChatHistory(sessionId, endReason);

  if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN && endReason !== 'agent_timeout') {
    sendSatisfactionSurvey(conversation.customerWs, sessionId);

    setTimeout(() => {
      if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN) {
        const message = endReason === 'agent_timeout'
          ? 'Your agent has been disconnected for too long. The chat has been ended. Feel free to start a new conversation!'
          : 'The agent has ended the chat. Feel free to ask me anything else!';

        conversation.customerWs.send(JSON.stringify({
          type: 'agent_left',
          message: message
        }));
      }
    }, 5000);
  }

  conversation.hasHuman = false;
  conversation.agentWs = null;
  conversation.assignedAgent = null;
  conversation.agentName = null;

  if (agentId) {
    if (agentData) {
      agentData.status = 'online';
      agentData.sessionId = null;
    }
    agentSessions.delete(agentId);
    sessionAgentMap.delete(sessionId);

    if (agentReconnectTimeouts.has(agentId)) {
      clearTimeout(agentReconnectTimeouts.get(agentId));
      agentReconnectTimeouts.delete(agentId);
    }
  }

  humanAgents.forEach((otherAgentData, otherId) => {
    if (otherId !== agentId && otherAgentData.ws && otherAgentData.ws.readyState === WebSocket.OPEN) {
      otherAgentData.ws.send(JSON.stringify({
        type: 'chat_ended',
        sessionId,
        endedBy: agentData ? agentData.user.name : 'Unknown',
        endReason,
        totalQueue: waitingQueue.length
      }));
    }
  });

  console.log(`Chat ended for session ${sessionId} by ${endReason}. Agent: ${agentData ? agentData.user.name : 'Unknown'}`);
}

async function handleHumanRequest(sessionId) {
  const conversation = conversations.get(sessionId);
  if (!conversation) return;

  if (humanAgents.size === 0) {
    conversation.customerWs.send(JSON.stringify({
      type: 'no_agents_available',
      message: 'Sorry, no human agents are currently available. Please try again later or continue chatting with me!'
    }));
    return;
  }

  if (!waitingQueue.includes(sessionId)) {
    waitingQueue.push(sessionId);
  }

  const queuePosition = waitingQueue.indexOf(sessionId) + 1;

  humanAgents.forEach((agentData, agentId) => {
    if (agentData.ws && agentData.ws.readyState === WebSocket.OPEN) {
      agentData.ws.send(JSON.stringify({
        type: 'pending_request',
        sessionId,
        position: queuePosition,
        totalInQueue: waitingQueue.length,
        lastMessage: conversation.messages.slice(-1)[0]?.content || "Customer wants to speak with human"
      }));
    }
  });

  if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN) {
    conversation.customerWs.send(JSON.stringify({
      type: 'waiting_for_human',
      message: `You've been added to the queue (position ${queuePosition}). A human agent will be with you shortly.`
    }));
  }

  console.log(`Human request added to queue for session ${sessionId}, position ${queuePosition}`);
}

// ========== ENHANCED MESSAGE HANDLING ========== //
async function handleWebSocketMessage(ws, data) {
  try {
    console.log('Received message:', data.type);

    switch(data.type) {
      case 'customer_message':
        await handleCustomerMessage(ws, data.sessionId, data.message);
        break;
      case 'agent_join':
        handleAgentJoin(ws, data);
        break;
      case 'agent_message':
        handleAgentMessage(data.sessionId, data.message);
        break;
      case 'request_human':
        await handleHumanRequest(data.sessionId);
        break;
      case 'accept_request':
        handleAcceptRequest(data.sessionId, data.agentId);
        break;
      case 'end_chat':
        handleEndChat(data.sessionId);
        break;
      case 'restore_session':
        handleCustomerSessionRestore(ws, data.sessionId);
        break;
      case 'handoff_response':
        // Handle customer's response to handoff offer
        if (data.accepted) {
          await handleHumanRequest(data.sessionId);
        } else {
          const conversation = conversations.get(data.sessionId);
          if (conversation && conversation.customerWs) {
            // Reset AI state - don't add to history to avoid loop
            conversation.customerWs.send(JSON.stringify({
              type: 'ai_response',
              message: "No problem! I'm here to help. What else can I assist you with?",
              sessionId: data.sessionId
            }));
          }
        }
        break;
      case 'end_session':
        // Handle customer ending session
        const conversation = conversations.get(data.sessionId);
        if (conversation) {
          if (conversation.hasHuman) {
            handleEndChat(data.sessionId, 'customer_ended');
          } else {
            // Clear the session for AI-only conversations
            conversations.delete(data.sessionId);
            clearCustomerTimeout(data.sessionId);
            
            // Remove from waiting queue if present
            const queueIndex = waitingQueue.indexOf(data.sessionId);
            if (queueIndex > -1) {
              waitingQueue.splice(queueIndex, 1);
            }

            if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN) {
              conversation.customerWs.send(JSON.stringify({
                type: 'session_ended',
                message: 'Session ended. Thank you for chatting with us!'
              }));
            }
          }
        }
        break;
      case 'satisfaction_response':
        // Handle satisfaction survey response
        const historyIndex = chatHistory.findIndex(h => h.sessionId === data.sessionId);
        if (historyIndex !== -1) {
          chatHistory[historyIndex].customerSatisfaction = {
            rating: data.rating,
            feedback: data.feedback,
            timestamp: new Date()
          };
          console.log(`Satisfaction response saved for session ${data.sessionId}: ${data.rating}/5`);
        }
        break;
      default:
        console.log('Unknown message type:', data.type);
    }
  } catch (error) {
    console.error('Message handling error:', error);
  }
}

// ========== WEBSOCKET SETUP ========== //
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      await handleWebSocketMessage(ws, data);
    } catch (error) {
      console.error('Message parse error:', error);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');

    // Clean up disconnected agents
    for (const [agentId, agentData] of humanAgents) {
      if (agentData.ws === ws) {
        const sessionId = agentSessions.get(agentId);

        if (sessionId) {
          const conversation = conversations.get(sessionId);
          if (conversation && conversation.hasHuman) {
            console.log(`Agent ${agentData.user.name} disconnected from session ${sessionId}`);

            if (!agentReconnectTimeouts.has(agentId)) {
              setupAgentReconnectTimeout(agentId, sessionId);
            }

            if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN) {
              conversation.customerWs.send(JSON.stringify({
                type: 'agent_disconnected_temp',
                message: 'Your agent seems to have lost connection. They should be back shortly...'
              }));
            }
          }
        }

        humanAgents.delete(agentId);

        humanAgents.forEach((otherAgentData, otherId) => {
          if (otherAgentData.ws && otherAgentData.ws.readyState === WebSocket.OPEN) {
            otherAgentData.ws.send(JSON.stringify({
              type: 'agent_left',
              agentId,
              agentName: agentData.user.name,
              totalAgents: humanAgents.size
            }));
          }
        });

        console.log(`Agent ${agentData.user.name} (${agentId}) disconnected`);
        break;
      }
    }

    // Clean up disconnected customers
    for (const [sessionId, conversation] of conversations) {
      if (conversation.customerWs === ws) {
        console.log(`Customer ${sessionId} disconnected`);

        clearCustomerTimeout(sessionId);

        const queueIndex = waitingQueue.indexOf(sessionId);
        if (queueIndex > -1) {
          waitingQueue.splice(queueIndex, 1);

          humanAgents.forEach((agentData, agentId) => {
            if (agentData.ws && agentData.ws.readyState === WebSocket.OPEN) {
              agentData.ws.send(JSON.stringify({
                type: 'customer_left_queue',
                sessionId,
                remainingQueue: waitingQueue.length
              }));
            }
          });
        }

        if (conversation.hasHuman) {
          saveChatHistory(sessionId, 'customer_disconnected');
        }

        break;
      }
    }
  });
});

// ========== AUTHENTICATION ROUTES ========== //
app.post('/api/agent/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    let foundUser = null;
    for (const [id, user] of agentUsers) {
      if (user.username === username && user.isActive) {
        foundUser = { id, ...user };
        break;
      }
    }

    if (!foundUser) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValidPassword = await bcrypt.compare(password, foundUser.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      {
        agentId: foundUser.id,
        username: foundUser.username,
        role: foundUser.role
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    const { password: _, ...userWithoutPassword } = foundUser;

    res.json({
      success: true,
      token,
      user: userWithoutPassword
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/agent/validate', verifyToken, (req, res) => {
  const user = agentUsers.get(req.user.agentId);
  if (!user || !user.isActive) {
    return res.status(401).json({ error: 'Invalid user account' });
  }

  const { password: _, ...userWithoutPassword } = user;
  res.json({
    success: true,
    user: { id: user.id, ...userWithoutPassword }
  });
});

function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ========== KNOWLEDGE BASE API ROUTES ========== //
const multer = require('multer');
const PDFIngestionService = require('./knowledge-base/ingest-pdf');

// Configure multer for file uploads
const upload = multer({ 
  dest: './temp/',
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
      'application/msword', // .doc
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
      'application/vnd.ms-excel' // .xls
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, Word, and Excel files are allowed'));
    }
  }
});

const pdfIngestionService = new PDFIngestionService();

// Upload documents endpoint
app.post('/api/knowledge-base/upload', verifyToken, upload.array('documents', 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const title = req.body.title || '';
    const results = [];
    let successCount = 0;

    for (const file of req.files) {
      try {
        // Determine file type and process accordingly
        const fileExt = file.originalname.split('.').pop().toLowerCase();
        const cleanTitle = title || file.originalname.replace(/\.[^/.]+$/, '');
        
        const result = await pdfIngestionService.ingestPDF(file.path, cleanTitle);
        results.push({ filename: file.originalname, ...result });
        if (result.success) successCount++;
        
        // Clean up uploaded file
        require('fs').unlinkSync(file.path);
      } catch (error) {
        console.error(`Failed to process ${file.originalname}:`, error);
        results.push({ 
          filename: file.originalname, 
          success: false, 
          error: error.message 
        });
        
        // Clean up uploaded file even on error
        try {
          require('fs').unlinkSync(file.path);
        } catch (cleanupError) {
          console.error('Failed to cleanup file:', cleanupError);
        }
      }
    }

    res.json({
      success: true,
      processedFiles: successCount,
      totalFiles: req.files.length,
      results: results
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get all documents
app.get('/api/knowledge-base/documents', verifyToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const documents = await knowledgeDB.getGroupedDocuments(limit);
    res.json(documents);
  } catch (error) {
    console.error('Get documents error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete document
app.delete('/api/knowledge-base/documents/:id', verifyToken, async (req, res) => {
  try {
    const filename = req.params.id;
    if (filename.includes('.')) {
      // Delete entire document group by filename
      await knowledgeDB.deleteDocumentGroup(filename);
    } else {
      // Delete single chunk by ID
      const id = parseInt(filename);
      await knowledgeDB.deleteDocument(id);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Delete document error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get knowledge base statistics
app.get('/api/knowledge-base/stats', verifyToken, async (req, res) => {
  try {
    const stats = await knowledgeDB.getDocumentStats();
    res.json(stats);
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== ROUTES ========== //
app.get('/agent', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/agent-dashboard.html'));
});

app.get('/kb-login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/kb-login.html'));
});

app.get('/knowledge-base', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/knowledge-base.html'));
});

// Test knowledge base endpoint
app.get('/test-kb', async (req, res) => {
  try {
    const query = req.query.q || 'pricing';
    console.log('Testing knowledge base with query:', query);
    
    // Test direct database query first
    const { data: allDocs, error: countError } = await supabase
      .from('documents')
      .select('id, content, metadata')
      .limit(5);
    
    if (countError) {
      return res.json({ error: 'Database connection failed', details: countError });
    }
    
    console.log(`Found ${allDocs?.length || 0} total documents in database`);
    
    // Test embedding search
    const results = await searchKnowledgeBase(query, 3);
    
    // Test direct function call
    const queryEmbedding = await generateEmbedding(query);
    const { data: directResults, error: directError } = await supabase.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: 0.0,
      match_count: 3
    });
    
    console.log('Direct function test:', directResults?.length || 0, 'results');
    if (directError) console.log('Direct function error:', directError);
    
    res.json({
      query,
      totalDocuments: allDocs?.length || 0,
      sampleDocuments: allDocs?.map(doc => ({ id: doc.id, preview: doc.content?.substring(0, 100) + '...' })) || [],
      searchResults: results.length,
      results: results.map(r => ({ 
        similarity: r.similarity, 
        preview: r.content?.substring(0, 100) + '...' 
      })),
      directResults: directResults?.map(r => ({
        similarity: r.similarity,
        preview: r.content?.substring(0, 100) + '...'
      })) || [],
      threshold: SIMILARITY_THRESHOLD,
      embeddingLength: queryEmbedding?.length
    });
  } catch (error) {
    console.error('Test KB error:', error);
    res.json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    agents: humanAgents.size,
    queue: waitingQueue.length,
    conversations: conversations.size,
    activeAgents: Array.from(humanAgents.values()).filter(agent => agent.status === 'online').length,
    activeSessions: agentSessions.size
  });
});

app.get('/analytics', verifyToken, (req, res) => {
  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const recentChats = chatHistory.filter(chat => chat.endTime >= last24h);
  const avgSatisfaction = recentChats
    .filter(chat => chat.customerSatisfaction?.rating)
    .reduce((sum, chat, _, arr) => sum + (chat.customerSatisfaction.rating / arr.length), 0);

  const avgChatDuration = recentChats.length > 0
    ? recentChats.reduce((sum, chat, _, arr) => {
        const duration = chat.endTime - chat.startTime;
        return sum + (duration / arr.length);
      }, 0) / 1000 / 60
    : 0;

  res.json({
    totalChats: chatHistory.length,
    last24hChats: recentChats.length,
    averageSatisfaction: Math.round(avgSatisfaction * 100) / 100,
    averageChatDuration: Math.round(avgChatDuration * 100) / 100,
    currentQueue: waitingQueue.length,
    activeAgents: humanAgents.size,
    agentStatuses: Object.fromEntries([...humanAgents.entries()].map(([id, data]) => [id, {
      name: data.user.name,
      username: data.user.username,
      status: data.status,
      sessionId: data.sessionId
    }])),
    pendingReconnections: agentSessions.size
  });
});

app.get('/chat-history', verifyToken, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const recentChats = chatHistory
    .slice(-limit)
    .map(chat => ({
      sessionId: chat.sessionId,
      startTime: chat.startTime,
      endTime: chat.endTime,
      agentId: chat.agentId,
      agentName: chat.agentName,
      messageCount: chat.messages.length,
      satisfaction: chat.customerSatisfaction?.rating || null,
      endReason: chat.endReason
    }));

  res.json(recentChats);
});

// Initialize and start server
async function startServer() {
  await initializeAgentUsers();

  server.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on port ${process.env.PORT || 3000}`);
    console.log('Available agent accounts:');
    for (const [id, user] of agentUsers) {
      console.log(`- ${user.name} (${user.username}) - Role: ${user.role}`);
    }
  });
}

startServer();