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
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" }); // Gemini 2.5 Flash Lite
const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-001" }); // Gemini Embeddings 001

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
const customerIdleTimeouts = new Map();
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
const CUSTOMER_IDLE_WARNING = 10 * 60 * 1000; // 10 minutes for idle warning
const CUSTOMER_IDLE_TIMEOUT = (10 * 60 * 1000) + (30 * 1000); // 10 minutes + 30 seconds total
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

    If the message is a greeting or pleasantry (e.g., 'hi', 'hello', 'how are you', 'good morning', 'hey', 'greetings', 'how's it going', 'good day', etc.), set needsHuman to false and reason to 'Greeting message'.

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
      // For greetings, skip handoff analysis and return friendly response only
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

    // Only analyze handoff intent if not a greeting
    const handoffAnalysis = await analyzeHandoffIntent(userMessage, conversationHistory);

    // If high confidence handoff intent, return handoff suggestion
    if (handoffAnalysis.needsHuman && handoffAnalysis.confidence > HANDOFF_THRESHOLD) {
      return {
        type: 'handoff_suggestion',
        message: handoffAnalysis.suggestedResponse || "I'd be happy to connect you with one of our sales specialists who can give you personalized assistance.",
        reason: handoffAnalysis.reason
      };
    }

    // Check if message is a question
    const isQuestion = userMessage.includes('?') || 
                      userMessage.toLowerCase().startsWith('what') ||
                      userMessage.toLowerCase().startsWith('how') ||
                      userMessage.toLowerCase().startsWith('when') ||
                      userMessage.toLowerCase().startsWith('where') ||
                      userMessage.toLowerCase().startsWith('why') ||
                      userMessage.toLowerCase().startsWith('can') ||
                      userMessage.toLowerCase().startsWith('do') ||
                      userMessage.toLowerCase().startsWith('does') ||
                      userMessage.toLowerCase().startsWith('is') ||
                      userMessage.toLowerCase().startsWith('are');

    let context;
    if (isQuestion && knowledgeResults.length === 0) {
      // No knowledge found for question - suggest human handoff
      return {
        type: 'handoff_suggestion',
        message: "I'm sorry, I couldn't find specific information about that. Would you like to connect with human support?",
        reason: "No relevant knowledge found for customer question"
      };
    } else if (isQuestion) {
      // Question with knowledge available
      context = `You are a helpful customer support assistant. Please answer customer questions using only the information provided from the documents table in the Supabase datastore.

Knowledge base information:
${knowledgeResults.map(item => `- ${item.content}`).join('\n')}

Customer question: "${userMessage}"

Answer based ONLY on the knowledge base information above. Be direct and concise.`;
    } else {
      // Not a question - reply without checking knowledge base
      context = `You are a helpful customer support assistant. The customer said: "${userMessage}"

This is not a question, so respond appropriately without needing to check any knowledge base. Be friendly and helpful.`;
    }

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
      message: "Oops! I'm having a bit of trouble right now. Would you like to connect with human support?"
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

function setupCustomerIdleTimeout(sessionId) {
  clearCustomerIdleTimeout(sessionId);

  const timeoutId = setTimeout(() => {
    const conversation = conversations.get(sessionId);
    if (conversation) {
      console.log(`Customer ${sessionId} idle timeout - ending session`);
      
      if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN) {
        conversation.customerWs.send(JSON.stringify({
          type: 'session_timeout',
          message: 'Your session has ended due to inactivity. Feel free to start a new conversation!'
        }));
      }

      if (conversation.hasHuman) {
        handleEndChat(sessionId, 'customer_idle');
      } else {
        // Clean up AI-only session
        conversations.delete(sessionId);
        const queueIndex = waitingQueue.indexOf(sessionId);
        if (queueIndex > -1) {
          waitingQueue.splice(queueIndex, 1);
        }
      }
    }
    customerIdleTimeouts.delete(sessionId);
  }, CUSTOMER_IDLE_TIMEOUT);

  customerIdleTimeouts.set(sessionId, timeoutId);
}

