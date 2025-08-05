-- Create customer intents table for tracking customer queries and AI responses
CREATE TABLE IF NOT EXISTS customer_intents (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    customer_message TEXT NOT NULL,
    intent_category VARCHAR(100),
    intent_type VARCHAR(100),
    confidence_score DECIMAL(3,2),
    knowledge_sources JSONB,
    response_type VARCHAR(50) NOT NULL, -- 'ai_response', 'handoff_suggestion', 'no_knowledge'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_customer_intents_session_id ON customer_intents(session_id);
CREATE INDEX IF NOT EXISTS idx_customer_intents_created_at ON customer_intents(created_at);
CREATE INDEX IF NOT EXISTS idx_customer_intents_intent_category ON customer_intents(intent_category);
CREATE INDEX IF NOT EXISTS idx_customer_intents_response_type ON customer_intents(response_type);