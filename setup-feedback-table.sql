-- Create customer feedback table
CREATE TABLE IF NOT EXISTS customer_feedback (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    customer_name VARCHAR(255),
    customer_email VARCHAR(255),
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    feedback_text TEXT,
    interaction_type VARCHAR(50) NOT NULL, -- 'ai_only', 'human_agent'
    agent_id VARCHAR(255),
    agent_name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_customer_feedback_session_id ON customer_feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_customer_feedback_created_at ON customer_feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_customer_feedback_rating ON customer_feedback(rating);