function clearCustomerIdleTimeout(sessionId) {
  const timeoutId = customerIdleTimeouts.get(sessionId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    customerIdleTimeouts.delete(sessionId);
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
    
    // Reset idle timeout on session restore
    setupCustomerIdleTimeout(sessionId);

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
    setupCustomerIdleTimeout(sessionId);
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

function sendSatisfactionSurvey(customerWs, sessionId, interactionType = 'human_agent') {
  if (customerWs && customerWs.readyState === WebSocket.OPEN) {
    customerWs.send(JSON.stringify({
      type: 'satisfaction_survey',
      sessionId,
      interactionType,
      message: interactionType === 'ai_only' 
        ? 'How was your experience with our AI assistant?' 
        : 'How was your experience with our support?',
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
    // If agent already exists, just update the WebSocket (don't create duplicate)
    if (humanAgents.has(agentId)) {
      const existingAgent = humanAgents.get(agentId);
      existingAgent.ws = ws;
      console.log(`Updated WebSocket for existing agent ${user.name}`);
    } else {
      humanAgents.set(agentId, {
        ws,
        user,
        status: 'online',
        sessionId: null
      });
    }
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
    if (agentData.ws && agentData.ws.readyState === WebSocket.OPEN) {
      agentData.ws.send(JSON.stringify({
        type: 'request_already_taken',
        message: 'This customer has already been assigned to another agent',
        sessionId
      }));
    }
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
      message: `${agentData.user.name} has joined the chat!`
    }));
  }

  if (agentData.ws && agentData.ws.readyState === WebSocket.OPEN) {
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
    console.log(`✅ Customer assigned message sent to agent ${agentData.user.name}`);
  } else {
    console.log(`❌ Agent WebSocket not available for ${agentData.user.name}`);
  }

  console.log(`Agent ${agentData.user.name} accepted request for session ${sessionId}. Queue now: ${waitingQueue.length}`);
}

function handleAgentMessage(sessionId, message, messageType = 'text') {
  console.log(`\n=== AGENT MESSAGE DEBUG ===`);
  console.log(`Session ID: ${sessionId}`);
  console.log(`Message: ${message}`);
  
  const conversation = conversations.get(sessionId);
  if (!conversation) {
    console.log('❌ Cannot send agent message - conversation not found');
    console.log(`Available conversations: ${Array.from(conversations.keys()).join(', ')}`);
    return;
  }
  
  console.log(`✅ Conversation found`);
  console.log(`Has human: ${conversation.hasHuman}`);
  console.log(`Assigned agent: ${conversation.assignedAgent}`);
  console.log(`Agent name: ${conversation.agentName}`);

  if (!conversation.customerWs) {
    console.log('❌ Cannot send agent message - customer not connected');
    return;
  }
  
  console.log(`✅ Customer WebSocket exists`);
  console.log(`Customer WebSocket state: ${conversation.customerWs.readyState}`);

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
    console.log(`✅ Agent message sent successfully to customer`);
  } else {
    console.log(`❌ Customer WebSocket not open (state: ${conversation.customerWs.readyState})`);
  }
  console.log(`=== END DEBUG ===\n`);
}

function handleEndChat(sessionId, endReason = 'agent_ended') {
  const conversation = conversations.get(sessionId);
  if (!conversation) return;

  const agentId = conversation.assignedAgent;
  const agentData = humanAgents.get(agentId);

  saveChatHistory(sessionId, endReason);

  // Notify customer and show survey if session had human agent
  if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN && endReason !== 'agent_timeout') {
    if (endReason === 'agent_ended' || endReason === 'customer_ended') {
      sendSatisfactionSurvey(conversation.customerWs, sessionId, 'human_agent');
    }

    setTimeout(() => {
      if (conversation.customerWs && conversation.customerWs.readyState === WebSocket.OPEN) {
        const message = endReason === 'agent_timeout'
          ? 'Your agent has been disconnected for too long. The chat has been ended. Feel free to start a new conversation!'
          : endReason === 'customer_ended'
          ? 'Session ended. Thank you for chatting with us!'
          : 'The agent has ended the chat. Feel free to ask me anything else!';

        conversation.customerWs.send(JSON.stringify({
          type: 'agent_left',
          message: message
        }));
      }
    }, endReason === 'customer_ended' ? 0 : 5000);
  }

  // Notify agent if session ended by customer
  if (conversation.agentWs && conversation.agentWs.readyState === WebSocket.OPEN && endReason === 'customer_ended') {
    conversation.agentWs.send(JSON.stringify({
      type: 'session_ended_by_customer',
      sessionId,
      message: 'Customer has ended the session.'
    }));
  }

  // Clean up conversation state
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

  // Notify other agents
  humanAgents.forEach((otherAgentData, otherId) => {
    if (otherId !== agentId && otherAgentData.ws && otherAgentData.ws.readyState === WebSocket.OPEN) {
      otherAgentData.ws.send(JSON.stringify({
        type: 'chat_ended',
        sessionId,
        endedBy: endReason === 'customer_ended' ? 'Customer' : (agentData ? agentData.user.name : 'Unknown'),
        endReason,
        totalQueue: waitingQueue.length
      }));
    }
  });

  console.log(`Chat ended for session ${sessionId} by ${endReason}. Agent: ${agentData ? agentData.user.name : 'Unknown'}`);
}

async function handleHumanRequest(sessionId, customerInfo = null) {
  console.log('🔍 handleHumanRequest called with:', { sessionId, customerInfo });
  const conversation = conversations.get(sessionId);
  if (!conversation) {
    console.log('❌ No conversation found for session:', sessionId);
    return;
  }

  // Store customer info if provided
  if (customerInfo) {
    console.log('✅ Customer info provided:', customerInfo);
    conversation.customerInfo = customerInfo;
    
    // Log customer intent with info
    await knowledgeDB.logCustomerIntent(
      sessionId,
      'Customer requested human support',
      'human_request',
      'support',
      0,
      [],
      'human_request',
      customerInfo
    );
    console.log('✅ Customer intent logged with info');
  } else {
    console.log('⚠️ No customer info provided');
    // Log human request without customer info
    await knowledgeDB.logCustomerIntent(
      sessionId,
      'Customer requested human support',
      'human_request',
      'support',
      0,
      [],
      'human_request'
    );
    console.log('✅ Customer intent logged without info');
  }

  // Get all agents with active WebSocket connections for notifications
  const connectedAgents = Array.from(humanAgents.values()).filter(agent => 
    agent.ws && agent.ws.readyState === WebSocket.OPEN
  );

  // Check if any agents are available with active connections
  if (connectedAgents.length === 0) {
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

  // Send notifications to agents with active WebSocket connections
  connectedAgents.forEach((agentData) => {
    agentData.ws.send(JSON.stringify({
      type: 'pending_request',
      sessionId,
      position: queuePosition,
      totalInQueue: waitingQueue.length,
      lastMessage: conversation.messages.slice(-1)[0]?.content || "Customer wants to speak with human"
    }));
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
        console.log(`Received agent_message for session ${data.sessionId}`);
        handleAgentMessage(data.sessionId, data.message);
        break;
      case 'request_human':
        console.log('🔍 Received request_human message:', data);
        await handleHumanRequest(data.sessionId, data.customerInfo);
        break;
      case 'accept_request':
        console.log(`Agent ${data.agentId} accepting request ${data.sessionId}`);
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
          // Don't directly connect, let client show customer info dialog
          const conversation = conversations.get(data.sessionId);
          if (conversation && conversation.customerWs) {
            conversation.customerWs.send(JSON.stringify({
              type: 'show_customer_info_dialog',
              sessionId: data.sessionId
            }));
          }
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
            // End chat with human agent
            handleEndChat(data.sessionId, 'customer_ended');
          } else {
            // Show survey for AI-only conversations if they had meaningful interaction
            if (conversation.messages && conversation.messages.length > 2) {
              sendSatisfactionSurvey(conversation.customerWs, data.sessionId, 'ai_only');
              
              setTimeout(() => {
                // Clear the session for AI-only conversations after survey
                conversations.delete(data.sessionId);
                clearCustomerTimeout(data.sessionId);
                
                // Remove from waiting queue if present
                const queueIndex = waitingQueue.indexOf(data.sessionId);
                if (queueIndex > -1) {
                  waitingQueue.splice(queueIndex, 1);
                  
                  // Notify agents about queue update
                  humanAgents.forEach((agentData, agentId) => {
                    if (agentData.ws && agentData.ws.readyState === WebSocket.OPEN) {
                      agentData.ws.send(JSON.stringify({
                        type: 'customer_left_queue',
                        sessionId: data.sessionId,
                        remainingQueue: waitingQueue.length
                      }));
                    }
                  });
                }
              }, 10000); // Give time for survey completion
            } else {
              // No meaningful interaction, just end session
              conversations.delete(data.sessionId);
              clearCustomerTimeout(data.sessionId);
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
      case 'file_uploaded':
        // Handle file upload notification
        const fileConversation = conversations.get(data.sessionId);
        if (fileConversation && fileConversation.agentWs && fileConversation.agentWs.readyState === WebSocket.OPEN) {
          fileConversation.agentWs.send(JSON.stringify({
            type: 'customer_file_uploaded',
            sessionId: data.sessionId,
            fileInfo: data.fileInfo
          }));
        }
        break;
      case 'satisfaction_response':
        // Handle satisfaction survey response
        await saveFeedbackToDatabase(data);
        const historyIndex = chatHistory.findIndex(h => h.sessionId === data.sessionId);
        if (historyIndex !== -1) {
          chatHistory[historyIndex].customerSatisfaction = {
            rating: data.rating,
            feedback: data.feedback,
            customerName: data.customerName,
            customerEmail: data.customerEmail,
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

        // Don't delete agent, just mark WebSocket as null to keep them available
        agentData.ws = null;
        console.log(`Agent ${agentData.user.name} (${agentId}) WebSocket disconnected but keeping agent available`);
        break;
      }
    }

    // Clean up disconnected customers
    for (const [sessionId, conversation] of conversations) {
      if (conversation.customerWs === ws) {
        console.log(`Customer ${sessionId} disconnected`);

        clearCustomerTimeout(sessionId);
        clearCustomerIdleTimeout(sessionId);

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

// Configure multer for knowledge base uploads
const kbUpload = multer({ 
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

// Configure multer for customer attachments
const upload = multer({
  dest: './uploads/',
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'text/plain'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed'));
    }
  }
});

const pdfIngestionService = new PDFIngestionService();

// Upload documents endpoint
app.post('/api/knowledge-base/upload', verifyToken, kbUpload.array('documents', 10), async (req, res) => {
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

// ========== FEEDBACK STORAGE ========== //
async function saveFeedbackToDatabase(data) {
  try {
    const conversation = conversations.get(data.sessionId);
    const historyRecord = chatHistory.find(h => h.sessionId === data.sessionId);
    
    const { error } = await supabase
      .from('customer_feedback')
      .insert({
        session_id: data.sessionId,
        customer_name: data.customerName || null,
        customer_email: data.customerEmail || null,
        rating: data.rating,
        feedback_text: data.feedback || null,
        interaction_type: data.interactionType || 'human_agent',
        agent_id: conversation?.assignedAgent || historyRecord?.agentId || null,
        agent_name: conversation?.agentName || historyRecord?.agentName || null
      });

    if (error) {
      console.error('Error saving feedback to database:', error);
    } else {
      console.log(`Feedback saved to database for session ${data.sessionId}`);
    }
  } catch (error) {
    console.error('Database error saving feedback:', error);
  }
}

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

app.get('/feedback', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/feedback-dashboard.html'));
});

app.get('/intents', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/intents-dashboard.html'));
});

app.get('/files', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/file-history.html'));
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

// Get customer feedback with filters
app.get('/api/feedback', verifyToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    let query = supabase
      .from('customer_feedback')
      .select('*')
      .order('created_at', { ascending: false });

    // Apply filters
    if (req.query.interaction_type) {
      query = query.eq('interaction_type', req.query.interaction_type);
    }
    if (req.query.rating) {
      query = query.eq('rating', parseInt(req.query.rating));
    }
    if (req.query.date_from) {
      query = query.gte('created_at', req.query.date_from);
    }
    if (req.query.date_to) {
      query = query.lte('created_at', req.query.date_to + 'T23:59:59');
    }

    const { data, error } = await query.range(offset, offset + limit - 1);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (error) {
    console.error('Error fetching feedback:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// File upload endpoint
app.post('/api/upload-attachment', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { sessionId } = req.body;
    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'Session ID required' });
    }

    // Store file info in database
    const { error } = await supabase
      .from('customer_attachments')
      .insert({
        session_id: sessionId,
        filename: req.file.filename,
        original_filename: req.file.originalname,
        file_size: req.file.size,
        file_type: req.file.mimetype,
        file_url: `/uploads/${req.file.filename}`
      });

    if (error) {
      console.error('Error saving attachment:', error);
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    res.json({
      success: true,
      fileInfo: {
        filename: req.file.originalname,
        size: req.file.size,
        url: `/uploads/${req.file.filename}`
      }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get attachments for session
app.get('/api/attachments/:sessionId', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('customer_attachments')
      .select('*')
      .eq('session_id', req.params.sessionId)
      .order('uploaded_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data || []);
  } catch (error) {
    console.error('Error fetching attachments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve uploaded files with original filename
app.get('/uploads/:filename', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('customer_attachments')
      .select('original_filename')
      .eq('filename', req.params.filename)
      .single();

    if (error || !data) {
      return res.status(404).send('File not found');
    }

    const filePath = path.join(__dirname, 'uploads', req.params.filename);
    res.download(filePath, data.original_filename);
  } catch (error) {
    res.status(500).send('Error downloading file');
  }
});

// Get customer intents with filters
app.get('/api/intents', verifyToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    let query = supabase
      .from('customer_intents')
      .select('*')
      .order('created_at', { ascending: false });

    // Apply filters
    if (req.query.intent_category) {
      query = query.eq('intent_category', req.query.intent_category);
    }
    if (req.query.response_type) {
      query = query.eq('response_type', req.query.response_type);
    }
    if (req.query.date_from) {
      query = query.gte('created_at', req.query.date_from);
    }
    if (req.query.date_to) {
      query = query.lte('created_at', req.query.date_to + 'T23:59:59');
    }
    if (req.query.customer_country) {
      query = query.ilike('customer_country', `%${req.query.customer_country}%`);
    }
    if (req.query.customer_name) {
      query = query.or(`customer_firstname.ilike.%${req.query.customer_name}%,customer_lastname.ilike.%${req.query.customer_name}%`);
    }
    if (req.query.customer_email) {
      query = query.ilike('customer_email', `%${req.query.customer_email}%`);
    }

    const { data, error } = await query.range(offset, offset + limit - 1);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data || []);
  } catch (error) {
    console.error('Error fetching intents:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get file history with filters
app.get('/api/file-history', verifyToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    
    let query = supabase
      .from('customer_attachments')
      .select('*')
      .order('uploaded_at', { ascending: false });

    // Apply filters
    if (req.query.session_id) {
      query = query.eq('session_id', req.query.session_id);
    }
    if (req.query.file_type) {
      query = query.like('file_type', `${req.query.file_type}%`);
    }
    if (req.query.date_from) {
      query = query.gte('uploaded_at', req.query.date_from);
    }
    if (req.query.date_to) {
      query = query.lte('uploaded_at', req.query.date_to + 'T23:59:59');
    }

    const { data, error } = await query.range(offset, offset + limit - 1);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data || []);
  } catch (error) {
    console.error('Error fetching file history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete selected attachments
app.delete('/api/delete-attachments', verifyToken, async (req, res) => {
  try {
    const { fileIds } = req.body;
    
    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({ error: 'No file IDs provided' });
    }

    // Get file info before deletion for cleanup
    const { data: files, error: fetchError } = await supabase
      .from('customer_attachments')
      .select('filename')
      .in('id', fileIds);

    if (fetchError) {
      return res.status(500).json({ error: fetchError.message });
    }

    // Delete from database
    const { error: deleteError } = await supabase
      .from('customer_attachments')
      .delete()
      .in('id', fileIds);

    if (deleteError) {
      return res.status(500).json({ error: deleteError.message });
    }

    // Delete physical files
    const fs = require('fs');
    const path = require('path');
    
    files.forEach(file => {
      try {
        const filePath = path.join(__dirname, 'uploads', file.filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (error) {
        console.error(`Error deleting file ${file.filename}:`, error);
      }
    });

    res.json({ success: true, deletedCount: fileIds.length });
  } catch (error) {
    console.error('Error deleting attachments:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Initialize and start server
async function startServer() {
  await initializeAgentUsers();
  
  // Create feedback table if it doesn't exist
  try {
    const { error } = await supabase.rpc('exec_sql', {
      sql: `
        CREATE TABLE IF NOT EXISTS customer_feedback (
          id SERIAL PRIMARY KEY,
          session_id VARCHAR(255) NOT NULL,
          customer_name VARCHAR(255),
          customer_email VARCHAR(255),
          rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
          feedback_text TEXT,
          interaction_type VARCHAR(50) NOT NULL,
          agent_id VARCHAR(255),
          agent_name VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
      `
    });
    if (error) console.log('Note: Could not create feedback table automatically:', error.message);
  } catch (e) {
    console.log('Note: Run setup-feedback-table.sql manually in Supabase');
  }

  server.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on port ${process.env.PORT || 3000}`);
    console.log('Available agent accounts:');
    for (const [id, user] of agentUsers) {
      console.log(`- ${user.name} (${user.username}) - Role: ${user.role}`);
    }
  });
}

startServer();